import { hanFixture } from './fixtures/han-report.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { executeReview, DEMO_FALLBACK, withinDeadline } from '../skills/check-ticket/scripts/core.mjs';
import { runCommand, browserMcpOverrides } from '../skills/check-ticket/scripts/worker.mjs';
import { TicketReviewService } from '../skills/check-ticket/scripts/service.mjs';
import { postComment, findPostedComment, readEvidence, ANDREW_ID, settings, createIO, jobTraceEmitter, safeReason } from '../skills/check-ticket/scripts/adapters.mjs';
import { formatReviewComment } from '../skills/check-ticket/scripts/handoff.mjs';
import { formatOriginalAnswer } from '../skills/check-ticket/scripts/report-content.mjs';
import { splitTelegramText } from '../skills/check-ticket/scripts/notifications.mjs';
import { CHECK_ACK } from '../skills/check-ticket/scripts/bot-command.mjs';
import { CHAT_TEMPLATES } from '../skills/check-ticket/scripts/bot-reply.mjs';

const limits={eliteTimeoutMs:200,classificationTimeoutMs:200,branchTimeoutMs:200,demoTimeoutMs:200};
const result=(category='Question',extra={})=>({category,canCustomize:null,bugType:'unknown',browserCheck:'none',verificationNotes:'',reason:'evidence',comment:'Cần kiểm tra cấu hình ứng dụng.',css:'',storefrontUrl:'',verified:false,screenshotPath:'',screenshotVerified:false,...extra});
function flow(category,extra={}) {
  const calls=[];const saved={};let closed=0;
  const initial=result(category,extra);
  const io={progress:async()=>{},elite:async target=>{calls.push(['elite',target]);return initial.comment;},evidence:async()=>({id:'internal',subject:'Ticket'}),
    worker:async phase=>{calls.push([phase]);return {...initial,...(phase==='classify'?{}:{verified:true})};},
    browser:async()=>{calls.push(['browser']);return {info:{endpoint:'test'},close:async()=>{closed++;}};},
    demoAvailable:async()=>false,upload:async()=>{calls.push(['upload']);return 'https://demo.test/image';},save:async(name,data)=>{saved[name]=data;}};
  return {io,calls,saved,initial,closed:()=>closed};
}

test('full-report fallback preserves category, evidence and caveats under the TS wrapper for every category', async () => {
  for (const category of ['Customize','Bug','Feature request','Question']) {
    const full=hanFixture('Han đề xuất kiểm tra `enabled=false`; Han chưa xác nhận nguyên nhân.',category);
    const h=flow(category,{comment:full.fullReport});
    h.io.worker=async phase=>{ if(phase==='classify') return h.initial; throw new Error('fixture branch unavailable'); };
    const review=await executeReview('CB-fixture',h.io,limits);
    assert.equal(review.comment,full.comment); assert.equal(review.fullReport,full.fullReport);
    assert.equal(review.category,category); assert.deepEqual(h.saved['report.json'],full.report);
    assert.equal(h.saved['comment.txt'],full.comment); assert.equal(h.saved['report.md'],full.fullReport);
    assert.ok(review.audit.some(a=>a.status==='elite_fallback'));
  }
});

test('manual and follow-up hancal previews derive only from the matching full report and persist both artifacts', async () => {
  for (const followUp of [null,{instruction:'check tiếp phản hồi mới',commentId:'new-comment'}]) {
    const full=hanFixture(followUp?'Theo phản hồi mới, Han chưa xác nhận `save=true`.':'Han đề xuất kiểm tra `save=false`; chưa thực hiện thay đổi.','Bug');
    const saved={}; let seen;
    const io={hancal:async(target,context,follow)=>{seen=follow;return {status:'ok',ticketId:'ticket-fixture',runId:'run-fixture',category:'Bug',writer:{body:full.fullReport},counts:{},verified:{}};},save:async(name,data)=>saved[name]=data};
    const review=await executeReview('CB-fixture',io,{...limits,analysis:'hancal',hancalTimeoutMs:500},{followUp});
    assert.equal(seen,followUp); assert.equal(review.comment,full.comment); assert.equal(review.fullReport,full.fullReport);
    assert.equal(review.ticketId,'ticket-fixture'); assert.equal(review.hancal.runId,'run-fixture');
    assert.equal(saved['comment.txt'],full.comment); assert.deepEqual(saved['report.json'],full.report);
  }
});

test('Formatting preserves every original detail and exact code while dropping only the source appendix',()=>{
  const code='```liquid\n{{ card_product.metafields.air_reviews_product.review_avg }}\n# Sources\n**keep these literal markers**\n```';
  const original='**Kết luận**\n\nChờ collab code từ merchant.\n\n**Trạng thái:**\n- Aria đã xin lúc 09:34.\n- Avery xác nhận lúc 09:37.\n\n1. Thêm snippet; chưa thực hiện.\n2. Reset 5/11 → 11/11 webhooks sau khi có xác nhận.\n\n'+code+'\n\nGiữ `**literal**` và điều kiện ít nhất 1 approved review.\n\n---\n\n**Sources**\n- Nguồn nội bộ\n\n⚠️ **Citation audit (harness):** kiểm tra nguồn';
  const expected='Kết luận\n\nChờ collab code từ merchant.\n\nTrạng thái:\n- Aria đã xin lúc 09:34.\n- Avery xác nhận lúc 09:37.\n\n1. Thêm snippet; chưa thực hiện.\n2. Reset 5/11 → 11/11 webhooks sau khi có xác nhận.\n\n'+code+'\n\nGiữ `**literal**` và điều kiện ít nhất 1 approved review.';
  assert.equal(formatOriginalAnswer(original),expected);
  assert(formatOriginalAnswer(original,{includeInternalSections:true}).includes('Nguồn nội bộ'));
});

test('All categories use the concise worker report, preserve the raw answer and fall back to the saved summary',async()=>{
  const source='**Trạng thái**\n\nAria đã xin quyền lúc 09:34; Avery xác nhận đang chờ quyền lúc 09:37. '+
    'Hiện tại ticket vẫn đang chờ quyền theme để hỗ trợ merchant. Sau khi có quyền mới thực hiện các bước tiếp theo. '+
    'Cần ít nhất 1 approved review để sao hiển thị. Reset 6 webhook thiếu chỉ sau khi có xác nhận; thao tác này chưa thực hiện. '+
    'Nhắc lại: cần đợi merchant cung cấp quyền theme trước khi tiến hành xử lý ticket.';
  const summary='Chờ quyền theme: Aria xin 09:34, Avery xác nhận 09:37. Cần 1 approved review; chưa reset 6 webhook thiếu, phải có xác nhận trước.';
  for(const [category,extra] of [['Bug',{bugType:'logic_internal'}],['Question',{}],['Feature request',{}],['Customize',{canCustomize:false}]]) {
    for(const fail of [false,true]) {
      const h=flow(category,extra);h.io.elite=async()=>source;
      h.io.worker=async phase=>{
        if(fail&&phase!=='classify')throw Error('branch unavailable');
        return {...h.initial,comment:summary};
      };
      const r=await executeReview('TEST-summary',h.io,limits);
      assert.equal(r.comment,formatReviewComment(summary,category));
      assert(r.comment.length<=Math.floor(source.length*0.7));
      assert.equal(h.saved['elite.txt'],source);
      assert.equal(h.saved['elite-fallback.json'].comment,summary);
    }
  }
});

test('Question and feature request route to their skills without browser or posting',async()=>{
  for(const [category,phase] of [['Question','question'],['Feature request','feature-request']]) {
    const h=flow(category);const review=await executeReview('CB-260917-test',h.io,limits);
    assert.equal(review.category,category);assert(h.calls.some(c=>c[0]===phase));assert(!h.calls.some(c=>c[0]==='browser'));
    assert.equal(h.calls[0][1].url,'https://helpdesk.avada.net/tickets/CB-260917-test');assert(h.saved['elite-fallback.json']);
  }
});

test('Every category makes exactly one Elite request before producing its report',async()=>{
  for(const [category,extra] of [['Bug',{bugType:'logic_theme'}],['Question',{}],['Feature request',{}],['Customize',{canCustomize:true}],['Customize',{canCustomize:false}]]) {
    const h=flow(category,extra);
    await executeReview('TEST-once',h.io,limits,{publishDemo:true});
    assert.equal(h.calls.filter(call=>call[0]==='elite').length,1);
    assert.equal(h.saved['elite.txt'],h.initial.comment);
    assert(h.saved['comment.txt']);
  }
});

test('Customize preserves tested CSS when uploader is missing, with exact fallback',async()=>{
  const h=flow('Customize',{canCustomize:true,css:'.old {}'});
  h.io.worker=async phase=>phase==='classify'?h.initial:result('Customize',{canCustomize:true,verified:true,css:'.tested {color:red}',comment:'Đã kiểm tra bố cục trực tiếp.'});
  const r=await executeReview('CB-260917-test',h.io,limits,{publishDemo:true});
  assert.match(r.comment,/\.tested/);assert(r.comment.endsWith(DEMO_FALLBACK));assert.equal(h.closed(),1);assert(!h.calls.some(c=>c[0]==='upload'));
});

test('Customize deadline aborts work and uses only stored Elite CSS, never partial worker CSS',async()=>{
  const h=flow('Customize',{canCustomize:true,css:'.elite {}'});let aborted=false;
  h.io.worker=async(phase,data,{signal})=>{
    if(phase==='classify')return h.initial;
    return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>{aborted=true;reject(signal.reason);},{once:true}));
  };
  const r=await executeReview('CB-260917-test',h.io,{...limits,branchTimeoutMs:15},{publishDemo:true});
  assert(aborted);assert.equal(r.result.verified,false);assert.match(r.comment,/\.elite/);assert(r.audit.some(a=>a.phase==='customize'&&a.status==='timeout'));assert.equal(h.closed(),1);
});

test('Unfeasible Customize investigates reasons without a browser or demo',async()=>{
  const h=flow('Customize',{canCustomize:false});const r=await executeReview('CB-260917-test',h.io,limits,{publishDemo:true});
  assert(h.calls.some(c=>c[0]==='customize-feasibility'));assert(!h.calls.some(c=>c[0]==='browser'));assert(!r.comment.includes(DEMO_FALLBACK));
});

