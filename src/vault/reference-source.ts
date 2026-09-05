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
  findMarkdownPaths?(kind: "reference" | "sticker" | "block", id: string): Promise<readonly string[]>;
}

export async function locateObsidianReference(
  vault: ReferenceVaultReader,
  capture: ObsidianReferenceCaptureV2,
): Promise<{ notePath: string; markdown: string } | { reason: "note-missing" | "block-missing" | "ambiguous" }> {
  const { notePath, blockId } = capture.source.locator;
  const marker = () => new RegExp(`(?:^|\\s)\\^${escapeRegExp(blockId)}[ \\t]*(?=\\r?$)`, "gm");
  const recorded = await vault.read(notePath);
  const count = recorded === null ? 0 : [...recorded.matchAll(marker())].length;
  if (count > 1) return { reason: "ambiguous" };
  if (count === 1) return { notePath, markdown: recorded! };
  let located: { notePath: string; markdown: string } | undefined;
  for (const candidate of await (vault.findMarkdownPaths?.("block", blockId) ?? Promise.resolve([]))) {
    if (candidate === notePath) continue;
    const markdown = await vault.read(candidate);
    const matches = markdown === null ? 0 : [...markdown.matchAll(marker())].length;
    if (matches > 1 || (matches > 0 && located)) return { reason: "ambiguous" };
    if (matches === 1) located = { notePath: candidate, markdown: markdown! };
  }
  return located ?? { reason: recorded === null ? "note-missing" : "block-missing" };
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
  const located = await locateObsidianReference(vault, capture);
  if ("reason" in located) return { kind: "blocked", reason: located.reason };
  const markdown = normalizeSourceText(located.markdown);
  const nextHash = documentHash(markdown);
  if (nextHash === capture.source.snapshot.documentHash && located.notePath === capture.source.locator.notePath) return { kind: "unchanged", source: capture.source };
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
      locator: { ...capture.source.locator, notePath: located.notePath },
      snapshot: { markdown, documentHash: nextHash, capturedAt, freshness: "refreshed" },
    },
  };
}
