// Fixed-route Helpdesk reader for Han auto. No controller, AI, arbitrary URL fetch or writes.
import { createHash, randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import { autoReviewBinding } from '../skills/check-ticket/scripts/han-reports.mjs';
export const digest = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
export const fail = (status, message) => Object.assign(new Error(message), { status });
export function redact(value) {
  const original = String(value ?? '');
  const text = original
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [đã ẩn]')
    .replace(/\b(?:sk|rk|pk|dk)[_-](?:live[_-]|test[_-]|proj-)?[A-Za-z0-9_-]{16,}\b/g, '[đã ẩn khóa]')
    .replace(/((?:password|passwd|mật khẩu|api[_ -]?key|access[_ -]?token|refresh[_ -]?token|authorization|secret|API_AVADA_TICKET|DEV_ZONE|BEARER_Auth|TS_ELITE_EXT_TOKEN)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s<>]+)/gi, '$1[đã ẩn]')
    .replace(/([?&](?:token|key|auth|password|secret|signature|access_token)=)[^&\s"'<>]+/gi, '$1[đã ẩn]');
  return { text, redacted: text !== original };
}
export function safeUrl(value) {
  try { const u = new URL(String(value));
    if (u.protocol !== 'https:' || u.username || u.password || /\[đã ẩn/.test(value)
      || /(?:token|password|secret|signature|authorization|api.?key|key)=/i.test(u.hash)
      || [...u.searchParams.keys()].some(k => /token|password|secret|signature|authorization|api.?key|^key$/i.test(k))) return null;
    return u.href;
  } catch { return null; }
}
const text = value => redact(value).text;
export function safeComment(action, ticketId) {
  if (!action?.id || typeof action.id !== 'string' || action.ticketId && action.ticketId !== ticketId) throw fail(502, 'Comment thiếu ID hoặc sai ticket.');
  const content = redact(action.metadata?.content ?? action.content ?? '');
  const attachments = Array.isArray(action.metadata?.attachments) ? action.metadata.attachments : [];
  return { id: action.id, ticketId, type: 'commentTicket', createdAt: Number.isFinite(Date.parse(action.createdAt)) ? new Date(action.createdAt).toISOString() : null,
    author: { name: text(action.author?.displayName || 'Không rõ tác giả'), photoURL: safeUrl(action.author?.photoURL) },
    content: content.text, redacted: content.redacted, contentSha256: digest(String(action.metadata?.content ?? action.content ?? '')),
    attachments: attachments.map(a => ({ name: text(a.name || a.filename || 'Tệp đính kèm'), url: safeUrl(a.url || a.href) })),
    hash: digest([action.id, action.createdAt, content.text]) };
}
export function createAutoTicketReader({ root, get, now = () => Date.now(), secret = randomBytes(32), pageSize = 100, maxSnapshots = 100, ttlMs = 15*60*1000 } = {}) {
  const snapshots = new Map();
  const key = b => digest([b.ticketId,b.jobId,b.runId]);
  const sign = body => createHmac('sha256', secret).update(body).digest('base64url');
  const encode = data => { const body = Buffer.from(JSON.stringify(data)).toString('base64url'); return body+'.'+sign(body); };
  function decode(token, binding) {
    if (typeof token !== 'string' || token.length > 8000) throw fail(400, 'Cursor không hợp lệ.');
    const [body, mac, extra] = token.split('.');
    const expected = sign(body || '');
    if (extra || !mac || mac.length !== expected.length || !timingSafeEqual(Buffer.from(mac),Buffer.from(expected))) throw fail(400, 'Cursor không hợp lệ.');
    let data; try { data = JSON.parse(Buffer.from(body,'base64url').toString()); } catch { throw fail(400,'Cursor không hợp lệ.'); }
    if (data.binding !== key(binding)) throw fail(409,'Cursor không thuộc ticket/lượt này.');
    return data;
  }
  async function read(binding, path, signal) {
    const combined = signal ? AbortSignal.any([signal,AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000);
    try { combined.throwIfAborted(); return await get(path, { signal: combined }); }
    catch (error) { const code = /HTTP\s*(\d{3})/.exec(error.message || '')?.[1]; throw fail(code === '403' ? 403 : code === '429' ? 429 : 502, code ? `Helpdesk HTTP ${code}; chưa đọc được dữ liệu.` : 'Chưa đọc được Helpdesk; tải lại khi sẵn sàng.'); }
  }
  async function detail(input, signal) {
    const { job,binding,review } = await autoReviewBinding(root,input);
    const data = await read(binding,`/tickets/${encodeURIComponent(binding.ticketId)}`,signal); const t=data.ticket||data;
    if (t?.id !== binding.ticketId) throw fail(502,'Thông tin ticket không khớp.');
    return { binding, fetchedAt:new Date(now()).toISOString(), historicalRun:{status:job.status,statusLabel:review.statusLabel,trigger:job.trigger,finishedAt:job.finishedAt||null,canonical:review.canonical,delivery:review.delivery},
      ticket:{ id:t.id,reference:text(t.ticketId),title:text(t.subject),description:text(t.description),app:text(t.appName),shops:(Array.isArray(t.storeDomains)?t.storeDomains:[]).map(text),status:text(t.ticketStatus),tsStatus:text(t.tsStatus),done:t.dueDateDone===true,
        url:`https://helpdesk.avada.net/t/${encodeURIComponent(t.ticketId||t.id)}` } };
  }
  async function comments(input, token = '', signal) {
    const {binding}=await autoReviewBinding(root,input); const k=key(binding); let snapshot, cursor='';
    if(token){const decoded=decode(token,binding);snapshot=snapshots.get(decoded.snapshot);cursor=decoded.cursor;
      if(!snapshot || snapshot.bindingKey!==k || now()-snapshot.at>ttlMs)throw fail(409,'Phiên tải comment đã hết hạn. Tải lại ticket.');
      if(snapshot.pages.has(cursor))return snapshot.pages.get(cursor);
      if(snapshot.next!==cursor)throw fail(409,'Cursor không còn mới. Tải lại comment.');
    } else {
      for(const [id,s]of snapshots)if(now()-s.at>ttlMs)snapshots.delete(id);
      if(snapshots.size>=maxSnapshots) snapshots.delete(snapshots.keys().next().value);
      const id=randomBytes(16).toString('hex');snapshot={id,bindingKey:k,at:now(),seen:new Map(),raw:new Set(),visited:new Set(),pages:new Map(),next:'',comments:new Map(),complete:false};snapshots.set(id,snapshot);
    }
    if(snapshot.loading)throw fail(409,'Trang comment đang được tải; hãy đọc lại trạng thái.');
    if(snapshot.pages.size>=50)throw fail(413,'Đã tới giới hạn đọc 50 trang; comment chưa được xác nhận đầy đủ.');
    snapshot.loading=true;
    try {
    const params=new URLSearchParams({type:'commentTicket',limit:String(pageSize),...(cursor?{cursor}:{})});
    const data=await read(binding,`/tickets/${encodeURIComponent(binding.ticketId)}/actions?${params}`,signal);
    if(!Array.isArray(data?.actions))throw fail(502,'Helpdesk thiếu danh sách action.');
    const pageBytes=Buffer.byteLength(JSON.stringify(data));
    if((snapshot.bytes||0)+pageBytes>32*1024*1024)throw fail(413,'Tổng comment đã vượt giới hạn bản đọc; không cắt hoặc giả đầy đủ.');
    snapshot.bytes=(snapshot.bytes||0)+pageBytes;
    // UI stores full bodies; an oversized page fails explicitly, never silently clips a code block.
    if(Buffer.byteLength(JSON.stringify(data))>8*1024*1024)throw fail(413,'Trang comment quá lớn để tải an toàn; chưa được coi là đầy đủ.');
    const comments=[];let error=null;const before=snapshot.raw.size;
    for(const a of data.actions){
      if(typeof a?.id!=='string'||a.ticketId&&a.ticketId!==binding.ticketId){error='invalid_action_binding';break;}
      const hash=digest(a);
      if(snapshot.seen.has(a.id)&&snapshot.seen.get(a.id)!==hash){error='changed_during_read';break;}
      const fresh=!snapshot.raw.has(a.id);snapshot.raw.add(a.id);snapshot.seen.set(a.id,hash);
      if(!a.type||a.type==='commentTicket'){const c=safeComment(a,binding.ticketId);snapshot.comments.set(c.id,c);if(fresh)comments.push(c);}
    }
    const next=typeof data.nextCursor==='string'?data.nextCursor:'';
    const totalActions=Number.isSafeInteger(data.total)&&data.total>=0?data.total:null;
    // Upstream total may count all actions: never call it totalComments.
    if(totalActions!==null&&totalActions<snapshot.raw.size)error ||= 'inconsistent_total';
    if(snapshot.totalActions!==undefined&&totalActions!==null&&snapshot.totalActions!==null&&snapshot.totalActions!==totalActions)error ||= 'changed_during_read';
    snapshot.totalActions=totalActions;
    let complete=false;
    if(!error&&next&&(next===cursor||snapshot.visited.has(next)))error='repeated_cursor';
    if(!error&&cursor&&snapshot.raw.size===before)error='no_progress';
    if(!error&&!next){
      if(data.hasMore===true)error='missing_cursor';
      else if(data.hasMore===false)complete=true;
      else if(data.actions.length<pageSize&&(totalActions===null||snapshot.raw.size>=totalActions))complete=true;
      else if(totalActions!==null&&snapshot.raw.size===totalActions)complete=true;
      else error='end_not_proven';
    }
    snapshot.error=error;
    if(error){snapshot.complete=false;snapshot.next=null;}
    else{snapshot.complete=complete;snapshot.next=next||null;}
    snapshot.visited.add(cursor);
    const result={binding,snapshotId:snapshot.id,fetchedAt:new Date(now()).toISOString(),comments:comments.sort((a,b)=>String(a.createdAt).localeCompare(String(b.createdAt))||a.id.localeCompare(b.id)),loadedComments:snapshot.comments.size,scannedActions:snapshot.raw.size,totalActions,totalComments:complete?snapshot.comments.size:null,complete,error,
      nextCursor:!error&&next?encode({binding:k,snapshot:snapshot.id,cursor:next}):null};
    snapshot.pages.set(cursor,result);return result;
    } finally { snapshot.loading=false; }
  }
  function evidence(binding,id){const s=snapshots.get(id);if(!s||s.bindingKey!==key(binding)||now()-s.at>ttlMs)throw fail(409,'Dữ liệu comment đã hết hạn; tải lại trước khi hỏi.');if(s.error)throw fail(409,'Comment đổi hoặc phân trang chưa xác minh; tải lại ticket trước khi hỏi.');return{comments:[...s.comments.values()].sort((a,b)=>String(a.createdAt).localeCompare(String(b.createdAt))||a.id.localeCompare(b.id)),complete:s.complete,fetchedAt:new Date(s.at).toISOString(),snapshotId:id};}
  return{detail,comments,evidence};
}
