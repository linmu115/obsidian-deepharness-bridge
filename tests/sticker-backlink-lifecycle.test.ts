import { describe, expect, it } from "vitest";

import {
  deleteStickerBacklinkFromNote,
  deleteStickerBacklinks,
  removeStickerBacklinksFromMarkdown,
  type StickerBacklinkVault,
} from "../src/vault/sticker-backlink-lifecycle.ts";

const target = {
  stickerId: "9bb3a80e-230d-44d1-a37c-f7b79d2bf315",
  sessionId: "session-demo",
  anchorId: "assistant-9:1",
  quoteHash: "sha256:quote",
};

describe("sticker backlink lifecycle", () => {
  it.each([false, true])("preserves edits between candidate read and atomic unlink (global=%s)", async (global) => {
    const original = `before\n<!-- dsh-sticker-backlink:${JSON.stringify(target)} -->\nlink\n<!-- /dsh-sticker-backlink -->\nafter\n`;
    let current = original;
    const vault: StickerBacklinkVault = {
      listMarkdownPaths: async () => ["synthetic.md"],
      read: async () => {
        const snapshot = current;
        current += "USER EDIT DURING DELETE\n";
        return snapshot;
      },
      process: async (_path, update) => { current = update(current); return current; },
    };
    const result = global ? await deleteStickerBacklinks(vault, target) : await deleteStickerBacklinkFromNote(vault, "synthetic.md", target);
    expect(result).toEqual({ notesChanged: 1, linksRemoved: 1 });
    expect(current).toBe("before\nafter\nUSER EDIT DURING DELETE\n");
  });

  it("removes the same logical sticker relation after the DSH native session ID changes", () => {
    const metadata = JSON.stringify({
      ...target,
      logicalSessionId: "logical-session-1",
      logicalAnchorId: "logical-anchor-1",
    });
    const source = `<!-- dsh-sticker-backlink:${metadata} -->\nlink\n<!-- /dsh-sticker-backlink -->\n`;
    expect(removeStickerBacklinksFromMarkdown(source, {
      ...target,
      sessionId: "session-alpha2",
      logicalSessionId: "logical-session-1",
      logicalAnchorId: "logical-anchor-1",
      legacySessionId: "session-demo",
      legacyAnchorId: target.anchorId,
    })).toEqual({ source: "", linksRemoved: 1 });
  });

  it("removes managed pasted blocks without touching surrounding note content", () => {
    const metadata = JSON.stringify(target);
    const source = [
      "before",
      `<!-- dsh-sticker-backlink:${metadata} -->`,
      "[[DeepHarness/Sessions/session-demo#^dsh-sticker-9bb3a80e|贴纸来源]]",
      "[回到 DSH：会话](obsidian://deepharness?session=session-demo&anchor=assistant-9%3A1&quoteHash=sha256%3Aquote&sticker=9bb3a80e-230d-44d1-a37c-f7b79d2bf315)",
      "<!-- /dsh-sticker-backlink -->",
      "after",
      "",
    ].join("\n");

    expect(removeStickerBacklinksFromMarkdown(source, target)).toEqual({
      source: "before\nafter\n",
      linksRemoved: 1,
    });
  });

  it("cleans legacy two-line links and generated callouts", () => {
    const logical = "obsidian://deepharness?session=session-demo&anchor=assistant-9%3A1&quoteHash=sha256%3Aquote&sticker=9bb3a80e-230d-44d1-a37c-f7b79d2bf315";
    const source = [
      "keep",
      "[[DeepHarness/Sessions/session-demo#^dsh-sticker-9bb3a80e|贴纸来源]]",
      `[回到 DSH：会话](${logical})`,
      "> [!dsh-reference]",
      "> 来源：[[DeepHarness/Sessions/session-demo#^dsh-sticker-9bb3a80e|贴纸来源]]",
      `> [回到 DSH：会话](${logical})`,
      "> 引用内容：正文",
      "remain",
      "",
    ].join("\n");

    expect(removeStickerBacklinksFromMarkdown(source, target)).toEqual({
      source: "keep\nremain\n",
      linksRemoved: 2,
    });
  });

  it("updates every matching Markdown note idempotently", async () => {
    const metadata = JSON.stringify(target);
    const files = new Map([
      ["a.md", `<!-- dsh-sticker-backlink:${metadata} -->\nlink\n<!-- /dsh-sticker-backlink -->\n`],
      ["b.md", "unrelated\n"],
    ]);
    const vault: StickerBacklinkVault = {
      listMarkdownPaths: async () => [...files.keys()],
      read: async (path) => files.get(path) ?? null,
      process: async (path, update) => { const content = update(files.get(path)!); files.set(path, content); return content; },
    };

    await expect(deleteStickerBacklinks(vault, target)).resolves.toEqual({ notesChanged: 1, linksRemoved: 1 });
    await expect(deleteStickerBacklinks(vault, target)).resolves.toEqual({ notesChanged: 0, linksRemoved: 0 });
    expect(files.get("a.md")).toBe("");
  });

  it("unlinks only the selected note while preserving other notes that reference the sticker", async () => {
    const metadata = JSON.stringify(target);
    const block = `<!-- dsh-sticker-backlink:${metadata} -->\nlink\n<!-- /dsh-sticker-backlink -->\n`;
    const files = new Map([
      ["selected.md", block],
      ["other.md", block],
    ]);
    const vault: StickerBacklinkVault = {
      listMarkdownPaths: async () => [...files.keys()],
      read: async (path) => files.get(path) ?? null,
      process: async (path, update) => { const content = update(files.get(path)!); files.set(path, content); return content; },
    };

    await expect(deleteStickerBacklinkFromNote(vault, "selected.md", target))
      .resolves.toEqual({ notesChanged: 1, linksRemoved: 1 });
    expect(files.get("selected.md")).toBe("");
    expect(files.get("other.md")).toBe(block);
    await expect(deleteStickerBacklinkFromNote(vault, "selected.md", target))
      .resolves.toEqual({ notesChanged: 0, linksRemoved: 0 });
  });
});
