import { describe, expect, it } from "vitest";
import { MarkdownLookupIndex } from "../src/vault/markdown-lookup-index.ts";

describe("rebuildable Markdown lookup", () => {
  it("falls back rather than starving a lookup while files keep changing", async () => {
    let index: MarkdownLookupIndex;
    index = new MarkdownLookupIndex(async () => ["changing.md"], async () => { index.invalidate("changing.md"); return "text"; });
    expect(await index.find("block", "target")).toEqual(["changing.md"]);
    expect(index.diagnostics.filesRead).toBe(2);
  });

  it("reads each unchanged note once, updates changed files, and follows rename/delete", async () => {
    const files = new Map(Array.from({ length: 500 }, (_, i) => [`${i}.md`, `unrelated ${i}`]));
    files.set("target.md", '<!-- dsh-reference:{"referenceId":"ref-1"} -->\n^block-1\n');
    const index = new MarkdownLookupIndex(async () => [...files.keys()], async (path) => files.get(path) ?? null);
    expect(await index.find("reference", "ref-1")).toEqual(["target.md"]);
    const initial = index.diagnostics.filesRead;
    expect(initial).toBe(501);
    expect(await index.find("block", "block-1")).toEqual(["target.md"]);
    expect(index.diagnostics.filesRead).toBe(initial);
    files.set("moved.md", files.get("target.md")!);
    files.delete("target.md");
    index.invalidate("target.md"); index.invalidate("moved.md");
    expect(await index.find("reference", "ref-1")).toEqual(["moved.md"]);
    expect(index.diagnostics.filesRead).toBe(initial + 1);
    files.set("moved.md", "no marker"); index.invalidate("moved.md");
    expect(await index.find("reference", "ref-1")).toEqual([]);
    files.delete("moved.md"); index.invalidate("moved.md");
    expect(await index.find("block", "block-1")).toEqual([]);
  });

  it("retains duplicate candidates and legacy sticker links", async () => {
    const index = new MarkdownLookupIndex(async () => ["a.md", "b.md"], async () =>
      '[回到 DSH：test](obsidian://deepharness?sticker=sticker%201)\n^same-block\n');
    expect(await index.find("sticker", "sticker 1")).toEqual(["a.md", "b.md"]);
    expect(await index.find("block", "same-block")).toEqual(["a.md", "b.md"]);
  });

  it("falls back to a full candidate scan when rebuilding fails", async () => {
    let failed = true;
    const index = new MarkdownLookupIndex(async () => ["a.md", "b.md"], async () => {
      if (failed) throw new Error("temporary read failure");
      return "^target\n";
    });
    expect(await index.find("block", "target")).toEqual(["a.md", "b.md"]);
    failed = false;
    expect(await index.find("block", "target")).toEqual(["a.md", "b.md"]);
    expect(index.diagnostics.indexedFiles).toBe(2);
  });

  it("does not mark a stale in-flight read as clean after a modify event", async () => {
    let current = "old text";
    let index: MarkdownLookupIndex;
    let reads = 0;
    index = new MarkdownLookupIndex(async () => ["a.md"], async () => {
      reads += 1;
      const snapshot = current;
      if (reads === 1) { current = "^new-block\n"; index.invalidate("a.md"); }
      return snapshot;
    });
    expect(await index.find("block", "new-block")).toEqual(["a.md"]);
    expect(reads).toBe(2);
  });
});
