import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { App, PluginManifest } from "obsidian";
import DeepHarnessBridgePlugin from "../src/main.ts";
import { startBridgeServer, type RunningBridge } from "../src/bridge/server.ts";
import { DEFAULT_SETTINGS } from "../src/settings.ts";
import type { PendingReferenceRecord, StoredPluginDataV2 } from "../src/migrations/v1-pending.ts";
import type { BacklinkCommitV2, ReferenceClaimV2, ReferenceDeleteCommitV2, ReferenceRefreshRequestV2, ReferenceRefreshResultV2 } from "../src/protocol.ts";
import { createObsidianReferenceCapture } from "../src/vault/reference-source.ts";
import { ObsidianVaultAdapter } from "../src/vault/obsidian-adapter.ts";
import { syntheticApp } from "./helpers/obsidian-vault.ts";
import { ClientActionQueue } from "../src/bridge/queue.ts";
import { ensureDshWebViewer } from "../src/webviewer/adapter.ts";
import { captureEditorSelection, type NoteSelection } from "../src/selection/editor-menu.ts";

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
  queueReference(selection: NoteSelection): Promise<void>;
  resolveDshViewerUrl(): Promise<string>;
  claimReference(claim: ReferenceClaimV2): Promise<void>;
  refreshReference(request: ReferenceRefreshRequestV2): Promise<ReferenceRefreshResultV2>;
  commitBacklink(commit: BacklinkCommitV2): Promise<unknown>;
  deleteReferencesForMarker(marker: string): Promise<void>;
  deleteCommittedReference(commit: ReferenceDeleteCommitV2): Promise<void>;
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

