import { JSDOM } from "jsdom";
import { describe, expect, it, vi } from "vitest";

import {
  collectCompactDshBlockIds,
  compactRenderedDshBlockIds,
  shouldCompactDshBlockIds,
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

  it("renders a delete control that targets the exact generated marker", () => {
    const dom = new JSDOM('<div id="root">被引用的段落。 ^dsh-note-01234567</div>');
    const previous = globalThis.NodeFilter;
    Object.assign(globalThis, { NodeFilter: dom.window.NodeFilter });
    try {
      const root = dom.window.document.querySelector<HTMLElement>("#root");
      const onDelete = vi.fn();
      expect(root).not.toBeNull();
      expect(compactRenderedDshBlockIds(root as HTMLElement, onDelete)).toBe(1);
      const button = root?.querySelector<HTMLButtonElement>(".dsh-block-id-delete");
      expect(button?.getAttribute("aria-label")).toBe("删除 DSH 引用");
      button?.click();
      expect(onDelete).toHaveBeenCalledWith("^dsh-note-01234567");
    } finally {
      Object.assign(globalThis, { NodeFilter: previous });
    }
  });
});
