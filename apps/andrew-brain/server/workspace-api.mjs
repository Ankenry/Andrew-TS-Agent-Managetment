import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createOrcaAdapter} from './orca-adapter.mjs';
import {createCodexChatBridge} from './codex-conversation.mjs';
import {controlCommand} from './codex-controls.mjs';
const run=promisify(execFile);
const denied=/^(?:\.|node_modules$|runtime$|apps_doc$|knowledge-base$|db$|dist$|coverage$|private$|secrets?$|credentials?|service[-_]?account|auth(?:\.|$)|logs?$|sessions?$|memories$|tokens?$|test-results$|playwright-report$)/i;
const textFiles=/\.(?:md|txt|json|[cm]?js|jsx|ts|tsx|css|html|svg|py|sh|ya?ml|toml|patch|sql)$/i;
class WorkspaceError extends Error{constructor(status,code,message){super(message);this.status=status;this.code=code;}}
export function createWorkspaceApi({root,stateFile=path.join(os.homedir(),'.local/state/andrew-brain/workspace.json'),orca=null,fixture=false,worktreeId=null}={}){
  root=path.resolve(root);orca||=createOrcaAdapter(root,{worktreeId});
  const intent=randomBytes(24).toString('hex');let writes=Promise.resolve();const commands=new Map();
  const fail=(status,code,message)=>{throw new WorkspaceError(status,code,message);};
  async function files(){
    const {stdout}=await run('git',['-C',root,'ls-files','--cached','--others','--exclude-standard','-z'],{timeout:8000,maxBuffer:4*1024*1024});
    return [...new Set(stdout.split('\0').filter(Boolean))].filter(p=>!p.split('/').some(s=>denied.test(s))&&!p.startsWith('docs/reports/')&&textFiles.test(p)).sort();
  }
  async function state(){try{const data=JSON.parse(await fs.readFile(stateFile,'utf8'));if(!Array.isArray(data.tasks))throw Error();return data;}catch(e){if(e.code==='ENOENT')return{tasks:[]};fail(503,'STATE_UNAVAILABLE','Chưa đọc được checklist. Thử mở lại ứng dụng.');}}
  async function lock(){
    await fs.mkdir(path.dirname(stateFile),{recursive:true,mode:0o700});const lockFile=stateFile+'.lock';
    for(let attempt=0;attempt<100;attempt++){
      try{const fd=await fs.open(lockFile,'wx',0o600);try{await fd.writeFile(JSON.stringify({pid:process.pid}));}catch(e){await fd.close();await fs.unlink(lockFile).catch(()=>{});throw e;}return async()=>{await fd.close();await fs.unlink(lockFile);};}
      catch(e){if(e.code!=='EEXIST')throw e;try{const owner=JSON.parse(await fs.readFile(lockFile,'utf8'));if(Number.isInteger(owner.pid)&&owner.pid>0){try{process.kill(owner.pid,0);}catch(error){if(error.code==='ESRCH')await fs.unlink(lockFile).catch(()=>{});}}}catch{}await new Promise(r=>setTimeout(r,25));}
    }
    fail(503,'CHECKLIST_BUSY','Checklist đang cập nhật. Chờ một chút rồi thử lại.');
  }
  async function mutate(fn){const work=writes.then(async()=>{const release=await lock();try{const data=await state();const result=fn(data);const temp=stateFile+'.tmp';await fs.writeFile(temp,JSON.stringify(data),{mode:0o600});await fs.rename(temp,stateFile);return result;}finally{await release();}});writes=work.catch(()=>{});return work;}
  const messageHash=text=>createHash('sha256').update(text.replace(/\r\n/g,'\n').trim()).digest('hex');
  const pending=r=>r&&['sending','accepted','running','unconfirmed'].includes(r.state);
  async function syncChat(snapshot){
    const saved=await state();if(!Object.values(saved.chatRequests||{}).some(r=>r.sessionId===snapshot.sessionId&&pending(r)))return;
    await mutate(data=>{for(const record of Object.values(data.chatRequests||{})){
      if(record.sessionId!==snapshot.sessionId||!pending(record))continue;
      const user=snapshot.messages.find(m=>m.role==='user'&&Date.parse(m.timestamp)>=Date.parse(record.createdAt)&&messageHash(m.text)===record.messageHash);
      if(!user)continue;record.turnId=user.turnId;record.state='running';
      if(snapshot.status.turnId===user.turnId&&snapshot.status.state==='completed'&&snapshot.messages.some(m=>m.role==='assistant'&&m.phase==='final'&&m.turnId===user.turnId&&Date.parse(m.timestamp)>=Date.parse(user.timestamp))){record.state='completed';record.finishedAt=snapshot.status.finishedAt;}
      if(snapshot.status.turnId===user.turnId&&snapshot.status.state==='interrupted')record.state='interrupted';
      if(snapshot.status.turnId===user.turnId&&snapshot.status.state==='error'&&snapshot.status.activity==='reply_missing')record.state='failed';
    }});
  }
  const chat=typeof orca.prepareConversation==='function'?createCodexChatBridge({root,orca,onChange:(session,frame)=>{
    if(!['message','status'].includes(frame.type))return;const snapshot=session.snapshot();snapshot.messages=[...snapshot.messages];void syncChat(snapshot).catch(()=>{});
  }}):null;
  async function chatSnapshot(session){const snapshot=session.snapshot();await syncChat(snapshot);const saved=await state();return{...snapshot,pending:Object.values(saved.chatRequests||{}).filter(r=>r.sessionId===snapshot.sessionId&&pending(r)).map(r=>({id:r.id,state:r.state,createdAt:r.createdAt,turnId:r.turnId||null}))};}
  const nameKey=a=>createHash('sha256').update(JSON.stringify([root,a.agentId||a.id,a.incarnationId,a.worktreeId])).digest('hex');
  const unresolved=r=>['sending','accepted','unconfirmed'].includes(r.state);
  async function settingsSnapshot(session){
    const settings=typeof orca.inspectSettings==='function'?await orca.inspectSettings(session.source):{supported:false,models:[],permissions:[],runtime:{},message:'Phiên này chưa hỗ trợ điều khiển cấu hình.'};
    const runtime={...settings.runtime};if(session.status.serviceTier)runtime.serviceTier=session.status.serviceTier==='default'?'standard':session.status.serviceTier;
    if(!runtime.permission&&runtime.permissionFingerprint&&runtime.permissionFingerprint===session.status.permissionFingerprint)runtime.permission=session.status.permission;
    if(runtime.model&&runtime.model!==session.status.model){session.setUsage(null);session.setStatus({model:runtime.model});}
    if(runtime.permission&&runtime.permission!==session.status.permission)session.setStatus({permission:runtime.permission,approvalPolicy:runtime.approvalPolicy});
    const saved=await state(),records=Object.values(saved.controlRequests||{}).filter(r=>r.sessionId===session.source.sessionId&&unresolved(r));
    const matches=r=>r.state!=='sending'&&r.state!=='unconfirmed'&&({model:runtime.model,speed:runtime.serviceTier,permission:runtime.permission})[r.action]===r.value;
    if(records.some(matches))await mutate(data=>{for(const r of Object.values(data.controlRequests||{}))if(r.sessionId===session.source.sessionId&&unresolved(r)&&matches(r))r.state='confirmed';});
    return{...settings,runtime,pending:records.filter(r=>!matches(r)).map(r=>({id:r.id,action:r.action,value:r.value,state:r.state}))};
  }
  function readIntent(req){if(req.headers['x-andrew-intent']!==intent||req.headers.origin&&req.headers.origin!==`http://${req.headers.host}`)fail(403,'USER_ACTION_REQUIRED','Mở hội thoại từ cửa sổ Andrew Brain.');}
  function chatFailure(error){
    const code=error.message;
    if(code==='AGENT_CHANGED')fail(409,code,'Phiên agent đã thay đổi. Tải lại và chọn lại agent.');
    if(code==='CHAT_PROVIDER_UNSUPPORTED')fail(409,code,'Chat trực tiếp hiện hỗ trợ Codex local. Chọn một phiên Codex trong Orca.');
    fail(503,'CODEX_CONVERSATION_UNAVAILABLE','Chưa nối được hội thoại của phiên Codex này. Kiểm tra phiên trong Orca rồi chọn lại.');
  }
  async function input(req){
    if(req.headers.origin!==`http://${req.headers.host}`||req.headers['x-andrew-intent']!==intent)fail(403,'USER_ACTION_REQUIRED','Thao tác cần được gửi từ cửa sổ Andrew Brain.');
    if(!/^application\/json(?:;|$)/i.test(req.headers['content-type']||''))fail(415,'JSON_REQUIRED','Định dạng yêu cầu chưa hợp lệ.');
    const chunks=[];let size=0;for await(const b of req){size+=b.length;if(size>16000)fail(413,'TOO_LARGE','Nội dung quá dài.');chunks.push(b);}
    try{return JSON.parse(Buffer.concat(chunks));}catch{fail(400,'INVALID_JSON','Nội dung yêu cầu chưa hợp lệ.');}
  }
  async function file(relative){
    if(typeof relative!=='string'||path.isAbsolute(relative)||relative.includes('\\')||relative.split('/').some(s=>s==='..'||denied.test(s)))fail(404,'FILE_DENIED','File không nằm trong phạm vi đọc.');
    if(!(await files()).includes(relative))fail(404,'FILE_DENIED','Không tìm thấy file trong workspace.');
    if(await fs.realpath(root)!==root)fail(403,'ROOT_CHANGED','Đường dẫn workspace đã thay đổi.');
    let current=root;for(const segment of relative.split('/')){current=path.join(current,segment);if((await fs.lstat(current)).isSymbolicLink())fail(403,'SYMLINK_DENIED','Không đọc file qua symlink.');}
    const stat=await fs.lstat(current);if(!stat.isFile())fail(404,'FILE_DENIED','Đây không phải file văn bản.');
    if(stat.size>256*1024)fail(413,'FILE_TOO_LARGE','File lớn hơn 256 KB. Mở bằng trình soạn thảo để đọc đầy đủ.');
    const fd=await fs.open(current,constants.O_RDONLY|constants.O_NOFOLLOW);
    try{const opened=await fd.stat();if(opened.ino!==stat.ino||opened.dev!==stat.dev)fail(409,'FILE_CHANGED','File vừa thay đổi. Chọn lại file.');const bytes=await fd.readFile();if(await fs.realpath(current)!==current||await fs.realpath(root)!==root)fail(403,'SYMLINK_DENIED','Đường dẫn file đã thay đổi.');if(bytes.length>256*1024||bytes.includes(0))fail(415,'NOT_TEXT','Chưa hỗ trợ xem file này.');const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);return{path:relative,text,bytes:bytes.length};}finally{await fd.close();}
  }
  const handle=async(req,url,send,res)=>{
    if(!url.pathname.startsWith('/api/workspace'))return false;
    try{
      if(req.method==='GET'&&url.pathname==='/api/workspace'){
        const [data,listing,agents]=await Promise.all([state(),files(),orca.list()]);
        agents.items=agents.items.map(a=>({...a,...(data.agentNames?.[nameKey(a)]?{title:data.agentNames[nameKey(a)].title}:{})}));agents.renameAvailable=typeof orca.rename==='function';
        send(200,{id:'project',name:path.basename(root),path:root,intent,tasks:data.tasks,files:listing,agents,chat:{available:!!chat,engine:'codex-local',via:'orca'},dataset:fixture?'fixture':'local'});return true;
      }
      if(req.method==='GET'&&url.pathname==='/api/workspace/chat'){
        readIntent(req);if(!chat)fail(503,'CHAT_UNAVAILABLE','Cầu nối hội thoại chưa sẵn sàng.');
        const binding=Object.fromEntries(['agentId','incarnationId','worktreeId'].map(k=>[k,url.searchParams.get(k)]));
        if(!Object.values(binding).every(v=>typeof v==='string'&&v.length>0&&v.length<1000))fail(400,'INVALID_AGENT','Chọn lại agent nhận việc.');
        try{const session=await chat.open(binding);if(url.searchParams.get('sessionId')&&url.searchParams.get('sessionId')!==session.source.sessionId)throw Error('AGENT_CHANGED');send(200,await chatSnapshot(session));}catch(e){chatFailure(e);}return true;
      }
      if(req.method==='GET'&&url.pathname==='/api/workspace/chat/events'){
        readIntent(req);if(!chat||!chat.subscribe(url.searchParams.get('id'),Math.max(0,Number(url.searchParams.get('after'))||0),req,res))fail(404,'CHAT_EXPIRED','Kết nối hội thoại đã hết hạn. Chọn lại agent.');return true;
      }
      if(req.method==='POST'&&url.pathname==='/api/workspace/agents/name'){
        const data=await input(req);
        if(!data||typeof data.title!=='string'||!data.title.trim()||data.title.trim().length>80||/[\x00-\x1f\x7f]/.test(data.title))fail(400,'INVALID_NAME','Tên phiên cần từ 1 đến 80 ký tự trên một dòng.');
        if(typeof orca.rename!=='function')fail(503,'RENAME_UNAVAILABLE','Chưa đổi được tên tab Orca.');
        if(![data.agentId,data.incarnationId,data.worktreeId].every(v=>typeof v==='string'&&v.length>0&&v.length<1000))fail(400,'INVALID_AGENT','Chọn lại phiên cần đổi tên.');
        const title=data.title.trim();try{await orca.rename({...data,title});}catch(e){if(e.message==='AGENT_CHANGED')chatFailure(e);fail(502,'RENAME_UNCONFIRMED','Chưa xác nhận được tên mới trong Orca. Kiểm tra tab rồi thử lại.');}
        await mutate(s=>{s.agentNames||={};s.agentNames[nameKey(data)]={title};});send(200,{renamed:true,title});return true;
      }
      if(req.method==='GET'&&url.pathname==='/api/workspace/chat/settings'){
        readIntent(req);if(!chat)fail(503,'CHAT_UNAVAILABLE','Mở hội thoại trước khi chọn cấu hình.');
        const binding=Object.fromEntries(['agentId','incarnationId','worktreeId'].map(k=>[k,url.searchParams.get(k)]));
        try{const session=await chat.verify(url.searchParams.get('id'),binding);send(200,await settingsSnapshot(session));}catch(e){chatFailure(e);}return true;
      }
      if(req.method==='POST'&&url.pathname==='/api/workspace/chat/settings/acknowledge'){
        const data=await input(req);if(!chat||typeof data.requestId!=='string')fail(400,'INVALID_CONTROL','Yêu cầu cấu hình chưa hợp lệ.');
        let session;try{session=await chat.verify(data.chatId,data);}catch(e){chatFailure(e);}
        await mutate(s=>{const r=s.controlRequests?.[data.requestId];if(r&&r.sessionId===session.source.sessionId&&unresolved(r))r.state='acknowledged_by_user';});send(200,{acknowledged:true});return true;
      }
      if(req.method==='POST'&&url.pathname==='/api/workspace/chat/settings'){
        const data=await input(req);if(!chat||data.confirm!==true||!/^[-a-zA-Z0-9_]{8,100}$/.test(data.requestId||''))fail(400,'INVALID_CONTROL','Chọn cấu hình từ cửa sổ chat.');
        let session;try{session=await chat.verify(data.chatId,data);const fresh=await orca.prepareConversation(data);if(fresh.sessionId!==session.source.sessionId)throw Error('AGENT_CHANGED');await session.refresh();}catch(e){chatFailure(e);}
        if(session.status.state==='running')fail(409,'CHAT_BUSY','Chờ lượt hiện tại kết thúc trước khi đổi cấu hình.');
        const settings=await settingsSnapshot(session);let message;
        try{message=controlCommand(data,settings,settings.runtime.model||session.status.model);}catch(e){fail(400,e.message,'Lựa chọn này chưa khả dụng trong phiên Codex.');}
        const digest=createHash('sha256').update(JSON.stringify([session.source.sessionId,data.action,data.value])).digest('hex');
        const reservation=await mutate(s=>{
          s.controlRequests||={};const old=s.controlRequests[data.requestId];if(old){if(old.digest!==digest)fail(409,'REQUEST_CHANGED','Cấu hình yêu cầu đã thay đổi.');return{existing:true,record:old};}
          if(Object.keys(s.controlRequests).length>=1000)fail(409,'SESSION_LIMIT','Đã đạt giới hạn yêu cầu cấu hình.');
          if(Object.values(s.chatRequests||{}).some(r=>r.sessionId===session.source.sessionId&&pending(r))||Object.values(s.controlRequests).some(r=>r.sessionId===session.source.sessionId&&unresolved(r)))fail(409,'CONTROL_PENDING','Đối chiếu yêu cầu trước trong Orca trước khi đổi tiếp.');
          const record={id:data.requestId,sessionId:session.source.sessionId,action:data.action,value:data.value,digest,state:'sending'};s.controlRequests[data.requestId]=record;return{existing:false,record};
        });
        if(reservation.existing){send(200,{accepted:reservation.record.state!=='unconfirmed',applied:reservation.record.state==='confirmed',replayed:true,settings:await settingsSnapshot(session)});return true;}
        try{const receipt=await orca.send({...data,message});if(receipt.accepted!==true)throw Error('SEND_UNCONFIRMED');await mutate(s=>{s.controlRequests[data.requestId].state='accepted';});send(200,{accepted:true,applied:false,settings:await settingsSnapshot(session)});}
        catch{await mutate(s=>{s.controlRequests[data.requestId].state='unconfirmed';});fail(502,'CONTROL_UNCONFIRMED','Chưa xác nhận được yêu cầu cấu hình. Kiểm tra Orca, không tự gửi lại.');}return true;
      }
      if(req.method==='POST'&&url.pathname==='/api/workspace/chat/acknowledge'){
        const data=await input(req);if(typeof data.requestId!=='string')fail(400,'INVALID_REQUEST','Yêu cầu chưa hợp lệ.');
        await mutate(s=>{const r=s.chatRequests?.[data.requestId];if(r&&pending(r))r.state='acknowledged_by_user';});send(200,{acknowledged:true});return true;
      }
      if(req.method==='GET'&&url.pathname==='/api/workspace/file'){send(200,await file(url.searchParams.get('path')));return true;}
      if(req.method==='DELETE'&&url.pathname==='/api/workspace/tasks'){
        const data=await input(req);
        if(!data||typeof data.id!=='string'||!/^[-a-zA-Z0-9_]{1,100}$/.test(data.id))fail(400,'INVALID_TASK','Chọn công việc cần xóa.');
        // Idempotent after a lost response; only the selected checklist entry changes.
        send(200,await mutate(s=>{s.tasks=s.tasks.filter(task=>task.id!==data.id);return{id:data.id,deleted:true};}));return true;
      }
      if(req.method==='POST'&&url.pathname==='/api/workspace/tasks'){
        const data=await input(req);
        if(typeof data.title==='string'){
          const title=data.title.trim();if(!title||title.length>500)fail(400,'INVALID_TASK','Nhập công việc từ 1 đến 500 ký tự.');
          send(201,await mutate(s=>{if(s.tasks.length>=1000)fail(409,'TASK_LIMIT','Checklist đã có 1.000 công việc.');const task={id:randomUUID(),title,done:false,createdAt:new Date().toISOString()};s.tasks.push(task);return task;}));return true;
        }
        if(typeof data.id!=='string'||typeof data.done!=='boolean')fail(400,'INVALID_TASK','Công việc chưa hợp lệ.');
        send(200,await mutate(s=>{const task=s.tasks.find(t=>t.id===data.id);if(!task)fail(404,'TASK_MISSING','Không tìm thấy công việc.');task.done=data.done;return task;}));return true;
      }
      if(req.method==='POST'&&url.pathname==='/api/workspace/commands'){
        const data=await input(req);
        if(data.confirm!==true||typeof data.message!=='string'||!data.message.trim()||data.message.length>8000||/\x00/.test(data.message))fail(400,'INVALID_COMMAND','Chọn agent và nhập chỉ thị trước khi gửi.');
        if(![data.agentId,data.incarnationId,data.worktreeId].every(x=>typeof x==='string'&&x.length<1000))fail(400,'INVALID_AGENT','Chọn lại agent nhận việc.');
        if(typeof data.requestId!=='string'||!/^[-a-zA-Z0-9_]{8,100}$/.test(data.requestId))fail(400,'REQUEST_ID_REQUIRED','Yêu cầu cần mã xác nhận.');
        const digest=createHash('sha256').update(JSON.stringify([data.agentId,data.incarnationId,data.worktreeId,data.message])).digest('hex');
        let pending=commands.get(data.requestId);
        if(pending&&pending.digest!==digest)fail(409,'REQUEST_CHANGED','Nội dung yêu cầu đã thay đổi.');
        if(!pending){
          if(commands.size>=1000)fail(409,'SESSION_LIMIT','Mở lại app trước khi tiếp tục gửi chỉ thị.');
          const work=(async()=>{
            let session;
            if(chat){
              if(typeof data.chatId!=='string')fail(409,'CHAT_REQUIRED','Mở lại hội thoại trước khi gửi tin nhắn.');
              try{session=await chat.verify(data.chatId,data);await session.refresh();await syncChat(session.snapshot());}catch(e){chatFailure(e);}
              const reservation=await mutate(s=>{
                if(Object.values(s.controlRequests||{}).some(r=>r.sessionId===session.source.sessionId&&unresolved(r)&&(r.action==='permission'||['sending','unconfirmed'].includes(r.state))))fail(409,'CONTROL_PENDING','Cấu hình đang chờ xác nhận. Kiểm tra Orca trước khi gửi tin nhắn.');
                s.chatRequests||={};const old=s.chatRequests[data.requestId];if(old){if(old.digest!==digest||old.sessionId!==session.source.sessionId)fail(409,'REQUEST_CHANGED','Nội dung yêu cầu đã thay đổi.');return{existing:true,record:old};}
                if(Object.values(s.chatRequests).some(r=>r.sessionId===session.source.sessionId&&['sending','accepted','running','unconfirmed'].includes(r.state)))fail(409,'CHAT_PENDING','Tin nhắn trước vẫn đang chờ phản hồi. Kiểm tra hội thoại trước khi gửi tiếp.');
                const record={id:data.requestId,digest,messageHash:messageHash(data.message),sessionId:session.source.sessionId,createdAt:new Date().toISOString(),state:'sending'};s.chatRequests[data.requestId]=record;return{existing:false,record};
              });
              if(reservation.existing)return{accepted:reservation.record.state!=='sending'&&reservation.record.state!=='unconfirmed',completed:reservation.record.state==='completed',id:data.requestId,chatId:session.id,sessionId:session.source.sessionId,message:'Đang đối chiếu tin nhắn đã gửi; không gửi lại.'};
            }
            try{const receipt=await orca.send(data);if(receipt.accepted!==true)throw Error('SEND_UNCONFIRMED');
              if(session)await mutate(s=>{const r=s.chatRequests[data.requestId];if(r.state==='sending'||r.state==='unconfirmed')r.state='accepted';r.nativeReceiptId=receipt.requestId||null;});
              return{accepted:true,completed:false,requestId:receipt.requestId||null,id:data.requestId,...(session?{chatId:session.id,sessionId:session.source.sessionId}:{}),message:session?'Tin nhắn đã chuyển tới Codex local.':'Orca đã nhận input. Chưa có xác nhận hoàn thành từ agent.'};
            }catch(e){if(session)await mutate(s=>{const r=s.chatRequests[data.requestId];if(r.state==='sending')r.state='unconfirmed';});if(e.message==='AGENT_CHANGED')fail(409,'AGENT_CHANGED','Phiên agent đã thay đổi. Tải lại danh sách rồi chọn lại agent.');fail(502,'SEND_UNCONFIRMED','Chưa xác nhận được việc gửi. Kiểm tra hội thoại Codex hoặc Orca trước khi thử lại.');}
          })();
          pending={digest,work};commands.set(data.requestId,pending);
        }
        send(200,await pending.work);return true;
      }
      send(405,{error:{code:'METHOD_DENIED',message:'Thao tác chưa được hỗ trợ.'}});return true;
    }catch(e){send(e.status||503,{error:{code:e.code||'WORKSPACE_UNAVAILABLE',message:e instanceof WorkspaceError?e.message:'Chưa đọc được workspace. Kiểm tra thư mục rồi thử lại.'}});return true;}
  };
  handle.close=()=>chat?.close();return handle;
}
