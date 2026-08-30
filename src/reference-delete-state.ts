import type { PendingReferenceRecord, StoredPluginDataV2 } from "./migrations/v1-pending.ts";
import type {
  BacklinkReceiptV2,
  ReferenceDeleteCommitV2,
  ReferenceDeleteRequestV2,
} from "./protocol.ts";

function referenceIdOf(record: PendingReferenceRecord): string {
  return record.state === "needs-reselect" ? record.referenceId : record.capture.referenceId;
}

export interface LocalReferenceStateRemoval {
  data: StoredPluginDataV2;
  record?: PendingReferenceRecord;
  receipt?: BacklinkReceiptV2;
}

/**
 * Remove the locally visible relationship while deliberately retaining its
 * durable delete request. The request is the outbox tombstone replayed to DSH
 * until Core confirms that its side of the relationship is gone.
 */
export function removeLocalReferenceState(
  data: StoredPluginDataV2,
  referenceId: string,
): LocalReferenceStateRemoval {
  const record = data.pendingReferences.find((candidate) => referenceIdOf(candidate) === referenceId);
  const receipt = data.backlinkReceipts.find((candidate) => candidate.referenceId === referenceId);
  return {
    data: {
      ...data,
      pendingReferences: data.pendingReferences.filter((candidate) => referenceIdOf(candidate) !== referenceId),
      backlinkReceipts: data.backlinkReceipts.filter((candidate) => candidate.referenceId !== referenceId),
    },
    ...(record === undefined ? {} : { record }),
    ...(receipt === undefined ? {} : { receipt }),
  };
}

/** Clear the durable outbox tombstone only after Core acknowledges deletion. */
export function acknowledgeReferenceDelete(
  data: StoredPluginDataV2,
  referenceId: string,
): StoredPluginDataV2 {
  const local = removeLocalReferenceState(data, referenceId);
  return {
    ...local.data,
    referenceDeleteRequests: local.data.referenceDeleteRequests.filter((request) => request.referenceId !== referenceId),
  };
}

/** Use the same exact relation identity for the eager local cleanup. */
export function localDeleteCommit(
  request: ReferenceDeleteRequestV2,
): ReferenceDeleteCommitV2 {
  return {
    annotationProtocolVersion: request.annotationProtocolVersion,
    type: "reference-delete-commit",
    referenceId: request.referenceId,
    profileId: request.profileId,
    sessionId: request.sessionId,
    setId: request.setId,
    deletedAt: request.requestedAt,
  };
}
