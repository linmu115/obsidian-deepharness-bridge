import type { BacklinkReceiptV2 } from "../protocol.ts";
import type { PendingReferenceRecord, OwnedMarker } from "../migrations/v1-pending.ts";

export interface PendingMarkerVault {
  read(path: string): Promise<string | null>;
  listMarkdownPaths(): Promise<string[]>;
  process(path: string, update: (content: string) => string): Promise<string>;
  findMarkdownPaths?(kind: "reference" | "sticker" | "block", id: string): Promise<readonly string[]>;
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
  return new RegExp(`(?:^[ \\t]*|[ \\t]+)\\^${escapeRegExp(blockId)}(?=[ \\t]*(?:\\r?\\n|$))`, "gm");
}

function markerCount(content: string, blockId: string): number {
  return [...content.matchAll(markerPattern(blockId))].length;
}

async function locateMarkerPath(
  vault: PendingMarkerVault,
  recordedPath: string,
  blockId: string,
  allowMovedNote: boolean,
): Promise<string | null> {
  const recordedContent = await vault.read(recordedPath);
  // An existing source without its marker has already been cleaned. A same-ID
  // marker in another note is not evidence that ownership moved there.
  if (recordedContent !== null) return markerCount(recordedContent, blockId) > 0 ? recordedPath : null;
  if (!allowMovedNote) return null;

  let locatedPath: string | null = null;
  let locatedCount = 0;
  for (const path of await (vault.findMarkdownPaths?.("block", blockId) ?? vault.listMarkdownPaths())) {
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
  options: { allowMovedNote?: boolean; isExternallyReferenced?(blockId: string): boolean } = {},
): Promise<PendingMarkerCleanupResult> {
  if (target.blockIdOwnership !== "plugin-created") {
    return { markerRemoved: false, reason: "not-owned" };
  }
  const { notePath, blockId } = target.capture.source.locator;
  return cleanupOwnedMarker(vault, { notePath, blockId }, pendingReferences.filter(record => record !== target), backlinkReceipts, options);
}

/** The caller must have durable proof that this marker was created by the plugin. */
export async function cleanupOwnedMarker(
  vault: PendingMarkerVault,
  { notePath, blockId }: OwnedMarker,
  pendingReferences: readonly PendingReferenceRecord[],
  backlinkReceipts: readonly BacklinkReceiptV2[],
  options: { allowMovedNote?: boolean; isExternallyReferenced?(blockId: string): boolean } = {},
): Promise<PendingMarkerCleanupResult> {
  const sharedPending = pendingReferences.some((record) => {
    const capture = captureOf(record);
    return capture?.source.locator.blockId === blockId && (options.allowMovedNote !== false || capture.source.locator.notePath === notePath);
  });
  const sharedBacklink = backlinkReceipts.some((receipt) => receipt.blockId === blockId && (options.allowMovedNote !== false || receipt.notePath === notePath));
  if (sharedPending || sharedBacklink || options.isExternallyReferenced?.(blockId)) return { markerRemoved: false, reason: "still-referenced" };

  const markerPath = await locateMarkerPath(vault, notePath, blockId, options.allowMovedNote !== false);
  if (markerPath === null) return { markerRemoved: false, reason: "already-absent" };

  let removed = false;
  let protectedDuringWrite = false;
  await vault.process(markerPath, (content) => {
    if (options.isExternallyReferenced?.(blockId)) { protectedDuringWrite = true; return content; }
    const pattern = markerPattern(blockId);
    const matches = [...content.matchAll(pattern)];
    if (matches.length === 0) return content;
    if (matches.length > 1) throw new Error(`Managed block marker is ambiguous: ${blockId}`);
    removed = true;
    return content.replace(pattern, "");
  });
  return removed
    ? { markerRemoved: true, reason: "removed" }
    : { markerRemoved: false, reason: protectedDuringWrite ? "still-referenced" : "already-absent" };
}
