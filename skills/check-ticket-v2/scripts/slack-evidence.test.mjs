import { hanFixture } from '../../../scripts/fixtures/han-report.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSlackEvidence, slackRequirement, parseThread, claimsNoDevReply } from './slack-evidence.mjs';
import { scoreQuote, verifyFindings } from './verify.mjs';
import { checkWriterOutput } from './postcheck.mjs';
import { prepare, followUpContext } from './prepare.mjs';
import { investigatorPrompt, writerPrompt } from './prompts.mjs';
import { runPipeline } from './pipeline.mjs';
import { executeReview, normalizeLimits } from '../../check-ticket/scripts/core.mjs';
import { followUpWindow } from '../../check-ticket/scripts/bot-command.mjs';
import { TicketReviewService } from '../../check-ticket/scripts/service.mjs';
import { ANDREW_ID, postComment, findPostedComment } from '../../check-ticket/scripts/adapters.mjs';

const link = 'https://avadaio.slack.com/archives/C083Z2KTZQS/p1792602394612479';
const rootTs = '1792602394.612479', replyTs = '1792644927.662819';
const correction = 'oct/cct: Strictly Required, không phải Analytics. Add/Edit rồi Save; không cần scan lại.';
const ticket = () => ({ id: 't1', ticketId: 'CB-test', appName: 'Cookie Bar', tsStatus: 'dev_fixing', subject: 'Kiểm tra cookie', description: 'Kiểm tra dữ liệu', storeDomains: [], slackLink: link, comments: [] });
const parent = (count = 1) => ({ ts: rootTs, text: 'Question for dev', reply_count: count, latest_reply: count ? replyTs : undefined });
const reply = () => ({ ts: replyTs, thread_ts: rootTs, user: 'UDEV', text: correction });
const response = (data, status = 200, headers = {}) => ({ ok: status >= 200 && status < 300, status, headers: new Headers(headers), json: async () => data });
const full = () => response({ ok: true, messages: [parent(), reply()], has_more: false });
const read = (fetchImpl = async () => full(), options = {}) => readSlackEvidence(ticket(), { token: 'fixture-private-token', fetchImpl, ...options });
const finding = (ref = `slack:C083Z2KTZQS:${replyTs}`, quote = correction) => ({ id: 'S1', kind: 'fact', claim: 'Theo dev: oct/cct là Strictly Required; không cần scan lại.', quote, source: { type: 'slack', ref } });
const verify = (slack, findings = [finding()]) => verifyFindings({ category: 'Question', findings, summary: 'Dev correction' }, { slack, ticketText: 'ticket', toolLog: [] });
const settings = { commentMinChars: 1, commentMaxChars: 5000, letterMinScore: 0.7 };
const written = text => ({ body: text, claims: [{ text, finding_ids: ['S1'], inference: false }], customer_letter: null, letter_finding_ids: [] });

test('field-only and comment-only links are canonicalized, reply permalinks use parent thread_ts', () => {
  assert.equal(slackRequirement(ticket()).threads[0].url, link);
  const t = { ...ticket(), slackLink: '', comments: [{ content: `[dev](${link}):` }, { content: link }] };
  assert.equal(slackRequirement(t).threads.length, 1);
  assert.equal(parseThread(`${link}?thread_ts=1792000000.000001`).rootTs, '1792000000.000001');
  assert.equal(slackRequirement({ ...ticket(), slackLink: '' }, { instruction: 'xem phản hồi dev' }).error, 'missing_thread_link');
  assert.equal(slackRequirement({ ...ticket(), slackLink: 'https://evil.test/archives/C083/p1792602394612479' }).error, 'invalid_host');
  assert.equal(slackRequirement({ ...ticket(), slackLink: '' }).required, false);
});

test('GET backend keeps complete thread and message provenance; credentials stay out of evidence', async () => {
  const seen = [];
  const evidence = await read(async (url, opts) => { seen.push([String(url), opts]); return full(); });
  assert.equal(evidence.complete, true); assert.equal(evidence.threads[0].replyCount, 1);
  assert.equal(evidence.threads[0].messages[1].ref, `slack:C083Z2KTZQS:${replyTs}`);
  assert.equal(evidence.threads[0].messages[1].text, correction);
  assert.ok(evidence.fetchedAt); assert.equal(evidence.threads[0].pages, 1);
  assert.equal(seen[0][1].method, 'GET'); assert.equal(seen[0][1].redirect, 'error');
  assert.match(seen[0][0], /^https:\/\/slack.com\/api\/conversations.replies\?/);
  assert.ok(!JSON.stringify(evidence).includes('fixture-private-token'));
});

