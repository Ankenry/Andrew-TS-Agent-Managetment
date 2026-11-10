import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parseDocument } from 'yaml';
export const FOLDERS = ['00-inbox','01-to-do','10-daily','20-meetings','30-projects','50-learning','60-guides','70-decisions'];
const denied = /^(?:\.|(?:private|secrets?|credentials?|auth|logs?|sessions?|memories|history|keys?|tokens?)(?:$|\.))/i;
const origins=JSON.parse(await fs.readFile(new URL('./template-origin.json',import.meta.url),'utf8')).files;
const maxBytes = 1024 * 1024;
const hash = value => createHash('sha256').update(value).digest('hex');
export const fold = value => String(value).normalize('NFD').replace(/\p{M}/gu,'').replace(/đ/g,'d').replace(/Đ/g,'D').toLowerCase();
export class ReaderError extends Error { constructor(status, code, message) { super(message); this.status=status; this.code=code; } }
function parse(raw, relative) {
 const normalized=raw.replace(/^\uFEFF/,'');
 let body=normalized, data={}, warning=null;
 const match=normalized.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
 if (match) {
  body=normalized.slice(match[0].length);
  try { const doc=parseDocument(match[1],{uniqueKeys:true}); if(doc.errors.length) throw Error(); data=doc.toJS({maxAliasCount:10}); if(!data || typeof data!=='object' || Array.isArray(data)) throw Error(); }
  catch { data={}; body=raw; warning='Frontmatter chưa hợp lệ. Nội dung gốc vẫn được giữ.'; }
 }
 if (data.private===true || ['private','secret','confidential'].includes(String(data.sensitivity).toLowerCase())) return null;
 const base=path.basename(relative,'.md');
 const title=typeof data.title==='string' ? data.title : body.match(/^#\s+(.+)$/m)?.[1] || base;
 const category=/example|sample|template|mẫu/i.test(base) || data.example===true ? 'example' : 'note';
 const tags=Array.isArray(data.tags) ? data.tags.filter(x=>typeof x==='string').slice(0,30) : [];
 return {body,title:title.slice(0,300),type:typeof data.type==='string'?data.type:'note',tags,category,warning};
}
export function createReader(root, templateOrigins=origins) {
 const absolute=path.resolve(root);
 async function rootCheck() {
  let stat;try {stat=await fs.lstat(absolute);}catch{throw new ReaderError(503,'VAULT_UNAVAILABLE','Không mở được thư mục brain. Kiểm tra đường dẫn và quyền đọc.');}
  if(!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(absolute)!==absolute) throw new ReaderError(503,'VAULT_UNAVAILABLE','Thư mục brain phải là thư mục thật, không qua symlink.');
 }
 async function safeRead(relative) {
  if(path.isAbsolute(relative) || relative.split(/[\\/]/).some(p=>p==='..'||denied.test(p)) || !FOLDERS.includes(relative.split('/')[0]) || !relative.endsWith('.md')) throw new ReaderError(404,'NOT_FOUND','Không tìm thấy ghi chú trong phạm vi được đọc.');
  let current=absolute;
  for(const segment of relative.split('/')) {current=path.join(current,segment);const s=await fs.lstat(current);if(s.isSymbolicLink()) throw new ReaderError(404,'NOT_FOUND','Không đọc đường dẫn symlink.');}
  const real=await fs.realpath(current);if(!real.startsWith(absolute+path.sep)) throw new ReaderError(404,'NOT_FOUND','Nguồn nằm ngoài brain.');
  const initial=await fs.lstat(current);if(!initial.isFile())throw new ReaderError(404,'NOT_FOUND','Không phải ghi chú.');
  if(initial.size>maxBytes)throw new ReaderError(413,'NOTE_TOO_LARGE','Ghi chú lớn hơn 1 MiB; chưa tải để tránh cắt mất nội dung.');
  const fd=await fs.open(current,constants.O_RDONLY|constants.O_NOFOLLOW);
  try {
   const stat=await fd.stat();if(stat.ino!==initial.ino || stat.dev!==initial.dev || stat.size>maxBytes)throw new ReaderError(409,'SOURCE_CHANGED','Nguồn vừa thay đổi. Tải lại danh sách.');
   const bytes=await fd.readFile();let raw;try{raw=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);}catch{throw new ReaderError(415,'INVALID_UTF8','Ghi chú không phải UTF-8 hợp lệ; chưa tải thay vì thay ký tự.');}const after=await fd.stat();
   if(after.size!==stat.size || after.mtimeMs!==stat.mtimeMs || await fs.realpath(current)!==real)throw new ReaderError(409,'SOURCE_CHANGED','Nguồn vừa thay đổi. Tải lại danh sách.');
   return {raw,stat:after};
  }finally{await fd.close();}
 }
 async function snapshot() {
  await rootCheck();const notes=[];const issues=[];
  async function walk(relative) {
   let entries;try{entries=await fs.readdir(path.join(absolute,relative),{withFileTypes:true});}catch(e){if(e.code!=='ENOENT')issues.push({code:'FOLDER_UNREADABLE'});return;}
   for(const e of entries.sort((a,b)=>a.name.localeCompare(b.name))) {
    if(denied.test(e.name)||e.isSymbolicLink())continue;
    const rel=relative+'/'+e.name;
    if(e.isDirectory()){await walk(rel);continue;}
    if(!e.isFile()||!e.name.endsWith('.md')||/^readme\.md$/i.test(e.name))continue;
    try {
     const {raw,stat}=await safeRead(rel);const parsed=parse(raw,rel);if(!parsed)continue;if(parsed.category==='note'&&templateOrigins[rel]===hash(raw))parsed.category='reference';
     notes.push({...parsed,id:hash(rel).slice(0,24),path:rel,folder:relative.split('/')[0],sourceHash:hash(raw),updatedAt:new Date(stat.mtimeMs).toISOString(),bytes:stat.size,excerpt:parsed.body.replace(/[#*`>\[\]]/g,'').replace(/\s+/g,' ').trim().slice(0,170)});
    }catch(e){issues.push({code:e.code||'NOTE_UNREADABLE'});}
   }
  }
  for(const f of FOLDERS) {
   try{const st=await fs.lstat(path.join(absolute,f));if(st.isDirectory()&&!st.isSymbolicLink())await walk(f);}catch(e){if(e.code!=='ENOENT')issues.push({code:'FOLDER_UNREADABLE'});}
  }
  notes.sort((a,b)=>Number(a.category==='example')-Number(b.category==='example') || b.updatedAt.localeCompare(a.updatedAt) || a.path.localeCompare(b.path));
  const revision=hash(notes.map(n=>n.id+':'+n.sourceHash).join('\n'));
  return {notes,revision,issues};
 }
 function publicMeta(n) {const {body,...rest}=n;return rest;}
 async function list({q='',folder='',category='',limit=30,cursor='',revision:expected=''}={}) {
  if(q.length>200||!Number.isInteger(limit)||limit<1||limit>50||(folder&&!FOLDERS.includes(folder))||(category&&!['note','example','reference'].includes(category)))throw new ReaderError(400,'BAD_QUERY','Bộ lọc không hợp lệ.');
  const snap=await snapshot();if(expected&&expected!==snap.revision)throw new ReaderError(409,'INDEX_CHANGED','Danh sách đã thay đổi. Tải lại từ đầu.');
  const terms=fold(q).trim().split(/\s+/).filter(Boolean);const filtered=snap.notes.filter(n=>(!folder||n.folder===folder)&&(!category||n.category===category)&&terms.every(t=>fold(n.title+' '+n.body+' '+n.tags.join(' ')).includes(t)));
  let offset=0;const scope=hash(JSON.stringify({q,folder,category,limit}));
  if(cursor){try{const c=JSON.parse(Buffer.from(cursor,'base64url').toString());if(c.revision!==snap.revision||c.scope!==scope)throw new ReaderError(409,'INDEX_CHANGED','Nguồn hoặc bộ lọc đã thay đổi. Tải lại danh sách.');if(!Number.isInteger(c.offset)||c.offset<0||c.offset>filtered.length)throw Error();offset=c.offset;}catch(e){if(e instanceof ReaderError)throw e;throw new ReaderError(400,'BAD_CURSOR','Trang tiếp theo không hợp lệ.');}}
  const end=offset+limit;
  return {items:filtered.slice(offset,end).map(publicMeta),total:filtered.length,noteCount:snap.notes.filter(n=>n.category==='note').length,exampleCount:snap.notes.filter(n=>n.category==='example').length,referenceCount:snap.notes.filter(n=>n.category==='reference').length,revision:snap.revision,complete:snap.issues.length===0,issues:snap.issues,nextCursor:end<filtered.length?Buffer.from(JSON.stringify({offset:end,scope,revision:snap.revision})).toString('base64url'):null};
 }
 async function detail(id,expectedHash='') {
  if(!/^[a-f0-9]{24}$/.test(id))throw new ReaderError(404,'NOT_FOUND','Không tìm thấy ghi chú.');
  const snap=await snapshot();const n=snap.notes.find(n=>n.id===id);if(!n)throw new ReaderError(404,'NOT_FOUND','Ghi chú không còn trong phạm vi được đọc.');
  if(expectedHash&&expectedHash!==n.sourceHash)throw new ReaderError(409,'SOURCE_CHANGED','Ghi chú đã thay đổi trên đĩa. Tải bản mới trước khi dùng làm nguồn.');
  const plain=n.body.replace(/```[\s\S]*?```/g,'');const links=[...plain.matchAll(/\[\[([^\]|#]+)(?:[^\]]*)\]\]/g)].map(m=>{const target=m[1];const matches=snap.notes.filter(x=>fold(path.basename(x.path,'.md'))===fold(target)||fold(x.title)===fold(target)||x.path===target+'.md');return {label:target,id:matches.length===1?matches[0].id:null};});
  return {...n,revision:snap.revision,links};
 }
 return {list,detail,snapshot};
}
