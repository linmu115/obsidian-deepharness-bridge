import { z } from "zod";
import {
  ReferenceClaimV2Schema as BaseReferenceClaimV2Schema,
  ReferenceDeleteCommitV2Schema as BaseReferenceDeleteCommitV2Schema,
  ReferenceDeleteRequestV2Schema as BaseReferenceDeleteRequestV2Schema,
} from "dsh-annotation-core/protocol";

export {
  ANNOTATION_PROTOCOL_VERSION,
  BacklinkCommitV2Schema,
  BacklinkReceiptV2Schema,
  ObsidianNoteReferenceSourceSchema,
  ObsidianReferenceCaptureV2Schema,
  ReferenceDiscardV2Schema,
  ReferenceRefreshRequestV2Schema,
  ReferenceRefreshResultV2Schema,
  backlinkCommitDigest,
  canonicalSha256,
  documentHash,
  normalizeSourceText,
  selectedTextHash,
} from "dsh-annotation-core/protocol";
export type {
  BacklinkCommitV2,
  BacklinkReceiptV2,
  ObsidianNoteReferenceSource,
  ObsidianReferenceCaptureV2,
  ReferenceDiscardV2,
  ReferenceRefreshRequestV2,
  ReferenceRefreshResultV2,
} from "dsh-annotation-core/protocol";

export * from "dsh-obsidian-bridge-protocol/data";
import { stableLogicalTargetShape } from "dsh-obsidian-bridge-protocol/data";

export const ReferenceClaimV2Schema = BaseReferenceClaimV2Schema.extend(stableLogicalTargetShape).strict();
export type ReferenceClaimV2 = z.infer<typeof ReferenceClaimV2Schema>;
export const ReferenceDeleteRequestV2Schema = BaseReferenceDeleteRequestV2Schema.extend(stableLogicalTargetShape).strict();
export type ReferenceDeleteRequestV2 = z.infer<typeof ReferenceDeleteRequestV2Schema>;
export const ReferenceDeleteCommitV2Schema = BaseReferenceDeleteCommitV2Schema.extend(stableLogicalTargetShape).strict();
export type ReferenceDeleteCommitV2 = z.infer<typeof ReferenceDeleteCommitV2Schema>;
