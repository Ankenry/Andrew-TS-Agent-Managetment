import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { hanFixture } from './fixtures/han-report.mjs';
import { HAN_GREETING, HAN_TITLES, parseHanReport, reportArtifacts, isHanCompactComment, HELPDESK_OPENING, HISTORICAL_HAN_COMMENT_VERSION, helpdeskProse } from '../skills/check-ticket/scripts/han-report.mjs';
import { formatReviewComment } from '../skills/check-ticket/scripts/handoff.mjs';
import { checkWriterOutput } from '../skills/check-ticket-v2/scripts/postcheck.mjs';
import { readHanReports } from '../skills/check-ticket/scripts/han-reports.mjs';
import { isAiReviewComment, ANDREW_ID } from './hachimi-analytics-store.mjs';

const css = '.widget-parent .rating {\n  display: none;\n}\n/* **5. Những điểm cần lưu ý** */';
const source = hanFixture(`1. Han đề xuất dán vào \`Custom CSS\` sau khi xác nhận đúng theme.\n\n\`\`\`css\n${css}\n\`\`\`\n\nHan chưa thử được trên storefront vì trang bị khóa; chưa lưu vào shop.`, 'Customize');

test('whole-report summary uses the old wrapper and preserves code, placement and uncertainty', () => {
  const before = JSON.stringify(source.report);
  assert.deepEqual(parseHanReport(source.fullReport, 'Customize'), source.report);
  assert.ok(source.comment.startsWith(`${HELPDESK_OPENING}\nĐây là loại ticket gì : Customize\n\nKhách cần`));
  for (const text of [css, 'Custom CSS', 'chưa thử được', 'chưa lưu vào shop', 'chưa có demo']) assert.ok(source.comment.includes(text));
  for (const id of [1,2,3,4,5,6,7]) assert.ok(!source.comment.split('\n').includes(`**${id}. ${HAN_TITLES[id-1]}**`));
  assert.equal(formatReviewComment(source.comment, 'Customize'), source.comment);
  assert.equal(formatReviewComment(source.fullReport, 'Customize'), source.comment);
  assert.doesNotMatch(source.comment, /Han Support|cạ nhà|Han đề xuất|Nếu cạ nhà/);
  assert.equal(JSON.stringify(source.report), before, 'canonical full report is immutable');
});

test('malformed report never silently becomes a compact comment', () => {
  for (const body of [source.fullReport.replace('**3.', '**4.'), source.fullReport.replace('**7. Trạng thái hiện tại**', '**7. Wrong**'), source.fullReport + '\n```js\nno close']) {
    assert.throws(() => parseHanReport(body, 'Customize'));
  }
  assert.equal(isHanCompactComment(`**${HAN_GREETING}**\n\nDạ chờ em check xíu nha`), false);
});

test('evidence and caveats in sections 1/3/5/7 stay in Helpdesk without relocation into 2/4/6', () => {
  const report = structuredClone(source.report);
  const facts = [
    'Han phân loại Customize vì yêu cầu đổi layout, chưa xác nhận lỗi app.',
    'Han đã đọc `hideNoStarRating=false` từ storefront lúc 10:15; chưa đọc được DevZone: HTTP 401 AUTH_FAILED.',
    'Han chưa xác nhận nguyên nhân; ảnh chỉ chứng minh block đang hiển thị, không chứng minh khách đã Save.',
    'Han chưa lưu cấu hình hoặc CSS; chưa có demo được kiểm chứng.',
  ];
  [1,3,5,7].forEach((id, i) => report.sections[id-1].body = facts[i]);
  const body = reportArtifacts(report).fullReport;
  const result = checkWriterOutput({ body, claims: facts.map((text,i)=>({text,finding_ids:['G'+i],inference:i%2===0})), customer_letter:null,letter_finding_ids:[] }, {
    category:'Customize', findings:facts.map((_,i)=>({id:'G'+i,kind:i%2===0?'gap':'fact',verified:i%2!==0,code:css,code_lang:'css'})),
  }, {hanReport:true,commentMaxChars:20000,commentMinChars:10,letterMinScore:.9});
  assert.equal(result.ok,true,result.violations.join('; '));
  const compact = reportArtifacts(report).comment;
  for (const fact of facts) assert.ok(compact.includes(helpdeskProse(fact)));
  assert.ok(compact.includes(css));
  const noCode = structuredClone(report); noCode.sections[3].body = 'Han đề xuất kiểm tra trước khi sửa.';
  const missing = checkWriterOutput({body:reportArtifacts(noCode).fullReport,claims:[{text:facts[0],finding_ids:['G0'],inference:true}]},
    {category:'Customize',findings:[{id:'G0',kind:'gap',verified:false,code:css}]}, {hanReport:true,commentMaxChars:20000,commentMinChars:10,letterMinScore:.9});
  assert.equal(missing.ok,false); assert.ok(missing.violations.some(v=>v.includes('khối code')));
});

test('summary deduplicates prose, keeps exact literals/fences and does not truncate long evidence', () => {
  const report = structuredClone(source.report);
  report.sections[4].body = report.sections[6].body;
  report.sections[2].body = 'Han đọc `HanFlag=false`, "Han UI label", https://fixture.test/Han?q=1; Han chưa đổi cấu hình.';
  report.sections[3].body = 'Han đề xuất đoạn sau:\n\n~~~~js\nconst Han = "cạ nhà";\n**2. Nội dung khách đang cần**\n```\n~~~~';
  const comment = reportArtifacts(report).comment;
  assert.equal(helpdeskProse('Han đọc `count` 2. Han chưa đổi.'),'TS đọc `count` 2. TS chưa đổi.');
  assert.equal(comment.split(helpdeskProse(report.sections[4].body)).length,2);
  for(const literal of ['`HanFlag=false`','"Han UI label"','https://fixture.test/Han?q=1','const Han = "cạ nhà";','**2. Nội dung khách đang cần**']) assert.ok(comment.includes(literal));
  report.sections[3].body='Evidence: '+ 'x'.repeat(21000);
  assert.throws(()=>reportArtifacts(report),/exceeds 20000/);
});

