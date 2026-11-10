import{test}from'node:test';import assert from'node:assert/strict';import fs from'node:fs/promises';import path from'node:path';import{execFileSync}from'node:child_process';
import{createApp}from'../server/index.mjs';import{createOrcaAdapter}from'../server/orca-adapter.mjs';
const runs=path.resolve('tests/.runs');await fs.mkdir(runs,{recursive:true});
async function fixture(send=async()=>({accepted:true,requestId:'receipt'})){
 const root=await fs.mkdtemp(path.join(runs,'workspace-'));await fs.mkdir(path.join(root,'src'));await fs.mkdir(path.join(root,'runtime'));
 await fs.writeFile(path.join(root,'src/main.ts'),'export const source = "read only";');await fs.writeFile(path.join(root,'.env'),'SECRET_SENTINEL');await fs.writeFile(path.join(root,'runtime/customer.md'),'SECRET_SENTINEL');await fs.writeFile(path.join(root,'service-account.json'),'SECRET_SENTINEL');
 execFileSync('git',['init','--quiet',root]);execFileSync('git',['-C',root,'add','.']);
 const orca={list:async()=>({available:true,items:[{id:'term_test',title:'Fixture agent',engine:'codex',connected:true,writable:true,incarnationId:'process-one',worktreeId:'workspace-one'}]}),send};
 const server=createApp({root:path.resolve('tests/fixtures/vault'),workspaceRoot:root,workspaceStateFile:path.join(root,'.app-state/tasks.json'),orca,fixture:true});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const base='http://127.0.0.1:'+server.address().port;const workspace=await(await fetch(base+'/api/workspace')).json();
 const post=(url,data,headers={})=>fetch(base+url,{method:'POST',headers:{'Content-Type':'application/json',Origin:base,'X-Andrew-Intent':workspace.intent,...headers},body:JSON.stringify(data)});
 return{root,server,base,workspace,post,close:()=>new Promise(r=>server.close(r))};
}
test('workspace file reader excludes secrets/runtime even when tracked, and denies traversal/symlinks',async()=>{
 const h=await fixture();try{
  assert.deepEqual(h.workspace.files,['src/main.ts']);assert.equal(h.workspace.dataset,'fixture');
  const file=await(await fetch(h.base+'/api/workspace/file?path=src%2Fmain.ts')).json();assert.equal(file.text,'export const source = "read only";');
  for(const p of['../.env','.env','runtime/customer.md','service-account.json','/etc/passwd'])assert.equal((await fetch(h.base+'/api/workspace/file?'+new URLSearchParams({path:p}))).status,404,p);
  await fs.symlink(path.join(h.root,'.env'),path.join(h.root,'src/link.ts'));assert.equal((await fetch(h.base+'/api/workspace/file?path=src%2Flink.ts')).status,403);
  assert.equal(await fs.readFile(path.join(h.root,'src/main.ts'),'utf8'),file.text);
 }finally{await h.close();}
});
test('checklist writes require same-origin user intent, persist and serialize without changing project files',async()=>{
 const h=await fixture();try{
  assert.equal((await h.post('/api/workspace/tasks',{title:'Denied'},{Origin:'https://evil.test'})).status,403);
  assert.equal((await h.post('/api/workspace/tasks',{title:'Denied'},{'X-Andrew-Intent':'wrong'})).status,403);
  const responses=await Promise.all(['Kiểm tra giao diện','Xác minh phạm vi'].map(title=>h.post('/api/workspace/tasks',{title})));assert(responses.every(r=>r.status===201));
  let state=await(await fetch(h.base+'/api/workspace')).json();assert.equal(state.tasks.length,2);
  const task=state.tasks[0];assert.equal((await h.post('/api/workspace/tasks',{id:task.id,done:true})).status,200);
  const saved=JSON.parse(await fs.readFile(path.join(h.root,'.app-state/tasks.json'),'utf8'));assert.equal(saved.tasks.find(t=>t.id===task.id).done,true);
  assert.equal((await h.post('/api/notes',{title:'No note writes'})).status,405);
  assert.equal(await fs.readFile(path.join(h.root,'src/main.ts'),'utf8'),'export const source = "read only";');
 }finally{await h.close();}
});
test('explicit command delivery is deduplicated, does not claim completion and rejects changed retries',async()=>{
 let calls=0;const h=await fixture(async data=>{calls++;assert.equal(data.incarnationId,'process-one');return{accepted:true,requestId:'orca-receipt'};});
 try{const body={requestId:'command-one',agentId:'term_test',incarnationId:'process-one',worktreeId:'workspace-one',message:'Fixture request',confirm:true};
  assert.equal((await h.post('/api/workspace/commands',{...body,confirm:false})).status,400);
  const receipts=await Promise.all([h.post('/api/workspace/commands',body),h.post('/api/workspace/commands',body)]);assert(receipts.every(r=>r.status===200));const saved=await receipts[0].json();assert.equal(saved.accepted,true);assert.equal(saved.completed,false);assert.equal(calls,1);
  assert.equal((await h.post('/api/workspace/commands',{...body,message:'different'})).status,409);assert.equal(calls,1);
 }finally{await h.close();}
});
test('unconfirmed delivery never automatically resends the same request',async()=>{
 let calls=0;const h=await fixture(async()=>{calls++;throw Error('SEND_UNCONFIRMED');});try{const body={requestId:'unknown-one',agentId:'term_test',incarnationId:'process-one',worktreeId:'workspace-one',message:'Fixture request',confirm:true};for(let i=0;i<2;i++)assert.equal((await h.post('/api/workspace/commands',body)).status,502);assert.equal(calls,1);}finally{await h.close();}
});
test('independent reader instances coordinate checklist writes without losing tasks',async()=>{
 const h=await fixture();const second=createApp({root:path.resolve('tests/fixtures/vault'),workspaceRoot:h.root,workspaceStateFile:path.join(h.root,'.app-state/tasks.json'),orca:{list:async()=>({available:false,items:[]}),send:async()=>{throw Error('No sends');}},fixture:true});await new Promise(r=>second.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+second.address().port;
 try{const state=await(await fetch(base+'/api/workspace')).json();const requests=Array.from({length:20},(_,i)=>i%2?h.post('/api/workspace/tasks',{title:'First '+i}):fetch(base+'/api/workspace/tasks',{method:'POST',headers:{'Content-Type':'application/json',Origin:base,'X-Andrew-Intent':state.intent},body:JSON.stringify({title:'Second '+i})}));const results=await Promise.all(requests);assert(results.every(r=>r.status===201));const current=await(await fetch(base+'/api/workspace')).json();assert.equal(current.tasks.length,20);assert.equal(new Set(current.tasks.map(t=>t.id)).size,20);}finally{await new Promise(r=>second.close(r));await h.close();}
});
test('Orca adapter filters metadata, binds process/workspace and keeps input out of OS argv',async()=>{
 const root=await fs.mkdtemp(path.join(runs,'orca-'));const bin=path.join(root,'resources/bin');const entryDir=path.join(root,'resources/app.asar.unpacked/out/cli');await fs.mkdir(bin,{recursive:true});await fs.mkdir(entryDir,{recursive:true});
 const terminal={handle:'term_test',title:'Fixture agent',agentIdentity:'codex',connected:true,writable:true,incarnationId:'process-one',worktreeId:'workspace-one',worktreePath:root,preview:'PRIVATE_TRANSCRIPT'};
 const payload={ok:true,result:{terminals:[terminal,{...terminal,handle:'term_other',worktreePath:root+'-other'},{...terminal,handle:'term_orphan',orphaned:true},{...terminal,handle:'term_shell',agentIdentity:'bash'}]}};
 await fs.writeFile(path.join(root,'metadata.json'),JSON.stringify(payload));const cli=path.join(root,'orca');
 await fs.writeFile(path.join(entryDir,'package.json'),'{"type":"commonjs"}');
 await fs.writeFile(cli,"#!/bin/sh\nlauncher='"+path.join(bin,'orca-ide')+"'\ncat '"+path.join(root,'metadata.json')+"'\n",{mode:0o755});
 await fs.writeFile(path.join(entryDir,'index.js'),"exports.main=async function(args){if(args[1]==='rename'){const title=args[args.indexOf('--title')+1];if(title!=='Fixture Renamed'||process.argv.join(' ').includes(title))throw Error('Unsafe rename argv');process.stdout.write(JSON.stringify({ok:true,result:{rename:{handle:'term_test',title}}}));return;}const message=args[args.indexOf('--text')+1];if(message!=='TEST_ONLY_PRIVATE_INPUT'||process.argv.join(' ').includes(message))throw Error('Unsafe argv');process.stdout.write(JSON.stringify({ok:true,id:'fixture-receipt',result:{send:{accepted:true,prompt:{requestId:'fixture-receipt',provider:'codex'}}}}));};");
 const orca=createOrcaAdapter(root,{cli,worktreeId:'workspace-one'});assert.deepEqual(await orca.rename({agentId:'term_test',incarnationId:'process-one',worktreeId:'workspace-one',title:'Fixture Renamed'}),{renamed:true,title:'Fixture Renamed'});const agents=await orca.list();assert.equal(agents.items.length,1);assert(!JSON.stringify(agents).includes('PRIVATE_TRANSCRIPT'));
 await assert.rejects(orca.send({agentId:'term_test',incarnationId:'changed',worktreeId:'workspace-one',message:'TEST_ONLY_PRIVATE_INPUT'}),/AGENT_CHANGED/);
 assert.deepEqual(await orca.send({agentId:'term_test',incarnationId:'process-one',worktreeId:'workspace-one',message:'TEST_ONLY_PRIVATE_INPUT',operation:'rename',title:'Do not rename'}),{accepted:true,requestId:'fixture-receipt',completed:false});
});

test('task deletion requires same-origin intent, removes only its ID and safely tolerates retries',async()=>{
 const h=await fixture(async()=>{throw Error('Deletion must not send an agent command');});try{
  const first=await(await h.post('/api/workspace/tasks',{title:'Task to remove'})).json();const second=await(await h.post('/api/workspace/tasks',{title:'Keep completed task'})).json();await h.post('/api/workspace/tasks',{id:second.id,done:true});
  const stateFile=path.join(h.root,'.app-state/tasks.json');const initial=JSON.parse(await fs.readFile(stateFile,'utf8'));initial.chatRequests={keep:{id:'keep',state:'accepted'}};await fs.writeFile(stateFile,JSON.stringify(initial));
  const remove=(id,headers={})=>fetch(h.base+'/api/workspace/tasks',{method:'DELETE',headers:{Origin:h.base,'Content-Type':'application/json','X-Andrew-Intent':h.workspace.intent,...headers},body:JSON.stringify({id})});
  assert.equal((await remove(first.id,{Origin:'https://evil.test'})).status,403);assert.equal((await remove(first.id,{'X-Andrew-Intent':'wrong'})).status,403);assert.equal((await remove('')).status,400);assert.equal((await remove('../all')).status,400);
  let saved=JSON.parse(await fs.readFile(stateFile,'utf8'));assert.equal(saved.tasks.length,2);
  const responses=await Promise.all([remove(first.id),remove(first.id),h.post('/api/workspace/tasks',{title:'Added while deleting'})]);assert(responses.slice(0,2).every(r=>r.status===200));assert.equal(responses[2].status,201);
  saved=JSON.parse(await fs.readFile(stateFile,'utf8'));assert.equal(saved.tasks.length,2);assert(!saved.tasks.some(t=>t.id===first.id));assert.equal(saved.tasks.find(t=>t.id===second.id).done,true);assert.deepEqual(saved.chatRequests,initial.chatRequests);
  assert.equal(await fs.readFile(path.join(h.root,'src/main.ts'),'utf8'),'export const source = "read only";');assert.equal((await remove(first.id)).status,200);
 }finally{await h.close();}
});
