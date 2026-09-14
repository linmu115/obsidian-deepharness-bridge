import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { NoteIdentity } from '@linmu/dsh-session-contracts';
import { SerialWork } from '../serial-work.ts';
import type { SessionNoteDocument } from '../protocol.ts';

const id = z.string().min(1).max(256);
const notePath = z.string().min(1).max(2048).refine(p => !p.startsWith('/') && !p.includes('\\') && !p.split('/').includes('..') && !p.includes(':'));
const stateSchema = z.object({
  version: z.literal(1), vaultId: id,
  notes: z.array(z.object({ noteId: id, notePath, missing: z.boolean() })),
  fences: z.array(z.object({ sessionId: id, instanceId: id, migrationId: id, revision: id, phase: z.enum(['frozen', 'active']), receiptId: id.optional() })),
  links: z.array(z.object({ objectId: id, noteId: id, instanceId: id, logicalSessionId: id, nativeSessionId: id, title: z.string().max(500), deleted: z.boolean().default(false) })),
  imports: z.array(z.object({ instanceId: id, after: z.string().max(256) })).default([]),
});
type State = z.infer<typeof stateSchema>;
export interface KnowledgeVaultIO {
  readState(): Promise<unknown | null>;
  writeState(state: unknown): Promise<void>;
  listPaths(): string[];
  readNoteId(path: string): Promise<string | undefined>;
  assignNoteId(path: string, proposed: string): Promise<string>;
  pathsForNoteId(noteId: string): string[];
  readLegacy(sessionId: string): Promise<SessionNoteDocument | null>;
  updateNote(path: string, update: (text: string | null) => string): Promise<unknown>;
  openNote(path: string, blockId?: string): Promise<void>;
}
const failure = (message: string) => Object.assign(new Error(message), { code: 'KNOWLEDGE_CONFLICT' });
const text = (v: unknown) => id.parse(v);

