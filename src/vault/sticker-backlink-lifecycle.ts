import {
  stickerBacklinkTargetSchema,
  type StickerBacklinkDeleteResult,
  type StickerBacklinkTarget,
} from "../protocol.ts";

export interface StickerBacklinkVault {
  listMarkdownPaths(): Promise<readonly string[]>;
  read(path: string): Promise<string | null>;
  process(path: string, update: (content: string) => string): Promise<string>;
  findMarkdownPaths?(kind: "sticker" | "reference" | "block", id: string): Promise<readonly string[]>;
}

const MANAGED_BLOCK = /(?:^|(?<=\n))<!-- dsh-sticker-backlink:(\{[^\r\n]*\}) -->\r?\n[\s\S]*?\r?\n<!-- \/dsh-sticker-backlink -->(?:\r?\n|$)/g;

type StickerIdentity = Pick<StickerBacklinkTarget, "stickerId" | "dshInstanceId">;

function matchesStickerIdentity(source: StickerIdentity, target: StickerBacklinkTarget): boolean {
  return source.stickerId === target.stickerId
    && (source.dshInstanceId === undefined || source.dshInstanceId === target.dshInstanceId);
}

function logicalStickerTargets(line: string): StickerIdentity[] {
  const targets: StickerIdentity[] = [];
  for (const match of line.matchAll(/obsidian:\/\/deepharness\?[^\s)>\]]+/g)) {
    try {
      const query = new URL(match[0]).searchParams;
      const stickerId = query.get("sticker")?.trim();
      const dshInstanceId = query.get("dshInstanceId");
      if (stickerId) targets.push({ stickerId, ...(dshInstanceId === null ? {} : { dshInstanceId }) });
    } catch {
      // Ignore malformed user-authored links.
    }
  }
  return targets;
}

function ownsGeneratedLinks(lines: readonly string[], target: StickerBacklinkTarget): boolean {
  const links = lines.flatMap(logicalStickerTargets);
  return links.length > 0 && links.every(link => matchesStickerIdentity(link, target));
}

function lineBody(line: string): string {
  return line.replace(/\r?\n$/, "");
}

function isLegacyWikiLine(line: string, target: StickerBacklinkTarget): boolean {
  const blockId = `dsh-sticker-${target.stickerId.slice(0, 8)}`;
  return lineBody(line).trim() === `[[DeepHarness/Sessions/${encodeURIComponent(target.sessionId)}#^${blockId}|贴纸来源]]`;
}

function isGeneratedLogicalLinkLine(line: string, target: StickerBacklinkTarget): boolean {
  const trimmed = lineBody(line).trim();
  if (!ownsGeneratedLinks([trimmed], target)) return false;
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
      if (ownsGeneratedLinks(block, target)) {
        removed += 1;
      } else output.push(...block);
      // A protected callout is indivisible, just like a protected managed block.
      index = end;
      continue;
    }
    if (isGeneratedLogicalLinkLine(line, target)) {
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
  const output: string[] = [];
  let linksRemoved = 0;
  let offset = 0;
  const appendLegacy = (part: string) => {
    const legacy = removeLegacyGeneratedLinks(part, target);
    output.push(legacy.source);
    linksRemoved += legacy.removed;
  };
  for (const match of source.matchAll(MANAGED_BLOCK)) {
    appendLegacy(source.slice(offset, match.index));
    let owned = false;
    try {
      owned = matchesStickerIdentity(stickerBacklinkTargetSchema.parse(JSON.parse(match[1]!)), target);
    } catch { /* Unreadable metadata cannot authorize deletion. */ }
    if (owned) linksRemoved += 1;
    else output.push(match[0]);
    // Never feed a retained block through legacy cleanup: its interior may
    // contain old unscoped generated links, but the outer owner is authoritative.
    offset = match.index + match[0].length;
  }
  appendLegacy(source.slice(offset));
  return { source: output.join(""), linksRemoved };
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
  let linksRemoved = 0;
  await vault.process(notePath, (latest) => {
    const next = removeStickerBacklinksFromMarkdown(latest, target);
    linksRemoved = next.linksRemoved;
    return next.source;
  });
  return { notesChanged: linksRemoved > 0 ? 1 : 0, linksRemoved };
}

export async function deleteStickerBacklinks(
  vault: StickerBacklinkVault,
  value: StickerBacklinkTarget,
): Promise<StickerBacklinkDeleteResult> {
  const target = stickerBacklinkTargetSchema.parse(value);
  let notesChanged = 0;
  let linksRemoved = 0;
  const paths = await (vault.findMarkdownPaths?.("sticker", target.stickerId) ?? vault.listMarkdownPaths());
  for (const path of paths) {
    const result = await deleteStickerBacklinkFromNote(vault, path, target);
    notesChanged += result.notesChanged;
    linksRemoved += result.linksRemoved;
  }
  return { notesChanged, linksRemoved };
}
