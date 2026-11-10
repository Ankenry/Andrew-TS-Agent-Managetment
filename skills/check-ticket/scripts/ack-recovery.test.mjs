import test from 'node:test';
import assert from 'node:assert/strict';
import { TicketReviewService } from './service.mjs';
import { ANDREW_ID, postComment, findPostedComment } from './adapters.mjs';
import { CHECK_ACK, parseBotCommand } from './bot-command.mjs';
import { recoverAckDraft, ackReceiptId } from './ack-recovery.mjs';
const now = Date.parse('2026-10-22T00:10:00Z');
const action = (id,content,at='2026-10-22T00:01:00Z') => ({id,createdAt:at,author:{memberId:ANDREW_ID},metadata:{content}});
function job(id='new') {
 const text='@han viết mail';
 return {id:'cmd-'+id,ticketId:'ticket',reference:'CHAT-test',trigger:'bot_command',mode:'draft',status:'queued',phase:'queued',attempts:0,
   command:{...parseBotCommand(text),commentId:id,createdAt:'2026-10-22T00:01:00Z'},ack:{status:'pending',content:CHECK_ACK,attempts:0},telegram:{}};
}
function fixture() {
 const target=job(), old=job('old');old.status='needs_attention';old.phase='ack';
 old.ack={status:'needs_attention',content:CHECK_ACK,attempts:1,startedAt:'2026-10-22T00:02:00Z',beforeIds:['old'],reconcileAttempts:3,lastError:'unconfirmed'};
 const comments=[action('new','@han viết mail')];const posts=[];
 const get=async (path,opts={})=>{
   if(opts.method==='POST') {posts.push(opts.body);const a=action('receipt-'+posts.length,opts.body.content,new Date(now).toISOString());a.author=opts.body.author;comments.push(a);return {id:a.id};}
   if(path.startsWith('/members'))return {members:[{id:ANDREW_ID,displayName:'Andrew',photoURL:'https://example.test/avatar'}]};
   if(path.includes('/actions?'))return {actions:comments,total:comments.length};
   return {ticket:{id:'ticket'}};
 };
 const opts={config:{enabled:true,maxAttempts:3},get,now:()=>now,post:(id,c,m)=>postComment(id,c,get,m),find:(id,c,s)=>findPostedComment(id,c,get,s)};
 const service=new TicketReviewService(opts);
 service.state={jobs:{[target.id]:target,[old.id]:old},commands:{new:'cmd-new',old:'cmd-old'},commandScanAt:'unchanged'};
 service.change=async fn=>fn(service.state);
 return {target,old,comments,posts,get,opts,service};
}
function recovery(f) {
 f.target.status='needs_attention';f.target.phase='ack';f.target.ack.status='needs_attention';f.target.ack.attempts=3;
 return {targetJobId:f.target.id,historicalJobIds:[f.old.id],actions:f.comments,approval:'fixture-user-order',reason:'Old outcome unresolved; isolate only this target.',now:new Date(now).toISOString()};
}
test('late historical ACK receipt is GET-confirmed before a new ACK; historical content is never replayed',async()=>{
 const f=fixture();f.old.ack.receiptId='late-old';f.comments.push(action('late-old',CHECK_ACK,'2026-10-22T00:03:00Z'));
 assert.equal(await f.service.deliverCommandAck(f.target),true);
 assert.equal(f.old.ack.commentId,'late-old');assert.equal(f.old.status,'needs_attention');assert.equal(f.posts.length,1);
 assert.equal(f.target.ack.receiptId,'receipt-1');assert.equal(f.target.ack.commentId,'receipt-1');
});
test('identical text from another command is not a receipt for an unresolved old ACK',async()=>{
 const f=fixture();f.old.ack.receiptId='missing-old';const other=job('other');other.ack={status:'sent',commentId:'other-ack'};f.service.state.jobs[other.id]=other;
 f.comments.push(action('other-ack',CHECK_ACK,'2026-10-22T00:03:00Z'));
 assert.equal(await f.service.deliverCommandAck(f.target),false);assert.equal(f.posts.length,0);assert.equal(f.old.ack.status,'needs_attention');
});
test('never-posted historical blocked ACK does not lock the whole ticket',async()=>{
 const f=fixture();f.old.ack={status:'needs_attention',attempts:3,content:CHECK_ACK,lastError:'earlier blocked'};
 assert.equal(await f.service.deliverCommandAck(f.target),true);assert.equal(f.posts.length,1);
});
test('unknown historical POST remains blocked without an explicit scoped recovery',async()=>{
 const f=fixture();assert.equal(await f.service.deliverCommandAck(f.target),false);
 assert.equal(f.posts.length,0);assert.equal(f.target.ack.lastErrorPhase,'prior_ack_reconcile');assert.match(f.target.ack.lastError,/earlier ACK/);
});
test('command disappearance or changed author/instruction prevents new ACK',async()=>{
 for(const modify of [f=>f.comments.splice(0),f=>f.comments[0].author.memberId='someone',f=>f.comments[0].metadata.content='@han gửi mail']) {
  const f=fixture();f.old.ack.status='sent';modify(f);
  assert.equal(await f.service.deliverCommandAck(f.target),false);assert.equal(f.posts.length,0);assert.equal(f.target.ack.startedAt,undefined);
 }
});
test('author lookup failure is recorded as no POST and can retry; POST transport errors remain uncertain',async()=>{
 const f=fixture();f.old.ack.status='sent';
 f.service.post=(id,c,m)=>postComment(id,c,async(path,opts)=>{if(path.startsWith('/members'))throw Error('read unavailable');return f.get(path,opts);},m);
 await f.service.deliverCommandAck(f.target);
 assert.equal(f.target.ack.status,'pending');assert.equal(f.target.ack.startedAt,undefined);assert.equal(f.target.ack.lastErrorPhase,'author_lookup');
 assert.equal(f.target.ack.errors[0].postAttempted,false);assert.equal(f.target.ack.abortedIntents.length,1);assert.equal(f.posts.length,0);
 f.target.ack.nextAttemptAt=0;
 f.service.post=(id,c,m)=>postComment(id,c,async(path,opts)=>{if(opts?.method==='POST')throw Error('transport unknown');return f.get(path,opts);},m);
 await f.service.deliverCommandAck(f.target);
 assert.equal(f.target.ack.status,'uncertain');assert.equal(f.target.ack.lastErrorPhase,'post');assert.equal(f.target.ack.errors.at(-1).postAttempted,true);
});
test('scoped recovery preserves history/dedup and allows precisely one new ACK with exact receipt verification',async()=>{
 const f=fixture();const options=recovery(f);const before=structuredClone(f.old.ack);
 const audit=recoverAckDraft(f.service.state,options);assert.deepEqual(audit.history[0].ack,before);
 assert.equal(f.old.status,'needs_attention');assert.equal(f.old.ack.commentId,undefined);assert.equal(f.target.ack.requireReceiptId,true);
 assert.equal(f.service.state.commandScanAt,'unchanged');assert.deepEqual(f.service.state.commands,{new:'cmd-new',old:'cmd-old'});
 assert.throws(()=>recoverAckDraft(f.service.state,options),/not a never-posted/);
 // A delayed identical old ACK appears after the target's POST. Only returned ID may confirm target.
 const post=f.service.post;f.service.post=async(...args)=>{const receipt=await post(...args);f.comments.push(action('late-unknown',CHECK_ACK,new Date(now).toISOString()));return receipt;};
 assert.equal(await f.service.ensureCommandAck(f.target),true);assert.equal(f.target.ack.commentId,'receipt-1');assert.equal(f.posts.length,1);
 const restart=new TicketReviewService(f.opts);restart.state=structuredClone(f.service.state);restart.change=async fn=>fn(restart.state);
 assert.equal(await restart.ensureCommandAck(restart.state.jobs[f.target.id]),true);assert.equal(f.posts.length,1);
 const next=job('next');f.service.state.jobs[next.id]=next;f.comments.push(action('next','@han viết mail'));
 assert.equal(await f.service.deliverCommandAck(next),false);assert.equal(f.posts.length,1,'isolation cannot authorize another command');
});
test('recovery without returned receipt never guesses from text and restart never reposts',async()=>{
 const f=fixture();recoverAckDraft(f.service.state,recovery(f));
 const post=f.service.post;f.service.post=async(...args)=>{await post(...args);throw Error('lost response');};
 await f.service.deliverCommandAck(f.target);assert.equal(f.target.ack.status,'uncertain');
 const restart=new TicketReviewService(f.opts);restart.state=structuredClone(f.service.state);restart.change=async fn=>fn(restart.state);
 const target=restart.state.jobs[f.target.id];target.ack.nextAttemptAt=0;
 await restart.deliverCommandAck(target);assert.equal(f.posts.length,1);assert.equal(target.ack.commentId,undefined);assert.match(target.ack.lastError,/receipt ID required/);
});
test('recovery refuses vanished commands, target POST intent, existing draft or out-of-scope blockers before changing state',()=>{
 for(const modify of [f=>f.comments.splice(0),f=>f.target.ack.startedAt='2026-10-22T00:02:00Z',
   f=>f.comments.push(action('draft','[DRAFT — mail theo yêu cầu | Command: new]')),
   f=>{const extra=structuredClone(f.old);extra.id='cmd-extra';f.service.state.jobs[extra.id]=extra;}]) {
  const f=fixture();const opts=recovery(f);modify(f);const before=JSON.stringify(f.service.state);
  assert.throws(()=>recoverAckDraft(f.service.state,opts));assert.equal(JSON.stringify(f.service.state),before);
 }
});
test('receipt extraction only accepts actual returned IDs; scoped GET validates ID/content/author/time',async()=>{
 assert.equal(ackReceiptId({success:true}),null);assert.equal(ackReceiptId({id:123}),null);assert.equal(ackReceiptId({comment:{id:'real'}}),'real');assert.equal(ackReceiptId({commentId:'actual'}),'actual');assert.equal(ackReceiptId({actionId:'actual-action'}),'actual-action');
 const actions=[action('wrong',CHECK_ACK),action('real',CHECK_ACK)];
 assert.equal((await findPostedComment('ticket',CHECK_ACK,async()=>({actions}),{receiptId:'real'})).id,'real');
 assert.equal(await findPostedComment('ticket',CHECK_ACK,async()=>({actions}),{receiptId:'real',excludeIds:['real']}),null);
 assert.equal(await findPostedComment('ticket',CHECK_ACK,async()=>({actions}),{receiptId:'real',since:'2026-10-22T00:02:00Z'}),null);
 actions[1].author.memberId='someone';assert.equal(await findPostedComment('ticket',CHECK_ACK,async()=>({actions}),{receiptId:'real'}),null);
});

test('Helpdesk updated-ticket response is not mistaken for a comment receipt',async()=>{
 assert.equal(ackReceiptId({id:'ticket',ticketId:'CHAT-test',subject:'ticket subject'}),null);
 assert.equal(ackReceiptId({id:'ticket'},'ticket'),null);
 const f=fixture();f.old.ack.status='sent';const post=f.service.post;
 f.service.post=async(...args)=>{await post(...args);return {id:'ticket',ticketId:'CHAT-test',subject:'ticket subject'};};
 assert.equal(await f.service.deliverCommandAck(f.target),true);assert.equal(f.target.ack.receiptId,undefined);
 assert.equal(f.target.ack.commentId,'receipt-1');assert.equal(f.target.ack.responseKind,'ticket');assert.equal(f.posts.length,1);
});
