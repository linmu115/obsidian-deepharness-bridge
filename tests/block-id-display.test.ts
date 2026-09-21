import { JSDOM } from "jsdom";
import { describe, expect, it, vi } from "vitest";
import type { StateEffect } from "@codemirror/state";
import type { Decoration, DecorationSet, EditorView, WidgetType } from "@codemirror/view";

import {
  buildDshReferenceBlockDecorations,
  collectManagedDshReferenceBlockEntries,
  collectManagedDshReferenceBlocks,
  collectCompactDshBlockIds,
  compactRenderedDshBlockIds,
  hideRenderedDshReferenceBlocks,
  shouldCompactDshBlockIds,
  toggleDshReferenceBlock,
} from "../src/ui/block-id-display.ts";

describe("compact DSH block ID display", () => {
  it("finds only generated dsh-note anchors at the end of a line", () => {
    const markdown = [
      "被引用的段落。 ^dsh-note-b0ede882",
      "用户自己的块标记。 ^project-anchor",
      "正文示例 ^dsh-note-not-an-anchor because text follows",
      "网址片段example^dsh-note-not-a-block",
      "另一个引用。 ^dsh-note-A1_b-2   ",
    ].join("\n");

    expect(collectCompactDshBlockIds(markdown)).toEqual([
      {
        from: markdown.indexOf("^dsh-note-b0ede882"),
        to: markdown.indexOf("^dsh-note-b0ede882") + "^dsh-note-b0ede882".length,
        marker: "^dsh-note-b0ede882",
      },
      {
        from: markdown.indexOf("^dsh-note-A1_b-2"),
        to: markdown.indexOf("^dsh-note-A1_b-2") + "^dsh-note-A1_b-2".length,
        marker: "^dsh-note-A1_b-2",
      },
    ]);
  });

  it("preserves the full marker for the hover label", () => {
    const [match] = collectCompactDshBlockIds("内容 ^dsh-note-0123456789abcdef");
    expect(match?.marker).toBe("^dsh-note-0123456789abcdef");
  });

  it("keeps source mode raw and compacts only live preview", () => {
    expect(shouldCompactDshBlockIds(false)).toBe(false);
    expect(shouldCompactDshBlockIds(true)).toBe(true);
  });

  it("finds complete managed reference blocks so live preview can hide their source", () => {
    const markdown = [
      "正文。 ^dsh-note-01234567",
      "",
      '<!-- dsh-reference:{"referenceId":"reference-1"} -->',
      "> [!dsh-reference]",
      "> [打开 DSH 会话](obsidian://deepharness?session=session-1)",
      "> 引用内容：正文。",
      "> ^dsh-ref-reference",
      "<!-- /dsh-reference -->",
      "",
      "后文。",
    ].join("\n");
    const start = markdown.indexOf("<!-- dsh-reference:");
    const end = markdown.indexOf("<!-- /dsh-reference -->") + "<!-- /dsh-reference -->".length;

    expect(collectManagedDshReferenceBlocks(markdown)).toEqual([{ from: start, to: end }]);
  });

  it("removes only managed DSH reference callouts in reading mode", () => {
    const dom = new JSDOM([
      '<div id="root">',
      '  <div class="callout" data-callout="dsh-reference">托管引用</div>',
      '  <div class="callout" data-callout="note">用户笔记</div>',
      "</div>",
    ].join(""));
    const root = dom.window.document.querySelector<HTMLElement>("#root");

    expect(root).not.toBeNull();
    expect(hideRenderedDshReferenceBlocks(root as HTMLElement)).toBe(1);
    expect(root?.querySelector('[data-callout="dsh-reference"]')).toBeNull();
    expect(root?.querySelector('[data-callout="note"]')?.textContent).toBe("用户笔记");
  });

  it("opens from the chip body and deletes only from the dedicated control", () => {
    const dom = new JSDOM('<div id="root">被引用的段落。 ^dsh-note-01234567</div>', {
      url: "https://obsidian.local/note",
    });
    const previous = globalThis.NodeFilter;
    Object.assign(globalThis, { NodeFilter: dom.window.NodeFilter });
    try {
      const root = dom.window.document.querySelector<HTMLElement>("#root");
      const onOpen = vi.fn();
      const onDelete = vi.fn();
      expect(root).not.toBeNull();
      expect(compactRenderedDshBlockIds(root as HTMLElement, { onOpen, onDelete })).toBe(1);
      const chip = root?.querySelector<HTMLElement>(".dsh-block-id-chip");
      expect(chip?.getAttribute("role")).toBe("link");
      chip?.click();
      expect(onOpen).toHaveBeenCalledWith("^dsh-note-01234567", chip);
      expect(onDelete).not.toHaveBeenCalled();
      const button = root?.querySelector<HTMLButtonElement>(".dsh-block-id-delete");
      expect(button?.getAttribute("aria-label")).toBe("删除 DSH 引用");
      button?.click();
      expect(onDelete).toHaveBeenCalledWith("^dsh-note-01234567");
      expect(onOpen).toHaveBeenCalledTimes(1);
      expect(root?.querySelector(".dsh-block-id-chip")).toBeNull();
    } finally {
      Object.assign(globalThis, { NodeFilter: previous });
    }
  });
});

