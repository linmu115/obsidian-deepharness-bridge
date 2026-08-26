import { describe, expect, it } from "vitest";

import type { PendingReferenceRecord } from "../src/migrations/v1-pending.ts";
import { cleanupOwnedPendingMarker } from "../src/vault/pending-reference-cleanup.ts";
import { createObsidianReferenceCapture } from "../src/vault/reference-source.ts";

class MemoryVault {
  readonly files = new Map<string, string>();
  writes = 0;

  async read(path: string): Promise<string | null> { return this.files.get(path) ?? null; }

  async listMarkdownPaths(): Promise<string[]> { return [...this.files.keys()].filter((path) => path.endsWith(".md")); }

  async process(path: string, update: (content: string) => string): Promise<string> {
    const current = this.files.get(path);
    if (current === undefined) throw new Error(`missing: ${path}`);
    const next = update(current);
    if (next !== current) {
      this.files.set(path, next);
      this.writes += 1;
    }
    return next;
  }
}

const notePath = "笔记.md";
const blockId = "dsh-note-owned";
const markdown = `# 笔记\n\n引用内容 ^${blockId}\n`;

function record(
  referenceId: string,
  blockIdOwnership: "plugin-created" | "pre-existing" = "plugin-created",
): Extract<PendingReferenceRecord, { state: "claimed" }> {
  const capture = createObsidianReferenceCapture({
    actionId: `action-${referenceId}`,
    referenceId,
    vaultId: "vault-1",
    notePath,
    blockId,
    occurrence: 0,
    selectedText: "引用内容",
    markdown,
    capturedAt: 1,
  });
  return {
    state: "claimed",
    capture,
    blockIdOwnership,
    claim: {
      annotationProtocolVersion: 2,
      type: "reference-claim",
      referenceId,
      profileId: "web",
      sessionId: "session-1",
      setId: "set-1",
    },
  };
}

describe("pending reference marker cleanup", () => {
  it("removes only the plugin-created block marker and keeps the note text", async () => {
    const vault = new MemoryVault();
    vault.files.set(notePath, markdown);
    const target = record("reference-1");

    const result = await cleanupOwnedPendingMarker(vault, target, [target], []);

    expect(result).toEqual({ markerRemoved: true, reason: "removed" });
    expect(vault.files.get(notePath)).toBe("# 笔记\n\n引用内容\n");
    expect(vault.writes).toBe(1);
  });

  it("is idempotent when the note or marker has already disappeared", async () => {
    const target = record("reference-1");
    const missingNote = new MemoryVault();
    await expect(cleanupOwnedPendingMarker(missingNote, target, [target], []))
      .resolves.toEqual({ markerRemoved: false, reason: "already-absent" });

    const missingMarker = new MemoryVault();
    missingMarker.files.set(notePath, "# 笔记\n\n引用内容\n");
    await expect(cleanupOwnedPendingMarker(missingMarker, target, [target], []))
      .resolves.toEqual({ markerRemoved: false, reason: "already-absent" });
  });

  it("finds one plugin-owned marker after the source note was moved", async () => {
    const vault = new MemoryVault();
    vault.files.set("已移动/笔记.md", markdown);
    const target = record("reference-1");

    await expect(cleanupOwnedPendingMarker(vault, target, [target], []))
      .resolves.toEqual({ markerRemoved: true, reason: "removed" });
    expect(vault.files.get("已移动/笔记.md")).toBe("# 笔记\n\n引用内容\n");
  });

  it("refuses to guess when a stale source path matches multiple notes", async () => {
    const vault = new MemoryVault();
    vault.files.set("移动一/笔记.md", markdown);
    vault.files.set("移动二/笔记.md", markdown);
    const target = record("reference-1");

    await expect(cleanupOwnedPendingMarker(vault, target, [target], []))
      .rejects.toThrow(`Managed block marker is ambiguous: ${blockId}`);
    expect(vault.writes).toBe(0);
  });

  it("never removes a pre-existing or still-shared block marker", async () => {
    const preExistingVault = new MemoryVault();
    preExistingVault.files.set(notePath, markdown);
    const preExisting = record("reference-pre-existing", "pre-existing");
    await expect(cleanupOwnedPendingMarker(preExistingVault, preExisting, [preExisting], []))
      .resolves.toEqual({ markerRemoved: false, reason: "not-owned" });
    expect(preExistingVault.files.get(notePath)).toBe(markdown);

    const sharedVault = new MemoryVault();
    sharedVault.files.set(notePath, markdown);
    const first = record("reference-1");
    const second = record("reference-2");
    await expect(cleanupOwnedPendingMarker(sharedVault, first, [first, second], []))
      .resolves.toEqual({ markerRemoved: false, reason: "still-referenced" });
    expect(sharedVault.files.get(notePath)).toBe(markdown);

    await expect(cleanupOwnedPendingMarker(sharedVault, first, [first], [{
      referenceId: "sent-reference",
      commitDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      notePath,
      blockId,
      revision: "1",
      writtenAt: 1,
    }])).resolves.toEqual({ markerRemoved: false, reason: "still-referenced" });
  });
});
