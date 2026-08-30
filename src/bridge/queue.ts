import type { DeepLinkAction, ObsidianReferenceCaptureV2, ReferenceClaimV2, ReferenceDeleteRequestV2 } from "../protocol.ts";

export type QueuedBridgeMessage = DeepLinkAction | ObsidianReferenceCaptureV2 | ReferenceDeleteRequestV2;

export interface QueuedAction {
  cursor: number;
  message: QueuedBridgeMessage;
}

interface QueueEntry extends QueuedAction {
  acknowledgedBy: Set<string>;
  claim?: ReferenceClaimV2;
}

function messageId(message: QueuedBridgeMessage): string { return message.actionId; }

export class ClientActionQueue {
  #cursor = 0;
  readonly #entries: QueueEntry[] = [];

  enqueue(message: QueuedBridgeMessage): number {
    const id = messageId(message);
    const existing = this.#entries.find((entry) => messageId(entry.message) === id);
    if (existing) return existing.cursor;
    const cursor = ++this.#cursor;
    this.#entries.push({ cursor, message, acknowledgedBy: new Set() });
    return cursor;
  }

  pending(
    clientId: string,
    after: number,
    accepts: (message: QueuedBridgeMessage) => boolean = () => true,
  ): { cursor: number; actions: QueuedAction[] } {
    return {
      cursor: this.#cursor,
      actions: this.#entries
        .filter((entry) => (
          entry.cursor > after
          && entry.claim === undefined
          && !entry.acknowledgedBy.has(clientId)
          && accepts(entry.message)
        ))
        .map(({ cursor, message }) => ({ cursor, message })),
    };
  }

  acknowledge(clientId: string, id: string): boolean {
    const index = this.#entries.findIndex((candidate) => messageId(candidate.message) === id);
    if (index < 0) return false;
    const entry = this.#entries[index]!;
    // Navigation and deletion are one-shot commands. Once their owning
    // consumer completes them, remove them so a freshly mounted DSH client
    // cannot replay historical UI side effects under a new client ID.
    if (entry.message.type === "deep-link" || entry.message.type === "reference-delete-request") {
      this.#entries.splice(index, 1);
      return true;
    }
    entry.acknowledgedBy.add(clientId);
    return true;
  }

  cancelReferenceDeepLinks(referenceId: string): number {
    let removed = 0;
    for (let index = this.#entries.length - 1; index >= 0; index -= 1) {
      const message = this.#entries[index]!.message;
      if (message.type !== "deep-link" || message.referenceId !== referenceId) continue;
      this.#entries.splice(index, 1);
      removed += 1;
    }
    return removed;
  }

  message(id: string): QueuedBridgeMessage | undefined {
    return this.#entries.find((entry) => messageId(entry.message) === id)?.message;
  }

  claim(id: string, claim: ReferenceClaimV2): "created" | "identical" | "conflict" | "missing" {
    const entry = this.#entries.find((candidate) => messageId(candidate.message) === id);
    if (!entry) return "missing";
    if (entry.message.type !== "reference-capture" || entry.message.referenceId !== claim.referenceId) return "conflict";
    if (entry.claim !== undefined) return JSON.stringify(entry.claim) === JSON.stringify(claim) ? "identical" : "conflict";
    entry.claim = claim;
    return "created";
  }
}
