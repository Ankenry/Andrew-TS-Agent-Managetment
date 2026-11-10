// node --test skills/check-ticket-v2/scripts/ — the controller's `analysis: hancal` branch (skills/check-ticket/scripts/core.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { executeReview, normalizeLimits, describeHancalFindings, DEMO_FALLBACK } from '../../check-ticket/scripts/core.mjs';
import { formatReviewComment } from '../../check-ticket/scripts/handoff.mjs';

const limits = { analysis: 'hancal', hancalTimeoutMs: 500, eliteTimeoutMs: 200, classificationTimeoutMs: 200, branchTimeoutMs: 200, demoTimeoutMs: 200 };
const analysis = (overrides = {}) => ({
  status: 'ok', category: 'Bug', ticketId: 'internal-id', runId: 'r1', jobDir: '/tmp/job/v2', browserAllowed: false,
  writer: { body: 'Flow vẫn bật nhưng không có run ngày 08/10.\n- Cron publisher chạy `0 0 * * *` theo UTC.' },
  postcheck: { ok: true, violations: [] },
  verified: { category: 'Bug', summary: 'tóm tắt', stats: { total: 2, facts: 1, gaps: 1 }, findings: [
    { id: 'F1', kind: 'fact', score: 1, claim: 'Cron chạy 0 0 * * *', source: { ref: 'apps_doc/joy/x.js', line: 45 } },
    { id: 'G1', kind: 'gap', score: null, blocker: 'dev', gap_ok: true, claim: 'Thiếu log' },
  ] },
  timings: { prepare: 1000, investigate: 90000, verify: 50, write: 60000 }, counts: { toolCalls: 12, browserCalls: 0 },
  customerLetter: null, ...overrides,
});
function harness(result) {
  const calls = []; const saved = {};
  const io = {
    progress: async () => {}, save: async (name, data) => { saved[name] = data; }, trace: () => {},
    hancal: async target => { calls.push(['hancal', target.url]); return typeof result === 'function' ? result() : result; },
    elite: async () => { calls.push(['elite']); return 'elite answer'; },
    worker: async phase => { calls.push([phase]); throw new Error('worker must not run in hancal mode'); },
    evidence: async () => ({ id: 'internal-id', subject: 'Ticket' }), browser: async () => { calls.push(['browser']); throw new Error('no browser'); },
    demoAvailable: async () => false, upload: async () => 'https://demo.test/x',
  };
  return { io, calls, saved };
}

test('normalizeLimits defaults to hancal, keeps elite, rejects unknown modes and caps the hancal deadline', () => {
  assert.equal(normalizeLimits({}).analysis, 'hancal');
  assert.equal(normalizeLimits({ analysis: 'elite' }).analysis, 'elite');
  assert.equal(normalizeLimits({ analysis: 'gpt' }).analysis, 'hancal');
  assert.equal(normalizeLimits({ hancalTimeoutMs: 9_000_000 }).hancalTimeoutMs, 600000);
  assert.equal(normalizeLimits({ hancalTimeoutMs: 0 }).hancalTimeoutMs, 600000);
  assert.equal(normalizeLimits({ hancalTimeoutMs: 120000 }).hancalTimeoutMs, 120000);
});

test('hancal mode runs the v2 pipeline once, never Elite or workers, and composes the wrapped comment', async () => {
  const h = harness(analysis());
  const review = await executeReview('JOY-261008-8f3cBn', h.io, limits);
  assert.deepEqual(h.calls, [['hancal', 'https://helpdesk.avada.net/tickets/JOY-261008-8f3cBn']]);
  assert.equal(review.ticketId, 'internal-id');
  assert.equal(review.category, 'Bug');
  assert.equal(review.analysis, 'hancal');
  assert.equal(review.comment, formatReviewComment(analysis().writer.body, 'Bug'));
  assert.match(review.comment, /^Sau khi TS check thì thấy như sau:\nĐây là loại ticket gì : Bug\n\n/);
  assert.equal(h.saved['comment.txt'], review.comment);
  assert.equal(h.saved['review.json'].hancal.counts.toolCalls, 12);
  assert.match(h.saved['analysis.txt'], /F1 \[fact\] điểm 1\.0.*apps_doc\/joy\/x\.js:45/);
  assert.match(h.saved['analysis.txt'], /G1 \[gap\] điểm - · dev/);
  assert.equal(h.saved['elite.txt'], undefined);
  assert.equal(review.audit[0].phase, 'hancal'); assert.equal(review.audit[0].status, 'complete');
});

