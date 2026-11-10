import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {parseBotCommand,CHECK_ACK} from './bot-command.mjs';
import {TicketReviewService} from './service.mjs';
import {ANDREW_ID,postComment,findPostedComment} from './adapters.mjs';
import {readDraftContext,generateDraft,commandDraftComment} from './bot-draft.mjs';
import {formatDraftComment} from '../../dev-fix-follow/scripts/core.mjs';
const ORIGINAL='@han tạo mail cho khách giúp anh là TS hiện đã chuyển đổi mail ở hệ thống chuyển mail support từ support@example.test sang jp@example.test';
const ID='qt6k2MtoVleaacCfOqXx';
const BODY='Subject: Support contact update\n\nHi JP,\n\nOur support team has updated your support contact address as requested.\n\nBest regards,\nSupport team';
const IMAGE_DRAFT='@han viết mail báo khách theo như slack thread, nhớ lấy cả link ảnh mà tester đã gửi kèm cả link ảnh này https://capture.avada.io/i/yIHiT7VMfElP';
const VIDEO_DRAFT='@han viết mail báo khách đi, chỗ dev bảo là chưa bật banner ở Canada là sai, chỉ cần báo đã fix done và kèm theo thông tin, video tôi đã gửi cho Iris ở comment ticket là được';
const REWRITE_DRAFT='@han sao trong mail không nhắc tới "Do store này đổi currency nhưng ở handle page detect sai báo lại dev theme thôi", viết llại mail cho tôi';
const LOCATED_IMAGE_DRAFT='@han check ticket này, check thread slack xem dev done chưa thì viết mail báo khách kèm link ảnh này ( https://capture.avada.io/i/eJnkjqwn7veF ) thay cho image dev gửi ở thread slack';

test('existing media located in a thread can omit the past-tense marker without changing the command',()=>{
 for(const text of [LOCATED_IMAGE_DRAFT,'@han soạn mail kèm ảnh dev gửi ở thread Slack',
  '@han soạn mail kèm screenshot mà QA đăng trong comment',
  '@han viết mail dùng hình tester gửi tại ticket',
  '@han viết mail kèm link image developer gửi trong Slack']) {
  const parsed=parseBotCommand(text);
  assert.equal(parsed.kind,'draft',text);assert.deepEqual(parsed.reasons,[]);
  assert.equal(parsed.instruction,text.slice(5));
  assert.deepEqual(parsed,parseBotCommand(text),'repeated parsing must be stable');
 }
});

test('located media evidence never exempts a new send, request, future tense or another write',()=>{
 for(const action of ['gửi luôn','gửi mail cho khách','gửi ảnh cho dev','đăng lên Slack','send it',
  'delete draft','đổi status done','tick done','bật setting','theme push']) {
  for(const text of [LOCATED_IMAGE_DRAFT+', rồi '+action,'@han '+action+', '+LOCATED_IMAGE_DRAFT.slice(5)])
   assert.equal(parseBotCommand(text).kind,'refused',text);
 }
 for(const text of ['@han viết mail, nhờ dev gửi image ở thread Slack',
  '@han viết mail kèm image dev sẽ gửi ở thread Slack','@han viết mail kèm image dev cần gửi ở thread Slack',
  '@han viết mail kèm image dev gửi cho khách','@han viết mail kèm image dev gửi lên Slack',
  '@han viết mail kèm image dev gửi ở thread Slack cho khách'])
  assert.equal(parseBotCommand(text).kind,'refused',text);
});

test('located-media draft posts one ACK and one draft, then stays deduplicated after restart',async()=>{
 const h=await harness();const j=await h.enqueue('located-image',LOCATED_IMAGE_DRAFT);
 assert.equal(j.mode,'draft');await h.service.processOne();assert.equal(j.status,'done');
 assert.equal(h.generations(),1);assert.equal(h.posted.length,2);
 assert.equal(h.posted[0].content,CHECK_ACK);
 assert.match(h.posted[1].content,/^\[DRAFT — mail theo yêu cầu \| Command: located-image\]/);
 const ack=structuredClone(j.ack);
 await h.restart();await h.enqueue('located-image',LOCATED_IMAGE_DRAFT);await h.service.processOne();
 assert.equal(h.generations(),1);assert.equal(h.posted.length,2);
 assert.deepEqual(h.service.state.jobs[j.id].ack,ack);
});

