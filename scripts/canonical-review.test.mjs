import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { canonicalReview } from '../skills/check-ticket/scripts/canonical-review.mjs';
import { readHanReports } from '../skills/check-ticket/scripts/han-reports.mjs';
import { conversationFromJob } from '../skills/check-ticket/scripts/history.mjs';

const job = { id:'job1', ticketId:'ticket1', reference:'CHAT-261101-fixture', runId:'run1', category:'Bug', status:'done',
  createdAt:'2026-11-01T01:00:00Z', finishedAt:'2026-11-01T01:05:00Z', commentId:'receipt1',
  artifactDir:'/tmp/runtime/check-ticket/jobs/job1/run1', comment:'Sau khi TS check thì thấy như sau:\nĐây là loại ticket gì : Bug\n\nChưa xác nhận nguyên nhân.' };

test('saved controller receipt requires comment, run binding, valid ID and completion; unknown never promotes', () => {
  const before=JSON.stringify(job);
  assert.equal(canonicalReview(job).delivery.confirmed,true);
  for(const fields of [{status:'queued'},{status:'ready'},{status:'posting'},{status:'uncertain'},{status:'needs_attention'},
    {commentId:null},{commentId:'../bad'},{finishedAt:null},{finishedAt:'2026-10-01'},{artifactDir:null},{runId:null,artifactDir:null},{comment:''}]) {
    const result=canonicalReview({...job,...fields});
    assert.equal(result.delivery.confirmed,false,JSON.stringify(fields));
    assert.doesNotMatch(result.statusLabel,/^Đã xác nhận/);
  }
  assert.equal(JSON.stringify(job),before);
});

test('conflicting run, category or reused receipt hides result and never falls back to report', () => {
  for(const fields of [{runId:'run2'},{runId:'../secret'},{ticketId:'../secret'},{report:{category:'Customize'}}]) {
    const result=canonicalReview({...job,...fields});
    assert.equal(result.comment,null);assert.equal(result.canonical.provenance,'conflict');assert.equal(result.delivery.confirmed,false);
  }
  assert.equal(canonicalReview(job,{jobs:[job,{...job,id:'job2',runId:'run2'}]}).comment,null);
});

test('legacy exact comment remains visible with notice; missing comment has no synthesized result', () => {
  const legacy={...job,runId:undefined,artifactDir:undefined,comment:'  Báo cáo cũ\n\n```css\n.x {color:red}\n```\n  '};
  assert.equal(canonicalReview(legacy).comment,legacy.comment);
  assert.equal(canonicalReview(legacy).canonical.provenance,'legacy');
  assert.match(canonicalReview(legacy).canonical.notice,/thiếu dữ liệu/);
  const missing=canonicalReview({...job,comment:undefined,report:{category:'Bug',sections:[]}});
  assert.equal(missing.comment,null);assert.match(missing.canonical.notice,/Chưa có bản comment/);
});

test('API and History preserve exact long comment, hash and full source; do not read or reproject analysis', async () => {
  const root=await mkdtemp('/tmp/canonical-review-');const statePath=root+'/state.json';
  const long={...job,comment:job.comment+'\n\n```js\n'+Array.from({length:1500},(_,i)=>`const value${i} = "<img src=x>";`).join('\n')+'\n```\n\nCaveat cuối: chưa thử storefront.\n',
    report:{category:'Bug',version:'han-support-v1',sections:[{id:1,body:'SOURCE RETAINED — deliberately not canonical comment'}]}};
  const state=JSON.stringify({jobs:{job1:long}});await writeFile(statePath,state);
  const data=await readHanReports({root,statePath,id:'job1',runId:'run1'});
  const history=conversationFromJob(long,{analysis:'OLD ANALYSIS MUST NOT APPEAR'});
  assert.ok(long.comment.length>20000);
  assert.equal(data.comment,long.comment);assert.equal(history.messages.at(-1).text,long.comment);
  assert.equal(data.canonical.sha256,createHash('sha256').update(long.comment).digest('hex'));
  assert.deepEqual(data.report,long.report);assert.equal(history.messages.filter(m=>m.canonical).length,1);
  assert.ok(!JSON.stringify(history).includes('OLD ANALYSIS'));assert.equal(await readFile(statePath,'utf8'),state);
  await assert.rejects(readHanReports({root,statePath,id:'job1',runId:'run2'}),/Lượt check đã thay đổi/);
  const next={...long,runId:'run2',artifactDir:'/tmp/runtime/check-ticket/jobs/job1/run2'};
  assert.notEqual(conversationFromJob(next).automatic.revision,history.automatic.revision);
  assert.equal(conversationFromJob({...long,commentId:null}).automatic.status,'uncertain');
});