test('pagination reads through next_cursor, dedups identical overlap, verifies root/reply count', async () => {
  const seen = [];
  const evidence = await read(async url => {
    const cursor = new URL(url).searchParams.get('cursor'); seen.push(cursor);
    return cursor ? response({ ok: true, messages: [parent(), reply()] }) : response({ ok: true, messages: [parent()], has_more: true, response_metadata: { next_cursor: 'page2' } });
  });
  assert.deepEqual(seen, [null, 'page2']); assert.equal(evidence.threads[0].pages, 2);
  assert.equal(evidence.threads[0].messages.length, 2);
});

test('reply permalink in comment is covered by field thread; standalone reply resolves exact parent', async () => {
  let calls = 0;
  const replyLink = link.replace('1792602394612479', replyTs.replace('.', ''));
  const t = { ...ticket(), comments: [{ content: `[correction](${replyLink}):` }] };
  const e = await readSlackEvidence(t, { token: 'fixture', fetchImpl: async () => { calls++; return full(); } });
  assert.equal(e.complete, true); assert.equal(calls, 1); assert.equal(e.threads.length, 1);
  const seen = [];
  const standalone = await readSlackEvidence({ ...t, slackLink: '' }, { token: 'fixture', fetchImpl: async url => {
    const u = new URL(url); seen.push(u);
    if (u.pathname.endsWith('history')) { assert.equal(u.searchParams.get('oldest'), replyTs); assert.equal(u.searchParams.get('latest'), replyTs); return response({ ok: true, messages: [reply()] }); }
    if (u.searchParams.get('ts') === replyTs) return response({ ok: false, error: 'thread_not_found' });
    return full();
  } });
  assert.equal(standalone.complete, true); assert.equal(standalone.threads[0].rootTs, rootTs); assert.equal(seen.length, 3);
});

for (const [name, data, expected] of [
  ['missing root', { messages: [reply()] }, 'missing_root'],
  ['missing reply', { messages: [parent()] }, 'reply_count_mismatch'],
  ['missing count', { messages: [{ ts: rootTs, thread_ts: rootTs, text: 'root' }] }, 'missing_reply_count'],
  ['missing cursor', { messages: [parent()], has_more: true }, 'missing_cursor'],
  ['missing latest', { messages: [{ ...parent(), latest_reply: '1792649999.000001' }, reply()] }, 'missing_latest_reply'],
  ['cross thread', { messages: [parent(), { ...reply(), thread_ts: '1792000000.000001' }] }, 'invalid_message'],
]) test(`incomplete ${name} never becomes empty success`, async () => {
  const evidence = await read(async () => response({ ok: true, ...data }));
  assert.equal(evidence.status, 'incomplete'); assert.equal(evidence.complete, false); assert.equal(evidence.errors[0].code, expected);
});

test('valid unthreaded root is complete with zero replies; reply ts response may start at parent', async () => {
  const empty = await read(async () => response({ ok: true, messages: [{ ts: rootTs, text: 'Question' }], has_more: false }));
  assert.equal(empty.complete, true); assert.equal(empty.threads[0].replyCount, 0);
  const replyLink = link.replace('1792602394612479', replyTs.replace('.', ''));
  const result = await readSlackEvidence({ ...ticket(), slackLink: replyLink }, { token: 'fixture', fetchImpl: async () => response({ ok: true, messages: [{ ...parent(), thread_ts: rootTs }, reply()] }) });
  assert.equal(result.complete, true); assert.equal(result.threads[0].rootTs, rootTs);
});

test('repeated cursors, page and size bounds fail closed', async () => {
  const more = () => response({ ok: true, messages: [parent()], has_more: true, response_metadata: { next_cursor: 'same' } });
  assert.equal((await read(async () => more())).errors[0].code, 'repeated_cursor');
  assert.equal((await read(async () => more(), { maxPages: 1 })).errors[0].code, 'page_limit');
  assert.equal((await read(undefined, { maxChars: 10 })).errors[0].code, 'context_limit');
});

test('429 honors Retry-After within whole-read deadline; never retries auth', async () => {
  let calls = 0, clock = 1000; const waits = [];
  const result = await read(async () => ++calls === 1 ? response({}, 429, { 'retry-after': '2' }) : full(), { now: () => clock, sleep: async ms => { waits.push(ms); clock += ms; }, timeoutMs: 5000 });
  assert.equal(result.complete, true); assert.deepEqual(waits, [2000]); assert.equal(calls, 2);
  assert.equal((await read(async () => response({}, 429, { 'retry-after': '60' }), { timeoutMs: 1000 })).errors[0].code, 'rate_limited_deadline');
  calls = 0;
  const auth = await read(async () => { calls++; return response({ ok: false, error: 'invalid_auth' }); });
  assert.equal(auth.errors[0].code, 'invalid_auth'); assert.equal(calls, 1);
  assert.equal((await read(async () => response({}, 403))).errors[0].code, 'http_403');
  assert.equal((await read(async () => { throw new Error('fixture-private-token'); })).errors[0].code, 'network_or_request_timeout');
});

