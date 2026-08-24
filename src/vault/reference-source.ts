import {
  ANNOTATION_PROTOCOL_VERSION,
  ObsidianReferenceCaptureV2Schema,
  documentHash,
  normalizeSourceText,
  selectedTextHash,
  type ObsidianReferenceCaptureV2,
  type ReferenceRefreshResultV2,
} from "../protocol.ts";

export interface ReferenceVaultReader {
  read(path: string): Promise<string | null>;
}

export interface CreateReferenceCaptureInput {
  actionId: string;
  referenceId: string;
  vaultId: string;
  notePath: string;
  heading?: string;
  blockId: string;
  occurrence: number;
  selectedText: string;
  markdown: string;
  capturedAt: number;
}

export function selectionOffsets(markdown: string, selectedText: string): number[] {
  const source = normalizeSourceText(markdown);
  const selected = normalizeSourceText(selectedText);
  if (!selected) return [];
  const offsets: number[] = [];
  let cursor = 0;
  while (cursor <= source.length - selected.length) {
    const offset = source.indexOf(selected, cursor);
    if (offset < 0) break;
    offsets.push(offset);
    cursor = offset + Math.max(1, selected.length);
  }
  return offsets;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function occurrenceAtBlock(markdown: string, selectedText: string, blockId: string): number | undefined {
  const source = normalizeSourceText(markdown);
  const marker = new RegExp(`(?:^|\\s)\\^${escapeRegExp(blockId)}\\s*$`, "m").exec(source);
  if (!marker) return undefined;
  const lineStart = source.lastIndexOf("\n", marker.index) + 1;
  const lineEndAt = source.indexOf("\n", marker.index);
  const lineEnd = lineEndAt < 0 ? source.length : lineEndAt;
  const offsets = selectionOffsets(source, selectedText);
  const matchIndex = offsets.findIndex((offset) => offset >= lineStart && offset + normalizeSourceText(selectedText).length <= lineEnd);
  return matchIndex < 0 ? undefined : matchIndex;
}

export function createObsidianReferenceCapture(input: CreateReferenceCaptureInput): ObsidianReferenceCaptureV2 {
  const selectedText = normalizeSourceText(input.selectedText).trim();
  const markdown = normalizeSourceText(input.markdown);
  return ObsidianReferenceCaptureV2Schema.parse({
    annotationProtocolVersion: ANNOTATION_PROTOCOL_VERSION,
    type: "reference-capture",
    actionId: input.actionId,
    referenceId: input.referenceId,
    source: {
      sourceType: "obsidian-note",
      selectedText,
      locator: {
        vaultId: input.vaultId,
        notePath: input.notePath,
        ...(input.heading ? { heading: input.heading } : {}),
        blockId: input.blockId,
        occurrence: input.occurrence,
        selectedTextHash: selectedTextHash(selectedText),
      },
      snapshot: {
        markdown,
        documentHash: documentHash(markdown),
        capturedAt: input.capturedAt,
        freshness: "captured",
      },
    },
  });
}

export async function refreshObsidianReference(
  vault: ReferenceVaultReader,
  capture: ObsidianReferenceCaptureV2,
  capturedAt = Date.now(),
): Promise<ReferenceRefreshResultV2> {
  const source = await vault.read(capture.source.locator.notePath);
  if (source === null) return { kind: "blocked", reason: "note-missing" };
  const markdown = normalizeSourceText(source);
  const nextHash = documentHash(markdown);
  if (nextHash === capture.source.snapshot.documentHash) return { kind: "unchanged", source: capture.source };
  const occurrence = occurrenceAtBlock(markdown, capture.source.selectedText, capture.source.locator.blockId);
  if (occurrence === undefined) {
    const marker = new RegExp(`(?:^|\\s)\\^${escapeRegExp(capture.source.locator.blockId)}\\s*$`, "m");
    return marker.test(markdown)
      ? { kind: "blocked", reason: "selection-changed" }
      : { kind: "blocked", reason: "block-missing" };
  }
  if (occurrence !== capture.source.locator.occurrence) return { kind: "blocked", reason: "ambiguous" };
  return {
    kind: "refreshed",
    source: {
      ...capture.source,
      snapshot: { markdown, documentHash: nextHash, capturedAt, freshness: "refreshed" },
    },
  };
}
