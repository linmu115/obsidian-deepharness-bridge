import { describe, expect, it, vi } from "vitest";

import { ensureDshWebViewer } from "../src/webviewer/adapter.ts";
import { handleDshUrl } from "../src/webviewer/deep-link.ts";
import { buildObsidianDshLink, obsidianProtocolUrl } from "../src/logical-link.ts";

function fakeLeaf(url: string) {
  return {
    view: { getState: () => ({ url, title: "DeepSeek Harness" }) },
    setViewState: vi.fn(async () => undefined),
  };
}

function appWith(leaves: ReturnType<typeof fakeLeaf>[] = []) {
  const created = fakeLeaf("");
  return {
    created,
    app: {
      workspace: {
        getLeavesOfType: vi.fn(() => leaves),
        getLeaf: vi.fn(() => created),
        revealLeaf: vi.fn(),
      },
    },
  };
}

describe("Obsidian DSH Web Viewer adapter", () => {
  it("builds the official Obsidian protocol URL from handler data", () => {
    const expected = "obsidian://deepharness?session=session-demo&anchor=user-node-42&quoteHash=sha256%3A30101ebf&sticker=9bb3a80e-230d-44d1-a37c-f7b79d2bf315";
    expect(buildObsidianDshLink({
      sessionId: "session-demo",
      anchorId: "user-node-42",
      quoteHash: "sha256:30101ebf",
      stickerId: "9bb3a80e-230d-44d1-a37c-f7b79d2bf315",
    })).toBe(expected);
    expect(obsidianProtocolUrl({
      action: "deepharness",
      session: "session-demo",
      anchor: "user-node-42",
      quoteHash: "sha256:30101ebf",
      sticker: "9bb3a80e-230d-44d1-a37c-f7b79d2bf315",
    })).toBe(expected);
  });

  it("keeps sticker identity out of the DSH deep-link action payload", async () => {
    const { app } = appWith([fakeLeaf("http://127.0.0.1:51882/")]);
    const action = await handleDshUrl(
      "obsidian://deepharness?session=session-demo&anchor=user-node-42&quoteHash=sha256%3A30101ebf&sticker=9bb3a80e-230d-44d1-a37c-f7b79d2bf315",
      { app, dshUrl: "http://127.0.0.1:51882/", enqueue: vi.fn() },
    );

    expect(action).not.toHaveProperty("stickerId");
  });

  it("preserves the annotation identity needed to open the exact DSH reference", async () => {
    const { app } = appWith([fakeLeaf("http://127.0.0.1:51882/")]);
    const action = await handleDshUrl(
      "obsidian://deepharness?session=session-demo&anchor=user-node-42&setId=set-1&referenceId=reference-1",
      { app, dshUrl: "http://127.0.0.1:51882/", enqueue: vi.fn() },
    );

    expect(action).toMatchObject({ setId: "set-1", referenceId: "reference-1" });
  });

  it("reuses an existing loopback DSH webviewer leaf", async () => {
    const existing = fakeLeaf("http://127.0.0.1:51882/");
    const { app } = appWith([existing]);
    const leaf = await ensureDshWebViewer(app, "http://127.0.0.1:51882/");

    expect(leaf).toBe(existing);
    expect(app.workspace.getLeaf).not.toHaveBeenCalled();
    expect(app.workspace.revealLeaf).toHaveBeenCalledWith(existing);
  });

  it("reauthenticates an existing Web Viewer with the current DSH launch URL", async () => {
    const existing = fakeLeaf("http://127.0.0.1:51882/");
    const { app } = appWith([existing]);

    await ensureDshWebViewer(app, "http://127.0.0.1:51882/?token=current-token");

    expect(existing.setViewState).toHaveBeenCalledWith({
      type: "webviewer",
      active: true,
      state: {
        url: "http://127.0.0.1:51882/?token=current-token",
        title: "DeepSeek Harness",
      },
    });
    expect(app.workspace.revealLeaf).toHaveBeenCalledWith(existing);
  });

  it("creates a core webviewer tab when no matching DSH leaf exists", async () => {
    const { app, created } = appWith([fakeLeaf("http://127.0.0.1:41780/")]);
    const leaf = await ensureDshWebViewer(app, "http://localhost:51882/");

    expect(leaf).toBe(created);
    expect(created.setViewState).toHaveBeenCalledWith({
      type: "webviewer",
      active: true,
      state: { url: "http://localhost:51882/", title: "DeepSeek Harness" },
    });
  });

  it("activates the Web Viewer before enqueuing a parsed logical deep link", async () => {
    const { app } = appWith([fakeLeaf("http://127.0.0.1:51882/")]);
    const calls: string[] = [];
    app.workspace.revealLeaf.mockImplementation(() => { calls.push("reveal"); });
    const enqueue = vi.fn((action) => { calls.push("enqueue"); return action.actionId; });

    const action = await handleDshUrl(
      "obsidian://deepharness?session=session-demo&anchor=user-node-42&quoteHash=sha256%3A30101ebf",
      {
        app,
        dshUrl: "http://127.0.0.1:51882/",
        enqueue,
        createActionId: () => "6f09f1be-5dc1-48e4-ac08-e3c05d70ac01",
      },
    );

    expect(calls).toEqual(["reveal", "enqueue"]);
    expect(action).toMatchObject({
      protocolVersion: 1,
      type: "deep-link",
      sessionId: "session-demo",
      anchorId: "user-node-42",
      quoteHash: "sha256:30101ebf",
    });
  });

  it("rejects incomplete logical links and non-loopback DSH targets", async () => {
    const { app } = appWith();
    await expect(handleDshUrl("dsh://open/session/session-demo", {
      app,
      dshUrl: "http://127.0.0.1:51882/",
      enqueue: vi.fn(),
    })).rejects.toThrow(/anchor/i);
    await expect(ensureDshWebViewer(app, "https://example.com/")).rejects.toThrow(/loopback/i);
  });

  it("reads the current DSH URL when settings change after registration", async () => {
    const current = fakeLeaf("http://127.0.0.1:51999/");
    const { app } = appWith([current]);
    let dshUrl = "http://127.0.0.1:51882/";
    dshUrl = "http://127.0.0.1:51999/";

    await handleDshUrl("dsh://open/session/session-demo?anchor=user-node-42", {
      app,
      dshUrl: () => dshUrl,
      enqueue: vi.fn(),
    });

    expect(app.workspace.revealLeaf).toHaveBeenCalledWith(current);
    expect(app.workspace.getLeaf).not.toHaveBeenCalled();
  });

  it("keeps legacy dsh links readable", async () => {
    const { app } = appWith([fakeLeaf("http://127.0.0.1:51882/")]);
    const action = await handleDshUrl("dsh://open/session/session-demo?anchor=user-node-42", {
      app,
      dshUrl: "http://127.0.0.1:51882/",
      enqueue: vi.fn(),
      createActionId: () => "6f09f1be-5dc1-48e4-ac08-e3c05d70ac01",
    });
    expect(action).toMatchObject({ sessionId: "session-demo", anchorId: "user-node-42" });
  });
});
