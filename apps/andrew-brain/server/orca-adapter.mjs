import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {resolveCodexConversation} from './codex-conversation.mjs';
import {inspectCodexSettings} from './codex-controls.mjs';
const run=promisify(execFile);
const fallback=path.join(os.homedir(),'.config/orca/linux-orca-cli-shim/orca');

export function createOrcaAdapter(root,{worktreeId=null,cli=fallback}={}){
  async function call(args){
    const {stdout}=await run(cli,args,{cwd:root,timeout:12000,maxBuffer:2*1024*1024});
    const data=JSON.parse(stdout);if(!data.ok)throw Error('ORCA_UNAVAILABLE');return data.result;
  }
  async function list(){
    try{
      const args=['terminal','list','--environment','local','--json'];
      if(worktreeId)args.push('--worktree','id:'+worktreeId);
      const data=await call(args);
      // Terminal previews, transcripts and output are never returned to the UI.
      const items=(data.terminals||[]).filter(t=>t.worktreePath===root&&!t.orphaned&&t.connected&&['codex','claude'].includes(t.agentIdentity))
        .map(t=>({id:t.handle,title:t.title,engine:t.agentIdentity,connected:!!t.connected,
          writable:!!t.writable,incarnationId:t.incarnationId,worktreeId:t.worktreeId,
          workspacePath:t.worktreePath}));
      return{available:true,items};
    }catch{return{available:false,items:[],message:'Chưa kết nối được Orca. Mở Orca rồi tải lại danh sách agent.'};}
  }
  async function input({agentId,incarnationId,worktreeId:expectedWorkspace,message,title,operation}){
    const current=await list();
    const target=current.items.find(a=>a.id===agentId&&a.incarnationId===incarnationId&&a.worktreeId===expectedWorkspace&&a.writable);
    if(!target)throw Error('AGENT_CHANGED');
    // Read the installed CLI entry point; the CLI shim must still be valid.
    // The exported CLI main receives text in memory, never in OS argv.
    const shim=await fs.readFile(cli,'utf8');
    const launcher=/^launcher='([^']+)'/m.exec(shim)?.[1];
    if(!launcher)throw Error('ORCA_INPUT_UNAVAILABLE');
    const entry=path.resolve(path.dirname(launcher),'../app.asar.unpacked/out/cli/index.js');
    const helper=fileURLToPath(new URL('./orca-input.mjs',import.meta.url));
    const response=await new Promise((resolve,reject)=>{
      const child=execFile('/usr/bin/node',[helper,entry],{cwd:root,timeout:20000,maxBuffer:1024*1024},
        (error,stdout)=>error?reject(Error('SEND_UNCONFIRMED')):resolve(stdout));
      child.stdin.on('error',()=>{});
      child.stdin.end(JSON.stringify({root,terminal:target.id,message,title,operation}));
    });
    let receipt;try{receipt=JSON.parse(response);}catch{throw Error('SEND_UNCONFIRMED');}
    if(operation==='rename'){
      if(receipt.ok!==true||receipt.result?.rename?.handle!==target.id||receipt.result.rename.title!==title)throw Error('RENAME_UNCONFIRMED');
      return{renamed:true,title};
    }
    const delivery=receipt.result?.send;
    if(receipt.ok!==true||delivery?.accepted!==true||!delivery.prompt?.requestId||delivery.prompt.provider==='old-host')throw Error('SEND_UNCONFIRMED');
    return{accepted:true,requestId:delivery.prompt.requestId,completed:false};
  }
  async function prepareConversation({agentId,incarnationId,worktreeId:expectedWorkspace}){
    const current=await list();const target=current.items.find(a=>a.id===agentId&&a.incarnationId===incarnationId&&a.worktreeId===expectedWorkspace&&a.writable);
    if(!target)throw Error('AGENT_CHANGED');if(target.engine!=='codex')throw Error('CHAT_PROVIDER_UNSUPPORTED');
    return resolveCodexConversation(root,target);
  }
  return{list,send:data=>input({agentId:data.agentId,incarnationId:data.incarnationId,worktreeId:data.worktreeId,message:data.message}),rename:data=>input({agentId:data.agentId,incarnationId:data.incarnationId,worktreeId:data.worktreeId,title:data.title,operation:'rename'}),prepareConversation,inspectSettings:inspectCodexSettings};
}
