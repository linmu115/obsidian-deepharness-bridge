import { vi } from "vitest";
import type { App } from "obsidian";
import { KeyedSerialWork } from "../../src/serial-work.ts";

export class SyntheticFile { constructor(public path: string) {} }
export class SyntheticFolder { constructor(public path: string) {} }

/** All contents and host callbacks are in memory; no real Obsidian runtime is used. */
export function syntheticApp() {
  const files = new Map<string, string>();
  const entries = new Map<string, SyntheticFile | SyntheticFolder>();
  const work = new KeyedSerialWork();
  const vault = {
    getAbstractFileByPath: (path: string) => entries.get(path) ?? null,
    getMarkdownFiles: () => [...entries.values()].filter((entry) => entry instanceof SyntheticFile),
    cachedRead: vi.fn(async (file: SyntheticFile) => files.get(file.path)!),
    process: vi.fn((file: SyntheticFile, update: (content: string) => string) => work.run(file.path, async () => {
      const next = update(files.get(file.path)!); files.set(file.path, next); return next;
    })),
    createFolder: vi.fn(async (path: string) => {
      if (entries.has(path)) throw new Error("already exists");
      const folder = new SyntheticFolder(path); entries.set(path, folder); return folder;
    }),
    create: vi.fn(async (path: string, source: string) => {
      if (entries.has(path)) throw new Error("already exists");
      const file = new SyntheticFile(path); entries.set(path, file); files.set(path, source); return file;
    }),
    on: vi.fn(() => ({})),
  };
  const metadataCache = {
    resolvedLinks: {} as Record<string, Record<string, number>>,
    on: vi.fn(() => ({})),
    getFileCache: vi.fn((): unknown => null),
    getFirstLinkpathDest: vi.fn((): { path: string } | null => null),
  };
  const workspace = { on: vi.fn(() => ({})), onLayoutReady: vi.fn(), getLeavesOfType: vi.fn(() => []), getActiveFile: vi.fn(() => null) };
  return {
    app: { vault, metadataCache, workspace } as unknown as App,
    files, entries, vault, metadataCache, workspace,
    put(path: string, source: string) { entries.set(path, new SyntheticFile(path)); files.set(path, source); },
  };
}

export const obsidianPath = (path: string) => path.replace(/\\/g, "/").replace(/\/+/g, "/");
export const parseSyntheticLink = (value: string) => {
  const [path, ...fragment] = value.split("#");
  return { path, subpath: fragment.length ? `#${fragment.join("#")}` : "" };
};
