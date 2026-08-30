import type { DeepLinkAction } from "./protocol.ts";

export const OBSIDIAN_DEEPHARNESS_ACTION = "deepharness";

export interface DshLogicalLocation {
  sessionId: string;
  anchorId: string;
  quoteHash?: string;
  stickerId?: string;
  setId?: string;
  referenceId?: string;
}

export function buildObsidianDshLink(location: DshLogicalLocation): string {
  const query = new URLSearchParams({
    session: location.sessionId,
    anchor: location.anchorId,
    ...(location.quoteHash ? { quoteHash: location.quoteHash } : {}),
    ...(location.stickerId ? { sticker: location.stickerId } : {}),
    ...(location.setId ? { setId: location.setId } : {}),
    ...(location.referenceId ? { referenceId: location.referenceId } : {}),
  });
  return `obsidian://${OBSIDIAN_DEEPHARNESS_ACTION}?${query.toString()}`;
}

export function obsidianProtocolUrl(params: Record<string, string>): string {
  const read = (name: string): string | undefined => {
    const exact = params[name];
    if (exact !== undefined) return exact;
    const normalized = name.toLowerCase();
    return Object.entries(params).find(([key]) => key.toLowerCase() === normalized)?.[1];
  };
  if (read("action") !== OBSIDIAN_DEEPHARNESS_ACTION) {
    throw new Error("Unsupported Obsidian protocol action");
  }
  const quoteHash = read("quoteHash");
  const stickerId = read("sticker");
  const setId = read("setId");
  const referenceId = read("referenceId");
  return buildObsidianDshLink({
    sessionId: read("session") ?? "",
    anchorId: read("anchor") ?? "",
    ...(quoteHash ? { quoteHash } : {}),
    ...(stickerId ? { stickerId } : {}),
    ...(setId ? { setId } : {}),
    ...(referenceId ? { referenceId } : {}),
  });
}

export function parseDshLogicalLocation(value: string): DshLogicalLocation {
  const url = new URL(value);
  let sessionId = "";
  if (url.protocol === "dsh:" && url.hostname === "open") {
    const segments = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    if (segments.length !== 2 || segments[0] !== "session" || !segments[1]) {
      throw new Error("DSH link must identify a session");
    }
    sessionId = segments[1];
  } else if (url.protocol === "obsidian:" && url.hostname === OBSIDIAN_DEEPHARNESS_ACTION) {
    sessionId = url.searchParams.get("session") ?? "";
    if (!sessionId) throw new Error("DSH link must identify a session");
  } else {
    throw new Error("Unsupported DSH logical link");
  }

  const allowed = url.protocol === "dsh:"
    ? new Set(["anchor", "quoteHash", "setId", "referenceId"])
    : new Set(["session", "anchor", "quoteHash", "sticker", "setId", "referenceId"]);
  const unknown = [...url.searchParams.keys()].find((key) => !allowed.has(key));
  if (unknown) throw new Error(`Unknown DSH link parameter: ${unknown}`);
  const anchorId = url.searchParams.get("anchor");
  if (!anchorId) throw new Error("DSH link is missing an anchor");
  const quoteHash = url.searchParams.get("quoteHash");
  const stickerId = url.searchParams.get("sticker");
  const setId = url.searchParams.get("setId");
  const referenceId = url.searchParams.get("referenceId");
  return {
    sessionId,
    anchorId,
    ...(quoteHash ? { quoteHash } : {}),
    ...(stickerId ? { stickerId } : {}),
    ...(setId ? { setId } : {}),
    ...(referenceId ? { referenceId } : {}),
  };
}

export function parseDshLogicalLink(
  value: string,
  createActionId: () => string,
): DeepLinkAction {
  const location = parseDshLogicalLocation(value);
  return {
    protocolVersion: 1,
    type: "deep-link",
    actionId: createActionId(),
    sessionId: location.sessionId,
    anchorId: location.anchorId,
    ...(location.quoteHash ? { quoteHash: location.quoteHash } : {}),
    ...(location.stickerId ? { stickerId: location.stickerId } : {}),
    ...(location.setId ? { setId: location.setId } : {}),
    ...(location.referenceId ? { referenceId: location.referenceId } : {}),
  };
}
