import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { z } from "zod";

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

interface TokenRecord {
  clientId: string;
  surfaceId?: string;
  origin: string;
  expiresAt: number;
}

const LOCAL_HOST_CALLER = "local-host";

export interface SaveSessionNoteRequest {
  document: SessionNoteDocument;
  expectedRevision: string;
}

export interface BridgeServerOptions {
  port?: number;
  allowedDshOrigins?: string[];
  tokenTtlMs?: number;
  maxBodyBytes?: number;
  now?: () => number;
  onOpenNote?: (action: OpenNoteAction) => Promise<void>;
  onReadSessionNote?: (sessionId: string) => Promise<SessionNoteDocument | null>;
  onSaveSessionNote?: (request: SaveSessionNoteRequest) => Promise<{ revision: string }>;
  onListStickerBacklinks?: (target: StickerBacklinkTarget) => Promise<StickerBacklink[]>;
  onDeleteStickerBacklinks?: (target: StickerBacklinkTarget) => Promise<StickerBacklinkDeleteResult>;
  onClaimReference?: (claim: ReferenceClaimV2) => Promise<void>;
  onRefreshReference?: (request: ReferenceRefreshRequestV2) => Promise<ReferenceRefreshResultV2>;
  onDiscardReference?: (request: ReferenceDiscardV2) => Promise<void>;
  onCommitBacklink?: (commit: BacklinkCommitV2) => Promise<BacklinkReceiptV2>;
  onDeleteCommittedReference?: (commit: ReferenceDeleteCommitV2) => Promise<void>;
}

