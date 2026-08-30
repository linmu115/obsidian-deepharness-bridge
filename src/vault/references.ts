import {
  backlinkCommitDigest,
  documentHash,
  type BacklinkCommitV2,
  type BacklinkReceiptV2,
  type ObsidianReferenceCaptureV2,
  type ReferenceDeleteCommitV2,
  type PendingCitation,
  type ResolvedCitation,
} from "../protocol.ts";
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
    let raw: unknown;
    try { raw = JSON.parse(match[1] ?? ""); }
    catch { throw new VaultDocumentError("CORRUPT_MARKER", "A dsh-reference marker contains invalid metadata"); }
    if (typeof raw !== "object" || raw === null || !("citationId" in raw)) continue;
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

export interface ReferenceVaultProcessAdapter extends VaultTextAdapter {
  process(path: string, update: (content: string) => string): Promise<string>;
}

export interface ReferenceDeleteVaultAdapter extends ReferenceVaultProcessAdapter {
  listMarkdownPaths(): Promise<string[]>;
}

export class ReferenceDocumentError extends Error {
  constructor(readonly code: "REVISION_CONFLICT" | "CORRUPT_MARKER" | "NOTE_NOT_FOUND" | "IDEMPOTENCY_CONFLICT", message: string) {
    super(message);
    this.name = "ReferenceDocumentError";
  }
}

interface ReferenceMetadataV2 {
  referenceId: string;
  setId: string;
  profileId: string;
  sessionId: string;
  userMessageId: string;
  userAnchorId: string;
  userTextHash: string;
  commitDigest: string;
  blockId: string;
}

export interface CommittedReferenceNavigationTarget {
  notePath: string;
  referenceId: string;
  setId: string;
  profileId: string;
  sessionId: string;
  userMessageId: string;
  userAnchorId: string;
  userTextHash: string;
}

function parseV2Metadata(value: string): ReferenceMetadataV2 | null {
  let raw: unknown;
  try { raw = JSON.parse(value); }
  catch { throw new ReferenceDocumentError("CORRUPT_MARKER", "A dsh-reference marker contains invalid JSON"); }
  if (typeof raw !== "object" || raw === null || !("referenceId" in raw)) return null;
  const metadata = raw as Partial<ReferenceMetadataV2>;
  for (const key of ["referenceId", "setId", "profileId", "sessionId", "userMessageId", "userAnchorId", "userTextHash", "commitDigest", "blockId"] as const) {
    if (typeof metadata[key] !== "string" || metadata[key] === "") {
      throw new ReferenceDocumentError("CORRUPT_MARKER", `A v2 dsh-reference marker is missing ${key}`);
    }
  }
  return metadata as ReferenceMetadataV2;
}

function parseMatchingV2Metadata(value: string, referenceId: string): ReferenceMetadataV2 | null {
  let raw: unknown;
  try { raw = JSON.parse(value); }
  catch { return null; }
  if (typeof raw !== "object" || raw === null || (raw as { referenceId?: unknown }).referenceId !== referenceId) {
    return null;
  }
  return parseV2Metadata(value);
}

function findV2Reference(source: string, referenceId: string): ReferenceMetadataV2 | null {
  REFERENCE_BLOCK.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = REFERENCE_BLOCK.exec(source)) !== null) {
    const metadata = parseMatchingV2Metadata(match[1] ?? "", referenceId);
    if (metadata?.referenceId === referenceId) return metadata;
  }
  const openingMarkers = source.matchAll(/<!-- dsh-reference:(\{[^\r\n]*\}) -->/g);
  for (const opening of openingMarkers) {
    let raw: unknown;
    try { raw = JSON.parse(opening[1] ?? ""); }
    catch { continue; }
    if (typeof raw === "object" && raw !== null && (raw as { referenceId?: unknown }).referenceId === referenceId) {
      throw new ReferenceDocumentError("CORRUPT_MARKER", "The requested dsh-reference marker is incomplete");
    }
  }
  return null;
}

