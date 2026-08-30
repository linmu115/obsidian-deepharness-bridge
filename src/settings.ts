export const DEFAULT_BRIDGE_PORT = 18_473;
export const DEFAULT_TOKEN_TTL_MS = 15 * 60 * 1_000;
export const DEFAULT_MAX_BODY_BYTES = 128 * 1_024;

export interface DeepHarnessBridgeSettings {
  dshOrigin: string;
  dshLaunchLogPath: string;
  bridgePort: number;
  companionDirectory: string;
  /** Stable routing identity for the DSH page hosted by Obsidian Web Viewer. */
  webViewerSurfaceId: string;
}

export const DEFAULT_SETTINGS: DeepHarnessBridgeSettings = {
  dshOrigin: "http://127.0.0.1:3080",
  dshLaunchLogPath: "",
  bridgePort: DEFAULT_BRIDGE_PORT,
  companionDirectory: "DeepHarness",
  webViewerSurfaceId: "",
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function ensureBridgeSurfaceId(value: string | undefined, create: () => string): string {
  const current = value?.trim() ?? "";
  if (UUID_PATTERN.test(current)) return current;
  const generated = create();
  if (!UUID_PATTERN.test(generated)) throw new Error("Generated DSH Web Viewer surface ID is not a UUID");
  return generated;
}

export function normalizeLoopbackOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" || (url.hostname !== "127.0.0.1" && url.hostname !== "localhost")) {
    throw new Error(`DSH origin must be an HTTP loopback origin: ${value}`);
  }
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error(`DSH origin must not contain credentials, a path, query or fragment: ${value}`);
  }
  return url.origin;
}

export function validateBridgePort(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 65_535) {
    throw new Error("Bridge port must be an integer from 0 to 65535");
  }
  return value;
}
