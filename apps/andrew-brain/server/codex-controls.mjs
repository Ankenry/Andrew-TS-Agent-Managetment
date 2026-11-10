import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const run=promisify(execFile),versions=new Map();
export const permissionChoices=[{id:':read-only',name:'Chỉ đọc'},{id:':workspace',name:'Trong workspace'},{id:':danger-full-access',name:'Toàn quyền'}];
const modelId=value=>typeof value==='string'&&/^[a-zA-Z0-9_.:/-]{1,120}$/.test(value)?value:null;
export function permissionId(policy){
 if(policy&&typeof policy==='object'&&permissionChoices.some(p=>p.id===policy.id))return policy.id;
 const type=typeof policy==='object'&&policy?policy.type:policy;
 if(['read-only','readOnly'].includes(type))return ':read-only';
 if(['workspace-write','workspaceWrite'].includes(type))return ':workspace';
 if(['danger-full-access','dangerFullAccess','disabled'].includes(type))return ':danger-full-access';
 return null;
}
export function permissionFingerprint(policy){
 if(!policy||typeof policy!=='object')return null;
 const sorted=value=>Array.isArray(value)?value.map(sorted):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,sorted(value[key])])):value;
 return createHash('sha256').update(JSON.stringify(sorted(policy))).digest('hex');
}
export async function inspectCodexSettings(source){
 const home=source.codexHome;if(!home)return{supported:false,models:[],permissions:permissionChoices,runtime:{},message:'Chưa đọc được cấu hình phiên Codex.'};
 let models=[],runtime={},supported=false;
 try{const cache=JSON.parse(await fs.readFile(path.join(home,'models_cache.json'),'utf8'));models=(cache.models||[]).filter(m=>m.visibility==='list'&&modelId(m.slug)).map(m=>({id:m.slug,name:typeof m.display_name==='string'?m.display_name.slice(0,80):m.slug,fast:(m.service_tiers||[]).some(t=>t.id==='priority')}));}catch{}
 try{
  const executable=await fs.readlink(path.join(source.procRoot||'/proc',String(source.pid),'exe'));
  let version=versions.get(executable);if(!version){version=(await run(executable,['--version'],{timeout:3000,maxBuffer:4096})).stdout;versions.set(executable,version);}
  const match=/codex(?:-cli)?\s+(\d+)\.(\d+)\.(\d+)/i.exec(version);supported=!!match&&(Number(match[1])>0||Number(match[2])>=167);
 }catch{}
 try{
  const script=fileURLToPath(new URL('./codex-runtime.py',import.meta.url));
  const stdout=await new Promise((resolve,reject)=>{const child=execFile('/usr/bin/python3',[script],{timeout:3500,maxBuffer:16384},(error,out)=>error?reject(error):resolve(out));child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify({codexHome:home,root:source.root,sessionId:source.sessionId,filename:source.filename}));});
  const data=JSON.parse(stdout);let policy;try{policy=JSON.parse(data.sandbox_policy);}catch{}
  runtime={model:modelId(data.model),effort:modelId(data.reasoning_effort),permission:permissionId(policy),permissionFingerprint:permissionFingerprint(policy),approvalPolicy:['never','on-request','untrusted'].includes(data.approval_mode)?data.approval_mode:null};
 }catch{}
 return{supported,models,permissions:permissionChoices,runtime,...(!supported?{message:'Phiên này chưa hỗ trợ điều khiển inline; kiểm tra trong Orca.'}:{})};
}
export function controlCommand(data,settings,currentModel){
 if(!settings.supported)throw Error('CONTROLS_UNAVAILABLE');
 if(data.action==='model'&&settings.models.some(m=>m.id===data.value))return '/model '+data.value;
 if(data.action==='speed'&&['standard','priority'].includes(data.value)){
  if(data.value==='priority'&&!settings.models.some(m=>m.id===currentModel&&m.fast))throw Error('FAST_UNAVAILABLE');
  return '/model --speed='+data.value;
 }
 if(data.action==='permission'&&permissionChoices.some(p=>p.id===data.value))return '/permissions '+data.value;
 throw Error('INVALID_CONTROL');
}
