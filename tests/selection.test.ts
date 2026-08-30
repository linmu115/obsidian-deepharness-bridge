import { describe, expect, it, vi } from "vitest";

import { captureEditorSelection } from "../src/selection/editor-menu.ts";
import { captureReadingSelection, registerReadingSelectionMenu } from "../src/selection/reading-menu.ts";
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

  it("uses the nearest rendered block ID after a committed reference duplicates the quote", () => {
    const markerChip = {
      dataset: { dshBlockId: "^original-paragraph" },
      getAttribute: (name: string) => name === "data-dsh-block-id" ? "^original-paragraph" : null,
    };
    const paragraph = {
      querySelector: (selector: string) => selector === "[data-dsh-block-id]" ? markerChip : null,
    };
    const previewText = {
      closest: (selector: string) => selector.startsWith("p, li") ? paragraph : null,
    };
    const source = [
      "可重复引用的原文。 ^original-paragraph",
      "",
      "> [!dsh-reference] DSH 引用",
      "> 可重复引用的原文。",
      "",
    ].join("\n");
    const view = {
      file: { path: "重复引用.md" },
      containerEl: { contains: (node: unknown) => node === previewText },
      getViewData: () => source,
    };
    const selection = {
      rangeCount: 1,
      toString: () => "可重复引用的原文。",
      getRangeAt: () => ({ commonAncestorContainer: previewText }),
    };

    expect(captureReadingSelection(view, selection, { vaultId: "vault-1" })).toMatchObject({
      source: { locator: { blockId: "original-paragraph", occurrence: 0 } },
      requiresBlockIdWrite: false,
    });
  });

  it("preserves Copy and appends DSH in Obsidian's shared event menu", () => {
    const previewNode = {};
    const selection = {
      rangeCount: 1,
      toString: () => "可引用原文。",
      getRangeAt: () => ({ commonAncestorContainer: previewNode }),
    };
    const view = {
      file: { path: "菜单.md" },
      containerEl: { contains: (node: unknown) => node === previewNode },
      getViewData: () => "可引用原文。\n",
    };
    let listener: ((event: MouseEvent) => void) | undefined;
    let registrationOptions: boolean | AddEventListenerOptions | undefined;
    const fakeDocument = { getSelection: () => selection };
    const plugin = {
      app: {
        vault: {},
        workspace: { getActiveViewOfType: () => view },
      },
      registerDomEvent: (_target: unknown, _type: string, callback: (event: MouseEvent) => void, options?: boolean | AddEventListenerOptions) => {
        listener = callback;
        registrationOptions = options;
      },
    };
    const titles: string[] = [];
    const clickHandlers: Array<() => unknown> = [];
    const menu = {
      addItem: vi.fn((configure: (value: unknown) => unknown) => {
        const item = {
          setTitle(title: string) { titles.push(title); return this; },
          setIcon() { return this; },
          onClick(handler: () => unknown) { clickHandlers.push(handler); return this; },
        };
        configure(item);
        return menu;
      }),
      showAtMouseEvent: vi.fn(),
    };
    const event = { preventDefault: vi.fn() } as unknown as MouseEvent;
    const copyText = vi.fn();

    registerReadingSelectionMenu(plugin as never, {
      markdownViewType: class FakeMarkdownView {} as never,
      document: fakeDocument as never,
      menuForEvent: () => menu as never,
      copyText,
      onCitation: vi.fn(),
    });
    listener?.(event);

    expect(menu.addItem).toHaveBeenCalledTimes(2);
    expect(titles).toEqual(["复制", "引用到 DSH"]);
    expect(registrationOptions).toEqual({ capture: true });
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(menu.showAtMouseEvent).not.toHaveBeenCalled();
    expect(clickHandlers).toHaveLength(2);
    void clickHandlers[0]?.();
    expect(copyText).toHaveBeenCalledWith("可引用原文。");
  });

  it("leaves the original menu untouched when a reading selection cannot be resolved", () => {
    const previewNode = {};
    const selection = {
      rangeCount: 1,
      toString: () => "重复段落",
      getRangeAt: () => ({ commonAncestorContainer: previewNode }),
    };
    const view = {
      file: { path: "歧义.md" },
      containerEl: { contains: (node: unknown) => node === previewNode },
      getViewData: () => "重复段落\n\n重复段落\n",
    };
    let listener: ((event: MouseEvent) => void) | undefined;
    const plugin = {
      app: { vault: {}, workspace: { getActiveViewOfType: () => view } },
      registerDomEvent: (_target: unknown, _type: string, callback: (event: MouseEvent) => void) => {
        listener = callback;
      },
    };
    const menuForEvent = vi.fn();
    const event = { preventDefault: vi.fn() } as unknown as MouseEvent;

    registerReadingSelectionMenu(plugin as never, {
      markdownViewType: class FakeMarkdownView {} as never,
      document: { getSelection: () => selection } as never,
      menuForEvent,
      onCitation: vi.fn(),
    });
    listener?.(event);

    expect(menuForEvent).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
  });
});
