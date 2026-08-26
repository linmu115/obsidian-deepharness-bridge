import { describe, expect, it, vi } from "vitest";

import { captureEditorSelection } from "../src/selection/editor-menu.ts";
import { captureReadingSelection } from "../src/selection/reading-menu.ts";
import { documentHash, selectedTextHash } from "../src/protocol.ts";

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
      vaultId: "vault-1",
      createReferenceId: () => "76213b70-7f6e-41be-b2e3-1b195cbf1268",
      createActionId: () => "action-1",
      now: () => 1_777_000_000_000,
    });

    expect(result).toMatchObject({
      type: "reference-capture",
      actionId: "action-1",
      referenceId: "76213b70-7f6e-41be-b2e3-1b195cbf1268",
      source: {
        selectedText: "Generation 保存完整组合。",
        locator: {
          vaultId: "vault-1",
          notePath: "架构/DSH维护引擎.md",
          heading: "Generation",
          blockId: expect.stringMatching(/^dsh-note-[a-f0-9]{8}$/),
          occurrence: 0,
          selectedTextHash: selectedTextHash("Generation 保存完整组合。"),
        },
        snapshot: { markdown: editor.value, documentHash: documentHash(editor.value), freshness: "captured" },
      },
      blockIdOwnership: "plugin-created",
    });
    expect(editor.replaceRange).toHaveBeenCalledOnce();
  });

  it("preserves a pre-existing editor block ID and records that the plugin does not own it", () => {
    const editor = new FakeEditor();
    editor.value = "# Generation\n\nGeneration 保存完整组合。 ^user-owned\n";

    const result = captureEditorSelection(editor, { path: "架构/DSH维护引擎.md" }, {
      vaultId: "vault-1",
      createReferenceId: () => "reference-existing",
      createActionId: () => "action-existing",
      now: () => 1_777_000_000_000,
    });

    expect(result).toMatchObject({
      blockIdOwnership: "pre-existing",
      source: { locator: { blockId: "user-owned" } },
    });
    expect(editor.replaceRange).not.toHaveBeenCalled();
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
      vaultId: "vault-1",
      createReferenceId: () => "76213b70-7f6e-41be-b2e3-1b195cbf1268",
      createActionId: () => "action-1",
    })).toMatchObject({
      source: {
        selectedText: "Generation 保存完整组合。",
        locator: {
          vaultId: "vault-1",
          notePath: "架构/DSH维护引擎.md",
          blockId: "generation-definition",
          heading: "Generation",
          occurrence: 0,
        },
      },
      requiresBlockIdWrite: false,
      blockIdOwnership: "pre-existing",
    });
    expect(captureReadingSelection(view, makeSelection(outsideNode))).toBeNull();
  });

  it("refuses an ambiguous repeated reading selection instead of defaulting occurrence to zero", () => {
    const previewNode = {};
    const view = {
      file: { path: "重复.md" },
      containerEl: { contains: (node: unknown) => node === previewNode },
      getViewData: () => "重复段落\n\n重复段落\n",
    };
    const selection = {
      rangeCount: 1,
      toString: () => "重复段落",
      getRangeAt: () => ({ commonAncestorContainer: previewNode }),
    };
    expect(captureReadingSelection(view, selection, { vaultId: "vault-1" })).toBeNull();
  });
});