function navigationTarget(
  notePath: string,
  metadata: ReferenceMetadataV2,
): CommittedReferenceNavigationTarget {
  return {
    notePath,
    referenceId: metadata.referenceId,
    setId: metadata.setId,
    profileId: metadata.profileId,
    sessionId: metadata.sessionId,
    userMessageId: metadata.userMessageId,
    userAnchorId: metadata.userAnchorId,
    userTextHash: metadata.userTextHash,
  };
}

export async function findCommittedReferenceNavigationTarget(
  vault: ReferenceDeleteVaultAdapter,
  referenceId: string,
  recordedNotePath?: string,
): Promise<CommittedReferenceNavigationTarget | null> {
  if (recordedNotePath !== undefined) {
    const source = await vault.read(recordedNotePath);
    if (source !== null) {
      const metadata = findV2Reference(source, referenceId);
      if (metadata !== null) return navigationTarget(recordedNotePath, metadata);
    }
  }

  for (const notePath of await vault.listMarkdownPaths()) {
    if (notePath === recordedNotePath) continue;
    const source = await vault.read(notePath);
    if (source === null) continue;
    const metadata = findV2Reference(source, referenceId);
    if (metadata !== null) return navigationTarget(notePath, metadata);
  }
  return null;
}

function findV2ReferenceBlock(
  source: string,
  referenceId: string,
): { start: number; end: number; metadata: ReferenceMetadataV2 } | null {
  REFERENCE_BLOCK.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = REFERENCE_BLOCK.exec(source)) !== null) {
    const metadata = parseMatchingV2Metadata(match[1] ?? "", referenceId);
    if (metadata?.referenceId === referenceId) {
      return { start: match.index, end: match.index + match[0].length, metadata };
    }
  }
  const openingMarkers = source.matchAll(/<!-- dsh-reference:(\{[^\r\n]*\}) -->/g);
  for (const opening of openingMarkers) {
    let raw: unknown;
    try { raw = JSON.parse(opening[1] ?? ""); }
    catch { continue; }
    if (typeof raw === "object" && raw !== null && (raw as { referenceId?: unknown }).referenceId === referenceId) {
      throw new ReferenceDocumentError("CORRUPT_MARKER", "The requested dsh-reference marker is incomplete");
    }
  }
  return null;
}

function validateDeleteRelation(metadata: ReferenceMetadataV2, commit: ReferenceDeleteCommitV2): void {
  if (
    metadata.setId !== commit.setId || metadata.profileId !== commit.profileId
    || metadata.sessionId !== commit.sessionId
  ) throw new ReferenceDocumentError("IDEMPOTENCY_CONFLICT", "The committed reference block belongs to a different DSH relation");
}

async function removeV2ReferenceBlock(
  vault: ReferenceDeleteVaultAdapter,
  path: string,
  commit: ReferenceDeleteCommitV2,
  metadata: ReferenceMetadataV2,
): Promise<{ removed: boolean; notePath?: string; blockId?: string }> {
  let removed = false;
  await vault.process(path, (source) => {
    const block = findV2ReferenceBlock(source, commit.referenceId);
    if (block === null) return source;
    validateDeleteRelation(block.metadata, commit);
    removed = true;
    let end = block.end;
    if (source.slice(end, end + 2) === "\r\n") end += 2;
    else if (source[end] === "\n") end += 1;
    return `${source.slice(0, block.start)}${source.slice(end)}`;
  });
  return removed ? { removed, notePath: path, blockId: metadata.blockId } : { removed: false };
}

export async function deleteCommittedReferenceBacklink(
  vault: ReferenceDeleteVaultAdapter,
  commit: ReferenceDeleteCommitV2,
  recordedNotePath?: string,
): Promise<{ removed: boolean; notePath?: string; blockId?: string }> {
  if (recordedNotePath !== undefined) {
    const recordedSource = await vault.read(recordedNotePath);
    if (recordedSource !== null) {
      const recordedBlock = findV2ReferenceBlock(recordedSource, commit.referenceId);
      if (recordedBlock !== null) {
        validateDeleteRelation(recordedBlock.metadata, commit);
        return removeV2ReferenceBlock(vault, recordedNotePath, commit, recordedBlock.metadata);
      }
    }
  }

  const orderedPaths = (await vault.listMarkdownPaths()).filter((path) => path !== recordedNotePath);
  let found: { path: string; metadata: ReferenceMetadataV2 } | undefined;
  for (const path of orderedPaths) {
    const source = await vault.read(path);
    if (source === null) continue;
    const block = findV2ReferenceBlock(source, commit.referenceId);
    if (block === null) continue;
    if (found !== undefined) throw new ReferenceDocumentError("IDEMPOTENCY_CONFLICT", "The committed reference block is ambiguous");
    validateDeleteRelation(block.metadata, commit);
    found = { path, metadata: block.metadata };
  }
  if (found === undefined) return { removed: false };
  return removeV2ReferenceBlock(vault, found.path, commit, found.metadata);
}