beforeEach(() => { vi.stubGlobal("document", {}); vi.mocked(ensureDshWebViewer).mockReset(); vi.mocked(startBridgeServer).mockReset(); vi.mocked(startBridgeServer).mockImplementation(async () => bridgeStub()); });
afterEach(async () => { await Promise.all(opened.splice(0).map((plugin) => plugin.shutdown())); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("plugin state persistence and lifecycle", () => {
  it("protects a queued capture when an older reference sharing its marker is cancelled first", async () => {
    const a = claimed("a", "plugin-created");
    const { plugin, internals, files } = fixture([{ ...a, state: "queued" }]);
    const started = gate(); const release = gate();
    vi.mocked(plugin.saveData).mockImplementationOnce(async () => { started.resolve(); await release.promise; });
    vi.spyOn(internals, "resolveDshViewerUrl").mockResolvedValue("http://127.0.0.1:3080/");
    const blocking = plugin.updateSettings({ dshLaunchLogPath: "" }); await started.promise;
    const discard = plugin.discardReference("a");
    const second = internals.queueReference({ ...a.capture, actionId: "action-b", referenceId: "b", requiresBlockIdWrite: false, blockIdOwnership: "pre-existing" });
    release.resolve(); await Promise.all([blocking, discard, second]);
    expect(files.get("a.md")).toBe("quote ^dsh-note-a\n");
    expect(plugin.pendingReferences).toMatchObject([{ capture: { referenceId: "b" }, blockIdOwnership: "plugin-created" }]);
    await plugin.discardReference("b");
    expect(files.get("a.md")).toBe("quote\n");
  });

  it.each([true, false])("reserves a shared editor marker while an earlier save fails (second save succeeds: %s)", async (secondSucceeds) => {
    const { plugin, internals, put } = fixture(); put("editor.md", "quote\n");
    let value = "quote\n";
    const editor = {
      getSelection: () => "quote", getValue: () => value, getCursor: (which: "from" | "to") => ({ line: 0, ch: which === "from" ? 0 : 5 }),
      getLine: () => value.split("\n")[0]!,
      replaceRange: (text: string, from: { line: number; ch: number }, to = from) => { value = value.slice(0, from.ch) + text + value.slice(to.ch); },
    };
    const a = captureEditorSelection(editor, { path: "editor.md" }, { createReferenceId: () => "a" })!;
    const started = gate(); const release = gate();
    vi.spyOn(internals, "resolveDshViewerUrl").mockResolvedValue("http://127.0.0.1:3080/");
    vi.mocked(plugin.saveData).mockImplementationOnce(async () => { started.resolve(); await release.promise; throw new Error("first save failed"); });
    vi.mocked(plugin.saveData).mockImplementationOnce(async () => {
      expect(value).toBe("quote ^dsh-note-2d02ffd5\n");
      if (!secondSucceeds) throw new Error("second save failed");
    });
    const first = internals.queueReference(a); const firstResult = first.catch((error: Error) => error.message);
    await started.promise;
    const b = captureEditorSelection(editor, { path: "editor.md" }, { createReferenceId: () => "b" })!;
    expect(b.blockIdOwnership).toBe("pre-existing");
    const second = internals.queueReference(b); const secondResult = second.catch((error: Error) => error.message);
    release.resolve();
    expect(await firstResult).toBe("first save failed");
    expect(await secondResult).toBe(secondSucceeds ? undefined : "second save failed");
    if (secondSucceeds) {
      expect(plugin.pendingReferences).toMatchObject([{ state: "queued", capture: { referenceId: "b" }, blockIdOwnership: "plugin-created" }]);
      put("editor.md", value);
      await plugin.discardReference("b");
      expect(await internals.adapter!.read("editor.md")).toBe("quote\n");
    } else {
      expect(value).toBe("quote\n");
      expect(plugin.pendingReferences).toEqual([]);
    }
  });

  it("does not treat an identical block ID in another note as ownership of the failed capture marker", async () => {
    const other = claimed("other", "pre-existing");
    other.capture.source.locator.blockId = "dsh-note-a";
    const { plugin, internals, put, files } = fixture([other]);
    put("other.md", "quote ^dsh-note-a\n"); put("a.md", "quote ^dsh-note-a\n");
    const a = claimed("a", "plugin-created");
    vi.mocked(plugin.saveData).mockRejectedValueOnce(new Error("save failed"));
    await expect(internals.queueReference({ ...a.capture, requiresBlockIdWrite: false, blockIdOwnership: "plugin-created" })).rejects.toThrow("save failed");
    expect(files.get("a.md")).toBe("quote\n");
    expect(files.get("other.md")).toBe("quote ^dsh-note-a\n");
  });

  it("does not compensate an unflushed marker by deleting the same ID from a different note", async () => {
    const { plugin, internals, put, files } = fixture();
    put("a.md", "quote\n"); put("other.md", "user content ^dsh-note-a\n");
    const a = claimed("a", "plugin-created");
    vi.mocked(plugin.saveData).mockRejectedValueOnce(new Error("save failed"));
    await expect(internals.queueReference({ ...a.capture, requiresBlockIdWrite: false, blockIdOwnership: "plugin-created", rollbackBlockId() {} })).rejects.toThrow("save failed");
    expect(files.get("a.md")).toBe("quote\n");
    expect(files.get("other.md")).toBe("user content ^dsh-note-a\n");
  });

  it("cleans an orphan backlink after legacy state loss and rejects mismatched orphan metadata", async () => {
    const original = fixture([claimed("a")]);
    await original.internals.commitBacklink({ annotationProtocolVersion: 2, type: "backlink-commit", referenceId: "a", profileId: "web", sessionId: "session", setId: "set-a", userMessageId: "message", userAnchorId: "anchor", userTextHash: "sha256:text" });
    const orphan = original.files.get("a.md")!;
    const { plugin, internals, put, files } = fixture(); put("a.md", orphan);
    const commit: ReferenceDeleteCommitV2 = { annotationProtocolVersion: 2, type: "reference-delete-commit", referenceId: "a", profileId: "web", sessionId: "session", setId: "set-a", deletedAt: 1 };
    await expect(internals.deleteCommittedReference({ ...commit, sessionId: "wrong" })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect(files.get("a.md")).toBe(orphan);
    await internals.deleteCommittedReference(commit);
    expect(files.get("a.md")).not.toContain("<!-- dsh-reference:");
    expect(plugin.pendingReferences).toEqual([]);
    vi.mocked(plugin.saveData).mockRejectedValue(new Error("duplicate must not save"));
    await expect(internals.deleteCommittedReference(commit)).resolves.toBeUndefined();
  });

  it("compensates a selection rejected because the plugin has stopped", async () => {
    const { plugin, internals, put, files } = fixture();
    const a = claimed("a", "plugin-created"); put("a.md", "quote ^dsh-note-a\n");
    await plugin.shutdown();
    await expect(internals.queueReference({ ...a.capture, blockIdOwnership: "plugin-created", requiresBlockIdWrite: false })).rejects.toMatchObject({ code: "INVALID_STATE" });
    expect(files.get("a.md")).toBe("quote\n");
    expect(plugin.pendingReferences).toEqual([]);
  });

  it("keeps a durable capture recoverable when delivery rejects and retries against the current viewer URL", async () => {
    const { plugin, internals, put } = fixture();
    const a = claimed("a", "plugin-created"); put("a.md", "quote ^dsh-note-a\n");
    internals.bridge!.enqueue = () => { throw new Error("Bridge is stopping"); };
    const urls: string[] = [];
    let url = "http://127.0.0.1:3080/";
    vi.spyOn(internals, "resolveDshViewerUrl").mockImplementation(async () => url);
    vi.mocked(ensureDshWebViewer).mockImplementation(async (_app, target) => { urls.push(target); throw new Error("server stopped"); });
    await expect(internals.queueReference({ ...a.capture, blockIdOwnership: "plugin-created", requiresBlockIdWrite: false })).resolves.toBeUndefined();
    await new Promise((resolve) => setImmediate(resolve));
    expect(plugin.pendingReferences).toHaveLength(1);
    const queue = new ClientActionQueue(); internals.bridge!.enqueue = (message) => queue.enqueue(message);
    url = "http://127.0.0.1:45981/";
    await plugin.retryPendingWork();
    await new Promise((resolve) => setImmediate(resolve));
    expect(urls).toEqual(["http://127.0.0.1:3080/", "http://127.0.0.1:45981/"]);
    expect(queue.pending("surface", 0).actions.map(({ message }) => message.actionId)).toEqual(["action-a"]);
  });

  it.each(["profileId", "sessionId", "setId"] as const)("rejects a deletion with a wrong %s before cleaning a claimed marker", async (field) => {
    const { plugin, internals, files } = fixture([claimed("a", "plugin-created")]);
    await expect(internals.deleteCommittedReference({ annotationProtocolVersion: 2, type: "reference-delete-commit", referenceId: "a", profileId: "web", sessionId: "session", setId: "set-a", deletedAt: 1, [field]: "wrong" })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect(files.get("a.md")).toBe("quote ^dsh-note-a\n");
    expect(plugin.pendingReferences).toHaveLength(1);
  });

  it.each(["profileId", "sessionId", "setId"] as const)("rejects a wrong %s acknowledgement after local deletion leaves only the durable request", async (field) => {
    const { plugin, internals, files } = fixture([claimed("a", "plugin-created")]);
    await internals.deleteReferencesForMarker("^dsh-note-a");
    expect(plugin.pendingReferences).toEqual([]);
    await expect(internals.deleteCommittedReference({ annotationProtocolVersion: 2, type: "reference-delete-commit", referenceId: "a", profileId: "web", sessionId: "session", setId: "set-a", deletedAt: 1, [field]: "wrong" })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect(internals.data.referenceDeleteRequests).toMatchObject([{ referenceId: "a", profileId: "web", sessionId: "session", setId: "set-a" }]);
    expect(files.get("a.md")).toBe("quote\n");
  });

  it("retains deletion identity after a partial cleanup save and makes duplicate commits a no-op", async () => {
    const { plugin, internals, files } = fixture([claimed("a", "plugin-created")]);
    const commit: ReferenceDeleteCommitV2 = { annotationProtocolVersion: 2, type: "reference-delete-commit", referenceId: "a", profileId: "web", sessionId: "session", setId: "set-a", deletedAt: 1 };
    vi.mocked(plugin.saveData).mockImplementation(async (data) => {
      const value = data as StoredPluginDataV2;
      if (value.pendingReferences.length === 0 && value.referenceDeleteRequests.length === 0) throw new Error("ack save failed");
    });
    await expect(internals.deleteCommittedReference(commit)).rejects.toThrow("ack save failed");
    expect(internals.data.referenceDeleteRequests).toMatchObject([{ referenceId: "a", sessionId: "session", setId: "set-a" }]);
    await expect(internals.deleteCommittedReference({ ...commit, sessionId: "wrong" })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    vi.mocked(plugin.saveData).mockResolvedValue(undefined);
    await internals.deleteCommittedReference(commit);
    expect(plugin.pendingReferences).toEqual([]); expect(internals.data.referenceDeleteRequests).toEqual([]);
    expect(files.get("a.md")).toBe("quote\n");
    vi.mocked(plugin.saveData).mockRejectedValue(new Error("duplicate must not save"));
    await expect(internals.deleteCommittedReference(commit)).resolves.toBeUndefined();
  });

  it("rolls back a failed capture in the editor buffer before Obsidian flushes it to the vault", async () => {
    const { plugin, internals, put, files } = fixture(); put("editor.md", "quote\n");
    let value = "quote\n";
    const selection = captureEditorSelection({
      getSelection: () => "quote", getValue: () => value, getCursor: (which) => ({ line: 0, ch: which === "from" ? 0 : 5 }),
      getLine: () => value.split("\n")[0]!,
      replaceRange: (text, from, to = from) => { value = value.slice(0, from.ch) + text + value.slice(to.ch); },
    }, { path: "editor.md" })!;
    vi.spyOn(internals, "resolveDshViewerUrl").mockResolvedValue("http://127.0.0.1:3080/");
    vi.mocked(plugin.saveData).mockRejectedValueOnce(new Error("disk unavailable"));
    await expect(internals.queueReference(selection)).rejects.toThrow("disk unavailable");
    expect(value).toBe("quote\n");
    expect(files.get("editor.md")).toBe("quote\n");
    expect(plugin.pendingReferences).toEqual([]);
  });

  it("persists an offline capture before navigation and restores it into a fresh delivery queue", async () => {
    const a = claimed("a", "plugin-created");
    const { plugin, internals, put, files } = fixture();
    put("a.md", "quote ^dsh-note-a\n");
    const queue = new ClientActionQueue();
    internals.bridge!.enqueue = (message) => queue.enqueue(message);
    vi.spyOn(internals, "resolveDshViewerUrl").mockRejectedValue(new Error("DSH offline"));
    await expect(internals.queueReference({ ...a.capture, requiresBlockIdWrite: false, blockIdOwnership: "plugin-created" })).resolves.toBeUndefined();
    expect(plugin.pendingReferences).toMatchObject([{ state: "queued", capture: { referenceId: "a" } }]);
    const saved = structuredClone(vi.mocked(plugin.saveData).mock.calls.at(-1)![0]) as StoredPluginDataV2;
    expect(saved.pendingReferences).toMatchObject([{ capture: { referenceId: "a" }, blockIdOwnership: "plugin-created" }]);
    expect(queue.pending("surface", 0).actions.map(({ message }) => message.type)).toEqual(["reference-capture"]);
    expect(files.get("a.md")).toBe("quote ^dsh-note-a\n");
    await plugin.shutdown();
    const replacement = fixture(saved.pendingReferences);
    replacement.internals.bridge = null;
    const restored = new ClientActionQueue(); const bridge = bridgeStub();
    bridge.enqueue = (message) => restored.enqueue(message);
    vi.mocked(startBridgeServer).mockResolvedValueOnce(bridge);
    vi.spyOn(replacement.internals, "resolveDshViewerUrl").mockRejectedValue(new Error("still offline"));
    await replacement.plugin.retryPendingWork();
    expect(restored.pending("surface", 0).actions.map(({ message }) => message.actionId)).toEqual(["action-a"]);
  });

  it("does not hold state mutations or resurrect a cancelled capture while navigation is stalled", async () => {
    const { plugin, internals, put, files } = fixture();
    const a = claimed("a", "plugin-created"); put("a.md", "quote ^dsh-note-a\n");
    const queue = new ClientActionQueue(); internals.bridge!.enqueue = (message) => queue.enqueue(message);
    internals.bridge!.cancelReference = (id) => queue.cancelReference(id);
    vi.spyOn(internals, "resolveDshViewerUrl").mockResolvedValue("http://127.0.0.1:3080/");
    const started = gate(); const release = gate();
    vi.mocked(ensureDshWebViewer).mockImplementationOnce(async () => { started.resolve(); await release.promise; throw new Error("navigation failed"); });
    const capture = internals.queueReference({ ...a.capture, requiresBlockIdWrite: false, blockIdOwnership: "plugin-created" });
    await started.promise;
    try {
      expect(plugin.pendingReferences).toHaveLength(1);
      await plugin.discardReference("a");
      expect(files.get("a.md")).toBe("quote\n");
      expect(queue.pending("surface", 0).actions).toEqual([]);
    } finally { release.resolve(); await capture.catch(() => undefined); }
    expect(plugin.pendingReferences).toEqual([]);
    expect(queue.pending("surface", 0).actions).toEqual([]);
  });

  it.each(["plugin-created", "pre-existing"] as const)("compensates failed capture persistence only for a %s marker", async (ownership) => {
    const { plugin, internals, put, files } = fixture();
    const a = claimed("a", ownership); put("a.md", "quote ^dsh-note-a\n");
    vi.spyOn(internals, "resolveDshViewerUrl").mockResolvedValue("http://127.0.0.1:3080/");
    const queue = new ClientActionQueue(); internals.bridge!.enqueue = (message) => queue.enqueue(message);
    vi.mocked(plugin.saveData).mockRejectedValueOnce(new Error("disk unavailable"));
    await expect(internals.queueReference({ ...a.capture, requiresBlockIdWrite: false, blockIdOwnership: ownership })).rejects.toThrow("disk unavailable");
    expect(plugin.pendingReferences).toEqual([]);
    expect(queue.pending("surface", 0).actions).toEqual([]);
    expect(files.get("a.md")).toBe(ownership === "plugin-created" ? "quote\n" : "quote ^dsh-note-a\n");
  });

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