test('new comments reject footer/table sources while historical payloads remain readable unchanged', () => {
  for (const extra of ['Nếu cạ nhà cần hỗ trợ thêm, nhắn Han nhé.', 'Sources: internal', '| Việc | Ai |']) {
    const report=structuredClone(source.report); report.sections[6].body+='\n\n'+extra;
    assert.throws(()=>reportArtifacts(report),/summary source/);
    const old=reportArtifacts(report,{commentFormatVersion:HISTORICAL_HAN_COMMENT_VERSION});
    assert.equal(formatReviewComment(old.comment,old.report.category),old.comment);
    assert.ok(old.fullReport.includes(extra));
    const checked=checkWriterOutput({body:old.fullReport,claims:[{text:report.sections[3].body,finding_ids:['S1'],inference:true}]},
      {category:'Customize',findings:[{id:'S1',kind:'suggestion',verified:true,code:css}]}, {hanReport:true,commentMaxChars:20000,commentMinChars:10,letterMinScore:.9});
    assert.equal(checked.ok,false); assert.ok(checked.violations.some(v=>v.includes('summary source')));
  }
});

test('Han report passes verified claim checks and preserves Feature request classification', () => {
  const report=hanFixture('1. Han đề xuất kiểm tra cấu hình; chưa thực hiện thay đổi.', 'Feature request');
  const result=checkWriterOutput({body:report.fullReport,claims:[{text:report.report.sections[3].body,finding_ids:['S1'],inference:true}],customer_letter:null,letter_finding_ids:[]},
    {category:'Feature request',findings:[{id:'S1',kind:'suggestion',verified:true}]}, {hanReport:true,commentMaxChars:20000,commentMinChars:10,letterMinScore:.9});
  assert.equal(result.ok,true,result.violations.join('; '));
});

test('read-only API returns the saved report for that run, excludes chat/mail, rejects mismatch and preserves legacy', async () => {
  const root=await mkdtemp('/tmp/han-report-api-'); const statePath=root+'/state.json';
  const job={id:'job1',runId:'run1',ticketId:'ticket1',reference:'APPT-261024-bNhP4R',category:'Customize',status:'uncertain',createdAt:'2026-10-25T00:00:00Z',report:source.report,comment:source.comment};
  const historical={...job,id:'historical',...reportArtifacts(source.report,{commentFormatVersion:HISTORICAL_HAN_COMMENT_VERSION})}; delete historical.commentFormatVersion;
  const jobs={job1:job,historical, chat:{...job,id:'chat',mode:'reply'},mail:{...job,id:'mail',mode:'draft'},legacy:{...job,id:'legacy',report:null,comment:'Sau khi TS check thì thấy như sau:\nĐây là loại ticket gì : Bug\n\nCũ'}};
  await writeFile(statePath,JSON.stringify({jobs})); const before=JSON.stringify({jobs});
  const options={root,statePath,now:Date.parse('2026-10-25T06:00:00Z')};
  const list=await readHanReports(options); assert.deepEqual(new Set(list.reports.map(r=>r.id)),new Set(['job1','legacy','historical']));
  const detail=await readHanReports({...options,id:'job1',runId:'run1'});
  assert.equal(detail.fullReport,source.fullReport);assert.equal(detail.comment,source.comment);assert.equal(detail.status,'uncertain');assert.equal(detail.ticketId,'ticket1');
  assert.equal((await readHanReports({...options,id:'legacy'})).fullReport,null);
  const old=await readHanReports({...options,id:'historical'}); assert.equal(old.comment,historical.comment); assert.equal(old.fullReport,source.fullReport);
  assert.equal(formatReviewComment(old.comment,old.category),old.comment);
  assert.equal(await readFile(statePath,'utf8'),before);
  await assert.rejects(readHanReports({...options,id:'../secret'}),/Invalid/);
  await assert.rejects(readHanReports({...options,id:'job1',runId:'run2'}),/thay đổi/);
  assert.equal(JSON.stringify({jobs}),before);
  job.comment='Bản comment đã lưu khác projection, không được tự ghi đè.';await writeFile(statePath,JSON.stringify({jobs}));
  assert.equal((await readHanReports({...options,id:'job1',runId:'run1'})).comment,job.comment);
  job.artifactDir='/tmp/runtime/check-ticket/jobs/job1/other-run';await writeFile(statePath,JSON.stringify({jobs}));
  const conflict=await readHanReports({...options,id:'job1',runId:'run1'});
  assert.equal(conflict.comment,null);assert.equal(conflict.canonical.provenance,'conflict');
});

test('analytics recognizes old/new reviews but not ACK, chat, mail or human-authored reports', () => {
  const action=content=>({type:'commentTicket',author:{memberId:ANDREW_ID},metadata:{content}});
  for(const text of [source.comment,reportArtifacts(source.report,{commentFormatVersion:HISTORICAL_HAN_COMMENT_VERSION}).comment,'Sau khi TS check thì thấy như sau:\nĐây là loại ticket gì : Bug']) assert.equal(isAiReviewComment(action(text)),true);
  for(const text of ['Dạ chờ em check xíu nha','Dạ vâng ạ','[DRAFT — mail theo yêu cầu]\n'+source.comment,`**${HAN_GREETING}**\nChào anh`]) assert.equal(isAiReviewComment(action(text)),false);
  const human=action(source.comment);human.author.authUid='human';assert.equal(isAiReviewComment(human),false);
});