test('Bug subtypes route theme failures to MCP and keep internal/unknown bugs summary-only',async()=>{
  for(const bugType of ['ui_theme','logic_theme','logic_internal','unknown']) {
    const h=flow('Bug',{bugType});await executeReview('CB-260917-test',h.io,limits);
    assert.deepEqual(h.calls.map(c=>c[0]),['elite','classify',['ui_theme','logic_theme'].includes(bugType)?'bug-browser':'bug-report']);
  }
});

test('Reported storefront errors and missing blocks select MCP even without a theme subtype',async()=>{
  for(const browserCheck of ['storefront','error_code','block_missing']) {
    const h=flow('Bug',{browserCheck});
    await executeReview('CB-test',h.io,limits);
    assert.deepEqual(h.calls.map(c=>c[0]),['elite','classify','bug-browser']);
  }
});

test('Internal-only app scope overrides generic error/block routing and never starts MCP',async()=>{
  for(const browserCheck of ['none','storefront','error_code','block_missing']) {
    const h=flow('Bug',{bugType:'logic_internal',browserCheck});
    await executeReview('APP-test',h.io,limits);
    assert.deepEqual(h.calls.map(c=>c[0]),['elite','classify','bug-report']);
  }
});

test('Bug MCP observations are separate from the initial explanation, with no demo or CSS',async()=>{
  const original='Nguyên nhân có thể do cấu hình theme; chưa đủ dữ liệu để kết luận.';
  const notes='https://shop.test/pages/faq: block không hiển thị ở desktop; chưa kiểm tra mobile.';
  const h=flow('Bug',{bugType:'logic_theme',comment:original});
  h.io.worker=async(phase,data)=>{
    h.calls.push([phase]);
    if(phase==='classify')return h.initial;
    assert.equal(phase,'bug-browser');assert.equal(data.evidence.id,'internal');
    return {...h.initial,verified:true,verificationNotes:notes,css:'.unwanted {}',screenshotPath:'/unwanted.png',screenshotVerified:true};
  };
  const r=await executeReview('CB-test',h.io,limits,{publishDemo:true});
  assert.equal(r.result.verified,true);
  assert.equal(r.comment,formatReviewComment(original+'\n\n'+notes,'Bug'));
  assert.equal(r.result.css,'');assert.equal(r.result.screenshotPath,'');assert.equal(r.result.screenshotVerified,false);
  assert.deepEqual(h.calls.map(c=>c[0]),['elite','classify','bug-browser']);
});

test('MCP unavailability, incomplete verification or deadline keep the saved unverified fallback',async()=>{
  for(const mode of ['failure','incomplete','missing-observations','timeout']) {
    const h=flow('Bug',{bugType:'ui_theme'});let aborted=false;
    h.io.worker=async(phase,data,{signal})=>{
      h.calls.push([phase]);if(phase==='classify')return h.initial;
      if(mode==='failure')throw Error('MCP unavailable');
      if(mode==='timeout')return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>{aborted=true;reject(signal.reason);},{once:true}));
      return {...h.initial,verified:mode==='missing-observations',verificationNotes:mode==='incomplete'?'Partial, unverified observation':''};
    };
    const r=await executeReview('CB-test',h.io,{...limits,branchTimeoutMs:20});
    assert.equal(r.comment,formatReviewComment(h.initial.comment,h.initial.category));assert.equal(r.result.verified,false);assert.equal(r.result.verificationNotes,'');
    assert.equal(h.calls.filter(c=>c[0]==='elite').length,1);assert(r.audit.some(a=>a.phase==='bug-browser'&&a.status==='elite_fallback'));
    if(mode==='timeout')assert(aborted);
  }
});

test('Explicit bug and mixed storefront reports use MCP even when classified as Question',async()=>{
  for(const subject of ['[bug] Block không show', 'Sync trong app và block storefront không show']) {
    const h=flow('Question',{browserCheck:'block_missing'});
    h.io.evidence=async()=>({id:'internal',subject});
    await executeReview('CHAT-test',h.io,limits);
    assert.deepEqual(h.calls.map(c=>c[0]),['elite','classify','bug-browser']);
  }
});

test('Worker exposes isolated MCP only to the qualifying bug phase',()=>{
  for(const phase of ['classify','bug-report','question','feature-request','customize-feasibility','customize','demo']) {
    assert.deepEqual(browserMcpOverrides(phase,'/tmp/review'),['-c','mcp_servers.playwright.enabled=false']);
  }
  const args=browserMcpOverrides('bug-browser','/tmp/review path','/installed/mcp/cli.js');
  assert(args.includes('mcp_servers.playwright.enabled=true'));
  const mcpArgs=JSON.parse(args.find(a=>a.startsWith('mcp_servers.playwright.args=')).split('=',2)[1]);
  assert(mcpArgs.includes('--isolated'));assert(mcpArgs.includes('--headless'));assert(mcpArgs.includes('/tmp/review path/screenshots'));
  assert(!mcpArgs.includes('--extension'));assert(!mcpArgs.includes('--cdp-endpoint'));
});

test('Internal bugs synthesize only the original answer and never invent verification',async()=>{
  const h=flow('Bug',{bugType:'logic_internal'});const messages=[];const workers=[];
  h.io.elite=async(_,{message})=>{messages.push(message);if(messages.length>1)throw Error('Unexpected second Elite request');return 'Kết quả kiểm tra ban đầu.';};
  h.io.worker=async(phase,data)=>{
    workers.push(phase);
    if(phase==='classify')return h.initial;
    assert.equal(data.elite,'Kết quả kiểm tra ban đầu.');assert.equal(data.evidence,undefined);assert.equal(data.browser,undefined);
    return {...h.initial,comment:'Nguyên nhân chưa được xác minh.',verified:true,screenshotVerified:true,screenshotPath:'/untrusted.png',css:'.untrusted {}'};
  };
  const r=await executeReview('JSUB-test',h.io,limits);
  assert.equal(messages.length,1);assert.equal(messages[0],undefined);
  assert.deepEqual(workers,['classify','bug-report']);
  assert.equal(h.saved['elite.txt'],'Kết quả kiểm tra ban đầu.');
  assert.equal(r.result.verified,false);assert.equal(r.result.screenshotVerified,false);
  assert.equal(r.result.screenshotPath,'');assert.equal(r.result.css,'');
  assert(!h.calls.some(c=>['browser','upload'].includes(c[0])));
});

test('Explicit bug title synthesizes the same single answer even when classified as Question',async()=>{
  const h=flow('Question');const phases=[];const messages=[];
  h.io.evidence=async()=>({id:'internal',subject:'[bug] Sync pages and FAQ warning',description:'Two issues need explanation.'});
  h.io.elite=async(_,context)=>{messages.push(context.message);return 'Kết quả kiểm tra ban đầu.';};
  h.io.worker=async phase=>{phases.push(phase);return h.initial;};
  const review=await executeReview('CHAT-test',h.io,limits);
  assert.deepEqual(phases,['classify','bug-report']);assert.equal(messages.length,1);
  assert.equal(review.category,'Question');assert(!h.calls.some(c=>c[0]==='browser'));
});

test('Bug synthesis failure or timeout uses saved fallback without asking Elite again',async()=>{
  for(const mode of ['failure','timeout']) {
    const h=flow('Bug',{bugType:'logic_internal'});let calls=0;let aborted=false;const phases=[];
    h.io.elite=async()=>{calls++;return h.initial.comment;};
    h.io.worker=async(phase,data,{signal})=>{
      phases.push(phase);if(phase==='classify')return h.initial;
      if(mode==='timeout')return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>{aborted=true;reject(signal.reason);},{once:true}));
      throw Error('synthesis failed');
    };
    const r=await executeReview('JSUB-test',h.io,{...limits,eliteTimeoutMs:15,branchTimeoutMs:40});
    assert.equal(r.comment,formatReviewComment(h.initial.comment,h.initial.category));assert.equal(calls,1);
    assert.doesNotMatch(r.comment,/Elite/i);
    assert.equal(r.result.verified,false);assert(r.audit.some(a=>a.status==='elite_fallback'));
    assert(!phases.includes('bug-diagnosis'));assert(!h.calls.some(c=>c[0]==='browser'));
    if(mode==='timeout')assert(aborted);
  }
});

