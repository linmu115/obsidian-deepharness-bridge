import { Notice, PluginSettingTab, Setting, type App } from "obsidian";

import type { PendingReferenceRecord } from "../migrations/v1-pending.ts";
import { normalizeLoopbackOrigin, validateBridgePort, type DeepHarnessBridgeSettings } from "../settings.ts";
import { buildPendingReferenceRows, type PendingReferenceListOwner } from "./pending-reference-list.ts";
import { renderBindingSettings, type BindingSettingsOwner } from './binding-settings.ts';

export interface BridgeSettingsOwner extends PendingReferenceListOwner, Partial<BindingSettingsOwner> {
  settings: DeepHarnessBridgeSettings;
  bridgeStatus: string;
  pendingReferences: readonly PendingReferenceRecord[];
  updateSettings(patch: Partial<DeepHarnessBridgeSettings>): Promise<void>;
  connectionSummary?(): string;
  recoverySummary?(): string;
  retryPendingWork?(): Promise<void>;
}

export class DeepHarnessSettingTab extends PluginSettingTab {
  private refreshTimer: ReturnType<typeof setInterval> | undefined;
  private disposeBinding: (() => void) | undefined;
  constructor(app: App, private readonly owner: BridgeSettingsOwner) {
    super(app, owner as never);
  }

  display(): void {
    this.hide();
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "DeepHarness Bridge" });
    if (this.owner.bindingSnapshot && this.owner.discoverInstances && this.owner.changeVaultBinding)
      this.disposeBinding = renderBindingSettings(containerEl, this.owner as BindingSettingsOwner, this.owner.settings.dshOrigin);
    const draft = { ...this.owner.settings };
    let portText = String(draft.bridgePort);

    new Setting(containerEl)
      .setName("DSH Web 地址")
      .setDesc('旧版地址和手动发现候选。保存地址不会绑定实例，也不会覆盖已绑定实例的实时 Viewer。')
      .addText((text) => text
        .setValue(this.owner.settings.dshOrigin)
        .onChange((value) => { draft.dshOrigin = value; }));

    new Setting(containerEl)
      .setName("DSH 启动日志")
      .setDesc("保留旧版配置；新版绑定后只采用已核验实例的实时连接，不用此日志覆盖 Viewer。")
      .addText((text) => text
        .setPlaceholder("选择你自己的 DSH 启动日志文件（可选）")
        .setValue(this.owner.settings.dshLaunchLogPath)
        .onChange((value) => { draft.dshLaunchLogPath = value.trim(); }));

    new Setting(containerEl)
      .setName("Bridge 端口")
      .setDesc('0 表示自动分配；指定端口被其他 Vault 占用时自动选择可用端口。实际地址见连接状态。')
      .addText((text) => text
        .setValue(String(this.owner.settings.bridgePort))
        .onChange((value) => { portText = value; }));

    new Setting(containerEl)
      .setName("伴生笔记目录")
      .addText((text) => text
        .setValue(this.owner.settings.companionDirectory)
        .onChange((value) => { draft.companionDirectory = value; }));

    new Setting(containerEl)
      .setName("应用设置")
      .setDesc("编辑完成后一次应用连接和目录设置。")
      .addButton((button) => button.setButtonText("应用").setCta().onClick(async () => {
        button.setDisabled(true);
        try {
          if (!portText.trim()) throw new Error("请填写 Bridge 端口");
          await this.runRowAction(async () => {
            await this.owner.updateSettings({ ...draft,
              dshOrigin: normalizeLoopbackOrigin(draft.dshOrigin),
              bridgePort: validateBridgePort(Number(portText)),
            });
          }, "设置已应用");
        } catch (error) { new Notice(error instanceof Error ? error.message : String(error)); }
        finally { button.setDisabled(false); }
      }));

    const connection = new Setting(containerEl).setName("连接状态");
    const recovery = new Setting(containerEl).setName("引用同步");
    const refreshStatus = () => {
      connection.setDesc(this.owner.connectionSummary?.() ?? this.owner.bridgeStatus);
      recovery.setDesc(this.owner.recoverySummary?.() ?? "待处理引用可在下方打开或取消。");
    };
    refreshStatus();
    this.refreshTimer = setInterval(refreshStatus, 1000);
    if (this.owner.retryPendingWork) recovery.addButton((button) => button
      .setButtonText("重试待处理操作")
      .onClick(() => this.runRowAction(() => this.owner.retryPendingWork!(), "已重试待处理操作")));
    recovery.addButton((button) => button.setButtonText("刷新列表").onClick(() => this.display()));

    const pendingRows = buildPendingReferenceRows(this.owner);
    if (pendingRows.length === 0) return;

    containerEl.createEl("h3", { text: "待处理引用" });
    containerEl.createEl("p", {
      text: "等待接收的引用会在 DSH 会话可用后继续处理；已接收的引用会随提问写回。旧版引用需手动确认发送。",
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
      if (row.canDiscard) setting.addButton((button) => button
        .setButtonText("丢弃")
        .setWarning()
        .onClick(() => this.runRowAction(() => row.discard(), "引用记录已丢弃")));
    }
  }

  hide(): void {
    this.disposeBinding?.(); this.disposeBinding = undefined;
    if (this.refreshTimer !== undefined) clearInterval(this.refreshTimer);
    this.refreshTimer = undefined;
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
