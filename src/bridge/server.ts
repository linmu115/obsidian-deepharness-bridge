import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { z } from "zod";
import {
  BRIDGE_LIFECYCLE_PROTOCOL_VERSION,
  acquireBridgeLeaseRequestSchema,
  bridgeControlHandshakeRequestSchema,
  bridgeLeaseSchema,
  bridgeStatusSchema,
  drainBridgeRequestSchema,
  renewBridgeLeaseRequestSchema,
  resumeBridgeRequestSchema,
  type BridgeClientRole,
  type BridgeLease,
  type BridgeLifecycleState,
  type BridgeStatus,
} from "dsh-obsidian-bridge-protocol";

import {
  ANNOTATION_PROTOCOL_VERSION,
  BacklinkCommitV2Schema,
  ObsidianReferenceCaptureV2Schema,
  ReferenceClaimV2Schema,
  ReferenceDiscardV2Schema,
  ReferenceDeleteCommitV2Schema,
  ReferenceDeleteRequestV2Schema,
  ReferenceRefreshRequestV2Schema,
  ReferenceRefreshResultV2Schema,
  STICKER_PROTOCOL_VERSION,
  openNoteActionSchema,
  parseBridgeMessage,
  PROTOCOL_VERSION,
  sessionNoteDocumentSchema,
  stickerBacklinkSchema,
  stickerBacklinkDeleteResultSchema,
  stickerBacklinkTargetSchema,
  type OpenNoteAction,
  type BacklinkCommitV2,
  type BacklinkReceiptV2,
  type ReferenceClaimV2,
  type ObsidianReferenceCaptureV2,
  type ReferenceDiscardV2,
  type ReferenceDeleteCommitV2,
  type ReferenceRefreshRequestV2,
  type ReferenceRefreshResultV2,
  type SessionNoteDocument,
  type StickerBacklink,
  type StickerBacklinkDeleteResult,
  type StickerBacklinkTarget,
} from "../protocol.ts";
import {
  DEFAULT_BRIDGE_PORT,
  DEFAULT_MAX_BODY_BYTES,
  DEFAULT_TOKEN_TTL_MS,
  normalizeLoopbackOrigin,
  validateBridgePort,
} from "../settings.ts";
import { ClientActionQueue, type QueuedBridgeMessage } from "./queue.ts";
import { KeyedSerialWork } from "../serial-work.ts";
import { BINDING_CAPABILITY, VAULT_BINDING_PATH, VAULT_IDENTITY_PATH, changeVaultBindingRequestSchema, type BoundOperationRoute, type VaultIdentity } from 'dsh-obsidian-bridge-protocol/binding';
import type { VaultBindingProvider } from '../binding/provider.ts';
import { isLocalLocationCaller, VAULT_LOCATION_PATH } from './vault-location.ts';

interface TokenRecord {
  bindingRevision?: number;
  profileId?: string;
  dshBootId?: string;
  dshOrigin?: string;
  clientId: string;
  role: BridgeClientRole;
  surfaceId?: string;
  dshInstanceId?: string;
  origin: string;
  expiresAt: number;
  lastSeenAt?: number;
}

const LOCAL_HOST_CALLER = "local-host";

export interface SaveSessionNoteRequest {
  document: SessionNoteDocument;
  expectedRevision: string;
}

export interface BridgeServerOptions {
  binding?: VaultBindingProvider;
  discoveryIdentity?: () => VaultIdentity;
  vaultRoot?: () => Promise<string>;
  jobRoute?: (actionId: string) => BoundOperationRoute | undefined;
  autoPort?: boolean;
  onControllerReady?: () => void;
  onKnowledge?: (operation: string, input: Record<string, unknown>, instanceId: string) => Promise<unknown>;
  port?: number;
  allowedDshOrigins?: string[];
  tokenTtlMs?: number;
  maxBodyBytes?: number;
  now?: () => number;
  instanceId?: string;
  bridgeVersion?: string;
  /** Stable identity of the Web Viewer opened by this Obsidian vault. */
  referenceSurfaceId?: string;
  onOpenNote?: (action: OpenNoteAction) => Promise<void>;
  onReadSessionNote?: (sessionId: string) => Promise<SessionNoteDocument | null>;
  onSaveSessionNote?: (request: SaveSessionNoteRequest) => Promise<{ revision: string }>;
  onListStickerBacklinks?: (target: StickerBacklinkTarget) => Promise<StickerBacklink[]>;
  onDeleteStickerBacklinks?: (target: StickerBacklinkTarget) => Promise<StickerBacklinkDeleteResult>;
  referenceInstanceId?: (referenceId: string) => string | undefined | Promise<string | undefined>;
  onClaimReference?: (claim: ReferenceClaimV2) => Promise<void>;
  onRefreshReference?: (request: ReferenceRefreshRequestV2) => Promise<ReferenceRefreshResultV2>;
  onDiscardReference?: (request: ReferenceDiscardV2) => Promise<void>;
  onCommitBacklink?: (commit: BacklinkCommitV2) => Promise<BacklinkReceiptV2>;
  onDeleteCommittedReference?: (commit: ReferenceDeleteCommitV2) => Promise<void>;
}

export interface RunningBridge {
  readonly origin: string;
  readonly tokenExpiresAt: number | null;
  readonly identity: Pick<BridgeStatus, "instanceId" | "bootId" | "bridgeVersion" | "startedAt">;
  status(): BridgeStatus;
  activeDshViewerUrl(): string | undefined;
  prepareCapture(capture: ObsidianReferenceCaptureV2): ObsidianReferenceCaptureV2;
  enqueue(message: QueuedBridgeMessage): number;
  cancelReference(referenceId: string): number;
  restoreReferenceClaim(capture: ObsidianReferenceCaptureV2, claim: ReferenceClaimV2): void;
  diagnostics(): { activeActions: number; completedActions: number; connectedClients: number };
  close(): Promise<void>;
}

class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly code?: string) {
    super(message);
  }
}

