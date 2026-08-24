import {
  MarkdownView,
  normalizePath,
  TFile,
  type App,
  type WorkspaceLeaf,
} from "obsidian";

import {
  type MainMarkdownLeafPort,
  type MainMarkdownWorkspacePort,
  type MarkdownEditorPort,
} from "./open-note.ts";

function stateFilePath(leaf: WorkspaceLeaf): string | null {
  if (leaf.view instanceof MarkdownView) return leaf.view.file?.path ?? null;
  const state = leaf.getViewState().state;
  return state && typeof state.file === "string" ? state.file : null;
}

export class ObsidianMainMarkdownLeaf implements MainMarkdownLeafPort {
  constructor(
    private readonly app: App,
    private readonly leaf: WorkspaceLeaf,
  ) {}

  filePath(): string | null {
    return stateFilePath(this.leaf);
  }

  async open(notePath: string, subpath?: string): Promise<void> {
    const normalizedPath = normalizePath(notePath);
    const file = this.app.vault.getAbstractFileByPath(normalizedPath);
    if (!(file instanceof TFile)) throw new Error(`Obsidian note is unavailable: ${normalizedPath}`);

    await this.leaf.openFile(file, {
      active: true,
      ...(subpath ? { eState: { subpath } } : {}),
    });
    await this.leaf.loadIfDeferred();
  }

  async reveal(): Promise<void> {
    this.app.workspace.revealLeaf(this.leaf);
  }

  editor(): MarkdownEditorPort | null {
    return this.leaf.view instanceof MarkdownView ? this.leaf.view.editor : null;
  }
}

export class ObsidianMainMarkdownWorkspace implements MainMarkdownWorkspacePort {
  constructor(private readonly app: App) {}

  rootMarkdownLeaves(): MainMarkdownLeafPort[] {
    const leaves: MainMarkdownLeafPort[] = [];
    this.app.workspace.iterateRootLeaves((leaf) => {
      if (leaf.getViewState().type === "markdown") {
        leaves.push(new ObsidianMainMarkdownLeaf(this.app, leaf));
      }
    });
    return leaves;
  }

  recentFilePath(): string | null {
    return this.app.workspace.getActiveFile()?.path ?? null;
  }

  createRootTab(): MainMarkdownLeafPort {
    return new ObsidianMainMarkdownLeaf(this.app, this.app.workspace.getLeaf("tab"));
  }
}
