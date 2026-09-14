import { expect, it } from 'vitest';
import { resolveReferenceNote } from '../src/workspace/resolve-reference-note.ts';

const action = { protocolVersion: 1, type: 'open-note', actionId: 'open', notePath: 'old.md', blockId: 'stable-block' } as const;
const reader = (files: Record<string, string>) => ({ read: async (path: string) => files[path] ?? null, findMarkdownPaths: async () => Object.keys(files) });
it('opens a moved or renamed anchored reference even when its old path is reused', async () => {
  for (const files of [{ 'moved/new.md': 'selected ^stable-block' }, { 'old.md': 'unrelated replacement', 'moved/new.md': 'selected ^stable-block' }]) {
    expect(await resolveReferenceNote(reader(files), action)).toEqual({ ...action, notePath: 'moved/new.md' });
  }
});
it('rejects duplicate markers across notes even if the recorded path still matches', async () => {
  await expect(resolveReferenceNote(reader({ 'old.md': 'one ^stable-block', 'copy.md': 'two ^stable-block' }), action)).rejects.toThrow('歧义');
  await expect(resolveReferenceNote(reader({ 'old.md': 'one ^stable-block\ntwo ^stable-block' }), action)).rejects.toThrow('歧义');
});
it('does not guess an unrelated path when the saved block is gone', async () => {
  await expect(resolveReferenceNote(reader({ 'old.md': 'replacement', 'new.md': 'same words ^other-block' }), action)).rejects.toThrow('不存在');
});
it('keeps unanchored legacy navigation unchanged', async () => {
  const { blockId: _blockId, ...plain } = action;
  expect(await resolveReferenceNote(reader({}), plain)).toEqual(plain);
});
