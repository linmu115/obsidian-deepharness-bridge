import {
  stickerBacklinkSchema,
  stickerBacklinkTargetSchema,
  type StickerBacklink,
  type StickerBacklinkTarget,
} from "../protocol.ts";
import { sessionNotePath } from "./session-notes.ts";

export interface VaultBacklinkAdapter {
  listNativeBacklinks(notePath: string, blockId: string): Promise<readonly unknown[]>;
  sessionNotePath?(sessionId: string): string;
}

export async function listStickerBacklinks(
  vault: VaultBacklinkAdapter,
  input: StickerBacklinkTarget,
): Promise<StickerBacklink[]> {
  const target = stickerBacklinkTargetSchema.parse(input);
  const blockId = `dsh-sticker-${target.stickerId.slice(0, 8)}`;
  const backlinks = (await vault.listNativeBacklinks(vault.sessionNotePath?.(target.sessionId) ?? sessionNotePath(target.sessionId), blockId))
    .map((value) => stickerBacklinkSchema.parse(value));
  const unique = new Map<string, StickerBacklink>();

  for (const backlink of backlinks) {
    const identity = backlink.blockId
      ? `${backlink.notePath}\u0000block:${backlink.blockId}`
      : `${backlink.notePath}\u0000line:${backlink.line}\u0000column:${backlink.column ?? 0}`;
    if (!unique.has(identity)) {
      unique.set(identity, backlink);
    }
  }

  return [...unique.values()].sort((left, right) => (
    left.notePath.localeCompare(right.notePath, "zh-CN")
    || left.line - right.line
    || (left.column ?? 0) - (right.column ?? 0)
  ));
}
