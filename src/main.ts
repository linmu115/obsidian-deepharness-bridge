import { MarkdownView, Menu, Notice, Plugin } from "obsidian";

import { startBridgeServer, type RunningBridge } from "./bridge/server.ts";
import { parseBridgeMessage, type PendingCitation } from "./protocol.ts";
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
import { insertResolvedCitation } from "./vault/references.ts";
import { readSessionNote, saveSessionNote } from "./vault/session-notes.ts";
import { ensureDshWebViewer } from "./webviewer/adapter.ts";
import { registerDshLinkInterceptor } from "./webviewer/deep-link.ts";

interface StoredPluginData {
  settings?: Partial<DeepHarnessBridgeSettings>;
  pendingCitations?: PendingCitation[];
}

export default class DeepHarnessBridgePlugin extends Plugin implements BridgeSettingsOwner {
  settings: DeepHarnessBridgeSettings = { ...DEFAULT_SETTINGS };
  bridgeStatus = "未启动";
  private bridge: RunningBridge | null = null;
  private readonly pendingCitations = new Map<string, PendingCitation>();

  async onload(): Promise<void> {
    const stored = await this.loadData() as StoredPluginData | null;
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...stored?.settings,
    };
    this.settings.dshOrigin = normalizeLoopbackOrigin(this.settings.dshOrigin);
    this.settings.bridgePort = validateBridgePort(this.settings.bridgePort);
    for (const value of stored?.pendingCitations ?? []) {
      const message = parseBridgeMessage(value);
      if (message.type === "pending-citation") this.pendingCitations.set(message.citationId, message);
    }

    await this.startBridge();
    registerEditorSelectionMenu(this, (selection) => this.queueCitation(selection));
    registerReadingSelectionMenu(this, {
      markdownViewType: MarkdownView,
      createMenu: () => new Menu(),
      onCitation: (selection) => this.queueCitation(selection),
    });
    registerDshLinkInterceptor(this, {
      app: this.app,
      dshUrl: () => this.settings.dshOrigin,
      enqueue: (action) => this.bridge?.enqueue(action),
      onError: (error) => new Notice(error instanceof Error ? error.message : String(error)),
    });
    this.addSettingTab(new DeepHarnessSettingTab(this.app, this));
    this.register(() => { void this.bridge?.close(); });
  }

  async updateSettings(patch: Partial<DeepHarnessBridgeSettings>): Promise<void> {
    const previousOrigin = this.settings.dshOrigin;
    const previousPort = this.settings.bridgePort;
    this.settings = { ...this.settings, ...patch };
    await this.persist();
    if (previousOrigin !== this.settings.dshOrigin || previousPort !== this.settings.bridgePort) {
      await this.bridge?.close();
      this.bridge = null;
      await this.startBridge();
    }
  }

  private async persist(): Promise<void> {
    await this.saveData({
      settings: this.settings,
      pendingCitations: [...this.pendingCitations.values()],
    } satisfies StoredPluginData);
  }

  private vaultAdapter(): ObsidianVaultAdapter {
    return new ObsidianVaultAdapter(this.app, this.settings.companionDirectory);
  }

  private async queueCitation(selection: NoteSelection): Promise<void> {
    await ensureDshWebViewer(this.app, this.settings.dshOrigin);
    const pending = parseBridgeMessage(selection);
    if (pending.type !== "pending-citation") throw new Error("Selection did not produce a pending citation");
    this.pendingCitations.set(pending.citationId, pending);
    this.bridge?.enqueue(pending);
    await this.persist();
    new Notice("已引用到 DSH");
  }

  private async startBridge(): Promise<void> {
    const vault = this.vaultAdapter();
    try {
      this.bridge = await startBridgeServer({
        port: this.settings.bridgePort,
        allowedDshOrigins: [this.settings.dshOrigin],
        onResolveCitation: async (resolved) => {
          const pending = this.pendingCitations.get(resolved.citationId);
          if (!pending) throw new Error(`Pending citation is unavailable: ${resolved.citationId}`);
          const location = await insertResolvedCitation(vault, pending, resolved);
          this.pendingCitations.delete(resolved.citationId);
          await this.persist();
          return location;
        },
        onOpenNote: async (action) => {
          const subpath = action.blockId ? `#^${action.blockId}` : "";
          await this.app.workspace.openLinkText(`${action.notePath}${subpath}`, "", false);
        },
        onReadSessionNote: (sessionId) => readSessionNote(vault, sessionId),
        onSaveSessionNote: ({ document, expectedRevision }) => saveSessionNote(vault, document, expectedRevision),
      });
      this.bridgeStatus = `已连接 ${this.bridge.origin}`;
    } catch (error) {
      this.bridgeStatus = "启动失败";
      new Notice(error instanceof Error ? error.message : String(error));
      throw error;
    }
  }
}
