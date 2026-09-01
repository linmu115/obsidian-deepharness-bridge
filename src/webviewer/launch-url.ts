import { readFile } from "node:fs/promises";

import type { DeepHarnessBridgeSettings } from "../settings.ts";

export type ReadLaunchLog = (path: string) => Promise<string>;

function checkedViewerUrl(value: string, expectedOrigin: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" || (url.hostname !== "127.0.0.1" && url.hostname !== "localhost")) {
    throw new Error("DSH launch URL must use an HTTP loopback address");
  }
  if (url.username || url.password) throw new Error("DSH launch URL cannot contain credentials");
  if (url.origin !== new URL(expectedOrigin).origin) {
    throw new Error(`DSH launch URL origin does not match ${expectedOrigin}`);
  }
  return url.href;
}

export function launchUrlFromLog(log: string, expectedOrigin: string): string {
  const line = log.split(/\r?\n/).reverse().find((candidate) => /^dsh web:\s+https?:\/\/\S+\s*$/.test(candidate));
  const match = line?.match(/^dsh web:\s+(https?:\/\/\S+)\s*$/);
  if (!match?.[1]) throw new Error("DSH launch log does not contain a current 'dsh web:' URL");
  return checkedViewerUrl(match[1], expectedOrigin);
}

export async function resolveDshViewerUrl(
  settings: Pick<DeepHarnessBridgeSettings, "dshOrigin" | "dshLaunchLogPath">,
  readLaunchLog: ReadLaunchLog = async (path) => readFile(path, "utf8"),
  activeDshViewerUrl?: string,
): Promise<string> {
  if (activeDshViewerUrl !== undefined) {
    return checkedViewerUrl(activeDshViewerUrl, new URL(activeDshViewerUrl).origin);
  }
  const path = settings.dshLaunchLogPath.trim();
  if (!path) return checkedViewerUrl(settings.dshOrigin, settings.dshOrigin);
  let log: string;
  try {
    log = await readLaunchLog(path);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot read DSH launch log: ${detail}`);
  }
  return launchUrlFromLog(log, settings.dshOrigin);
}
