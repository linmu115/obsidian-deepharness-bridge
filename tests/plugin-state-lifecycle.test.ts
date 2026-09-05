import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { App, PluginManifest } from "obsidian";
import DeepHarnessBridgePlugin from "../src/main.ts";
import { startBridgeServer, type RunningBridge } from "../src/bridge/server.ts";
import { DEFAULT_SETTINGS } from "../src/settings.ts";
import type { PendingReferenceRecord, StoredPluginDataV2 } from "../src/migrations/v1-pending.ts";
import type { BacklinkCommitV2, ReferenceClaimV2, ReferenceRefreshRequestV2, ReferenceRefreshResultV2 } from "../src/protocol.ts";
import { createObsidianReferenceCapture } from "../src/vault/reference-source.ts";
import { ObsidianVaultAdapter } from "../src/vault/obsidian-adapter.ts";
import { syntheticApp } from "./helpers/obsidian-vault.ts";

vi.mock("obsidian", async () => {
  const stub = await import("./helpers/obsidian-vault.ts");
  class Plugin {
    constructor(public app: App, public manifest: PluginManifest) {}
    loadData = vi.fn(async (): Promise<unknown> => null);
    saveData = vi.fn(async (_data: unknown) => undefined);
    register = vi.fn(); registerEvent = vi.fn(); registerDomEvent = vi.fn();
    registerEditorExtension = vi.fn(); registerMarkdownPostProcessor = vi.fn();
    registerObsidianProtocolHandler = vi.fn(); addSettingTab = vi.fn();
  }
  return {
    Plugin, Notice: vi.fn(), MarkdownView: class {}, Menu: class {}, PluginSettingTab: class {}, Setting: class {},
    editorLivePreviewField: {}, TFile: stub.SyntheticFile, TFolder: stub.SyntheticFolder,
    normalizePath: stub.obsidianPath, parseLinktext: stub.parseSyntheticLink,
  };
});
vi.mock("../src/bridge/server.ts", () => ({ startBridgeServer: vi.fn() }));
vi.mock("../src/ui/block-id-display.ts", () => ({
  compactRenderedDshBlockIds: vi.fn(), createDshBlockIdCompactExtension: vi.fn(), hideRenderedDshReferenceBlocks: vi.fn(),
}));
vi.mock("../src/ui/sticker-backlink-display.ts", () => ({ compactRenderedDshStickerBacklinks: vi.fn(), createDshStickerBacklinkCompactExtension: vi.fn() }));
vi.mock("../src/webviewer/adapter.ts", () => ({ dshViewerUrlForSurface: (url: string) => url, ensureDshWebViewer: vi.fn(), provisionExistingDshWebViewer: vi.fn() }));

interface Internals {
  data: StoredPluginDataV2;
  adapter?: ObsidianVaultAdapter;
  bridge: RunningBridge | null;
  claimReference(claim: ReferenceClaimV2): Promise<void>;
  refreshReference(request: ReferenceRefreshRequestV2): Promise<ReferenceRefreshResultV2>;
  commitBacklink(commit: BacklinkCommitV2): Promise<unknown>;
  deleteReferencesForMarker(marker: string): Promise<void>;
}

const opened: DeepHarnessBridgePlugin[] = [];
const settings = { ...DEFAULT_SETTINGS, webViewerSurfaceId: "7b31f255-d087-4f8e-bdd6-d09a61860819" };
const manifest = { id: "obsidian-deepharness-bridge", name: "test", version: "test", minAppVersion: "1.0.0", author: "test", description: "synthetic" };

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve };
}

function claimed(referenceId: string, ownership: "pre-existing" | "plugin-created" = "pre-existing"): Extract<PendingReferenceRecord, { state: "claimed" }> {
  return {
    state: "claimed", blockIdOwnership: ownership,
    capture: createObsidianReferenceCapture({ actionId: `action-${referenceId}`, referenceId, vaultId: "synthetic", notePath: `${referenceId}.md`, blockId: `dsh-note-${referenceId}`, occurrence: 0, selectedText: "quote", markdown: `quote ^dsh-note-${referenceId}\n`, capturedAt: 1 }),
    claim: { annotationProtocolVersion: 2, type: "reference-claim", referenceId, profileId: "web", sessionId: "session", setId: `set-${referenceId}` },
  };
}

function bridgeStub(): RunningBridge {
  return {
    origin: "http://127.0.0.1:18473", tokenExpiresAt: null,
    identity: { instanceId: "synthetic", bootId: crypto.randomUUID(), bridgeVersion: "test", startedAt: 1 },
    status: vi.fn(() => ({ lifecycleProtocolVersion: 3, instanceId: "synthetic", bootId: crypto.randomUUID(), bridgeVersion: "test", startedAt: 1, state: "READY", stateChangedAt: 1, activeLeaseCount: 0, inFlightRequestCount: 0 } as const)),
    activeDshViewerUrl: vi.fn(), enqueue: vi.fn(() => 1), cancelReference: vi.fn(() => 1),
    restoreReferenceClaim: vi.fn(), diagnostics: vi.fn(() => ({ activeActions: 0, completedActions: 0, connectedClients: 0 })),
    close: vi.fn(async () => undefined),
  };
}

