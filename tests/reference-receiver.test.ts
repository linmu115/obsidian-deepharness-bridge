import { afterEach, expect, it, vi } from "vitest";
import { startBridgeServer, type RunningBridge } from "../src/bridge/server.ts";
import { createObsidianReferenceCapture } from "../src/vault/reference-source.ts";

const origin = "http://127.0.0.1:51882";
const surface = "7b31f255-d087-4f8e-bdd6-d09a61860819";
const otherSurface = "a2e5d29d-d44f-4e8e-bf5d-fe209f016196";
const bridges: RunningBridge[] = [];
afterEach(async () => { await Promise.all(bridges.splice(0).map(bridge => bridge.close())); });

async function start(referenceSurfaceId: string | undefined = surface) {
  const claimed = vi.fn(async () => {});
  const bridge = await startBridgeServer({ port: 0, allowedDshOrigins: [origin],
    ...(referenceSurfaceId ? { referenceSurfaceId } : {}), onClaimReference: claimed });
  bridges.push(bridge);
  const capture = createObsidianReferenceCapture({ actionId: "routing-action", referenceId: "routing-reference", vaultId: "synthetic-vault",
    notePath: "synthetic.md", blockId: "source-block", occurrence: 0, selectedText: "quote", markdown: "quote ^source-block\n", capturedAt: 1 });
  bridge.enqueue({ ...capture, dshInstanceId: "same-instance" });
  const client = async (clientId: string, surfaceId?: string) => {
    const response = await fetch(bridge.origin + "/v2/handshake", { method: "POST", headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({ clientId, dshInstanceId: "same-instance", ...(surfaceId ? { surfaceId } : {}) }) });
    expect(response.status).toBe(200);
    const { token } = await response.json() as { token: string };
    const headers = { origin, authorization: `Bearer ${token}`, "content-type": "application/json" };
    return {
      pending: async () => (await fetch(bridge.origin + "/v2/actions/pending?after=0", { headers })).json() as Promise<{ actions: { message: { type: string } }[] }>,
      claim: () => fetch(bridge.origin + "/v2/actions/routing-action/ack", { method: "POST", headers,
        body: JSON.stringify({ annotationProtocolVersion: 2, type: "reference-claim", referenceId: capture.referenceId,
          profileId: "web", sessionId: "obsidian-session", setId: "set-one", dshInstanceId: "same-instance" }) }),
    };
  };
  return { bridge, claimed, client };
}

it("only delivers and acknowledges captures on the configured Obsidian page, including after an acknowledgement replay", async () => {
  const f = await start();
  const desktop = await f.client("desktop"), foreign = await f.client("another-page", otherSurface);
  for (const client of [desktop, foreign]) {
    expect((await client.pending()).actions).toEqual([]);
    expect((await client.claim()).status).toBe(409);
  }
  expect(f.claimed).not.toHaveBeenCalled();
  expect(f.bridge.diagnostics().activeActions).toBe(1);
  // Opening the legitimate page later receives the original queued capture.
  const embedded = await f.client("obsidian-page", surface);
  expect((await embedded.pending()).actions.map(x => x.message.type)).toEqual(["reference-capture"]);
  expect((await embedded.claim()).status).toBe(200);
  expect((await embedded.claim()).status).toBe(200);
  for (const client of [desktop, foreign]) expect((await client.claim()).status).toBe(409);
  expect(f.claimed).toHaveBeenCalledOnce();
  expect(f.bridge.diagnostics().activeActions).toBe(0);
});

it("retains captures when an Obsidian receiver has not been configured", async () => {
  const f = await start("");
  const candidate = await f.client("unconfigured-page", surface);
  expect((await candidate.pending()).actions).toEqual([]);
  expect((await candidate.claim()).status).toBe(409);
  expect(f.claimed).not.toHaveBeenCalled();
  expect(f.bridge.diagnostics().activeActions).toBe(1);
});

it("keeps ordinary deep-link navigation available in standalone DSH while captures remain private to Obsidian", async () => {
  const f = await start();
  f.bridge.enqueue({ protocolVersion: 1, type: "deep-link", actionId: "6f09f1be-5dc1-48e4-ac08-e3c05d70ac01", sessionId: "existing-session",
    anchorId: "existing-message", quoteHash: "sha256:30101ebf", dshInstanceId: "same-instance" });
  const desktop = await f.client("desktop");
  expect((await desktop.pending()).actions.map(x => x.message.type)).toEqual(["deep-link"]);
});
