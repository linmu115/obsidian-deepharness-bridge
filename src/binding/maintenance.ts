import { createHmac, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { z } from "zod";
import { vaultBindingGrantSchema, type VaultBindingGrant } from "@linmu/dsh-session-contracts";
import type { VaultIdentity } from "dsh-obsidian-bridge-protocol/binding";
export const MAINTENANCE_BINDING_CAPABILITY = "maintenance-vault-binding-v1";
export async function localMaintenanceToken(): Promise<string> {
  const root = process.env.DSH_SESSION_MAINTENANCE_STATE_ROOT?.trim() || join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "DSH-Session-Maintenance");
  // Engine creates this file with current-user-only access. The token never travels over the wire.
  const value = JSON.parse(await readFile(join(root, "connection.json"), "utf8").catch(() => { throw new Error("无法核验本机 Maintenance 授权，请检查维护引擎是否可用"); }));
  return z.object({ host: z.literal("127.0.0.1"), token: z.string().regex(/^[A-Za-z0-9_-]{32,256}$/) }).parse(value).token;
}
export async function verifyMaintenanceGrant(input: unknown, identity: VaultIdentity, readToken = localMaintenanceToken, now = Date.now): Promise<VaultBindingGrant> {
  const envelope = z.object({ payload: z.string().min(1).max(8192).regex(/^[A-Za-z0-9_-]+$/), signature: z.string().regex(/^[0-9a-f]{64}$/) }).strict().parse(input);
  const expected = createHmac("sha256", await readToken()).update(envelope.payload).digest();
  if (!timingSafeEqual(expected, Buffer.from(envelope.signature, "hex"))) throw new Error("Maintenance 绑定授权无效");
  const grant = vaultBindingGrantSchema.parse(JSON.parse(Buffer.from(envelope.payload, "base64url").toString("utf8")));
  if (grant.expiresAt <= now() || grant.expiresAt > now() + 60000 || grant.vaultId !== identity.vaultId || grant.bootId !== identity.bootId || grant.publisherId !== identity.publisherId) throw new Error("Maintenance 绑定授权已过期或 Vault 身份已改变");
  return grant;
}