test('deadline and caller abort produce concrete incomplete outcome without secret leakage', async () => {
  let clock = 100;
  const result = await read(async () => { clock += 1001; return full(); }, { now: () => clock, timeoutMs: 1000 });
  assert.equal(result.errors[0].code, 'deadline'); assert.equal(result.complete, false);
  const abort = new AbortController(); abort.abort();
  assert.equal((await read(undefined, { signal: abort.signal })).errors[0].code, 'aborted');
});

test('zero new Helpdesk comments does not hide Slack reply older than sinceAt; correction reaches both prompts', async () => {
  const followUp = { instruction: 'check phản hồi dev', sinceAt: '2026-10-22T12:00:00Z', previousReport: 'oct/cct Analytics rồi scan lại' };
  const t = ticket(); assert.deepEqual(followUpContext(t, followUp).newComments, []);
  const prep = await prepare({ reference: 'CB-test', url: 'https://helpdesk.avada.net/tickets/CB-test' }, {
    evidence: async () => t, lessons: async () => [], statePath: '/nonexistent-fixture', preSettings: false, followUp,
    slackReader: (ticket, opts) => readSlackEvidence(ticket, { ...opts, token: 'fixture', fetchImpl: async () => full() }),
  });
  assert.equal(prep.slack.threads[0].messages[1].text, correction);
  assert.ok(prep.slack.threads[0].messages[1].at < followUp.sinceAt);
  const investigator = investigatorPrompt(prep, { deadline: Date.now() + 1000, maxTurns: 5 });
  const writer = writerPrompt(prep, verify(prep.slack), { maxChars: 5000, minChars: 1 });
  for (const prompt of [investigator, writer]) { assert.ok(prompt.includes(correction)); assert.ok(prompt.includes('KHÔNG có nghĩa Slack không cập nhật')); assert.ok(prompt.includes('không tin cậy')); }
});

test('Slack quote binds to exact message and complete snapshot, no cross-message fallback', async () => {
  const slack = await read();
  assert.equal(scoreQuote(finding(), { slack }).where, 'slack');
  assert.equal(scoreQuote(finding(`slack:C083Z2KTZQS:${rootTs}`), { slack, ticketText: correction }).score, 0);
  assert.equal(scoreQuote(finding(), { slack: { ...slack, complete: false }, ticketText: correction }).score, 0);
  assert.equal(verify(slack).slackProblems.length, 0);
  assert.ok(verify(slack, []).slackProblems.some(message => message.includes(`slack:C083Z2KTZQS:${replyTs}`)), 'missing technical/correction coverage remains blocked');
});

test('writer must include latest correction; unsupported no-reply claim cannot use unrelated verified IDs', async () => {
  const slack = await read(), verified = verify(slack);
  assert.equal(checkWriterOutput(written('Theo phản hồi dev, oct/cct nên chọn Strictly Required; không cần scan lại.'), verified, settings).ok, true);
  for (const text of ['Dev chưa phản hồi.', 'Chưa có dữ liệu kỹ thuật mới từ khách/dev.', 'No new response from developer.']) {
    assert.equal(claimsNoDevReply(text), true);
    assert.ok(checkWriterOutput(written(text), verified, settings).violations.some(x => /dev chưa/.test(x)));
  }
  assert.equal(claimsNoDevReply('CSE đã nhận việc theo Slack nhưng chưa có biên nhận gửi hoặc xác nhận khách đã Save. Lượt này chỉ tra cứu, không đăng Slack/Helpdesk, không đổi status và không cập nhật shop.'), false);
  assert.equal(claimsNoDevReply('Chưa có xác nhận khách đã lưu sau phản hồi dev.'), false);
  assert.ok(checkWriterOutput(written('Khách đã lưu thay đổi cookie.'), verified, settings).violations.some(x => /khách đã lưu/.test(x)));
  const old = { id: 'F1', kind: 'fact', verified: true, source: { ref: 'ticket' } };
  const output = written('Chờ TS bổ sung vào thread cũ.'); output.claims[0].finding_ids = ['F1'];
  assert.ok(checkWriterOutput(output, { ...verified, findings: [...verified.findings, old] }, settings).violations.some(x => /bỏ qua/.test(x)));
  const falseFinding = { ...finding(), claim: 'Dev chưa trả lời.' };
  assert.ok(verify(slack, [falseFinding]).slackProblems.some(x => /không có bằng chứng/.test(x)));
});

