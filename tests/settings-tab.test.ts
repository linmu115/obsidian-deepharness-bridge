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
