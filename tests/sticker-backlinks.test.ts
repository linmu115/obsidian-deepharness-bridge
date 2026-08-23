import { describe, expect, it } from "vitest";

import type { StickerBacklinkTarget } from "../src/protocol.ts";
import {
  listStickerBacklinks,
  type VaultMarkdownAdapter,
  type VaultMarkdownDocument,
} from "../src/vault/sticker-backlinks.ts";

class MemoryMarkdownVault implements VaultMarkdownAdapter {
  constructor(private readonly documents: readonly VaultMarkdownDocument[]) {}

  async listMarkdownFiles(): Promise<readonly VaultMarkdownDocument[]> {
    return this.documents;
  }
}

const target: StickerBacklinkTarget = {
  stickerId: "9bb3a80e-230d-44d1-a37c-f7b79d2bf315",
  sessionId: "session-demo",
  anchorId: "user-node-42",
  quoteHash: "sha256:30101ebf",
};

const officialLink = "obsidian://deepharness?session=session-demo&anchor=user-node-42&quoteHash=sha256%3A30101ebf&sticker=9bb3a80e-230d-44d1-a37c-f7b79d2bf315";
const legacyLink = "obsidian://deepharness?session=session-demo&anchor=user-node-42&quoteHash=sha256%3A30101ebf";

describe("sticker backlink index", () => {
  it("matches UUID links and legacy identity tuples with exact note locations", async () => {
    const vault = new MemoryMarkdownVault([
      {
        path: "项目/架构.md",
        content: [
          "# 插件架构",
          "",
          `> [回到贴纸](${officialLink})`,
          "> 解释这段设计。",
          "> ^sticker-reference",
        ].join("\n"),
      },
      {
        path: "日志/旧链接.md",
        content: ["# 旧记录", "", `[旧引用](${legacyLink})`].join("\n"),
      },
    ]);

    await expect(listStickerBacklinks(vault, target)).resolves.toEqual([
      {
        notePath: "日志/旧链接.md",
        line: 2,
        column: 6,
        heading: "旧记录",
        excerpt: `[旧引用](${legacyLink})`,
      },
      {
        notePath: "项目/架构.md",
        line: 2,
        column: 9,
        blockId: "sticker-reference",
        heading: "插件架构",
        excerpt: `[回到贴纸](${officialLink})`,
      },
    ]);
  });

  it("ignores another sticker UUID and deduplicates links at the same location", async () => {
    const otherSticker = officialLink.replace(target.stickerId, "048a8418-98e9-4c60-8b2b-d44535fd1299");
    const vault = new MemoryMarkdownVault([
      {
        path: "重复.md",
        content: `[当前](${officialLink}) [当前副本](${officialLink})\n^same-location`,
      },
      {
        path: "其他.md",
        content: `[不是当前贴纸](${otherSticker})`,
      },
    ]);

    const backlinks = await listStickerBacklinks(vault, target);
    expect(backlinks).toHaveLength(1);
    expect(backlinks[0]).toMatchObject({ notePath: "重复.md", line: 0, blockId: "same-location" });
  });
});
