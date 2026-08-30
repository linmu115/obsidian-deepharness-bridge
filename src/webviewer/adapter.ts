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

export const DSH_BRIDGE_SURFACE_PARAMETER = "dshBridgeSurface";

export function dshViewerUrlForSurface(dshUrl: string, surfaceId: string): string {
  const target = loopbackUrl(dshUrl);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(surfaceId)) {
    throw new Error("DSH Web Viewer surface ID must be a UUID");
  }
  target.searchParams.set(DSH_BRIDGE_SURFACE_PARAMETER, surfaceId);
  return target.href;
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

function isReadyDshLeaf(leaf: WebViewerLeaf): boolean {
  const state = leafState(leaf);
  return state.mode === "webview"
    && typeof state.title === "string"
    && state.title.trim() !== ""
    && state.title !== "DeepSeek Harness"
    && state.title !== "data:text/plain,";
}

export async function ensureDshWebViewer(app: WebViewerApp, dshUrl: string): Promise<WebViewerLeaf> {
  const target = loopbackUrl(dshUrl);
  const candidates = app.workspace.getLeavesOfType("webviewer").filter((leaf) => {
    const state = leafState(leaf);
    if (!state.url) return false;
    try { return loopbackUrl(state.url).origin === target.origin; }
    catch { return false; }
  });
  const existing = candidates.find(isReadyDshLeaf)
    ?? candidates.find((leaf) => leafState(leaf).mode === "webview")
    ?? candidates[0];
  if (existing) {
    const state = leafState(existing);
    const currentUrl = state.url ? new URL(state.url) : undefined;
    const currentHref = currentUrl?.href;
    const needsWebviewMode = state.mode !== "webview";
    const targetSurfaceId = target.searchParams.get(DSH_BRIDGE_SURFACE_PARAMETER);
    const needsSurfaceRouting = targetSurfaceId !== null
      && currentUrl?.searchParams.get(DSH_BRIDGE_SURFACE_PARAMETER) !== targetSurfaceId;
    if (needsWebviewMode && currentHref === target.href) {
      await existing.setViewState({
        type: "webviewer",
        active: true,
        state: { url: "about:blank", title: "DeepSeek Harness", mode: "webview" },
      });
    }
    if (needsWebviewMode || needsSurfaceRouting) {
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
