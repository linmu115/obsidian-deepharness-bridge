import { canonicalSha256, type DeepLinkAction, type ObsidianReferenceCaptureV2, type ReferenceClaimV2, type ReferenceDeleteRequestV2 } from "../protocol.ts";

export type QueuedBridgeMessage = DeepLinkAction | ObsidianReferenceCaptureV2 | ReferenceDeleteRequestV2;
export interface QueuedAction { cursor: number; message: QueuedBridgeMessage }
interface QueueEntry extends QueuedAction { acknowledgedBy: Set<string> }
interface CompletedAction {
  cursor: number;
  referenceId?: string;
  claim?: ReferenceClaimV2;
  cancelled?: boolean;
}
export type ClaimResult = "created" | "identical" | "conflict" | "missing" | "cancelled";

export class ClientActionQueue {
  #cursor = 0;
  readonly #entries = new Map<string, QueueEntry>();
  readonly #completed = new Map<string, CompletedAction>();
  readonly #referenceActions = new Map<string, Set<string>>();
  #navigationId: string | undefined;

  // Only finished, compact receipts are bounded. Active captures and deletion
  // outbox deliveries are never evicted; they remain recoverable from disk.
  constructor(private readonly completedLimit = 2048) {}

  get diagnostics() { return { activeActions: this.#entries.size, completedActions: this.#completed.size }; }

  private complete(id: string, receipt: CompletedAction): void {
    this.#entries.delete(id);
    if (this.#navigationId === id) this.#navigationId = undefined;
    this.#completed.set(id, receipt);
    while (this.#completed.size > this.completedLimit) {
      const oldest = this.#completed.keys().next().value!;
      const previous = this.#completed.get(oldest)!;
      this.#completed.delete(oldest);
      if (previous.referenceId) {
        const actions = this.#referenceActions.get(previous.referenceId);
        actions?.delete(oldest);
        if (actions?.size === 0) this.#referenceActions.delete(previous.referenceId);
      }
    }
  }

  enqueue(message: QueuedBridgeMessage): number {
    const id = message.actionId;
    const existing = this.#entries.get(id) ?? this.#completed.get(id);
    if (existing) return existing.cursor;
    if (message.type === "deep-link" && message.referenceId
      && [...(this.#referenceActions.get(message.referenceId) ?? [])].some((related) => this.#completed.get(related)?.cancelled)) {
      return this.#cursor;
    }
    if (message.type === "deep-link" && this.#navigationId) {
      const previous = this.#entries.get(this.#navigationId)!;
      this.complete(this.#navigationId, { cursor: previous.cursor });
    }
    const cursor = ++this.#cursor;
    this.#entries.set(id, { cursor, message, acknowledgedBy: new Set() });
    if (message.type === "reference-capture") {
      const actions = this.#referenceActions.get(message.referenceId) ?? new Set<string>();
      actions.add(id);
      this.#referenceActions.set(message.referenceId, actions);
    }
    if (message.type === "deep-link") this.#navigationId = id;
    return cursor;
  }

  pending(clientId: string, after: number, accepts: (message: QueuedBridgeMessage) => boolean = () => true) {
    const actions: QueuedAction[] = [];
    for (const entry of this.#entries.values()) {
      if (entry.cursor > after && !entry.acknowledgedBy.has(clientId) && accepts(entry.message)) {
        actions.push({ cursor: entry.cursor, message: entry.message });
      }
    }
    return { cursor: this.#cursor, actions };
  }

  acknowledge(clientId: string, id: string): boolean {
    const entry = this.#entries.get(id);
    if (!entry) return false;
    if (entry.message.type === "reference-capture") entry.acknowledgedBy.add(clientId);
    else this.complete(id, { cursor: entry.cursor });
    return true;
  }

  cancelReferenceDeepLinks(referenceId: string): number {
    if (!this.#navigationId) return 0;
    const entry = this.#entries.get(this.#navigationId)!;
    if (entry.message.type !== "deep-link" || entry.message.referenceId !== referenceId) return 0;
    this.complete(this.#navigationId, { cursor: entry.cursor, cancelled: true });
    return 1;
  }

  cancelReference(referenceId: string): number {
    let removed = this.cancelReferenceDeepLinks(referenceId);
    for (const id of [...(this.#referenceActions.get(referenceId) ?? [])]) {
      const entry = this.#entries.get(id) ?? this.#completed.get(id);
      if (!entry) continue;
      if (this.#entries.has(id)) removed += 1;
      this.complete(id, { cursor: entry.cursor, referenceId, cancelled: true });
    }
    return removed;
  }

  message(id: string): QueuedBridgeMessage | undefined { return this.#entries.get(id)?.message; }

  checkClaim(id: string, claim: ReferenceClaimV2): ClaimResult {
    const completed = this.#completed.get(id);
    if (completed?.cancelled) return "cancelled";
    if (completed) {
      return completed.claim && canonicalSha256(completed.claim) === canonicalSha256(claim) ? "identical" : "conflict";
    }
    const entry = this.#entries.get(id);
    if (!entry) return "missing";
    for (const related of this.#referenceActions.get(claim.referenceId) ?? []) {
      const previous = this.#completed.get(related);
      if (previous?.cancelled) return "cancelled";
      if (previous?.claim && canonicalSha256(previous.claim) !== canonicalSha256(claim)) return "conflict";
    }
    return entry.message.type === "reference-capture" && entry.message.referenceId === claim.referenceId ? "created" : "conflict";
  }

  claim(id: string, claim: ReferenceClaimV2): ClaimResult {
    const result = this.checkClaim(id, claim);
    if (result === "created") {
      this.complete(id, { cursor: this.#entries.get(id)!.cursor, referenceId: claim.referenceId, claim });
    }
    return result;
  }
}
