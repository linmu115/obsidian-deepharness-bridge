import { expect, it } from 'vitest';
import type { ExtensionObject } from '@linmu/dsh-session-contracts';
import { knowledgeLinkUpdate } from '../src/vault/knowledge-link-update.ts';

const note = { vaultId: 'vault', noteId: 'stable', notePath: '旧名.md', blockId: 'block' };
const old = { deleted: true, content: { body: { kind: 'note-link', logicalSessionId: 'logical', note, legacyReferenceId: 'ref' } } } as unknown as ExtensionObject;
it('preserves the saved deletion until an explicit restore and keeps the original block after rename', () => {
  expect(() => knowledgeLinkUpdate(old, { ...note, notePath: '新名.md' }, 'logical', 'synced', false)).toThrow('删除状态');
  const renamed = { vaultId: 'vault', noteId: 'stable', notePath: '新名.md' };
  expect(knowledgeLinkUpdate(old, renamed, 'logical', 'synced', true)).toMatchObject({ note: { ...renamed, blockId: 'block' }, legacyReferenceId: 'ref' });
  expect(knowledgeLinkUpdate(old, renamed, 'logical', 'synced', false, true)).toMatchObject({ note: { blockId: 'block' } });
  expect(() => knowledgeLinkUpdate(old, { ...renamed, noteId: 'different' }, 'logical', 'synced', true)).toThrow('身份');
});