test('short reply and draft do not replace last technical review baseline', () => {
  const jobs = Object.fromEntries(['review', 'reply', 'draft'].map((mode, i) => [mode, { id: mode, ticketId: 't1', mode, status: 'done', finishedAt: `2026-10-22T0${i}:00:00Z`, comment: mode }]));
  assert.equal(followUpWindow({ jobs, ticketId: 't1', commentAt: '2026-10-22T12:00:00Z' }).previousJobId, 'review');
});

test('both automatic/manual modes stop before model on mandatory Slack failure; core refuses success delivery', async () => {
  const slack = { required: true, status: 'incomplete', complete: false, threads: [], errors: [{ code: 'invalid_auth' }] };
  for (const mode of ['automatic', 'manual']) {
    const jobDir = await mkdtemp(join(tmpdir(), 'slack-incomplete-'));
    const prep = { ticket: ticket(), slack, app: { slug: 'cookie-bar' } };
    const result = await runPipeline('CB-test', { mode, settings: {}, jobDir, prepareTicket: async () => prep });
    assert.equal(result.status, 'incomplete'); assert.equal(result.writer, undefined);
    assert.equal(JSON.parse(await readFile(join(jobDir, 'slack-evidence.json'), 'utf8')).errors[0].code, 'invalid_auth');
    await assert.rejects(executeReview('CB-test', { hancal: async () => result }, normalizeLimits({ analysis: 'hancal' })), /no usable report/);
  }
});

test('Slack incomplete retry/restart preserves one ACK and posts at most one report after success', async () => {
  const time = Date.parse('2026-10-22T12:00:00Z'); const posts = [];
  const actions = [{ id: 'command', createdAt: new Date(time - 1000).toISOString(), author: { memberId: ANDREW_ID }, metadata: { content: '@han check phản hồi dev' } }];
  const job = { id: 'cmd-command', reference: 'CB-test', ticketId: 't1', trigger: 'bot_command', mode: 'review', status: 'queued', attempts: 0, telegram: {},
    command: { commentId: 'command', instruction: 'check phản hồi dev', kind: 'follow_up', createdAt: new Date(time - 1000).toISOString() }, ack: { status: 'pending', attempts: 0, content: 'Dạ chờ em check xíu nha' } };
  const get = async (path, opts = {}) => {
    if (opts.method === 'POST') { const id = `posted-${posts.length + 1}`; posts.push(opts.body.content); actions.push({ id, createdAt: new Date(time).toISOString(), author: opts.body.author, metadata: { content: opts.body.content } }); return { id }; }
    if (path.startsWith('/members')) return { members: [{ id: ANDREW_ID, displayName: 'Andrew', photoURL: 'https://fixture.test/avatar' }] };
    if (path.includes('/actions?')) return { actions, total: actions.length };
    return { ticket: { id: 't1' } };
  };
  let complete = false;
  const options = { root: await mkdtemp(join(tmpdir(), 'slack-controller-')), config: { enabled: true, maxAttempts: 3 }, now: () => time, get,
    post: (id, body, mentions) => postComment(id, body, get, mentions), find: (id, body, scope) => findPostedComment(id, body, get, scope),
    review: async () => executeReview('CB-test', { hancal: async () => complete
      ? { status: 'ok', ticketId: 't1', category: 'Question', writer: { body: hanFixture('Theo phản hồi dev mới nhất, oct/cct chọn Strictly Required; không cần scan lại.').fullReport }, counts: {}, verified: {} }
      : { status: 'incomplete', error: 'Slack invalid_auth' } }, normalizeLimits({ analysis: 'hancal' })),
  };
  const configure = state => { const s = new TicketReviewService(options); s.state = state; s.change = async fn => fn(s.state); s.log = () => {}; s.notice = async () => true; s.terminalNotice = async () => {}; return s; };
  let service = configure({ jobs: { [job.id]: job }, commands: { command: job.id } });
  await service.processOne();
  assert.equal(posts.length, 1); assert.equal(job.ack.status, 'sent'); assert.equal(job.commentId, undefined);
  const restarted = structuredClone(service.state); restarted.jobs[job.id].nextAttemptAt = 0;
  service = configure(restarted); complete = true;
  await service.processOne(); await service.processOne();
  assert.equal(posts.filter(x => x === 'Dạ chờ em check xíu nha').length, 1);
  assert.equal(posts.length, 2); assert.equal(service.state.jobs[job.id].status, 'done');
});