function managedReferenceSource(referenceId: string): string {
  return [
    "正文。 ^dsh-note-01234567",
    "",
    `<!-- dsh-reference:{"referenceId":"${referenceId}","blockId":"dsh-ref-01234567"} -->`,
    "> [!dsh-reference]",
    "> [打开 DSH 会话](obsidian://deepharness?session=session-1)",
    "> 引用内容：正文。",
    "> ^dsh-ref-01234567",
    "<!-- /dsh-reference -->",
    "",
    "后文。",
  ].join("\n");
}

function managedBlockSpan(markdown: string): { start: number; end: number } {
  const start = markdown.indexOf("<!-- dsh-reference:");
  return { start, end: markdown.indexOf("<!-- /dsh-reference -->") + "<!-- /dsh-reference -->".length };
}

function rangesIn(set: DecorationSet): { from: number; to: number; value: Decoration }[] {
  const ranges: { from: number; to: number; value: Decoration }[] = [];
  set.between(0, Number.MAX_SAFE_INTEGER, (from, to, value) => { ranges.push({ from, to, value }); });
  return ranges;
}

function fakeView(): { view: EditorView; dispatch: ReturnType<typeof vi.fn> } {
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  const dispatch = vi.fn();
  return { view: { dom: { ownerDocument: dom.window.document }, dispatch } as unknown as EditorView, dispatch };
}

function widgetOf(set: DecorationSet): WidgetType {
  const [range] = rangesIn(set);
  expect(range).toBeDefined();
  return range!.value.spec.widget as WidgetType;
}

