import type { OpenNoteAction } from "../protocol.ts";

export interface EditorPosition {
  line: number;
  ch: number;
}

export interface MarkdownEditorPort {
  setCursor(position: EditorPosition): void;
  scrollIntoView(range: { from: EditorPosition; to: EditorPosition }, center?: boolean): void;
}

export interface MainMarkdownLeafPort {
  filePath(): string | null;
  open(notePath: string, subpath?: string): Promise<void>;
  reveal(): Promise<void>;
  editor(): MarkdownEditorPort | null;
}

export interface MainMarkdownWorkspacePort {
  rootMarkdownLeaves(): MainMarkdownLeafPort[];
  recentFilePath(): string | null;
  createRootTab(): MainMarkdownLeafPort;
}

export async function openNoteInMainMarkdownLeaf(
  workspace: MainMarkdownWorkspacePort,
  action: OpenNoteAction,
): Promise<MainMarkdownLeafPort> {
  const leaves = workspace.rootMarkdownLeaves();
  const recentFilePath = workspace.recentFilePath();
  const leaf = (
    (recentFilePath ? leaves.find((candidate) => candidate.filePath() === recentFilePath) : undefined)
    ?? leaves[0]
    ?? workspace.createRootTab()
  );

  await leaf.open(action.notePath, action.blockId ? `#^${action.blockId}` : undefined);
  await leaf.reveal();

  if (!action.blockId && action.line !== undefined) {
    const editor = leaf.editor();
    if (editor) {
      const position = { line: action.line, ch: action.column ?? 0 };
      editor.setCursor(position);
      editor.scrollIntoView({ from: position, to: position }, true);
    }
  }

  return leaf;
}