test('located-media draft revalidates the unchanged command and rejects an appended send',async()=>{
 const base=contextGet();const getFor=text=>async path=>{const data=await base(path);
  if(data.actions)data.actions=data.actions.map(a=>a.id===ID?{...a,content:text}:a);return data;};
 const command={commentId:ID,instruction:LOCATED_IMAGE_DRAFT.slice(5)};
 const context=await readDraftContext('JOY',command,getFor(LOCATED_IMAGE_DRAFT));
 assert.equal(context.command.content,LOCATED_IMAGE_DRAFT);
 await assert.rejects(readDraftContext('JOY',command,getFor(LOCATED_IMAGE_DRAFT+', rồi gửi luôn')),/no longer draft/);
});

test('mail-content correction routes to rewrite draft without changing the exact instruction',()=>{
 for(const text of [REWRITE_DRAFT,REWRITE_DRAFT.replace('nhắc tới','nhắc đến'),REWRITE_DRAFT.replace('llại','lại'),
  '@han viết lại mail cho tôi','@han soạn lại một bản email cho khách','@han viet lai mail cho khach',
  '@han viết lại mail nhắc tới lỗi currency','@han soạn lại thư cần nhắc đến vấn đề của theme']) {
  const parsed=parseBotCommand(text);
  assert.equal(parsed.kind,'draft',text);assert.deepEqual(parsed.reasons,[]);
  assert.equal(parsed.instruction,text.slice(5));
 }
 assert.equal(parseBotCommand('@han sao trong mail không nhắc tới lỗi currency?').kind,'question');
 assert.deepEqual(parseBotCommand(REWRITE_DRAFT),parseBotCommand(REWRITE_DRAFT));
});

test('mail-content reference cannot exempt person tags, sends or other writes',()=>{
 for(const action of ['nhắc Iris','nhắc @Iris','nhắc tới @Iris','nhắc đến Iris','tag Iris','mention @Iris',
  'gửi mail cho khách','gửi luôn','đăng lên Slack','send it','delete draft','đổi status done','tick done','bật setting','theme push']) {
  for(const text of [`${REWRITE_DRAFT}, rồi ${action}`,`@han ${action}, ${REWRITE_DRAFT.slice(5)}`]) assert.equal(parseBotCommand(text).kind,'refused',text);
 }
 for(const text of ['@han viết lại mail, mail cần nhắc tới @Iris','@han viết lại mail, mail không nhắc tới "@Iris"',
  '@han viết lại mail, mail cần nhắc tới Iris','@han viết lại mail, mail không nhắc tới "gửi mail cho khách"',
  '@han viết lại mail và gửi cho khách','@han viết llại mail và gửi luôn']) assert.equal(parseBotCommand(text).kind,'refused',text);
});

test('CB correction with an existing video is draft-only and retains the exact instruction',()=>{
 for(const text of [VIDEO_DRAFT, '@han soạn mail kèm video mà tôi đã gửi cho Iris', '@han viết mail kèm link video tôi đã đăng ở comment', '@han soạn mail kèm video dev đã gửi', '@han viết mail kèm ảnh tôi đã gửi']) {
  const parsed=parseBotCommand(text);
  assert.equal(parsed.kind,'draft',text);
  assert.deepEqual(parsed.reasons,[]);
  assert.equal(parsed.instruction,text.slice(5));
 }
 for(const action of ['gửi cho Iris','gửi mail cho khách','gửi luôn','đăng lên Slack','send it','delete draft','đổi status done','tick done','bật setting','theme push']) {
  for(const text of [`${VIDEO_DRAFT}, rồi ${action}`,`@han ${action}, ${VIDEO_DRAFT.slice(5)}`]) assert.equal(parseBotCommand(text).kind,'refused',text);
 }
 for(const text of ['@han soạn mail rồi gửi video cho Iris','@han soạn mail kèm video tôi sẽ gửi','@han soạn mail, nhờ tôi gửi video','@han soạn mail kèm video tôi đã gửi cho khách']) assert.equal(parseBotCommand(text).kind,'refused',text);
});