function fixture(records: PendingReferenceRecord[] = []) {
  const host = syntheticApp();
  const plugin = new DeepHarnessBridgePlugin(host.app, manifest); opened.push(plugin);
  plugin.settings = { ...settings };
  const internals = plugin as unknown as Internals;
  internals.data = { dataVersion: 2, vaultId: "synthetic", settings: plugin.settings, pendingReferences: records, backlinkReceipts: [], referenceDeleteRequests: [] };
  internals.adapter = new ObsidianVaultAdapter(host.app, settings.companionDirectory);
  internals.bridge = bridgeStub();
  for (const record of records) if (record.state !== "needs-reselect") host.put(record.capture.source.locator.notePath, record.capture.source.snapshot.markdown);
  return { ...host, plugin, internals };
}

beforeEach(() => { vi.stubGlobal("document", {}); vi.mocked(startBridgeServer).mockReset(); vi.mocked(startBridgeServer).mockImplementation(async () => bridgeStub()); });
afterEach(async () => { await Promise.all(opened.splice(0).map((plugin) => plugin.shutdown())); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("plugin state persistence and lifecycle", () => {
  it("does not start or save after unload during initial data loading", async () => {
    const { app } = syntheticApp(); const plugin = new DeepHarnessBridgePlugin(app, manifest); opened.push(plugin);
    const started = gate(); const release = gate();
    vi.mocked(plugin.loadData).mockImplementationOnce(async () => { started.resolve(); await release.promise; return null; });
    const loading = plugin.onload(); await started.promise;
    await plugin.shutdown(); release.resolve(); await loading;
    expect(plugin.saveData).not.toHaveBeenCalled(); expect(startBridgeServer).not.toHaveBeenCalled();
  });

  it("keeps a paused refresh, another discard, and a claim in order without overwriting a neighboring record", async () => {
    const a = claimed("a"); const b = claimed("b");
    const { plugin, internals, vault, put } = fixture([{ ...a, state: "queued" }, { ...b, state: "queued" }]);
    const started = gate(); const release = gate();
    put("b.md", "prefix\nquote ^dsh-note-b\n");
    vault.cachedRead.mockImplementationOnce(async () => { started.resolve(); await release.promise; return "prefix\nquote ^dsh-note-b\n"; });
    const refresh = internals.refreshReference({ annotationProtocolVersion: 2, type: "reference-refresh", referenceId: "b", knownDocumentHash: b.capture.source.snapshot.documentHash });
    await started.promise;
    const discard = plugin.discardReference("a"); const claim = internals.claimReference(b.claim);
    expect(plugin.saveData).not.toHaveBeenCalled();
    release.resolve(); await Promise.all([refresh, discard, claim]);
    expect(plugin.pendingReferences).toHaveLength(1);
    expect(plugin.pendingReferences[0]).toMatchObject({ state: "claimed", capture: { referenceId: "b", source: { snapshot: { markdown: "prefix\nquote ^dsh-note-b\n" } } } });
    const snapshots = vi.mocked(plugin.saveData).mock.calls.map(([data]) => structuredClone(data) as StoredPluginDataV2);
    expect(snapshots.map((data) => data.pendingReferences.length)).toEqual([2, 1, 1]);
  });

  it("keeps claimed but unsent references discardable and rejects discard after a backlink commit", async () => {
    const a = claimed("a"); const { plugin, internals } = fixture([a]);
    await plugin.discardReference("a"); expect(plugin.pendingReferences).toEqual([]);
    const b = claimed("b"); const next = fixture([b]);
    await next.internals.commitBacklink({ annotationProtocolVersion: 2, type: "backlink-commit", referenceId: "b", profileId: "web", sessionId: "session", setId: "set-b", userMessageId: "message", userAnchorId: "anchor", userTextHash: "sha256:text" });
    await expect(next.plugin.discardReference("b")).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect(next.internals.data.backlinkReceipts).toHaveLength(1);
    expect(internals.bridge?.cancelReference).toHaveBeenCalledWith("a");
  });

  it("rolls back a rejected persistence without poisoning a retry or cancelling delivery", async () => {
    const a = claimed("a"); const { plugin, internals } = fixture([a]);
    vi.mocked(plugin.saveData).mockRejectedValueOnce(new Error("disk unavailable"));
    await expect(plugin.discardReference("a")).rejects.toThrow("disk unavailable");
    expect(plugin.pendingReferences).toHaveLength(1);
    expect(internals.bridge?.cancelReference).not.toHaveBeenCalled();
    await plugin.discardReference("a"); expect(plugin.pendingReferences).toEqual([]);
  });

  it("recovers a written backlink whose receipt save failed and never treats it as an unsent discard", async () => {
    const { plugin, internals, files } = fixture([claimed("a")]);
    vi.mocked(plugin.saveData).mockRejectedValueOnce(new Error("receipt save interrupted"));
    await expect(internals.commitBacklink({ annotationProtocolVersion: 2, type: "backlink-commit", referenceId: "a", profileId: "web", sessionId: "session", setId: "set-a", userMessageId: "message", userAnchorId: "anchor", userTextHash: "sha256:text" }))
      .rejects.toThrow("receipt save interrupted");
    expect(internals.data.backlinkReceipts).toHaveLength(0);
    expect(files.get("a.md")).toContain("<!-- dsh-reference:");
    await expect(plugin.discardReference("a")).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    await internals.deleteReferencesForMarker("^dsh-note-a");
    expect(files.get("a.md")).not.toContain("<!-- dsh-reference:");
    expect(internals.data.referenceDeleteRequests).toHaveLength(1);
  });

  it("persists deletion outbox before touching the note and retains it when cleanup fails", async () => {
    const { plugin, internals, vault } = fixture([claimed("a", "plugin-created")]);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vault.process.mockImplementationOnce(async () => {
      expect(vi.mocked(plugin.saveData).mock.calls[0]?.[0]).toMatchObject({ referenceDeleteRequests: [{ referenceId: "a" }] });
      throw new Error("note temporarily unavailable");
    });
    await internals.deleteReferencesForMarker("^dsh-note-a");
    expect(internals.data.referenceDeleteRequests).toHaveLength(1);
    expect(internals.bridge?.enqueue).toHaveBeenCalledWith(expect.objectContaining({ type: "reference-delete-request", referenceId: "a" }));
    await plugin.retryPendingWork();
    expect(internals.data.referenceDeleteRequests).toHaveLength(1); // Only Core's commit may acknowledge this.
    expect(plugin.pendingReferences).toEqual([]);
  });

  it("serializes rapid settings applies and restarts for directory changes", async () => {
    const { plugin, internals } = fixture();
    const started = gate(); const release = gate();
    vi.mocked(internals.bridge!.close).mockImplementationOnce(async () => { started.resolve(); await release.promise; });
    const first = plugin.updateSettings({ bridgePort: 18474 }); await started.promise;
    const second = plugin.updateSettings({ bridgePort: 18475, companionDirectory: "Other" });
    expect(startBridgeServer).not.toHaveBeenCalled();
    release.resolve(); await Promise.all([first, second]);
    expect(vi.mocked(startBridgeServer).mock.calls.map(([options]) => options?.port)).toEqual([18474, 18475]);
    expect(plugin.settings).toMatchObject({ bridgePort: 18475, companionDirectory: "Other" });
    const calls = vi.mocked(startBridgeServer).mock.results;
    const firstNewBridge = await calls[0]!.value as RunningBridge;
    expect(firstNewBridge.close).toHaveBeenCalledOnce();
  });

  it("closes a late startup during shutdown and never republishes it", async () => {
    const { plugin, internals } = fixture(); const started = gate(); const release = gate();
    const late = bridgeStub(); internals.bridge = null;
    vi.mocked(startBridgeServer).mockImplementationOnce(async () => { started.resolve(); await release.promise; return late; });
    const starting = plugin.retryPendingWork(); await started.promise;
    const stopping = plugin.shutdown(); expect(plugin.shutdown()).toBe(stopping);
    release.resolve(); await Promise.all([starting, stopping]);
    expect(late.close).toHaveBeenCalledOnce(); expect(internals.bridge).toBeNull();
    expect(plugin.bridgeStatus).toBe("已关闭");
    await expect(plugin.updateSettings({ bridgePort: 1 })).rejects.toMatchObject({ code: "INVALID_STATE" });
  });

  it("waits for the previous instance's pending persistence before loading data on re-enable", async () => {
    const { plugin, app } = fixture([claimed("a")]); const started = gate(); const release = gate();
    vi.mocked(plugin.saveData).mockImplementationOnce(async () => { started.resolve(); await release.promise; });
    const discard = plugin.discardReference("a"); await started.promise;
    const stopping = plugin.shutdown();
    const replacement = new DeepHarnessBridgePlugin(app, manifest); opened.push(replacement);
    const loading = replacement.onload();
    await Promise.resolve(); expect(replacement.loadData).not.toHaveBeenCalled();
    release.resolve(); await Promise.all([discard, stopping, loading]);
    expect(replacement.loadData).toHaveBeenCalledOnce(); expect(replacement.bridgeStatus).toContain("等待 DSH");
  });
});
