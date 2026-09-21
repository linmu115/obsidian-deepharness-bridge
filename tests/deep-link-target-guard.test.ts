import { describe, expect, it, vi } from "vitest";
import type { App, PluginManifest } from "obsidian";

import DeepHarnessBridgePlugin from "../src/main.ts";
import { parseDshLogicalLink } from "../src/logical-link.ts";
import { collectManagedStickerBacklinks, hrefForTarget } from "../src/ui/sticker-backlink-display.ts";
import { renderStickerBlock } from "../src/vault/session-notes.ts";
import type { DeepLinkAction, StickerBacklinkTarget, StickerRecord } from "../src/protocol.ts";
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
    addCommand = vi.fn();
  }
  return {
    Plugin, Modal: class {}, Notice: vi.fn(), MarkdownView: class {}, Menu: class {}, PluginSettingTab: class {}, Setting: class {},
    editorLivePreviewField: {}, TFile: stub.SyntheticFile, TFolder: stub.SyntheticFolder,
    normalizePath: stub.obsidianPath, parseLinktext: stub.parseSyntheticLink,
  };
});
vi.mock("../src/bridge/server.ts", () => ({ startBridgeServer: vi.fn() }));
vi.mock("../src/binding/discovery.ts", () => ({ discoverInstances: vi.fn(async () => ({ instances: [], conflicts: 0 })), publishVault: vi.fn(async () => async () => undefined) }));
vi.mock("../src/vault/knowledge-file.ts", () => ({ knowledgeFile: () => ({ readState: async () => null, writeState: async () => undefined }) }));
vi.mock("../src/ui/block-id-display.ts", () => ({
  compactRenderedDshBlockIds: vi.fn(), createDshBlockIdCompactExtension: vi.fn(), hideRenderedDshReferenceBlocks: vi.fn(),
}));
vi.mock("../src/webviewer/adapter.ts", () => ({ dshViewerUrlForSurface: (url: string) => url, ensureDshWebViewer: vi.fn(), provisionExistingDshWebViewer: vi.fn() }));

const manifest = { id: "obsidian-deepharness-bridge", name: "test", version: "test", minAppVersion: "1.0.0", author: "test", description: "synthetic", dir: ".obsidian/plugins/obsidian-deepharness-bridge" };
const boundInstanceId = "i-27c4d5a7-bdb5-4b8a-8d95-6267f47499c5";
const otherInstanceId = "i-7ecb6c19-80a5-4c2e-97e6-484bbfc0e926";
const sessionId = "session-demo";
const anchorId = "user-node-42";
const quoteHash = "sha256:30101ebf";
const stickerId = "9bb3a80e-230d-44d1-a37c-f7b79d2bf315";

const sticker: StickerRecord = {
  stickerId,
  dshInstanceId: boundInstanceId,
  sessionId,
  anchorId,
  role: "assistant",
  quote: "引文",
  quoteHash,
  occurrence: 0,
  markdown: "贴纸正文",
  tags: [],
  color: "yellow",
  blockId: "dsh-sticker-9bb3a80e",
};

interface Internals {
  binding?: { route(): { vaultId: string; instanceId: string; profileId: string; bindingRevision: number } };
  prepareDshTarget(action: DeepLinkAction): Promise<boolean>;
}

/** A plugin whose only configured dependency is the verified Vault binding. */
function fixture() {
  const host = syntheticApp();
  const plugin = new DeepHarnessBridgePlugin(host.app, manifest);
  const internals = plugin as unknown as Internals;
  internals.binding = {
    route: () => ({ vaultId: "synthetic", instanceId: boundInstanceId, profileId: "web", bindingRevision: 3 }),
  };
  host.put(`${plugin.settings.companionDirectory}/Sessions/${sessionId}.md`, `# DSH 会话 ${sessionId}\n\n${renderStickerBlock(sticker)}\n`);
  return { host, internals };
}

function actionFor(target: StickerBacklinkTarget): DeepLinkAction {
  return parseDshLogicalLink(hrefForTarget(target), () => crypto.randomUUID());
}

function rejectionOf(action: DeepLinkAction, internals: Internals): Promise<unknown> {
  return internals.prepareDshTarget(action).then(
    () => { throw new Error("expected prepareDshTarget to reject"); },
    (reason: unknown) => reason,
  );
}

describe("DeepLinkAction instance guard (prepareDshTarget)", () => {
  it("accepts a Live Preview sticker chip whose href carries the bound instance", async () => {
    const { internals } = fixture();
    const metadata = JSON.stringify({ stickerId, dshInstanceId: boundInstanceId, sessionId, anchorId, quoteHash });
    const matches = collectManagedStickerBacklinks([
      `<!-- dsh-sticker-backlink:${metadata} -->`,
      "[[DeepHarness/Sessions/session-demo#^dsh-sticker-9bb3a80e|贴纸来源]]",
      "[回到 DSH：会话标题](obsidian://deepharness?session=session-demo)",
      "<!-- /dsh-sticker-backlink -->",
    ].join("\n"));

    expect(matches).toHaveLength(1);
    const action = parseDshLogicalLink(matches[0]!.href, () => crypto.randomUUID());
    expect(action.dshInstanceId).toBe(boundInstanceId);
    await expect(internals.prepareDshTarget(action)).resolves.toBe(true);
  });

  it("accepts a legacy backlink whose href already carried the bound instance", async () => {
    const { internals } = fixture();
    await expect(internals.prepareDshTarget(actionFor(JSON.parse(JSON.stringify({
      stickerId, dshInstanceId: boundInstanceId, sessionId, anchorId, quoteHash,
    })) as StickerBacklinkTarget))).resolves.toBe(true);
  });

  it("still refuses a link that names another instance", async () => {
    const { internals } = fixture();
    const reason = await rejectionOf(actionFor({
      stickerId, dshInstanceId: otherInstanceId, sessionId, anchorId, quoteHash,
    }), internals);
    expect(reason).toBeInstanceOf(Error);
    expect((reason as Error).message).toBe("此历史链接属于其他实例，当前绑定不会改写它");
    expect((reason as Error & { code?: string }).code).toBe("BINDING_MISMATCH");
  });

  it("still refuses a link with no instance at all instead of adopting it", async () => {
    const { internals } = fixture();
    // Legacy metadata written before any binding: the href must stay instance-free.
    const legacy = hrefForTarget({ stickerId, sessionId, anchorId, quoteHash });
    expect(new URL(legacy).searchParams.has("dshInstanceId")).toBe(false);

    const reason = await rejectionOf(parseDshLogicalLink(legacy, () => crypto.randomUUID()), internals);
    expect(reason).toBeInstanceOf(Error);
    expect((reason as Error).message).toBe("此旧链接尚未核验实例归属，请先单独维护该链接");
    expect((reason as Error & { code?: string }).code).toBe("BINDING_MISMATCH");
  });
});
