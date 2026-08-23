import type { DeepLinkAction, PendingCitation } from "../protocol.ts";

export type QueuedBridgeMessage = DeepLinkAction | PendingCitation;

export interface QueuedAction {
  cursor: number;
  message: QueuedBridgeMessage;
}

interface QueueEntry extends QueuedAction {
  acknowledgedBy: Set<string>;
}

function messageId(message: QueuedBridgeMessage): string {
  return message.type === "pending-citation" ? message.citationId : message.actionId;
}

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

  pending(clientId: string, after: number): { cursor: number; actions: QueuedAction[] } {
    return {
      cursor: this.#cursor,
      actions: this.#entries
        .filter((entry) => entry.cursor > after && !entry.acknowledgedBy.has(clientId))
        .map(({ cursor, message }) => ({ cursor, message })),
    };
  }

  acknowledge(clientId: string, id: string): boolean {
    const entry = this.#entries.find((candidate) => messageId(candidate.message) === id);
    if (!entry) return false;
    entry.acknowledgedBy.add(clientId);
    return true;
  }
}
