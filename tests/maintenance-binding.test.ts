import { afterEach, expect, it, vi } from "vitest";
import { randomUUID, createHmac } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VaultBindingProvider } from "../src/binding/provider.ts";
import { verifyMaintenanceGrant } from "../src/binding/maintenance.ts";
import { startBridgeServer, type RunningBridge } from "../src/bridge/server.ts";
import type { VaultIdentity } from "dsh-obsidian-bridge-protocol/binding";
const servers: RunningBridge[]=[]; const directories:string[]=[];
afterEach(async()=>{await Promise.all(servers.splice(0).map(server=>server.close()));for(const root of directories.splice(0))await rm(root,{recursive:true,force:true});vi.unstubAllEnvs();});
const token="synthetic-maintenance-token-01234567890123456789";
function sign(grant: unknown, key=token) {const payload=Buffer.from(JSON.stringify(grant)).toString("base64url");return {payload,signature:createHmac("sha256",key).update(payload).digest("hex")};}
async function setup() {
 const root=await mkdtemp(join(tmpdir(),"synthetic-maintenance-binding-"));directories.push(root);vi.stubEnv("DSH_SESSION_MAINTENANCE_STATE_ROOT",root);
 await writeFile(join(root,"connection.json"),JSON.stringify({host:"127.0.0.1",token}));
 const probe=vi.fn(async()=>{throw new Error("DSH must not be contacted");});
 const persist=vi.fn(async()=>{}); const provider=new VaultBindingProvider("vault",persist,undefined,probe,async()=>({records:[],conflicts:[]}));
 const publisherId=randomUUID();
 const identity=():VaultIdentity=>({discoveryProtocolVersion:1,kind:"vault",vaultId:"vault",publisherId,bootId:server.identity.bootId,origin:server.origin,displayName:"fixture",capabilities:["maintenance-vault-binding-v1"],binding:provider.snapshot()});
 const server=await startBridgeServer({port:0,binding:provider,discoveryIdentity:identity});servers.push(server);
 const grant={domain:"maintenance-vault-binding-v1" as const,operationId:randomUUID(),vaultId:"vault",publisherId,bootId:server.identity.bootId,instanceId:"offline",profileId:"web",expectedRevision:0,intent:"bind" as const,expiresAt:Date.now()+30000};
 const post=(body:unknown,headers:Record<string,string>={})=>fetch(server.origin+"/control/v1/maintenance-binding",{method:"POST",headers:{"content-type":"application/json",...headers},body:JSON.stringify(body)});
 return {provider,probe,persist,identity,grant,post};
}
it("binds through a signed local request with DSH offline, replay is idempotent, no runtime identity is granted",async()=>{
 const f=await setup();const first=await f.post(sign(f.grant));expect(first.status).toBe(200);const snapshot=await first.json();
 expect(snapshot.target).toEqual({instanceId:"offline",profileId:"web"});expect(f.provider.currentIdentity()).toBeUndefined();expect(f.probe).not.toHaveBeenCalled();
 expect(await (await f.post(sign({...f.grant,expiresAt:Date.now()+30000}))).json()).toEqual(snapshot);expect(f.persist).toHaveBeenCalledOnce();
 const stale=await f.post(sign({...f.grant,operationId:randomUUID()}));expect(stale.status).toBe(409);
 const wrong=await f.post(sign({...f.grant,operationId:randomUUID(),expectedRevision:1,intent:"unbind",instanceId:"foreign"}));expect(wrong.status).toBe(409);
 const unbind=await f.post(sign({...f.grant,operationId:randomUUID(),expectedRevision:1,intent:"unbind"}));expect(unbind.status).toBe(200);expect((await unbind.json()).target).toBeNull();
});
it("rejects tampered, expired, other-boot and browser-origin grants before persistence",async()=>{
 const f=await setup();
 for (const body of [sign(f.grant,"bad-key"),sign({...f.grant,expiresAt:Date.now()-1}),sign({...f.grant,bootId:randomUUID()}),sign({...f.grant,vaultId:"other"})]) {
  await expect(verifyMaintenanceGrant(body,f.identity())).rejects.toThrow();
 }
 expect((await f.post(sign(f.grant),{origin:"http://127.0.0.1:31900"})).status).toBe(403);
 expect(f.persist).not.toHaveBeenCalled();
});