test('draft can reference images already sent by a third party without changing the instruction',()=>{
 for(const text of [IMAGE_DRAFT, '@han soạn mail kèm ảnh dev đã gửi', '@han viết mail kèm hình ảnh mà khách hàng đã gửi', '@han soạn mail kèm screenshot mà QA đã đăng', '@han viết mail kèm ảnh tester đã gửi và ảnh dev đã gửi']) {
  const parsed=parseBotCommand(text);
  assert.equal(parsed.kind,'draft',text);
  assert.deepEqual(parsed.reasons,[]);
  assert.equal(parsed.instruction,text.slice(5));
 }
 assert.deepEqual(parseBotCommand(IMAGE_DRAFT),parseBotCommand(IMAGE_DRAFT),'repeated parsing is stable');
});

test('past image evidence never exempts additional writes or future sending requests',()=>{
 for(const action of ['gửi luôn','gửi mail cho khách','đăng lên Slack','send it','delete draft','đổi status done','tick done','bật setting','theme push']) {
  for(const text of [`${IMAGE_DRAFT}, rồi ${action}`,`@han ${action}, ${IMAGE_DRAFT.slice(5)}`]) {
   assert.equal(parseBotCommand(text).kind,'refused',text);
  }
 }
 for(const text of ['@han soạn mail và gửi ảnh cho tester', '@han soạn mail, nhờ tester gửi ảnh', '@han soạn mail kèm ảnh mà tester sẽ gửi', '@han soạn mail kèm ảnh mà tester đã gửi cho khách']) {
  assert.equal(parseBotCommand(text).kind,'refused',text);
 }
});

test('Vietnamese/English drafting commands route to draft, exact JOY wording with anonymized recipients',()=>{
 for(const s of [ORIGINAL,'@han viết mail','@han soạn email cho khách','@han soạn mail trả lời khách','@han tạo một bản thư cho khách hàng','@han viet mail cho khach','@han draft an email to customer','@han compose a reply for merchant','@han write a customer email','@han prepare an email','@han create a reply']) assert.equal(parseBotCommand(s).kind,'draft',s);
});
test('sending and mixed forbidden actions cannot be laundered through a draft request',()=>{
 for(const s of ['@han gửi mail cho khách','@han send email','@han reply to customer','@han soạn mail và gửi mail cho khách','@han draft email and send it','@han draft email and deliver it','@han viết mail, đổi status done','@han soạn mail, tick done','@han draft email and delete draft','@han viết mail, bật setting','@han write email and update status','@han draft email and post to Slack','@han draft email; theme push','@han gửi khách rồi soạn mail','@han soạn mail và gửi luôn','@han draft email and reply to customer','@han soạn mail rồi gửi tới khách','@han draft email then reply to the customer']) assert.equal(parseBotCommand(s).kind,'refused',s);
 assert.equal(parseBotCommand('@han draft email '+ 'a'.repeat(2100)).kind,'refused');
 for(const [s,k] of [['@han check tiếp','follow_up'],['@han hi','chat'],['@han ticket này sao rồi?','question']]) assert.equal(parseBotCommand(s).kind,k);
});

async function harness({fail=0,uncertain=false,saveUncertain=true,noAvatar=false,ackUncertain=false}={}) {
 const root=await mkdtemp(join(tmpdir(),'mail-draft-test-'));
 let now=Date.parse('2026-10-21T15:27:00Z'), generations=0;const posted=[],comments=[],notices=[];
 const ticket={id:'ticket',ticketId:'JOY-261021-myRcTw',subject:'Update support email',appName:'JOY Loyalty',memberIds:[ANDREW_ID]};
 const get=async(path,options={})=>{
  if(options.method==='POST') {
   assert.match(path,/\/comments$/); posted.push(options.body);
   const isAck=options.body.content===CHECK_ACK;
   if((!uncertain || saveUncertain || isAck) && (!ackUncertain || !isAck)) comments.push({id:'p'+posted.length,createdAt:new Date(now).toISOString(),author:options.body.author,metadata:{content:options.body.content}});
   if((uncertain&&!isAck)||(ackUncertain&&isAck)) throw Error('POST outcome unknown');
   return {id:'p'+posted.length};
  }
  if(path.startsWith('/members')) return {members:[{id:ANDREW_ID,displayName:'Andrew',photoURL:noAvatar?'':'https://example.test/avatar.png',privateKey:'never copy'}]};
  if(path.startsWith('/tickets?'))return {tickets:[ticket],total:1};
  if(path.includes('/actions?'))return {actions:comments,total:comments.length};
  if(path.startsWith('/tickets/'))return {ticket};
  throw Error('Unexpected request '+path);
 };
 const opts={root,statePath:join(root,'state.json'),config:{enabled:true,maxAttempts:3,pollIntervalMs:300000,queueIntervalMs:10000},get,now:()=>now,resumeSession:true,
  post:(id,content,mentions)=>postComment(id,content,get,mentions),find:(id,content,scope)=>findPostedComment(id,content,get,scope),
  review:async()=>{throw Error('Must not run review');},reply:async()=>{throw Error('Must not run reply');},
  draft:async()=>{generations++;if(generations<=fail)throw Error('Draft generation unavailable');return {ticketId:'ticket',body:BODY,source:'draft',appName:'JOY Loyalty'};},
  notify:async text=>{notices.push(text);return {messageId:notices.length};}};
 let service=new TicketReviewService(opts);await service.initialize();
 const enqueue=async(id=ID,text=ORIGINAL)=>{const command={...parseBotCommand(text),commentId:id,createdAt:new Date(now-1000).toISOString(),content:text};if(!comments.some(a=>a.id===id))comments.push({id,createdAt:command.createdAt,author:{memberId:ANDREW_ID},metadata:{content:text}});await service.enqueueCommand(ticket,command);return service.state.jobs['cmd-'+id];};
 return {root,opts,posted,comments,notices,enqueue,get service(){return service;},generations:()=>generations,tick:()=>now+=600000,restart:async()=>{service=new TicketReviewService(opts);await service.initialize();return service;}};
}

