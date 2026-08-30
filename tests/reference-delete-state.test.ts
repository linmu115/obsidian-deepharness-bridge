import { describe, expect, it } from "vitest";

import {
  discardPendingReference,
  type PendingReferenceRecord,
  type StoredPluginDataV2,
} from "../src/migrations/v1-pending.ts";
import type { BacklinkReceiptV2, ReferenceDeleteRequestV2 } from "../src/protocol.ts";
import {
  acknowledgeReferenceDelete,
  localDeleteCommit,
  removeLocalReferenceState,
} from "../src/reference-delete-state.ts";
import { DEFAULT_SETTINGS } from "../src/settings.ts";

const request: ReferenceDeleteRequestV2 = {
  annotationProtocolVersion: 2,
  type: "reference-delete-request",
  actionId: "delete-action-1",
  referenceId: "reference-1",
  profileId: "web",
  sessionId: "session-1",
  setId: "set-1",
  requestedAt: 100,
};

const record = {
  state: "claimed",
  blockIdOwnership: "plugin-created",
  capture: { referenceId: request.referenceId },
  claim: {
    annotationProtocolVersion: 2,
    type: "reference-claim",
    referenceId: request.referenceId,
    profileId: request.profileId,
    sessionId: request.sessionId,
    setId: request.setId,
  },
} as PendingReferenceRecord;

const receipt = {
  referenceId: request.referenceId,
  commitDigest: `sha256:${"1".repeat(64)}`,
  notePath: "note.md",
  blockId: "dsh-ref-reference",
  revision: "revision-1",
  writtenAt: 90,
} satisfies BacklinkReceiptV2;

function data(): StoredPluginDataV2 {
  return {
    dataVersion: 2,
    vaultId: "vault-1",
    settings: DEFAULT_SETTINGS,
    pendingReferences: [record],
    backlinkReceipts: [receipt],
    referenceDeleteRequests: [request],
  };
}

describe("local-first reference deletion state", () => {
  it("removes visible local state but keeps the durable Core outbox tombstone", () => {
    const removed = removeLocalReferenceState(data(), request.referenceId);
    expect(removed.record).toBe(record);
    expect(removed.receipt).toBe(receipt);
    expect(removed.data.pendingReferences).toEqual([]);
    expect(removed.data.backlinkReceipts).toEqual([]);
    expect(removed.data.referenceDeleteRequests).toEqual([request]);
  });

  it("clears the tombstone only after the Core acknowledgement", () => {
    const removed = removeLocalReferenceState(data(), request.referenceId).data;
    expect(acknowledgeReferenceDelete(removed, request.referenceId).referenceDeleteRequests).toEqual([]);
  });

  it("accepts a Core pending-discard acknowledgement after eager local removal", () => {
    const locallyRemoved = removeLocalReferenceState(data(), request.referenceId).data;
    const acknowledged = discardPendingReference(locallyRemoved, request.referenceId);

    expect(acknowledged.changed).toBe(true);
    expect(acknowledged.data.referenceDeleteRequests).toEqual([]);
  });

  it("uses the exact relation identity for eager local cleanup", () => {
    expect(localDeleteCommit(request)).toEqual({
      annotationProtocolVersion: 2,
      type: "reference-delete-commit",
      referenceId: "reference-1",
      profileId: "web",
      sessionId: "session-1",
      setId: "set-1",
      deletedAt: 100,
    });
  });
});
