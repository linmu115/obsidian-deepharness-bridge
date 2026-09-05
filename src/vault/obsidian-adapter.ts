import {
  normalizePath,
  parseLinktext,
  TFile,
  TFolder,
  type App,
} from "obsidian";

import { collectNativeBacklinks } from "./native-backlink-index.ts";
import type { AtomicVaultTextAdapter } from "./session-notes.ts";
import type { VaultBacklinkAdapter } from "./sticker-backlinks.ts";
import { KeyedSerialWork } from "../serial-work.ts";
import { MarkdownLookupIndex, type MarkdownLookupKind } from "./markdown-lookup-index.ts";

// Shared by adapters for the same Vault, including a settings restart.
const vaultWork = new WeakMap<object, KeyedSerialWork>();

export class ObsidianVaultAdapter implements AtomicVaultTextAdapter, VaultBacklinkAdapter {
  private readonly work: KeyedSerialWork;
  private readonly lookup: MarkdownLookupIndex;
  private metadataGeneration = 0;
  private nativeSources: Map<string, string[]> | undefined;
  private readonly nativeResults = new Map<string, Promise<Awaited<ReturnType<typeof collectNativeBacklinks>>>>();

  constructor(
    private readonly app: App,
    private readonly companionDirectory: string,
  ) {
    this.work = vaultWork.get(app.vault) ?? new KeyedSerialWork();
    vaultWork.set(app.vault, this.work);
    this.lookup = new MarkdownLookupIndex(() => this.listMarkdownPaths(), (path) => this.read(path));
  }

  invalidate(path?: string): void {
    this.lookup.invalidate(path);
    this.invalidateMetadata();
  }

  invalidateMetadata(): void {
    this.metadataGeneration += 1;
    this.nativeSources = undefined;
    this.nativeResults.clear();
  }

  get indexDiagnostics() { return this.lookup.diagnostics; }

  findMarkdownPaths(kind: MarkdownLookupKind, id: string): Promise<readonly string[]> {
    return this.lookup.find(kind, id);
  }

  sessionNotePath(sessionId: string): string {
    return normalizePath(`${this.companionDirectory}/Sessions/${encodeURIComponent(sessionId)}.md`);
  }

  private async ensureParentFolders(path: string): Promise<void> {
    const segments = normalizePath(path).split("/").slice(0, -1);
    let current = "";
    for (const segment of segments) {
      current = current ? `${current}/${segment}` : segment;
      const folderPath = current;
      await this.work.run(folderPath, async () => {
        const existing = this.app.vault.getAbstractFileByPath(folderPath);
        if (existing instanceof TFolder) return;
        if (existing) throw new Error(`Vault path is not a folder: ${folderPath}`);
        try { await this.app.vault.createFolder(folderPath); }
        catch (error) {
          if (!(this.app.vault.getAbstractFileByPath(folderPath) instanceof TFolder)) throw error;
        }
      });
    }
  }

  async read(path: string): Promise<string | null> {
    const resolved = normalizePath(path);
    const file = this.app.vault.getAbstractFileByPath(resolved);
    if (!file) return null;
    if (!(file instanceof TFile)) throw new Error(`Vault path is not a Markdown file: ${resolved}`);
    return this.app.vault.cachedRead(file);
  }

  async listMarkdownPaths(): Promise<string[]> {
    return this.app.vault.getMarkdownFiles().map((file) => file.path);
  }

  async write(path: string, content: string): Promise<void> {
    await this.update(path, () => content);
  }

  async update(path: string, update: (content: string | null) => string): Promise<string> {
    const resolved = normalizePath(path);
    return this.work.run(resolved, async () => {
      await this.ensureParentFolders(resolved);
      const existing = this.app.vault.getAbstractFileByPath(resolved);
      if (existing instanceof TFile) {
        try { return await this.app.vault.process(existing, update); }
        finally { this.invalidate(resolved); }
      }
      if (existing) throw new Error(`Vault path is not a Markdown file: ${resolved}`);
      const content = update(null);
      try { await this.app.vault.create(resolved, content); }
      catch (error) {
        // Another window may create the note while folders are being created.
        const created = this.app.vault.getAbstractFileByPath(resolved);
        if (!(created instanceof TFile)) throw error;
        return await this.app.vault.process(created, update);
      } finally { this.invalidate(resolved); }
      return content;
    });
  }

  async process(path: string, update: (content: string) => string): Promise<string> {
    const resolved = normalizePath(path);
    return this.work.run(resolved, async () => {
      const file = this.app.vault.getAbstractFileByPath(resolved);
      if (!(file instanceof TFile)) throw new Error(`Vault Markdown note was not found: ${resolved}`);
      try { return await this.app.vault.process(file, update); }
      finally { this.invalidate(resolved); }
    });
  }

  async listNativeBacklinks(notePath: string, blockId: string): Promise<Awaited<ReturnType<typeof collectNativeBacklinks>>> {
    const targetPath = normalizePath(notePath);
    const key = JSON.stringify([targetPath, blockId]);
    const cached = this.nativeResults.get(key);
    if (cached) return cached;
    if (!this.nativeSources) {
      this.nativeSources = new Map();
      for (const [source, destinations] of Object.entries(this.app.metadataCache.resolvedLinks)) {
        for (const [target, count] of Object.entries(destinations)) {
          if (!count) continue;
          const sources = this.nativeSources.get(target) ?? [];
          sources.push(source);
          this.nativeSources.set(target, sources);
        }
      }
    }
    const generation = this.metadataGeneration;
    const result = collectNativeBacklinks({
      resolvedLinks: this.app.metadataCache.resolvedLinks,
      sourcePaths: this.nativeSources.get(targetPath) ?? [],
      getSource: (path) => {
        const file = this.app.vault.getAbstractFileByPath(path);
        return file instanceof TFile ? { path: file.path, value: file } : null;
      },
      getCache: (source) => this.app.metadataCache.getFileCache(source.value as TFile),
      parseLinktext,
      resolveDestinationPath: (linkPath, sourcePath) => (
        this.app.metadataCache.getFirstLinkpathDest(linkPath, sourcePath)?.path ?? null
      ),
      readSource: (source) => this.app.vault.cachedRead(source.value as TFile),
    }, targetPath, blockId);
    const validated = result.then((backlinks) => generation === this.metadataGeneration
      ? backlinks : this.listNativeBacklinks(notePath, blockId)).catch((error: unknown) => {
      if (this.nativeResults.get(key) === validated) this.nativeResults.delete(key);
      throw error;
    });
    if (generation === this.metadataGeneration) this.nativeResults.set(key, validated);
    return validated;
  }
}
