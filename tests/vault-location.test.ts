import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { get, type IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { VaultIdentity } from 'dsh-obsidian-bridge-protocol/binding';
import { startBridgeServer, type RunningBridge, type BridgeServerOptions } from '../src/bridge/server.ts';
import { canonicalVaultRoot, isLocalLocationCaller, VAULT_LOCATION_PATH } from '../src/bridge/vault-location.ts';

const servers: RunningBridge[] = [];
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => server.close()));
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});
async function temporaryDirectory() {
  const path = await mkdtemp(join(tmpdir(), 'companion-location-'));
  directories.push(path); return path;
}
async function start(overrides: BridgeServerOptions = {}) {
  const publisherId = randomUUID();
  const server: RunningBridge = await startBridgeServer({ port: 0, allowedDshOrigins: ['http://127.0.0.1:31900'],
    discoveryIdentity: (): VaultIdentity => ({ discoveryProtocolVersion: 1, kind: 'vault', vaultId: 'synthetic-vault', publisherId,
      bootId: server.identity.bootId, displayName: 'synthetic', origin: server.origin, capabilities: [],
      binding: { bindingProtocolVersion: 1, vaultId: 'synthetic-vault', revision: 0, target: null, updatedAt: 0 } }), ...overrides });
  servers.push(server); return server;
}

it('returns canonical directory proof with the same live identity and keeps public identity path-free', async () => {
  const directory = await temporaryDirectory();
  const alias = directory + '-alias'; directories.push(alias);
  await symlink(directory, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const server = await start({ vaultRoot: () => canonicalVaultRoot({ getBasePath: () => alias }) });
  const publicIdentity = await (await fetch(server.origin + '/discovery/v1/identity')).json();
  const response = await fetch(server.origin + VAULT_LOCATION_PATH);
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(response.headers.get('access-control-allow-origin')).toBeNull();
  expect(await response.json()).toEqual({ locationProtocolVersion: 1, vaultId: publicIdentity.vaultId,
    publisherId: publicIdentity.publisherId, bootId: publicIdentity.bootId, origin: publicIdentity.origin, vaultRoot: await realpath(directory) });
  expect(publicIdentity).not.toHaveProperty('vaultRoot');
  expect(publicIdentity).not.toHaveProperty('locationProtocolVersion');
});

it.each([undefined, { getBasePath: () => undefined }, { getBasePath: () => '' }, { getBasePath: () => 'relative-path' }])(
  'rejects unknown or relative adapter roots without falling back to cwd: %o', async adapter => {
    await expect(canonicalVaultRoot(adapter)).rejects.toThrow('Vault location is unavailable');
  });
it('sanitizes missing directories, files, and thrown filesystem details', async () => {
  const directory = await temporaryDirectory();
  const file = join(directory, 'not-a-directory'); await writeFile(file, 'synthetic');
  for (const path of [file, join(directory, 'missing')]) {
    await expect(canonicalVaultRoot({ getBasePath: () => path })).rejects.toThrow(/^Vault location is unavailable$/);
  }
  const server = await start({ vaultRoot: async () => { throw new Error(directory + ' secret-credential'); } });
  const response = await fetch(server.origin + VAULT_LOCATION_PATH);
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: 'Vault location is unavailable', code: 'VAULT_LOCATION_UNAVAILABLE' });
});

it('rejects browser Origin, preflight, cross-site and forged Host before resolving any path', async () => {
  const root = vi.fn(async () => '/synthetic');
  const server = await start({ vaultRoot: root });
  for (const headers of [{ origin: 'http://127.0.0.1:31900' }, { origin: 'https://example.com' }, { origin: '' },
    { 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-site': 'same-origin' }]) {
    const response = await fetch(server.origin + VAULT_LOCATION_PATH, { headers });
    expect(response.status, JSON.stringify(headers)).toBe(403);
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  }
  const preflight = await fetch(server.origin + VAULT_LOCATION_PATH, { method: 'OPTIONS', headers: { origin: 'http://127.0.0.1:31900' } });
  expect(preflight.status).toBe(403);
  expect(preflight.headers.get('access-control-allow-origin')).toBeNull();
  expect((await fetch(server.origin + VAULT_LOCATION_PATH, { method: 'POST' })).status).toBe(405);
  const forgedHostStatus = await new Promise<number | undefined>((resolve, reject) => {
    get(server.origin + VAULT_LOCATION_PATH, { headers: { host: 'attacker.example' } }, response => {
      response.resume(); response.on('end', () => resolve(response.statusCode));
    }).on('error', reject);
  });
  expect(forgedHostStatus).toBe(403);
  expect(root).not.toHaveBeenCalled();
});

it.each(['192.0.2.1', '::ffff:192.0.2.1', undefined])('rejects non-loopback socket %s even with forwarded loopback headers', address => {
  const request = { headers: { host: '127.0.0.1:12345', 'x-forwarded-for': '127.0.0.1' }, socket: { remoteAddress: address } } as unknown as Pick<IncomingMessage, 'headers' | 'socket'>;
  expect(isLocalLocationCaller(request, 'http://127.0.0.1:12345')).toBe(false);
});

it('fails safely without a root provider or with stale published identity', async () => {
  const server = await start();
  expect((await fetch(server.origin + VAULT_LOCATION_PATH)).status).toBe(503);
  const stale = await start({ vaultRoot: async () => '/synthetic', discoveryIdentity: () => ({ bootId: randomUUID() }) as VaultIdentity });
  expect((await fetch(stale.origin + VAULT_LOCATION_PATH)).status).toBe(503);
});

it('does not return a path when shutdown starts during filesystem resolution', async () => {
  let finish!: (root: string) => void;
  let entered!: () => void;
  const resolving = new Promise<void>(resolve => { entered = resolve; });
  const root = new Promise<string>(resolve => { finish = resolve; });
  const server = await start({ vaultRoot: () => { entered(); return root; } });
  const pending = fetch(server.origin + VAULT_LOCATION_PATH);
  await resolving;
  const closed = server.close();
  finish('/private-synthetic-path');
  const response = await pending;
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: 'Vault location is unavailable', code: 'VAULT_LOCATION_UNAVAILABLE' });
  await closed;
});
