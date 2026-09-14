import type { PendingReferenceRecord, StoredPluginDataV2 } from '../migrations/v1-pending.ts';

/** Transfer ownership before dropping a reference; callers persist this with their state change. */
export function rememberOwnedMarkers(data: StoredPluginDataV2, records: readonly PendingReferenceRecord[] = data.pendingReferences): StoredPluginDataV2 {
  const key = (marker: { notePath: string; blockId: string }) => JSON.stringify([marker.notePath, marker.blockId]);
  const markers = new Map((data.ownedMarkers ?? []).map(marker => [key(marker), marker]));
  for (const record of records) {
    if (record.state === 'needs-reselect' || record.blockIdOwnership !== 'plugin-created') continue;
    const { notePath, blockId } = record.capture.source.locator;
    if (!markers.has(key({ notePath, blockId }))) markers.set(key({ notePath, blockId }), { notePath, blockId });
  }
  return { ...data, ownedMarkers: [...markers.values()] };
}