test('Customize keeps the demo fallback sentence; browser calls mark the result as verified', async () => {
  const h = harness(analysis({ category: 'Customize', browserAllowed: true, counts: { toolCalls: 5, browserCalls: 1 } }));
  const review = await executeReview('JOY-261007-nRDnQV', h.io, limits);
  assert.ok(review.comment.endsWith(DEMO_FALLBACK));
  assert.equal(review.result.verified, true); assert.equal(review.result.browserCheck, 'storefront');
});

test('a failed, rejected, provider-mentioning or category-less v2 result never becomes a comment', async () => {
  for (const [bad, pattern] of [
    [analysis({ status: 'failed', error: 'Điều tra không nộp được findings', writer: null }), /no usable report \(failed: Điều tra/],
    [analysis({ status: 'writer_rejected', postcheck: { ok: false, violations: ['body nhắc Elite', 'claims rỗng'] } }), /writer_rejected: body nhắc Elite; claims rỗng/],
    [analysis({ writer: { body: 'Theo TS Elite 2 thì lỗi.' } }), /must not mention/],
    [analysis({ category: 'Khác' }), /no usable report/],
    [analysis({ ticketId: null }), /ticket ID/],
  ]) {
    const h = harness(bad);
    await assert.rejects(executeReview('JOY-1', h.io, limits), pattern);
    assert.equal(h.saved['comment.txt'], undefined);
  }
});

test('hancal deadline aborts the pipeline and reports a timeout phase', async () => {
  const h = harness(() => new Promise(() => {}));
  await assert.rejects(executeReview('JOY-1', h.io, { ...limits, hancalTimeoutMs: 50 }), /Deadline exceeded: hancal/);
  assert.equal(h.saved['comment.txt'], undefined);
});

test('elite mode still takes the former path and an IO without hancal fails fast in hancal mode', async () => {
  const h = harness(analysis());
  h.io.worker = async () => ({ category: 'Question', canCustomize: null, bugType: 'unknown', browserCheck: 'none', verificationNotes: '', reason: '', comment: 'Cần kiểm tra cấu hình.', css: '', storefrontUrl: '', verified: false, screenshotPath: '', screenshotVerified: false });
  const review = await executeReview('CB-1', h.io, { ...limits, analysis: 'elite' });
  assert.equal(h.calls[0][0], 'elite'); assert.ok(!h.calls.some(call => call[0] === 'hancal')); assert.equal(review.category, 'Question');
  delete h.io.hancal;
  await assert.rejects(executeReview('CB-1', h.io, limits), /not available/);
});

test('describeHancalFindings is empty without findings', () => { assert.equal(describeHancalFindings({}), ''); assert.equal(describeHancalFindings(null), ''); });

test('a "@bot" follow-up is handed to the pipeline as data and refused in elite mode (13/10/2026)', async () => {
  const seen = [];
  const h = harness(analysis({ followUp: { newComments: 2 } }));
  h.io.hancal = async (target, context, followUp) => { seen.push(followUp); return analysis(); };
  const followUp = { instruction: 'xem lại console theo ảnh', commentId: 'c2', sinceAt: '2026-10-12T12:00:00.000Z', previousReport: 'cũ' };
  const review = await executeReview('JOY-261012-yaATZq', h.io, limits, { followUp });
  assert.deepEqual(seen, [followUp]);
  assert.equal(review.followUp.instruction, 'xem lại console theo ảnh'); assert.equal(review.followUp.commentId, 'c2');
  await assert.rejects(executeReview('JOY-1', h.io, { ...limits, analysis: 'elite' }, { followUp }), /hancal/);
});
