import type { StickerBacklink } from "../protocol.ts";

interface CachePosition {
  start: { line: number; col: number };
  end: { line: number; col: number };
}

interface NativeBacklinkCache {
  links?: readonly { link: string; position: CachePosition }[];
  headings?: readonly { heading: string; position: CachePosition }[];
  blocks?: Readonly<Record<string, { id: string; position: CachePosition }>>;
}

export interface NativeBacklinkSource {
  path: string;
  value: unknown;
}

export interface NativeBacklinkIndex {
  resolvedLinks: Readonly<Record<string, Readonly<Record<string, number>>>>;
  getSource(path: string): NativeBacklinkSource | null;
  getCache(source: NativeBacklinkSource): NativeBacklinkCache | null;
  parseLinktext(value: string): { path: string; subpath: string };
  resolveDestinationPath(linkPath: string, sourcePath: string): string | null;
  readSource(source: NativeBacklinkSource): Promise<string>;
}

function sourceBlockId(cache: NativeBacklinkCache, line: number): string | undefined {
  return Object.values(cache.blocks ?? {})
    .filter((block) => block.position.start.line <= line && block.position.end.line >= line)
    .sort((left, right) => (
      (left.position.end.line - left.position.start.line)
      - (right.position.end.line - right.position.start.line)
    ))[0]?.id;
}

function sourceHeading(cache: NativeBacklinkCache, line: number): string | undefined {
  return cache.headings
    ?.filter((heading) => heading.position.start.line <= line)
    .sort((left, right) => right.position.start.line - left.position.start.line)[0]
    ?.heading;
}

function lineExcerpt(content: string, line: number): string {
  const value = content.split(/\r?\n/)[line]?.replace(/^\s*>\s?/, "").trim() ?? "";
  return value.length <= 180 ? value : `${value.slice(0, 177)}...`;
}

export async function collectNativeBacklinks(
  index: NativeBacklinkIndex,
  targetPath: string,
  blockId: string,
): Promise<StickerBacklink[]> {
  const backlinks: StickerBacklink[] = [];

  for (const [sourcePath, destinations] of Object.entries(index.resolvedLinks)) {
    if (!destinations[targetPath]) continue;
    const source = index.getSource(sourcePath);
    if (!source) continue;
    const cache = index.getCache(source);
    if (!cache?.links?.length) continue;
    let content: string | null = null;

    for (const link of cache.links) {
      const parsed = index.parseLinktext(link.link);
      if (parsed.subpath !== `#^${blockId}`) continue;
      if (index.resolveDestinationPath(parsed.path, sourcePath) !== targetPath) continue;
      content ??= await index.readSource(source);
      const line = link.position.start.line;
      const referencedBlockId = sourceBlockId(cache, line);
      const heading = sourceHeading(cache, line);
      backlinks.push({
        notePath: sourcePath,
        line,
        column: link.position.start.col,
        ...(referencedBlockId ? { blockId: referencedBlockId } : {}),
        ...(heading ? { heading } : {}),
        excerpt: lineExcerpt(content, line),
      });
    }
  }

  return backlinks;
}
