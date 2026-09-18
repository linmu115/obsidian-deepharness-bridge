import { realpath, stat } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import { isAbsolute } from 'node:path';

export const VAULT_LOCATION_PATH = '/discovery/v1/vault-location';

/** Local process access only. Never trust forwarded headers or browser CORS grants. */
export function isLocalLocationCaller(request: Pick<IncomingMessage, 'headers' | 'socket'>, origin: string): boolean {
  const address = request.socket.remoteAddress;
  return (address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1')
    && request.headers.origin === undefined
    && (request.headers['sec-fetch-site'] === undefined || request.headers['sec-fetch-site'] === 'none')
    && request.headers.host === new URL(origin).host;
}

/** Caller supplies only a desktop FileSystemAdapter; no fallback to cwd or config. */
export async function canonicalVaultRoot(adapter: { getBasePath(): unknown } | undefined): Promise<string> {
  try {
    const base = adapter?.getBasePath();
    if (typeof base !== 'string' || !isAbsolute(base)) throw new Error();
    const root = await realpath(base);
    if (!(await stat(root)).isDirectory()) throw new Error();
    return root;
  } catch {
    // Filesystem errors include absolute paths. Keep them out of responses and logs.
    throw new Error('Vault location is unavailable');
  }
}
