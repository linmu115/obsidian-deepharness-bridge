import { PROTOCOL_VERSION, type DeepLinkAction } from "../protocol.ts";
import { ensureDshWebViewer, type WebViewerApp } from "./adapter.ts";

export interface DeepLinkHandlerOptions {
  app: WebViewerApp;
  dshUrl: string | (() => string);
  enqueue(action: DeepLinkAction): unknown;
  createActionId?: () => string;
  onError?: (error: unknown) => void;
}

export function parseDshUrl(value: string, createActionId: () => string = () => crypto.randomUUID()): DeepLinkAction {
  const url = new URL(value);
  if (url.protocol !== "dsh:" || url.hostname !== "open") throw new Error("Unsupported DSH logical link");
  const segments = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (segments.length !== 2 || segments[0] !== "session" || !segments[1]) throw new Error("DSH link must identify a session");
  const unknownParameters = [...url.searchParams.keys()].filter((key) => key !== "anchor" && key !== "quoteHash");
  if (unknownParameters.length) throw new Error(`Unknown DSH link parameter: ${unknownParameters[0]}`);
  const anchorId = url.searchParams.get("anchor");
  if (!anchorId) throw new Error("DSH link is missing an anchor");
  const quoteHash = url.searchParams.get("quoteHash");
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: "deep-link",
    actionId: createActionId(),
    sessionId: segments[1],
    anchorId,
    ...(quoteHash ? { quoteHash } : {}),
  };
}

export async function handleDshUrl(value: string, options: DeepLinkHandlerOptions): Promise<DeepLinkAction> {
  const action = parseDshUrl(value, options.createActionId);
  const dshUrl = typeof options.dshUrl === "function" ? options.dshUrl() : options.dshUrl;
  await ensureDshWebViewer(options.app, dshUrl);
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
    const link = target instanceof Element ? target.closest<HTMLAnchorElement>("a[href^='dsh://']") : null;
    if (!link) return;
    event.preventDefault();
    event.stopPropagation();
    void handleDshUrl(link.href, options).catch((error: unknown) => options.onError?.(error));
  }, { capture: true });
}
