import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { z } from "zod";

import {
  openNoteActionSchema,
  parseBridgeMessage,
  PROTOCOL_VERSION,
  resolvedCitationSchema,
  sessionNoteDocumentSchema,
  stickerBacklinkSchema,
  stickerBacklinkTargetSchema,
  type OpenNoteAction,
  type ResolvedCitation,
  type SessionNoteDocument,
  type StickerBacklink,
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
  origin: string;
  expiresAt: number;
}

export interface CitationResolutionLocation {
  notePath: string;
  blockId: string;
}

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
  onResolveCitation?: (citation: ResolvedCitation) => Promise<CitationResolutionLocation>;
  onOpenNote?: (action: OpenNoteAction) => Promise<void>;
  onReadSessionNote?: (sessionId: string) => Promise<SessionNoteDocument | null>;
  onSaveSessionNote?: (request: SaveSessionNoteRequest) => Promise<{ revision: string }>;
  onListStickerBacklinks?: (target: StickerBacklinkTarget) => Promise<StickerBacklink[]>;
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

const handshakeSchema = z.object({ clientId: z.string().min(1).max(128) });
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

function errorPayload(error: unknown): { error: string } {
  if (error instanceof Error) return { error: error.message };
  return { error: "Unknown bridge error" };
}

function applicationErrorStatus(error: unknown): number | null {
  if (!error || typeof error !== "object" || !("code" in error)) return null;
  const code = (error as { code?: unknown }).code;
  if (code === "REVISION_CONFLICT" || code === "CORRUPT_MARKER") return 409;
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
  const tokens = new Map<string, TokenRecord>();
  const resolvedCitations = new Map<string, { request: string; result: CitationResolutionLocation }>();
  const inMemoryNotes = new Map<string, SessionNoteDocument>();
  let latestTokenExpiry: number | null = null;
  let closed = false;

  const server = createServer((request, response) => {
    void (async () => {
      const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
      const originHeader = request.headers.origin;
      const requestOrigin = typeof originHeader === "string" ? originHeader : undefined;
      const allowedOrigin = requestOrigin && allowedOrigins.has(requestOrigin) ? requestOrigin : undefined;
      if (!allowedOrigin) throw new HttpError(403, "Request origin is not allowed");

      if (request.method === "OPTIONS") {
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

      if (request.method === "POST" && requestUrl.pathname === "/v1/handshake") {
        const input = handshakeSchema.parse(await readJsonBody(request, maxBodyBytes));
        for (const [token, record] of tokens) {
          if (record.clientId === input.clientId) tokens.delete(token);
        }
        const token = randomBytes(32).toString("base64url");
        const expiresAt = now() + tokenTtlMs;
        tokens.set(token, { clientId: input.clientId, origin: allowedOrigin, expiresAt });
        latestTokenExpiry = expiresAt;
        json(response, 200, { protocolVersion: PROTOCOL_VERSION, clientId: input.clientId, token, expiresAt }, allowedOrigin);
        return;
      }

      const token = bearerToken(request);
      const authentication = token ? tokens.get(token) : undefined;
      if (!authentication || authentication.origin !== allowedOrigin || authentication.expiresAt <= now()) {
        if (token) tokens.delete(token);
        throw new HttpError(401, "Handshake token is missing or expired");
      }

      if (request.method === "GET" && requestUrl.pathname === "/v1/actions/next") {
        const afterText = requestUrl.searchParams.get("after") ?? "0";
        const after = Number(afterText);
        if (!Number.isInteger(after) || after < 0) throw new HttpError(400, "Action cursor must be a non-negative integer");
        json(response, 200, queue.pending(authentication.clientId, after), allowedOrigin);
        return;
      }

      const ackMatch = /^\/v1\/actions\/([^/]+)\/ack$/.exec(requestUrl.pathname);
      if (request.method === "POST" && ackMatch) {
        await readJsonBody(request, maxBodyBytes);
        const actionId = decodeURIComponent(ackMatch[1] ?? "");
        if (!queue.acknowledge(authentication.clientId, actionId)) throw new HttpError(404, "Action was not found");
        json(response, 200, { acknowledged: true, actionId }, allowedOrigin);
        return;
      }

      if (request.method === "POST" && requestUrl.pathname === "/v1/citations/resolve") {
        const citation = resolvedCitationSchema.parse(await readJsonBody(request, maxBodyBytes));
        const requestKey = canonical(citation);
        const existing = resolvedCitations.get(citation.citationId);
        if (existing) {
          if (existing.request !== requestKey) throw new HttpError(409, "Citation ID was already resolved with different content");
          json(response, 200, existing.result, allowedOrigin);
          return;
        }
        const result = await (options.onResolveCitation?.(citation) ?? Promise.resolve({ notePath: "", blockId: "" }));
        resolvedCitations.set(citation.citationId, { request: requestKey, result });
        json(response, 200, result, allowedOrigin);
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

  return {
    origin: `http://127.0.0.1:${address.port}`,
    get tokenExpiresAt() {
      return latestTokenExpiry;
    },
    enqueue(message) {
      return queue.enqueue(parseBridgeMessage(message) as QueuedBridgeMessage);
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
