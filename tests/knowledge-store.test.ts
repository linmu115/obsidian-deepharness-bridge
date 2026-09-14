import { expect, it, vi } from 'vitest';
import { VaultKnowledgeStore, type KnowledgeVaultIO } from '../src/vault/knowledge-store.ts';
import type { SessionNoteDocument } from '../src/protocol.ts';

async function fixture() {
  let saved: unknown = null;
  const files = new Map([['笔记.md', '# 原有正文\n用户的内容\n'], ['另一个.md', '另一份正文\n']]);
  const identities = new Map<string,string>();
  let legacy: SessionNoteDocument = { protocolVersion: 1, type: 'session-note', sessionId: 'native', revision: 'sha256:original', stickers: [] };
  const io: KnowledgeVaultIO = { readNoteId: async path => identities.get(path), assignNoteId: async(path,id)=>{identities.set(path,id);return id;}, pathsForNoteId:id=>[...identities].filter(([path,value])=>value===id&&files.has(path)).map(([path])=>path), readState: async () => saved, writeState: async state => { saved = structuredClone(state); }, listPaths: () => [...files.keys()], readLegacy: async () => legacy,
    updateNote: async (path, update) => { files.set(path, update(files.get(path) ?? null)); }, openNote: vi.fn(async () => undefined) };
  const store = new VaultKnowledgeStore('vault', io); await store.load();
  return { store, io, files, identities, saved: () => saved, changeLegacy: () => { legacy = { ...legacy, revision: 'sha256:changed' }; } };
}
it('serializes old writes before a durable freeze and retains the fence after restart and activation', async () => {
  const f = await fixture(), writes: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const write = f.store.guardedLegacySave('native', async () => { await gate; writes.push('saved'); });
  const freeze = f.store.dispatch('session-freeze', { sessionId: 'native', migrationId: 'migration' }, 'instance');
  release(); await write; await freeze;
  expect(writes).toEqual(['saved']);
  await expect(f.store.guardedLegacySave('native', async () => writes.push('wrong'))).rejects.toThrow('冻结');
  const restarted = new VaultKnowledgeStore('vault', f.io); await restarted.load();
  await expect(restarted.dispatch('session-freeze', { sessionId: 'native', migrationId: 'other' }, 'instance')).rejects.toThrow();
  await expect(restarted.dispatch('session-activate', { sessionId: 'native', migrationId: 'migration', receiptId: 'receipt' }, 'foreign')).rejects.toThrow();
  await restarted.dispatch('session-activate', { sessionId: 'native', migrationId: 'migration', receiptId: 'receipt' }, 'instance');
  await expect(restarted.guardedLegacySave('native', async () => undefined)).rejects.toThrow();
  expect(JSON.stringify(f.saved())).not.toContain('用户的内容');
});
it('refuses activation after an external change to the frozen note', async () => {
  const f = await fixture();
  await f.store.dispatch('session-freeze', { sessionId: 'native', migrationId: 'm' }, 'instance'); f.changeLegacy();
  await expect(f.store.dispatch('session-activate', { sessionId: 'native', migrationId: 'm', receiptId: 'r' }, 'instance')).rejects.toThrow('改变');
  expect(f.saved()).toMatchObject({ fences: [{ phase: 'frozen' }] });
});
it('keeps stable note identity through rename, removes one link, and repairs an interrupted note write', async () => {
  const f = await fixture();
  const note = await f.store.dispatch('note-register', { notePath: '笔记.md' }, 'instance') as { noteId: string };
  const one = { objectId: 'one', notePath: '笔记.md', logicalSessionId: 'logical-a', nativeSessionId: 'native-a', title: '讨论甲' };
  await f.store.dispatch('link-commit', one, 'instance'); await f.store.dispatch('link-commit', one, 'instance');
  expect(f.files.get('笔记.md')!.match(/<!-- dsh-session-link:one -->/g)).toHaveLength(1);
  await f.store.dispatch('link-commit', { ...one, objectId: 'two', logicalSessionId: 'logical-b' }, 'instance');
  await f.store.dispatch('link-delete', one, 'instance');
  expect(f.files.get('笔记.md')).not.toContain('dsh-session-link:one'); expect(f.files.get('笔记.md')).toContain('dsh-session-link:two');
  expect(f.files.get('笔记.md')!.startsWith('# 原有正文\n用户的内容\n')).toBe(true);
  f.files.set('移动/新名字.md', f.files.get('笔记.md')!); f.files.delete('笔记.md'); await f.store.rename('笔记.md', '移动/新名字.md');
  f.identities.set('移动/新名字.md',note.noteId);f.identities.delete('笔记.md');
  await expect(f.store.dispatch('note-open', { noteId: note.noteId }, 'instance')).resolves.toMatchObject({ notePath: '移动/新名字.md', noteId: note.noteId });
  expect(f.io.openNote).toHaveBeenCalledWith('移动/新名字.md', undefined);
  const update = f.io.updateNote;
  f.io.updateNote = async () => { throw new Error('disk interruption'); };
  await expect(f.store.dispatch('link-commit', { ...one, notePath: '移动/新名字.md' }, 'instance')).rejects.toThrow('disk interruption');
  f.io.updateNote = update;
  const restarted = new VaultKnowledgeStore('vault', f.io); await restarted.load();
  await restarted.dispatch('link-commit', { ...one, notePath: '移动/新名字.md' }, 'instance');
  expect(f.files.get('移动/新名字.md')).toContain('dsh-session-link:one');
  await expect(restarted.dispatch('link-delete', one, 'foreign')).rejects.toThrow('另一');
  await restarted.rename('移动/新名字.md','移动/新名字.md',true);
  f.files.delete('移动/新名字.md');
  await expect(restarted.dispatch('note-resolve', { noteId: note.noteId }, 'instance')).rejects.toThrow('移除');
});
it('paginates note metadata and refuses unknown paths or ambiguous identities', async () => {
  const f = await fixture(); for (let i = 0; i < 65; i++) f.files.set('索引' + String(i).padStart(3,'0') + '.md','private full body');
  const page = await f.store.dispatch('notes', { query: '索引' }, 'instance') as { items: unknown[]; nextCursor: string };
  expect(page.items).toHaveLength(30); expect(JSON.stringify(page)).not.toContain('private full body');
  expect((await f.store.dispatch('notes',{ query:'索引',after:page.nextCursor },'instance') as {items:unknown[]}).items).toHaveLength(30);
  await expect(f.store.dispatch('note-register', { notePath: '../secret.md' }, 'instance')).rejects.toThrow();
  const note=await f.store.dispatch('note-register',{notePath:'笔记.md'},'instance') as {noteId:string};
  f.identities.set('另一个.md',note.noteId);
  await expect(f.store.dispatch('note-register',{notePath:'笔记.md'},'instance')).rejects.toThrow('歧义');
});
it('finds an offline move by identity even when another note reuses the old path, and persists import progress', async () => {
  const f = await fixture();
  const note = await f.store.dispatch('note-register', { notePath: '笔记.md' }, 'instance') as { noteId: string };
  f.files.set('归档/移动.md', f.files.get('笔记.md')!); f.identities.set('归档/移动.md', note.noteId);
  f.files.set('笔记.md', '后来创建的另一份笔记'); f.identities.set('笔记.md', 'different');
  await f.store.dispatch('import-cursor', { after: 'receipt-100' }, 'instance');
  const restarted = new VaultKnowledgeStore('vault', f.io); await restarted.load();
  await expect(restarted.dispatch('note-open', { noteId: note.noteId }, 'instance')).resolves.toMatchObject({ notePath: '归档/移动.md' });
  await expect(restarted.dispatch('import-cursor', {}, 'instance')).resolves.toEqual({ after: 'receipt-100' });
  await expect(restarted.dispatch('import-cursor', {}, 'foreign')).resolves.toEqual({ after: '' });
});

it('rejects a stale synchronization page instead of restoring a newer deletion', async () => {
  const f = await fixture();
  const intent = { objectId: 'one', notePath: '笔记.md', logicalSessionId: 'logical', nativeSessionId: 'native', title: '讨论' };
  await f.store.dispatch('link-commit', intent, 'instance');
  const old = await f.store.dispatch('link-get', { objectId: 'one' }, 'instance') as Record<string, unknown>;
  await f.store.dispatch('link-delete', intent, 'instance');
  await expect(f.store.dispatch('link-commit', { ...old, notePath: '笔记.md', repair: true }, 'instance')).rejects.toThrow('意图已改变');
  expect(await f.store.dispatch('link-get', { objectId: 'one' }, 'instance')).toMatchObject({ deleted: true, revision: 2 });
  expect(f.files.get('笔记.md')).not.toContain('dsh-session-link:one');
});