test('controller posts one ACK + one draft with current author/avatar and command marker; dedup after restart',async()=>{
 const h=await harness();const j=await h.enqueue();assert.equal(h.posted.length,1);assert.equal(j.ack.status,'sent');
 await h.service.processOne();assert.equal(j.status,'done');assert.equal(h.generations(),1);assert.equal(h.posted.length,2);
 assert.match(h.posted[1].content,new RegExp('^\\[DRAFT.*Command: '+ID));assert.equal(h.posted[0].content,CHECK_ACK);
 for(const p of h.posted)assert.deepEqual(p.author,{memberId:ANDREW_ID,displayName:'Andrew',photoURL:'https://example.test/avatar.png'});
 assert.match(h.notices.at(-1),/chưa gửi email/);
 assert.equal(h.service.health().botCommands.draftMailFormat,'andrew-app-team-v1');
 await h.restart();await h.enqueue();await h.service.processOne();assert.equal(h.posted.length,2);assert.equal(h.generations(),1);
});
test('failed draft retries keep existing ACK, restart before retry, eventual one draft',async()=>{
 const h=await harness({fail:1});const j=await h.enqueue();await h.service.processOne();assert.equal(j.status,'queued');assert.equal(h.posted.length,1);
 h.tick();await h.restart();await h.service.processOne();assert.equal(h.service.state.jobs[j.id].status,'done');assert.equal(h.posted.length,2);assert.equal(h.generations(),2);
});
for(const [caseName,text] of [['image',IMAGE_DRAFT],['video',VIDEO_DRAFT],['rewrite',REWRITE_DRAFT]]) test(`${caseName}-reference command reaches draft delivery once; restart does not replay it`,async()=>{
 const h=await harness();const j=await h.enqueue('image-command',text);
 assert.equal(j.mode,'draft');assert.equal(j.ack.status,'sent');
 await h.service.processOne();assert.equal(j.status,'done');assert.equal(h.generations(),1);
 assert.equal(h.posted.length,2);assert.equal(h.posted[0].content,CHECK_ACK);
 assert.match(h.posted[1].content,/Command: image-command/);
 await h.restart();await h.enqueue('image-command',text);await h.service.processOne();
 assert.equal(h.generations(),1);assert.equal(h.posted.length,2);
});
test('permanent draft failure retains ACK and emits draft failure, no report',async()=>{
 const h=await harness({fail:9});const j=await h.enqueue();for(let i=0;i<3;i++){await h.service.processOne();h.tick();}
 assert.equal(j.status,'needs_attention');assert.equal(h.posted.length,1);assert.match(h.notices.at(-1),/Chưa lưu được mail nháp/);
});
test('ambiguous saved POST reconciles after restart without generation/repost',async()=>{
 const h=await harness({uncertain:true});const j=await h.enqueue();await h.service.processOne();assert.equal(j.status,'uncertain');assert.equal(h.posted.length,2);
 await h.restart();await h.service.processOne();assert.equal(h.service.state.jobs[j.id].status,'done');assert.equal(h.posted.length,2);assert.equal(h.generations(),1);
});
test('ambiguous unsaved POST becomes needs_attention without blind repost',async()=>{
 const h=await harness({uncertain:true,saveUncertain:false});const j=await h.enqueue();await h.service.processOne();await h.restart();await h.service.processOne();
 assert.equal(h.service.state.jobs[j.id].status,'needs_attention');assert.equal(h.posted.length,2);
});
test('missing author avatar or unconfirmed ACK blocks draft generation',async()=>{
 for(const config of [{noAvatar:true},{ackUncertain:true}]){const h=await harness(config);const j=await h.enqueue();for(let i=0;i<4;i++){await h.service.processOne();h.tick();}assert.equal(h.generations(),0);assert.equal(j.status,'needs_attention');assert.equal(h.posted.length,config.ackUncertain?1:0);}
});
test('separate commands with identical body have distinct draft markers and ACK receipts',async()=>{
 const h=await harness();const a=await h.enqueue();await h.service.processOne();h.tick();const b=await h.enqueue('other-command');await h.service.processOne();
 assert.equal(h.posted.length,4);assert.notEqual(a.ack.commentId,b.ack.commentId);assert.notEqual(a.commentId,b.commentId);assert.notEqual(a.comment,b.comment);
});
test('mixed command is refused after ACK, never reaches draft worker',async()=>{
 const h=await harness();const j=await h.enqueue(ID,'@han soạn mail và gửi mail cho khách');await h.service.processOne();assert.equal(j.status,'cancelled');assert.equal(h.posted.length,1);assert.equal(h.generations(),0);
});
test('previous refused historical command remains refused after candidate restart (no replay/migration)',async()=>{
 const h=await harness();const j=await h.enqueue(ID,'@han gửi mail cho khách');await h.restart();await h.enqueue(ID,ORIGINAL);await h.service.processOne();assert.equal(h.service.state.jobs[j.id].status,'cancelled');assert.equal(h.generations(),0);assert.equal(h.posted.length,1);
});
test('previously refused mail-content correction keeps its ACK and cancelled state until explicit recovery',async()=>{
 const h=await harness();const j=await h.enqueue('rewrite-cancelled',REWRITE_DRAFT);
 await h.service.change(s=>{j.status='cancelled';j.phase='refused';j.mode='refused';j.command.kind='refused';j.command.reasons=['mention người khác trong comment'];s.commands['rewrite-cancelled'].kind='refused';});
 const ack=structuredClone(j.ack);
 await h.restart();await h.enqueue('rewrite-cancelled',REWRITE_DRAFT);await h.service.processOne();
 assert.equal(h.service.state.jobs[j.id].status,'cancelled');assert.deepEqual(h.service.state.jobs[j.id].ack,ack);
 assert.equal(h.generations(),0);assert.equal(h.posted.length,1);
});

