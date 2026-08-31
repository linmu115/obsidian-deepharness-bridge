import {
  stickerBacklinkTargetSchema,
  type StickerBacklinkDeleteResult,
  type StickerBacklinkTarget,
} from "../protocol.ts";

export interface StickerBacklinkVault {
  listMarkdownPaths(): Promise<readonly string[]>;
  read(path: string): Promise<string | null>;
  write(path: string, content: string): Promise<void>;
}

const MANAGED_BLOCK = /(?:^|(?<=\n))<!-- dsh-sticker-backlink:(\{[^\r\n]*\}) -->\r?\n[\s\S]*?\r?\n<!-- \/dsh-sticker-backlink -->(?:\r?\n|$)/g;

function stickerIdInLogicalLink(line: string): string | undefined {
  for (const match of line.matchAll(/obsidian:\/\/deepharness\?[^\s)>\]]+/g)) {
    try {
      const stickerId = new URL(match[0]).searchParams.get("sticker")?.trim();
      if (stickerId) return stickerId;
    } catch {
      // Ignore malformed user-authored links.
    }
  }
  return undefined;
}

function removeManagedBlocks(source: string, target: StickerBacklinkTarget): { source: string; removed: number } {
  let removed = 0;
  const output = source.replace(MANAGED_BLOCK, (block, metadataText: string) => {
    try {
      const metadata = stickerBacklinkTargetSchema.parse(JSON.parse(metadataText));
      if (metadata.stickerId !== target.stickerId || metadata.sessionId !== target.sessionId) return block;
      removed += 1;
      return "";
    } catch {
      return block;
    }
  });
  return { source: output, removed };
}

function lineBody(line: string): string {
  return line.replace(/\r?\n$/, "");
}

function isLegacyWikiLine(line: string, target: StickerBacklinkTarget): boolean {
  const blockId = `dsh-sticker-${target.stickerId.slice(0, 8)}`;
  return lineBody(line).trim() === `[[DeepHarness/Sessions/${encodeURIComponent(target.sessionId)}#^${blockId}|贴纸来源]]`;
}

function isGeneratedLogicalLinkLine(line: string, stickerId: string): boolean {
  const trimmed = lineBody(line).trim();
  if (stickerIdInLogicalLink(trimmed) !== stickerId) return false;
  return /^\[回到 DSH(?::|：)/.test(trimmed) || /^>\s*\[回到 DSH(?::|：)/.test(trimmed);
}

function removeLegacyGeneratedLinks(source: string, target: StickerBacklinkTarget): { source: string; removed: number } {
  const lines = source.match(/.*(?:\r?\n|$)/g)?.filter(Boolean) ?? [];
  const output: string[] = [];
  let removed = 0;
  for (let index = 0; index < lines.length;) {
    const line = lines[index]!;
    if (/^>\s*\[!dsh-reference\]/.test(lineBody(line).trim())) {
      let end = index + 1;
      while (end < lines.length && /^>/.test(lineBody(lines[end]!).trim())) end += 1;
      const block = lines.slice(index, end);
      if (block.some((candidate) => stickerIdInLogicalLink(candidate) === target.stickerId)) {
        removed += 1;
        index = end;
        continue;
      }
    }
    if (isGeneratedLogicalLinkLine(line, target.stickerId)) {
      if (output.length > 0 && isLegacyWikiLine(output.at(-1)!, target)) output.pop();
      removed += 1;
      index += 1;
      continue;
    }
    output.push(line);
    index += 1;
  }
  return { source: output.join(""), removed };
}

export function removeStickerBacklinksFromMarkdown(
  source: string,
  value: StickerBacklinkTarget,
): { source: string; linksRemoved: number } {
  const target = stickerBacklinkTargetSchema.parse(value);
  const managed = removeManagedBlocks(source, target);
  const legacy = removeLegacyGeneratedLinks(managed.source, target);
  return { source: legacy.source, linksRemoved: managed.removed + legacy.removed };
}

export async function deleteStickerBacklinkFromNote(
  vault: StickerBacklinkVault,
  notePath: string,
  value: StickerBacklinkTarget,
): Promise<StickerBacklinkDeleteResult> {
  const target = stickerBacklinkTargetSchema.parse(value);
  const source = await vault.read(notePath);
  if (source === null || !source.includes(target.stickerId)) {
    return { notesChanged: 0, linksRemoved: 0 };
  }
  const next = removeStickerBacklinksFromMarkdown(source, target);
  if (next.source === source) return { notesChanged: 0, linksRemoved: 0 };
  await vault.write(notePath, next.source);
  return { notesChanged: 1, linksRemoved: next.linksRemoved };
}

export async function deleteStickerBacklinks(
  vault: StickerBacklinkVault,
  value: StickerBacklinkTarget,
): Promise<StickerBacklinkDeleteResult> {
  const target = stickerBacklinkTargetSchema.parse(value);
  let notesChanged = 0;
  let linksRemoved = 0;
  for (const path of await vault.listMarkdownPaths()) {
    const source = await vault.read(path);
    if (source === null || !source.includes(target.stickerId)) continue;
    const next = removeStickerBacklinksFromMarkdown(source, target);
    if (next.source === source) continue;
    await vault.write(path, next.source);
    notesChanged += 1;
    linksRemoved += next.linksRemoved;
  }
  return { notesChanged, linksRemoved };
}
