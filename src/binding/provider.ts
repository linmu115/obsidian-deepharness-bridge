import type { VaultBindingGrant } from "@linmu/dsh-session-contracts";
import {
  BINDING_CAPABILITY, DSH_IDENTITY_PATH, changeVaultBindingRequestSchema, discoveryOriginSchema,
  dshInstanceIdentitySchema, vaultBindingSnapshotSchema,
  type BindingTarget, type BoundOperationRoute, type ChangeVaultBindingRequest, type DshInstanceIdentity, type VaultBindingSnapshot,
} from 'dsh-obsidian-bridge-protocol/binding';
import { readDiscoveryRecords } from 'dsh-obsidian-bridge-protocol/discovery';
import { SerialWork } from '../serial-work.ts';
import { get } from 'node:http';

export interface StoredBindingState {
  snapshot: VaultBindingSnapshot;
  receipts: Record<string, { request: string; result: VaultBindingSnapshot; owner?: BindingTarget }>;
}
export function bindingError(code: string, message: string): Error & { code: string } { return Object.assign(new Error(message), { code }); }
/** Desktop transport avoids renderer CORS without weakening the loopback identity boundary. */
function readDesktopIdentity(url: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const request = get(url, response => {
      if (response.statusCode !== 200) { response.resume(); request.destroy(bindingError('INSTANCE_OFFLINE', '实例未运行或尚未安装新版 Bridge')); return; }
      if (Number(response.headers['content-length']) > 65_536) { request.destroy(bindingError('IDENTITY_CONFLICT', '实例身份响应过大')); return; }
      const chunks: Buffer[] = []; let length = 0;
      response.on('data', (chunk: Buffer) => { length += chunk.length; if (length > 65_536) request.destroy(bindingError('IDENTITY_CONFLICT', '实例身份响应过大')); else chunks.push(chunk); });
      response.on('error', error => { clearTimeout(timer); reject(error); });
      response.on('end', () => { clearTimeout(timer); resolve(Buffer.concat(chunks)); });
    });
    // Total deadline, not an idle timeout: a slow drip must not keep the probe alive.
    const timer = setTimeout(() => request.destroy(bindingError('INSTANCE_OFFLINE', '实例身份探测超时')), 5_000);
    request.on('error', error => { clearTimeout(timer); reject(error); });
    // node:http never follows redirects; only HTTP 200 is accepted above.
  });
}
export async function probeDshIdentity(origin: string, fetchImpl?: typeof fetch): Promise<DshInstanceIdentity> {
  const normalized = discoveryOriginSchema.parse(origin);
  let payload: Buffer;
  if (!fetchImpl) payload = await readDesktopIdentity(normalized + DSH_IDENTITY_PATH);
  else {
  const response = await fetchImpl(normalized + DSH_IDENTITY_PATH, { redirect: 'error', signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw bindingError('INSTANCE_OFFLINE', '实例未运行或尚未安装新版 Bridge');
  if (Number(response.headers.get('content-length')) > 65_536) throw bindingError('IDENTITY_CONFLICT', '实例身份响应过大');
  const reader = response.body?.getReader(); if (!reader) throw bindingError('INSTANCE_OFFLINE', '实例未返回身份');
  const chunks: Uint8Array[] = []; let length = 0;
  try { for (;;) { const part = await reader.read(); if (part.done) break; length += part.value.length;
    if (length > 65_536) throw bindingError('IDENTITY_CONFLICT', '实例身份响应过大'); chunks.push(part.value); } }
  finally { await reader.cancel().catch(() => undefined); }
  payload = Buffer.concat(chunks);
  }
  const identity = dshInstanceIdentitySchema.parse(JSON.parse(payload.toString('utf8')));
  if (identity.origin !== normalized || !identity.capabilities.includes(BINDING_CAPABILITY)) throw bindingError('IDENTITY_CONFLICT', '实例身份或绑定能力不匹配');
  return identity;
}

/** One durable writer for both the settings UI and authenticated control requests. */
export class VaultBindingProvider {
  private state: StoredBindingState;
  private readonly work = new SerialWork();
  private readonly listeners = new Set<() => void>();
  private readonly verified = new Map<string, DshInstanceIdentity>();
  constructor(readonly vaultId: string, private readonly persist: (state: StoredBindingState) => Promise<void>, initial?: StoredBindingState,
    private readonly probe = probeDshIdentity, private readonly discover = readDiscoveryRecords, private readonly now = Date.now) {
    this.state = initial ?? { snapshot: { bindingProtocolVersion: 1, vaultId, revision: 0, target: null, updatedAt: now() }, receipts: {} };
    this.state = { snapshot: vaultBindingSnapshotSchema.parse(this.state.snapshot), receipts: this.state.receipts };
    if (this.state.snapshot.vaultId !== vaultId) throw bindingError('IDENTITY_CONFLICT', 'Vault 绑定身份不匹配');
  }
  snapshot(): VaultBindingSnapshot { return structuredClone(this.state.snapshot); }
  operationOwner(operationId: string): BindingTarget | undefined { return Object.hasOwn(this.state.receipts, operationId) ? this.state.receipts[operationId]?.owner : undefined; }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  currentIdentity(): DshInstanceIdentity | undefined { const target = this.state.snapshot.target; return target ? this.verified.get(JSON.stringify(target)) : undefined; }
  supports(capability: string): boolean { return !!this.currentIdentity()?.capabilities.includes(capability); }
  async assertUniqueVault(): Promise<void> {
    const discovered = await this.discover().catch(() => ({ records: [], conflicts: [] }));
    if (discovered.conflicts.some(item => item.kind === 'vault' && item.id === this.vaultId)) throw bindingError('IDENTITY_CONFLICT', '此 Vault 身份被多个活动副本使用，已暂停操作');
  }
  async verify(candidate: { origin: string; bootId: string }, target: BindingTarget): Promise<DshInstanceIdentity> {
    const discovered = await this.discover().catch(() => ({ records: [], conflicts: [] }));
    if (discovered.conflicts.some(item => item.kind === 'dsh' && item.id === target.instanceId && item.profileId === target.profileId))
      throw bindingError('IDENTITY_CONFLICT', '此实例有多个活动身份，已暂停连接');
    const known = discovered.records.find(item => item.kind === 'dsh' && item.instanceId === target.instanceId && item.profileId === target.profileId);
    if (known && (known.origin !== candidate.origin || known.bootId !== candidate.bootId)) throw bindingError('BOOT_MISMATCH', '实例已重启，请刷新连接');
    const identity = await this.probe(candidate.origin);
    if (identity.instanceId !== target.instanceId || identity.profileId !== target.profileId || identity.bootId !== candidate.bootId)
      throw bindingError('IDENTITY_CONFLICT', '候选地址当前属于其他实例或运行代次');
    this.verified.set(JSON.stringify({ instanceId: identity.instanceId, profileId: identity.profileId }), identity);
    return identity;
  }
  change(input: ChangeVaultBindingRequest): Promise<VaultBindingSnapshot> {
    return this.apply(changeVaultBindingRequestSchema.parse(input));
  }
  /** Called only after the local Engine signature and Vault boot have been verified. No controller identity is established. */
  changeManaged(grant: VaultBindingGrant): Promise<VaultBindingSnapshot> {
    const owner = { instanceId: grant.instanceId, profileId: grant.profileId };
    return this.apply({ operationId: grant.operationId, expectedRevision: grant.expectedRevision, intent: grant.intent,
      target: grant.intent === "bind" ? owner : null }, owner);
  }
  private apply(request: ChangeVaultBindingRequest, managerOwner?: BindingTarget): Promise<VaultBindingSnapshot> {
    return this.work.run(async () => {
      const canonical = JSON.stringify(managerOwner ? { source: "maintenance-v1", owner: managerOwner, request } : request);
      const receipt = Object.hasOwn(this.state.receipts, request.operationId) ? this.state.receipts[request.operationId] : undefined;
      if (receipt) {
        if (receipt.request !== canonical) throw bindingError('IDEMPOTENCY_CONFLICT', '操作标识已用于另一绑定请求');
        return structuredClone(receipt.result);
      }
      const current = this.state.snapshot;
      if (request.expectedRevision !== current.revision) throw bindingError('BINDING_REVISION_CONFLICT', '绑定已在其他入口修改，请刷新后重试');
      if (request.intent === 'bind' && current.target !== null) throw bindingError('BINDING_REVISION_CONFLICT', '已有绑定，请明确选择改绑');
      if (request.intent === 'rebind' && current.target === null) throw bindingError('BINDING_REVISION_CONFLICT', '当前尚未绑定，请选择绑定');
      if (managerOwner && request.intent === "unbind" && (current.target?.instanceId !== managerOwner.instanceId || current.target.profileId !== managerOwner.profileId))
        throw bindingError("BINDING_REVISION_CONFLICT", "Vault 当前不属于此实例，不能解绑");
      if (request.target && !managerOwner) await this.verify(request.candidate!, request.target);
      await this.assertUniqueVault();
      const snapshot: VaultBindingSnapshot = { bindingProtocolVersion: 1, vaultId: this.vaultId, revision: current.revision + 1,
        target: request.target, updatedAt: this.now(), lastOperationId: request.operationId };
      const owner = request.target ?? current.target;
      const next = { snapshot, receipts: { ...this.state.receipts, [request.operationId]: { request: canonical, result: snapshot, ...(owner ? { owner } : {}) } } };
      await this.persist(structuredClone(next));
      this.state = next;
      if (managerOwner) this.verified.clear();
      for (const listener of this.listeners) { try { listener(); } catch { /* Durable result is not rolled back by a UI observer. */ } }
      return structuredClone(snapshot);
    });
  }
  route(): BoundOperationRoute {
    const snapshot = this.state.snapshot;
    if (!snapshot.target) throw bindingError('BINDING_REQUIRED', '请先在 Bridge 设置中为此 Vault 选择实例');
    return { vaultId: this.vaultId, ...snapshot.target, bindingRevision: snapshot.revision };
  }
  accepts(route: BoundOperationRoute | undefined): boolean {
    const current = this.state.snapshot;
    return !!route && route.vaultId === this.vaultId && route.bindingRevision === current.revision
      && route.instanceId === current.target?.instanceId && route.profileId === current.target?.profileId;
  }
}
