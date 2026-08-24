import { MarkdownView, Menu, Notice, Plugin } from "obsidian";

import { startBridgeServer, type RunningBridge } from "./bridge/server.ts";
import { OBSIDIAN_DEEPHARNESS_ACTION, obsidianProtocolUrl } from "./logical-link.ts";
import {
  discardPendingReference,
  migrateStoredPluginData,
  releaseMigratedReference as releaseMigratedRecord,
  type PendingReferenceRecord,
  type StoredPluginDataV2,
} from "./migrations/v1-pending.ts";
import {
  ObsidianReferenceCaptureV2Schema,
  canonicalSha256,
  type BacklinkCommitV2,
  type ObsidianReferenceCaptureV2,
  type ReferenceClaimV2,
  type ReferenceDiscardV2,
  type ReferenceRefreshRequestV2,
  type ReferenceRefreshResultV2,
} from "./protocol.ts";
import { registerEditorSelectionMenu, type NoteSelection } from "./selection/editor-menu.ts";
import { registerReadingSelectionMenu } from "./selection/reading-menu.ts";
import {
  DEFAULT_SETTINGS,
  normalizeLoopbackOrigin,
  validateBridgePort,
  type DeepHarnessBridgeSettings,
} from "./settings.ts";
import { DeepHarnessSettingTab, type BridgeSettingsOwner } from "./ui/settings-tab.ts";
import { ObsidianVaultAdapter } from "./vault/obsidian-adapter.ts";
import { commitReferenceBacklink } from "./vault/references.ts";
import { refreshObsidianReference } from "./vault/reference-source.ts";
import { readSessionNote, saveSessionNote } from "./vault/session-notes.ts";
import { listStickerBacklinks } from "./vault/sticker-backlinks.ts";
import { ensureDshWebViewer } from "./webviewer/adapter.ts";
import { handleDshUrl, registerDshLinkInterceptor } from "./webviewer/deep-link.ts";
import { ObsidianMainMarkdownWorkspace } from "./workspace/obsidian-adapter.ts";
import { openNoteInMainMarkdownLeaf } from "./workspace/open-note.ts";

function codedError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function captureOf(record: PendingReferenceRecord): ObsidianReferenceCaptureV2 | undefined {
  return record.state === "needs-reselect" ? undefined : record.capture;
}

export default class DeepHarnessBridgePlugin extends Plugin implements BridgeSettingsOwner {
  settings: DeepHarnessBridgeSettings = { ...DEFAULT_SETTINGS };
  bridgeStatus = "未启动";
  private bridge: RunningBridge | null = null;
  private data: StoredPluginDataV2 = {
    dataVersion: 2,
    vaultId: "uninitialized",
    settings: { ...DEFAULT_SETTINGS },
    pendingReferences: [],
    backlinkReceipts: [],
  };

  get pendingReferences(): readonly PendingReferenceRecord[] { return this.data.pendingReferences; }

  async onload(): Promise<void> {
    const raw = await this.loadData() as unknown;
    const legacySettings = typeof raw === "object" && raw !== null && "settings" in raw
      ? (raw as { settings?: Partial<DeepHarnessBridgeSettings> }).settings
      : undefined;
    const provisional = { ...DEFAULT_SETTINGS, ...(legacySettings ?? {}) };
    const migrationVault = new ObsidianVaultAdapter(this.app, provisional.companionDirectory);
    this.data = await migrateStoredPluginData(raw, {
      vault: migrationVault,
      defaultSettings: DEFAULT_SETTINGS,
      createVaultId: () => crypto.randomUUID(),
      createActionId: () => crypto.randomUUID(),
      now: Date.now,
    });
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...this.data.settings,
      dshOrigin: normalizeLoopbackOrigin(this.data.settings.dshOrigin),
      bridgePort: validateBridgePort(this.data.settings.bridgePort),
    };
    this.data = { ...this.data, settings: this.settings };
    await this.persist();

