export function removeSingleOrphanReferenceClosingMarker(source: string): string;

export function repairOrphanReferenceClosingMarker(
  notePath: string,
  backupRoot: string,
): Promise<{ notePath: string; backupPath: string; removedMarkers: number }>;
