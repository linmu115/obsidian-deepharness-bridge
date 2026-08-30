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
const provisionedSurfaces = new WeakMap<WebViewerLeaf, string>();

export function dshViewerUrlForSurface(dshUrl: string, surfaceId: string): string {
  const target = loopbackUrl(dshUrl);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(surfaceId)) {
    throw new Error("DSH Web Viewer surface ID must be a UUID");
  }
  // DSH exchanges its one-use launch token with a 303 redirect to a clean `/`.
  // URL fragments are not sent to that server and survive the redirect, while
  // ordinary query parameters are intentionally discarded with the token.
  const fragment = new URLSearchParams(target.hash.replace(/^#/, ""));
  fragment.set(DSH_BRIDGE_SURFACE_PARAMETER, surfaceId);
  target.hash = fragment.toString();
  return target.href;
}

function surfaceIdFromUrl(url: URL | undefined): string | undefined {
  if (url === undefined) return undefined;
  const fragment = new URLSearchParams(url.hash.replace(/^#/, ""));
  return fragment.get(DSH_BRIDGE_SURFACE_PARAMETER)
    ?? url.searchParams.get(DSH_BRIDGE_SURFACE_PARAMETER)
    ?? undefined;
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
    const targetSurfaceId = surfaceIdFromUrl(target);
    const needsSurfaceRouting = targetSurfaceId !== null
      && targetSurfaceId !== undefined
      && surfaceIdFromUrl(currentUrl) !== targetSurfaceId
      && provisionedSurfaces.get(existing) !== targetSurfaceId;
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
      if (targetSurfaceId !== undefined) provisionedSurfaces.set(existing, targetSurfaceId);
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
  const targetSurfaceId = surfaceIdFromUrl(target);
  if (targetSurfaceId !== undefined) provisionedSurfaces.set(leaf, targetSurfaceId);
  app.workspace.revealLeaf(leaf);
  return leaf;
}
