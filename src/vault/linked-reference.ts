import { z } from 'zod';
import { createObsidianReferenceCapture, occurrenceAtBlock, selectionOffsets } from './reference-source.ts';
import { ReferenceClaimV2Schema, canonicalSha256, type ObsidianReferenceCaptureV2, type ReferenceClaimV2 } from '../protocol.ts';
import type { LocalKnowledgeLink } from './knowledge-store.ts';

const inputSchema = z.object({ objectId:z.string().min(1).max(256), operationId:z.string().uuid(), nativeSessionId:z.string().min(1), logicalSessionId:z.string().min(1), profileId:z.string().min(1), setId:z.string().min(1).optional() });
type Input = z.infer<typeof inputSchema>;
type Prepared = { identity:string; capture:ObsidianReferenceCaptureV2; input:Input; expires:number; claimedSet?:string };
export interface LinkedReferenceIO {
  getLink(objectId:string, instanceId:string):Promise<LocalKnowledgeLink>;
  resolveNote(noteId:string, instanceId:string):Promise<{vaultId:string;notePath:string}>;
  resolveTarget(logicalSessionId:string):Promise<{instanceId:string;profileId:string;nativeSessionId:string}>;
  read(path:string):Promise<string|null>;
  process(path:string, update:(text:string)=>string):Promise<string>;
  saveClaimed(capture:ObsidianReferenceCaptureV2, claim:ReferenceClaimV2):Promise<void>;
}
/** Explicit dock actions only. These references never enter the automatic capture queue. */
export class LinkedReferenceService {
  private readonly prepared = new Map<string,Prepared>();
  constructor(private readonly io:LinkedReferenceIO, private readonly now=Date.now) {}
  async request(operation:string, raw:Record<string,unknown>, instanceId:string) {
    const input=inputSchema.parse(raw), key=instanceId+':'+input.operationId;
    for(const [k,v] of this.prepared)if(v.expires<this.now())this.prepared.delete(k);
    const link=await this.io.getLink(input.objectId,instanceId);
    if(link.deleted || link.logicalSessionId!==input.logicalSessionId)throw new Error('关联已解除或不属于当前会话');
    const target=await this.io.resolveTarget(link.logicalSessionId);
    if(target.instanceId!==instanceId || target.profileId!==input.profileId || target.nativeSessionId!==input.nativeSessionId)throw new Error('引用目标已改变，请重新打开会话');
    const identity=canonicalSha256({instanceId,objectId:input.objectId,nativeSessionId:input.nativeSessionId,logicalSessionId:input.logicalSessionId,profileId:input.profileId});
    const old=this.prepared.get(key);
    if(old && old.identity!==identity)throw new Error('此引用操作已经绑定另一目标');
    if(operation==='link-reference-commit'){
      if(!old || !input.setId)throw new Error('引用准备已过期，请重新引用');
      if(old.claimedSet && old.claimedSet!==input.setId)throw new Error('引用已经加入另一引用集');
      const claim=ReferenceClaimV2Schema.parse({annotationProtocolVersion:2,type:'reference-claim',referenceId:old.capture.referenceId,setId:input.setId,profileId:input.profileId,sessionId:input.nativeSessionId,dshInstanceId:instanceId,logicalSessionId:input.logicalSessionId});
      await this.io.saveClaimed(old.capture,claim);old.claimedSet=input.setId;
      return {committed:true,referenceId:old.capture.referenceId};
    }
    if(operation!=='link-reference-prepare')throw new Error('不支持此引用操作');
    if(old)return {referenceId:old.capture.referenceId,source:old.capture.source};
    if(this.prepared.size>=32)throw new Error('待处理的引用过多，请稍后重试');
    const note=await this.io.resolveNote(link.noteId,instanceId);
    let markdown=await this.io.read(note.notePath);if(markdown===null)throw new Error('关联笔记已不存在');
    if(Buffer.byteLength(markdown,'utf8')>220*1024)throw new Error('笔记较大，请在 Obsidian 中选择需要的段落引用');
    let blockId=link.blockId, selected=link.sticker?.selection.selectedText, occurrence=0;
    if(selected){
      if(!blockId)throw new Error('来源选段缺少定位，请在 Obsidian 重新选择');
      const escaped=blockId.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
      if([...markdown.matchAll(new RegExp('(?:^|\\s)\\^'+escaped+'[ \\t]*(?=\\r?$)','gm'))].length!==1)throw new Error('原选段定位缺失或重复，请在 Obsidian 重新选择');
      const found=occurrenceAtBlock(markdown,selected,blockId);
      if(found===undefined)throw new Error('原选段已变动或无法唯一定位，请在 Obsidian 重新选择');
      occurrence=found;
    }else{
      // Whole-note associations use a short preview; the existing source protocol carries the current note body.
      const body=markdown.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/,'');
      selected=body.split(/\r?\n/).find(line=>line.trim() && !line.startsWith('<!--') && !line.startsWith('```'))?.trim().slice(0,2000);
      if(!selected)throw new Error('笔记没有可引用的正文');
      if(!blockId){
        blockId='dsh-note-link-'+link.noteId;
        const marker='^'+blockId, before=markdown;
        if(!markdown.split(/\r?\n/).some(l=>l.trim()===marker)) markdown=await this.io.process(note.notePath,text=>{if(text!==before)throw new Error('笔记正在编辑，请重试');return text+'\n\n'+marker+'\n';});
      }
      occurrence=0;
      if(!selectionOffsets(markdown,selected).length)throw new Error('笔记内容已改变，请重试');
    }
    const capture={...createObsidianReferenceCapture({actionId:input.operationId,referenceId:input.operationId,vaultId:note.vaultId,notePath:note.notePath,blockId:blockId!,selectedText:selected,occurrence,markdown,capturedAt:this.now()}),dshInstanceId:instanceId};
    this.prepared.set(key,{identity,capture,input,expires:this.now()+5*60_000});
    return {referenceId:capture.referenceId,source:capture.source};
  }
}
