import { createHash } from "node:crypto";

import {
  PROTOCOL_VERSION,
  sessionNoteDocumentSchema,
  stickerSchema,
  type SessionNoteDocument,
  type StickerRecord,
} from "../protocol.ts";

export interface VaultTextAdapter {
  read(path: string): Promise<string | null>;
  write(path: string, content: string): Promise<void>;
}

interface ManagedStickerBlock {
  start: number;
  end: number;
  sticker: StickerRecord;
}

export interface ParsedSessionNote {
  readonly source: string;
  readonly document: SessionNoteDocument;
  readonly blocks: readonly ManagedStickerBlock[];
}

export class VaultDocumentError extends Error {
  constructor(readonly code: "REVISION_CONFLICT" | "CORRUPT_MARKER" | "NOTE_NOT_FOUND", message: string) {
    super(message);
    this.name = "VaultDocumentError";
  }
}

const STICKER_BLOCK = /<!-- dsh-sticker:(\{[^\r\n]*\}) -->\r?\n([\s\S]*?)\r?\n<!-- \/dsh-sticker -->/g;

export function contentRevision(content: string): string {
  return `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
}

export function sessionNotePath(sessionId: string): string {
  return `DeepHarness/Sessions/${encodeURIComponent(sessionId)}.md`;
}

function corrupt(message: string): never {
  throw new VaultDocumentError("CORRUPT_MARKER", message);
}

function stickerFromBlock(metadataText: string, body: string): StickerRecord {
  let metadata: unknown;
  try {
    metadata = JSON.parse(metadataText);
  } catch {
    return corrupt("A dsh-sticker marker contains invalid JSON");
  }
  const lines = body.split(/\r?\n/);
  if (!lines[0]?.startsWith("> [!note]+ ")) return corrupt("A dsh-sticker block has no note callout header");
  const blockLine = lines.at(-1);
  const blockMatch = /^\^([A-Za-z0-9-]+)$/.exec(blockLine ?? "");
  if (!blockMatch) return corrupt("A dsh-sticker block has no stable block ID");
  const markdownLines = lines.slice(1, -1);
  if (markdownLines.some((line) => !line.startsWith(">"))) {
    return corrupt("A dsh-sticker callout contains unmanaged body lines");
  }
  const markdown = markdownLines.map((line) => line === ">" ? "" : line.replace(/^> ?/, "")).join("\n");
  try {
    const sticker = stickerSchema.parse({
      ...(metadata as Record<string, unknown>),
      markdown,
      blockId: blockMatch[1],
    });
    if (typeof (metadata as Record<string, unknown>).blockId === "string"
      && (metadata as Record<string, unknown>).blockId !== blockMatch[1]) {
      return corrupt("A dsh-sticker marker and callout disagree on block ID");
    }
    return sticker;
  } catch {
    return corrupt("A dsh-sticker marker does not match protocol v1");
  }
}

export function parseSessionNote(source: string, expectedSessionId?: string): ParsedSessionNote {
  const blocks: ManagedStickerBlock[] = [];
  const ids = new Set<string>();
  let match: RegExpExecArray | null;
  STICKER_BLOCK.lastIndex = 0;
  while ((match = STICKER_BLOCK.exec(source)) !== null) {
    const sticker = stickerFromBlock(match[1] ?? "", match[2] ?? "");
    if (expectedSessionId && sticker.sessionId !== expectedSessionId) {
      return corrupt(`Sticker ${sticker.stickerId} belongs to a different session`);
    }
    if (ids.has(sticker.stickerId)) return corrupt(`Duplicate sticker ID: ${sticker.stickerId}`);
    ids.add(sticker.stickerId);
    blocks.push({ start: match.index, end: match.index + match[0].length, sticker });
  }
  const markerStarts = source.match(/<!-- dsh-sticker:/g)?.length ?? 0;
  const markerEnds = source.match(/<!-- \/dsh-sticker -->/g)?.length ?? 0;
  if (markerStarts !== blocks.length || markerEnds !== blocks.length) {
    return corrupt("A dsh-sticker marker is incomplete or damaged");
  }
  const inferredSessionId = expectedSessionId ?? blocks[0]?.sticker.sessionId;
  if (!inferredSessionId) return corrupt("Session ID is required for a note without sticker blocks");
  return {
    source,
    blocks,
    document: {
      protocolVersion: PROTOCOL_VERSION,
      type: "session-note",
      sessionId: inferredSessionId,
      revision: contentRevision(source),
      stickers: blocks.map((block) => block.sticker),
    },
  };
}

export function renderSessionNote(parsed: ParsedSessionNote): string {
  return parsed.source;
}

export function renderStickerBlock(sticker: StickerRecord): string {
  const { markdown, ...metadata } = sticker;
  const blockId = sticker.blockId ?? `dsh-sticker-${sticker.stickerId.slice(0, 8)}`;
  return [
    `<!-- dsh-sticker:${JSON.stringify({ ...metadata, blockId })} -->`,
    `> [!note]+ ${sticker.quote}`,
    ...markdown.split("\n").map((line) => `> ${line}`),
    `^${blockId}`,
    "<!-- /dsh-sticker -->",
  ].join("\n");
}

function applyStickerChanges(parsed: ParsedSessionNote, desired: readonly StickerRecord[]): string {
  const desiredById = new Map(desired.map((sticker) => [sticker.stickerId, sticker]));
  const existingIds = new Set(parsed.blocks.map((block) => block.sticker.stickerId));
  let output = parsed.source;
  for (const block of [...parsed.blocks].reverse()) {
    const replacement = desiredById.get(block.sticker.stickerId);
    output = `${output.slice(0, block.start)}${replacement ? renderStickerBlock(replacement) : ""}${output.slice(block.end)}`;
  }
  const additions = desired.filter((sticker) => !existingIds.has(sticker.stickerId));
  if (additions.length > 0) {
    const separator = output.length === 0 ? "" : output.endsWith("\n") ? "\n" : "\n\n";
    output = `${output}${separator}${additions.map(renderStickerBlock).join("\n\n")}\n`;
  }
  return output;
}

export async function readSessionNote(vault: VaultTextAdapter, sessionId: string): Promise<SessionNoteDocument> {
  const source = await vault.read(sessionNotePath(sessionId));
  if (source === null) {
    return {
      protocolVersion: PROTOCOL_VERSION,
      type: "session-note",
      sessionId,
      revision: contentRevision(""),
      stickers: [],
    };
  }
  return parseSessionNote(source, sessionId).document;
}

export async function saveSessionNote(
  vault: VaultTextAdapter,
  value: SessionNoteDocument,
  expectedRevision: string,
): Promise<{ revision: string }> {
  const document = sessionNoteDocumentSchema.parse(value);
  const path = sessionNotePath(document.sessionId);
  const current = await vault.read(path) ?? "";
  const actualRevision = contentRevision(current);
  if (actualRevision !== expectedRevision) {
    throw new VaultDocumentError("REVISION_CONFLICT", `Expected ${expectedRevision}, found ${actualRevision}`);
  }
  const initialSource = current.length === 0 ? `# DSH 会话 ${document.sessionId}\n` : current;
  const parsed = parseSessionNote(initialSource, document.sessionId);
  const output = applyStickerChanges(parsed, document.stickers);
  if (output !== current) await vault.write(path, output);
  return { revision: contentRevision(output) };
}
