import {
  normalizePath,
  parseLinktext,
  TFile,
  TFolder,
  type App,
} from "obsidian";

import { collectNativeBacklinks } from "./native-backlink-index.ts";
import type { VaultTextAdapter } from "./session-notes.ts";
import type { VaultBacklinkAdapter } from "./sticker-backlinks.ts";

export class ObsidianVaultAdapter implements VaultTextAdapter, VaultBacklinkAdapter {
  constructor(
    private readonly app: App,
    private readonly companionDirectory: string,
  ) {}

  private resolvePath(path: string): string {
    if (!path.startsWith("DeepHarness/")) return normalizePath(path);
    return normalizePath(`${this.companionDirectory}/${path.slice("DeepHarness/".length)}`);
  }

  private async ensureParentFolders(path: string): Promise<void> {
    const segments = normalizePath(path).split("/").slice(0, -1);
    let current = "";
    for (const segment of segments) {
      current = current ? `${current}/${segment}` : segment;
      const existing = this.app.vault.getAbstractFileByPath(current);
      if (existing instanceof TFolder) continue;
      if (existing) throw new Error(`Vault path is not a folder: ${current}`);
      await this.app.vault.createFolder(current);
    }
  }

  async read(path: string): Promise<string | null> {
    const resolved = this.resolvePath(path);
    const file = this.app.vault.getAbstractFileByPath(resolved);
    if (!file) return null;
    if (!(file instanceof TFile)) throw new Error(`Vault path is not a Markdown file: ${resolved}`);
    return this.app.vault.cachedRead(file);
  }

  async listMarkdownPaths(): Promise<string[]> {
    return this.app.vault.getMarkdownFiles().map((file) => file.path);
  }

  async write(path: string, content: string): Promise<void> {
    const resolved = this.resolvePath(path);
    const existing = this.app.vault.getAbstractFileByPath(resolved);
    if (existing instanceof TFile) {
      await this.app.vault.modify(existing, content);
      return;
    }
    if (existing) throw new Error(`Vault path is not a Markdown file: ${resolved}`);
    await this.ensureParentFolders(resolved);
    await this.app.vault.create(resolved, content);
  }

  async process(path: string, update: (content: string) => string): Promise<string> {
    const resolved = this.resolvePath(path);
    const file = this.app.vault.getAbstractFileByPath(resolved);
    if (!(file instanceof TFile)) throw new Error(`Vault Markdown note was not found: ${resolved}`);
    return this.app.vault.process(file, update);
  }

  async listNativeBacklinks(notePath: string, blockId: string) {
    const targetPath = this.resolvePath(notePath);
    return collectNativeBacklinks({
      resolvedLinks: this.app.metadataCache.resolvedLinks,
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
  }
}
