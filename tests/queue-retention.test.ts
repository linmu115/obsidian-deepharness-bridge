import { describe, expect, it } from "vitest";
import { ClientActionQueue } from "../src/bridge/queue.ts";
import { createObsidianReferenceCapture } from "../src/vault/reference-source.ts";

const capture = (id: string) => createObsidianReferenceCapture({
  actionId: `action-${id}`, referenceId: id, vaultId: "synthetic", notePath: "note.md",
  blockId: "block-1", occurrence: 0, selectedText: "quote", markdown: "quote ^block-1\n", capturedAt: 1,
});
const claim = (id: string) => ({ annotationProtocolVersion: 2, type: "reference-claim", referenceId: id, profileId: "web", sessionId: "session", setId: "set" }) as const;

describe("bounded delivery history", () => {
  it("keeps pending work while discarding old finished capture snapshots", () => {
    const queue = new ClientActionQueue();
    queue.enqueue(capture("pending"));
    queue.enqueue({ annotationProtocolVersion: 2, type: "reference-delete-request", actionId: "delete", referenceId: "deleting", profileId: "web", sessionId: "session", setId: "set", requestedAt: 1 });
    for (let i = 0; i < 10_000; i += 1) {
      const id = String(i); queue.enqueue(capture(id)); expect(queue.claim(`action-${id}`, claim(id))).toBe("created");
    }
    expect(queue.diagnostics).toEqual({ activeActions: 2, completedActions: 2048 });
    expect(queue.pending("new-client", 0).actions.map((entry) => entry.message.actionId)).toEqual(["action-pending", "delete"]);
    expect(queue.message("action-9999")).toBeUndefined();
    expect(queue.claim("action-9999", claim("9999"))).toBe("identical");
    queue.cancelReference("9999");
    expect(queue.claim("action-9999", claim("9999"))).toBe("cancelled");
    queue.enqueue(capture("9999"));
    expect(queue.diagnostics.activeActions).toBe(2);
  });
});
