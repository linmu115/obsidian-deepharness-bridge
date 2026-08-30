import {
  BacklinkReceiptV2Schema,
  ObsidianReferenceCaptureV2Schema,
  ReferenceClaimV2Schema,
  ReferenceDeleteRequestV2Schema,
  pendingCitationSchema,
  type BacklinkReceiptV2,
  type ObsidianReferenceCaptureV2,
  type PendingCitation,
  type ReferenceClaimV2,
  type ReferenceDeleteRequestV2,
} from "../protocol.ts";
import type { DeepHarnessBridgeSettings } from "../settings.ts";
import { createObsidianReferenceCapture, occurrenceAtBlock } from "../vault/reference-source.ts";

export interface LegacyPendingCitationV1 {
  citationId: string;
  notePath: string;
  blockId: string;
  heading?: string;
  text: string;
  contentHash: string;
}

export type BlockIdOwnership = "plugin-created" | "pre-existing";

interface MarkerOwnership {
  blockIdOwnership: BlockIdOwnership;
}

export type PendingReferenceRecord =
  | ({ state: "queued"; capture: ObsidianReferenceCaptureV2 } & MarkerOwnership)
  | ({ state: "migrated-ready"; capture: ObsidianReferenceCaptureV2; legacy: LegacyPendingCitationV1 } & MarkerOwnership)
  | ({ state: "claimed"; capture: ObsidianReferenceCaptureV2; claim: ReferenceClaimV2 } & MarkerOwnership)
  | {
      state: "needs-reselect";
      referenceId: string;
      legacy: LegacyPendingCitationV1 | { raw: unknown };
      reason: "note-missing" | "block-missing" | "ambiguous" | "content-changed" | "invalid-record";
    };

export interface StoredPluginDataV2 {
  dataVersion: 2;
  vaultId: string;
  settings: DeepHarnessBridgeSettings;
  pendingReferences: PendingReferenceRecord[];
  backlinkReceipts: BacklinkReceiptV2[];
  referenceDeleteRequests: ReferenceDeleteRequestV2[];
}

interface StoredPluginDataV1 {
  settings?: Partial<DeepHarnessBridgeSettings>;
  pendingCitations?: unknown[];
}

export interface MigrationVaultReader { read(path: string): Promise<string | null> }

export interface MigrationOptions {
  vault: MigrationVaultReader;
  defaultSettings: DeepHarnessBridgeSettings;
  createVaultId(): string;
  createActionId(): string;
  now(): number;
}

function legacyRecord(value: PendingCitation): LegacyPendingCitationV1 {
  return {
    citationId: value.citationId,
    notePath: value.notePath,
    blockId: value.blockId,
    ...(value.heading ? { heading: value.heading } : {}),
    text: value.text,
    contentHash: value.contentHash,
  };
}

function markerExists(markdown: string, referenceId: string): boolean {
  const escaped = referenceId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`<!-- dsh-reference:\\{[^\\r\\n]*(?:\\"referenceId\\"|\\"citationId\\"):\\"${escaped}\\"`).test(markdown);
}

function isV2(value: unknown): value is StoredPluginDataV2 {
  return typeof value === "object" && value !== null && (value as { dataVersion?: unknown }).dataVersion === 2;
}

function markerOwnership(value: unknown, capture: ObsidianReferenceCaptureV2): BlockIdOwnership {
  if (value === "plugin-created" || value === "pre-existing") return value;
  return capture.source.locator.blockId.startsWith("dsh-note-") ? "plugin-created" : "pre-existing";
}

function validateV2(value: StoredPluginDataV2): StoredPluginDataV2 {
  const pendingReferences = value.pendingReferences.map((record): PendingReferenceRecord => {
    if (record.state === "queued") {
      const capture = ObsidianReferenceCaptureV2Schema.parse(record.capture);
      return { state: "queued", capture, blockIdOwnership: markerOwnership(record.blockIdOwnership, capture) };
    }
    if (record.state === "migrated-ready") {
      const capture = ObsidianReferenceCaptureV2Schema.parse(record.capture);
      return {
        state: "migrated-ready",
        capture,
        legacy: record.legacy,
        blockIdOwnership: markerOwnership(record.blockIdOwnership, capture),
      };
    }
    if (record.state === "claimed") {
      const capture = ObsidianReferenceCaptureV2Schema.parse(record.capture);
      return {
        state: "claimed",
        capture,
        claim: ReferenceClaimV2Schema.parse(record.claim),
        blockIdOwnership: markerOwnership(record.blockIdOwnership, capture),
      };
    }
    return record;
  });
  return {
    dataVersion: 2,
    vaultId: value.vaultId,
    settings: value.settings,
    pendingReferences,
    backlinkReceipts: value.backlinkReceipts.map((receipt) => BacklinkReceiptV2Schema.parse(receipt)),
    referenceDeleteRequests: (value.referenceDeleteRequests ?? []).map((request) => ReferenceDeleteRequestV2Schema.parse(request)),
  };
}

