export interface WebViewerLeaf {
  view?: { getState?(): unknown };
  getViewState?(): { state?: unknown };
  setViewState(state: {
    type: string;
    active: boolean;
    state: { url: string; title: string; mode: "webview" };
  }): Promise<void>;
}

export interface WebViewerApp {
  workspace: {
    getLeavesOfType(type: string): WebViewerLeaf[];
    getLeaf(kind: "tab"): WebViewerLeaf;
    revealLeaf(leaf: WebViewerLeaf): void;
  };
}

export class WebViewerUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebViewerUnavailableError";
  }
}

function loopbackUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "http:" || (url.hostname !== "127.0.0.1" && url.hostname !== "localhost")) {
    throw new Error(`DSH Web Viewer target must be an HTTP loopback URL: ${value}`);
  }
  if (url.username || url.password) throw new Error("DSH Web Viewer target cannot contain credentials");
  return url;
}

function leafState(leaf: WebViewerLeaf): { url?: string; title?: string; mode?: string } {
  const value = leaf.view?.getState?.() ?? leaf.getViewState?.().state;
  return value && typeof value === "object" ? value as { url?: string; title?: string; mode?: string } : {};
}

export async function ensureDshWebViewer(app: WebViewerApp, dshUrl: string): Promise<WebViewerLeaf> {
  const target = loopbackUrl(dshUrl);
  const existing = app.workspace.getLeavesOfType("webviewer").find((leaf) => {
    const state = leafState(leaf);
    if (!state.url) return false;
    try {
      const current = loopbackUrl(state.url);
      return current.origin === target.origin;
    } catch {
      return false;
    }
  });
  if (existing) {
    const state = leafState(existing);
    if (target.search && state.url && new URL(state.url).href !== target.href) {
      await existing.setViewState({
        type: "webviewer",
        active: true,
        state: { url: target.href, title: "DeepSeek Harness", mode: "webview" },
      });
    }
    app.workspace.revealLeaf(existing);
    return existing;
  }
  const leaf = app.workspace.getLeaf("tab");
  if (!leaf || typeof leaf.setViewState !== "function") {
    throw new WebViewerUnavailableError("Obsidian core Web Viewer is unavailable");
  }
  await leaf.setViewState({
    type: "webviewer",
    active: true,
    state: { url: target.href, title: "DeepSeek Harness", mode: "webview" },
  });
  app.workspace.revealLeaf(leaf);
  return leaf;
}
