import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { VaultBindingProvider, type StoredBindingState } from '../src/binding/provider.ts';
import { startBridgeServer, type RunningBridge } from '../src/bridge/server.ts';
import { createObsidianReferenceCapture } from '../src/vault/reference-source.ts';
import type { DshInstanceIdentity, ChangeVaultBindingRequest } from 'dsh-obsidian-bridge-protocol/binding';
const servers: RunningBridge[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => server.close())); });
const emptyDiscovery = async () => ({ records: [], conflicts: [] });
function identity(instanceId = 'instance-a', origin = 'http://127.0.0.1:31900'): DshInstanceIdentity { return { discoveryProtocolVersion: 1, kind: 'dsh', instanceId, profileId: 'web', bootId: randomUUID(), publisherId: randomUUID(), displayName: instanceId, origin, capabilities: ['vault-instance-binding-v1'] }; }
function change(target: DshInstanceIdentity, revision = 0): ChangeVaultBindingRequest { return { operationId: randomUUID(), expectedRevision: revision, intent: revision ? 'rebind' : 'bind', target: { instanceId: target.instanceId, profileId: target.profileId }, candidate: { origin: target.origin, bootId: target.bootId } }; }
async function start(provider: VaultBindingProvider, options: Parameters<typeof startBridgeServer>[0] = {}) { const server = await startBridgeServer({ port: 0, binding: provider, ...options }); servers.push(server); return server; }
async function request(server: RunningBridge, path: string, body?: unknown, token?: string, method = body === undefined ? 'GET' : 'POST') { return fetch(server.origin + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); }
async function controller(server: RunningBridge, provider: VaultBindingProvider, target: DshInstanceIdentity) {
  const result = await request(server, '/control/v1/handshake', { lifecycleProtocolVersion: 3, bindingProtocolVersion: 1, clientId: randomUUID(), role: 'controller', dshInstanceId: target.instanceId, profileId: target.profileId, dshBootId: target.bootId, dshOrigin: target.origin, vaultId: provider.vaultId, bindingRevision: provider.snapshot().revision });
  expect(result.status).toBe(200); return (await result.json()).token as string;
}
async function lease(server: RunningBridge, target: DshInstanceIdentity, token: string) { return request(server, '/control/v1/leases', { lifecycleProtocolVersion: 3, expectedBootId: server.identity.bootId, ttlMs: 60_000, browserOrigins: [target.origin], dshViewerUrl: target.origin + '/?token=private-viewer' }, token); }

