import { describe, expect, it, vi } from "vitest";

import { captureEditorSelection } from "../src/selection/editor-menu.ts";
import { captureReadingSelection } from "../src/selection/reading-menu.ts";
import { contentRevision } from "../src/vault/session-notes.ts";

class FakeEditor {
  value = "# Generation\n\nGeneration 保存完整组合。\n";
  selection = "Generation 保存完整组合。";
  replaceRange = vi.fn((replacement: string, from: { line: number; ch: number }) => {
    const lines = this.value.split("\n");
    const line = lines[from.line] ?? "";
    lines[from.line] = `${line.slice(0, from.ch)}${replacement}${line.slice(from.ch)}`;
    this.value = lines.join("\n");
  });

  getSelection(): string { return this.selection; }
  getValue(): string { return this.value; }
  getCursor(which: "from" | "to"): { line: number; ch: number } {
    return which === "from" ? { line: 2, ch: 0 } : { line: 2, ch: this.selection.length };
  }
  getLine(line: number): string { return this.value.split("\n")[line] ?? ""; }
}

describe("Obsidian selection capture", () => {
  it("normalizes editor text and assigns a stable paragraph block ID", () => {
    const editor = new FakeEditor();
    editor.selection = "  Generation 保存完整组合。\r\n";
    const result = captureEditorSelection(editor, { path: "架构/DSH维护引擎.md" }, {
      createCitationId: () => "76213b70-7f6e-41be-b2e3-1b195cbf1268",
    });

    expect(result).toMatchObject({
      citationId: "76213b70-7f6e-41be-b2e3-1b195cbf1268",
      notePath: "架构/DSH维护引擎.md",
      heading: "Generation",
      text: "Generation 保存完整组合。",
      blockId: expect.stringMatching(/^dsh-note-[a-f0-9]{8}$/),
    });
    expect(editor.replaceRange).toHaveBeenCalledOnce();
    expect(result?.contentHash).toBe(contentRevision(editor.value));
  });

  it("ignores empty editor selections without changing the note", () => {
    const editor = new FakeEditor();
    editor.selection = "  \n";
    expect(captureEditorSelection(editor, { path: "note.md" })).toBeNull();
    expect(editor.replaceRange).not.toHaveBeenCalled();
  });

  it("captures reading selections only from the active Markdown preview", () => {
    const previewNode = {};
    const outsideNode = {};
    const view = {
      file: { path: "架构/DSH维护引擎.md" },
      containerEl: { contains: (node: unknown) => node === previewNode },
      getViewData: () => "# Generation\n\nGeneration 保存完整组合。 ^generation-definition\n",
    };
    const makeSelection = (node: unknown) => ({
      rangeCount: 1,
      toString: () => "Generation 保存完整组合。",
      getRangeAt: () => ({ commonAncestorContainer: node }),
    });

    expect(captureReadingSelection(view, makeSelection(previewNode), {
      createCitationId: () => "76213b70-7f6e-41be-b2e3-1b195cbf1268",
    })).toMatchObject({
      notePath: "架构/DSH维护引擎.md",
      blockId: "generation-definition",
      heading: "Generation",
      text: "Generation 保存完整组合。",
      requiresBlockIdWrite: false,
    });
    expect(captureReadingSelection(view, makeSelection(outsideNode))).toBeNull();
  });
});
