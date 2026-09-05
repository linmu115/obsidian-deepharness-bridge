import { afterEach, describe, expect, it, vi } from "vitest";
import type { App } from "obsidian";
import { DEFAULT_SETTINGS } from "../src/settings.ts";
import { DeepHarnessSettingTab, type BridgeSettingsOwner } from "../src/ui/settings-tab.ts";

interface Control {
  label: string;
  value: string;
  disabled: boolean;
  change?: (value: string) => void;
  click?: () => Promise<void> | void;
}
interface Row { name: string; description: string; texts: Control[]; buttons: Control[] }
const { rows } = vi.hoisted(() => ({ rows: [] as Row[] }));

vi.mock("obsidian", () => {
  class Component implements Control {
    label = ""; value = ""; disabled = false;
    change?: (value: string) => void; click?: () => Promise<void> | void;
    setValue(value: string) { this.value = value; return this; }
    setPlaceholder() { return this; } setCta() { return this; } setWarning() { return this; }
    setButtonText(value: string) { this.label = value; return this; }
    setDisabled(value: boolean) { this.disabled = value; return this; }
    onChange(callback: (value: string) => void) { this.change = callback; return this; }
    onClick(callback: () => Promise<void> | void) { this.click = callback; return this; }
  }
  class Setting implements Row {
    name = ""; description = ""; texts: Component[] = []; buttons: Component[] = [];
    constructor() { rows.push(this); }
    setName(value: string) { this.name = value; return this; }
    setDesc(value: string) { this.description = value; return this; }
    addText(build: (component: Component) => void) { const component = new Component(); this.texts.push(component); build(component); return this; }
    addButton(build: (component: Component) => void) { const component = new Component(); this.buttons.push(component); build(component); return this; }
  }
  return { Notice: vi.fn(), Setting, PluginSettingTab: class {
    containerEl = { empty() { rows.length = 0; }, createEl() {} };
  } };
});

const tabs: DeepHarnessSettingTab[] = [];
afterEach(() => { for (const tab of tabs.splice(0)) tab.hide(); vi.useRealTimers(); });

function setup() {
  const owner: BridgeSettingsOwner = {
    settings: { ...DEFAULT_SETTINGS }, bridgeStatus: "starting", pendingReferences: [],
    updateSettings: vi.fn(async () => undefined), releaseMigratedReference: vi.fn(), discardReference: vi.fn(), openReferenceNote: vi.fn(),
    connectionSummary: vi.fn(() => "waiting"), recoverySummary: vi.fn(() => "pending"), retryPendingWork: vi.fn(async () => undefined),
  };
  const tab = new DeepHarnessSettingTab({} as App, owner); tabs.push(tab); tab.display();
  const row = (name: string) => rows.find((candidate) => candidate.name === name)!;
  return { owner, tab, row };
}

describe("explicit settings apply", () => {
  it("edits locally and submits one validated patch after Apply", async () => {
    const { owner, row } = setup();
    row("Bridge 端口").texts[0]!.change!("1"); row("Bridge 端口").texts[0]!.change!("18474");
    row("DSH Web 地址").texts[0]!.change!("http://127.0.0.1:51882");
    row("伴生笔记目录").texts[0]!.change!("NewFolder");
    expect(owner.updateSettings).not.toHaveBeenCalled();
    await row("应用设置").buttons[0]!.click!();
    expect(owner.updateSettings).toHaveBeenCalledOnce();
    expect(owner.updateSettings).toHaveBeenCalledWith(expect.objectContaining({ bridgePort: 18474, dshOrigin: "http://127.0.0.1:51882", companionDirectory: "NewFolder" }));
  });

  it("does not apply incomplete or invalid drafts", async () => {
    const { owner, row } = setup();
    for (const port of ["", "70000", "not-a-port"]) {
      row("Bridge 端口").texts[0]!.change!(port); await row("应用设置").buttons[0]!.click!();
    }
    expect(owner.updateSettings).not.toHaveBeenCalled();
  });

  it("refreshes live status without overwriting a draft and stops its timer on hide", () => {
    vi.useFakeTimers(); const { owner, row, tab } = setup();
    row("Bridge 端口").texts[0]!.change!("18474");
    vi.mocked(owner.connectionSummary!).mockReturnValue("connected");
    vi.advanceTimersByTime(1000);
    expect(row("连接状态").description).toBe("connected");
    expect(owner.updateSettings).not.toHaveBeenCalled();
    tab.hide(); expect(vi.getTimerCount()).toBe(0);
  });
});
