import {useEffect,useRef,useState,type FormEvent,type RefObject} from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import CodexControls from './CodexControls';
import {Check,LoaderCircle,MessageSquare,Send,Unplug,RefreshCw} from 'lucide-react';

type Agent={id:string;title:string;engine:string;incarnationId:string;worktreeId:string;writable:boolean;nativeSessionId?:string;selectionKey?:string};
type Message={id:string;role:'user'|'assistant';text:string;phase:string;turnId:string|null;timestamp:string};
type Status={state:string;activity:string;turnId:string|null;startedAt:string|null;model?:string;finishedAt?:string;serviceTier?:string|null;permission?:string|null};
type Pending={id:string;state:string;createdAt:string;turnId:string|null};
type Usage={used:number;total:number;observedAt:string;model:string|null};
type Conversation={usage:Usage|null;id:string;sessionId:string;sequence:number;messages:Message[];status:Status;historyTruncated:boolean;pending:Pending[]};
type Outbox={id:string;text:string;at:string;state:'sending'|'queued'|'unconfirmed'|'rejected';notice?:string};
type Props={agent:Agent|null;agents:Agent[];agentIsCurrent:boolean;intent:string;draft:string;setDraft:(s:string)=>void;chooseAgent:(id:string)=>void;draftField:RefObject<HTMLTextAreaElement|null>;refreshWorkspace:()=>void;bindSession:(id:string)=>void};
class ChatError extends Error{code:string;constructor(message:string,code:string){super(message);this.code=code;}}
async function json<T>(url:string,options:RequestInit={}):Promise<T>{const r=await fetch(url,options);const data=await r.json();if(!r.ok)throw new ChatError(data.error?.message||'Chưa nối được hội thoại.',data.error?.code||'CHAT_FAILED');return data;}
const normalized=(s:string)=>s.replace(/\r\n/g,'\n').trim();
function activity(status:Status){if(status.state==='disconnected')return 'Mất kết nối với phiên Codex';if(status.state==='interrupted')return 'Lượt trả lời đã dừng';if(status.state==='error')return 'Codex báo lỗi trong lượt này';if(status.state!=='running')return 'Codex đã kết thúc lượt trả lời';if(status.activity==='working')return 'Đang thực hiện tác vụ…';if(status.activity==='waiting_input')return 'Đang chờ thao tác trong Orca';if(status.activity==='responding')return 'Đang trả lời…';return 'Đang suy nghĩ…';}

