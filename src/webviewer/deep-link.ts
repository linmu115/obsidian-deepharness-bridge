import type { DeepLinkAction } from "../protocol.ts";
import { parseDshLogicalLink } from "../logical-link.ts";
import { dshViewerUrlForSurface, ensureDshWebViewer, type WebViewerApp } from "./adapter.ts";

export interface DeepLinkHandlerOptions {
  app: WebViewerApp;
  dshUrl: string | (() => string | Promise<string>);
  surfaceId: string;
  enqueue(action: DeepLinkAction): unknown;
  createActionId?: () => string;
  onError?: (error: unknown) => void;
}

export function parseDshUrl(value: string, createActionId: () => string = () => crypto.randomUUID()): DeepLinkAction {
  return parseDshLogicalLink(value, createActionId);
}

export async function handleDshUrl(value: string, options: DeepLinkHandlerOptions): Promise<DeepLinkAction> {
  const action = { ...parseDshUrl(value, options.createActionId), targetSurfaceId: options.surfaceId };
  const dshUrl = await (typeof options.dshUrl === "function" ? options.dshUrl() : options.dshUrl);
  await ensureDshWebViewer(options.app, dshViewerUrlForSurface(dshUrl, options.surfaceId));
  options.enqueue(action);
  return action;
}

interface LinkInterceptorPlugin {
  registerDomEvent(
    element: Document,
    type: "click",
    callback: (event: MouseEvent) => void,
    options: AddEventListenerOptions,
  ): void;
}

export function registerDshLinkInterceptor(plugin: LinkInterceptorPlugin, options: DeepLinkHandlerOptions): void {
  plugin.registerDomEvent(document, "click", (event) => {
    const target = event.target;
    const link = target instanceof Element
      ? target.closest<HTMLAnchorElement>("a[href^='dsh://'], a[href^='obsidian://deepharness']")
      : null;
    if (!link) return;
    event.preventDefault();
    event.stopPropagation();
    void handleDshUrl(link.href, options).catch((error: unknown) => options.onError?.(error));
  }, { capture: true });
}