function renderV2Reference(
  capture: ObsidianReferenceCaptureV2,
  commit: BacklinkCommitV2,
  commitDigest: string,
  blockId: string,
): string {
  const metadata: ReferenceMetadataV2 = {
    referenceId: commit.referenceId,
    setId: commit.setId,
    profileId: commit.profileId,
    sessionId: commit.sessionId,
    userMessageId: commit.userMessageId,
    userAnchorId: commit.userAnchorId,
    userTextHash: commit.userTextHash,
    commitDigest,
    blockId,
  };
  const logicalLink = buildObsidianDshLink({
    sessionId: commit.sessionId,
    anchorId: commit.userAnchorId,
    quoteHash: commit.userTextHash,
    setId: commit.setId,
    referenceId: commit.referenceId,
  });
  return [
    `<!-- dsh-reference:${JSON.stringify(metadata)} -->`,
    "> [!dsh-reference]",
    `> [[DSH会话-${safeWikiText(commit.sessionId)}#^${safeWikiText(commit.userAnchorId)}|DSH 用户提问]]`,
    `> [打开 DSH 会话](${logicalLink})`,
    `> 引用内容：${capture.source.selectedText.split("\n").join("\n> ")}`,
    `> ^${blockId}`,
    "<!-- /dsh-reference -->",
  ].join("\n");
}

export async function commitReferenceBacklink(
  vault: ReferenceVaultProcessAdapter,
  capture: ObsidianReferenceCaptureV2,
  commit: BacklinkCommitV2,
  existingReceipt?: BacklinkReceiptV2,
  writtenAt = Date.now(),
): Promise<BacklinkReceiptV2> {
  if (capture.referenceId !== commit.referenceId) {
    throw new ReferenceDocumentError("IDEMPOTENCY_CONFLICT", "Capture and backlink reference IDs do not match");
  }
  const digest = backlinkCommitDigest(commit);
  if (existingReceipt !== undefined) {
    if (existingReceipt.referenceId !== commit.referenceId || existingReceipt.commitDigest !== digest) {
      throw new ReferenceDocumentError("IDEMPOTENCY_CONFLICT", "Backlink retry conflicts with the persisted receipt");
    }
    return existingReceipt;
  }
  const notePath = capture.source.locator.notePath;
  const blockId = `dsh-ref-${commit.referenceId.slice(0, 8)}`;
  let recoveredBlockId: string | undefined;
  const output = await vault.process(notePath, (source) => {
    const marker = findV2Reference(source, commit.referenceId);
    if (marker !== null) {
      if (marker.commitDigest !== digest) {
        throw new ReferenceDocumentError("IDEMPOTENCY_CONFLICT", "Backlink marker belongs to a different commit");
      }
      recoveredBlockId = marker.blockId;
      return source;
    }
    if (documentHash(source) !== capture.source.snapshot.documentHash) {
      throw new ReferenceDocumentError("REVISION_CONFLICT", "The note changed after the reference was captured");
    }
    const separator = source.length === 0 ? "" : source.endsWith("\n") ? "\n" : "\n\n";
    return `${source}${separator}${renderV2Reference(capture, commit, digest, blockId)}\n`;
  });
  return {
    referenceId: commit.referenceId,
    commitDigest: digest,
    notePath,
    blockId: recoveredBlockId ?? blockId,
    revision: contentRevision(output),
    writtenAt,
  };
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
