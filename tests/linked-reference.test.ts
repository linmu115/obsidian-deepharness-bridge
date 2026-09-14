import { expect,it,vi } from 'vitest';
import { LinkedReferenceService, type LinkedReferenceIO } from '../src/vault/linked-reference.ts';
import type { LocalKnowledgeLink } from '../src/vault/knowledge-store.ts';
const input={objectId:'link',operationId:'ea6cd569-2564-48dc-bef7-542eac61bac6',nativeSessionId:'native',logicalSessionId:'logical',profileId:'web'};
function fixture(){
  let markdown='# Note\nThe selected passage ^block\nLater material', clock=100;
  const link:LocalKnowledgeLink={objectId:'link',noteId:'note',instanceId:'instance',logicalSessionId:'logical',nativeSessionId:'native',title:'title',deleted:false,revision:1,blockId:'block',sticker:{objectId:'sticker',selection:{selectedText:'selected passage',selectedTextHash:'sha256:'+'a'.repeat(64),occurrence:0}}};
  const io:LinkedReferenceIO={getLink:vi.fn(async()=>link),resolveNote:vi.fn(async()=>({vaultId:'vault',notePath:'Moved.md'})),resolveTarget:vi.fn(async()=>({instanceId:'instance',profileId:'web',nativeSessionId:'native'})),read:vi.fn(async()=>markdown),process:vi.fn(async(_p,update)=>markdown=update(markdown)),saveClaimed:vi.fn(async()=>{})};
  const service=new LinkedReferenceService(io,()=>clock);
  return{service,io,link,setText:(text:string)=>markdown=text,tick:()=>clock+=301_000};
}
it('prepares the current moved note and registers an exact session claim only on commit',async()=>{
  const f=fixture(),p=await f.service.request('link-reference-prepare',input,'instance') as any;
  expect(p.source.locator.notePath).toBe('Moved.md');expect(p.source.snapshot.markdown).toContain('Later material');expect(f.io.saveClaimed).not.toHaveBeenCalled();
  expect(await f.service.request('link-reference-prepare',input,'instance')).toEqual(p);
  await f.service.request('link-reference-commit',{...input,setId:'set'},'instance');
  expect(f.io.saveClaimed).toHaveBeenCalledWith(expect.objectContaining({referenceId:input.operationId}),expect.objectContaining({sessionId:'native',setId:'set',logicalSessionId:'logical',dshInstanceId:'instance'}));
});
it.each(['deleted','changed','foreign','other-profile'])('refuses %s sources/targets without a saved capture',async kind=>{
  const f=fixture();if(kind==='deleted')f.link.deleted=true;if(kind==='changed')f.setText('The changed passage ^block');
  await expect(f.service.request('link-reference-prepare',{...input,...(kind==='other-profile'?{profileId:'other'}:{})},kind==='foreign'?'foreign':'instance')).rejects.toThrow();expect(f.io.saveClaimed).not.toHaveBeenCalled();
});
it('rejects expired preparation and set retargeting',async()=>{const f=fixture();await f.service.request('link-reference-prepare',input,'instance');await f.service.request('link-reference-commit',{...input,setId:'set'},'instance');await expect(f.service.request('link-reference-commit',{...input,setId:'other'},'instance')).rejects.toThrow();f.tick();await expect(f.service.request('link-reference-commit',{...input,setId:'set'},'instance')).rejects.toThrow('过期');});
it('supports whole-note links and limits source size',async()=>{const f=fixture();delete f.link.sticker;delete f.link.blockId;const p=await f.service.request('link-reference-prepare',input,'instance') as any;expect(p.source.selectedText).toBe('# Note');expect(p.source.snapshot.markdown).toContain('Later material');expect(f.io.process).toHaveBeenCalledTimes(1);const g=fixture();g.setText('x'.repeat(230*1024));await expect(g.service.request('link-reference-prepare',input,'instance')).rejects.toThrow('较大');});
it('refuses duplicate source anchors and revoked links at commit',async()=>{const f=fixture();f.setText('selected passage ^block\nselected passage ^block');await expect(f.service.request('link-reference-prepare',input,'instance')).rejects.toThrow('重复');const g=fixture();await g.service.request('link-reference-prepare',input,'instance');g.link.deleted=true;await expect(g.service.request('link-reference-commit',{...input,setId:'set'},'instance')).rejects.toThrow('解除');expect(g.io.saveClaimed).not.toHaveBeenCalled();});
