import type { BacklinkReceiptV2 } from "../protocol.ts";
import type { PendingReferenceRecord } from "../migrations/v1-pending.ts";

export interface PendingMarkerVault {
  read(path: string): Promise<string | null>;
  listMarkdownPaths(): Promise<string[]>;
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

function markerCount(content: string, blockId: string): number {
  return [...content.matchAll(markerPattern(blockId))].length;
}

async function locateMarkerPath(
  vault: PendingMarkerVault,
  recordedPath: string,
  blockId: string,
): Promise<string | null> {
  const recordedContent = await vault.read(recordedPath);
  if (recordedContent !== null && markerCount(recordedContent, blockId) > 0) return recordedPath;

  let locatedPath: string | null = null;
  let locatedCount = 0;
  for (const path of await vault.listMarkdownPaths()) {
    if (path === recordedPath) continue;
    const content = await vault.read(path);
    if (content === null) continue;
    const count = markerCount(content, blockId);
    if (count === 0) continue;
    locatedPath ??= path;
    locatedCount += count;
    if (locatedCount > 1) throw new Error(`Managed block marker is ambiguous: ${blockId}`);
  }
  return locatedPath;
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
    return capture?.source.locator.blockId === blockId;
  });
  const sharedBacklink = backlinkReceipts.some((receipt) => receipt.blockId === blockId);
  if (sharedPending || sharedBacklink) return { markerRemoved: false, reason: "still-referenced" };

  const markerPath = await locateMarkerPath(vault, notePath, blockId);
  if (markerPath === null) return { markerRemoved: false, reason: "already-absent" };

  let removed = false;
  await vault.process(markerPath, (content) => {
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