it('serializes binding CAS and replays durable idempotency receipts after restart', async () => {
  const target = identity(); let saved: StoredBindingState | undefined;
  const persist = vi.fn(async (state: StoredBindingState) => { saved = state; });
  const provider = new VaultBindingProvider('vault', persist, undefined, async () => target, emptyDiscovery);
  const first = change(target), competing = change(target);
  const result = await Promise.allSettled([provider.change(first), provider.change(competing)]);
  expect(result.map(item => item.status)).toEqual(['fulfilled', 'rejected']); expect(persist).toHaveBeenCalledOnce();
  const restarted = new VaultBindingProvider('vault', persist, saved, async () => target, emptyDiscovery);
  expect(await restarted.change(first)).toEqual(provider.snapshot());
  await expect(restarted.change({ ...first, intent: 'rebind' })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  expect(persist).toHaveBeenCalledOnce();
});
it('does not publish binding success after persistence or identity verification fails', async () => {
  const target = identity(), provider = new VaultBindingProvider('vault', async () => { throw new Error('disk failed'); }, undefined, async () => target, emptyDiscovery);
  await expect(provider.change(change(target))).rejects.toThrow('disk failed'); expect(provider.snapshot().target).toBeNull();
  await expect(provider.change(change(identity('other')))).rejects.toMatchObject({ code: 'IDENTITY_CONFLICT' });
});
it('routes two Vaults with the same note path independently and keeps the survivor live', async () => {
  const target = identity(), opens = [vi.fn(async () => undefined), vi.fn(async () => undefined)];
  const vaults = await Promise.all(['vault-one', 'vault-two'].map(async (id, i) => {
    const provider = new VaultBindingProvider(id, async () => undefined, undefined, async () => target, emptyDiscovery); await provider.change(change(target));
    const server = await start(provider, { onOpenNote: opens[i]! }); const token = await controller(server, provider, target); return { server, token };
  }));
  for (const vault of vaults) expect((await request(vault.server, '/v1/obsidian/open-note', { protocolVersion: 1, type: 'open-note', actionId: randomUUID(), notePath: 'Notes/Same.md' }, vault.token)).status).toBe(200);
  expect((await request(vaults[0]!.server, '/v1/obsidian/open-note', { protocolVersion: 1, type: 'open-note', actionId: randomUUID(), vaultId: 'vault-two', notePath: 'Notes/Same.md' }, vaults[0]!.token)).status).toBe(409);
  expect(opens[0]).toHaveBeenCalledOnce(); expect(opens[1]).toHaveBeenCalledOnce();
  await vaults[0]!.server.close(); expect((await request(vaults[1]!.server, '/control/v1/status')).status).toBe(200);
});
it('prevents another instance from taking the Viewer and fences old tokens and jobs after rebind', async () => {
  const a = identity(), b = identity('instance-b', 'http://127.0.0.1:31901');
  const provider = new VaultBindingProvider('vault', async () => undefined, undefined, async origin => origin === a.origin ? a : b, emptyDiscovery);
  await provider.change(change(a));
  const oldRoute = provider.route(), capture = { ...createObsidianReferenceCapture({ actionId: 'old-action', referenceId: 'ref', vaultId: 'vault', notePath: 'Same.md', blockId: 'block', occurrence: 0, selectedText: 'quote', markdown: 'quote ^block\n', capturedAt: 1 }), dshInstanceId: a.instanceId };
  const surfaceId = randomUUID();
  const server = await start(provider, { referenceSurfaceId: surfaceId, jobRoute: () => oldRoute }); server.enqueue(capture);
  const tokenA = await controller(server, provider, a); expect((await lease(server, a, tokenA)).status).toBe(201);
  const tokenB = await controller(server, provider, b); expect((await lease(server, b, tokenB)).status).toBe(409);
  expect(server.activeDshViewerUrl()).toBe(a.origin + '/?token=private-viewer');
  expect((await request(server, '/control/v1/binding', change(b, 1))).status).toBe(401);
  expect((await request(server, '/control/v1/binding', change(b, 1), tokenB)).status).toBe(200);
  expect(server.activeDshViewerUrl()).toBeUndefined();
  expect((await request(server, '/v2/actions/pending', undefined, tokenA)).status).toBe(401);
  const surface = await request(server, '/v2/handshake', { clientId: 'new-surface', surfaceId, dshInstanceId: b.instanceId, vaultId: 'vault', bindingRevision: 2, profileId: 'web', bindingProtocolVersion: 1, dshBootId: b.bootId });
  const newToken = (await surface.json()).token;
  const pending = await (await request(server, '/v2/actions/pending', undefined, newToken)).json();
  expect(pending.actions).toEqual([]); expect(capture.dshInstanceId).toBe(a.instanceId); expect(provider.accepts(oldRoute)).toBe(false);
});
it('rejects a stale boot and publishes independent available ports', async () => {
  let target = identity(); const provider = new VaultBindingProvider('vault', async () => undefined, undefined, async () => target, emptyDiscovery);
  await provider.change(change(target)); const server = await start(provider); const token = await controller(server, provider, target); await lease(server, target, token);
  const old = target; target = { ...target, bootId: randomUUID() };
  expect((await lease(server, old, token)).status).toBe(409);
  const fresh = await controller(server, provider, target); expect((await lease(server, target, fresh)).status).toBe(201);
  expect((await request(server, '/v2/handshake', { clientId: 'old-viewer', bindingProtocolVersion: 1, dshInstanceId: target.instanceId, vaultId: 'vault', bindingRevision: 1, profileId: 'web', dshBootId: old.bootId })).status).toBe(409);
  const second = await start(provider, { port: Number(new URL(server.origin).port), autoPort: true }); expect(second.origin).not.toBe(server.origin);
});

it('never advertises a browser-forbidden preferred port when auto selection is enabled', async () => {
  const target = identity(), provider = new VaultBindingProvider('vault', async () => undefined, undefined, async () => target, emptyDiscovery);
  const server = await start(provider, { port: 6000, autoPort: true });
  expect(new URL(server.origin).port).not.toBe('6000');
  expect((await request(server, '/control/v1/status')).status).toBe(200);
});
it('replays an authenticated unbind after its token was invalidated by the first success', async () => {
  const target = identity(), provider = new VaultBindingProvider('vault', async () => undefined, undefined, async () => target, emptyDiscovery);
  await provider.change(change(target)); const server = await start(provider);
  const input = { operationId: randomUUID(), expectedRevision: 1, intent: 'unbind', target: null };
  const first = await request(server, '/control/v1/binding', input, await controller(server, provider, target));
  expect(first.status).toBe(200);
  const replay = await request(server, '/control/v1/binding', input, await controller(server, provider, target));
  expect(replay.status).toBe(200); expect(await replay.json()).toEqual(await first.json());
});