export default function NativeCodexChat({agent,agents,agentIsCurrent,intent,draft,setDraft,chooseAgent,draftField,refreshWorkspace,bindSession}:Props){
 const [chat,setChat]=useState<Conversation|null>(null),[loading,setLoading]=useState(false),[connected,setConnected]=useState(false),[error,setError]=useState(''),[revision,setRevision]=useState(0),[sending,setSending]=useState(false),[outbox,setOutbox]=useState<Outbox[]>([]),[clock,setClock]=useState(Date.now()),[controlsBlocked,setControlsBlocked]=useState(false);
 const chatRef=useRef<Conversation|null>(null),sendLock=useRef(false),expectedSession=useRef<string|null>(null),selected=useRef<string|null>(null),end=useRef<HTMLDivElement>(null),connection=useRef<AbortController|null>(null);
 const identity=agent?[agent.id,agent.incarnationId,agent.worktreeId,agent.selectionKey||''].join(':'):null;
 const headers={'X-Andrew-Intent':intent};
 const binding=agent?{agentId:agent.id,incarnationId:agent.incarnationId,worktreeId:agent.worktreeId}:null;
 function applySnapshot(next:Conversation){const current=chatRef.current;const value=current&&current.id===next.id&&current.sessionId===next.sessionId&&current.sequence>next.sequence?{...current,pending:next.pending}:next;chatRef.current=value;setChat(value);}
 async function refresh(signal?:AbortSignal){if(!binding)return null;const params=new URLSearchParams(binding);if(expectedSession.current)params.set('sessionId',expectedSession.current);const next=await json<Conversation>('/api/workspace/chat?'+params,{headers,signal});if(expectedSession.current&&expectedSession.current!==next.sessionId)throw new ChatError('Phiên Codex đã thay đổi. Chọn lại agent để tiếp tục.','AGENT_CHANGED');expectedSession.current=next.sessionId;bindSession(next.sessionId);applySnapshot(next);return next;}
 useEffect(()=>{
  if(selected.current!==identity){selected.current=identity;expectedSession.current=agent?.nativeSessionId||null;chatRef.current=null;setChat(null);setOutbox([]);}
  if(!agent||!agentIsCurrent)return;const abort=new AbortController();connection.current=abort;let active=true;setLoading(true);setConnected(false);setError('');
  async function connect(){
   try{
    const snapshot=await refresh(abort.signal);if(!snapshot||!active)return;setLoading(false);
    const response=await fetch('/api/workspace/chat/events?'+new URLSearchParams({id:snapshot.id,after:String(snapshot.sequence)}),{headers,signal:abort.signal});if(!response.ok||!response.body)throw new ChatError('Luồng hội thoại đã ngắt. Kết nối lại để nhận phần trả lời còn thiếu.','STREAM_CLOSED');
    setConnected(true);const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='';
    while(active){const value=await reader.read();if(value.done)throw new ChatError('Kết nối hội thoại đã ngắt. Không gửi lại tin nhắn; bấm Kết nối lại.','STREAM_CLOSED');buffer+=decoder.decode(value.value,{stream:true});if(buffer.length>4*1024*1024)throw new ChatError('Phản hồi quá lớn để hiển thị trong app. Xem trong Orca.','MESSAGE_TOO_LARGE');
     for(;;){const newline=buffer.indexOf('\n');if(newline<0)break;const line=buffer.slice(0,newline);buffer=buffer.slice(newline+1);if(!line)continue;const event=JSON.parse(line);if(!active)break;
      if(event.type==='snapshot'){if(event.sessionId!==expectedSession.current)throw new ChatError('Phiên Codex đã thay đổi. Chọn lại agent.','AGENT_CHANGED');applySnapshot(event);continue;}
      const current=chatRef.current;if(!current||event.type==='heartbeat'||event.sequence<=current.sequence)continue;
      let next={...current,sequence:event.sequence};
      if(event.type==='message'&&event.message?.id?.startsWith(current.sessionId+':'))next={...next,messages:[...current.messages.filter(m=>m.id!==event.message.id),event.message].slice(-60)};
      if(event.type==='status')next={...next,status:event.status};
      if(event.type==='usage')next={...next,usage:event.usage};
      chatRef.current=next;setChat(next);
      if(event.type==='status'&&['completed','interrupted'].includes(event.status.state))void refresh(abort.signal).catch(()=>{});
      if(event.type==='status'&&event.status.state==='disconnected')throw new ChatError('Phiên Codex đã ngắt hoặc thay đổi. Chọn lại agent trong Orca.','AGENT_CHANGED');
     }
    }
   }catch(e){if(active&&(e as Error).name!=='AbortError'){abort.abort();setError(e instanceof ChatError?e.message:'Kết nối hội thoại đã ngắt. Không gửi lại tin nhắn; bấm Kết nối lại.');setConnected(false);setLoading(false);if((e as ChatError).code==='USER_ACTION_REQUIRED')refreshWorkspace();}}
  }
  void connect();return()=>{active=false;abort.abort();setConnected(false);};
 },[identity,agentIsCurrent,intent,revision]);
 useEffect(()=>{end.current?.scrollIntoView({block:'nearest'});},[chat?.messages.length,outbox.length]);
 useEffect(()=>{if(!connected||chat?.status.state!=='running')return;setClock(Date.now());const timer=setInterval(()=>setClock(Date.now()),1000);return()=>clearInterval(timer);},[connected,chat?.status.state,chat?.status.startedAt]);
 const native=chat?.messages||[];
 const observed=(item:Outbox)=>native.some(m=>m.role==='user'&&normalized(m.text)===normalized(item.text)&&Date.parse(m.timestamp)>=Date.parse(item.at)-500);
 const unconfirmed=outbox.filter(o=>o.state==='unconfirmed'&&!observed(o));
 const pending=(chat?.pending||[]).filter(p=>!native.some(m=>m.role==='user'&&m.turnId===p.turnId&&p.turnId&&native.some(a=>a.role==='assistant'&&a.phase==='final'&&a.turnId===p.turnId)&&chat?.status.state==='completed'));
 const waiting=outbox.some(o=>['sending','queued'].includes(o.state)&&!observed(o))||pending.length>0;
 const running=chat?.status.state==='running';
 const canSend=agentIsCurrent&&!!agent&&agent.engine==='codex'&&!!chat&&connected&&!controlsBlocked&&!sending&&!waiting&&!running&&!unconfirmed.length&&!!draft.trim();
 async function submit(e?:FormEvent){
  e?.preventDefault();if(!canSend||sendLock.current||!agent||!chat)return;sendLock.current=true;setSending(true);setError('');const id=crypto.randomUUID(),text=draft.trim(),at=new Date().toISOString();setOutbox(old=>[...old,{id,text,at,state:'sending'}]);
  try{const receipt=await json<{accepted:boolean;completed:boolean;message:string}>('/api/workspace/commands',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({...binding,chatId:chat.id,requestId:id,message:text,confirm:true})});setOutbox(old=>old.map(m=>m.id===id?{...m,state:receipt.accepted?'queued':'unconfirmed',notice:receipt.message}:m));if(receipt.accepted)setDraft('');await refresh();}
  catch(e){const failure=e as ChatError;setOutbox(old=>old.map(m=>m.id===id?{...m,state:failure.code==='SEND_UNCONFIRMED'||!(failure instanceof ChatError)?'unconfirmed':'rejected',notice:failure.message}:m));setError(failure.message);void refresh().catch(()=>{});}
  finally{setSending(false);sendLock.current=false;}
 }
 async function acknowledge(id:string){try{await json('/api/workspace/chat/acknowledge',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({requestId:id})});setOutbox(old=>old.map(m=>m.id===id?{...m,state:'rejected',notice:'Đã đối chiếu trong Orca.'}:m));setError('');await refresh();}catch(e){setError((e as Error).message);}}
 const elapsed=chat?.status.startedAt?Math.max(0,Math.floor((clock-Date.parse(chat.status.startedAt))/1000)):0;
 return <div className="wm-native-chat">
  <div className="wm-codex-connection"><span className={connected?'wm-connection-dot':'wm-connection-dot offline'}/><span>{loading?'Đang nối hội thoại…':connected?'Codex local qua Orca':agent?'Chưa nối hội thoại':'Chọn agent để mở hội thoại'}</span>{chat&&<small title={'Phiên '+chat.sessionId}>{chat.status.model||'Codex'} · {chat.sessionId.slice(0,8)}</small>}</div>
  <div className="wm-chat-body wm-native-messages" aria-live="polite">
   {chat?.historyTruncated&&native.length>0&&<p className="wm-chat-history-note">Hội thoại gần đây của phiên đã chọn.</p>}
   {native.map(message=><article className={'wm-native-message '+message.role+(message.phase==='commentary'?' commentary':'')} key={message.id}><div className="wm-message-meta"><strong>{message.role==='user'?'Bạn':agent?.title.replace(/ \| Andrew TS Tools$/,'')||'Codex'}</strong>{message.phase==='commentary'&&<span>Cập nhật tiến độ</span>}</div>{message.role==='assistant'?<div className="markdown wm-native-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={{a:({href,children})=>href&&/^https?:\/\//i.test(href)?<a href={href} target="_blank" rel="noopener noreferrer">{children}</a>:<span>{children}</span>,img:()=> <span>Ảnh từ xa không tự tải.</span>,pre:({children})=><pre tabIndex={0}>{children}</pre>}}>{message.text}</ReactMarkdown></div>:<p className="wm-message-text">{message.text}</p>}</article>)}
   {outbox.filter(m=>!observed(m)).map(m=><article className="wm-native-message user" key={m.id}><div className="wm-message-meta"><strong>Bạn</strong></div><p className="wm-message-text">{m.text}</p><div className={'wm-receipt '+m.state}>{m.state==='sending'?<LoaderCircle size={14} className="spinning"/>:m.state==='queued'?<Check size={14}/>:<Unplug size={14}/>}<span>{m.state==='sending'?'Đang chuyển tin nhắn…':m.state==='queued'?'Đang chờ Codex nhận lượt…':m.notice}</span></div></article>)}
   {loading&&<div className="wm-native-loading"><LoaderCircle size={20} className="spinning"/>Đang đọc hội thoại của phiên đã chọn…</div>}
   {!agent&&!loading&&<div className="wm-empty-chat"><MessageSquare size={30}/><h3>Trò chuyện cùng Codex local.</h3><p>Chọn đúng phiên agent đang mở trên Orca. Câu trả lời và cập nhật xử lý sẽ xuất hiện ngay tại đây.</p></div>}
   {agent&&!loading&&!native.length&&!outbox.length&&!error&&<div className="wm-empty-chat"><MessageSquare size={28}/><h3>Hội thoại đã sẵn sàng.</h3><p>Gửi câu hỏi hoặc một việc cần làm để bắt đầu.</p></div>}
   {connected&&(running||waiting)&&<div className="wm-thinking" role="status"><LoaderCircle size={17} className="spinning"/><div><strong>{running&&chat?activity(chat.status):'Đang chờ Codex nhận tin nhắn…'}</strong><span>Trạng thái từ phiên Codex local đã chọn.</span></div>{running&&<time aria-hidden="true">{elapsed<60?elapsed+'s':Math.floor(elapsed/60)+'m '+elapsed%60+'s'}</time>}</div>}
   {!connected&&!loading&&(running||waiting)&&<div className="wm-send-warning" role="status">Chưa xác định được hoạt động hiện tại. Kết nối lại để theo dõi tiếp cùng phiên; tin nhắn không được gửi lại.</div>}
   {chat&&!running&&!waiting&&chat.status.state==='completed'&&<div className="wm-turn-complete"><Check size={14}/>Codex đã kết thúc lượt trả lời.</div>}
   {chat?.status.state==='error'&&!error&&<div className="wm-error" role="alert">{chat.status.activity==='reply_missing'?'Lượt đã kết thúc nhưng chưa có câu trả lời hiển thị. Kiểm tra phiên trong Orca hoặc gửi câu hỏi tiếp theo.':'Codex báo lỗi trong lượt này. Kiểm tra phiên trong Orca trước khi thử tiếp.'}</div>}
   {chat?.status.state==='interrupted'&&!error&&<div className="wm-send-warning" role="status">Lượt trả lời đã dừng trong Orca.</div>}
   {error&&<div className="wm-error" role="alert">{error}<button type="button" onClick={()=>setRevision(v=>v+1)}><RefreshCw size={13}/> Kết nối lại</button></div>}
   <div ref={end}/>
  </div>
  <div className="wm-context-meter" aria-label="Context của phiên" title={chat?.usage?'Số token Codex báo lúc '+new Date(chat.usage.observedAt).toLocaleTimeString('vi-VN'):'Chờ mẫu token_count từ Codex.'}><span>Context</span>{chat?.usage?<><strong>{chat.usage.used.toLocaleString('vi-VN')} / {chat.usage.total.toLocaleString('vi-VN')} <small>tokens</small></strong><progress aria-label="Context đã dùng" max={chat.usage.total} value={Math.min(chat.usage.used,chat.usage.total)}/>{!connected&&<small>Mẫu cuối</small>}</>:<small>Chưa có số liệu</small>}</div>
  <form className="wm-composer" onSubmit={submit}><label htmlFor="wm-native-agent">Agent nhận việc</label><select id="wm-native-agent" value={agentIsCurrent?agent?.id||'':''} onChange={e=>chooseAgent(e.target.value)}><option value="">Chọn phiên Codex…</option>{agents.map(a=><option key={a.id} value={a.id} disabled={!a.writable||a.engine!=='codex'}>{a.title.replace(/ \| Andrew TS Tools$/,'')}</option>)}</select>{agent&&!agentIsCurrent&&<p className="wm-error">Phiên agent đã thay đổi. Tải lại và chọn lại agent.</p>}<label className="sr-only" htmlFor="wm-native-question">Chỉ thị cho agent</label><textarea id="wm-native-question" ref={draftField} value={draft} onChange={e=>setDraft(e.target.value)} maxLength={8000} placeholder="Hỏi hoặc giao việc cho Codex local…" onKeyDown={e=>{if((e.ctrlKey||e.metaKey)&&e.key==='Enter'){e.preventDefault();void submit();}}}/><div className="wm-compose-bottom wm-native-actions"><CodexControls id={chat?.id||null} binding={binding} intent={intent} connected={connected} idle={!running&&!waiting&&!sending&&!unconfirmed.length} observedModel={chat?.status.model} observedTier={chat?.status.serviceTier} observedPermission={chat?.status.permission} onBlocked={setControlsBlocked}/><span>{draft.length}/8000 <kbd>Ctrl ↵</kbd></span><button type="submit" disabled={!canSend}>{sending?'Đang gửi…':'Gửi tin nhắn'}<Send size={15}/></button></div>{(unconfirmed.length||pending.some(p=>p.state==='unconfirmed'))?<p className="wm-send-warning">Kiểm tra hội thoại trong Orca trước khi gửi lại.<button type="button" onClick={()=>void acknowledge(unconfirmed[0]?.id||pending.find(p=>p.state==='unconfirmed')!.id)}>Đã kiểm tra trong Orca</button></p>:<p className="wm-chat-hint">Cùng phiên Codex trong Orca. Không hiển thị suy nghĩ nội bộ.</p>}</form>
 </div>;
}
