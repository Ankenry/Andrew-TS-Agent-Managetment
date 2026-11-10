// Read only the public conversation of the exact live Codex process in Orca.
// Reasoning text, system/developer content and tool arguments/results never leave here.
import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {EventEmitter} from 'node:events';
import {randomUUID} from 'node:crypto';
import {permissionId,permissionFingerprint} from './codex-controls.mjs';

const UUID=/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/i;
const FILE=new RegExp('^rollout-.+-('+UUID.source+')\\.jsonl$','i');
const primary=meta=>typeof meta.source==='string'&&!meta.parent_thread_id;
const startTicks=text=>text.slice(text.lastIndexOf(')')+2).trim().split(/\s+/)[19];
const safeText=(content,type)=>Array.isArray(content)?content.filter(p=>p?.type===type&&typeof p.text==='string').map(p=>p.text).join('\n'):'';
const bootstrap=text=>/^(?:# AGENTS\.md instructions|<environment_context>|<permissions instructions>|<user_instructions>|<INSTRUCTIONS>)/i.test(text.trim());

async function header(filename){
 const fd=await fs.open(filename,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{let data=Buffer.alloc(0),offset=0;while(data.length<2*1024*1024){const b=Buffer.alloc(65536);const{bytesRead}=await fd.read(b,0,b.length,offset);if(!bytesRead)break;offset+=bytesRead;data=Buffer.concat([data,b.subarray(0,bytesRead)]);const at=data.indexOf(10);if(at>=0){const record=JSON.parse(data.subarray(0,at).toString('utf8'));if(record.type!=='session_meta')throw Error('CODEX_SOURCE_UNAVAILABLE');return record.payload;}}throw Error('CODEX_SOURCE_UNAVAILABLE');}finally{await fd.close();}
}

export async function resolveCodexConversation(root,target,{procRoot='/proc'}={}){
 root=await fs.realpath(root);const found=[];
 for(const name of await fs.readdir(procRoot)){
  if(!/^\d+$/.test(name))continue;const proc=path.join(procRoot,name);
  try{
   const args=(await fs.readFile(path.join(proc,'cmdline'),'utf8')).split('\0');
   if(path.basename(args[0]||'')!=='codex')continue;
   const envText=await fs.readFile(path.join(proc,'environ'),'utf8');let terminal=null,codexHome=null;
   for(const entry of envText.split('\0')){if(entry.startsWith('ORCA_TERMINAL_HANDLE='))terminal=entry.slice(21);if(entry.startsWith('CODEX_HOME='))codexHome=entry.slice(11);}
   if(terminal!==target.id||await fs.realpath(path.join(proc,'cwd'))!==root)continue;
   if((await fs.stat(proc)).uid!==process.getuid())continue;
   const expected=args.find((a,i)=>i>0&&args[i-1]==='resume'&&new RegExp('^'+UUID.source+'$','i').test(a));
   const sessionsRoot=await fs.realpath(path.join(codexHome||path.join(os.homedir(),'.codex'),'sessions'));
   for(const fd of await fs.readdir(path.join(proc,'fd'))){
    try{
     const filename=await fs.readlink(path.join(proc,'fd',fd));const match=FILE.exec(path.basename(filename));
     if(!match||expected&&match[1]!==expected)continue;
     const canonical=await fs.realpath(filename);if(canonical!==filename||!canonical.startsWith(sessionsRoot+path.sep))continue;
     const meta=await header(filename);if(meta.id!==match[1]||await fs.realpath(meta.cwd)!==root||!primary(meta))continue;
     const stat=await fs.stat(filename);if(!stat.isFile()||stat.uid!==process.getuid())continue;
     const source={sessionId:meta.id,root,filename,codexHome:await fs.realpath(codexHome||path.join(os.homedir(),'.codex')),pid:Number(name),fd,procRoot,startTicks:startTicks(await fs.readFile(path.join(proc,'stat'),'utf8')),ino:stat.ino,dev:stat.dev};
     found.push(source);
    }catch{}
   }
  }catch{}
 }
 const unique=[...new Map(found.map(s=>[s.pid+':'+s.sessionId,s])).values()];
 if(unique.length!==1)throw Error(unique.length?'CODEX_SOURCE_AMBIGUOUS':'CODEX_SOURCE_UNAVAILABLE');
 return unique[0];
}

export async function validateCodexConversation(source){
 if(source.validate)return source.validate();
 try{const proc=path.join(source.procRoot||'/proc',String(source.pid));return startTicks(await fs.readFile(path.join(proc,'stat'),'utf8'))===source.startTicks&&await fs.readlink(path.join(proc,'fd',source.fd))===source.filename&&await fs.realpath(path.join(proc,'cwd'))===source.root;}catch{return false;}
}

export class PublicConversation extends EventEmitter{
 constructor(source,{pollMs=250,maxMessages=60,maxHistoryBytes=2*1024*1024}={}){
  super();Object.assign(this,{source,pollMs,maxMessages,maxHistoryBytes});this.id=randomUUID();this.messages=[];this.status={state:'idle',activity:'idle',turnId:null,startedAt:null};this.sequence=0;this.frames=[];this.carry=Buffer.alloc(0);this.offset=0;this.lineStart=0;this.timer=null;this.reading=false;this.closed=false;this.lastUsed=Date.now();
 }
 async initialize(){
  const meta=await header(this.source.filename);if(meta.id!==this.source.sessionId||await fs.realpath(meta.cwd)!==this.source.root)throw Error('CODEX_SOURCE_UNAVAILABLE');
  this.file=await fs.open(this.source.filename,constants.O_RDONLY|constants.O_NOFOLLOW);try{const stat=await this.file.stat();this.ino=stat.ino;this.dev=stat.dev;this.offset=Math.max(0,stat.size-this.maxHistoryBytes);this.lineStart=this.offset;this.skipFirst=this.offset>0;this.historyTruncated=this.skipFirst;await this.readAvailable();return this;}catch(e){await this.file.close();this.file=null;throw e;}
 }
 snapshot(){return{id:this.id,sessionId:this.source.sessionId,messages:this.messages,status:this.status,usage:this.usage||null,sequence:this.sequence,historyTruncated:this.historyTruncated};}
 setUsage(usage){this.usage=usage;this.publish('usage',{usage});}
 publish(type,data){const frame={sequence:++this.sequence,type,...data};this.frames.push(frame);while(this.frames.length>180||this.frames.length>1&&this.frames.reduce((n,f)=>n+JSON.stringify(f).length,0)>4*1024*1024)this.frames.shift();this.emit('frame',frame);this.onChange?.(this,frame);}
 setStatus(next){const value={...this.status,...next};if(JSON.stringify(value)===JSON.stringify(this.status))return;this.status=value;this.publish('status',{status:this.status});}
 consume(record,offset){
  const p=record.payload||{},parsedTime=typeof record.timestamp==='string'&&record.timestamp.length<50?Date.parse(record.timestamp):NaN,time=Number.isFinite(parsedTime)?new Date(parsedTime).toISOString():new Date().toISOString();
  if(record.type==='compacted'||record.type==='event_msg'&&p.type==='context_compacted'){this.setUsage(null);return;}
  if(record.type==='turn_context'){
   if(typeof p.model==='string'&&this.status.model&&p.model!==this.status.model)this.setUsage(null);
   const runtime={permission:permissionId(p.active_permission_profile)||permissionId(p.permission_profile)||permissionId(p.sandbox_policy),permissionFingerprint:permissionFingerprint(p.permission_profile||p.sandbox_policy),approvalPolicy:['never','on-request','untrusted'].includes(p.approval_policy)?p.approval_policy:null,serviceTier:['default','standard','priority'].includes(p.service_tier)?p.service_tier:null};
   this.setStatus(runtime);
   this.setStatus({state:'running',activity:'thinking',turnId:typeof p.turn_id==='string'&&new RegExp('^'+UUID.source+'$','i').test(p.turn_id)?p.turn_id:null,startedAt:time,finishedAt:null,...(typeof p.model==='string'&&/^[a-zA-Z0-9_.:/-]{1,120}$/.test(p.model)?{model:p.model}:{})});return;
  }
  if(record.type==='response_item'&&p.type==='message'){
   let text,phase;
   if(p.role==='user'){text=safeText(p.content,'input_text');if(!text||bootstrap(text))return;phase='user';}
   else if(p.role==='assistant'&&['commentary','final','final_answer'].includes(p.phase)&&p.channel!=='analysis'){text=safeText(p.content,'output_text');phase=p.phase==='commentary'?'commentary':'final';}
   else return;
   if(!text)return;if(text.length>512000){this.setStatus({state:'error',activity:'reply_too_large'});return;}
   const message={id:this.source.sessionId+':'+offset,role:p.role,text,phase,turnId:this.status.turnId,timestamp:time};
   this.messages.push(message);while(this.messages.length>this.maxMessages||this.messages.length>1&&this.messages.reduce((n,m)=>n+Buffer.byteLength(m.text),0)>2*1024*1024){this.messages.shift();this.historyTruncated=true;}
   this.publish('message',{message});if(p.role==='assistant')this.setStatus({state:'running',activity:'responding'});return;
  }
  if(record.type==='response_item'&&['reasoning','function_call','function_call_output','custom_tool_call','custom_tool_call_output'].includes(p.type)){
   const activity=p.type==='reasoning'||p.type.endsWith('_output')?'thinking':/request_user_input/.test(p.name||'')?'waiting_input':'working';
   this.setStatus({state:'running',activity});return;
  }
  if(record.type==='event_msg'){
   if(p.type==='token_count'){
    const used=p.info?.last_token_usage?.total_tokens,total=p.info?.model_context_window;
    if(Number.isSafeInteger(used)&&used>=0&&Number.isSafeInteger(total)&&total>0)this.setUsage({used,total,observedAt:time,model:this.status.model||null});
    return;
   }
   if(p.type==='task_complete'&&(!p.turn_id||!this.status.turnId||p.turn_id===this.status.turnId)){const reply=this.messages.some(m=>m.role==='assistant'&&m.phase==='final'&&m.turnId===this.status.turnId);this.setStatus({state:reply?'completed':'error',activity:reply?'idle':'reply_missing',finishedAt:time});return;}
   if(['task_aborted','turn_aborted','task_interrupted'].includes(p.type)){this.setStatus({state:'interrupted',activity:'idle',finishedAt:time});return;}
   if(['agent_reasoning','reasoning'].includes(p.type)){this.setStatus({state:'running',activity:'thinking'});return;}
   if(p.type==='error'){this.setStatus({state:'error',activity:'runtime_error'});return;}
   if(p.type==='item_completed'&&p.item?.type==='function_call')this.setStatus({state:'running',activity:/request_user_input/.test(p.item.name||'')?'waiting_input':'working'});
  }
 }
 async readAvailable(){
  const stat=await this.file.stat();if(stat.ino!==this.ino||stat.dev!==this.dev||stat.size<this.offset)throw Error('CODEX_SOURCE_CHANGED');
  while(this.offset<stat.size){
   const bytes=Buffer.alloc(Math.min(262144,stat.size-this.offset));const{bytesRead}=await this.file.read(bytes,0,bytes.length,this.offset);if(!bytesRead)break;this.offset+=bytesRead;this.carry=Buffer.concat([this.carry,bytes.subarray(0,bytesRead)]);
   for(;;){const newline=this.carry.indexOf(10);if(newline<0)break;const line=this.carry.subarray(0,newline),start=this.lineStart;this.carry=this.carry.subarray(newline+1);this.lineStart=start+newline+1;if(this.skipFirst){this.skipFirst=false;continue;}if(!line.length)continue;try{this.consume(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(line)),start);}catch{throw Error('CODEX_RECORD_INVALID');}}
   if(this.carry.length>4*1024*1024)throw Error('CODEX_RECORD_TOO_LARGE');
  }
 }
 async refresh(){
  if(this.reading||this.closed)return;this.reading=true;
  try{await this.readAvailable();if(!await validateCodexConversation(this.source))throw Error('CODEX_SOURCE_CHANGED');}
  catch{this.setStatus({state:'disconnected',activity:'source_changed'});this.stop();}
  finally{this.reading=false;}
 }
 start(){if(!this.timer&&!this.closed){this.timer=setInterval(()=>void this.refresh(),this.pollMs);this.timer.unref();void this.refresh();}}
 stop(){if(this.timer)clearInterval(this.timer);this.timer=null;}
 async close(){if(this.closed)return;this.closed=true;this.stop();this.emit('closed');await this.file?.close().catch(()=>{});this.removeAllListeners();}
}

export function createCodexChatBridge({root,orca,onChange=null}={}){
 const sessions=new Map();
 const binding=(a,b)=>a.id===b.agentId&&a.incarnationId===b.incarnationId&&a.worktreeId===b.worktreeId;
 async function open(data){
  const source=await orca.prepareConversation(data);
  if(source.root!==root)throw Error('AGENT_CHANGED');
  const key=[data.agentId,data.incarnationId,data.worktreeId,source.sessionId].join(':');let session=sessions.get(key);
  if(session&&!session.closed&&await validateCodexConversation(session.source)){await session.refresh();if(session.status.state!=='disconnected'){session.lastUsed=Date.now();return session;}}
  if(session)await session.close();
  if(sessions.size>=32){const idle=[...sessions.entries()].filter(([,s])=>s.listenerCount('frame')===0).sort((a,b)=>a[1].lastUsed-b[1].lastUsed)[0];if(!idle)throw Error('CHAT_LIMIT');await idle[1].close();sessions.delete(idle[0]);}
  session=new PublicConversation(source);session.onChange=onChange;await session.initialize();session.agent={id:data.agentId,incarnationId:data.incarnationId,worktreeId:data.worktreeId};sessions.set(key,session);return session;
 }
 function get(id){return[...sessions.values()].find(s=>s.id===id&&!s.closed);}
 async function verify(id,data){const session=get(id);if(!session||!binding(session.agent,data)||!await validateCodexConversation(session.source))throw Error('AGENT_CHANGED');return session;}
 function subscribe(id,after,req,res){
  const session=get(id);if(!session)return false;
  res.writeHead(200,{'Content-Type':'application/x-ndjson; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Connection':'keep-alive'});res.flushHeaders();
  const write=frame=>{if(!res.destroyed)res.write(JSON.stringify(frame)+'\n');};
  if(after<(session.frames[0]?.sequence||0)-1)write({type:'snapshot',...session.snapshot()});else for(const frame of session.frames)if(frame.sequence>after)write(frame);
  session.on('frame',write);session.start();const heartbeat=setInterval(()=>write({type:'heartbeat',sequence:session.sequence}),10000);heartbeat.unref();
  const closed=()=>{if(!res.destroyed)res.end();};session.on('closed',closed);
  res.once('close',()=>{clearInterval(heartbeat);session.off('frame',write);session.off('closed',closed);if(!session.listenerCount('frame'))session.stop();session.lastUsed=Date.now();});return true;
 }
 return{open,get,verify,subscribe,close:()=>{for(const s of sessions.values())void s.close();sessions.clear();}};
}
