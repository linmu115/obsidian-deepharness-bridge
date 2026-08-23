import { Notice, PluginSettingTab, Setting, type App } from "obsidian";

import { normalizeLoopbackOrigin, validateBridgePort, type DeepHarnessBridgeSettings } from "../settings.ts";

export interface BridgeSettingsOwner {
  settings: DeepHarnessBridgeSettings;
  bridgeStatus: string;
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
  }
}
