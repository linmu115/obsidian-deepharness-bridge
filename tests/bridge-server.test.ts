import { afterEach, describe, expect, it, vi } from "vitest";

import { startBridgeServer, type RunningBridge } from "../src/bridge/server.ts";
import type { BacklinkCommitV2, DeepLinkAction, ReferenceDeleteCommitV2, ReferenceDeleteRequestV2 } from "../src/protocol.ts";
import { createObsidianReferenceCapture } from "../src/vault/reference-source.ts";

const DSH_ORIGIN = "http://127.0.0.1:51882";
const openBridges: RunningBridge[] = [];

afterEach(async () => {
  await Promise.all(openBridges.splice(0).map((bridge) => bridge.close()));
});

async function start(options: Parameters<typeof startBridgeServer>[0] = {}): Promise<RunningBridge> {
  const bridge = await startBridgeServer({
    port: 0,
    allowedDshOrigins: [DSH_ORIGIN],
    ...options,
  });
  openBridges.push(bridge);
  return bridge;
}

async function request(
  bridge: RunningBridge,
  route: string,
  init: RequestInit = {},
): Promise<Response> {
  return fetch(`${bridge.origin}${route}`, init);
}

async function handshake(bridge: RunningBridge, origin = DSH_ORIGIN): Promise<string> {
  const response = await request(bridge, "/v1/handshake", {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ clientId: "dsh-web-test" }),
  });
  expect(response.status).toBe(200);
  return (await response.json() as { token: string }).token;
}

async function handshakeV2(bridge: RunningBridge, clientId = "dsh-web-v2"): Promise<string> {
  const response = await request(bridge, "/v2/handshake", {
    method: "POST",
    headers: { "content-type": "application/json", origin: DSH_ORIGIN },
    body: JSON.stringify({ clientId }),
  });
  expect(response.status).toBe(200);
  const body = await response.json() as { token: string; annotationProtocolVersion: number; capabilities: string[] };
  expect(body).toMatchObject({ annotationProtocolVersion: 2 });
  expect(body.capabilities).toEqual(expect.arrayContaining([
    "reference-capture-v2", "reference-refresh", "backlink-commit-v2", "reference-delete-v2",
  ]));
  return body.token;
}

function authorized(token: string, extra: HeadersInit = {}): HeadersInit {
  return { authorization: `Bearer ${token}`, origin: DSH_ORIGIN, ...extra };
}

const firstAction: DeepLinkAction = {
  protocolVersion: 1,
  type: "deep-link",
  actionId: "6f09f1be-5dc1-48e4-ac08-e3c05d70ac01",
  sessionId: "session-demo",
  anchorId: "user-node-42",
  quoteHash: "sha256:30101ebf",
};

