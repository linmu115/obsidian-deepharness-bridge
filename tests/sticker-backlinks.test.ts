import { describe, expect, it, vi } from "vitest";

import type { StickerBacklinkTarget } from "../src/protocol.ts";
import {
  listStickerBacklinks,
  type VaultBacklinkAdapter,
} from "../src/vault/sticker-backlinks.ts";

const target: StickerBacklinkTarget = {
  stickerId: "9bb3a80e-230d-44d1-a37c-f7b79d2bf315",
  sessionId: "session-demo",
  anchorId: "user-node-42",
  quoteHash: "sha256:30101ebf",
};

describe("native Obsidian sticker backlinks", () => {
  it("queries the companion Markdown block through the native backlink index", async () => {
    const listNativeBacklinks = vi.fn(async () => [{
      notePath: "项目/架构.md",
      line: 12,
      column: 4,
      heading: "插件架构",
      excerpt: "[[贴纸来源]]",
    }]);
    const vault: VaultBacklinkAdapter = { listNativeBacklinks };

    await expect(listStickerBacklinks(vault, target)).resolves.toEqual([{
      notePath: "项目/架构.md",
      line: 12,
      column: 4,
      heading: "插件架构",
      excerpt: "[[贴纸来源]]",
    }]);
    expect(listNativeBacklinks).toHaveBeenCalledWith(
      "DeepHarness/Sessions/session-demo.md",
      "dsh-sticker-9bb3a80e",
    );
  });

  it("validates, deduplicates and sorts native backlink locations", async () => {
    const duplicate = { notePath: "项目/架构.md", line: 12, column: 4, excerpt: "引用贴纸" };
    const vault: VaultBacklinkAdapter = {
      listNativeBacklinks: async () => [
        duplicate,
        { notePath: "日志/记录.md", line: 2, excerpt: "更早的引用" },
        duplicate,
      ],
    };

    await expect(listStickerBacklinks(vault, target)).resolves.toEqual([
      { notePath: "日志/记录.md", line: 2, excerpt: "更早的引用" },
      duplicate,
    ]);
  });
});
