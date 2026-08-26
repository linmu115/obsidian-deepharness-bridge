import type { BacklinkReceiptV2 } from "../protocol.ts";
import type { PendingReferenceRecord } from "../migrations/v1-pending.ts";

export interface PendingMarkerVault {
  read(path: string): Promise<string | null>;
  process(path: string, update: (content: string) => string): Promise<string>;
}

export interface PendingMarkerCleanupResult {
  markerRemoved: boolean;
  reason: "removed" | "already-absent" | "not-owned" | "still-referenced";
}

type CapturedRecord = Exclude<PendingReferenceRecord, { state: "needs-reselect" }>;

function captureOf(record: PendingReferenceRecord) {
  return record.state === "needs-reselect" ? undefined : record.capture;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function markerPattern(blockId: string): RegExp {
  return new RegExp(`[ \\t]+\\^${escapeRegExp(blockId)}(?=[ \\t]*(?:\\r?\\n|$))`, "g");
}

export async function cleanupOwnedPendingMarker(
  vault: PendingMarkerVault,
  target: CapturedRecord,
  pendingReferences: readonly PendingReferenceRecord[],
  backlinkReceipts: readonly BacklinkReceiptV2[],
): Promise<PendingMarkerCleanupResult> {
  if (target.blockIdOwnership !== "plugin-created") {
    return { markerRemoved: false, reason: "not-owned" };
  }
  const { notePath, blockId } = target.capture.source.locator;
  const sharedPending = pendingReferences.some((record) => {
    if (record === target) return false;
    const capture = captureOf(record);
    return capture?.source.locator.notePath === notePath && capture.source.locator.blockId === blockId;
  });
  const sharedBacklink = backlinkReceipts.some((receipt) => receipt.notePath === notePath && receipt.blockId === blockId);
  if (sharedPending || sharedBacklink) return { markerRemoved: false, reason: "still-referenced" };

  const current = await vault.read(notePath);
  if (current === null || !markerPattern(blockId).test(current)) {
    return { markerRemoved: false, reason: "already-absent" };
  }

  let removed = false;
  await vault.process(notePath, (content) => {
    const pattern = markerPattern(blockId);
    const matches = [...content.matchAll(pattern)];
    if (matches.length === 0) return content;
    if (matches.length > 1) throw new Error(`Managed block marker is ambiguous: ${blockId}`);
    removed = true;
    return content.replace(pattern, "");
  });
  return removed
    ? { markerRemoved: true, reason: "removed" }
    : { markerRemoved: false, reason: "already-absent" };
}
