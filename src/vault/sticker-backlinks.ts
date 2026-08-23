import {
  stickerBacklinkSchema,
  stickerBacklinkTargetSchema,
  type StickerBacklink,
  type StickerBacklinkTarget,
} from "../protocol.ts";
import { parseDshLogicalLocation } from "../logical-link.ts";

export interface VaultMarkdownDocument {
  path: string;
  content: string;
}

export interface VaultMarkdownAdapter {
  listMarkdownFiles(): Promise<readonly VaultMarkdownDocument[]>;
}

const LOGICAL_LINK = /(?:obsidian:\/\/deepharness\?[^\s<>()\]]+|dsh:\/\/open\/session\/[^\s<>()\]]+)/g;
const HEADING = /^#{1,6}\s+(.+?)\s*$/;
const BLOCK_ID = /^\s*>?\s*\^([A-Za-z0-9-]+)\s*$/;

function findBlockId(lines: readonly string[], line: number): string | undefined {
  const limit = Math.min(lines.length, line + 12);
  for (let index = line; index < limit; index += 1) {
    const value = lines[index] ?? "";
    const match = BLOCK_ID.exec(value);
    if (match?.[1]) return match[1];
    if (index > line && (value.trim() === "" || HEADING.test(value))) break;
  }
  return undefined;
}

function excerpt(value: string): string {
  const normalized = value.replace(/^\s*>\s?/, "").trim();
  return normalized.length <= 180 ? normalized : `${normalized.slice(0, 177)}...`;
}

function matchesTarget(link: ReturnType<typeof parseDshLogicalLocation>, target: StickerBacklinkTarget): boolean {
  if (link.stickerId) return link.stickerId === target.stickerId;
  return link.sessionId === target.sessionId
    && link.anchorId === target.anchorId
    && link.quoteHash === target.quoteHash;
}

export async function listStickerBacklinks(
  vault: VaultMarkdownAdapter,
  input: StickerBacklinkTarget,
): Promise<StickerBacklink[]> {
  const target = stickerBacklinkTargetSchema.parse(input);
  const backlinks: StickerBacklink[] = [];
  const identities = new Set<string>();

  for (const document of await vault.listMarkdownFiles()) {
    const lines = document.content.split(/\r?\n/);
    let heading: string | undefined;
    for (let line = 0; line < lines.length; line += 1) {
      const value = lines[line] ?? "";
      const headingMatch = HEADING.exec(value);
      if (headingMatch?.[1]) heading = headingMatch[1].trim();
      LOGICAL_LINK.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = LOGICAL_LINK.exec(value)) !== null) {
        let location: ReturnType<typeof parseDshLogicalLocation>;
        try {
          location = parseDshLogicalLocation(match[0]);
        } catch {
          continue;
        }
        if (!matchesTarget(location, target)) continue;
        const blockId = findBlockId(lines, line);
        const identity = `${document.path}\u0000${blockId ? `block:${blockId}` : `line:${line}`}`;
        if (identities.has(identity)) continue;
        identities.add(identity);
        backlinks.push(stickerBacklinkSchema.parse({
          notePath: document.path,
          line,
          column: match.index,
          ...(blockId ? { blockId } : {}),
          ...(heading ? { heading } : {}),
          excerpt: excerpt(value),
        }));
      }
    }
  }

  return backlinks.sort((left, right) => (
    left.notePath.localeCompare(right.notePath, "zh-CN")
    || left.line - right.line
    || (left.column ?? 0) - (right.column ?? 0)
  ));
}