function contextGet({truncated=false,slack=false,wrongAuthor=false}={}) {
 const command={id:ID,author:{memberId:wrongAuthor?'other':ANDREW_ID},createdAt:'2026-10-21T15:26:35Z',content:ORIGINAL};
 return async path=>{
  if(!path.includes('/actions?'))return {ticket:{id:'ticket',subject:'contact',appName:'JOY Loyalty',description:'full description',slackLink:slack?'https://slack.example/thread':null}};
  const page2=path.includes('cursor=next');
  if(truncated)return {actions:Array.from({length:100},(_,i)=>({...command,id:String(i)})),total:101};
  return page2?{actions:[{...command,id:'old',content:'Oldest critical fact',createdAt:'2026-10-20T00:00:00Z'}],total:2}:{actions:[command],nextCursor:'next',total:2};
 };
}
test('draft reads all comment pages and full linked Slack context without truncation',async()=>{
 let slackCalls=0;const slack=async()=>{slackCalls++;return {messages:Array.from({length:201},(_,i)=>({text:'msg-'+i})),latestAt:'now'};};
 const ctx=await readDraftContext('JOY', {commentId:ID},contextGet({slack:true}),slack);
 assert.equal(ctx.comments.length,2);assert.equal(ctx.comments[0].content,'Oldest critical fact');assert.equal(ctx.slack.messages.length,201);assert.equal(slackCalls,1);
 await readDraftContext('JOY',{commentId:ID},contextGet(),()=>{throw Error('no Slack link means no Slack read');});
});
for(const [caseName,text] of [['image',IMAGE_DRAFT],['video',VIDEO_DRAFT],['rewrite',REWRITE_DRAFT]]) test(`draft context revalidates a ${caseName}-reference command and rejects a newly added send request`,async()=>{
 const base=contextGet();
 const getFor=text=>async path=>{
  const data=await base(path);
  if(data.actions)data.actions=data.actions.map(a=>a.id===ID?{...a,content:text}:a);
  return data;
 };
 const command={commentId:ID,instruction:parseBotCommand(text).instruction};
 const context=await readDraftContext('JOY',command,getFor(text));
 assert.equal(context.command.content,text);
 await assert.rejects(readDraftContext('JOY',command,getFor(text+', rồi gửi luôn')),/no longer draft/);
});
test('truncated thread, missing command author or Slack failure prevents draft',async()=>{
 await assert.rejects(readDraftContext('JOY',{commentId:ID},contextGet({truncated:true})),/incomplete/);
 await assert.rejects(readDraftContext('JOY',{commentId:ID},contextGet({wrongAuthor:true})),/author/);
 await assert.rejects(readDraftContext('JOY',{commentId:ID},contextGet({slack:true}),async()=>{throw Error('Slack failed');}),/Slack failed/);
});
test('generator uses full evidence, no analysis pipeline; invalid output and blockers fail closed',async()=>{
 const root=await mkdtemp(join(tmpdir(),'draft-generation-test-'));const job={reference:'JOY',ticketId:'ticket',command:{commentId:ID}};
 let seen;
 const opts={job,root,jobDir:root,get:contextGet(),codex:async input=>{seen=input;return {last:{body:BODY,blocker:''}};}};
 const r=await generateDraft(opts);assert.match(r.comment,/^\[DRAFT/);assert.match(seen.prompt,/Oldest critical fact/);assert.match(seen.prompt,/new explicit Andrew update/);assert.equal(seen.serverEnv,undefined);
 for(const response of [{last:{body:BODY,blocker:'unclear'}},{last:{body:'',blocker:''}},{failure:{message:'private'},last:null},{last:{body:BODY}}]) await assert.rejects(generateDraft({...opts,codex:async()=>response}));
});
test('existing dev draft format unchanged; command draft rejects internal wrappers/secrets',()=>{
 assert.match(formatDraftComment('done','2026-10-21',BODY,undefined,'JOY Loyalty'),/Slack update: 2026-10-21/);
 for(const body of ['','Hancal confirmed','[DRAFT] hi','token=abcdefghijklmnop'])assert.throws(()=>commandDraftComment(body,ID,'JOY Loyalty'));
 assert.throws(()=>commandDraftComment(BODY,'bad\nID'));
});

test('shared Slack reader paginates and rejects missing root/replies or has_more without cursor',async()=>{
 const {loadSlackThread}=await import('../../dev-fix-follow/scripts/adapters.mjs');
 const link='https://avada.slack.com/archives/C123/p1761050000000000';
 const parent={ts:'1761050000.000000',text:'parent',reply_count:2};
 const replies=[{ts:'1761050001.000000',text:'BA detail'},{ts:'1761050002.000000',text:'tester detail'}];
 let calls=0;
 const thread=await loadSlackThread(link,{token:'fixture-token',users:async()=>({}),api:async(method,query)=>{calls++;return query.cursor?{messages:replies,response_metadata:{}}:{messages:[parent],has_more:true,response_metadata:{next_cursor:'next'}};}});
 assert.equal(thread.messages.length,3);assert.equal(calls,2);assert.equal(thread.messages.at(-1).text,'tester detail');
 for(const data of [{messages:[parent]}, {messages:[parent],has_more:true},{messages:replies}])await assert.rejects(loadSlackThread(link,{token:'fixture-token',users:async()=>({}),api:async()=>data}),/thiếu|còn trang/);
});
test('drafts never masquerade as a previous review and history labels drafts as unsent',async()=>{
 const {followUpWindow}=await import('./bot-command.mjs');const {conversationFromJob}=await import('./history.mjs');
 const draft={id:'cmd-x',ticketId:'ticket',reference:'JOY-test',mode:'draft',trigger:'bot_command',status:'done',createdAt:'2026-10-21T15:00:00Z',finishedAt:'2026-10-21T15:01:00Z',comment:commandDraftComment(BODY,'x','JOY Loyalty')};
 assert.equal(followUpWindow({jobs:{draft},ticketId:'ticket',commentAt:'2026-10-21T15:02:00Z'}).previousJobId,null);
 const text=conversationFromJob(draft).messages.at(-1).text;assert.match(text,/mail nháp/);assert.match(text,/chưa gửi email/);assert.doesNotMatch(text,/check xong/);
});
test('ready draft survives restart without regenerating and posting-phase recovery reconciles',async()=>{
 const h=await harness();const j=await h.enqueue();
 await h.service.change(()=>{j.comment=commandDraftComment(BODY,ID,'JOY Loyalty');j.status='ready';j.mode='draft';j.phase='draft';});
 await h.restart();await h.service.processOne();assert.equal(h.generations(),0);assert.equal(h.posted.length,2);assert.equal(h.service.state.jobs[j.id].status,'done');
 const h2=await harness();const j2=await h2.enqueue();
 await h2.service.change(()=>{j2.comment=commandDraftComment(BODY,ID,'JOY Loyalty');j2.status='posting';j2.phase='comment';});
 h2.comments.push({id:'saved-before-crash',createdAt:new Date(h2.opts.now()).toISOString(),author:{memberId:ANDREW_ID},metadata:{content:j2.comment}});
 await h2.restart();await h2.service.processOne();assert.equal(h2.service.state.jobs[j2.id].status,'done');assert.equal(h2.posted.length,1);assert.equal(h2.generations(),0);
});
test('ambiguous ACK saved before restart reconciles once and draft proceeds with that ACK',async()=>{
 const h=await harness({ackUncertain:true});const j=await h.enqueue();assert.equal(j.ack.status,'uncertain');
 h.comments.push({id:'ack-recovered',createdAt:new Date(h.opts.now()).toISOString(),author:{memberId:ANDREW_ID},metadata:{content:CHECK_ACK}});
 h.tick();await h.restart();await h.service.processOne();const recovered=h.service.state.jobs[j.id];assert.equal(recovered.ack.commentId,'ack-recovered');assert.equal(recovered.status,'done');assert.equal(h.posted.length,2);
});

test('draft comment cannot trigger a new @han command while POST receipt is still uncertain',async()=>{
 const {findBotCommands}=await import('./bot-command.mjs');
 const content=commandDraftComment(BODY,ID,'JOY Loyalty');
 const commands=findBotCommands([{id:'unknown-receipt',type:'commentTicket',createdAt:'2026-10-21T15:30:00Z',author:{memberId:ANDREW_ID},metadata:{content}}],{authorId:ANDREW_ID,since:'2026-10-21T15:00:00Z'});
 assert.deepEqual(commands,[]);
});

test('edited command is revalidated before generation and cannot gain send authority',async()=>{
 const get=contextGet();
 const edited=async path=>{const d=await get(path);if(d.actions)for(const a of d.actions)if(a.id===ID)a.content='@han gửi email cho khách';return d;};
 await assert.rejects(readDraftContext('JOY',{commentId:ID},edited),/no longer draft/);
 await assert.rejects(readDraftContext('JOY',{commentId:ID,instruction:'soạn một mail khác'},get),/changed/);
});
test('generator uses actual ticket appName to replace a model greeting for the wrong app',async()=>{
 const root=await mkdtemp(join(tmpdir(),'draft-app-'));const getBase=contextGet();
 const get=async path=>{const d=await getBase(path);if(d.ticket)d.ticket.appName='Air Reviews';return d;};
 const job={reference:'JOY',ticketId:'ticket',command:{commentId:ID}};
 const draft=await generateDraft({job,root,jobDir:root,get,codex:async()=>({last:{body:'I am Andrew from the Loyalty technical support team, and I hope this email finds you well\n\nThe requested change is ready.\n\nBest regards,\nAndrew, Joy Technical Support Team',blocker:''}})});
 assert.equal(draft.appName,'Air Reviews');assert.match(draft.comment,/Air Reviews technical support team/);assert.match(draft.comment,/Andrew, Air Reviews Technical Support Team$/);assert.doesNotMatch(draft.comment,/Loyalty|Joy Technical/);
 let modelCalled=false;
 const unknown=async path=>{const d=await getBase(path);if(d.ticket)d.ticket.appName='Unverified App';return d;};
 await assert.rejects(generateDraft({job,root,jobDir:root,get:unknown,codex:async()=>{modelCalled=true;}}),/verified known ticket appName/);assert.equal(modelCalled,false);
});
