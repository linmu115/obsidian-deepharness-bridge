import { describe, expect, it, vi } from "vitest";

import {
  openNoteInMainMarkdownLeaf,
  type MainMarkdownLeafPort,
  type MainMarkdownWorkspacePort,
} from "../src/workspace/open-note.ts";
import type { OpenNoteAction } from "../src/protocol.ts";

function action(patch: Partial<OpenNoteAction> = {}): OpenNoteAction {
  return {
    protocolVersion: 1,
    type: "open-note",
    actionId: "c8a4fe4c-eb9d-448a-8864-30328ef0cdb4",
    notePath: "Notes/reference.md",
    ...patch,
  };
}

function markdownLeaf(path: string | null) {
  const editor = {
    setCursor: vi.fn(),
    scrollIntoView: vi.fn(),
  };
  const leaf: MainMarkdownLeafPort = {
    filePath: () => path,
    open: vi.fn(async () => undefined),
    reveal: vi.fn(async () => undefined),
    editor: () => editor,
  };
  return { leaf, editor };
}

function workspace(
  leaves: MainMarkdownLeafPort[],
  recentFilePath: string | null,
  created: MainMarkdownLeafPort,
): MainMarkdownWorkspacePort {
  return {
    rootMarkdownLeaves: () => leaves,
    recentFilePath: () => recentFilePath,
    createRootTab: vi.fn(() => created),
  };
}

describe("open note in the main Markdown area", () => {
  it("opens the backlink in the existing Markdown leaf instead of replacing the DSH webviewer", async () => {
    const markdown = markdownLeaf("Notes/current.md");
    const created = markdownLeaf(null);
    const host = workspace([markdown.leaf], "Notes/current.md", created.leaf);

    const selected = await openNoteInMainMarkdownLeaf(host, action());

    expect(selected).toBe(markdown.leaf);
    expect(markdown.leaf.open).toHaveBeenCalledWith("Notes/reference.md", undefined);
    expect(markdown.leaf.reveal).toHaveBeenCalledOnce();
    expect(host.createRootTab).not.toHaveBeenCalled();
  });

  it("prefers the most recently active Markdown file when multiple main leaves exist", async () => {
    const first = markdownLeaf("Notes/first.md");
    const recent = markdownLeaf("Notes/recent.md");
    const created = markdownLeaf(null);

    await openNoteInMainMarkdownLeaf(
      workspace([first.leaf, recent.leaf], "Notes/recent.md", created.leaf),
      action(),
    );

    expect(recent.leaf.open).toHaveBeenCalledOnce();
    expect(first.leaf.open).not.toHaveBeenCalled();
  });

  it("creates a new root Markdown tab when no Markdown leaf exists", async () => {
    const created = markdownLeaf(null);
    const host = workspace([], null, created.leaf);

    await openNoteInMainMarkdownLeaf(host, action());

    expect(host.createRootTab).toHaveBeenCalledOnce();
    expect(created.leaf.open).toHaveBeenCalledWith("Notes/reference.md", undefined);
  });

  it("opens a native Obsidian block subpath without applying a line fallback", async () => {
    const markdown = markdownLeaf("Notes/current.md");

    await openNoteInMainMarkdownLeaf(
      workspace([markdown.leaf], "Notes/current.md", markdown.leaf),
      action({ blockId: "dsh-ref-example", line: 8, column: 3 }),
    );

    expect(markdown.leaf.open).toHaveBeenCalledWith("Notes/reference.md", "#^dsh-ref-example");
    expect(markdown.editor.setCursor).not.toHaveBeenCalled();
  });

  it("positions the selected Markdown editor for legacy line backlinks", async () => {
    const markdown = markdownLeaf("Notes/current.md");

    await openNoteInMainMarkdownLeaf(
      workspace([markdown.leaf], "Notes/current.md", markdown.leaf),
      action({ line: 8, column: 3 }),
    );

    const position = { line: 8, ch: 3 };
    expect(markdown.editor.setCursor).toHaveBeenCalledWith(position);
    expect(markdown.editor.scrollIntoView).toHaveBeenCalledWith({ from: position, to: position }, true);
  });
});
