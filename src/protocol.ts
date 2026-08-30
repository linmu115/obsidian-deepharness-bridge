import { z } from "zod";

export {
  ANNOTATION_PROTOCOL_VERSION,
  BacklinkCommitV2Schema,
  BacklinkReceiptV2Schema,
  ObsidianNoteReferenceSourceSchema,
  ObsidianReferenceCaptureV2Schema,
  ReferenceClaimV2Schema,
  ReferenceDiscardV2Schema,
  ReferenceDeleteCommitV2Schema,
  ReferenceDeleteRequestV2Schema,
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
  ReferenceClaimV2,
  ReferenceDiscardV2,
  ReferenceDeleteCommitV2,
  ReferenceDeleteRequestV2,
  ReferenceRefreshRequestV2,
  ReferenceRefreshResultV2,
} from "dsh-annotation-core/protocol";

export const STICKER_PROTOCOL_VERSION = 1 as const;
/** Historical alias retained for sticker/session-note/deep-link v1 only. */
export const PROTOCOL_VERSION = STICKER_PROTOCOL_VERSION;

export const stickerSchema = z.object({
  stickerId: z.string().uuid(),
  sessionId: z.string().min(1),
  anchorId: z.string().min(1),
  role: z.enum(["user", "assistant"]),
  quote: z.string(),
  quoteHash: z.string().min(1),
  occurrence: z.number().int().nonnegative(),
  markdown: z.string(),
  tags: z.array(z.string()),
  color: z.enum(["yellow", "green", "pink", "blue"]),
  notePath: z.string().optional(),
  blockId: z.string().optional(),
});

export const deepLinkActionSchema = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  type: z.literal("deep-link"),
  actionId: z.string().uuid(),
  sessionId: z.string().min(1),
  anchorId: z.string().min(1),
  quoteHash: z.string().optional(),
  stickerId: z.string().uuid().optional(),
  setId: z.string().min(1).optional(),
  referenceId: z.string().min(1).optional(),
  targetSurfaceId: z.string().uuid().optional(),
});

export const openNoteActionSchema = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  type: z.literal("open-note"),
  actionId: z.string().uuid(),
  notePath: z.string().min(1),
  blockId: z.string().optional(),
  line: z.number().int().nonnegative().optional(),
  column: z.number().int().nonnegative().optional(),
});

export const stickerBacklinkTargetSchema = z.object({
  stickerId: z.string().uuid(),
  sessionId: z.string().min(1),
  anchorId: z.string().min(1),
  quoteHash: z.string().min(1),
});

export const stickerBacklinkSchema = z.object({
  notePath: z.string().min(1),
  line: z.number().int().nonnegative(),
  column: z.number().int().nonnegative().optional(),
  blockId: z.string().min(1).optional(),
  heading: z.string().min(1).optional(),
  excerpt: z.string(),
});

export const stickerBacklinkDeleteResultSchema = z.object({
  notesChanged: z.number().int().nonnegative(),
  linksRemoved: z.number().int().nonnegative(),
});

export const pendingCitationSchema = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  type: z.literal("pending-citation"),
  citationId: z.string().uuid(),
  notePath: z.string().min(1),
  blockId: z.string().min(1),
  heading: z.string().optional(),
  text: z.string().min(1),
  contentHash: z.string().min(1),
});

export const resolvedCitationSchema = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  type: z.literal("resolved-citation"),
  citationId: z.string().uuid(),
  sessionId: z.string().min(1),
  anchorId: z.string().min(1),
  role: z.literal("user"),
  quoteHash: z.string().min(1),
});

export const sessionNoteDocumentSchema = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  type: z.literal("session-note"),
  sessionId: z.string().min(1),
  revision: z.string().min(1),
  stickers: z.array(stickerSchema),
});

export const bridgeMessageSchema = z.discriminatedUnion("type", [
  deepLinkActionSchema,
  openNoteActionSchema,
  pendingCitationSchema,
  resolvedCitationSchema,
  sessionNoteDocumentSchema,
]);

export type StickerRecord = z.infer<typeof stickerSchema>;
export type DeepLinkAction = z.infer<typeof deepLinkActionSchema>;
export type OpenNoteAction = z.infer<typeof openNoteActionSchema>;
export type StickerBacklinkTarget = z.infer<typeof stickerBacklinkTargetSchema>;
export type StickerBacklink = z.infer<typeof stickerBacklinkSchema>;
export type StickerBacklinkDeleteResult = z.infer<typeof stickerBacklinkDeleteResultSchema>;
export type PendingCitation = z.infer<typeof pendingCitationSchema>;
export type ResolvedCitation = z.infer<typeof resolvedCitationSchema>;
export type SessionNoteDocument = z.infer<typeof sessionNoteDocumentSchema>;
export type BridgeMessage = z.infer<typeof bridgeMessageSchema>;

export function parseBridgeMessage(value: unknown): BridgeMessage {
  return bridgeMessageSchema.parse(value);
}
