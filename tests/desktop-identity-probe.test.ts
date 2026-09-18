import { afterEach, expect, it, vi } from 'vitest';
import { createServer, type Server, type RequestListener } from 'node:http';
import { randomUUID } from 'node:crypto';
import { probeDshIdentity } from '../src/binding/provider.ts';
const servers: Server[] = [];
afterEach(async () => { vi.unstubAllGlobals(); await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }))); });
async function serve(handler: RequestListener) {
 const server = createServer(handler); servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
 const address = server.address(); if (!address || typeof address === 'string') throw new Error('address'); return `http://127.0.0.1:${address.port}`;
}
it('probes the desktop HTTP backend when renderer fetch rejects every cross-origin request', async () => {
 const rendererFetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch')); vi.stubGlobal('fetch', rendererFetch);
 const origin = await serve((request, response) => { expect(request.url).toBe('/obsidian-bridge/identity'); response.end(JSON.stringify({ discoveryProtocolVersion:1,kind:'dsh',instanceId:'test-instance',profileId:'web',bootId:randomUUID(),publisherId:randomUUID(),displayName:'test',origin,capabilities:['vault-instance-binding-v1'] })); });
 expect((await probeDshIdentity(origin)).instanceId).toBe('test-instance'); expect(rendererFetch).not.toHaveBeenCalled();
});
it('does not follow redirects or accept an oversized body', async () => {
 let destinationHits=0; const destination=await serve((_request,response)=>{destinationHits++;response.end('{}');});
 const redirect=await serve((_request,response)=>{response.writeHead(302,{location:destination});response.end();});
 await expect(probeDshIdentity(redirect)).rejects.toMatchObject({code:'INSTANCE_OFFLINE'});expect(destinationHits).toBe(0);
 const oversized=await serve((_request,response)=>{response.end('x'.repeat(65_537));});
 await expect(probeDshIdentity(oversized)).rejects.toMatchObject({code:'IDENTITY_CONFLICT'});
});
it('retains injected fetch and rejects non-loopback addresses before transport', async () => {
 const injected=vi.fn().mockResolvedValue(new Response('{}'));
 await expect(probeDshIdentity('https://example.com',injected)).rejects.toBeDefined();expect(injected).not.toHaveBeenCalled();
 await expect(probeDshIdentity('http://127.0.0.1:12345',injected)).rejects.toBeDefined();expect(injected).toHaveBeenCalledOnce();
});
