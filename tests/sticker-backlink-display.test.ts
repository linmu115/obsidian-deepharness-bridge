import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";

import {
  collectManagedStickerBacklinks,
  compactRenderedDshStickerBacklinks,
} from "../src/ui/sticker-backlink-display.ts";

const stickerId = "9bb3a80e-230d-44d1-a37c-f7b79d2bf315";
const href = "obsidian://deepharness?session=session-demo&anchor=user-node-42&quoteHash=sha256%3A30101ebf&sticker=9bb3a80e-230d-44d1-a37c-f7b79d2bf315";
const metadata = JSON.stringify({
  stickerId,
  sessionId: "session-demo",
  anchorId: "user-node-42",
  quoteHash: "sha256:30101ebf",
});

describe("compact sticker backlink display", () => {
  it("collects a complete managed backlink and preserves its logical target", () => {
    const markdown = [
      `<!-- dsh-sticker-backlink:${metadata} -->`,
      "[[DeepHarness/Sessions/session-demo#^dsh-sticker-9bb3a80e|贴纸来源]]",
      `[回到 DSH：会话标题](${href})`,
      "<!-- /dsh-sticker-backlink -->",
    ].join("\n");

    expect(collectManagedStickerBacklinks(markdown)).toEqual([{
      from: 0,
      to: markdown.length,
      href,
      target: JSON.parse(metadata),
    }]);
  });

  it("leaves malformed or unmanaged markdown unchanged", () => {
    expect(collectManagedStickerBacklinks([
      '<!-- dsh-sticker-backlink:{"stickerId":"not-a-uuid"} -->',
      `[回到 DSH](${href})`,
      "<!-- /dsh-sticker-backlink -->",
    ].join("\n"))).toEqual([]);
    expect(collectManagedStickerBacklinks(`[用户链接](${href})`)).toEqual([]);
  });

  it("replaces the generated source and long title with one clickable chip in reading mode", () => {
    const dom = new JSDOM([
      '<div id="root"><p>',
      '<a class="internal-link" data-href="DeepHarness/Sessions/session-demo#^dsh-sticker-9bb3a80e">贴纸来源</a>',
      `<a href="${href}">回到 DSH：一个非常长的会话标题</a>`,
      "</p></div>",
    ].join(""));
    const root = dom.window.document.querySelector<HTMLElement>("#root")!;

    const deleted: unknown[] = [];
    expect(compactRenderedDshStickerBacklinks(root, {
      onDelete: (target) => deleted.push(target),
    })).toBe(1);
    expect(root.querySelector("a.internal-link")).toBeNull();
    const chip = root.querySelector<HTMLElement>(".dsh-sticker-backlink-chip");
    expect(chip?.textContent).toBe("DSH 贴纸×");
    expect(chip?.querySelector<HTMLAnchorElement>(".dsh-sticker-backlink-open")?.href).toBe(href);
    const deleteButton = chip?.querySelector<HTMLButtonElement>(".dsh-sticker-backlink-delete");
    expect(deleteButton?.getAttribute("aria-label")).toBe("删除 DSH 贴纸引用");
    deleteButton?.click();
    expect(root.querySelector(".dsh-sticker-backlink-chip")).toBeNull();
    expect(deleted).toEqual([JSON.parse(metadata)]);
    expect(root.textContent).not.toContain("一个非常长的会话标题");
  });

  it("replaces a generated sticker reference callout without touching user callouts", () => {
    const dom = new JSDOM([
      '<div id="root">',
      `<div class="callout" data-callout="dsh-reference"><a href="${href}">回到 DSH：长标题</a><p>很长的引用正文</p></div>`,
      '<div class="callout" data-callout="note">用户内容</div>',
      "</div>",
    ].join(""));
    const root = dom.window.document.querySelector<HTMLElement>("#root")!;

    expect(compactRenderedDshStickerBacklinks(root)).toBe(1);
    expect(root.querySelector('[data-callout="dsh-reference"]')).toBeNull();
    expect(root.querySelector(".dsh-sticker-backlink-chip")?.textContent).toBe("DSH 贴纸");
    expect(root.querySelector('[data-callout="note"]')?.textContent).toBe("用户内容");
  });
});
