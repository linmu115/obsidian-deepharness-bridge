import { describe, expect, it } from "vitest";

import {
  ANNOTATION_PROTOCOL_VERSION,
  ObsidianReferenceCaptureV2Schema,
  ReferenceClaimV2Schema,
  STICKER_PROTOCOL_VERSION,
  documentHash,
  parseBridgeMessage,
  selectedTextHash,
} from "../src/protocol.ts";
import { buildObsidianDshLink, parseDshLogicalLink } from "../src/logical-link.ts";

describe("annotation protocol v2 boundary", () => {
  it("persists Maintenance logical IDs while retaining the old native target", () => {
    const claim = ReferenceClaimV2Schema.parse({
      annotationProtocolVersion: 2,
      type: "reference-claim",
      referenceId: "reference-1",
      profileId: "web",
      sessionId: "session-alpha1",
      setId: "set-1",
      logicalSessionId: "logical-session-1",
      legacySessionId: "session-alpha1",
    });
    expect(claim.logicalSessionId).toBe("logical-session-1");
    const link = buildObsidianDshLink({
      ...(claim.logicalSessionId ? { logicalSessionId: claim.logicalSessionId } : {}),
      logicalAnchorId: "logical-anchor-1",
      ...(claim.legacySessionId ? { legacySessionId: claim.legacySessionId } : {}),
      legacyAnchorId: "anchor-alpha1",
      sessionId: claim.sessionId,
      anchorId: "anchor-alpha1",
      referenceId: claim.referenceId,
    });
    expect(parseDshLogicalLink(link, () => "f6142265-c555-4547-9ed8-d9f178083841")).toMatchObject({
      logicalSessionId: "logical-session-1",
      logicalAnchorId: "logical-anchor-1",
      legacySessionId: "session-alpha1",
      legacyAnchorId: "anchor-alpha1",
      sessionId: "session-alpha1",
      anchorId: "anchor-alpha1",
    });
  });

  it("carries a stable vault locator and the complete Markdown snapshot", () => {
    const markdown = "# 维护系统\n\nGeneration 保存完整组合。 ^generation-definition\n";
    const capture = ObsidianReferenceCaptureV2Schema.parse({
      annotationProtocolVersion: ANNOTATION_PROTOCOL_VERSION,
      type: "reference-capture",
      actionId: "action-1",
      referenceId: "reference-1",
      source: {
        sourceType: "obsidian-note",
        selectedText: "Generation 保存完整组合。",
        locator: {
          vaultId: "vault-stable-1",
          notePath: "架构/维护系统.md",
          heading: "维护系统",
          blockId: "generation-definition",
          occurrence: 0,
          selectedTextHash: selectedTextHash("Generation 保存完整组合。"),
        },
        snapshot: {
          markdown,
          documentHash: documentHash(markdown),
          capturedAt: 1_777_000_000_000,
          freshness: "captured",
        },
      },
    });

    expect(capture.annotationProtocolVersion).toBe(2);
    expect(capture.source.snapshot.markdown).toBe(markdown);
  });

  it("keeps sticker and session-note protocol v1 readable", () => {
    expect(STICKER_PROTOCOL_VERSION).toBe(1);
    expect(parseBridgeMessage({
      protocolVersion: 1,
      type: "session-note",
      sessionId: "session-old",
      revision: "sha256:old",
      stickers: [],
    })).toMatchObject({ protocolVersion: 1, type: "session-note" });
  });
});