/** Only identities, ownership fences and link receipts live here. Note bodies stay in Vault. */
export class VaultKnowledgeStore {
  private readonly work = new SerialWork();
  private state!: State;
  constructor(private readonly vaultId: string, private readonly io: KnowledgeVaultIO) {}
  async load(): Promise<void> {
    const stored = await this.io.readState();
    this.state = stored === null ? { version: 1, vaultId: this.vaultId, notes: [], fences: [], links: [], imports: [] } : stateSchema.parse(stored);
    if (this.state.vaultId !== this.vaultId) throw failure('知识登记属于另一个 Vault');
  }
  private async change(update: (next: State) => void): Promise<void> {
    const next = structuredClone(this.state);
    update(next);
    await this.io.writeState(stateSchema.parse(next));
    this.state = next;
  }
  guardedLegacySave<T>(sessionId: string, save: () => Promise<T>): Promise<T> {
    return this.work.run(async () => {
      if (this.state.fences.some(f => f.sessionId === sessionId)) throw failure('旧贴纸写入已冻结或已迁入 Maintenance，请从新入口编辑');
      return save();
    });
  }
  rename(oldPath: string, path: string, missing = false): Promise<void> {
    return this.work.run(() => this.change(next => {
      for (const note of next.notes) if (note.notePath === oldPath) { note.notePath = path; note.missing = missing; }
    }));
  }
  private async identity(path: string): Promise<NoteIdentity> {
    notePath.parse(path);
    if (!this.io.listPaths().includes(path)) throw failure('笔记不存在');
    const noteId = await this.io.readNoteId(path) ?? await this.io.assignNoteId(path, randomUUID());
    if (this.io.pathsForNoteId(noteId).filter(p => p !== path).length) throw failure('笔记身份有歧义，请先整理登记');
    await this.change(s => { s.notes = s.notes.filter(n => n.noteId !== noteId); s.notes.push({ noteId, notePath: path, missing: false }); });
    return { vaultId: this.vaultId, noteId, notePath: path };
  }
  private async resolveNote(noteId: string): Promise<NoteIdentity> {
    const known = this.state.notes.find(n => n.noteId === noteId);
    const paths = new Set(this.io.pathsForNoteId(noteId));
    if (known && this.io.listPaths().includes(known.notePath) && await this.io.readNoteId(known.notePath) === noteId) paths.add(known.notePath);
    if (paths.size !== 1) throw failure(paths.size ? '笔记身份有歧义' : '笔记已移除或索引尚未就绪，无法定位');
    const path = [...paths][0]!;
    if (await this.io.readNoteId(path) !== noteId) throw failure('笔记身份已改变');
    if (!known || known.notePath !== path || known.missing) await this.change(s => { s.notes = s.notes.filter(n => n.noteId !== noteId); s.notes.push({ noteId, notePath: path, missing: false }); });
    return { vaultId: this.vaultId, noteId, notePath: path };
  }
  dispatch(operation: string, input: Record<string, unknown>, instanceId: string): Promise<unknown> {
    return this.work.run(async () => {
      text(instanceId);
      if (operation === 'info') return { vaultId: this.vaultId, protocolVersion: 1 };
      if (operation === 'import-cursor') {
        if (input.after !== undefined) {
          const after = z.string().max(256).parse(input.after);
          await this.change(s => { s.imports = s.imports.filter(i => i.instanceId !== instanceId); s.imports.push({ instanceId, after }); });
        }
        return { after: this.state.imports.find(i => i.instanceId === instanceId)?.after ?? '' };
      }
      if (operation === 'session-freeze') {
        const sessionId = text(input.sessionId), migrationId = text(input.migrationId);
        const document = await this.io.readLegacy(sessionId) ?? { protocolVersion: 1, type: 'session-note', sessionId, revision: 'sha256:empty', stickers: [] };
        const old = this.state.fences.find(f => f.sessionId === sessionId);
        if (old && (old.instanceId !== instanceId || old.migrationId !== migrationId)) throw failure('此会话已有另一份迁移记录');
        if (old && old.revision !== document.revision) throw failure('冻结后旧笔记已改变，请核对后恢复到冻结版本再重试');
        if (!old) await this.change(s => s.fences.push({ sessionId, instanceId, migrationId, revision: document.revision, phase: 'frozen' }));
        return { vaultId: this.vaultId, migrationId, document, phase: old?.phase ?? 'frozen' };
      }
      if (operation === 'session-activate') {
        const fence = this.state.fences.find(f => f.sessionId === input.sessionId);
        if (!fence || fence.instanceId !== instanceId || fence.migrationId !== input.migrationId) throw failure('缺少匹配的旧写入冻结记录');
        const current = await this.io.readLegacy(fence.sessionId);
        if ((current?.revision ?? 'sha256:empty') !== fence.revision) throw failure('旧笔记在导入后改变，未解除冻结');
        const receiptId = text(input.receiptId);
        if (fence.phase === 'active' && fence.receiptId !== receiptId) throw failure('迁移回执不同');
        await this.change(s => Object.assign(s.fences.find(f => f.sessionId === fence.sessionId)!, { phase: 'active', receiptId }));
        return { active: true, receiptId };
      }
      if (operation === 'notes') {
        const query = typeof input.query === 'string' ? input.query.slice(0,200).toLowerCase() : '';
        const after = typeof input.after === 'string' ? input.after : '';
        const paths = this.io.listPaths().filter(p => p > after && p.toLowerCase().includes(query)).sort().slice(0,31);
        return { items: paths.slice(0,30).map(path => ({ notePath: path })), nextCursor: paths.length > 30 ? paths[29] : null };
      }
      if (operation === 'note-register') return this.identity(notePath.parse(input.notePath));
      if (operation === 'note-resolve' || operation === 'note-open') {
        const note = await this.resolveNote(text(input.noteId));
        if (operation === 'note-open') await this.io.openNote(note.notePath, input.blockId === undefined ? undefined : text(input.blockId));
        return { vaultId: this.vaultId, noteId: note.noteId, notePath: note.notePath };
      }
      if (operation === 'links') {
        const after = typeof input.after === 'string' ? input.after : '';
        const items = this.state.links.filter(l => l.instanceId === instanceId && l.objectId > after).sort((a,b) => a.objectId.localeCompare(b.objectId)).slice(0,31);
        return { items: items.slice(0,30).map(l => ({ ...l, note: this.state.notes.find(n => n.noteId === l.noteId) })), nextCursor: items.length > 30 ? items[29]!.objectId : null };
      }
      if (operation === 'link-commit' || operation === 'link-delete' || operation === 'link-register') {
        const objectId = text(input.objectId), old = this.state.links.find(l => l.objectId === objectId);
        if (old && old.instanceId !== instanceId) throw failure('链接属于另一个实例');
        const identity = old ? await this.resolveNote(old.noteId) : await this.identity(notePath.parse(input.notePath));
        if (!identity || ('missing' in identity && identity.missing)) throw failure('笔记已移除');
        const link = { objectId, noteId: identity.noteId, instanceId, logicalSessionId: text(input.logicalSessionId), nativeSessionId: text(input.nativeSessionId), title: String(input.title ?? 'DSH 会话').slice(0,500), deleted: operation === 'link-delete' };
        if (old && (old.noteId !== identity.noteId || old.logicalSessionId !== link.logicalSessionId)) throw failure('链接身份不能改绑，请新建链接');
        // Persist intent before editing Markdown; retry repairs either interrupted step.
        await this.change(s => { s.links = s.links.filter(l => l.objectId !== objectId); s.links.push(link); });
        if (operation === 'link-register') return { note: { vaultId: this.vaultId, noteId: identity.noteId, notePath: identity.notePath }, objectId };
        const marker = '<!-- dsh-session-link:' + encodeURIComponent(objectId) + ' -->';
        const close = '<!-- /dsh-session-link:' + encodeURIComponent(objectId) + ' -->';
        const url = 'obsidian://deepharness-session?' + new URLSearchParams({ instance: instanceId, session: link.logicalSessionId });
        const label = link.title.replace(/[\[\]\\\r\n]/g, ' ');
        await this.io.updateNote(identity.notePath, content => {
          if (content === null) throw failure('笔记不存在');
          const start = content.indexOf(marker), end = content.indexOf(close);
          if ((start < 0) !== (end < 0) || (start >= 0 && (end < start || content.indexOf(marker,start+marker.length) >= 0))) throw failure('链接标记损坏或重复');
          const block = link.deleted ? '' : marker + '\n[会话：' + label + '](' + url + ')\n' + close;
          return start >= 0 ? content.slice(0,start) + block + content.slice(end+close.length) : link.deleted ? content : content + '\n\n' + block + '\n';
        });
        return { note: { vaultId: this.vaultId, noteId: identity.noteId, notePath: identity.notePath }, objectId, deleted: link.deleted };
      }
      throw failure('不支持此知识操作');
    });
  }
}
