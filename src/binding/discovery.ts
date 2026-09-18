import { readDiscoveryRecords, writeDiscoveryRecord, removeDiscoveryRecord } from 'dsh-obsidian-bridge-protocol/discovery';
import { type DshInstanceIdentity, type VaultIdentity } from 'dsh-obsidian-bridge-protocol/binding';
import { probeDshIdentity } from './provider.ts';

export async function discoverInstances(manualOrigin?: string): Promise<{ instances: DshInstanceIdentity[]; conflicts: number }> {
  const scan = await readDiscoveryRecords().catch(error => { if (manualOrigin) return { records: [], conflicts: [] }; throw error; });
  const instances: DshInstanceIdentity[] = [];
  for (const record of scan.records) {
    if (record.kind !== 'dsh') continue;
    try { const live = await probeDshIdentity(record.origin);
      if (live.instanceId === record.instanceId && live.profileId === record.profileId && live.bootId === record.bootId) instances.push(live);
    } catch { /* Discovery entries are hints; stale or unverified candidates stay unavailable. */ }
  }
  if (manualOrigin) {
    const live = await probeDshIdentity(manualOrigin);
    if (scan.conflicts.some(item => item.kind === 'dsh' && item.id === live.instanceId && item.profileId === live.profileId)) throw new Error('此实例有冲突的活动身份');
    if (!instances.some(item => item.instanceId === live.instanceId && item.profileId === live.profileId)) instances.push(live);
  }
  return { instances, conflicts: scan.conflicts.length };
}

export async function publishVault(identity: () => VaultIdentity, onError: (error: unknown) => void): Promise<() => Promise<void>> {
  let stopped = false, pending: Promise<void> = Promise.resolve();
  const refresh = () => {
    pending = pending.catch(() => undefined).then(async () => {
      if (stopped) return;
      const now = Date.now(); await writeDiscoveryRecord({ ...identity(), updatedAt: now, expiresAt: now + 30_000 });
    });
    return pending;
  };
  await refresh();
  const timer = setInterval(() => { void refresh().catch(onError); }, 10_000);
  return async () => { stopped = true; clearInterval(timer); await pending.catch(() => undefined); const current = identity(); await removeDiscoveryRecord(current); };
}