const handshakeSchema = z.object({
  bindingProtocolVersion: z.literal(1).optional(),
  dshBootId: z.string().uuid().optional(),
  vaultId: z.string().min(1).optional(),
  bindingRevision: z.number().int().nonnegative().optional(),
  profileId: z.string().min(1).optional(),
  clientId: z.string().min(1).max(128),
  surfaceId: z.string().uuid().optional(),
  dshInstanceId: z.string().min(1).max(256).optional(),
});
const BRIDGE_CAPABILITIES = [
  "reference-capture-v2",
  "reference-refresh",
  "backlink-commit-v2",
  "reference-delete-v2",
  "targeted-deep-link-v1",
  "instance-routing-v1",
  "sticker-backlink-delete-v1",
] as const;

function captureReceiver(authentication: TokenRecord, referenceSurfaceId: string | undefined): boolean {
  return referenceSurfaceId !== undefined && authentication.role === "surface" && authentication.surfaceId === referenceSurfaceId;
}

function visibleTo(authentication: TokenRecord, message: QueuedBridgeMessage, referenceSurfaceId?: string): boolean {
  if ("dshInstanceId" in message && message.dshInstanceId !== undefined && message.dshInstanceId !== authentication.dshInstanceId) return false;
  if (message.type === "reference-capture") return captureReceiver(authentication, referenceSurfaceId);
  return message.type !== "deep-link"
    || message.targetSurfaceId === undefined
    || message.targetSurfaceId === authentication.surfaceId;
}
const saveSessionNoteSchema = z.object({
  document: sessionNoteDocumentSchema,
  expectedRevision: z.string().min(1),
});

function json(
  response: ServerResponse,
  status: number,
  value: unknown,
  allowedOrigin?: string,
): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  if (allowedOrigin) {
    response.setHeader("access-control-allow-origin", allowedOrigin);
    response.setHeader("vary", "Origin");
  }
  response.end(`${JSON.stringify(value)}\n`);
}

function errorPayload(error: unknown): { error: string; code?: string } {
  const message = error instanceof Error ? error.message : "Unknown bridge error";
  const code = error && typeof error === "object" && "code" in error
    ? (error as { code?: unknown }).code
    : undefined;
  return typeof code === "string" ? { error: message, code } : { error: message };
}

function applicationErrorStatus(error: unknown): number | null {
  if (!error || typeof error !== "object" || !("code" in error)) return null;
  const code = (error as { code?: unknown }).code;
  if (code === 'INSTANCE_OFFLINE') return 503;
  if (typeof code === 'string' && ['BINDING_REQUIRED', 'BINDING_MISMATCH', 'BINDING_REVISION_CONFLICT', 'BOOT_MISMATCH', 'IDENTITY_CONFLICT'].includes(code)) return 409;
  if (code === "REVISION_CONFLICT" || code === "CORRUPT_MARKER" || code === "IDEMPOTENCY_CONFLICT" || code === "SOURCE_CHANGED" || code === "KNOWLEDGE_CONFLICT") return 409;
  if (code === "NOTE_NOT_FOUND") return 404;
  return null;
}

async function readJsonBody(request: IncomingMessage, maxBodyBytes: number): Promise<unknown> {
  const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") throw new HttpError(400, "Content-Type must be application/json");
  const declaredLength = Number(request.headers["content-length"] ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > maxBodyBytes) {
    throw new HttpError(413, `Request body exceeds ${maxBodyBytes} bytes`);
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > maxBodyBytes) throw new HttpError(413, `Request body exceeds ${maxBodyBytes} bytes`);
    chunks.push(bytes);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "Request body is not valid JSON");
  }
}

function bearerToken(request: IncomingMessage): string | null {
  const value = request.headers.authorization;
  return value?.startsWith("Bearer ") ? value.slice("Bearer ".length) : null;
}

