import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";

import {
  collectManagedStickerBacklinks,
  compactRenderedDshStickerBacklinks,
  hrefForTarget,
} from "../src/ui/sticker-backlink-display.ts";
import { parseDshLogicalLink } from "../src/logical-link.ts";
import type { StickerBacklinkTarget } from "../src/protocol.ts";

const stickerId = "9bb3a80e-230d-44d1-a37c-f7b79d2bf315";
const href = "obsidian://deepharness?session=session-demo&anchor=user-node-42&quoteHash=sha256%3A30101ebf&sticker=9bb3a80e-230d-44d1-a37c-f7b79d2bf315";
const metadata = JSON.stringify({
  stickerId,
  sessionId: "session-demo",
  anchorId: "user-node-42",
  quoteHash: "sha256:30101ebf",
});

/** Metadata written while an instance was already bound, as the sticker board emits it. */
const boundInstanceId = "i-27c4d5a7-bdb5-4b8a-8d95-6267f47499c5";
const boundMetadata = JSON.stringify({
  stickerId,
  dshInstanceId: boundInstanceId,
  logicalSessionId: "ls_796db5528095e5663ccea57f",
  logicalAnchorId: "87ad1682-cf2a-4459-b98c-2fd9c974774d",
  legacySessionId: "session-demo",
  legacyAnchorId: "user-node-42",
  sessionId: "session-demo",
  anchorId: "user-node-42",
  quoteHash: "sha256:30101ebf",
});

describe("managed sticker backlink hrefs", () => {
  it("keeps dshInstanceId and every logical ID in the Live Preview href", () => {
    const markdown = [
      `<!-- dsh-sticker-backlink:${boundMetadata} -->`,
      "[[DeepHarness/Sessions/session-demo#^dsh-sticker-9bb3a80e|贴纸来源]]",
      `[回到 DSH：会话标题](${hrefForTarget(JSON.parse(boundMetadata) as StickerBacklinkTarget)})`,
      "<!-- /dsh-sticker-backlink -->",
    ].join("\n");

    const matches = collectManagedStickerBacklinks(markdown);
    expect(matches).toHaveLength(1);
    const params = new URL(matches[0]!.href).searchParams;
    expect(params.get("dshInstanceId")).toBe(boundInstanceId);
    expect(params.get("logicalSessionId")).toBe("ls_796db5528095e5663ccea57f");
    expect(params.get("logicalAnchorId")).toBe("87ad1682-cf2a-4459-b98c-2fd9c974774d");
    expect(params.get("legacySessionId")).toBe("session-demo");
    expect(params.get("legacyAnchorId")).toBe("user-node-42");
    expect(params.get("session")).toBe("session-demo");
    expect(params.get("anchor")).toBe("user-node-42");
    expect(params.get("quoteHash")).toBe("sha256:30101ebf");
    expect(params.get("sticker")).toBe(stickerId);
  });

  it("round-trips the Live Preview href into a deep-link action that still names its instance", () => {
    const action = parseDshLogicalLink(
      hrefForTarget(JSON.parse(boundMetadata) as StickerBacklinkTarget),
      () => crypto.randomUUID(),
    );
    expect(action.dshInstanceId).toBe(boundInstanceId);
    expect(action.sessionId).toBe("session-demo");
    expect(action.anchorId).toBe("user-node-42");
    expect(action.stickerId).toBe(stickerId);
  });

  it("omits absent logical fields so pre-binding links keep their original href", () => {
    // Backward compatibility: a legacy link must not gain a fabricated dshInstanceId.
    expect(hrefForTarget(JSON.parse(metadata) as StickerBacklinkTarget)).toBe(href);
    expect(new URL(collectManagedStickerBacklinks([
      `<!-- dsh-sticker-backlink:${metadata} -->`,
      `[回到 DSH：会话标题](${href})`,
      "<!-- /dsh-sticker-backlink -->",
    ].join("\n"))[0]!.href).searchParams.has("dshInstanceId")).toBe(false);
  });
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
