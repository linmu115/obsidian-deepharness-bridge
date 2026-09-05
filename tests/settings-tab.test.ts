import { describe, expect, it, vi } from "vitest";

import type { PendingReferenceRecord } from "../src/migrations/v1-pending.ts";
import { buildPendingReferenceRows } from "../src/ui/pending-reference-list.ts";
import { createObsidianReferenceCapture } from "../src/vault/reference-source.ts";

function migrated(referenceId = "reference-1"): PendingReferenceRecord {
  const capture = createObsidianReferenceCapture({
    actionId: "action-1",
    referenceId,
    vaultId: "vault-1",
    notePath: "Notes/source.md",
    blockId: "block-1",
    occurrence: 0,
    selectedText: "引用内容",
    markdown: "引用内容 ^block-1\n",
    capturedAt: 100,
  });
  return {
    state: "migrated-ready",
    blockIdOwnership: "pre-existing",
    capture,
    legacy: {
      citationId: referenceId,
      notePath: "Notes/source.md",
      blockId: "block-1",
      text: "引用内容",
      contentHash: "sha256:legacy",
    },
  };
}

describe("pending reference settings rows", () => {
  it("shows current queued and claimed work and hides synced history", () => {
    const ready = migrated() as Extract<PendingReferenceRecord, { state: "migrated-ready" }>;
    const records: PendingReferenceRecord[] = [
      { state: "queued", capture: ready.capture, blockIdOwnership: "pre-existing" },
      { state: "claimed", capture: { ...ready.capture, referenceId: "claimed" }, blockIdOwnership: "pre-existing", claim: { annotationProtocolVersion: 2, type: "reference-claim", referenceId: "claimed", profileId: "web", sessionId: "session", setId: "set" } },
      { state: "claimed", capture: { ...ready.capture, referenceId: "synced" }, blockIdOwnership: "pre-existing", claim: { annotationProtocolVersion: 2, type: "reference-claim", referenceId: "synced", profileId: "web", sessionId: "session", setId: "set" } },
    ];
    const rows = buildPendingReferenceRows({
      pendingReferences: records, releaseMigratedReference: vi.fn(), discardReference: vi.fn(), openReferenceNote: vi.fn(),
      referenceStatus: (id) => id === "synced" ? "synced" : "pending",
    });
    expect(rows).toHaveLength(2);
    expect(rows[0]?.description).toContain("等待 DSH 接收");
    expect(rows[1]).toMatchObject({ canOpen: true, canDiscard: true });
    expect(rows[1]?.description).toContain("等待随提问写回");
  });

  it("keeps deletion recovery visible without exposing destructive discard", () => {
    const [row] = buildPendingReferenceRows({
      pendingReferences: [migrated()], releaseMigratedReference: vi.fn(), discardReference: vi.fn(), openReferenceNote: vi.fn(),
      referenceStatus: () => "deleting",
    });
    expect(row).toMatchObject({ canDiscard: false }); expect(row?.description).toContain("等待 DSH 确认");
  });

  it("releases one migrated reference by its stable ID", async () => {
    const releaseMigratedReference = vi.fn(async () => undefined);
    const owner = {
      pendingReferences: [migrated()],
      releaseMigratedReference,
      discardReference: vi.fn(async () => undefined),
      openReferenceNote: vi.fn(async () => undefined),
    };
    const [row] = buildPendingReferenceRows(owner);
    expect(row).toMatchObject({ referenceId: "reference-1", canOpen: true, canRelease: true });
    await row?.release();
    expect(releaseMigratedReference).toHaveBeenCalledOnce();
    expect(releaseMigratedReference).toHaveBeenCalledWith("reference-1");
  });

  it("exposes quarantine reason, note opening and discard without a send action", async () => {
    const quarantined: PendingReferenceRecord = {
      state: "needs-reselect",
      referenceId: "reference-bad",
      legacy: {
        citationId: "reference-bad",
        notePath: "Notes/problem.md",
        blockId: "missing-block",
        text: "旧内容",
        contentHash: "sha256:legacy",
      },
      reason: "block-missing",
    };
    const openReferenceNote = vi.fn(async () => undefined);
    const discardReference = vi.fn(async () => undefined);
    const [row] = buildPendingReferenceRows({
      pendingReferences: [quarantined],
      releaseMigratedReference: vi.fn(async () => undefined),
      discardReference,
      openReferenceNote,
    });
    expect(row).toMatchObject({
      referenceId: "reference-bad",
      title: "Notes/problem.md",
      canOpen: true,
      canRelease: false,
    });
    expect(row?.description).toContain("定位标识不存在");
    await row?.open();
    await row?.discard();
    expect(openReferenceNote).toHaveBeenCalledWith(quarantined);
    expect(discardReference).toHaveBeenCalledWith("reference-bad");
  });

  it("keeps malformed quarantine records discardable without an open-note action", () => {
    const [row] = buildPendingReferenceRows({
      pendingReferences: [{
        state: "needs-reselect",
        referenceId: "legacy-invalid-1",
        legacy: { raw: { broken: true } },
        reason: "invalid-record",
      }],
      releaseMigratedReference: vi.fn(async () => undefined),
      discardReference: vi.fn(async () => undefined),
      openReferenceNote: vi.fn(async () => undefined),
    });
    expect(row).toMatchObject({ canOpen: false, canRelease: false });
  });
});
