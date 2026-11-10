// Private reader owned by the desktop window. No dependency on the web service.
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {createApp} from '../server/index.mjs';

let desktopConfig={};try{desktopConfig=JSON.parse(await fs.readFile(new URL('./workspace.json',import.meta.url),'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
const fixture=process.env.BRAIN_FIXTURE==='1';
let fixtureConfig={};
if(fixture){
  const appRoot=fileURLToPath(new URL('../',import.meta.url));const runs=path.join(appRoot,'.runtime/desktop-smoke');await fs.mkdir(runs,{recursive:true});
  const workspaceRoot=await fs.mkdtemp(path.join(runs,'workspace-'));await fs.mkdir(path.join(workspaceRoot,'src'));await fs.writeFile(path.join(workspaceRoot,'README.md'),'# Workspace minh họa\nDữ liệu dùng cho kiểm thử desktop.');await fs.writeFile(path.join(workspaceRoot,'src/main.ts'),'export const fixture = true;');execFileSync('git',['init','--quiet',workspaceRoot]);
  const workspaceStateFile=path.join(workspaceRoot,'.tasks.json');await fs.writeFile(workspaceStateFile,JSON.stringify({tasks:[{id:'fixture-task',title:'Rà soát bố cục desktop',done:false,createdAt:'2026-11-10T00:00:00Z'}]}));
  const sessionId=randomUUID(),filename=path.join(workspaceRoot,'.native.jsonl');
  const rec=(type,payload)=>({timestamp:new Date().toISOString(),type,payload});
  const append=(...rows)=>fs.appendFile(filename,rows.map(r=>JSON.stringify(r)).join('\n')+'\n');
  const message=(role,text)=>rec('response_item',{type:'message',role,...(role==='assistant'?{phase:'final_answer'}:{}),content:[{type:role==='assistant'?'output_text':'input_text',text}]});
  await fs.writeFile(filename,JSON.stringify(rec('session_meta',{id:sessionId,cwd:workspaceRoot,source:'cli'}))+'\n');const firstTurn=randomUUID();await append(rec('turn_context',{turn_id:firstTurn,model:'fixture-model'}),message('user','Kiểm tra kết nối hội thoại.'),message('assistant','Đã đọc được phản hồi từ phiên Codex minh họa.'),rec('event_msg',{type:'task_complete',turn_id:firstTurn}),rec('event_msg',{type:'token_count',info:{last_token_usage:{total_tokens:12345},model_context_window:128000}}));
  fixtureConfig={workspaceRoot,workspaceStateFile,orca:{list:async()=>({available:true,items:[{id:'term_fixture-a',title:'Agent minh họa',engine:'codex',connected:true,writable:true,incarnationId:'fixture-process',worktreeId:'fixture-workspace'}]}),rename:async data=>({renamed:true,title:data.title}),inspectSettings:async()=>({supported:true,models:[{id:'fixture-model',name:'Codex minh họa',fast:true}],permissions:[{id:':read-only',name:'Chỉ đọc'}],runtime:{model:'fixture-model',permission:':read-only'},pending:[]}),prepareConversation:async()=>({root:workspaceRoot,filename,sessionId,validate:async()=>true}),send:async data=>{const turn=randomUUID();await append(rec('turn_context',{turn_id:turn,model:'fixture-model'}),message('user',data.message),rec('response_item',{type:'reasoning',content:[{text:'SECRET_NATIVE_REASONING'}]}));setTimeout(()=>void append(message('assistant','Phản hồi WebKit đã nhận thành công.'),rec('event_msg',{type:'task_complete',turn_id:turn})),1400).unref();return{accepted:true,requestId:'native-fixture-receipt'};}}};
}
const server=createApp({root:process.env.BRAIN_ROOT||path.join(os.homedir(),'avada-brain'),
  fixture,uiPort:0,...desktopConfig,...fixtureConfig});
let closing=false;
function stop(){
  if(closing)return;closing=true;
  server.close(()=>process.exit(0));
  server.closeIdleConnections();
  setTimeout(()=>{server.closeAllConnections();process.exit(0);},1500).unref();
}
process.once('SIGTERM',stop);
process.once('SIGINT',stop);
process.stdin.resume();
process.stdin.once('end',stop); // Parent exit must not leave a reader behind.
server.listen(0,'127.0.0.1',()=>{
  process.stdout.write(JSON.stringify({event:'ready',port:server.address().port})+'\n');
});