test('Elite adapter always sends the exact check request without enrichment or custom follow-ups',async t=>{
  const dir=await mkdtemp(resolve(tmpdir(),'ticket-elite-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const requests=[];
  t.mock.method(globalThis,'fetch',async(url,options)=>{requests.push({url,...JSON.parse(options.body)});return {ok:true,json:async()=>({answer:'Elite answer'})};});
  const io=await createIO(dir);const target={reference:'JSUB-test',url:'https://helpdesk.avada.net/tickets/JSUB-test'};
  await io.elite(target,{});await io.elite(target,{message:'Detailed internal bug request'});
  assert.equal(requests[0].message,'Check ticket '+target.url);assert.equal(requests[1].message,'Check ticket '+target.url);
  assert(requests.every(r=>r.summaryOnly===true&&r.ticketId==='JSUB-test'));
});

test('Demo and upload share one deadline, timeout keeps verified CSS and omits URL',async()=>{
  const h=flow('Customize',{canCustomize:true,css:'.ok {}'});h.io.demoAvailable=async()=>true;
  h.io.worker=async phase=>({...h.initial,verified:phase!=='classify',screenshotPath:phase==='demo'?'/demo.png':'',screenshotVerified:phase==='demo'});
  h.io.upload=async(_,{signal})=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
  const r=await executeReview('CB-260917-test',h.io,{...limits,demoTimeoutMs:15},{publishDemo:true});
  assert.equal(r.result.verified,true);assert.equal(r.demoUrl,'');assert(r.comment.includes(DEMO_FALLBACK));assert(r.audit.some(a=>a.phase==='demo'&&a.status==='timeout'));
});

test('Preview never requests capture/upload even if configured',async()=>{
  const h=flow('Customize',{canCustomize:true});h.io.demoAvailable=async()=>{throw Error('Unexpected upload check');};
  await executeReview('CB-260917-test',h.io,limits,{publishDemo:false});assert(!h.calls.some(c=>c[0]==='demo'));
});

test('Elite/classifier failure prevents branch work and cannot produce a comment',async()=>{
  const h=flow('Question');h.io.elite=async()=>{throw Error('offline');};
  await assert.rejects(executeReview('CB-260917-test',h.io,limits),/offline/);assert.equal(h.calls.length,0);
  h.io.elite=async()=>'elite';h.io.worker=async()=>({category:'bogus'});
  await assert.rejects(executeReview('CB-260917-test',h.io,limits),/invalid/);
});

test('Reports containing provider attribution cannot reach preview or Helpdesk writes',async()=>{
  for(const name of ['TS Elite 2','TS Elite','Elite','TS-ELITE-2']) {
    const h=flow('Bug',{bugType:'logic_internal',comment:`Theo ${name}, nguyên nhân chưa được xác minh.`});
    await assert.rejects(executeReview('JSUB-test',h.io,limits),/must not mention/);
    assert.equal(h.saved['comment.txt'],undefined);
    let requests=0;
    await assert.rejects(postComment('ticket',h.initial.comment,async()=>{requests++;}),/must not mention/);
    assert.equal(requests,0);
  }
});

test('Deadline stops a real child process and its descendants',async t=>{
  const dir=await mkdtemp(resolve(tmpdir(),'ticket-kill-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const marker=resolve(dir,'late-write');
  const child=`const {spawn}=require('node:child_process');spawn(process.execPath,['-e',${JSON.stringify(`setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},'bad'),1500)`)}],{stdio:'ignore'});setInterval(()=>{},10000);`;
  await assert.rejects(withinDeadline('process',100,({signal})=>runCommand(process.execPath,['-e',child],{signal})),/Deadline/);
  await new Promise(r=>setTimeout(r,1600));await assert.rejects(readFile(marker),{code:'ENOENT'});
});

async function queue(t) {
  const root=await mkdtemp(resolve(tmpdir(),'ticket-queue-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const input={tickets:[{id:'old',ticketId:'CB-260917-old',memberIds:[ANDREW_ID]}],notifications:[],posted:[],comments:[],reviews:0,time:Date.parse('2026-09-18T00:00:00Z')};
  const config={enabled:true,maxAttempts:3,pollIntervalMs:300000,queueIntervalMs:10000,...limits};
  const get=async path=>{
    if(path.startsWith('/members?'))return {members:[{id:ANDREW_ID,displayName:input.andrewName || 'Andrew',role:'TS'},...(input.members || [])]};
    if(path.startsWith('/tickets?'))return {tickets:input.tickets,total:input.tickets.length};
    if(path.startsWith('/notifications?'))return {notifications:input.notifications};
    if(path.startsWith('/tickets/'))return {ticket:input.tickets.find(t=>t.id===decodeURIComponent(path.slice(9))||t.ticketId===decodeURIComponent(path.slice(9)))};
    throw Error('Unexpected get');
  };
  const opts={root,statePath:resolve(root,'state.json'),config,get,now:()=>input.time,
    review:async reference=>{input.reviews++;const ticket=input.tickets.find(t=>t.ticketId===reference);return {ticketId:ticket.id,category:'Question',...hanFixture('Kết quả cho '+reference)};},
    post:async(id,comment)=>{input.posted.push({id,comment});input.comments.push({id:'comment',ticketId:id,content:comment});},
    find:async(id,comment)=>input.comments.find(c=>c.ticketId===id&&c.content===comment),};
  const service=new TicketReviewService(opts);await service.initialize();input.time+=1000;
  return {root,input,opts,service};
}
const newTicket=(id='new')=>({id,ticketId:'CB-260918-'+id,memberIds:[ANDREW_ID]});
const notification=(id,type,ticketId)=>({id,type,userId:ANDREW_ID,createdAt:'2026-09-18T00:00:00.500Z',metadata:{ticketId}});

test('Baseline ignores old tickets; creation plus assignment plus roster produces one comment',async t=>{
  const h=await queue(t);await h.service.scan();assert.equal(Object.keys(h.service.state.jobs).length,0);
  h.input.tickets.push(newTicket());h.input.time+=1000;
  h.input.notifications=[{...notification('a','ticket_created','new'),createdAt:'2026-09-18T00:00:01.500Z'},{...notification('b','ticket_assigned','new'),createdAt:'2026-09-18T00:00:01.600Z'}];
  await Promise.all([h.service.scan(),h.service.scan()]);assert.equal(Object.keys(h.service.state.jobs).length,1);
  await Promise.all([h.service.processOne(),h.service.processOne()]);assert.equal(h.input.reviews,1);assert.equal(h.input.posted.length,1);assert.equal(h.service.state.jobs.new.status,'done');
  await h.service.scan();await h.service.processOne();assert.equal(h.input.posted.length,1);
});

test('New Andrew roster membership triggers even without notifications; unrelated member does not',async t=>{
  const h=await queue(t);h.input.tickets.push(newTicket(),{...newTicket('other'),memberIds:['someone-else']});
  await h.service.scan();assert.deepEqual(Object.keys(h.service.state.jobs),['new']);
});

test('Wrong recipient assignment and unrelated notification types do not enqueue',async t=>{
  const h=await queue(t);h.input.notifications=[{...notification('a','ticket_assigned','old'),userId:'someone-else'},notification('b','ticket_commented','old')];
  await h.service.scan();assert.deepEqual(Object.keys(h.service.state.jobs),[]);
});

test('Assignment removed while queued cancels the automatic review before posting',async t=>{
  const h=await queue(t);h.input.tickets.push(newTicket());await h.service.scan();
  h.input.tickets[1].memberIds=[];await h.service.processOne();
  assert.equal(h.service.state.jobs.new.status,'cancelled');assert.equal(h.input.reviews,0);assert.equal(h.input.posted.length,0);
});

test('Delivery read failures have a bounded retry limit without rerunning AI',async t=>{
  const h=await queue(t);h.input.tickets.push(newTicket());await h.service.scan();
  h.service.find=async()=>{throw Error('read unavailable');};
  for(let i=0;i<3;i++){await h.service.processOne();h.input.time+=600000;}
  assert.equal(h.service.state.jobs.new.status,'needs_attention');assert.equal(h.input.reviews,1);assert.equal(h.input.posted.length,0);
});

test('OS timeout bounds a subprocess independently of JavaScript abort',async()=>{
  await assert.rejects(runCommand('timeout',['--signal=TERM','--kill-after=1s','0.1s',process.execPath,'-e','setInterval(()=>{},1000)']),/unsuccessfully/);
});

test('Lost POST response reconciles the saved comment and never reposts',async t=>{
  const h=await queue(t);h.input.tickets.push(newTicket());await h.service.scan();
  h.service.post=async(id,comment)=>{h.input.posted.push({id,comment});h.input.comments.push({id:'saved',ticketId:id,content:comment});throw Error('lost response');};
  await h.service.processOne();assert.equal(h.service.state.jobs.new.status,'uncertain');
  const resumed=new TicketReviewService(h.opts);await resumed.initialize();await resumed.processOne();
  assert.equal(resumed.state.jobs.new.status,'done');assert.equal(h.input.posted.length,1);
});

test('Unknown delivery absent from server stops for attention instead of duplicating',async t=>{
  const h=await queue(t);h.input.tickets.push(newTicket());await h.service.scan();
  h.service.post=async()=>{throw Error('timeout');};await h.service.processOne();await h.service.processOne();
  assert.equal(h.service.state.jobs.new.status,'needs_attention');assert.equal(h.input.reviews,1);
});

for(const committed of [false,true]) test(`safe delivery diagnostics survive restart and reconciliation (committed=${committed})`,async t=>{
 const h=await queue(t);const events=[];h.service.trace=()=>(kind,text,extra)=>events.push({kind,text,...extra});
 h.input.tickets.push(newTicket());await h.service.scan();let posts=0;
 h.service.post=async(id,content)=>{
  posts++;if(committed)h.input.comments.push({id:'saved',ticketId:id,content});
  throw Object.assign(Error('Helpdesk POST outcome is unknown.'),{postAttempted:true,detail:{source:'helpdesk',method:'POST',endpoint:'/api/external/tickets/private-id/comments?token=private-secret',phase:'transport',errorCode:'ECONNRESET',httpStatus:null,elapsedMs:2500,reusedSocket:true,headers:{key:'private-secret'},message:'private-secret'}});
 };
 await h.service.processOne();const failed=h.service.state.jobs.new;
 assert.equal(failed.status,'uncertain');assert.equal(failed.deliveryErrors[0].errorCode,'ECONNRESET');assert.equal(failed.deliveryErrors[0].httpStatus,null);
 assert.equal(failed.deliveryErrors[0].endpoint,'/api/external/tickets/:id/comments');assert.equal(failed.deliveryErrors[0].postAttempted,true);
 assert(!JSON.stringify(failed).includes('private-secret'));assert(!JSON.stringify(events).includes('private-secret'));
 assert.equal(events.find(e=>e.kind==='warning').payload.detail.errorCode,'ECONNRESET');
 const resumed=new TicketReviewService({...h.opts,post:async()=>{posts++;throw Error('Must not repost');}});await resumed.initialize();await resumed.processOne();await resumed.processOne();
 assert.equal(resumed.state.jobs.new.status,committed?'done':'needs_attention');
 assert.deepEqual(resumed.state.jobs.new.deliveryErrors,failed.deliveryErrors);assert.equal(posts,1);assert.equal(h.input.reviews,1);
});

test('Restart during running work resumes safely; legacy notifier queue is not imported',async t=>{
  const h=await queue(t);h.input.tickets.push(newTicket());await h.service.scan();await h.service.change(s=>{s.jobs.new.status='running';});
  await mkdir(resolve(h.root,'runtime'),{recursive:true});await writeFile(resolve(h.root,'runtime/telegram-ticket-notifier-state.json'),JSON.stringify({autoTicketReviews:{ancient:{status:'queued'}}}));
  const resumed=new TicketReviewService(h.opts);await resumed.initialize();assert.equal(resumed.state.jobs.new.status,'queued');assert.equal(resumed.state.jobs.ancient,undefined);
  await resumed.processOne();assert.equal(h.input.posted.length,1);
});

test('Truncated assignment snapshot never silently drops old membership',async t=>{
  const h=await queue(t);const get=h.service.get;h.service.get=async path=>path.startsWith('/tickets?')?{tickets:[],total:19000}:get(path);
  await assert.rejects(h.service.scan(),/truncated/);assert.deepEqual(h.service.state.assignedTicketIds,['old']);
});

test('An inaccessible ticket cannot starve newer tickets and retries after cursor advancement and restart',async t=>{
  const h=await queue(t);let blocked=true;
  h.input.tickets.push(newTicket('denied'),newTicket('fresh'));
  h.input.notifications=[notification('a','ticket_created','denied'),notification('b','ticket_created','fresh')];
  const get=h.opts.get;
  h.opts.get=async path=>{if(blocked&&path==='/tickets/denied')throw Error('Helpdesk GET failed (HTTP 403).');return get(path);};
  h.service.get=h.opts.get;
  // Isolate notification discovery from the independent assigned roster.
  h.input.tickets[1].memberIds=[];h.input.tickets[2].memberIds=[];
  await h.service.scan();
  assert.deepEqual(Object.keys(h.service.state.jobs),['fresh']);
  assert.equal(h.service.health().pendingTicketEvents,1);
  assert.match(h.service.health().lastError,/403/);
  h.input.notifications=[];h.input.time+=300000;blocked=false;
  const resumed=new TicketReviewService(h.opts);await resumed.initialize();await resumed.scan();
  assert.deepEqual(Object.keys(resumed.state.jobs),['fresh','denied']);
  assert.equal(resumed.health().pendingTicketEvents,0);
});

test('Fresh connections baseline offline tickets but maintenance restarts preserve live notifications',async t=>{
  const h=await queue(t);
  h.input.tickets.push(newTicket('offline'),newTicket('live'));
  h.input.notifications=[notification('a','ticket_created','offline'),{...notification('b','ticket_created','live'),createdAt:'2026-09-18T00:00:03.000Z'}];
  const fresh=new TicketReviewService({...h.opts,sessionStartedAt:'2026-09-18T00:00:02.000Z'});
  await fresh.initialize();h.input.time+=5000;await fresh.scan();
  assert.deepEqual(Object.keys(fresh.state.jobs),['live']);
  h.input.tickets.push(newTicket('maintenance'));
  h.input.time+=1000;
  h.input.notifications=[{...notification('c','ticket_created','maintenance'),createdAt:new Date(h.input.time).toISOString()}];
  const resumed=new TicketReviewService({...h.opts,sessionStartedAt:'2026-09-18T00:00:10.000Z',resumeSession:true});
  await resumed.initialize();await resumed.scan();
  assert.deepEqual(Object.keys(resumed.state.jobs),['live','maintenance']);
});

test('Posting resolves current author by ID every time and refuses missing avatar',async()=>{
  const posts=[];let reads=0;
  const request=async(path,options)=>{if(path.startsWith('/members')){reads++;return {members:[{id:ANDREW_ID,displayName:'Andrew',photoURL:'https://example.test/current.png',secret:'never-copy'}]};}posts.push(options.body);return {};};
  await postComment('ticket','report',request);await postComment('ticket','report 2',request);
  assert.equal(reads,2);assert.deepEqual(posts[0].author,{memberId:ANDREW_ID,displayName:'Andrew',photoURL:'https://example.test/current.png'});
  let writes=0;await assert.rejects(postComment('ticket','report',async(path)=>{if(path.startsWith('/members'))return {members:[{id:ANDREW_ID,displayName:'Andrew'}]};writes++;}),/avatar/);assert.equal(writes,0);
});

test('Configured production deadlines cannot exceed five and two minutes',async()=>{
  const config=await settings();assert(config.branchTimeoutMs<=300000);assert(config.demoTimeoutMs<=120000);
});

test('Report wrapper uses the classified category, preserves code and removes old handoffs idempotently',()=>{
  const body='Đang chờ quyền theme.\n\n```liquid\n{{ product.title }}\n```';
  for(const category of ['Customize','Bug','Feature request','Question']) {
    const expected=`Sau khi TS check thì thấy như sau:\nĐây là loại ticket gì : ${category}\n\n${body}`;
    for(const ending of ['', '\n\nChờ @Andrew review kết quả', '\n\n@Andrew xem giúp hướng xử lý này ổn chưa nhé?', '\n\nNhờ @Old check lại và báo khách nhé ạ']) {
      const formatted=formatReviewComment(body+ending,category);
      assert.equal(formatted,expected);
      assert.equal(formatReviewComment(formatted,category),expected);
    }
    assert.equal(formatReviewComment(formatReviewComment(body,'Question'),category),expected);
  }
  assert.throws(()=>formatReviewComment(body,'Invented'),/category/);
  assert.throws(()=>formatReviewComment('', 'Bug'),/empty/);
});

test('Read-only evidence no longer fetches a recipient profile for an automatic mention',async()=>{
  const evidence=await readEvidence('ticket',async path=>{
    if(path.startsWith('/members?'))throw Error('Unexpected recipient profile lookup');
    if(path.includes('/actions?'))return {actions:[]};
    return {ticket:{id:'ticket',memberIds:['cs']}};
  });
  assert.equal(evidence.handoff,undefined);
  assert(!JSON.stringify(evidence).includes('never-copy'));
});

test('Fallback and successful reports include the category opening and no closing mention',async()=>{
  for(const fail of [false,true]) {
    const h=flow('Customize',{canCustomize:true,css:'.test {}'});
    h.io.evidence=async()=>({id:'internal'});
    if(fail)h.io.worker=async phase=>{if(phase==='classify')return h.initial;throw Error('unavailable');};
    const r=await executeReview('CB-test',h.io,limits);
    assert(r.comment.startsWith('Sau khi TS check thì thấy như sau:\nĐây là loại ticket gì : Customize\n\n'));assert(r.comment.endsWith(DEMO_FALLBACK));assert(!r.comment.includes('@Andrew'));
    assert.equal(h.saved['comment.txt'],r.comment);
  }
});

test('Posting sends structured mentions with current author and only public recipient fields',async()=>{
  let sent;
  await postComment('ticket','@Andrew xem giúp hướng xử lý này ổn chưa nhé?',async(path,options)=>{
    if(path.startsWith('/members'))return {members:[{id:ANDREW_ID,displayName:'Andrew',photoURL:'https://example.test/avatar.png'}]};
    sent=options.body;return {};
  },[{memberId:ANDREW_ID,displayName:'Andrew',secret:'never-copy'}]);
  assert.deepEqual(sent.mentions,[{memberId:ANDREW_ID,displayName:'Andrew'}]);assert.equal(sent.author.memberId,ANDREW_ID);
});

test('Service persists formatted report without an automatic mention before POST',async t=>{
  const h=await queue(t);h.input.members=[{id:'old-cs',displayName:'Old',role:'CS'},{id:'new-cs',displayName:'New',role:'CSR'}];
  h.input.tickets.push({...newTicket(),memberIds:[ANDREW_ID,'old-cs']});await h.service.scan();
  h.service.review=async()=>{
    h.input.tickets[1].memberIds=[ANDREW_ID,'new-cs'];
    h.input.andrewName='Andrew Current';
    return {ticketId:'new',category:'Question',...hanFixture('Báo cáo')};
  };
  h.service.post=async(id,comment,mentions)=>{
    const state=JSON.parse(await readFile(h.opts.statePath,'utf8'));
    assert.equal(state.jobs.new.comment,comment);assert.deepEqual(state.jobs.new.mentions,mentions);
    assert.deepEqual(mentions,[]);
    assert.equal(comment,hanFixture('Báo cáo').comment);
    assert.deepEqual(state.jobs.new.report,hanFixture('Báo cáo').report);
    h.input.comments.push({id:'sent',ticketId:id,content:comment});
  };
  await h.service.processOne();assert.equal(h.service.state.jobs.new.status,'done');
});

function enableNotices(h) {
  const sent=[];
  h.opts.notify=h.service.notify=async text=>{sent.push(text);return {messageId:sent.length};};
  return sent;
}

test('Automatic lifecycle sends receipt, checking, then exact confirmed report once across duplicate triggers and restart',async t=>{
  const h=await queue(t);const sent=enableNotices(h);const steps=[];
  h.opts.notify=h.service.notify=async text=>{sent.push(text);steps.push(text.slice(0,2));return {messageId:sent.length};};
  const review=h.service.review,post=h.service.post;
  h.service.review=async(...args)=>{assert.equal(sent.length,2);steps.push('review');return review(...args);};
  h.service.post=async(...args)=>{assert.equal(sent.length,2);steps.push('post');return post(...args);};
  h.input.tickets.push(newTicket());
  h.input.notifications=[notification('a','ticket_created','new'),notification('b','ticket_assigned','new')];
  await h.service.scan();await h.service.processOne();
  assert.equal(sent.length,3);assert.match(sent[0],/Đã nhận ticket/);assert.match(sent[1],/Hachimi đang checking/);
  assert.match(sent[2],/Hachimi đã check xong/);assert(sent[2].endsWith(h.input.posted[0].comment));
  assert(steps.indexOf('post')<steps.length-1);
  const resumed=new TicketReviewService(h.opts);await resumed.initialize();await resumed.scan();await resumed.processOne();
  assert.equal(sent.length,3);assert.equal(h.input.reviews,1);assert.equal(h.input.posted.length,1);
});

test('Known Telegram receipt failure delays checking without consuming an AI retry',async t=>{
  const h=await queue(t);const sent=enableNotices(h);let offline=true;
  h.service.notify=async text=>{if(offline)throw Object.assign(Error('rejected'),{deliveryUncertain:false});sent.push(text);return {messageId:sent.length};};
  h.input.tickets.push(newTicket());await h.service.scan();await h.service.processOne();
  assert.equal(h.input.reviews,0);assert.equal(h.service.state.jobs.new.attempts,0);
  assert.equal(h.service.health().telegramPending,1);
  offline=false;h.input.time+=60000;await h.service.processOne();
  assert.equal(sent.length,3);assert.equal(h.input.reviews,1);
});

test('Unconfirmed Telegram send is not resent on restart and prevents out-of-order checking',async t=>{
  const h=await queue(t);enableNotices(h);let attempts=0;
  h.opts.notify=h.service.notify=async()=>{attempts++;throw Error('response lost');};
  h.input.tickets.push(newTicket());await h.service.scan();await h.service.processOne();
  const resumed=new TicketReviewService(h.opts);await resumed.initialize();h.input.time+=600000;await resumed.processOne();
  assert.equal(attempts,1);assert.equal(h.input.reviews,0);assert.equal(resumed.health().telegramNeedsAttention,1);
});

test('Long completion report resumes unsent parts after restart without rerunning review or reposting',async t=>{
  const h=await queue(t);const sent=enableNotices(h);let fail=true;
  const comment='Nội dung báo cáo 🧪\n'.repeat(600);
  h.service.review=async()=>{h.input.reviews++;return {ticketId:'new',category:'Question',...hanFixture(comment)};};
  h.opts.notify=h.service.notify=async text=>{
    if(sent.length===3&&fail)throw Object.assign(Error('rate limited'),{deliveryUncertain:false,retryAfterMs:60000});
    sent.push(text);return {messageId:sent.length};
  };
  h.input.tickets.push(newTicket());await h.service.scan();await h.service.processOne();
  assert.equal(h.service.state.jobs.new.status,'done');assert.equal(h.service.state.jobs.new.telegram.completed.nextPart,1);
  fail=false;h.input.time+=60000;
  const resumed=new TicketReviewService(h.opts);await resumed.initialize();await resumed.processOne();
  assert(sent.every(part=>part.length<=3800));assert(sent.slice(2).join('').endsWith(h.input.posted[0].comment));
  assert.equal(h.input.reviews,1);assert.equal(h.input.posted.length,1);assert.equal(resumed.state.jobs.new.telegram.completed.status,'sent');
});

test('Lost Helpdesk response announces completion only after reconciliation finds the posted report',async t=>{
  const h=await queue(t);const sent=enableNotices(h);
  h.service.post=async(id,comment)=>{h.input.comments.push({id:'saved',ticketId:id,content:comment});throw Error('lost POST response');};
  h.input.tickets.push(newTicket());await h.service.scan();await h.service.processOne();
  assert.equal(sent.length,2);assert.equal(h.service.state.jobs.new.status,'uncertain');
  await h.service.processOne();assert.equal(sent.length,3);assert.match(sent[2],/check xong/);
});

test('Review failures alert Telegram without claiming completion; legacy jobs never replay notices',async t=>{
  const h=await queue(t);const sent=enableNotices(h);
  h.service.config.maxAttempts=1;h.service.review=async()=>{throw Error('failed');};
  h.input.tickets.push(newTicket());await h.service.scan();await h.service.processOne();
  assert.equal(sent.length,3);assert.match(sent[2],/chưa hoàn tất/);assert(!sent.some(text=>text.includes('đã check xong')));
  delete h.service.state.jobs.new.telegram;
  await h.service.change(()=>{});
  const resumed=new TicketReviewService(h.opts);await resumed.initialize();await resumed.processOne();assert.equal(sent.length,3);
});

test('Restart during Telegram send requires attention instead of replaying',async t=>{
  const h=await queue(t);const sent=enableNotices(h);h.input.tickets.push(newTicket());await h.service.scan();
  await h.service.change(()=>{h.service.state.jobs.new.telegram.received={status:'sending',parts:['receipt'],nextPart:0,messageIds:[],attempts:1};});
  const resumed=new TicketReviewService(h.opts);await resumed.initialize();await resumed.processOne();
  assert.equal(sent.length,0);assert.equal(h.input.reviews,0);assert.equal(resumed.health().telegramNeedsAttention,1);
});

test('Telegram splitting preserves exact text and Unicode across size boundaries',()=>{
  const text='x'.repeat(3799)+'😀'+'a'.repeat(3800)+'\n```css\n.elite {color:red}\n```';
  const parts=splitTelegramText(text);
  assert.equal(parts.join(''),text);assert(parts.every(part=>part.length<=3800));
  assert(parts.every(part=>!/[\uD800-\uDBFF]$/.test(part)));
});

test('Elite adapter keeps the reason and the consumer reported by the bridge',async t=>{
  const dir=await mkdtemp(resolve(tmpdir(),'ticket-elite-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const requests=[];
  t.mock.method(globalThis,'fetch',async url=>{requests.push(String(url));return {ok:false,status:400,json:async()=>({error:'AI_LOGIN_REQUIRED',consumer:'ts-web',jobId:'job-1'})};});
  const io=await createIO(dir);const target={reference:'JSUB-test',url:'https://helpdesk.avada.net/tickets/JSUB-test'};
  await assert.rejects(io.elite(target,{}),error=>{
    assert.match(error.message,/^TS Elite 2 review failed: AI_LOGIN_REQUIRED \(HTTP 400\)\.$/);
    assert.equal(error.detail.consumer,'ts-web');assert.equal(error.detail.code,'AI_LOGIN_REQUIRED');assert.equal(error.detail.bridgeJobId,'job-1');assert(error.detail.hint);
    return true;
  });
  // A temporary folder is not a job folder: nothing is sent to the tracing web and no local trace log is written.
  assert.deepEqual(requests,['http://127.0.0.1:39541/codex-ts-elite/review']);
  await assert.rejects(readFile(resolve(dir,'..','trace.jsonl')),{code:'ENOENT'});
  await jobTraceEmitter(dir)('note','outside the job folders');assert.equal(requests.length,1);
});

test('Failure reasons are printable and never carry long opaque strings',()=>{
  assert.equal(safeReason('  AI_LOGIN_REQUIRED\n'),'AI_LOGIN_REQUIRED');
  assert.equal(safeReason('Bearer '+'a1B2'.repeat(20)+' rejected'),'Bearer […] rejected');
  assert.equal(safeReason('x '.repeat(400)).length,300);assert.equal(safeReason(undefined),'');
});

test('Review traces how long each phase took and why a phase stopped',async()=>{
  const h=flow('Question');const events=[];h.io.trace=(kind,text,extra)=>events.push({kind,text,...extra});
  await executeReview('JSUB-test',h.io,limits);
  for(const phase of ['elite','classify','question']) {
    const done=events.find(e=>e.kind==='note'&&e.phase===phase);
    assert.equal(done.payload.status,'complete');assert(Number.isFinite(done.payload.elapsedMs));
  }
  const composed=events.at(-1);assert.equal(composed.phase,'compose');assert.equal(composed.payload.category,'Question');assert.equal(composed.payload.audit.length,3);
  const failing=flow('Question');const failed=[];failing.io.trace=(kind,text,extra)=>failed.push({kind,text,...extra});
  failing.io.elite=async()=>{throw Object.assign(Error('TS Elite 2 review failed: AI_LOGIN_REQUIRED (HTTP 400).'),{detail:{consumer:'ts-web',httpStatus:400}});};
  await assert.rejects(executeReview('JSUB-test',failing.io,limits),/AI_LOGIN_REQUIRED/);
  assert.equal(failed.length,1);assert.equal(failed[0].kind,'warning');assert.match(failed[0].text,/Pha elite lỗi sau .*AI_LOGIN_REQUIRED/);
  assert.equal(failed[0].payload.status,'failed');assert.equal(failed[0].payload.consumer,'ts-web');
  const slow=flow('Question');const late=[];slow.io.trace=(kind,text,extra)=>late.push({kind,text,...extra});
  slow.io.worker=async phase=>phase==='classify'?slow.initial:new Promise(()=>{});
  await executeReview('JSUB-test',slow.io,{...limits,branchTimeoutMs:20});
  assert(late.some(e=>e.kind==='warning'&&e.phase==='question'&&e.payload.status==='timeout'));
  assert(late.some(e=>e.kind==='warning'&&e.payload.status==='elite_fallback'&&e.payload.reason==='timeout'));
});

test('Controller traces every attempt, its failure reason and the retry decision',async t=>{
  const h=await queue(t);const events=[];
  h.service.trace=job=>(kind,text,extra)=>events.push({job:job.id,kind,text,...extra});
  h.service.review=async()=>{throw Object.assign(Error('TS Elite 2 review failed: AI_LOGIN_REQUIRED (HTTP 400).'),{detail:{consumer:'ts-web',code:'AI_LOGIN_REQUIRED'}});};
  h.input.tickets.push(newTicket());await h.service.scan();
  for(let attempt=1;attempt<=3;attempt++){await h.service.processOne();h.input.time+=600000;}
  const job=h.service.state.jobs.new;
  assert.equal(job.status,'needs_attention');assert.match(job.lastError,/AI_LOGIN_REQUIRED/);assert(Number.isFinite(Date.parse(job.failedAt)));
  assert.deepEqual(events.filter(e=>e.kind==='start').map(e=>e.payload.attempt),[1,2,3]);
  const failures=events.filter(e=>e.kind==='warning');
  assert.deepEqual(failures.map(e=>[e.payload.attempt,e.payload.status,e.payload.retryInMs]),[[1,'queued',60000],[2,'queued',120000],[3,'needs_attention',null]]);
  assert.match(failures[0].text,/^Lần thử 1\/3 dừng ở pha .*AI_LOGIN_REQUIRED.*thử lại sau 60s$/);
  assert.match(failures[2].text,/đã hết lượt thử/);assert(failures.every(e=>e.payload.consumer==='ts-web'&&e.job==='new'));
  // Terminal kinds stay owned by the file sync, so a retried attempt never closes the session.
  assert(!events.some(e=>['done','error','cancelled','result'].includes(e.kind)));
});

test('Controller traces comment delivery, and a broken tracer never affects the review',async t=>{
  const h=await queue(t);const events=[];
  h.service.trace=job=>(kind,text,extra)=>events.push({kind,text,...extra});
  h.input.tickets.push(newTicket());await h.service.scan();await h.service.processOne();
  assert.equal(h.service.state.jobs.new.status,'done');
  assert.deepEqual(events.map(e=>e.kind),['start','tool']);assert.equal(events[1].phase,'comment');assert.equal(events[1].payload.deliveryAttempt,1);
  const broken=await queue(t);broken.service.trace=()=>{throw Error('tracer down');};
  broken.input.tickets.push(newTicket());await broken.service.scan();await broken.service.processOne();
  assert.equal(broken.service.state.jobs.new.status,'done');assert.equal(broken.input.posted.length,1);
});

// --- "@han" comment commands (13/10/2026) -----------------------------------------------------------------------
function commandTicket(id='t1',{updatedAt='2026-09-18T00:00:05.000Z',...rest}={}) { return {id,ticketId:'JOY-261012-'+id,subject:'Point Calculator',memberIds:[ANDREW_ID],createdAt:'2026-09-17T00:00:00.000Z',updatedAt,...rest}; }
function commentAction(id,memberId,content,createdAt) { return {id,type:'commentTicket',author:{memberId,displayName:memberId===ANDREW_ID?'Andrew':'Alice'},metadata:{content},createdAt}; }
async function commandQueue(t,actionsByTicket) {
  const h=await queue(t);
  const get=h.opts.get;
  h.opts.get=h.service.get=async path=>{
    const match=/^\/tickets\/([^/?]+)\/actions\?/.exec(path);
    if(match){h.input.actionReads=(h.input.actionReads || 0)+1;return {actions:actionsByTicket[decodeURIComponent(match[1])] || []};}
    return get(path);
  };
  h.input.time += 9000;
  h.opts.post=h.service.post=async(id,comment)=>{
    h.input.posted.push({id,comment});
    h.input.comments.push({...commentAction('saved-'+h.input.posted.length,ANDREW_ID,comment,new Date(h.input.time).toISOString()),ticketId:id,content:comment});
  };
  h.opts.find=h.service.find=(id,comment,scope)=>findPostedComment(id,comment,async()=>({actions:h.input.comments.filter(c=>c.ticketId===id)}),scope);
  h.input.followUps=[];
  h.service.review=async(reference,jobDir,progress,options={})=>{h.input.reviews++;h.input.followUps.push(options.followUp || null);const ticket=h.input.tickets.find(t=>t.ticketId===reference);return {ticketId:ticket.id,category:'Question',...hanFixture('Check tiếp cho '+reference)};};
  // Tickets Andrew already had before the controller started: part of the roster baseline, so no lifecycle job is created for them.
  h.addBaseline=async(...tickets)=>{h.input.tickets.push(...tickets);await h.service.change(state=>{state.assignedTicketIds=h.input.tickets.map(t=>t.id);});};
  return h;
}

test('@han: Andrew\'s comment on a ticket updated after the cursor becomes one follow-up job; others are ignored',async t=>{
  const actions={t1:[commentAction('c2',ANDREW_ID,'@han check tiếp theo comment mới','2026-09-18T00:00:04.000Z'),commentAction('c1','alice','@han em nhờ anh','2026-09-18T00:00:03.000Z'),commentAction('c0',ANDREW_ID,'@han cũ','2026-09-17T23:00:00.000Z')],
    quiet:[commentAction('q1',ANDREW_ID,'@han','2026-09-18T00:00:04.000Z')]};
  const h=await commandQueue(t,actions);
  await h.addBaseline(commandTicket('t1'),commandTicket('quiet',{updatedAt:'2026-09-17T00:00:00.000Z'}));
  await h.service.scan();
  assert.equal(h.input.actionReads,2,'changed ticket detection plus ACK baseline; unchanged ticket is not read');
  assert.deepEqual(Object.keys(h.service.state.jobs).filter(id=>id.startsWith('cmd-')),['cmd-c2']);
  const job=h.service.state.jobs['cmd-c2'];
  assert.equal(job.trigger,'bot_command');assert.equal(job.ticketId,'t1');assert.equal(job.reference,'JOY-261012-t1');assert.equal(job.command.instruction,'check tiếp theo comment mới');
  assert.equal(job.followUp.sinceAt,'2026-09-17T00:00:00.000Z','no earlier check → window from the ticket creation');
  assert.deepEqual(Object.keys(h.service.state.commands),['c2']);
  // Same comment seen again on the next scans (updatedAt still after the old cursor) → no second job.
  h.input.time+=300000;h.input.tickets[1].updatedAt=new Date(h.input.time-1000).toISOString();
  await h.service.scan();await h.service.scan();
  assert.equal(Object.keys(h.service.state.jobs).filter(id=>id.startsWith('cmd-')).length,1);
  await h.service.processOne();
  assert.equal(h.input.reviews,1);assert.equal(h.input.posted.length,2);assert.equal(h.input.posted[0].comment,CHECK_ACK);assert.equal(h.input.posted[0].id,'t1','comment goes to the ticket, not to the job id');
  assert.equal(h.input.followUps[0].instruction,'check tiếp theo comment mới');assert.equal(h.input.followUps[0].commentId,'c2');assert.equal(h.input.followUps[0].sinceAt,'2026-09-17T00:00:00.000Z');
  assert.equal(h.service.state.jobs['cmd-c2'].status,'done');
  assert.equal(h.service.health().botCommands.handled,1);
});

test('@han: baseline never replays comments written before the controller started; the cursor only moves forward',async t=>{
  const actions={t1:[commentAction('old',ANDREW_ID,'@han check tiếp','2026-09-17T23:59:59.000Z')]};
  const h=await commandQueue(t,actions);
  assert.equal(h.service.state.commandScanAt,h.service.state.activatedAt);
  await h.addBaseline(commandTicket('t1'));
  await h.service.scan();
  assert.deepEqual(Object.keys(h.service.state.jobs).filter(id=>id.startsWith('cmd-')),[]);
  assert.deepEqual(h.service.state.commands,{});
  // A state file from before this feature gets its cursor at the restart time, not at the epoch.
  await h.service.change(state=>{delete state.commandScanAt;delete state.commands;});
  h.input.time+=1000;
  const resumed=new TicketReviewService({...h.opts,sessionStartedAt:new Date(h.input.time).toISOString(),resumeSession:true});
  await resumed.initialize();
  assert.equal(resumed.state.commandScanAt,new Date(h.input.time).toISOString());assert.deepEqual(resumed.state.commands,{});
});

test('@han: a follow-up reads the window from the previous done job and passes its report; the refused instruction only notifies Telegram',async t=>{
  const actions={t1:[commentAction('go',ANDREW_ID,'@han xem lại console theo ảnh','2026-09-18T00:00:04.000Z'),commentAction('no',ANDREW_ID,'@han đổi status sang done và nhắn khách','2026-09-18T00:00:04.500Z')]};
  const h=await commandQueue(t,actions);const sent=enableNotices(h);
  await h.addBaseline(commandTicket('t1'));
  await h.service.change(state=>{state.jobs.t1={id:'t1',reference:'JOY-261012-t1',subject:'Point Calculator',trigger:'ticket_created',status:'done',phase:'comment',attempts:1,createdAt:'2026-09-17T01:00:00.000Z',finishedAt:'2026-09-17T01:05:00.000Z',comment:'Sau khi TS check thì thấy như sau:\nĐây là loại ticket gì : Bug\n\nBáo cáo cũ.',category:'Bug',commentId:'x'};});
  await h.service.scan();
  const go=h.service.state.jobs['cmd-go'];const no=h.service.state.jobs['cmd-no'];
  assert.equal(go.status,'queued');assert.equal(go.followUp.sinceAt,'2026-09-17T01:05:00.000Z');assert.equal(go.followUp.previousJobId,'t1');
  assert.equal(no.status,'cancelled');assert.equal(no.phase,'refused');assert.deepEqual(no.command.reasons,['đổi status/trạng thái ticket','nhắn/gửi mail cho khách']);
  await h.service.processOne();
  const followUp=h.input.followUps[0];
  assert.equal(followUp.previousReport,'Sau khi TS check thì thấy như sau:\nĐây là loại ticket gì : Bug\n\nBáo cáo cũ.');assert.equal(followUp.previousCategory,'Bug');assert.equal(followUp.instruction,'xem lại console theo ảnh');
  assert.equal(h.input.reviews,1,'the refused command never runs the pipeline');
  assert.equal(h.input.posted.length,3);assert.equal(no.ack.status,'sent');assert.equal(no.mode,'refused');
  const texts=sent.join('\n---\n');
  assert.match(texts,/📥 Đã nhận lệnh @han trên ticket JOY-261012-t1\nChỉ thị: xem lại console theo ảnh/);
  assert.match(texts,/🔎 Hachimi đang check tiếp ticket JOY-261012-t1 theo lệnh @han/);
  assert.match(texts,/✅ Hachimi đã check tiếp xong ticket JOY-261012-t1/);
  assert.match(texts,/⛔ Lệnh @han trên ticket JOY-261012-t1 bị từ chối: đổi status\/trạng thái ticket; nhắn\/gửi mail cho khách/);
  assert.equal(sent.filter(text=>text.startsWith('⛔')).length,1);
  await h.service.processOne();
  assert.equal(sent.filter(text=>text.startsWith('⛔')).length,1,'the refusal is announced once');
});

test('@han: an unreadable ticket is retried next scan without blocking others; disabled config scans nothing',async t=>{
  const actions={ok:[commentAction('k',ANDREW_ID,'@han','2026-09-18T00:00:04.000Z')],bad:[commentAction('b',ANDREW_ID,'@han','2026-09-18T00:00:04.000Z')]};
  const h=await commandQueue(t,actions);
  const get=h.service.get;let blocked=true;
  h.opts.get=h.service.get=async path=>{if(blocked&&path.startsWith('/tickets/bad/actions'))throw Error('Helpdesk GET failed (HTTP 500).');return get(path);};
  await h.addBaseline(commandTicket('ok'),commandTicket('bad'));
  await h.service.scan();
  assert.deepEqual(Object.keys(h.service.state.jobs).filter(id=>id.startsWith('cmd-')),['cmd-k']);
  assert.equal(h.service.health().botCommands.pendingTickets,1);
  blocked=false;h.input.time+=300000;
  const resumed=new TicketReviewService(h.opts);await resumed.initialize();await resumed.scan();
  assert.deepEqual(Object.keys(resumed.state.jobs).filter(id=>id.startsWith('cmd-')).sort(),['cmd-b','cmd-k']);
  assert.equal(resumed.health().botCommands.pendingTickets,0);
  const off=new TicketReviewService({...h.opts,config:{...h.opts.config,botCommand:{enabled:false}}});await off.initialize();
  await h.addBaseline(commandTicket('more'));actions.more=[commentAction('m',ANDREW_ID,'@han','2026-09-18T00:10:00.000Z')];
  await off.scan();assert.equal(off.state.jobs['cmd-m'],undefined);assert.equal(off.health().botCommands.enabled,false);
});

// --- "@han" natural replies (14/10/2026, "Tôi chỉ @han hi mà sao không trả lời 1 cách tự nhiên mà lại thành check ticket vậy") ---
test('@han: a greeting gets one ACK then one plain template comment (no wrapper, no pipeline) and a single 💬 Telegram line',async t=>{
  const actions={t1:[commentAction('hi',ANDREW_ID,'@han hi','2026-09-18T00:00:04.000Z')]};
  const h=await commandQueue(t,actions);const sent=enableNotices(h);
  h.service.reply=async()=>{throw Error('model must not run for a chat');};
  await h.addBaseline(commandTicket('t1'));
  await h.service.scan();
  const job=h.service.state.jobs['cmd-hi'];
  assert.equal(job.mode,'reply');assert.equal(job.command.kind,'chat');assert.equal(job.command.chatGroup,'greeting');assert.equal(job.command.instruction,'hi');
  await h.service.processOne();
  assert.equal(h.input.reviews,0,'no follow-up pipeline');
  assert.equal(h.input.posted.length,2);assert.equal(h.input.posted[0].id,'t1');
  assert.equal(h.input.posted[0].comment,CHECK_ACK);const comment=h.input.posted[1].comment;
  assert.doesNotMatch(comment,/Sau khi TS check|Đây là loại ticket gì|Hachimi|Đại tá/);assert.match(comment,/JOY-261012-t1/);
  // The template is picked at random (chatReply pick=Math.random); check against the whole greeting group, not one phrase.
  const greetings=CHAT_TEMPLATES.greeting.map(tpl=>tpl.replace(/\{ref\}/g,'JOY-261012-t1').replace(/\{kw\}/g,'@han'));
  assert.ok(greetings.includes(comment),`comment is one of the greeting templates: ${comment}`);
  assert.equal(h.service.state.jobs['cmd-hi'].status,'done');assert.equal(h.service.state.jobs['cmd-hi'].replySource,'template');
  assert.equal(sent.length,1,'one Telegram line, no 📥/🔎');assert.match(sent[0],/^💬 Đã trả lời @han trên ticket JOY-261012-t1 \("hi"\): /);assert.ok(sent[0].includes(comment.slice(0,80)));
  await h.service.processOne();await h.service.scan();await h.service.processOne();
  assert.equal(sent.length,1);assert.equal(h.input.posted.length,2);
  assert.equal(h.service.health().botCommands.replies,1);
  // chatTemplates=false → the chat goes through the reply worker instead.
  const viaModel=new TicketReviewService({...h.opts,config:{...h.opts.config,botCommand:{chatTemplates:false}},reply:async(job)=>({kind:'chat',body:'Chào anh, mình đây.',source:'model'})});
  await viaModel.initialize();actions.t1.push(commentAction('hi2',ANDREW_ID,'@han hello','2026-09-18T00:00:11.000Z'));h.input.tickets[1].updatedAt='2026-09-18T00:00:12.000Z';h.input.time+=5000;
  await viaModel.scan();await viaModel.processOne();
  assert.equal(h.input.posted.at(-1).comment,'Chào anh, mình đây.');assert.equal(viaModel.state.jobs['cmd-hi2'].replySource,'model');
});

test('@han: a question is answered by the reply worker from existing data as one plain comment; an unsure text the model reads as a check runs the follow-up',async t=>{
  const actions={t1:[commentAction('q',ANDREW_ID,'@han ticket này sao rồi?','2026-09-18T00:00:04.000Z'),commentAction('u',ANDREW_ID,'@han khách bảo vẫn lỗi','2026-09-18T00:00:04.500Z')]};
  const h=await commandQueue(t,actions);const sent=enableNotices(h);
  const replies=[];
  h.service.reply=async(job,followUp,jobDir)=>{replies.push({id:job.id,followUp,jobDir});
    if(job.command.kind==='question') return {kind:'question',body:'Lần trước kết luận Bug do thiếu block; khách chưa phản hồi thêm. Anh muốn mình check tiếp không? (gõ @han check tiếp)',source:'model',attempts:1};
    return {kind:'follow_up',body:'',source:'model',attempts:1};};
  await h.addBaseline(commandTicket('t1'));
  await h.service.change(state=>{state.jobs.t1={id:'t1',reference:'JOY-261012-t1',subject:'Point Calculator',trigger:'ticket_created',status:'done',phase:'comment',attempts:1,createdAt:'2026-09-17T01:00:00.000Z',finishedAt:'2026-09-17T01:05:00.000Z',comment:'Sau khi TS check thì thấy như sau:\nĐây là loại ticket gì : Bug\n\nBáo cáo cũ.',category:'Bug',commentId:'x'};});
  await h.service.scan();
  assert.equal(h.service.state.jobs['cmd-q'].mode,'reply');assert.equal(h.service.state.jobs['cmd-q'].command.kind,'question');
  assert.equal(h.service.state.jobs['cmd-u'].mode,'reply');assert.equal(h.service.state.jobs['cmd-u'].command.kind,'unsure');
  await h.service.processOne();
  assert.equal(replies.length,1);assert.equal(replies[0].id,'cmd-q');assert.equal(replies[0].followUp.kind,'question');assert.equal(replies[0].followUp.instruction,'ticket này sao rồi?');assert.equal(replies[0].followUp.previousReport,h.service.state.jobs.t1.comment);
  assert.ok(replies[0].jobDir.includes('runtime/check-ticket/jobs/cmd-q/'));
  assert.equal(h.input.posted.length,3);assert.match(h.input.posted[2].comment,/^Lần trước kết luận Bug/);assert.equal(h.input.reviews,0);
  assert.equal(h.service.state.jobs['cmd-q'].status,'done');assert.equal(h.service.state.jobs['cmd-q'].comment,h.input.posted[2].comment,'no wrapper added');
  // Second job: the model says it is a real check request → the job switches to the review branch with the usual notices.
  await h.service.processOne();
  const u=h.service.state.jobs['cmd-u'];
  assert.equal(u.mode,'review');assert.equal(u.status,'queued');assert.equal(u.command.kind,'follow_up');assert.equal(u.command.resolvedBy,'model');assert.equal(u.attempts,0);
  assert.equal(h.input.reviews,0);assert.equal(h.input.posted.filter(p=>p.comment===CHECK_ACK).length,2,'model transition reuses ACK');
  await h.service.processOne();
  assert.equal(h.input.reviews,1);assert.equal(h.input.followUps[0].instruction,'khách bảo vẫn lỗi');assert.equal(h.input.followUps[0].commentId,'u');
  assert.equal(h.input.posted.length,4);assert.equal(h.input.posted[1].comment,CHECK_ACK);assert.match(h.input.posted[3].comment,/^Sau khi TS check thì thấy như sau:/);
  assert.equal(h.service.state.jobs['cmd-u'].status,'done');
  const texts=sent.join('\n---\n');
  assert.equal(sent.filter(text=>text.startsWith('💬')).length,1);
  assert.match(texts,/📥 Đã nhận lệnh @han trên ticket JOY-261012-t1\nChỉ thị: khách bảo vẫn lỗi/);assert.match(texts,/🔎 Hachimi đang check tiếp/);assert.match(texts,/✅ Hachimi đã check tiếp xong/);
  assert.equal(sent.length,4);
});

test('@han: a reply that cannot be produced keeps its ACK and warns once on Telegram after the attempts are used up',async t=>{
  const actions={t1:[commentAction('q',ANDREW_ID,'@han khách trả lời chưa','2026-09-18T00:00:04.000Z')]};
  const h=await commandQueue(t,actions);const sent=enableNotices(h);
  let calls=0;h.service.reply=async()=>{calls++;throw Error('Chưa soạn được câu trả lời @han: câu trả lời rỗng');};
  await h.addBaseline(commandTicket('t1'));
  await h.service.scan();
  for(let round=0;round<6;round++){await h.service.processOne();h.input.time+=600000;}
  assert.equal(calls,3,'maxAttempts reply attempts');
  assert.equal(h.input.posted.length,1,'only ACK posted');assert.equal(h.input.posted[0].comment,CHECK_ACK);assert.equal(h.input.reviews,0);
  const job=h.service.state.jobs['cmd-q'];
  assert.equal(job.status,'needs_attention');assert.match(job.lastError,/câu trả lời rỗng/);
  assert.equal(sent.length,1);assert.match(sent[0],/^⚠️ Chưa trả lời được @han trên ticket JOY-261012-t1 \("khách trả lời chưa"\): Chưa soạn được câu trả lời @han: câu trả lời rỗng\. Không đăng câu trả lời; ACK đã gửi được giữ lại nếu có\./);
  await h.service.processOne();assert.equal(sent.length,1);
  // A reply already on Helpdesk (restart after an unconfirmed POST) is recognised, not reposted.
  const again=new TicketReviewService(h.opts);await again.initialize();
  await again.change(state=>{state.jobs['cmd-q']={...state.jobs['cmd-q'],status:'ready',comment:'Dạ chưa anh.',telegram:{}};});
  h.input.comments.push({...commentAction('dup',ANDREW_ID,'Dạ chưa anh.',new Date(h.input.time).toISOString()),ticketId:'t1'});
  await again.processOne();
  assert.equal(again.state.jobs['cmd-q'].status,'done');assert.equal(again.state.jobs['cmd-q'].phase,'already_posted');assert.equal(h.input.posted.length,1);
});

// ACK regression: all Helpdesk/Telegram I/O is injected; never touches a live ticket.
test('@han ACK: exact text at detection while queue is busy; concurrent retries and restart never duplicate it',async t=>{
  const h=await commandQueue(t,{t1:[commentAction('ack',ANDREW_ID,'@han check cho tôi cái này','2026-09-18T00:00:04Z')]});
  await h.addBaseline(commandTicket());h.service.processing=true;
  await h.service.scan();const job=h.service.state.jobs['cmd-ack'];
  assert.deepEqual(h.input.posted,[{id:'t1',comment:'Dạ chờ em check xíu nha'}]);assert.equal(h.input.reviews,0);
  await Promise.all([h.service.ensureCommandAck(job),h.service.ensureCommandAck(job)]);
  const resumed=new TicketReviewService({...h.opts,review:h.service.review,resumeSession:true});await resumed.initialize();await resumed.processOne();
  assert.equal(resumed.state.jobs[job.id].status,'done');assert.equal(h.input.posted.length,2);
  assert.equal(resumed.state.jobs[job.id].commentFormatVersion,'ts-review-v1');
  assert.equal(resumed.state.jobs[job.id].report.sections.length,7);
  assert.match(h.input.posted[1].comment,/^Sau khi TS check thì thấy như sau:/);
  assert.deepEqual(h.input.followUps[0].acknowledgementIds,[job.ack.commentId]);
});

test('@han ACK: crash after committed POST reconciles before review, and report crash also reconciles without repost',async t=>{
  const h=await commandQueue(t,{t1:[commentAction('ack',ANDREW_ID,'@han check','2026-09-18T00:00:04Z')]});
  await h.addBaseline(commandTicket());const post=h.service.post;
  h.service.post=async(...args)=>{await post(...args);throw Error('connection lost after commit');};
  await h.service.scan();const job=h.service.state.jobs['cmd-ack'];assert.equal(job.ack.status,'uncertain');assert.equal(h.input.reviews,0);
  // Disk as it would look after a crash between POST and its response.
  await h.service.change(()=>{job.ack.status='posting';});h.input.time+=60000;
  const resumed=new TicketReviewService({...h.opts,review:h.service.review,resumeSession:true,post:h.service.post});await resumed.initialize();
  await resumed.processOne();assert.equal(resumed.state.jobs[job.id].ack.status,'sent');assert.equal(resumed.state.jobs[job.id].status,'uncertain');
  await resumed.change(()=>{resumed.state.jobs[job.id].status='posting';});
  const again=new TicketReviewService({...h.opts,resumeSession:true});await again.initialize();await again.processOne();
  assert.equal(again.state.jobs[job.id].status,'done');assert.equal(h.input.posted.length,2);assert.equal(h.input.reviews,1);
});

test('@han ACK: unresolved POST blocks pipeline and later ACK on same ticket; never reposts and warns once',async t=>{
  const h=await commandQueue(t,{t1:[commentAction('a',ANDREW_ID,'@han check','2026-09-18T00:00:04Z'),commentAction('b',ANDREW_ID,'@han check','2026-09-18T00:00:05Z')]});
  const sent=enableNotices(h);await h.addBaseline(commandTicket());let posts=0;
  h.service.post=async()=>{posts++;throw Error('timeout; result unknown');};
  await h.service.scan();
  for(let i=0;i<5;i++){h.input.time+=60000;await h.service.processOne();}
  assert.equal(posts,1);assert.equal(h.input.reviews,0);assert.equal(h.service.state.jobs['cmd-a'].ack.status,'needs_attention');
  assert.equal(sent.filter(text=>text.startsWith('⚠️')).length,2,'each blocked command terminates with its own failure notice');
});

test('@han ACK: two commands on one ticket each receive their own ACK and same-text report',async t=>{
  const h=await commandQueue(t,{t1:[commentAction('a',ANDREW_ID,'@han check','2026-09-18T00:00:04Z'),commentAction('b',ANDREW_ID,'@han check','2026-09-18T00:00:05Z')]});
  await h.addBaseline(commandTicket());await h.service.scan();
  assert.equal(h.input.posted.length,2);assert.notEqual(h.service.state.jobs['cmd-a'].ack.commentId,h.service.state.jobs['cmd-b'].ack.commentId);
  await h.service.processOne();await h.service.processOne();assert.equal(h.input.posted.length,4);
  assert.notEqual(h.service.state.jobs['cmd-a'].commentId,h.service.state.jobs['cmd-b'].commentId);
  assert.equal(h.service.state.jobs['cmd-a'].status,'done');assert.equal(h.service.state.jobs['cmd-b'].status,'done');
});

test('@han ACK: review failure keeps one ACK; deleted ticket cannot receive ACK',async t=>{
  const h=await commandQueue(t,{t1:[commentAction('a',ANDREW_ID,'@han check','2026-09-18T00:00:04Z')]});
  await h.addBaseline(commandTicket());await h.service.scan();h.service.review=async()=>{throw Error('pipeline failed');};
  for(let i=0;i<4;i++){await h.service.processOne();h.input.time+=300000;}
  assert.equal(h.input.posted.length,1);assert.equal(h.input.posted[0].comment,CHECK_ACK);assert.equal(h.service.state.jobs['cmd-a'].status,'needs_attention');
  const deleted=await commandQueue(t,{});await deleted.addBaseline(commandTicket('gone',{deletedAt:'now'}));
  await deleted.service.enqueueCommand(commandTicket('gone'),{commentId:'gone',createdAt:'2026-09-18T00:00:04Z',kind:'follow_up',instruction:'check'});
  assert.equal(deleted.input.posted.length,0);assert.equal(deleted.input.reviews,0);
});

test('Scoped comment reconciliation rejects old ACKs, other authors and another command delivery',async()=>{
  const actions=[commentAction('old',ANDREW_ID,CHECK_ACK,'2026-10-14T00:00:00Z'),commentAction('alice','alice',CHECK_ACK,'2026-10-14T00:02:00Z'),commentAction('claimed',ANDREW_ID,CHECK_ACK,'2026-10-14T00:02:00Z'),commentAction('new',ANDREW_ID,CHECK_ACK,'2026-10-14T00:02:01Z')];
  const found=await findPostedComment('t',CHECK_ACK,async()=>({actions}),{since:'2026-10-14T00:01:00Z',excludeIds:['claimed']});
  assert.equal(found.id,'new');
});


test('@han ACK: concurrent scan and processor stop after ACK failure without preparing an empty report',async t=>{
  const h=await commandQueue(t,{t1:[commentAction('a',ANDREW_ID,'@han check','2026-09-18T00:00:04Z')]});
  await h.addBaseline(commandTicket());h.service.config.maxAttempts=1;
  let release, entered;const posting=new Promise(r=>{entered=r;});
  h.service.post=async()=>{entered();await new Promise(r=>{release=r;});throw Error('unknown POST');};
  const scan=h.service.scan();await posting;const processing=h.service.processOne();release();await Promise.all([scan,processing]);
  const job=h.service.state.jobs['cmd-a'];assert.equal(job.status,'needs_attention');assert.equal(h.input.reviews,0);assert.equal(job.comment,undefined);
});

test('@han migration: catch up new-keyword gap once, ignore old keyword and pre-cutover comments, preserve existing jobs',async t=>{
  const actions={t1:[commentAction('before',ANDREW_ID,'@han check','2026-09-18T00:00:04Z'),commentAction('new',ANDREW_ID,'@han check','2026-09-18T00:00:06Z'),commentAction('old',ANDREW_ID,'@bot check','2026-09-18T00:00:07Z'),commentAction('handled',ANDREW_ID,'@han check','2026-09-18T00:00:08Z')]};
  const h=await commandQueue(t,actions);await h.addBaseline(commandTicket('t1',{updatedAt:'2026-09-18T00:00:08Z'}));
  const existing={id:'cmd-handled',ticketId:'t1',reference:'JOY-261012-t1',trigger:'bot_command',status:'done',command:{commentId:'handled'},commentId:'previous'};
  await h.service.change(state=>{state.commandKeyword='@bot';state.commandScanAt='2026-09-18T00:00:30Z';state.lastScanAt=state.commandScanAt;state.jobs[existing.id]=existing;state.commands.handled={jobId:existing.id};state.commandPending={t1:{reference:'JOY-261012-t1',sinceAt:'2026-09-18T00:00:00Z'}};});
  h.input.time=Date.parse('2026-09-18T00:01:00Z');
  const opts={...h.opts,review:h.service.review,resumeSession:true,config:{...h.opts.config,botCommand:{keyword:'@han',keywordSinceAt:'2026-09-18T00:00:05Z'}}};
  const resumed=new TicketReviewService(opts);await resumed.initialize();
  assert.equal(resumed.state.commandScanAt,'2026-09-18T00:00:05.000Z');assert.equal(resumed.state.lastScanAt,'2026-09-18T00:00:30Z');
  await resumed.scan();assert.deepEqual(Object.keys(resumed.state.commands).sort(),['handled','new']);
  assert.deepEqual(resumed.state.jobs[existing.id],existing);assert.equal(h.input.posted.length,1);
  const cursor=resumed.state.commandScanAt;const again=new TicketReviewService(opts);await again.initialize();
  assert.equal(again.state.commandScanAt,cursor,'migration must not rewind every restart');await again.scan();assert.equal(h.input.posted.length,1);
  const fresh=new TicketReviewService({...opts,resumeSession:false,sessionStartedAt:'2026-09-18T00:02:00Z'});await fresh.initialize();
  assert.equal(fresh.state.commandScanAt,'2026-09-18T00:02:00Z','fresh session still baselines old comments');
});

test('@han all branches: restart reconciles ACK before chat/question/refusal; no duplicate ACK on model transition',async t=>{
  for(const [instruction,kind] of [['hi','chat'],['CS cần báo lại gì với khách','question'],['khách bảo vẫn lỗi','unsure'],['đổi status sang done','refused']]){
    const h=await commandQueue(t,{t1:[commentAction('a',ANDREW_ID,'@han '+instruction,'2026-09-18T00:00:04Z')]});await h.addBaseline(commandTicket());
    const post=h.service.post;h.service.post=async(...args)=>{await post(...args);throw Error('lost ACK response');};
    await h.service.scan();const job=h.service.state.jobs['cmd-a'];assert.equal(job.command.kind,kind);assert.equal(job.ack.status,'uncertain');assert.equal(h.input.reviews,0);
    h.input.time+=60000;let replies=0;
    const resumed=new TicketReviewService({...h.opts,review:h.service.review,resumeSession:true,reply:async()=>{replies++;return kind==='unsure'?{kind:'follow_up'}:{kind:'question',body:'Dạ cần hỏi khách thêm thông tin.',source:'model'};}});
    await resumed.initialize();await resumed.processOne();if(kind==='unsure')await resumed.processOne();
    const done=resumed.state.jobs[job.id];assert.equal(done.ack.status,'sent');assert.equal(h.input.posted.filter(p=>p.comment===CHECK_ACK).length,1,kind);
    assert.equal(done.status,kind==='refused'?'cancelled':'done');assert.equal(h.input.posted.length,kind==='refused'?1:2);
    if(kind==='refused'||kind==='chat')assert.equal(replies,0);assert.equal(h.input.reviews,kind==='unsure'?1:0);
  }
});

test('@han generated reply mentioning the command is never treated as Andrew writing a new command',async t=>{
  const actions={t1:[commentAction('q',ANDREW_ID,'@han ticket sao rồi?','2026-09-18T00:00:04Z')]};
  const h=await commandQueue(t,actions);await h.addBaseline(commandTicket());await h.service.scan();
  h.input.time+=5000;h.service.reply=async()=>({kind:'question',body:'Chưa có thông tin mới. Anh gõ @han check tiếp nhé.',source:'model'});await h.service.processOne();
  actions.t1.push(...h.input.comments);h.input.tickets[1].updatedAt=new Date(h.input.time).toISOString();h.input.time+=5000;
  await h.service.scan();assert.deepEqual(Object.keys(h.service.state.commands),['q']);assert.equal(h.input.posted.length,2);
});

test('@han migration never opts a legacy unsure job into an ACK when its model switches to review',async t=>{
  const h=await commandQueue(t,{});await h.addBaseline(commandTicket());
  await h.service.change(state=>{state.jobs.legacy={id:'legacy',ticketId:'t1',reference:'JOY-261012-t1',trigger:'bot_command',mode:'reply',status:'queued',attempts:0,command:{commentId:'legacy-input',createdAt:'2026-09-18T00:00:04Z',instruction:'khách bảo vẫn lỗi',kind:'unsure'},followUp:{}};});
  h.service.reply=async()=>({kind:'follow_up'});await h.service.processOne();await h.service.processOne();
  assert.equal(h.service.state.jobs.legacy.ack,undefined);assert.equal(h.input.posted.length,1);assert.notEqual(h.input.posted[0].comment,CHECK_ACK);
});
