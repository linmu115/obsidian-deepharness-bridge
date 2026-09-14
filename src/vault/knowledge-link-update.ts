import type { ExtensionObject, NoteIdentity } from '@linmu/dsh-session-contracts';

/** Vault owns note identity; Maintenance owns the saved link and its deletion state. */
export function knowledgeLinkUpdate(existing: ExtensionObject | undefined, note: NoteIdentity, logicalSessionId: string, syncState: string, deleted: boolean, explicitChange = false) {
  const old = existing?.content.body as { kind?: string; logicalSessionId?: string; note?: NoteIdentity; legacyReferenceId?: string } | undefined;
  if (old && (old.kind !== 'note-link' || old.logicalSessionId !== logicalSessionId || old.note?.vaultId !== note.vaultId || old.note?.noteId !== note.noteId)) throw new Error('知识链接身份冲突');
  if (existing && existing.deleted !== deleted && !explicitChange) throw new Error('链接的删除状态已在另一侧改变，请在会话贴纸面板选择解除或恢复此链接');
  return { kind: 'note-link' as const, logicalSessionId, note: { ...old?.note, ...note }, syncState, ...(old?.legacyReferenceId ? { legacyReferenceId: old.legacyReferenceId } : {}) };
}
