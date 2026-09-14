import { noteSelectionSchema, type ExtensionObject, type NoteIdentity, type SessionSticker } from '@linmu/dsh-session-contracts';
import { canonicalSha256, type ObsidianReferenceCaptureV2 } from '../protocol.ts';
import type { LocalKnowledgeLink } from './knowledge-store.ts';

export function selectionStickerIntent(capture: ObsidianReferenceCaptureV2, target: { logicalSessionId: string; nativeSessionId: string; title: string }) {
  const { locator, selectedText } = capture.source;
  const selection = noteSelectionSchema.parse({ selectedText, selectedTextHash: locator.selectedTextHash, occurrence: locator.occurrence });
  return { ...target, objectId: 'note-sticker-link-' + capture.referenceId, notePath: locator.notePath, blockId: locator.blockId,
    ...(locator.heading ? { heading: locator.heading } : {}), sticker: { objectId: 'note-sticker-' + capture.referenceId, selection } };
}

/** The local journal holds only the bounded quote; an acknowledged object is never recreated. */
export async function writeSelectionSticker(request: <T>(operation: string, input: Record<string, unknown>) => Promise<T>, link: LocalKnowledgeLink, note: NoteIdentity): Promise<void> {
  if (!link.sticker) return;
  const { objectId, selection } = link.sticker;
  let old: ExtensionObject | undefined;
  try { old = await request<ExtensionObject>('get', { namespace: 'stickers', objectId }); }
  catch (error) { if ((error as { code?: string }).code !== 'EXTENSION_NOT_FOUND') throw error; }
  const body: SessionSticker = { kind: 'session', logicalSessionId: link.logicalSessionId, note, noteSelection: selection };
  if (old) {
    const previous = old.content.body as SessionSticker;
    if (previous.kind !== 'session' || previous.logicalSessionId !== body.logicalSessionId || previous.note?.vaultId !== note.vaultId || previous.note?.noteId !== note.noteId || previous.note?.blockId !== note.blockId || canonicalSha256(previous.noteSelection) !== canonicalSha256(selection)) throw new Error('选段贴纸身份冲突，请核对已保存对象');
    // Deletion of a sticker is independent from deletion of its note link.
    if (old.deleted || canonicalSha256(old.content.body) === canonicalSha256(body)) return;
  } else if (link.deleted) return;
  const result = await request<{ status: string }>('write', { namespace: 'stickers', objectId, expectedRevision: old?.revision ?? (0), title: old?.content.title ?? (link.title || '笔记选段会话'), body });
  if (result.status === 'conflict') throw new Error('选段贴纸有并发修改，进度已保留，请重试');
}
