import { normalizePath, TFile, TFolder, type App } from "obsidian";

import type { VaultTextAdapter } from "./session-notes.ts";

export class ObsidianVaultAdapter implements VaultTextAdapter {
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
}