describe("loopback bridge server", () => {
  it("reports the v2 annotation capabilities without changing sticker protocol v1", async () => {
    const bridge = await start();
    const v2 = await request(bridge, "/v2/health", { headers: { origin: DSH_ORIGIN } });
    expect(v2.status).toBe(200);
    expect(await v2.json()).toMatchObject({
      annotationProtocolVersion: 2,
      stickerProtocolVersion: 1,
      bridgeOrigin: bridge.origin,
      status: "ok",
    });
  });

  it("accepts the loopback Host without a browser Origin and binds its token to that caller", async () => {
    const bridge = await start();
    const health = await request(bridge, "/v2/health");
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ bridgeOrigin: bridge.origin });

    const handshakeResponse = await request(bridge, "/v2/handshake", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientId: "dsh-host" }),
    });
    expect(handshakeResponse.status).toBe(200);
    const handshakeBody = await handshakeResponse.json() as { token: string; bridgeOrigin: string };
    expect(handshakeBody.bridgeOrigin).toBe(bridge.origin);

    const localRequest = await request(bridge, "/v2/actions/pending?after=0", {
      headers: { authorization: `Bearer ${handshakeBody.token}` },
    });
    expect(localRequest.status).toBe(200);

    const browserReuse = await request(bridge, "/v2/actions/pending?after=0", {
      headers: authorized(handshakeBody.token),
    });
    expect(browserReuse.status).toBe(401);
  });

  it("binds only to loopback and reports protocol health", async () => {
    const bridge = await start();
    expect(new URL(bridge.origin).hostname).toBe("127.0.0.1");

    const response = await request(bridge, "/v1/health", {
      headers: { origin: DSH_ORIGIN },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ protocolVersion: 1, status: "ok" });
    expect(response.headers.get("access-control-allow-origin")).toBe(DSH_ORIGIN);
  });

  it("rejects non-allowlisted origins and expires handshake tokens", async () => {
    let timestamp = 1_000;
    const bridge = await start({ tokenTtlMs: 1_000, now: () => timestamp });

    const denied = await request(bridge, "/v1/handshake", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://example.com" },
      body: JSON.stringify({ clientId: "outside" }),
    });
    expect(denied.status).toBe(403);
    expect(denied.headers.get("access-control-allow-origin")).toBeNull();

    const token = await handshake(bridge);
    expect(bridge.tokenExpiresAt).toBe(2_000);
    timestamp += 1_001;
    const expired = await request(bridge, "/v1/actions/next?after=0", {
      headers: authorized(token),
    });
    expect(expired.status).toBe(401);
  });

  it("keeps FIFO actions until the client acknowledges them", async () => {
    const bridge = await start();
    const token = await handshake(bridge);
    const secondAction: DeepLinkAction = {
      ...firstAction,
      actionId: "c0a40c45-45f1-4ccb-b0e6-e34584c7fb2a",
      anchorId: "assistant-node-43",
    };
    bridge.enqueue(firstAction);
    bridge.enqueue(secondAction);

    const pending = await request(bridge, "/v1/actions/next?after=0", {
      headers: authorized(token),
    });
    expect(pending.status).toBe(200);
    expect(await pending.json()).toEqual({
      cursor: 2,
      actions: [
        { cursor: 1, message: firstAction },
        { cursor: 2, message: secondAction },
      ],
    });

    const ack = await request(bridge, `/v1/actions/${firstAction.actionId}/ack`, {
      method: "POST",
      headers: authorized(token, { "content-type": "application/json" }),
      body: "{}",
    });
    expect(ack.status).toBe(200);
    const remaining = await request(bridge, "/v1/actions/next?after=0", {
      headers: authorized(token),
    });
    expect(await remaining.json()).toEqual({
      cursor: 2,
      actions: [{ cursor: 2, message: secondAction }],
    });
  });

  it("does not expose v2 reference captures through the historical v1 action route", async () => {
    const bridge = await start();
    const token = await handshake(bridge);
    bridge.enqueue(createObsidianReferenceCapture({
      actionId: "action-v2",
      referenceId: "reference-v2",
      vaultId: "vault-1",
      notePath: "note.md",
      blockId: "block-1",
      occurrence: 0,
      selectedText: "引用",
      markdown: "引用 ^block-1\n",
      capturedAt: 100,
    }));
    const pending = await request(bridge, "/v1/actions/next?after=0", {
      headers: authorized(token),
    });
    expect(await pending.json()).toEqual({ cursor: 1, actions: [] });
    const removedResolver = await request(bridge, "/v1/citations/resolve", {
      method: "POST",
      headers: authorized(token, { "content-type": "application/json" }),
      body: "{}",
    });
    expect(removedResolver.status).toBe(404);
  });

  it("returns validated backlinks for a sticker identity", async () => {
    const onListStickerBacklinks = vi.fn(async () => [{
      notePath: "项目/架构.md",
      line: 12,
      column: 4,
      blockId: "sticker-reference",
      heading: "插件架构",
      excerpt: "回到贴纸",
    }]);
    const bridge = await start({ onListStickerBacklinks });
    const token = await handshake(bridge);
    const query = new URLSearchParams({
      stickerId: "9bb3a80e-230d-44d1-a37c-f7b79d2bf315",
      sessionId: "session-demo",
      anchorId: "user-node-42",
      quoteHash: "sha256:30101ebf",
    });

    const response = await request(bridge, `/v1/sticker-backlinks?${query}`, {
      headers: authorized(token),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ backlinks: await onListStickerBacklinks.mock.results[0]?.value });
    expect(onListStickerBacklinks).toHaveBeenCalledWith({
      stickerId: "9bb3a80e-230d-44d1-a37c-f7b79d2bf315",
      sessionId: "session-demo",
      anchorId: "user-node-42",
      quoteHash: "sha256:30101ebf",
    });
  });

  it("returns bounded parsing errors and releases the listening port", async () => {
    const bridge = await start({ maxBodyBytes: 64 });
    const malformed = await request(bridge, "/v1/handshake", {
      method: "POST",
      headers: { "content-type": "application/json", origin: DSH_ORIGIN },
      body: "{",
    });
    expect(malformed.status).toBe(400);

    const wrongType = await request(bridge, "/v1/handshake", {
      method: "POST",
      headers: { "content-type": "text/plain", origin: DSH_ORIGIN },
      body: "{}",
    });
    expect(wrongType.status).toBe(400);

    const tooLarge = await request(bridge, "/v1/handshake", {
      method: "POST",
      headers: { "content-type": "application/json", origin: DSH_ORIGIN },
      body: JSON.stringify({ clientId: "x".repeat(100) }),
    });
    expect(tooLarge.status).toBe(413);

    const origin = bridge.origin;
    await bridge.close();
    openBridges.splice(openBridges.indexOf(bridge), 1);
    await expect(fetch(`${origin}/v1/health`)).rejects.toThrow();
  });

  it("maps Vault revision conflicts to HTTP 409", async () => {
    const bridge = await start({
      onSaveSessionNote: async () => {
        throw Object.assign(new Error("stale revision"), { code: "REVISION_CONFLICT" });
      },
    });
    const token = await handshake(bridge);
    const response = await request(bridge, "/v1/session-notes/session-demo", {
      method: "PUT",
      headers: authorized(token, { "content-type": "application/json" }),
      body: JSON.stringify({
        document: {
          protocolVersion: 1,
          type: "session-note",
          sessionId: "session-demo",
          revision: "sha256:old",
          stickers: [],
        },
        expectedRevision: "sha256:old",
      }),
    });

    expect(response.status).toBe(409);
  });

  it("claims a queued v2 capture globally and makes identical retries idempotent", async () => {
    const onClaimReference = vi.fn(async () => undefined);
    const bridge = await start({ onClaimReference });
    const capture = createObsidianReferenceCapture({
      actionId: "action-v2", referenceId: "reference-v2", vaultId: "vault-1", notePath: "note.md",
      blockId: "block-1", occurrence: 0, selectedText: "引用", markdown: "引用 ^block-1\n", capturedAt: 100,
    });
    bridge.enqueue(capture);
    const token = await handshakeV2(bridge);
    const pending = await request(bridge, "/v2/actions/pending?after=0", { headers: authorized(token) });
    expect(await pending.json()).toMatchObject({ actions: [{ cursor: 1, message: capture }] });

    const claim = {
      annotationProtocolVersion: 2, type: "reference-claim", referenceId: capture.referenceId,
      profileId: "web", sessionId: "session-1", setId: "set-1",
    } as const;
    const ack = () => request(bridge, `/v2/actions/${capture.actionId}/ack`, {
      method: "POST", headers: authorized(token, { "content-type": "application/json" }), body: JSON.stringify(claim),
    });
    expect((await ack()).status).toBe(200);
    expect((await ack()).status).toBe(200);
    expect(onClaimReference).toHaveBeenCalledTimes(1);

    const secondToken = await handshakeV2(bridge, "dsh-web-second");
    const afterClaim = await request(bridge, "/v2/actions/pending?after=0", { headers: authorized(secondToken) });
    expect(await afterClaim.json()).toMatchObject({ actions: [] });
    const conflict = await request(bridge, `/v2/actions/${capture.actionId}/ack`, {
      method: "POST", headers: authorized(token, { "content-type": "application/json" }),
      body: JSON.stringify({ ...claim, sessionId: "other-session" }),
    });
    expect(conflict.status).toBe(409);
  });

  it("queues and acknowledges a durable reference deletion request", async () => {
    const bridge = await start();
    const deletion: ReferenceDeleteRequestV2 = {
      annotationProtocolVersion: 2,
      type: "reference-delete-request",
      actionId: "delete-action-1",
      referenceId: "reference-v2",
      profileId: "web",
      sessionId: "session-1",
      setId: "set-1",
      requestedAt: 100,
    };
    bridge.enqueue(deletion);
    const token = await handshakeV2(bridge);
    const pending = await request(bridge, "/v2/actions/pending?after=0", { headers: authorized(token) });
    expect(await pending.json()).toMatchObject({ actions: [{ cursor: 1, message: deletion }] });

    const ack = await request(bridge, `/v1/actions/${deletion.actionId}/ack`, {
      method: "POST",
      headers: authorized(token, { "content-type": "application/json" }),
      body: "{}",
    });
    expect(ack.status).toBe(200);
    const afterAck = await request(bridge, "/v2/actions/pending?after=0", { headers: authorized(token) });
    expect(await afterAck.json()).toMatchObject({ actions: [] });
  });

  it("serves refresh, discard, backlink commit and open-note v2 routes", async () => {
    const onRefreshReference = vi.fn(async () => ({ kind: "offline" as const }));
    const onDiscardReference = vi.fn(async () => undefined);
    const onCommitBacklink = vi.fn(async () => ({
      referenceId: "reference-v2", commitDigest: "sha256:30101ebf30101ebf30101ebf30101ebf30101ebf30101ebf30101ebf30101ebf",
      notePath: "note.md", blockId: "dsh-ref-reference", revision: "sha256:new", writtenAt: 100,
    }));
    const onDeleteCommittedReference = vi.fn(async () => undefined);
    const onOpenNote = vi.fn(async () => undefined);
    const bridge = await start({
      onRefreshReference, onDiscardReference, onCommitBacklink, onDeleteCommittedReference, onOpenNote,
    });
    const token = await handshakeV2(bridge);
    const jsonHeaders = authorized(token, { "content-type": "application/json" });

    const refresh = await request(bridge, "/v2/references/reference-v2/refresh", {
      method: "POST", headers: jsonHeaders,
      body: JSON.stringify({ annotationProtocolVersion: 2, type: "reference-refresh", referenceId: "reference-v2", knownDocumentHash: "sha256:30101ebf30101ebf30101ebf30101ebf30101ebf30101ebf30101ebf30101ebf" }),
    });
    expect(await refresh.json()).toEqual({ kind: "offline" });

    const discard = await request(bridge, "/v2/references/reference-v2/discard", {
      method: "POST", headers: jsonHeaders,
      body: JSON.stringify({ annotationProtocolVersion: 2, type: "reference-discard", referenceId: "reference-v2" }),
    });
    expect(discard.status).toBe(200);

    const commit: BacklinkCommitV2 = {
      annotationProtocolVersion: 2, type: "backlink-commit", referenceId: "reference-v2", setId: "set-1",
      profileId: "web", sessionId: "session-1", userMessageId: "user-1", userAnchorId: "anchor-1",
      userTextHash: "sha256:30101ebf30101ebf30101ebf30101ebf30101ebf30101ebf30101ebf30101ebf",
    };
    expect((await request(bridge, "/v2/backlinks/commit", { method: "POST", headers: jsonHeaders, body: JSON.stringify(commit) })).status).toBe(200);
    const deletion: ReferenceDeleteCommitV2 = {
      annotationProtocolVersion: 2, type: "reference-delete-commit", referenceId: "reference-v2",
      profileId: "web", sessionId: "session-1", setId: "set-1", deletedAt: 200,
    };
    expect((await request(bridge, "/v2/references/reference-v2/delete-commit", {
      method: "POST", headers: jsonHeaders, body: JSON.stringify(deletion),
    })).status).toBe(200);
    expect((await request(bridge, "/v2/obsidian/open-note", {
      method: "POST", headers: jsonHeaders,
      body: JSON.stringify({ protocolVersion: 1, type: "open-note", actionId: "00000000-0000-4000-8000-000000000001", notePath: "note.md", blockId: "block-1" }),
    })).status).toBe(200);
    expect(onRefreshReference).toHaveBeenCalledOnce();
    expect(onDiscardReference).toHaveBeenCalledOnce();
    expect(onCommitBacklink).toHaveBeenCalledOnce();
    expect(onDeleteCommittedReference).toHaveBeenCalledWith(deletion);
    expect(onOpenNote).toHaveBeenCalledOnce();
  });

  it("preserves typed application error codes in the HTTP response", async () => {
    const bridge = await start({
      onRefreshReference: async () => {
        throw Object.assign(new Error("source changed"), { code: "SOURCE_CHANGED" });
      },
    });
    const token = await handshakeV2(bridge);
    const response = await request(bridge, "/v2/references/reference-v2/refresh", {
      method: "POST",
      headers: authorized(token, { "content-type": "application/json" }),
      body: JSON.stringify({
        annotationProtocolVersion: 2,
        type: "reference-refresh",
        referenceId: "reference-v2",
        knownDocumentHash: "sha256:30101ebf30101ebf30101ebf30101ebf30101ebf30101ebf30101ebf30101ebf",
      }),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "source changed", code: "SOURCE_CHANGED" });
  });
});
