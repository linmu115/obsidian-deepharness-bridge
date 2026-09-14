import { expect, it } from 'vitest';
import { VaultKnowledgeStore, type KnowledgeVaultIO } from '../src/vault/knowledge-store.ts';
import { syncKnowledgeBatch } from '../src/vault/knowledge-sync.ts';

async function fixture(count = 650) {
  let saved: unknown = { version: 1, vaultId: 'vault', notes: [{ noteId: 'note', notePath: 'note.md', missing: false }], fences: [], links: Array.from({ length: count }, (_, i) => ({ objectId: 'link-' + String(i).padStart(4,'0'), noteId: 'note', instanceId: 'instance', logicalSessionId: 'session', nativeSessionId: 'native', title: 'title', deleted: false })) };
  const io: KnowledgeVaultIO = { readState: async () => structuredClone(saved), writeState: async state => { saved = structuredClone(state); }, listPaths: () => ['note.md'], readNoteId: async () => 'note', assignNoteId: async () => 'note', pathsForNoteId: () => ['note.md'], readLegacy: async () => null, updateNote: async () => undefined, openNote: async () => undefined };
  const store = new VaultKnowledgeStore('vault', io); await store.load();
  return { store, io, saved: () => saved };
}
it('resumes after restart and visits entries beyond 600 without rereading the prefix', async () => {
  const f = await fixture(), seen: string[] = [];
  for (let i = 0; i < 10; i++) expect(await syncKnowledgeBatch(f.store, 'instance', async l => { seen.push(l.objectId); })).toEqual({ done: false, count: 60 });
  const restarted = new VaultKnowledgeStore('vault', f.io); await restarted.load();
  expect(await syncKnowledgeBatch(restarted, 'instance', async l => { seen.push(l.objectId); })).toEqual({ done: true, count: 50 });
  expect(seen).toHaveLength(650); expect(new Set(seen).size).toBe(650); expect(seen.at(-1)).toBe('link-0649');
  expect(await syncKnowledgeBatch(restarted, 'instance', async () => { throw new Error('already done'); })).toEqual({ done: true, count: 0 });
});
it('retries the unacknowledged item after interruption and keeps other instance progress separate', async () => {
  const f = await fixture(65), seen: string[] = [];
  await expect(syncKnowledgeBatch(f.store, 'instance', async l => { if (l.objectId === 'link-0005') throw new Error('offline'); seen.push(l.objectId); })).rejects.toThrow('offline');
  const restarted = new VaultKnowledgeStore('vault', f.io); await restarted.load();
  expect(await syncKnowledgeBatch(restarted, 'foreign', async () => { throw new Error('foreign'); })).toEqual({ done: true, count: 0 });
  await syncKnowledgeBatch(restarted, 'instance', async l => { seen.push(l.objectId); });
  expect(seen).toHaveLength(65); expect(new Set(seen).size).toBe(65);
});
it('finishes the current pass then revisits changes behind its cursor', async () => {
  const f = await fixture(65), seen: boolean[] = [];
  await syncKnowledgeBatch(f.store, 'instance', async () => undefined);
  await f.store.rename('note.md', 'note.md', true);
  const end = await syncKnowledgeBatch(f.store, 'instance', async () => undefined);
  expect(end).toEqual({ done: false, count: 5 });
  await syncKnowledgeBatch(f.store, 'instance', async l => { seen.push(l.note!.missing); });
  await syncKnowledgeBatch(f.store, 'instance', async l => { seen.push(l.note!.missing); });
  expect(seen).toHaveLength(65); expect(seen.every(Boolean)).toBe(true);
});
it('does not let an obsolete concurrent worker move the saved cursor', async () => {
  const f = await fixture(2);
  await syncKnowledgeBatch(f.store, 'instance', async () => undefined, () => false, 1);
  await expect(f.store.dispatch('sync-progress', { expectedAfter: '', scanGeneration: 1, after: 'link-0001' }, 'instance')).rejects.toThrow('进度已改变');
});
