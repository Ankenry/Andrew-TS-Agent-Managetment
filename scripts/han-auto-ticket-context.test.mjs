import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readAutoTickets,autoReviewBinding} from '../skills/check-ticket/scripts/han-reports.mjs';
import {createAutoTicketReader,redact,safeUrl} from './han-auto-ticket-context.mjs';
const base={id:'job1',ticketId:'t1',runId:'r1',reference:'AIR-261104-demo',subject:'Example',trigger:'ticket_created',status:'done',createdAt:'2026-11-01T00:00:00Z',finishedAt:'2026-11-01T01:00:00Z',comment:'Sau khi TS check thì thấy như sau:\nĐây là loại ticket gì : Question\nBody'};
async function fixture(jobs=[base]){const root=await mkdtemp(join(tmpdir(),'han-auto-core-'));await mkdir(join(root,'runtime/check-ticket'),{recursive:true});await writeFile(join(root,'runtime/check-ticket/state.json'),JSON.stringify({jobs:Object.fromEntries(jobs.map(j=>[j.id,j]))}));return root;}
const binding={ticketId:'t1',jobId:'job1',runId:'r1'};
const action=(id,extra={})=>({id,ticketId:'t1',type:'commentTicket',createdAt:`2026-11-01T00:00:${String(Number(id)||0).padStart(2,'0')}Z`,author:{displayName:'Andrew',authUid:'never-expose',memberId:'private-member'},metadata:{content:'comment '+id},...extra});
test('auto triggers only; grouped runs latest done; honest incomplete and cursor binding',async()=>{
 const root=await fixture([base,{...base,id:'job2',runId:'r2',status:'ready',finishedAt:'2026-11-02T00:00:00Z'}, {...base,id:'command',trigger:'bot_command'}, {...base,id:'manual',trigger:'manual'}, {...base,id:'other',ticketId:'t2',status:'queued',finishedAt:''}]);
 const data=await readAutoTickets({root});assert.equal(data.tickets.length,1);assert.equal(data.tickets[0].jobId,'job1');assert.equal(data.tickets[0].runs.length,2);assert.equal(data.tickets[0].incompleteCount,1);assert.doesNotMatch(data.tickets[0].statusLabel,/Đã xác nhận/);
 const all=await readAutoTickets({root,scope:'all',limit:1});assert.equal(all.totalTickets,2);assert.ok(all.nextCursor);assert.equal((await readAutoTickets({root,scope:'all',cursor:all.nextCursor})).tickets.length,1);
 await assert.rejects(readAutoTickets({root,q:'changed',cursor:all.nextCursor}),{status:409});await assert.rejects(autoReviewBinding(root,{...binding,runId:'wrong'}),{status:409});
});
test('250 comments over three pages, duplicate ID, full code and read-only fixed routes',async()=>{
 const root=await fixture();const code='```js\n'+'const x = "<script>";\n'.repeat(1500)+'```';let calls=[];
 const reader=createAutoTicketReader({root,get:async path=>{calls.push(path);const c=new URL(path,'https://x').searchParams.get('cursor');if(!c)return{actions:Array.from({length:100},(_,i)=>action(String(i),i===0?{metadata:{content:code}}:{})),total:250,nextCursor:'page2'};if(c==='page2')return{actions:Array.from({length:100},(_,i)=>action(String(i+100))),total:250,nextCursor:'page3'};return{actions:[action('199'),...Array.from({length:50},(_,i)=>action(String(i+200)))],total:250,hasMore:false};}});
 let p=await reader.comments(binding);assert.equal(p.complete,false);assert.equal(p.comments[0].content,code);assert.equal(JSON.stringify(p).includes('never-expose'),false);const first=p;
 p=await reader.comments(binding,p.nextCursor);assert.equal(p.loadedComments,200);p=await reader.comments(binding,p.nextCursor);assert.equal(p.loadedComments,250);assert.equal(p.scannedActions,250);assert.equal(p.complete,true);assert.equal(p.totalComments,250);assert.equal(reader.evidence(binding,p.snapshotId).comments.length,250);
 await assert.rejects(reader.comments({...binding,ticketId:'t2'},first.nextCursor));assert.equal(calls.length,3);assert.ok(calls.every(x=>x.startsWith('/tickets/t1/actions?type=commentTicket&limit=100')));
});
test('totalActions is not totalComments; ambiguous terminal page never claims all',async()=>{
 const root=await fixture();let output={actions:[action('1'),action('2',{type:'statusChanged'})],total:99,hasMore:false};const reader=createAutoTicketReader({root,get:async()=>output});let p=await reader.comments(binding);assert.equal(p.totalActions,99);assert.equal(p.loadedComments,1);assert.equal(p.scannedActions,2);assert.equal(p.totalComments,1);assert.equal(p.complete,true);
 output={actions:[action('1')],total:99};p=await reader.comments(binding);assert.equal(p.complete,false);assert.equal(p.totalComments,null);assert.equal(p.error,'end_not_proven');
 for(const n of [0,100,101]){output={actions:Array.from({length:n},(_,i)=>action(String(i))),total:n};p=await reader.comments(binding);assert.equal(p.complete,true);assert.equal(p.loadedComments,n);}
});
test('cursor loop, changed comment, missing cursor, auth errors and binding rejected',async()=>{
 const root=await fixture();let call=0;const reader=createAutoTicketReader({root,get:async()=>++call===1?{actions:[action('1')],nextCursor:'x'}:{actions:[action('2')],nextCursor:'x'}});let p=await reader.comments(binding);p=await reader.comments(binding,p.nextCursor);assert.equal(p.error,'repeated_cursor');assert.throws(()=>reader.evidence(binding,p.snapshotId),{status:409});
 call=0;const changed=createAutoTicketReader({root,get:async()=>++call===1?{actions:[action('1')],nextCursor:'x'}:{actions:[action('1',{metadata:{content:'edited'}})],hasMore:false}});p=await changed.comments(binding);p=await changed.comments(binding,p.nextCursor);assert.equal(p.error,'changed_during_read');
 const missing=createAutoTicketReader({root,get:async()=>({actions:[],hasMore:true})});assert.equal((await missing.comments(binding)).error,'missing_cursor');
 for(const status of [403,429]){const r=createAutoTicketReader({root,get:async()=>{throw Error('Helpdesk GET failed (HTTP '+status+').')}});await assert.rejects(r.comments(binding),{status});}
 const bad=createAutoTicketReader({root,get:async()=>({id:'wrong'})});await assert.rejects(bad.detail(binding),{status:502});
});
test('redaction and safe links preserve code except explicit secret values',()=>{
 const r=redact('password="two word secret"\n```css\n.a { color:red; }\n```\nBearer abc.def_123');assert.equal(r.redacted,true);assert.doesNotMatch(r.text,/two word secret|abc.def/);assert.match(r.text,/\.a \{ color:red; \}/);
 for(const u of ['javascript:alert(1)','data:text/html,hey','http://site.test','https://u:p@site.test','https://site.test?token=secret','https://site.test?key=secret','https://site.test#access_token=secret'])assert.equal(safeUrl(u),null);assert.equal(safeUrl('https://capture.avada.io/i/example'),'https://capture.avada.io/i/example');
});
test('contradictory or changing totals never claim a complete snapshot',async()=>{const root=await fixture();const bad=createAutoTicketReader({root,get:async()=>({actions:[action('1')],total:0,hasMore:false})});assert.equal((await bad.comments(binding)).error,'inconsistent_total');let n=0;const changing=createAutoTicketReader({root,get:async()=>++n===1?{actions:[action('1')],total:2,nextCursor:'n'}:{actions:[action('2')],total:3,hasMore:false}});let p=await changing.comments(binding);p=await changing.comments(binding,p.nextCursor);assert.equal(p.complete,false);assert.equal(p.error,'changed_during_read');});
test('cancelled fixed-route read fails explicitly without complete evidence',async()=>{const root=await fixture();const abort=new AbortController();const r=createAutoTicketReader({root,get:async(_p,{signal})=>new Promise((_res,reject)=>{signal.addEventListener('abort',()=>reject(Error('aborted')),{once:true});})});const read=r.comments(binding,'',abort.signal);setImmediate(()=>abort.abort());await assert.rejects(read,{status:502});});
