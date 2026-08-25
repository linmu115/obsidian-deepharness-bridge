import { Notice, PluginSettingTab, Setting, type App } from "obsidian";

import type { PendingReferenceRecord } from "../migrations/v1-pending.ts";
import { normalizeLoopbackOrigin, validateBridgePort, type DeepHarnessBridgeSettings } from "../settings.ts";
import { buildPendingReferenceRows, type PendingReferenceListOwner } from "./pending-reference-list.ts";

export interface BridgeSettingsOwner extends PendingReferenceListOwner {
  settings: DeepHarnessBridgeSettings;
  bridgeStatus: string;
  pendingReferences: readonly PendingReferenceRecord[];
  updateSettings(patch: Partial<DeepHarnessBridgeSettings>): Promise<void>;
}

export class DeepHarnessSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly owner: BridgeSettingsOwner) {
    super(app, owner as never);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "DeepHarness Bridge" });

    new Setting(containerEl)
      .setName("DSH Web 地址")
      .addText((text) => text
        .setValue(this.owner.settings.dshOrigin)
        .onChange(async (value) => {
          try {
            await this.owner.updateSettings({ dshOrigin: normalizeLoopbackOrigin(value) });
          } catch (error) {
            new Notice(error instanceof Error ? error.message : String(error));
          }
        }));

    new Setting(containerEl)
      .setName("Bridge 端口")
      .addText((text) => text
        .setValue(String(this.owner.settings.bridgePort))
        .onChange(async (value) => {
          try {
            await this.owner.updateSettings({ bridgePort: validateBridgePort(Number(value)) });
          } catch (error) {
            new Notice(error instanceof Error ? error.message : String(error));
          }
        }));

    new Setting(containerEl)
      .setName("伴生笔记目录")
      .addText((text) => text
        .setValue(this.owner.settings.companionDirectory)
        .onChange(async (value) => {
          const directory = value.trim().replace(/^\/+|\/+$/g, "");
          if (directory) await this.owner.updateSettings({ companionDirectory: directory });
        }));

    new Setting(containerEl)
      .setName("连接状态")
      .setDesc(this.owner.bridgeStatus);

    const pendingRows = buildPendingReferenceRows(this.owner);
    if (pendingRows.length === 0) return;

    containerEl.createEl("h3", { text: "待处理的旧版引用" });
    containerEl.createEl("p", {
      text: "旧版引用不会自动发送到当前打开的会话。请逐条确认、发送或丢弃。",
      cls: "setting-item-description",
    });
    for (const row of pendingRows) {
      const setting = new Setting(containerEl)
        .setName(row.title)
        .setDesc(row.description);
      if (row.canOpen) {
        setting.addButton((button) => button
          .setButtonText("打开笔记")
          .onClick(() => this.runRowAction(() => row.open())));
      }
      if (row.canRelease) {
        setting.addButton((button) => button
          .setButtonText("发送到 DSH")
          .setCta()
          .onClick(() => this.runRowAction(() => row.release(), "已发送到 DSH")));
      }
      setting.addButton((button) => button
        .setButtonText("丢弃")
        .setWarning()
        .onClick(() => this.runRowAction(() => row.discard(), "引用记录已丢弃")));
    }
  }

  private async runRowAction(action: () => Promise<void>, successMessage?: string): Promise<void> {
    try {
      await action();
      if (successMessage) new Notice(successMessage);
      this.display();
    } catch (error) {
      new Notice(error instanceof Error ? error.message : String(error));
    }
  }
}
