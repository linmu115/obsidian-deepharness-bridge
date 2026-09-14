import { expect, it } from 'vitest';
import { knowledgeWriteSchema, type ExtensionObject } from '@linmu/dsh-session-contracts';
import { selectionStickerIntent, writeSelectionSticker } from '../src/vault/selection-sticker.ts';
import { createObsidianReferenceCapture } from '../src/vault/reference-source.ts';
import { VaultKnowledgeStore, type KnowledgeVaultIO } from '../src/vault/knowledge-store.ts';
import { syncKnowledgeBatch } from '../src/vault/knowledge-sync.ts';

it('persists a selected excerpt intent, resumes the same real session sticker, and keeps full note text out of the journal', async () => {
  const capture = createObsidianReferenceCapture({ actionId: 'action', referenceId: 'reference', vaultId: 'vault', notePath: 'note.md', blockId: 'block', occurrence: 0, selectedText: '有意义的选段', markdown: '有意义的选段 ^block\nwhole-note-private-material', capturedAt: 1 });
  const intent = selectionStickerIntent(capture, { logicalSessionId: 'real-logical', nativeSessionId: 'real-native', title: '深入讨论' });
  let state: unknown = null, markdown = capture.source.snapshot.markdown;
  const io: KnowledgeVaultIO = { readState: async () => state, writeState: async next => { state = structuredClone(next); }, listPaths: () => ['note.md'], readNoteId: async () => 'stable-note', assignNoteId: async () => 'stable-note', pathsForNoteId: () => ['note.md'], readLegacy: async () => null, updateNote: async (_path, update) => { markdown = update(markdown); }, openNote: async () => undefined };
  const first = new VaultKnowledgeStore('vault', io); await first.load();
  await first.dispatch('link-register', intent, 'instance');
  expect(first.referencesBlock('block')).toBe(true);
  expect(first.referencesBlock('unrelated')).toBe(false);
  expect(JSON.stringify(state)).toContain('有意义的选段'); expect(JSON.stringify(state)).not.toContain('whole-note-private-material');
  const restarted = new VaultKnowledgeStore('vault', io); await restarted.load();
  let object: ExtensionObject | undefined, writes = 0;
  const request = async <T>(operation: string, input: Record<string, unknown>): Promise<T> => {
    if (operation === 'get') { if (!object) throw Object.assign(new Error('missing'), { code: 'EXTENSION_NOT_FOUND' }); return object as T; }
    const parsed = knowledgeWriteSchema.parse(input); writes++;
    object = { objectId: parsed.objectId, revision: writes, deleted: false, content: { title: parsed.title, body: parsed.body, references: [{ logicalSessionId: 'real-logical' }] } } as unknown as ExtensionObject;
    return { status: 'written', object } as T;
  };
  await syncKnowledgeBatch(restarted, 'instance', async link => {
    await restarted.dispatch('link-commit', { ...link, notePath: 'note.md', repair: true }, 'instance');
    await writeSelectionSticker(request, link, { vaultId: 'vault', noteId: 'stable-note', notePath: 'note.md', blockId: 'block' });
    // Lost transport acknowledgement must not produce a second version.
    await writeSelectionSticker(request, link, { vaultId: 'vault', noteId: 'stable-note', notePath: 'note.md', blockId: 'block' });
    object!.deleted = true;
    await writeSelectionSticker(request, link, { vaultId: 'vault', noteId: 'stable-note', notePath: 'note.md', blockId: 'block' });
  });
  expect(writes).toBe(1); expect(object!.deleted).toBe(true);
  expect(object!.content.body).toMatchObject({ kind: 'session', logicalSessionId: 'real-logical', note: { blockId: 'block' }, noteSelection: { selectedText: '有意义的选段' } });
  expect(markdown).toContain('obsidian://deepharness-session?instance=instance&session=real-logical');
  expect(markdown).toContain('whole-note-private-material');
});

it('rejects oversized excerpts before a session or journal write is requested', () => {
  const capture = createObsidianReferenceCapture({ actionId: 'a', referenceId: 'r', vaultId: 'v', notePath: 'n.md', blockId: 'b', occurrence: 0, selectedText: 'x'.repeat(16001), markdown: 'x'.repeat(16001), capturedAt: 1 });
  expect(() => selectionStickerIntent(capture, { logicalSessionId: 'l', nativeSessionId: 'n', title: 't' })).toThrow();
});
