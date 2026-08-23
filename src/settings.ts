export const DEFAULT_BRIDGE_PORT = 18_473;
export const DEFAULT_TOKEN_TTL_MS = 15 * 60 * 1_000;
export const DEFAULT_MAX_BODY_BYTES = 128 * 1_024;

export interface DeepHarnessBridgeSettings {
  dshOrigin: string;
  bridgePort: number;
  companionDirectory: string;
}

export const DEFAULT_SETTINGS: DeepHarnessBridgeSettings = {
  dshOrigin: "http://127.0.0.1:51882",
  bridgePort: DEFAULT_BRIDGE_PORT,
  companionDirectory: "DeepHarness",
};

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
