// Canonical revert regressions: all controller I/O is injected; no live review or POST.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {hanFixture} from './fixtures/han-report.mjs';
import {HANDLING_COMMENT_VERSION, HELPDESK_COMMENT_VERSION, reportArtifacts} from '../skills/check-ticket/scripts/han-report.mjs';
import {executeReview} from '../skills/check-ticket/scripts/core.mjs';
import {TicketReviewService} from '../skills/check-ticket/scripts/service.mjs';
import {findPostedComment,ANDREW_ID} from '../skills/check-ticket/scripts/adapters.mjs';
import {checkWriterOutput} from '../skills/check-ticket-v2/scripts/postcheck.mjs';
import {writerPrompt} from '../skills/check-ticket-v2/scripts/prompts.mjs';
import {canonicalReview} from '../skills/check-ticket/scripts/canonical-review.mjs';
import {readHanReports} from '../skills/check-ticket/scripts/han-reports.mjs';
import {automaticHistory,conversationFromJob} from '../skills/check-ticket/scripts/history.mjs';
import {analyticsControllerJob,matchesHandlingReview} from './hachimi-analytics-store.mjs';
const hash=x=>createHash('sha256').update(x).digest('hex');
const source=hanFixture('Han đề xuất kiểm tra App embeds khi merchant đồng ý; chưa triển khai.','Question');
const claim={text:source.report.sections[3].body,finding_ids:['S1'],inference:true};
const verified={category:'Question',findings:[{id:'S1',kind:'suggestion',verified:true}],stats:{total:1}};
const output={body:source.fullReport,claims:[claim],customer_letter:null,letter_finding_ids:[]};
const settings={hanReport:true,commentMinChars:10,commentMaxChars:20000,letterMinScore:.9};
async function newReview(){
 const checked=checkWriterOutput(output,verified,settings);assert.equal(checked.ok,true,checked.violations.join('; '));
 const saved={};const review=await executeReview('CHAT-261101-abcdef',{save:async(n,v)=>{saved[n]=v;},hancal:async()=>({status:'ok',ticketId:'ticket1',category:'Question',writer:output,verified,postcheck:checked,counts:{}})}, {analysis:'hancal',hancalTimeoutMs:1000});
 assert.equal(saved['comment.txt'],source.comment);assert.equal(saved['report.md'],source.fullReport);return review;
}
function historical(root,status='done'){
 const artifacts=reportArtifacts(source.report,{commentFormatVersion:HANDLING_COMMENT_VERSION});
 return {id:'job1',ticketId:'ticket1',reference:'CHAT-261101-abcdef',trigger:'ticket_created',status,attempts:1,runId:'run1',category:'Question',createdAt:'2026-11-01T00:00:00Z',finishedAt:'2026-11-01T00:05:00Z',commentId:'receipt1',artifactDir:root+'/runtime/check-ticket/jobs/job1/run1',...artifacts,
 presentationBinding:{jobId:'job1',ticketId:'ticket1',runId:'run1',commentSha256:hash(artifacts.comment),fullReportSha256:hash(artifacts.fullReport),preparedAt:'2026-11-01T00:01:00Z'},
 deliveryReceipt:{jobId:'job1',ticketId:'ticket1',runId:'run1',commentId:'receipt1',commentAt:'2026-11-01T00:04:00Z',commentSha256:hash(artifacts.comment)}};
}
async function harness({status='queued',tamper=false,receiptWrong=false}={}){
 const root=await mkdtemp('/tmp/revert-canonical-');const actions=[];const calls={review:0,post:0};
 const job=status==='queued'?{id:'job1',ticketId:'ticket1',reference:'CHAT-261101-abcdef',trigger:'ticket_created',status,attempts:0,createdAt:'2026-11-01T00:00:00Z'}:historical(root,status);
 if(tamper)job.comment+=' changed';
 if(status==='uncertain')actions.push({id:'receipt1',type:'commentTicket',createdAt:'2026-11-01T00:04:00Z',author:{memberId:receiptWrong?'wrong':ANDREW_ID},metadata:{content:job.comment}});
 const statePath=root+'/state.json';await writeFile(statePath,JSON.stringify({version:1,assignedTicketIds:['ticket1'],jobs:{job1:job},commands:{},commandPending:{},seenNotificationIds:['keep'],activatedAt:job.createdAt}));
 const get=async path=>path.includes('/actions?')?{actions}:{ticket:{id:'ticket1'}};
 const options={root,statePath,config:{enabled:true,maxAttempts:1},resumeSession:true,now:()=>Date.parse('2026-11-01T01:00:00Z'),get,
  review:async()=>{calls.review++;return newReview();},find:(id,text,scope)=>findPostedComment(id,text,get,scope),
  post:async(id,text)=>{calls.post++;actions.push({id:'receipt-new',type:'commentTicket',createdAt:'2026-11-01T01:00:00Z',author:{memberId:ANDREW_ID},metadata:{content:text}});}};
 async function open(){const svc=new TicketReviewService(options);await svc.initialize();svc.notice=async()=>true;svc.terminalNotice=async()=>{};return svc;}
 return {root,statePath,actions,calls,open};
}
test('new actual core/controller path creates ts-review-v1 covering all report sections',async()=>{
 const h=await harness();const service=await h.open();await service.processOne();const j=service.state.jobs.job1;
 assert.equal(j.status,'done');assert.equal(j.commentFormatVersion,HELPDESK_COMMENT_VERSION);assert.equal(service.health().commentFormatVersion,HELPDESK_COMMENT_VERSION);
 assert.equal(j.comment,source.comment);assert.match(j.comment,/^Sau khi TS check thì thấy như sau:\nĐây là loại ticket gì : Question/);
 assert.equal(j.report.sections.length,7);assert.equal(h.calls.review,1);assert.equal(h.calls.post,1);
 assert.equal(h.actions[0].metadata.content,source.comment);
});
test('restored writer/postcheck retain full coverage and reject invalid claims/provider attribution',()=>{
 assert.equal(checkWriterOutput(output,verified,settings).ok,true);
 const prompt=writerPrompt({ticket:{},slack:null},verified,{maxChars:20000,minChars:10});
 assert.match(prompt,/TOÀN BỘ/);assert.doesNotMatch(prompt,/Automatic report ts-handling-v1/);
 for(const bad of [{...output,claims:[{...claim,finding_ids:['MISSING']}]},{...output,body:output.body.replace('Han đã đối chiếu','TS Elite 2 đã đối chiếu')}])assert.equal(checkWriterOutput(bad,verified,settings).ok,false);
});
for(const status of ['ready','uncertain'])test(`historical handling ${status} survives initialize/processOne/restart without rewrapping or AI`,async()=>{
 const h=await harness({status});let svc=await h.open();const before=structuredClone(svc.state.jobs.job1);await svc.processOne();const after=svc.state.jobs.job1;
 assert.equal(after.status,'done');assert.equal(after.comment,before.comment);assert.equal(after.commentFormatVersion,HANDLING_COMMENT_VERSION);assert.deepEqual(after.report,before.report);assert.deepEqual(after.presentationBinding,before.presentationBinding);
 assert.equal(h.calls.review,0);assert.equal(h.calls.post,status==='ready'?1:0);assert.equal(canonicalReview(after).delivery.confirmed,true);
 assert.equal(matchesHandlingReview(h.actions.find(a=>a.id===after.commentId),analyticsControllerJob(after,[after]),'ticket1'),true);
 svc=await h.open();await svc.processOne();assert.equal(h.calls.post,status==='ready'?1:0);assert.equal(svc.state.jobs.job1.comment,before.comment);
 assert.doesNotMatch(after.comment,/Sau khi TS check|Đây là loại ticket gì/);
});
test('historical binding tamper and wrong-author uncertain receipt cannot lead to a post or confirmed delivery',async()=>{
 const bad=await harness({status:'ready',tamper:true});const svc=await bad.open();await svc.processOne();assert.equal(bad.calls.post,0);assert.equal(bad.calls.review,0);assert.equal(canonicalReview(svc.state.jobs.job1).delivery.confirmed,false);
 const uncertain=await harness({status:'uncertain',receiptWrong:true});const other=await uncertain.open();await other.processOne();assert.equal(uncertain.calls.post,0);assert.equal(other.state.jobs.job1.status,'needs_attention');assert.equal(canonicalReview(other.state.jobs.job1).delivery.confirmed,false);
});
test('canonical API and History show exact historical short comment; full remains separate and state unchanged',async()=>{
 const h=await harness({status:'done'});const before=await readFile(h.statePath,'utf8');const j=JSON.parse(before).jobs.job1;
 const api=await readHanReports({root:h.root,statePath:h.statePath,id:j.id,runId:j.runId});const history=await automaticHistory({root:h.root,statePath:h.statePath,now:Date.parse(j.finishedAt)});
 assert.equal(api.comment,j.comment);assert.equal(api.fullReport,source.fullReport);assert.notEqual(api.comment,api.fullReport);
 assert.equal(history.conversations[0].messages.at(-1).text,j.comment);assert.equal(history.conversations[0].messages.filter(m=>m.canonical).length,1);assert.ok(!history.conversations[0].messages.some(m=>m.text===source.fullReport));
 assert.equal(api.canonical.sha256,hash(j.comment));assert.equal(api.delivery.confirmed,true);assert.equal(await readFile(h.statePath,'utf8'),before);
 await assert.rejects(readHanReports({root:h.root,statePath:h.statePath,id:j.id,runId:'wrong'}),/thay đổi/);
 const long={...j,commentFormatVersion:'ts-review-v1',comment:j.comment+'\n```js\n'+'  let x = 1;\n'.repeat(2000)+'```'};
 assert.equal(conversationFromJob(long).messages.at(-1).text,long.comment);
});