    const captureOptions = () => ({ vaultId: this.data.vaultId });
    registerEditorSelectionMenu(this, (selection) => this.queueReference(selection), captureOptions);
    registerReadingSelectionMenu(this, {
      markdownViewType: MarkdownView,
      createMenu: () => new Menu(),
      captureOptions,
      onCitation: (selection) => this.queueReference(selection),
    });
    registerDshLinkInterceptor(this, {
      app: this.app,
      dshUrl: () => this.settings.dshOrigin,
      enqueue: (action) => this.bridge?.enqueue(action),
      onError: (error) => new Notice(error instanceof Error ? error.message : String(error)),
    });
    this.registerObsidianProtocolHandler(OBSIDIAN_DEEPHARNESS_ACTION, (params) => {
      let value: string;
      try { value = obsidianProtocolUrl(params); }
      catch (error) { new Notice(error instanceof Error ? error.message : String(error)); return; }
      void handleDshUrl(value, {
        app: this.app,
        dshUrl: () => this.settings.dshOrigin,
        enqueue: (action) => this.bridge?.enqueue(action),
      }).catch((error: unknown) => new Notice(error instanceof Error ? error.message : String(error)));
    });
    this.addSettingTab(new DeepHarnessSettingTab(this.app, this));
    this.register(() => { void this.bridge?.close(); });
    await this.startBridge();
  }

  async updateSettings(patch: Partial<DeepHarnessBridgeSettings>): Promise<void> {
    const previousOrigin = this.settings.dshOrigin;
    const previousPort = this.settings.bridgePort;
    this.settings = { ...this.settings, ...patch };
    this.settings.dshOrigin = normalizeLoopbackOrigin(this.settings.dshOrigin);
    this.settings.bridgePort = validateBridgePort(this.settings.bridgePort);
    await this.persist();
    if (previousOrigin !== this.settings.dshOrigin || previousPort !== this.settings.bridgePort) {
      await this.bridge?.close();
      this.bridge = null;
      await this.startBridge();
    }
  }

  async releaseMigratedReference(referenceId: string): Promise<void> {
    const released = releaseMigratedRecord(this.data, referenceId);
    if (!released.changed || released.capture === undefined) return;
    this.data = released.data;
    await this.persist();
    this.bridge?.enqueue(released.capture);
  }

  async discardReference(referenceId: string): Promise<void> {
    const discarded = discardPendingReference(this.data, referenceId);
    if (!discarded.changed) return;
    this.data = discarded.data;
    await this.persist();
  }

  async openReferenceNote(record: PendingReferenceRecord): Promise<void> {
    const capture = captureOf(record);
    const notePath = capture?.source.locator.notePath ?? ("legacy" in record && "notePath" in record.legacy ? record.legacy.notePath : undefined);
    if (!notePath) return;
    await openNoteInMainMarkdownLeaf(new ObsidianMainMarkdownWorkspace(this.app), {
      protocolVersion: 1,
      type: "open-note",
      actionId: crypto.randomUUID(),
      notePath,
      ...(capture?.source.locator.blockId ? { blockId: capture.source.locator.blockId } : {}),
    });
  }

  private async persist(): Promise<void> {
    this.data = { ...this.data, settings: this.settings };
    await this.saveData(this.data);
  }

  private vaultAdapter(): ObsidianVaultAdapter {
    return new ObsidianVaultAdapter(this.app, this.settings.companionDirectory);
  }

  private async queueReference(selection: NoteSelection): Promise<void> {
    await ensureDshWebViewer(this.app, this.settings.dshOrigin);
    const { requiresBlockIdWrite: _uiOnly, ...rawCapture } = selection;
    const capture = ObsidianReferenceCaptureV2Schema.parse(rawCapture);
    const existing = this.data.pendingReferences.find((record) => captureOf(record)?.referenceId === capture.referenceId);
    if (existing !== undefined) {
      if (canonicalSha256(captureOf(existing)) !== canonicalSha256(capture)) {
        throw codedError("IDEMPOTENCY_CONFLICT", `Reference ID already exists: ${capture.referenceId}`);
      }
      if (existing.state === "queued") this.bridge?.enqueue(capture);
      return;
    }
    this.data = { ...this.data, pendingReferences: [...this.data.pendingReferences, { state: "queued", capture }] };
    await this.persist();
    this.bridge?.enqueue(capture);
    new Notice("已引用到 DSH");
  }

  private findCapture(referenceId: string): { index: number; record: Exclude<PendingReferenceRecord, { state: "needs-reselect" }> } {
    const index = this.data.pendingReferences.findIndex((record) => captureOf(record)?.referenceId === referenceId);
    const record = this.data.pendingReferences[index];
    if (index < 0 || record === undefined || record.state === "needs-reselect") {
      throw codedError("NOTE_NOT_FOUND", `Reference is unavailable: ${referenceId}`);
    }
    return { index, record };
  }

  private async claimReference(claim: ReferenceClaimV2): Promise<void> {
    const { index, record } = this.findCapture(claim.referenceId);
    if (record.state === "migrated-ready") throw codedError("IDEMPOTENCY_CONFLICT", "Migrated reference has not been released");
    if (record.state === "claimed") {
      if (canonicalSha256(record.claim) !== canonicalSha256(claim)) {
        throw codedError("IDEMPOTENCY_CONFLICT", "Reference was already claimed by another DSH target");
      }
      return;
    }
    const pendingReferences = [...this.data.pendingReferences];
    pendingReferences[index] = { state: "claimed", capture: record.capture, claim };
    this.data = { ...this.data, pendingReferences };
    await this.persist();
  }

  private async refreshReference(request: ReferenceRefreshRequestV2): Promise<ReferenceRefreshResultV2> {
    const { index, record } = this.findCapture(request.referenceId);
    if (record.capture.source.snapshot.documentHash !== request.knownDocumentHash) {
      throw codedError("SOURCE_CHANGED", "DSH requested refresh from an unknown snapshot");
    }
    const result = await refreshObsidianReference(this.vaultAdapter(), record.capture);
    if (result.kind === "refreshed") {
      const pendingReferences = [...this.data.pendingReferences];
      pendingReferences[index] = record.state === "claimed"
        ? { state: "claimed", capture: { ...record.capture, source: result.source }, claim: record.claim }
        : record.state === "migrated-ready"
          ? { state: "migrated-ready", capture: { ...record.capture, source: result.source }, legacy: record.legacy }
          : { state: "queued", capture: { ...record.capture, source: result.source } };
      this.data = { ...this.data, pendingReferences };
      await this.persist();
    }
    return result;
  }

  private async commitBacklink(commit: BacklinkCommitV2) {
    const { record } = this.findCapture(commit.referenceId);
    const existing = this.data.backlinkReceipts.find((receipt) => receipt.referenceId === commit.referenceId);
    const receipt = await commitReferenceBacklink(this.vaultAdapter(), record.capture, commit, existing);
    if (existing === undefined) {
      this.data = { ...this.data, backlinkReceipts: [...this.data.backlinkReceipts, receipt] };
      await this.persist();
    }
    return receipt;
  }

  private async startBridge(): Promise<void> {
    const vault = this.vaultAdapter();
    try {
      this.bridge = await startBridgeServer({
        port: this.settings.bridgePort,
        allowedDshOrigins: [this.settings.dshOrigin],
        onClaimReference: (claim) => this.claimReference(claim),
        onRefreshReference: (request) => this.refreshReference(request),
        onDiscardReference: async (request: ReferenceDiscardV2) => { await this.discardReference(request.referenceId); },
        onCommitBacklink: (commit) => this.commitBacklink(commit),
        onOpenNote: async (action) => {
          await openNoteInMainMarkdownLeaf(new ObsidianMainMarkdownWorkspace(this.app), action);
        },
        onListStickerBacklinks: (target) => listStickerBacklinks(vault, target),
        onReadSessionNote: (sessionId) => readSessionNote(vault, sessionId),
        onSaveSessionNote: ({ document, expectedRevision }) => saveSessionNote(vault, document, expectedRevision),
      });
      for (const record of this.data.pendingReferences) {
        if (record.state === "queued") this.bridge.enqueue(record.capture);
      }
      this.bridgeStatus = `已连接 ${this.bridge.origin}`;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.bridgeStatus = `启动失败：${message}`;
      new Notice(this.bridgeStatus);
    }
  }
}
