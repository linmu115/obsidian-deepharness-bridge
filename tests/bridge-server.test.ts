import { afterEach, describe, expect, it, vi } from "vitest";

import { startBridgeServer, type RunningBridge } from "../src/bridge/server.ts";
import type { DeepLinkAction, ResolvedCitation } from "../src/protocol.ts";

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

  it("resolves citations idempotently and rejects conflicting retries", async () => {
    const onResolveCitation = vi.fn(async () => ({ notePath: "架构/DSH维护引擎.md", blockId: "dsh-ref-a17" }));
    const bridge = await start({ onResolveCitation });
    const token = await handshake(bridge);
    const citation: ResolvedCitation = {
      protocolVersion: 1,
      type: "resolved-citation",
      citationId: "76213b70-7f6e-41be-b2e3-1b195cbf1268",
      sessionId: "session-demo",
      anchorId: "user-node-42",
      role: "user",
      quoteHash: "sha256:30101ebf",
    };
    const send = (value: ResolvedCitation) => request(bridge, "/v1/citations/resolve", {
      method: "POST",
      headers: authorized(token, { "content-type": "application/json" }),
      body: JSON.stringify(value),
    });

    expect((await send(citation)).status).toBe(200);
    expect((await send(citation)).status).toBe(200);
    expect(onResolveCitation).toHaveBeenCalledTimes(1);
    expect((await send({ ...citation, quoteHash: "sha256:different" })).status).toBe(409);
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
});