describe("managed DSH reference block display in live preview", () => {
  it("replaces the block with a visible capsule instead of an empty replacement", () => {
    const markdown = managedReferenceSource("reference-1");
    const { start, end } = managedBlockSpan(markdown);

    const { decorations, atomic } = buildDshReferenceBlockDecorations(markdown, true);
    const ranges = rangesIn(decorations);

    expect(ranges).toHaveLength(1);
    expect({ from: ranges[0]!.from, to: ranges[0]!.to }).toEqual({ from: start, to: end });
    // The previous build replaced the span with nothing, so a widget here is the regression guard.
    expect(ranges[0]!.value.spec.widget).toBeDefined();
    expect(ranges[0]!.value.spec.inclusive).toBe(true);
    expect(rangesIn(atomic).map(({ from, to }) => ({ from, to }))).toEqual([{ from: start, to: end }]);
  });

  it("draws both sentinels and a capsule that stays on the text line and toggles expansion", () => {
    const markdown = managedReferenceSource("reference-1");
    const key = collectManagedDshReferenceBlockEntries(markdown)[0]!.key;
    const { decorations } = buildDshReferenceBlockDecorations(markdown, true);
    const widget = widgetOf(decorations);
    const { view, dispatch } = fakeView();

    // A height estimate of 5px or more would make CodeMirror give the replacement its own line.
    expect(widget.estimatedHeight).toBe(-1);

    const capsule = widget.toDOM(view);
    expect(capsule.className).toContain("dsh-reference-capsule");
    expect(capsule.querySelector(".dsh-reference-sentinel-start")?.textContent).toBe("▸");
    expect(capsule.querySelector(".dsh-reference-sentinel-end")?.textContent).toBe("◂");
    expect(capsule.querySelector(".dsh-reference-capsule-label")?.textContent).toBe("引用");
    const toggle = capsule.querySelector<HTMLButtonElement>(".dsh-reference-capsule-toggle");
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");

    toggle!.click();
    expect(dispatch).toHaveBeenCalledTimes(1);
    const effects = (dispatch.mock.calls[0]![0] as { effects: readonly StateEffect<string>[] }).effects;
    expect(effects).toHaveLength(1);
    expect(effects[0]!.is(toggleDshReferenceBlock)).toBe(true);
    expect(effects[0]!.value).toBe(key);
  });

  it("drops the replacement for an expanded block so its source is visible and editable", () => {
    const markdown = managedReferenceSource("reference-1");
    const { start, end } = managedBlockSpan(markdown);
    const key = collectManagedDshReferenceBlockEntries(markdown)[0]!.key;

    const collapsed = buildDshReferenceBlockDecorations(markdown, true);
    expect(collapsed.atomic.size).toBe(1);
    expect(rangesIn(collapsed.decorations)[0]).toMatchObject({ from: start, to: end });

    const expanded = buildDshReferenceBlockDecorations(markdown, true, new Set([key]));
    const ranges = rangesIn(expanded.decorations);
    expect(ranges).toHaveLength(1);
    // A zero-width widget at the block start: the raw block text is no longer replaced.
    expect({ from: ranges[0]!.from, to: ranges[0]!.to }).toEqual({ from: start, to: start });
    expect(ranges[0]!.value.spec.widget).toBeDefined();
    expect(expanded.atomic.size).toBe(0);

    const capsule = widgetOf(expanded.decorations).toDOM(fakeView().view);
    expect(capsule.className).toContain("dsh-reference-capsule-expanded");
    expect(capsule.querySelector(".dsh-reference-capsule-toggle")?.getAttribute("aria-expanded")).toBe("true");
  });

  it("expands one block at a time and leaves the others collapsed", () => {
    const markdown = `${managedReferenceSource("reference-a")}\n\n${managedReferenceSource("reference-b")}`;
    const entries = collectManagedDshReferenceBlockEntries(markdown);
    expect(entries).toHaveLength(2);

    const mixed = buildDshReferenceBlockDecorations(markdown, true, new Set([entries[0]!.key]));
    expect(rangesIn(mixed.decorations)).toHaveLength(2);
    expect(mixed.atomic.size).toBe(1);
    expect({ from: rangesIn(mixed.atomic)[0]!.from, to: rangesIn(mixed.atomic)[0]!.to })
      .toEqual({ from: entries[1]!.from, to: entries[1]!.to });
  });

  it("keeps source mode raw and keeps a block's key stable while its body is edited", () => {
    const markdown = managedReferenceSource("reference-1");
    const source = buildDshReferenceBlockDecorations(markdown, false);
    expect(source.decorations.size).toBe(0);
    expect(source.atomic.size).toBe(0);

    const key = collectManagedDshReferenceBlockEntries(markdown)[0]!.key;
    const edited = markdown.replace("> 引用内容：正文。", "> 引用内容：改过的正文。");
    expect(collectManagedDshReferenceBlockEntries(edited)[0]!.key).toBe(key);
    expect(collectManagedDshReferenceBlockEntries(managedReferenceSource("reference-2"))[0]!.key).not.toBe(key);
  });
});
