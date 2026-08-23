import { describe, expect, it, vi } from "vitest";

import { collectNativeBacklinks } from "../src/vault/native-backlink-index.ts";

describe("Obsidian native backlink index", () => {
  it("uses resolved links and exact block references without scanning the Vault", async () => {
    const targetPath = "知识层/Sessions/session-demo.md";
    const sourcePath = "项目/架构.md";
    const source = { path: sourcePath, value: Symbol("source-file") };
    const readSource = vi.fn(async () => [
      "# 插件架构",
      "",
      "> [!note]",
      "> [[DeepHarness/Sessions/session-demo#^dsh-sticker-9bb3a80e|贴纸来源]]",
      "> ^sticker-reference",
    ].join("\n"));
    const resolveDestinationPath = vi.fn(() => targetPath);

    await expect(collectNativeBacklinks({
      resolvedLinks: {
        [sourcePath]: { [targetPath]: 1 },
        "无关.md": { "其他.md": 1 },
      },
      getSource: (path) => path === sourcePath ? source : null,
      getCache: () => ({
        links: [
          {
            link: "DeepHarness/Sessions/session-demo#^dsh-sticker-9bb3a80e",
            position: { start: { line: 3, col: 2 }, end: { line: 3, col: 74 } },
          },
          {
            link: "DeepHarness/Sessions/session-demo#^dsh-sticker-other",
            position: { start: { line: 8, col: 0 }, end: { line: 8, col: 60 } },
          },
        ],
        headings: [{
          heading: "插件架构",
          position: { start: { line: 0, col: 0 }, end: { line: 0, col: 6 } },
        }],
        blocks: {
          "sticker-reference": {
            id: "sticker-reference",
            position: { start: { line: 2, col: 0 }, end: { line: 4, col: 22 } },
          },
        },
      }),
      parseLinktext: (value) => {
        const hash = value.indexOf("#");
        return { path: value.slice(0, hash), subpath: value.slice(hash) };
      },
      resolveDestinationPath,
      readSource,
    }, targetPath, "dsh-sticker-9bb3a80e")).resolves.toEqual([{
      notePath: sourcePath,
      line: 3,
      column: 2,
      blockId: "sticker-reference",
      heading: "插件架构",
      excerpt: "[[DeepHarness/Sessions/session-demo#^dsh-sticker-9bb3a80e|贴纸来源]]",
    }]);
    expect(resolveDestinationPath).toHaveBeenCalledWith(
      "DeepHarness/Sessions/session-demo",
      sourcePath,
    );
    expect(readSource).toHaveBeenCalledTimes(1);
  });
});
