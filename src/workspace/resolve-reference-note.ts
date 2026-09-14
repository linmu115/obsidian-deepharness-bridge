import type { OpenNoteAction } from '../protocol.ts';
import type { ReferenceVaultReader } from '../vault/reference-source.ts';

/** A saved path is only a hint for anchored references: copied markers are ambiguous. */
export async function resolveReferenceNote(vault: ReferenceVaultReader, action: OpenNoteAction): Promise<OpenNoteAction> {
  if (!action.blockId) return action;
  const escaped = action.blockId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const paths = new Set([action.notePath, ...await (vault.findMarkdownPaths?.('block', action.blockId) ?? Promise.resolve([]))]);
  let found: string | undefined;
  for (const path of paths) {
    const markdown = await vault.read(path);
    const count = markdown === null ? 0 : [...markdown.matchAll(new RegExp('(?:^|\\s)\\^' + escaped + '[ \\t]*(?=\\r?$)', 'gm'))].length;
    if (count > 1 || (count && found !== undefined)) throw new Error('引用来源有歧义：多处存在相同块标识，请核对原笔记');
    if (count === 1) found = path;
  }
  if (!found) throw new Error('引用来源已移除或定位块不存在，请核对原笔记');
  return { ...action, notePath: found };
}