export interface RunningBridge {
  readonly origin: string;
  readonly tokenExpiresAt: number | null;
  enqueue(message: QueuedBridgeMessage): number;
  close(): Promise<void>;
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

const handshakeSchema = z.object({
  clientId: z.string().min(1).max(128),
  surfaceId: z.string().uuid().optional(),
});
const BRIDGE_CAPABILITIES = [
  "reference-capture-v2",
  "reference-refresh",
  "backlink-commit-v2",
  "reference-delete-v2",
  "targeted-deep-link-v1",
  "sticker-backlink-delete-v1",
] as const;

function visibleTo(authentication: TokenRecord, message: QueuedBridgeMessage): boolean {
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
  if (code === "REVISION_CONFLICT" || code === "CORRUPT_MARKER" || code === "IDEMPOTENCY_CONFLICT" || code === "SOURCE_CHANGED") return 409;
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

function canonical(value: unknown): string {
  return JSON.stringify(value);
}

export async function startBridgeServer(options: BridgeServerOptions = {}): Promise<RunningBridge> {
  const allowedOrigins = new Set((options.allowedDshOrigins ?? []).map(normalizeLoopbackOrigin));
  const port = validateBridgePort(options.port ?? DEFAULT_BRIDGE_PORT);
  const tokenTtlMs = options.tokenTtlMs ?? DEFAULT_TOKEN_TTL_MS;
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const now = options.now ?? Date.now;
  if (!Number.isFinite(tokenTtlMs) || tokenTtlMs <= 0) throw new Error("Token TTL must be positive");
  if (!Number.isInteger(maxBodyBytes) || maxBodyBytes < 1) throw new Error("Maximum body size must be a positive integer");

  const queue = new ClientActionQueue();
  const queueId = randomBytes(16).toString("hex");
  const tokens = new Map<string, TokenRecord>();
  const referenceClaims = new Map<string, ReferenceClaimV2>();
  const inMemoryNotes = new Map<string, SessionNoteDocument>();
  let latestTokenExpiry: number | null = null;
  let listeningOrigin = "";
  let closed = false;

  const server = createServer((request, response) => {
    void (async () => {
      const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
      const originHeader = request.headers.origin;
      const requestOrigin = typeof originHeader === "string" ? originHeader : undefined;
      const allowedOrigin = requestOrigin && allowedOrigins.has(requestOrigin) ? requestOrigin : undefined;
      const callerIdentity = allowedOrigin ?? (requestOrigin === undefined ? LOCAL_HOST_CALLER : undefined);
      if (!callerIdentity) throw new HttpError(403, "Request origin is not allowed");

      if (request.method === "OPTIONS") {
        if (!allowedOrigin) throw new HttpError(403, "Browser preflight requires an allowed origin");
        response.statusCode = 204;
        response.setHeader("access-control-allow-origin", allowedOrigin);
        response.setHeader("access-control-allow-methods", "GET, POST, PUT, OPTIONS");
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
          capabilities: BRIDGE_CAPABILITIES,
        }, allowedOrigin);
        return;
      }

      if (request.method === "POST" && (requestUrl.pathname === "/v1/handshake" || requestUrl.pathname === "/v2/handshake")) {
        const input = handshakeSchema.parse(await readJsonBody(request, maxBodyBytes));
        for (const [token, record] of tokens) {
          if (record.clientId === input.clientId) tokens.delete(token);
        }
        const token = randomBytes(32).toString("base64url");
        const expiresAt = now() + tokenTtlMs;
        tokens.set(token, {
          clientId: input.clientId,
          ...(input.surfaceId === undefined ? {} : { surfaceId: input.surfaceId }),
          origin: callerIdentity,
          expiresAt,
        });
        latestTokenExpiry = expiresAt;
        const v2 = requestUrl.pathname.startsWith("/v2/");
        json(response, 200, v2 ? {
          annotationProtocolVersion: ANNOTATION_PROTOCOL_VERSION,
          stickerProtocolVersion: STICKER_PROTOCOL_VERSION,
          bridgeOrigin: listeningOrigin,
          capabilities: BRIDGE_CAPABILITIES,
          clientId: input.clientId,
          ...(input.surfaceId === undefined ? {} : { surfaceId: input.surfaceId }),
          token,
          expiresAt,
        } : { protocolVersion: PROTOCOL_VERSION, clientId: input.clientId, token, expiresAt }, allowedOrigin);
        return;
      }

      const token = bearerToken(request);
      const authentication = token ? tokens.get(token) : undefined;
      if (!authentication || authentication.origin !== callerIdentity || authentication.expiresAt <= now()) {
        if (token) tokens.delete(token);
        throw new HttpError(401, "Handshake token is missing or expired");
      }

      if (request.method === "GET" && requestUrl.pathname === "/v1/actions/next") {
        const afterText = requestUrl.searchParams.get("after") ?? "0";
        const after = Number(afterText);
        if (!Number.isInteger(after) || after < 0) throw new HttpError(400, "Action cursor must be a non-negative integer");
        json(response, 200, queue.pending(
          authentication.clientId,
          after,
          (message) => message.type === "deep-link" && visibleTo(authentication, message),
        ), allowedOrigin);
        return;
      }


      if (request.method === "GET" && requestUrl.pathname === "/v2/actions/pending") {
        const afterText = requestUrl.searchParams.get("after") ?? "0";
        const after = Number(afterText);
        if (!Number.isInteger(after) || after < 0) throw new HttpError(400, "Action cursor must be a non-negative integer");
        json(response, 200, {
          queueId,
          ...queue.pending(authentication.clientId, after, (message) => visibleTo(authentication, message)),
        }, allowedOrigin);
        return;
      }

      const v2AckMatch = /^\/v2\/actions\/([^/]+)\/ack$/.exec(requestUrl.pathname);
      if (request.method === "POST" && v2AckMatch) {
        const actionId = decodeURIComponent(v2AckMatch[1] ?? "");
        const claim = ReferenceClaimV2Schema.parse(await readJsonBody(request, maxBodyBytes));
        const message = queue.message(actionId);
        if (message === undefined) throw new HttpError(404, "Action was not found");
        if (message.type !== "reference-capture" || message.referenceId !== claim.referenceId) {
          throw new HttpError(409, "Reference claim does not match the queued action");
        }
        const existing = referenceClaims.get(claim.referenceId);
        if (existing !== undefined) {
          if (canonical(existing) !== canonical(claim)) throw new HttpError(409, "Reference was already claimed by a different target");
        } else {
          await options.onClaimReference?.(claim);
          referenceClaims.set(claim.referenceId, claim);
        }
        const result = queue.claim(actionId, claim);
        if (result === "missing") throw new HttpError(404, "Action was not found");
        if (result === "conflict") throw new HttpError(409, "Reference action was already claimed differently");
        json(response, 200, { acknowledged: true, actionId, referenceId: claim.referenceId }, allowedOrigin);
        return;
      }

      const refreshMatch = /^\/v2\/references\/([^/]+)\/refresh$/.exec(requestUrl.pathname);
      if (request.method === "POST" && refreshMatch) {
        const referenceId = decodeURIComponent(refreshMatch[1] ?? "");
        const input = ReferenceRefreshRequestV2Schema.parse(await readJsonBody(request, maxBodyBytes));
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
        const input = ReferenceDiscardV2Schema.parse(await readJsonBody(request, maxBodyBytes));
        if (input.referenceId !== referenceId) throw new HttpError(400, "Reference ID does not match request path");
        await options.onDiscardReference?.(input);
        json(response, 200, { discarded: true, referenceId }, allowedOrigin);
        return;
      }

      if (request.method === "POST" && requestUrl.pathname === "/v2/backlinks/commit") {
        const input = BacklinkCommitV2Schema.parse(await readJsonBody(request, maxBodyBytes));
        const result = await options.onCommitBacklink?.(input);
        if (result === undefined) throw new HttpError(501, "Backlink commit is unavailable");
        json(response, 200, result, allowedOrigin);
        return;
      }

      const deleteCommitMatch = /^\/v2\/references\/([^/]+)\/delete-commit$/.exec(requestUrl.pathname);
      if (request.method === "POST" && deleteCommitMatch) {
        const referenceId = decodeURIComponent(deleteCommitMatch[1] ?? "");
        const input = ReferenceDeleteCommitV2Schema.parse(await readJsonBody(request, maxBodyBytes));
        if (input.referenceId !== referenceId) throw new HttpError(400, "Reference ID does not match request path");
        if (options.onDeleteCommittedReference === undefined) throw new HttpError(501, "Reference deletion is unavailable");
        await options.onDeleteCommittedReference(input);
        json(response, 200, { deleted: true, referenceId }, allowedOrigin);
        return;
      }

      if (request.method === "POST" && requestUrl.pathname === "/v2/obsidian/open-note") {
        const action = openNoteActionSchema.parse(await readJsonBody(request, maxBodyBytes));
        await options.onOpenNote?.(action);
        json(response, 200, { opened: true }, allowedOrigin);
        return;
      }

      const ackMatch = /^\/v1\/actions\/([^/]+)\/ack$/.exec(requestUrl.pathname);
      if (request.method === "POST" && ackMatch) {
        await readJsonBody(request, maxBodyBytes);
        const actionId = decodeURIComponent(ackMatch[1] ?? "");
        const message = queue.message(actionId);
        if (message?.type === "deep-link" && !visibleTo(authentication, message)) {
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
        const action = openNoteActionSchema.parse(await readJsonBody(request, maxBodyBytes));
        await options.onOpenNote?.(action);
        json(response, 200, { opened: true }, allowedOrigin);
        return;
      }

      if (request.method === "GET" && requestUrl.pathname === "/v1/sticker-backlinks") {
        const target = stickerBacklinkTargetSchema.parse(Object.fromEntries(requestUrl.searchParams));
        const backlinks = z.array(stickerBacklinkSchema).parse(
          await (options.onListStickerBacklinks?.(target) ?? Promise.resolve([])),
        );
        json(response, 200, { backlinks }, allowedOrigin);
        return;
      }

      if (request.method === "POST" && requestUrl.pathname === "/v1/sticker-backlinks/delete") {
        const target = stickerBacklinkTargetSchema.parse(await readJsonBody(request, maxBodyBytes));
        const result = stickerBacklinkDeleteResultSchema.parse(
          await (options.onDeleteStickerBacklinks?.(target) ?? Promise.resolve({ notesChanged: 0, linksRemoved: 0 })),
        );
        json(response, 200, result, allowedOrigin);
        return;
      }

      const sessionNoteMatch = /^\/v1\/session-notes\/([^/]+)$/.exec(requestUrl.pathname);
      if (sessionNoteMatch && request.method === "GET") {
        const sessionId = decodeURIComponent(sessionNoteMatch[1] ?? "");
        const document = await (options.onReadSessionNote?.(sessionId) ?? Promise.resolve(inMemoryNotes.get(sessionId) ?? null));
        if (!document) throw new HttpError(404, "Session note was not found");
        json(response, 200, document, allowedOrigin);
        return;
      }

      if (sessionNoteMatch && request.method === "PUT") {
        const input = saveSessionNoteSchema.parse(await readJsonBody(request, maxBodyBytes));
        const sessionId = decodeURIComponent(sessionNoteMatch[1] ?? "");
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
      const origin = typeof request.headers.origin === "string" && allowedOrigins.has(request.headers.origin)
        ? request.headers.origin
        : undefined;
      json(response, status, errorPayload(error), origin);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  listeningOrigin = `http://127.0.0.1:${address.port}`;

  return {
    origin: listeningOrigin,
    get tokenExpiresAt() {
      return latestTokenExpiry;
    },
    enqueue(message) {
      if (message.type === "reference-capture") return queue.enqueue(ObsidianReferenceCaptureV2Schema.parse(message));
      if (message.type === "reference-delete-request") {
        const deletion = ReferenceDeleteRequestV2Schema.parse(message);
        queue.cancelReferenceDeepLinks(deletion.referenceId);
        return queue.enqueue(deletion);
      }
      const legacy = parseBridgeMessage(message);
      if (legacy.type !== "deep-link") throw new TypeError("Only deep links, reference captures and reference deletions are queueable");
      return queue.enqueue(legacy as QueuedBridgeMessage);
    },
    async close() {
      if (closed) return;
      closed = true;
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    },
  };
}
