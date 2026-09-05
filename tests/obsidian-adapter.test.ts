import { describe, expect, it, vi } from "vitest";
import { syntheticApp, SyntheticFile } from "./helpers/obsidian-vault.ts";
import { ObsidianVaultAdapter } from "../src/vault/obsidian-adapter.ts";
import { contentRevision, saveSessionNote } from "../src/vault/session-notes.ts";

vi.mock("obsidian", async () => {
  const stub = await import("./helpers/obsidian-vault.ts");
  return { TFile: stub.SyntheticFile, TFolder: stub.SyntheticFolder, normalizePath: stub.obsidianPath, parseLinktext: stub.parseSyntheticLink };
});

describe("Obsidian atomic Vault adapter", () => {
  it("keeps physical source paths in the old default folder when companion settings change", async () => {
    const host = syntheticApp(); host.put("DeepHarness/source.md", "quote ^original-block\n");
    const adapter = new ObsidianVaultAdapter(host.app, "Other");
    expect(await adapter.findMarkdownPaths("block", "original-block")).toEqual(["DeepHarness/source.md"]);
    expect(await adapter.read("DeepHarness/source.md")).toContain("quote");
    expect(adapter.sessionNotePath("session")).toBe("Other/Sessions/session.md");
  });

  it("serializes first save across adapter instances and shares sibling folder creation", async () => {
    const host = syntheticApp();
    const first = new ObsidianVaultAdapter(host.app, "Companion");
    const second = new ObsidianVaultAdapter(host.app, "Companion");
    const document = { protocolVersion: 1, type: "session-note", sessionId: "shared", revision: contentRevision(""), stickers: [] } as const;
    const results = await Promise.allSettled([
      saveSessionNote(first, { ...document, stickers: [] }, document.revision),
      saveSessionNote(second, { ...document, stickers: [] }, document.revision),
      saveSessionNote(second, { ...document, sessionId: "sibling", stickers: [] }, document.revision),
    ]);
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected", "fulfilled"]);
    expect(results[1]).toMatchObject({ reason: { code: "REVISION_CONFLICT" } });
    expect(host.vault.createFolder.mock.calls.map(([path]) => path)).toEqual(["Companion", "Companion/Sessions"]);
    expect(host.vault.create).toHaveBeenCalledTimes(2);
  });

  it("rechecks CAS against an external first creator without overwriting their text", async () => {
    const host = syntheticApp(); const adapter = new ObsidianVaultAdapter(host.app, "Companion");
    host.vault.create.mockImplementationOnce(async (path) => {
      host.put(path, "external creator content\n"); throw new Error("already exists");
    });
    await expect(saveSessionNote(adapter, { protocolVersion: 1, type: "session-note", sessionId: "external", revision: contentRevision(""), stickers: [] }, contentRevision("")))
      .rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    expect(host.files.get("Companion/Sessions/external.md")).toBe("external creator content\n");
  });

  it("caches native backlink results and invalidates after source/metadata changes", async () => {
    const host = syntheticApp(); host.put("source.md", "[[target#^block]] original\n");
    host.metadataCache.resolvedLinks = { "source.md": { "target.md": 1 } };
    host.metadataCache.getFileCache.mockReturnValue({ links: [{ link: "target#^block", position: { start: { line: 0, col: 0 }, end: { line: 0, col: 18 } } }] });
    host.metadataCache.getFirstLinkpathDest.mockReturnValue({ path: "target.md" });
    const adapter = new ObsidianVaultAdapter(host.app, "Companion");
    expect((await adapter.listNativeBacklinks("target.md", "block"))[0]?.excerpt).toContain("original");
    await adapter.listNativeBacklinks("target.md", "block");
    expect(host.vault.cachedRead).toHaveBeenCalledTimes(1);
    host.put("source.md", "[[target#^block]] changed\n"); adapter.invalidate("source.md");
    expect((await adapter.listNativeBacklinks("target.md", "block"))[0]?.excerpt).toContain("changed");
    host.metadataCache.resolvedLinks = {}; adapter.invalidateMetadata();
    expect(await adapter.listNativeBacklinks("target.md", "block")).toEqual([]);
  });

  it("does not retain native results invalidated while a source read is in flight", async () => {
    const host = syntheticApp(); host.put("source.md", "old\n");
    host.metadataCache.resolvedLinks = { "source.md": { "target.md": 1 } };
    host.metadataCache.getFileCache.mockReturnValue({ links: [{ link: "target#^block", position: { start: { line: 0, col: 0 }, end: { line: 0, col: 5 } } }] });
    host.metadataCache.getFirstLinkpathDest.mockReturnValue({ path: "target.md" });
    const adapter = new ObsidianVaultAdapter(host.app, "Companion");
    host.vault.cachedRead.mockImplementationOnce(async (file: SyntheticFile) => {
      const before = host.files.get(file.path)!; host.put(file.path, "new\n"); adapter.invalidate(file.path); return before;
    });
    expect((await adapter.listNativeBacklinks("target.md", "block"))[0]?.excerpt).toBe("new");
  });
});
