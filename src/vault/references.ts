import type { PendingCitation, ResolvedCitation } from "../protocol.ts";
import { buildObsidianDshLink } from "../logical-link.ts";
import { contentRevision, VaultDocumentError, type VaultTextAdapter } from "./session-notes.ts";

export interface ReferenceLocation {
  notePath: string;
  blockId: string;
  revision: string;
  removed?: boolean;
}

interface ReferenceMetadata {
  citationId: string;
  sessionId: string;
  anchorId: string;
  quoteHash: string;
  blockId: string;
}

const REFERENCE_BLOCK = /<!-- dsh-reference:(\{[^\r\n]*\}) -->\r?\n[\s\S]*?\r?\n<!-- \/dsh-reference -->/g;

function parseReferenceMetadata(value: string): ReferenceMetadata {
  try {
    const metadata = JSON.parse(value) as Partial<ReferenceMetadata>;
    if (!metadata.citationId || !metadata.sessionId || !metadata.anchorId || !metadata.quoteHash || !metadata.blockId) {
      throw new Error("missing field");
    }
    return metadata as ReferenceMetadata;
  } catch {
    throw new VaultDocumentError("CORRUPT_MARKER", "A dsh-reference marker contains invalid metadata");
  }
}

function findReference(source: string, citationId: string): { start: number; end: number; metadata: ReferenceMetadata } | null {
  REFERENCE_BLOCK.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = REFERENCE_BLOCK.exec(source)) !== null) {
    const metadata = parseReferenceMetadata(match[1] ?? "");
    if (metadata.citationId === citationId) {
      return { start: match.index, end: match.index + match[0].length, metadata };
    }
  }
  const starts = source.match(/<!-- dsh-reference:/g)?.length ?? 0;
  const ends = source.match(/<!-- \/dsh-reference -->/g)?.length ?? 0;
  if (starts !== ends) throw new VaultDocumentError("CORRUPT_MARKER", "A dsh-reference marker is incomplete");
  return null;
}

function safeWikiText(value: string): string {
  return value.replace(/[\[\]|#^]/g, "-");
}

function renderReference(pending: PendingCitation, resolved: ResolvedCitation, blockId: string): string {
  const metadata: ReferenceMetadata = {
    citationId: pending.citationId,
    sessionId: resolved.sessionId,
    anchorId: resolved.anchorId,
    quoteHash: resolved.quoteHash,
    blockId,
  };
  const sessionTitle = `DSH会话-${safeWikiText(resolved.sessionId)}`;
  const logicalLink = buildObsidianDshLink({
    sessionId: resolved.sessionId,
    anchorId: resolved.anchorId,
    quoteHash: resolved.quoteHash,
  });
  const quoteLines = pending.text.split("\n");
  return [
    `<!-- dsh-reference:${JSON.stringify(metadata)} -->`,
    "> [!dsh-reference]",
    `> 来源：[[${sessionTitle}#^${safeWikiText(resolved.anchorId)}|DSH 用户提问]]`,
    `> [打开 DSH 会话](${logicalLink})`,
    `> 引用内容：${quoteLines[0] ?? ""}`,
    ...quoteLines.slice(1).map((line) => `> ${line}`),
    `> ^${blockId}`,
    "<!-- /dsh-reference -->",
  ].join("\n");
}

export async function insertResolvedCitation(
  vault: VaultTextAdapter,
  pending: PendingCitation,
  resolved: ResolvedCitation,
): Promise<ReferenceLocation> {
  if (pending.citationId !== resolved.citationId) {
    throw new Error("Pending and resolved citation IDs do not match");
  }
  const source = await vault.read(pending.notePath);
  if (source === null) throw new VaultDocumentError("NOTE_NOT_FOUND", `Vault note was not found: ${pending.notePath}`);
  const existing = findReference(source, pending.citationId);
  if (existing) {
    return {
      notePath: pending.notePath,
      blockId: existing.metadata.blockId,
      revision: contentRevision(source),
    };
  }
  const actualRevision = contentRevision(source);
  if (actualRevision !== pending.contentHash) {
    throw new VaultDocumentError("REVISION_CONFLICT", `Expected ${pending.contentHash}, found ${actualRevision}`);
  }
  const blockId = `dsh-ref-${pending.citationId.slice(0, 8)}`;
  const separator = source.length === 0 ? "" : source.endsWith("\n") ? "\n" : "\n\n";
  const output = `${source}${separator}${renderReference(pending, resolved, blockId)}\n`;
  await vault.write(pending.notePath, output);
  return { notePath: pending.notePath, blockId, revision: contentRevision(output) };
}

export async function removeResolvedCitation(
  vault: VaultTextAdapter,
  notePath: string,
  citationId: string,
  expectedRevision: string,
): Promise<ReferenceLocation> {
  const source = await vault.read(notePath);
  if (source === null) throw new VaultDocumentError("NOTE_NOT_FOUND", `Vault note was not found: ${notePath}`);
  const actualRevision = contentRevision(source);
  if (actualRevision !== expectedRevision) {
    throw new VaultDocumentError("REVISION_CONFLICT", `Expected ${expectedRevision}, found ${actualRevision}`);
  }
  const existing = findReference(source, citationId);
  if (!existing) return { notePath, blockId: `dsh-ref-${citationId.slice(0, 8)}`, revision: actualRevision, removed: false };
  const output = `${source.slice(0, existing.start)}${source.slice(existing.end)}`;
  await vault.write(notePath, output);
  return { notePath, blockId: existing.metadata.blockId, revision: contentRevision(output), removed: true };
}
