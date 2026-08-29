import { describe, expect, it, vi } from "vitest";
import { JSDOM } from "jsdom";

import { ensureDshWebViewer } from "../src/webviewer/adapter.ts";
import { handleDshUrl, registerDshLinkInterceptor } from "../src/webviewer/deep-link.ts";
import { buildObsidianDshLink, obsidianProtocolUrl } from "../src/logical-link.ts";

function fakeLeaf(url: string, title = "DeepSeek Harness", mode = "webview") {
  return {
    view: { getState: () => ({ url, title, mode }) },
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

  it("recovers annotation identity from Obsidian's case-normalized protocol parameters", () => {
    expect(obsidianProtocolUrl({
      action: "deepharness",
      session: "session-demo",
      anchor: "user-node-42",
      quotehash: "sha256:30101ebf",
      setid: "set-1",
      referenceid: "reference-1",
    })).toContain("setId=set-1&referenceId=reference-1");
  });

  it("intercepts a rendered Obsidian link before the protocol handler can discard its identity", async () => {
    const dom = new JSDOM('<a id="link" href="obsidian://deepharness?session=session-demo&anchor=user-node-42&setId=set-1&referenceId=reference-1"><span id="label">打开 DSH 会话</span></a>', {
      url: "app://obsidian.md/note",
    });
    const previousDocument = globalThis.document;
    const previousElement = globalThis.Element;
    Object.assign(globalThis, { document: dom.window.document, Element: dom.window.Element });
    try {
      const { app } = appWith([fakeLeaf("http://127.0.0.1:51882/")]);
      const enqueue = vi.fn();
      registerDshLinkInterceptor({
        registerDomEvent(element, type, callback, options) {
          element.addEventListener(type, callback, options);
        },
      }, { app, dshUrl: "http://127.0.0.1:51882/", enqueue });

      const event = new dom.window.MouseEvent("click", { bubbles: true, cancelable: true });
      dom.window.document.querySelector("#label")?.dispatchEvent(event);
      await vi.waitFor(() => expect(enqueue).toHaveBeenCalledOnce());
      expect(event.defaultPrevented).toBe(true);
      expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({
        setId: "set-1",
        referenceId: "reference-1",
      }));
    } finally {
      Object.assign(globalThis, { document: previousDocument, Element: previousElement });
      dom.window.close();
    }
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

  it("does not renavigate an already running Web Viewer merely to replay its launch token", async () => {
    const existing = fakeLeaf("http://127.0.0.1:51882/");
    const { app } = appWith([existing]);

    await ensureDshWebViewer(app, "http://127.0.0.1:51882/?token=current-token");

    expect(existing.setViewState).not.toHaveBeenCalled();
    expect(app.workspace.revealLeaf).toHaveBeenCalledWith(existing);
  });

  it("creates a core webviewer tab when no matching DSH leaf exists", async () => {
    const { app, created } = appWith([fakeLeaf("http://127.0.0.1:41780/")]);
    const leaf = await ensureDshWebViewer(app, "http://localhost:51882/");

    expect(leaf).toBe(created);
    expect(created.setViewState).toHaveBeenCalledWith({
      type: "webviewer",
      active: true,
      state: { url: "http://localhost:51882/", title: "DeepSeek Harness", mode: "webview" },
    });
  });

  it("reuses a same-origin DSH tab after its title changes to the session title", async () => {
    const existing = fakeLeaf("http://127.0.0.1:51882/", "A session title — DeepSeek Harness");
    const { app } = appWith([existing]);

    await ensureDshWebViewer(app, "http://127.0.0.1:51882/?token=current-token");

    expect(app.workspace.getLeaf).not.toHaveBeenCalled();
    expect(existing.setViewState).not.toHaveBeenCalled();
    expect(app.workspace.revealLeaf).toHaveBeenCalledWith(existing);
  });

  it("recovers an existing authenticated DSH tab that Obsidian left in blank mode", async () => {
    const authenticated = "http://127.0.0.1:51882/?token=current-token";
    const existing = fakeLeaf(authenticated, "data:text/plain,", "blank");
    const { app } = appWith([existing]);

    await ensureDshWebViewer(app, authenticated);

    expect(app.workspace.getLeaf).not.toHaveBeenCalled();
    expect(existing.setViewState).toHaveBeenNthCalledWith(1, {
      type: "webviewer",
      active: true,
      state: { url: "about:blank", title: "DeepSeek Harness", mode: "webview" },
    });
    expect(existing.setViewState).toHaveBeenNthCalledWith(2, {
      type: "webviewer",
      active: true,
      state: { url: authenticated, title: "DeepSeek Harness", mode: "webview" },
    });
    expect(app.workspace.revealLeaf).toHaveBeenCalledWith(existing);
  });

  it("prefers a ready same-origin DSH webview over an earlier blank tab", async () => {
    const blank = fakeLeaf("http://127.0.0.1:51882/?token=stale", "data:text/plain,", "blank");
    const ready = fakeLeaf("http://127.0.0.1:51882/", "Existing session — DeepSeek Harness", "webview");
    const { app } = appWith([blank, ready]);

    await ensureDshWebViewer(app, "http://127.0.0.1:51882/?token=current-token");

    expect(blank.setViewState).not.toHaveBeenCalled();
    expect(ready.setViewState).not.toHaveBeenCalled();
    expect(app.workspace.revealLeaf).toHaveBeenCalledWith(ready);
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