export async function startBridgeServer(options: BridgeServerOptions = {}): Promise<RunningBridge> {
  const configuredOrigins = new Set((options.allowedDshOrigins ?? []).map(normalizeLoopbackOrigin));
  const port = validateBridgePort(options.port ?? DEFAULT_BRIDGE_PORT);
  const tokenTtlMs = options.tokenTtlMs ?? DEFAULT_TOKEN_TTL_MS;
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const now = options.now ?? Date.now;
  const identity = {
    lifecycleProtocolVersion: BRIDGE_LIFECYCLE_PROTOCOL_VERSION,
    instanceId: options.instanceId?.trim() || "obsidian-deepharness-bridge",
    bootId: randomUUID(),
    bridgeVersion: options.bridgeVersion?.trim() || "development",
    startedAt: now(),
  } as const;
  if (!Number.isFinite(tokenTtlMs) || tokenTtlMs <= 0) throw new Error("Token TTL must be positive");
  if (!Number.isInteger(maxBodyBytes) || maxBodyBytes < 1) throw new Error("Maximum body size must be a positive integer");

  const queue = new ClientActionQueue();
  const queueId = randomBytes(16).toString("hex");
  const tokens = new Map<string, TokenRecord>();
  const leases = new Map<string, BridgeLease>();
  const actionRoutes = new Map<string, BoundOperationRoute | undefined>();
  const binding = options.binding;
  const unsubscribeBinding = binding?.subscribe(() => { tokens.clear(); leases.clear(); });
  const assertBinding = (authentication: TokenRecord): void => {
    if (!binding) return;
    const snapshot = binding.snapshot();
    if (!snapshot.target) throw new HttpError(409, 'Vault 尚未绑定实例', 'BINDING_REQUIRED');
    if (authentication.bindingRevision !== snapshot.revision || authentication.dshInstanceId !== snapshot.target.instanceId || authentication.profileId !== snapshot.target.profileId)
      throw new HttpError(409, '绑定已变化或操作属于另一实例', 'BINDING_MISMATCH');
    if (!authentication.dshBootId || authentication.dshBootId !== binding.currentIdentity()?.bootId)
      throw new HttpError(409, '实例已重启，请刷新页面连接', 'BOOT_MISMATCH');
  };
  const acceptsAction = (authentication: TokenRecord, message: QueuedBridgeMessage): boolean =>
    visibleTo(authentication, message, options.referenceSurfaceId) && (!binding || binding.accepts(actionRoutes.get(message.actionId)));
  const verifyController = async (authentication: TokenRecord, input: { browserOrigins: string[]; dshViewerUrl?: string | undefined }): Promise<void> => {
    if (!binding || authentication.role !== 'controller') return;
    await binding.verify({ origin: authentication.dshOrigin!, bootId: authentication.dshBootId! }, { instanceId: authentication.dshInstanceId!, profileId: authentication.profileId! });
    assertBinding(authentication);
    if (input.browserOrigins.some(origin => origin !== authentication.dshOrigin) || (input.dshViewerUrl && new URL(input.dshViewerUrl).origin !== authentication.dshOrigin))
      throw new HttpError(409, 'Viewer 地址不属于绑定实例', 'IDENTITY_CONFLICT');
  };
  const referenceWork = new KeyedSerialWork();
  const inMemoryNotes = new Map<string, SessionNoteDocument>();
  let latestTokenExpiry: number | null = null;
  let listeningOrigin = "";
  let closed = false;
  let closePromise: Promise<void> | undefined;
  let lifecycleState: Exclude<BridgeLifecycleState, "OFFLINE"> = "STARTING";
  let stateChangedAt = now();
  let inFlightRequestCount = 0;
  let controllerLeaseSeen = false;
  let drainRequestId: string | undefined;
  const drainWaiters = new Set<() => void>();

  const setLifecycleState = (state: typeof lifecycleState): void => {
    if (lifecycleState === state) return;
    lifecycleState = state;
    stateChangedAt = now();
  };
  const cleanupExpired = (): void => {
    const current = now();
    for (const [token, record] of tokens) if (record.expiresAt <= current) tokens.delete(token);
    for (const [leaseId, lease] of leases) if (lease.expiresAt <= current) leases.delete(leaseId);
  };
  const isAllowedBrowserOrigin = (origin: string): boolean => {
    cleanupExpired();
    if (!binding && !controllerLeaseSeen && configuredOrigins.has(origin)) return true;
    for (const lease of leases.values()) {
      if (lease.role === "controller" && lease.browserOrigins.includes(origin)) return true;
    }
    return false;
  };
  const lifecycleStatus = (): BridgeStatus => {
    cleanupExpired();
    return bridgeStatusSchema.parse({
      ...identity,
      state: lifecycleState,
      stateChangedAt,
      activeLeaseCount: leases.size,
      inFlightRequestCount,
      ...(drainRequestId === undefined ? {} : { drainRequestId }),
    });
  };
  // Renewing an older instance's lease must not steal the currently selected
  // viewer. Select the most recently attached controller, then keep it until it exits.
  const activeController = (): BridgeLease | undefined => {
    cleanupExpired();
    return [...leases.values()]
      .filter(lease => lease.role === "controller" && lease.dshViewerUrl !== undefined)
      .sort((left, right) => right.acquiredAt - left.acquiredAt || right.leaseId.localeCompare(left.leaseId))[0];
  };
  const activeDshViewerUrl = (): string | undefined => activeController()?.dshViewerUrl;
  const activeDshInstanceId = (): string | undefined => {
    const lease = activeController();
    return lease === undefined ? undefined : [...tokens.values()].find(token => token.role === "controller" && token.clientId === lease.clientId)?.dshInstanceId;
  };
  const assertCurrentBoot = (expectedBootId: string): void => {
    if (expectedBootId !== identity.bootId) {
      throw new HttpError(409, "Bridge boot identity changed", "BOOT_MISMATCH");
    }
  };
  const waitForDrain = async (deadlineMs: number): Promise<void> => {
    if (inFlightRequestCount === 0) return;
    await new Promise<void>((resolve) => {
      const finish = (): void => {
        clearTimeout(timer);
        drainWaiters.delete(finish);
        resolve();
      };
      const timer = setTimeout(finish, deadlineMs);
      drainWaiters.add(finish);
    });
  };
  const finishOneRequest = (): void => {
    inFlightRequestCount = Math.max(0, inFlightRequestCount - 1);
    if (inFlightRequestCount === 0) for (const finish of [...drainWaiters]) finish();
  };

  const server = createServer((request, response) => {
    let countedWorkRequest = false;
    void (async () => {
      const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
      if (requestUrl.pathname === VAULT_LOCATION_PATH) {
        // This endpoint is deliberately outside public identity and browser CORS.
        if (!isLocalLocationCaller(request, listeningOrigin)) {
          json(response, 403, { error: 'Local host access is required', code: 'VAULT_LOCATION_FORBIDDEN' }); return;
        }
        if (request.method !== 'GET') {
          json(response, 405, { error: 'Method is not allowed', code: 'METHOD_NOT_ALLOWED' }); return;
        }
        try {
          if (closed || lifecycleState !== 'READY' || !options.vaultRoot || !options.discoveryIdentity) throw new Error();
          inFlightRequestCount++; countedWorkRequest = true;
          const vaultRoot = await options.vaultRoot();
          const published = options.discoveryIdentity();
          if (closed || lifecycleState !== 'READY' || published.bootId !== identity.bootId || published.origin !== listeningOrigin) throw new Error();
          json(response, 200, { locationProtocolVersion: 1, vaultId: published.vaultId, publisherId: published.publisherId,
            bootId: published.bootId, origin: published.origin, vaultRoot });
        } catch {
          json(response, 503, { error: 'Vault location is unavailable', code: 'VAULT_LOCATION_UNAVAILABLE' });
        }
        return;
      }
      const originHeader = request.headers.origin;
      const requestOrigin = typeof originHeader === "string" ? originHeader : undefined;
      const allowedOrigin = requestOrigin && isAllowedBrowserOrigin(requestOrigin) ? requestOrigin : undefined;
      const callerIdentity = allowedOrigin ?? (requestOrigin === undefined ? LOCAL_HOST_CALLER : undefined);
      if (!callerIdentity) throw new HttpError(403, "Request origin is not allowed");

      if (request.method === "POST" && requestUrl.pathname === "/control/v1/maintenance-binding") {
        json(response, 410, { error: { code: 'BINDING_MOVED', message: '请在 DSH Bridge 的连接设置中选择 Vault；此全局绑定入口已停用。' } }); return;
      }

      if (request.method === "OPTIONS") {
        if (!allowedOrigin) throw new HttpError(403, "Browser preflight requires an allowed origin");
        response.statusCode = 204;
        response.setHeader("access-control-allow-origin", allowedOrigin);
        response.setHeader("access-control-allow-methods", "GET, POST, PUT, DELETE, OPTIONS");
        response.setHeader("access-control-allow-headers", "authorization, content-type");
        response.setHeader("access-control-max-age", "600");
        response.setHeader("vary", "Origin");
        response.end();
        return;
      }

      if (request.method === "GET" && requestUrl.pathname === "/v1/health") {
        json(response, 200, { protocolVersion: PROTOCOL_VERSION, status: "ok" }, allowedOrigin);
        return;
      }

      if (request.method === "GET" && requestUrl.pathname === "/v2/health") {
        json(response, 200, {
          annotationProtocolVersion: ANNOTATION_PROTOCOL_VERSION,
          stickerProtocolVersion: STICKER_PROTOCOL_VERSION,
          bridgeOrigin: listeningOrigin,
          status: "ok",
          capabilities: [...BRIDGE_CAPABILITIES, ...(binding ? [BINDING_CAPABILITY] : [])],
        }, allowedOrigin);
        return;
      }

      if (request.method === "GET" && requestUrl.pathname === "/control/v1/status") {
        json(response, 200, lifecycleStatus(), allowedOrigin);
        return;
      }

      if (request.method === 'GET' && requestUrl.pathname === VAULT_IDENTITY_PATH && options.discoveryIdentity) {
        json(response, 200, options.discoveryIdentity(), allowedOrigin); return;
      }
      if (request.method === 'GET' && requestUrl.pathname === VAULT_BINDING_PATH && binding) {
        json(response, 200, binding.snapshot(), allowedOrigin); return;
      }
      if (request.method === "POST" && requestUrl.pathname === "/control/v1/handshake") {
        const input = bridgeControlHandshakeRequestSchema.parse(await readJsonBody(request, maxBodyBytes));
        if (input.expectedBootId !== undefined) assertCurrentBoot(input.expectedBootId);
        if (input.role === "controller" && callerIdentity !== LOCAL_HOST_CALLER) {
          throw new HttpError(403, "Only a loopback host process can hold the controller role", "NOT_CONTROLLER");
        }
        if (binding) {
          const snapshot = binding.snapshot();
          if (input.bindingProtocolVersion !== 1 || input.vaultId !== snapshot.vaultId || input.bindingRevision !== snapshot.revision)
            throw new HttpError(409, '请刷新 Vault 绑定后重试', 'BINDING_MISMATCH');
          if (!input.dshInstanceId || !input.profileId || !input.dshBootId || !input.dshOrigin)
            throw new HttpError(409, '需要可核验的实例身份', 'IDENTITY_CONFLICT');
          await binding.verify({ origin: input.dshOrigin, bootId: input.dshBootId }, { instanceId: input.dshInstanceId, profileId: input.profileId });
          if (binding.snapshot().revision !== snapshot.revision) throw new HttpError(409, '绑定已变化', 'BINDING_MISMATCH');
          if (snapshot.target?.instanceId === input.dshInstanceId && snapshot.target.profileId === input.profileId
            && [...tokens.values()].some(token => token.role === 'controller' && token.dshInstanceId === input.dshInstanceId && token.dshBootId !== input.dshBootId)) {
            tokens.clear(); leases.clear();
          }
        }
        for (const [token, record] of tokens) {
          if (record.clientId === input.clientId) tokens.delete(token);
        }
        const token = randomBytes(32).toString("base64url");
        const expiresAt = now() + tokenTtlMs;
        tokens.set(token, {
          clientId: input.clientId,
          role: input.role,
          ...(binding ? { bindingRevision: input.bindingRevision!, profileId: input.profileId!, dshBootId: input.dshBootId!, dshOrigin: input.dshOrigin! } : {}),
          ...(input.dshInstanceId === undefined ? {} : { dshInstanceId: input.dshInstanceId }),
          origin: callerIdentity,
          expiresAt,
        });
        latestTokenExpiry = expiresAt;
        json(response, 200, {
          ...lifecycleStatus(),
          clientId: input.clientId,
          role: input.role,
          token,
          tokenExpiresAt: expiresAt,
          ...(binding ? { bindingProtocolVersion: 1, vaultId: binding.vaultId, bindingRevision: input.bindingRevision, profileId: input.profileId, dshBootId: input.dshBootId } : {}),
        }, allowedOrigin);
        return;
      }

      if (request.method === "POST" && (requestUrl.pathname === "/v1/handshake" || requestUrl.pathname === "/v2/handshake")) {
        const input = handshakeSchema.parse(await readJsonBody(request, maxBodyBytes));
        const bound = binding?.snapshot();
        if (bound && (!bound.target || input.dshInstanceId !== bound.target.instanceId
          || input.bindingProtocolVersion !== 1 || !input.dshBootId || input.dshBootId !== binding?.currentIdentity()?.bootId
          || input.vaultId !== bound.vaultId
          || input.profileId !== bound.target.profileId
          || input.bindingRevision !== bound.revision))
          throw new HttpError(409, '页面实例与 Vault 绑定不匹配', 'BINDING_MISMATCH');
        for (const [token, record] of tokens) {
          if (record.clientId === input.clientId) tokens.delete(token);
        }
        const token = randomBytes(32).toString("base64url");
        const expiresAt = now() + tokenTtlMs;
        tokens.set(token, {
          clientId: input.clientId,
          role: "surface",
          ...(bound?.target ? { bindingRevision: bound.revision, profileId: bound.target.profileId, dshBootId: input.dshBootId! } : {}),
          ...(input.surfaceId === undefined ? {} : { surfaceId: input.surfaceId }),
          ...(input.dshInstanceId === undefined ? {} : { dshInstanceId: input.dshInstanceId }),
          origin: callerIdentity,
          expiresAt,
        });
        latestTokenExpiry = expiresAt;
        const v2 = requestUrl.pathname.startsWith("/v2/");
        json(response, 200, v2 ? {
          annotationProtocolVersion: ANNOTATION_PROTOCOL_VERSION,
          stickerProtocolVersion: STICKER_PROTOCOL_VERSION,
          bridgeOrigin: listeningOrigin,
          capabilities: [...BRIDGE_CAPABILITIES, ...(binding ? [BINDING_CAPABILITY] : [])],
          clientId: input.clientId,
          ...(input.surfaceId === undefined ? {} : { surfaceId: input.surfaceId }),
          ...(input.dshInstanceId === undefined ? {} : { dshInstanceId: input.dshInstanceId }),
          token,
          expiresAt,
          ...(bound ? { bindingProtocolVersion: 1, vaultId: bound.vaultId, bindingRevision: bound.revision, profileId: bound.target?.profileId, dshBootId: input.dshBootId } : {}),
        } : { protocolVersion: PROTOCOL_VERSION, clientId: input.clientId, token, expiresAt }, allowedOrigin);
        return;
      }

      const token = bearerToken(request);
      const authentication = token ? tokens.get(token) : undefined;
      if (!authentication || authentication.origin !== callerIdentity || authentication.expiresAt <= now()) {
        if (token) tokens.delete(token);
        throw new HttpError(401, "Handshake token is missing or expired");
      }

      if (request.method === 'POST' && requestUrl.pathname === VAULT_BINDING_PATH && binding) {
        if (authentication.role !== 'controller' || callerIdentity !== LOCAL_HOST_CALLER) throw new HttpError(403, '绑定修改需要已认证的本机控制器', 'NOT_CONTROLLER');
        const input = changeVaultBindingRequestSchema.parse(await readJsonBody(request, maxBodyBytes));
        const target = input.target ?? binding.operationOwner(input.operationId) ?? binding.snapshot().target;
        if (!target || target.instanceId !== authentication.dshInstanceId || target.profileId !== authentication.profileId)
          throw new HttpError(403, '控制器只能管理自身实例的绑定', 'NOT_CONTROLLER');
        if (input.candidate && (input.candidate.origin !== authentication.dshOrigin || input.candidate.bootId !== authentication.dshBootId))
          throw new HttpError(409, '绑定候选与已核验控制器不匹配', 'IDENTITY_CONFLICT');
        json(response, 200, await binding.change(input), allowedOrigin); return;
      }
      await binding?.assertUniqueVault();
      assertBinding(authentication);
      const readAuthenticatedBody = async (limit = maxBodyBytes): Promise<unknown> => {
        const body = await readJsonBody(request, limit);
        assertBinding(authentication);
        return body;
      };
      if (request.method === "POST" && requestUrl.pathname === "/control/v1/leases") {
        const input = acquireBridgeLeaseRequestSchema.parse(await readAuthenticatedBody());
        await verifyController(authentication, input);
        if (authentication.role !== "controller" && (input.browserOrigins.length > 0 || input.dshViewerUrl !== undefined)) {
          throw new HttpError(403, "Only a loopback host controller may authorize browser origins or a DSH Viewer URL", "NOT_CONTROLLER");
        }
        assertCurrentBoot(input.expectedBootId);
        const acquiredAt = now();
        const lease = bridgeLeaseSchema.parse({
          leaseId: randomUUID(),
          clientId: authentication.clientId,
          role: authentication.role,
          bootId: identity.bootId,
          acquiredAt,
          expiresAt: acquiredAt + input.ttlMs,
          browserOrigins: input.browserOrigins,
          ...(binding ? { bindingProtocolVersion: 1, vaultId: binding.vaultId, bindingRevision: authentication.bindingRevision, profileId: authentication.profileId, dshBootId: authentication.dshBootId } : {}),
          ...(input.dshViewerUrl === undefined ? {} : { dshViewerUrl: input.dshViewerUrl }),
        });
        if (authentication.role === "controller") controllerLeaseSeen = true;
        leases.set(lease.leaseId, lease);
        if (authentication.role === 'controller') options.onControllerReady?.();
        json(response, 201, lease, allowedOrigin);
        return;
      }

      const controlLeaseMatch = /^\/control\/v1\/leases\/([^/]+)$/.exec(requestUrl.pathname);
      if (controlLeaseMatch && request.method === "PUT") {
        const leaseId = decodeURIComponent(controlLeaseMatch[1] ?? "");
        const input = renewBridgeLeaseRequestSchema.parse(await readAuthenticatedBody());
        await verifyController(authentication, input);
        if (authentication.role !== "controller" && (input.browserOrigins.length > 0 || input.dshViewerUrl !== undefined)) {
          throw new HttpError(403, "Only a loopback host controller may authorize browser origins or a DSH Viewer URL", "NOT_CONTROLLER");
        }
        assertCurrentBoot(input.expectedBootId);
        if (input.leaseId !== leaseId) throw new HttpError(400, "Lease ID does not match request path");
        const existing = leases.get(leaseId);
        if (existing === undefined || existing.clientId !== authentication.clientId) {
          throw new HttpError(404, "Bridge lease was not found", "LEASE_NOT_FOUND");
        }
        const renewed = bridgeLeaseSchema.parse({
          ...existing,
          expiresAt: now() + input.ttlMs,
          browserOrigins: input.browserOrigins,
          dshViewerUrl: input.dshViewerUrl,
        });
        leases.set(leaseId, renewed);
        if (authentication.role === 'controller') options.onControllerReady?.();
        json(response, 200, renewed, allowedOrigin);
        return;
      }

      if (controlLeaseMatch && request.method === "DELETE") {
        const leaseId = decodeURIComponent(controlLeaseMatch[1] ?? "");
        const existing = leases.get(leaseId);
        if (existing !== undefined && existing.clientId !== authentication.clientId) {
          throw new HttpError(403, "Bridge lease belongs to another client");
        }
        leases.delete(leaseId);
        json(response, 200, { released: existing !== undefined, leaseId }, allowedOrigin);
        return;
      }

      if (request.method === "POST" && requestUrl.pathname === "/control/v1/drain") {
        if (authentication.role !== "controller") {
          throw new HttpError(403, "Only the controller lease may drain the Bridge", "NOT_CONTROLLER");
        }
        const input = drainBridgeRequestSchema.parse(await readAuthenticatedBody());
        assertCurrentBoot(input.expectedBootId);
        if (drainRequestId !== undefined && drainRequestId !== input.requestId && lifecycleState !== "READY") {
          throw new HttpError(409, "A different drain request already owns this transition", "INVALID_STATE");
        }
        drainRequestId = input.requestId;
        setLifecycleState("DRAINING");
        await waitForDrain(input.deadlineMs);
        setLifecycleState("DRAINED");
        json(response, 200, lifecycleStatus(), allowedOrigin);
        return;
      }

      if (request.method === "POST" && requestUrl.pathname === "/control/v1/resume") {
        if (authentication.role !== "controller") {
          throw new HttpError(403, "Only the controller lease may resume the Bridge", "NOT_CONTROLLER");
        }
        const input = resumeBridgeRequestSchema.parse(await readAuthenticatedBody());
        assertCurrentBoot(input.expectedBootId);
        if (lifecycleState !== "DRAINED" && lifecycleState !== "DEGRADED") {
          throw new HttpError(409, `Bridge cannot resume from ${lifecycleState}`, "INVALID_STATE");
        }
        drainRequestId = undefined;
        setLifecycleState("READY");
        json(response, 200, lifecycleStatus(), allowedOrigin);
        return;
      }

      if (lifecycleState === "DRAINING" || lifecycleState === "DRAINED") {
        throw new HttpError(503, "Bridge is draining and does not accept new work", "INVALID_STATE");
      }
      countedWorkRequest = true;
      const assertReferenceOwner = async (referenceId: string, explicitInstanceId?: string) => {
        const owner = await options.referenceInstanceId?.(referenceId) ?? queue.instanceForReference(referenceId);
        assertBinding(authentication);
        if ((owner !== undefined && owner !== authentication.dshInstanceId) || (explicitInstanceId !== undefined && explicitInstanceId !== authentication.dshInstanceId))
          throw new HttpError(409, "Reference belongs to a different DSH instance", "IDEMPOTENCY_CONFLICT");
        return owner;
      };
      authentication.lastSeenAt = now();
      inFlightRequestCount += 1;

      if (request.method === "GET" && requestUrl.pathname === "/v1/actions/next") {
        const afterText = requestUrl.searchParams.get("after") ?? "0";
        const after = Number(afterText);
        if (!Number.isInteger(after) || after < 0) throw new HttpError(400, "Action cursor must be a non-negative integer");
        json(response, 200, queue.pending(
          authentication.clientId,
          after,
          (message) => message.type === "deep-link" && acceptsAction(authentication, message),
        ), allowedOrigin);
        return;
      }


      if (request.method === "GET" && requestUrl.pathname === "/v2/actions/pending") {
        const afterText = requestUrl.searchParams.get("after") ?? "0";
        const after = Number(afterText);
        if (!Number.isInteger(after) || after < 0) throw new HttpError(400, "Action cursor must be a non-negative integer");
        json(response, 200, {
          queueId,
          ...queue.pending(authentication.clientId, after, (message) => acceptsAction(authentication, message)),
        }, allowedOrigin);
        return;
      }

      const v2AckMatch = /^\/v2\/actions\/([^/]+)\/ack$/.exec(requestUrl.pathname);
      if (request.method === "POST" && v2AckMatch) {
        const actionId = decodeURIComponent(v2AckMatch[1] ?? "");
        const claim = ReferenceClaimV2Schema.parse(await readAuthenticatedBody());
        // Also reject stale/in-flight clients and replays after the queue entry
        // has completed; filtering the pending list alone is not sufficient.
        if (!captureReceiver(authentication, options.referenceSurfaceId)) throw new HttpError(409, "只有 Obsidian 内嵌页可以领取引用", "IDEMPOTENCY_CONFLICT");
        if (claim.dshInstanceId !== authentication.dshInstanceId) throw new HttpError(409, "Reference claim belongs to a different DSH instance", "IDEMPOTENCY_CONFLICT");
        const action = queue.message(actionId);
        if (action !== undefined && !acceptsAction(authentication, action)) throw new HttpError(409, "Reference action targets a different DSH instance or binding", "IDEMPOTENCY_CONFLICT");
        await referenceWork.run(claim.referenceId, async () => {
          assertBinding(authentication);
          if (action !== undefined && !acceptsAction(authentication, action)) throw new HttpError(409, "Reference binding changed", "BINDING_MISMATCH");
          const result = queue.checkClaim(actionId, claim);
          if (result === "missing" || result === "cancelled") throw new HttpError(404, "Reference action is no longer available", "NOTE_NOT_FOUND");
          if (result === "conflict") throw new HttpError(409, "Reference action was already claimed differently", "IDEMPOTENCY_CONFLICT");
          if (result === "created") await options.onClaimReference?.(claim);
          const committed = queue.claim(actionId, claim);
          if (committed === "cancelled" || committed === "missing") throw new HttpError(404, "Reference action was cancelled", "NOTE_NOT_FOUND");
        });
        json(response, 200, { acknowledged: true, actionId, referenceId: claim.referenceId }, allowedOrigin);
        return;
      }

      const refreshMatch = /^\/v2\/references\/([^/]+)\/refresh$/.exec(requestUrl.pathname);
      if (request.method === "POST" && refreshMatch) {
        const referenceId = decodeURIComponent(refreshMatch[1] ?? "");
        const input = ReferenceRefreshRequestV2Schema.parse(await readAuthenticatedBody());
        await assertReferenceOwner(input.referenceId);
        if (input.referenceId !== referenceId) throw new HttpError(400, "Reference ID does not match request path");
        const result = ReferenceRefreshResultV2Schema.parse(
          await (options.onRefreshReference?.(input) ?? Promise.resolve({ kind: "offline" as const })),
        );
        json(response, 200, result, allowedOrigin);
        return;
      }

      const discardMatch = /^\/v2\/references\/([^/]+)\/discard$/.exec(requestUrl.pathname);
      if (request.method === "POST" && discardMatch) {
        const referenceId = decodeURIComponent(discardMatch[1] ?? "");
        const input = ReferenceDiscardV2Schema.parse(await readAuthenticatedBody());
        await assertReferenceOwner(input.referenceId);
        if (input.referenceId !== referenceId) throw new HttpError(400, "Reference ID does not match request path");
        await referenceWork.run(referenceId, async () => {
          await assertReferenceOwner(input.referenceId);
          await options.onDiscardReference?.(input);
          queue.cancelReference(referenceId);
        });
        json(response, 200, { discarded: true, referenceId }, allowedOrigin);
        return;
      }

      if (request.method === "POST" && requestUrl.pathname === "/v2/backlinks/commit") {
        const input = BacklinkCommitV2Schema.parse(await readAuthenticatedBody());
        await assertReferenceOwner(input.referenceId, input.dshInstanceId);
        const result = await referenceWork.run(input.referenceId, async () => { await assertReferenceOwner(input.referenceId, input.dshInstanceId); return options.onCommitBacklink?.(input); });
        if (result === undefined) throw new HttpError(501, "Backlink commit is unavailable");
        json(response, 200, result, allowedOrigin);
        return;
      }

      const deleteCommitMatch = /^\/v2\/references\/([^/]+)\/delete-commit$/.exec(requestUrl.pathname);
      if (request.method === "POST" && deleteCommitMatch) {
        const referenceId = decodeURIComponent(deleteCommitMatch[1] ?? "");
        const input = ReferenceDeleteCommitV2Schema.parse(await readAuthenticatedBody());
        await assertReferenceOwner(input.referenceId, input.dshInstanceId);
        if (input.referenceId !== referenceId) throw new HttpError(400, "Reference ID does not match request path");
        if (options.onDeleteCommittedReference === undefined) throw new HttpError(501, "Reference deletion is unavailable");
        await referenceWork.run(referenceId, async () => {
          const owner = await assertReferenceOwner(input.referenceId, input.dshInstanceId);
          // Normalize only after authentication and only from a durable owner.
          // Historical unscoped jobs remain byte-for-byte the same DTO shape.
          const commit = input.dshInstanceId === undefined && owner !== undefined ? { ...input, dshInstanceId: owner } : input;
          await options.onDeleteCommittedReference!(commit);
          queue.cancelReference(referenceId);
        });
        json(response, 200, { deleted: true, referenceId }, allowedOrigin);
        return;
      }

      if (request.method === "POST" && requestUrl.pathname === "/v2/obsidian/open-note") {
        const action = openNoteActionSchema.parse(await readAuthenticatedBody());
        assertVault(action.vaultId);
        await options.onOpenNote?.(action);
        json(response, 200, { opened: true }, allowedOrigin);
        return;
      }

      const ackMatch = /^\/v1\/actions\/([^/]+)\/ack$/.exec(requestUrl.pathname);
      if (request.method === "POST" && ackMatch) {
        await readAuthenticatedBody();
        const actionId = decodeURIComponent(ackMatch[1] ?? "");
        const message = queue.message(actionId);
        if (message !== undefined && !acceptsAction(authentication, message)) {
          throw new HttpError(409, "Deep-link action belongs to another DSH surface");
        }
        // Multiple DSH surfaces can observe the same one-shot command before
        // the first acknowledgement removes it. A later acknowledgement is
        // therefore an idempotent success, not an actionable 404.
        const acknowledged = queue.acknowledge(authentication.clientId, actionId);
        json(response, 200, { acknowledged, actionId }, allowedOrigin);
        return;
      }

      if (request.method === "POST" && requestUrl.pathname === "/v1/obsidian/open-note") {
        const action = openNoteActionSchema.parse(await readAuthenticatedBody());
        assertVault(action.vaultId);
        await options.onOpenNote?.(action);
        json(response, 200, { opened: true }, allowedOrigin);
        return;
      }

      if (request.method === "GET" && requestUrl.pathname === "/v1/sticker-backlinks") {
        const target = stickerBacklinkTargetSchema.parse(Object.fromEntries(requestUrl.searchParams));
        assertVault(target.vaultId);
        if (target.dshInstanceId !== undefined && target.dshInstanceId !== authentication.dshInstanceId) throw new HttpError(409, "Sticker target belongs to another DSH instance", "IDEMPOTENCY_CONFLICT");
        const backlinks = z.array(stickerBacklinkSchema).parse(
          await (options.onListStickerBacklinks?.(target) ?? Promise.resolve([])),
        );
        json(response, 200, { backlinks: backlinks.map(backlink => ({ ...backlink, ...(binding ? { vaultId: binding.vaultId } : {}) })) }, allowedOrigin);
        return;
      }

      if (request.method === "POST" && requestUrl.pathname === "/v1/sticker-backlinks/delete") {
        const target = stickerBacklinkTargetSchema.parse(await readAuthenticatedBody());
        assertVault(target.vaultId);
        if (target.dshInstanceId !== undefined && target.dshInstanceId !== authentication.dshInstanceId) throw new HttpError(409, "Sticker target belongs to another DSH instance", "IDEMPOTENCY_CONFLICT");
        const result = stickerBacklinkDeleteResultSchema.parse(
          await (options.onDeleteStickerBacklinks?.(target) ?? Promise.resolve({ notesChanged: 0, linksRemoved: 0 })),
        );
        json(response, 200, result, allowedOrigin);
        return;
      }

      const sessionNoteMatch = /^\/v1\/session-notes\/([^/]+)$/.exec(requestUrl.pathname);
      const knowledgeMatch = /^\/v1\/knowledge\/([a-z-]{1,40})$/.exec(requestUrl.pathname);
      if (knowledgeMatch && request.method === 'POST') {
        if (!authentication.dshInstanceId) throw new HttpError(409, '知识操作需要当前实例身份');
        if (!options.onKnowledge) throw new HttpError(501, '请升级 Obsidian Companion');
        const input = z.record(z.string(), z.unknown()).parse(await readAuthenticatedBody(Math.min(maxBodyBytes, 512 * 1024)));
        assertVault(input.vaultId);
        const result = await options.onKnowledge(knowledgeMatch[1]!, input, authentication.dshInstanceId);
        if (Buffer.byteLength(JSON.stringify(result)) > 512 * 1024) throw new HttpError(413, '本次结果过大，请分批读取');
        json(response, 200, result, allowedOrigin);
        return;
      }
      if (sessionNoteMatch && request.method === "GET") {
        assertVault(requestUrl.searchParams.get("vaultId") ?? undefined);
        const sessionId = decodeURIComponent(sessionNoteMatch[1] ?? "");
        const document = await (options.onReadSessionNote?.(sessionId) ?? Promise.resolve(inMemoryNotes.get(sessionId) ?? null));
        if (!document) throw new HttpError(404, "Session note was not found");
        json(response, 200, { ...document, ...(binding ? { vaultId: binding.vaultId } : {}) }, allowedOrigin);
        return;
      }

      if (sessionNoteMatch && request.method === "PUT") {
        const input = saveSessionNoteSchema.parse(await readAuthenticatedBody());
        const sessionId = decodeURIComponent(sessionNoteMatch[1] ?? "");
        assertVault(input.document.vaultId);
        for (const sticker of input.document.stickers) assertVault(sticker.vaultId);
        if (input.document.sessionId !== sessionId) throw new HttpError(400, "Session ID does not match request path");
        const result = options.onSaveSessionNote
          ? await options.onSaveSessionNote(input)
          : (inMemoryNotes.set(sessionId, input.document), { revision: input.document.revision });
        json(response, 200, result, allowedOrigin);
        return;
      }

      throw new HttpError(404, "Bridge route was not found");
    })().catch((error: unknown) => {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      if (error instanceof z.ZodError) {
        json(response, 400, { error: "Request did not match the bridge protocol", issues: error.issues }, request.headers.origin as string | undefined);
        return;
      }
      const status = error instanceof HttpError ? error.status : applicationErrorStatus(error) ?? 500;
      const origin = typeof request.headers.origin === "string" && isAllowedBrowserOrigin(request.headers.origin)
        ? request.headers.origin
        : undefined;
      json(response, status, errorPayload(error), origin);
    }).finally(() => {
      if (countedWorkRequest) finishOneRequest();
    });
  });

  function assertVault(vaultId: unknown): void {
    if (vaultId !== undefined && (typeof vaultId !== 'string' || (binding && vaultId !== binding.vaultId)))
      throw new HttpError(409, 'Operation belongs to another Vault', 'BINDING_MISMATCH');
  }

  // Browsers reject these ports even on loopback; an OS ephemeral allocation can
  // land on one of them. Select another available port before publishing it.
  const forbiddenPorts = new Set([1719,1720,1723,2049,3659,4045,4190,5060,5061,6000,6566,6665,6666,6667,6668,6669,6679,6697,10080]);
  const listen = (selectedPort: number) => new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => { server.off('listening', onListening); reject(error); };
    const onListening = () => { server.off('error', onError); resolve(); };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(selectedPort, '127.0.0.1');
  });
  let selectedPort = options.autoPort && (port < 1024 || forbiddenPorts.has(port)) ? 0 : port;
  for (let attempt = 0; ; attempt++) {
    try { await listen(selectedPort); }
    catch (error) {
      if (options.autoPort && selectedPort !== 0 && (error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
        selectedPort = 0;
        await listen(selectedPort);
      } else throw error;
    }
    const allocatedPort = (server.address() as AddressInfo).port;
    if ((selectedPort !== 0 && !options.autoPort) || (allocatedPort >= 1024 && !forbiddenPorts.has(allocatedPort))) break;
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    if (attempt >= 9) throw new Error('Unable to allocate a browser-accessible loopback port');
    selectedPort = 0;
  }
  const address = server.address() as AddressInfo;
  listeningOrigin = `http://127.0.0.1:${address.port}`;
  setLifecycleState("READY");

  return {
    origin: listeningOrigin,
    identity,
    status: lifecycleStatus,
    activeDshViewerUrl,
    prepareCapture: capture => {
      const dshInstanceId = capture.dshInstanceId ?? (binding ? binding.route().instanceId : activeDshInstanceId());
      if (binding && (dshInstanceId !== binding.route().instanceId || capture.source.locator.vaultId !== binding.vaultId))
        throw new HttpError(409, '引用属于另一实例或 Vault', 'BINDING_MISMATCH');
      return ObsidianReferenceCaptureV2Schema.parse({ ...capture, ...(dshInstanceId === undefined ? {} : { dshInstanceId }) });
    },
    cancelReference: (referenceId) => queue.cancelReference(referenceId),
    restoreReferenceClaim: (capture, claim) => {
      actionRoutes.set(capture.actionId, options.jobRoute?.(capture.actionId));
      queue.enqueue(ObsidianReferenceCaptureV2Schema.parse(capture));
      const result = queue.claim(capture.actionId, ReferenceClaimV2Schema.parse(claim));
      if (result === "conflict") throw new HttpError(409, "Persisted reference claim conflicts", "IDEMPOTENCY_CONFLICT");
    },
    diagnostics: () => {
      cleanupExpired();
      return { ...queue.diagnostics, connectedClients: new Set([...tokens.values()]
        .filter((token) => token.role === "surface" && token.lastSeenAt !== undefined && now() - token.lastSeenAt < 10_000)
        .map((token) => token.clientId)).size };
    },
    get tokenExpiresAt() {
      return latestTokenExpiry;
    },
    enqueue(message) {
      if (closed) throw new HttpError(503, "Bridge is stopping", "INVALID_STATE");
      if (binding && !actionRoutes.has(message.actionId)) {
        const route = options.jobRoute?.(message.actionId);
        // Ephemeral navigation retains the explicit historical instance; never infer an unscoped target.
        actionRoutes.set(message.actionId, route ?? (message.type === 'deep-link' && message.dshInstanceId === binding.snapshot().target?.instanceId ? binding.route() : undefined));
      }
      if (message.type === "reference-capture") {
        return queue.enqueue(ObsidianReferenceCaptureV2Schema.parse(message));
      }
      if (message.type === "reference-delete-request") {
        const deletion = ReferenceDeleteRequestV2Schema.parse(message);
        queue.cancelReference(deletion.referenceId);
        return queue.enqueue(deletion);
      }
      const legacy = parseBridgeMessage(message);
      if (legacy.type !== "deep-link") throw new TypeError("Only deep links, reference captures and reference deletions are queueable");
      return queue.enqueue(legacy as QueuedBridgeMessage);
    },
    close() {
      if (closePromise) return closePromise;
      closed = true;
      unsubscribeBinding?.();
      setLifecycleState("DRAINING");
      closePromise = (async () => {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => error ? reject(error) : resolve());
        });
        // A disconnected client can leave its Vault callback running.
        while (inFlightRequestCount > 0) await waitForDrain(5_000);
        setLifecycleState("DRAINED");
        tokens.clear();
        leases.clear();
      })();
      return closePromise;
    },
  };
}
