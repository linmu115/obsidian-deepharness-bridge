import type { KnowledgeSyncState, LocalKnowledgeLink, VaultKnowledgeStore } from './knowledge-store.ts';

/** Progress follows acknowledged items; a failed write is retried after reload. */
export async function syncKnowledgeBatch(store: VaultKnowledgeStore, instanceId: string, sync: (link: LocalKnowledgeLink) => Promise<void>, stopped: () => boolean = () => false, maxItems = 60): Promise<{ done: boolean; count: number }> {
  let state = await store.dispatch('sync-state', {}, instanceId) as KnowledgeSyncState;
  if (!state.pending) return { done: true, count: 0 };
  let count = 0;
  while (count < maxItems && !stopped()) {
    const page = await store.dispatch('links', { after: state.after }, instanceId) as { items: LocalKnowledgeLink[]; nextCursor: string | null };
    for (const link of page.items) {
      if (count >= maxItems || stopped()) return { done: false, count };
      await sync(link);
      state = await store.dispatch('sync-progress', { expectedAfter: state.after, scanGeneration: state.scanGeneration, after: link.objectId }, instanceId) as KnowledgeSyncState;
      count++;
    }
    if (!page.nextCursor) {
      state = await store.dispatch('sync-progress', { expectedAfter: state.after, scanGeneration: state.scanGeneration, complete: true }, instanceId) as KnowledgeSyncState;
      return { done: !state.pending, count };
    }
  }
  return { done: false, count };
}