export async function migrateStoredPluginData(raw: unknown, options: MigrationOptions): Promise<StoredPluginDataV2> {
  if (isV2(raw)) return validateV2(raw);
  const legacyData = (typeof raw === "object" && raw !== null ? raw : {}) as StoredPluginDataV1;
  const settings = { ...options.defaultSettings, ...(legacyData.settings ?? {}) };
  const vaultId = options.createVaultId();
  const pendingReferences: PendingReferenceRecord[] = [];
  for (const [index, rawRecord] of (legacyData.pendingCitations ?? []).entries()) {
    const parsed = pendingCitationSchema.safeParse(rawRecord);
    if (!parsed.success) {
      pendingReferences.push({
        state: "needs-reselect",
        referenceId: `legacy-invalid-${index + 1}`,
        legacy: { raw: structuredClone(rawRecord) },
        reason: "invalid-record",
      });
      continue;
    }
    const legacy = legacyRecord(parsed.data);
    const markdown = await options.vault.read(legacy.notePath);
    if (markdown === null) {
      pendingReferences.push({ state: "needs-reselect", referenceId: legacy.citationId, legacy, reason: "note-missing" });
      continue;
    }
    if (markerExists(markdown, legacy.citationId)) continue;
    const occurrence = occurrenceAtBlock(markdown, legacy.text, legacy.blockId);
    if (occurrence === undefined) {
      const blockPresent = markdown.includes(`^${legacy.blockId}`);
      pendingReferences.push({
        state: "needs-reselect",
        referenceId: legacy.citationId,
        legacy,
        reason: blockPresent ? "content-changed" : "block-missing",
      });
      continue;
    }
    const capture = createObsidianReferenceCapture({
      actionId: options.createActionId(),
      referenceId: legacy.citationId,
      vaultId,
      notePath: legacy.notePath,
      ...(legacy.heading ? { heading: legacy.heading } : {}),
      blockId: legacy.blockId,
      occurrence,
      selectedText: legacy.text,
      markdown,
      capturedAt: options.now(),
    });
    pendingReferences.push({
      state: "migrated-ready",
      capture,
      legacy,
      blockIdOwnership: markerOwnership(undefined, capture),
    });
  }
  return { dataVersion: 2, vaultId, settings, pendingReferences, backlinkReceipts: [], referenceDeleteRequests: [] };
}

export function releaseMigratedReference(
  data: StoredPluginDataV2,
  referenceId: string,
): { data: StoredPluginDataV2; changed: boolean; capture?: ObsidianReferenceCaptureV2 } {
  const index = data.pendingReferences.findIndex((record) => record.state === "migrated-ready" && record.capture.referenceId === referenceId);
  if (index < 0) return { data, changed: false };
  const record = data.pendingReferences[index] as Extract<PendingReferenceRecord, { state: "migrated-ready" }>;
  const pendingReferences = [...data.pendingReferences];
  pendingReferences[index] = {
    state: "queued",
    capture: record.capture,
    blockIdOwnership: record.blockIdOwnership,
  };
  return { data: { ...data, pendingReferences }, changed: true, capture: record.capture };
}

export function discardPendingReference(
  data: StoredPluginDataV2,
  referenceId: string,
): { data: StoredPluginDataV2; changed: boolean; record?: PendingReferenceRecord } {
  const record = data.pendingReferences.find((candidate) => (
    candidate.state === "needs-reselect" ? candidate.referenceId === referenceId : candidate.capture.referenceId === referenceId
  ));
  const pendingReferences = data.pendingReferences.filter((record) => (
    record.state === "needs-reselect" ? record.referenceId !== referenceId : record.capture.referenceId !== referenceId
  ));
  const referenceDeleteRequests = data.referenceDeleteRequests.filter((request) => request.referenceId !== referenceId);
  const changed = pendingReferences.length !== data.pendingReferences.length
    || referenceDeleteRequests.length !== data.referenceDeleteRequests.length;
  return !changed
    ? { data, changed: false }
    : {
        data: { ...data, pendingReferences, referenceDeleteRequests },
        changed: true,
        ...(record === undefined ? {} : { record }),
      };
}
