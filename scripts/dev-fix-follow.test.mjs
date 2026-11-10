import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  currentSlot, threadKey, meaningfulAt, normalizeAssessment, decideDraft, decideProgress, formatProgressComment, formatDraftComment,
  assertCommentIsClean, summaryText, RESULT_SCHEMA,
} from '../skills/dev-fix-follow/scripts/core.mjs';
import { executeRun } from '../skills/dev-fix-follow/scripts/service.mjs';
import { parseSlackThreadLink, assessmentEvidence, readFollowEvidence } from '../skills/dev-fix-follow/scripts/adapters.mjs';

const TZ = 'Asia/Ho_Chi_Minh';
const SLOTS = ['10:00', '14:00', '18:00', '22:00'];
const CONFIG = { slots: SLOTS, timeZone: TZ, commentPolicy: 'on-change-or-daily', concurrency: 2, runTimeoutMs: 60_000, telegramSummary: true };
const at = local => new Date(`${local}:00+07:00`);

const assessment = (extra = {}) => ({ status: 'in_progress', progress: 'Dev đang kiểm tra log charge.', latestUpdate: 'Dev báo đang xem log.', latestMeaningfulAt: '', waitingFor: 'dev',
  customerRequests: [], draftKind: 'none', draftMail: '', confidence: 'high', evidence: '10:00 dev: đang xem log', ...extra });
const message = (ts, text, reactions = []) => ({ ts, at: new Date(Number.parseFloat(ts) * 1000).toISOString(), user: 'U1', text, reactions, assets: [] });

test('a scheduled run belongs to the latest slot at or before now', () => {
  assert.equal(currentSlot(at('2026-09-28T18:13'), SLOTS, TZ).key, '2026-09-28T18:00');
  assert.equal(currentSlot(at('2026-09-28T10:00'), SLOTS, TZ).label, '10:00 28/09/2026');
  assert.equal(currentSlot(at('2026-09-29T07:30'), SLOTS, TZ).key, '2026-09-28T22:00');
  assert.throws(() => currentSlot(at('2026-09-28T10:00'), ['25:00'], TZ));
});

test('thread key changes with a new message, an edit or a reaction', () => {
  const base = [message('1790000000.000100', 'a'), message('1790000100.000100', 'b')];
  const key = threadKey(base);
  assert.equal(threadKey(structuredClone(base)), key);
  assert.notEqual(threadKey([...base, message('1790000200.000100', 'c')]), key);
  assert.notEqual(threadKey([base[0], message('1790000100.000100', 'b edited')]), key);
  assert.notEqual(threadKey([base[0], message('1790000100.000100', 'b', [{ name: 'white_check_mark', count: 1 }])]), key);
});

test('reminders after the last meaningful message are not news', () => {
  const messages = [message('1790571629.131000', 'fix xong'), message('1790580000.000000', 'Bot: nhắc việc')];
  const thread = { latestAt: messages[1].at, messages };
  assert.equal(meaningfulAt({ latestMeaningfulAt: messages[0].at }, thread), messages[0].at);
  assert.equal(meaningfulAt({ latestMeaningfulAt: '2026-01-01T00:00:00.000Z' }, thread), messages[1].at);
  assert.equal(meaningfulAt({ latestMeaningfulAt: '' }, thread), messages[1].at);
});

test('a draft is kept only for its own status and never on a guess', () => {
  assert.equal(normalizeAssessment(assessment({ draftKind: 'done', draftMail: 'Hi' })).draftKind, 'none');
  const done = normalizeAssessment(assessment({ status: 'done', draftKind: 'done', draftMail: 'Hi Kaela' }));
  assert.equal(done.draftKind, 'done');
  const guess = normalizeAssessment(assessment({ status: 'done', draftKind: 'done', draftMail: 'Hi', confidence: 'low' }));
  assert.deepEqual([guess.draftKind, guess.draftMail, guess.draftWithheld], ['none', '', 'low_confidence']);
  const wrongKind = normalizeAssessment(assessment({ status: 'awaiting_customer', draftKind: 'done', draftMail: 'Hi' }));
  assert.equal(wrongKind.draftWithheld, 'missing_draft');
  assert.throws(() => normalizeAssessment({ ...assessment(), status: 'dev_reported_done' }));
  assert.deepEqual([...RESULT_SCHEMA.required].sort(), Object.keys(RESULT_SCHEMA.properties).sort());
});

test('an existing draft saved after the latest Slack message is not duplicated', () => {
  const done = normalizeAssessment(assessment({ status: 'done', draftKind: 'done', draftMail: 'Hi' }));
  const latestSlackAt = '2026-09-28T10:40:29.131Z';
  const comments = [{ content: '[DRAFT — dev báo done | Slack update: x]\n\nHi', createdAt: '2026-09-28T12:01:15.651Z' }];
  assert.equal(decideDraft({ assessment: done, comments, latestSlackAt, assessed: true }).action, 'exists');
  assert.equal(decideDraft({ assessment: done, comments, latestSlackAt: '2026-09-28T13:00:00.000Z', assessed: true }).action, 'post');
  assert.equal(decideDraft({ assessment: done, comments: [], latestSlackAt, assessed: true }).action, 'post');
  assert.equal(decideDraft({ assessment: done, comments: [], latestSlackAt, assessed: false }).action, 'none');
  assert.equal(decideDraft({ assessment: done, comments: [], latestSlackAt, assessed: false, pendingKind: 'done' }).action, 'post');
});

test('progress is posted on change, otherwise once a day', () => {
  const slot = currentSlot(at('2026-09-28T14:00'), SLOTS, TZ);
  const today = [{ content: '[DEV FOLLOW | 10:00 28/09/2026] Đang dev xử lý\n\nx', createdAt: '2026-09-28T03:00:10.000Z' }];
  const base = { policy: 'on-change-or-daily', slot, timeZone: TZ, key: 'k1', postedKey: 'k1', postedSlot: '2026-09-28T10:00' };
  assert.equal(decideProgress({ ...base, comments: today }).post, false);
  assert.equal(decideProgress({ ...base, comments: today, key: 'k2' }).reason, 'changed');
  assert.equal(decideProgress({ ...base, comments: today, policy: 'every-slot' }).post, true);
  const next = currentSlot(at('2026-09-29T10:00'), SLOTS, TZ);
  assert.equal(decideProgress({ ...base, slot: next, comments: today }).reason, 'daily');
  assert.equal(decideProgress({ ...base, postedSlot: slot.key, comments: today, policy: 'every-slot' }).post, false);
});

test('comments follow the ticket comment rules', () => {
  const slot = currentSlot(at('2026-09-28T18:00'), SLOTS, TZ);
  const waiting = normalizeAssessment(assessment({ status: 'awaiting_customer', waitingFor: 'khách', customerRequests: ['Link sản phẩm bị lỗi', 'Quyền staff'], draftKind: 'customer_info', draftMail: 'Hi' }));
  const content = formatProgressComment({ slot, status: waiting.status, assessment: waiting, latestSlackAt: '2026-09-28T10:40:29.131Z', changed: true, draft: { kind: 'customer_info', action: 'post' }, timeZone: TZ });
  assert.match(content, /^\[DEV FOLLOW \| 18:00 28\/09\/2026\] Chờ khách cung cấp thông tin\n\n/);
  assert.match(content, /Slack cập nhật gần nhất lúc 17:40 28\/09\/2026/);
  assert.match(content, /- Link sản phẩm bị lỗi\n- Quyền staff/);
  assert.match(content, /Đã lưu mail nháp/);
  assert.doesNotMatch(content, /\*\*|^#/m);
  const missing = formatProgressComment({ slot, status: 'missing_thread', assessment: null, latestSlackAt: '', changed: true, draft: null, timeZone: TZ });
  assert.match(missing, /chưa có link Slack thread/);
  assert.match(formatDraftComment('done', '2026-09-28T10:40:29.131Z', 'Hi Kaela,\n\nThe fix is ready.', undefined, 'Air Reviews'), /^\[DRAFT — dev báo done \| Slack update: 2026-09-28T10:40:29.131Z\]\n\nI am Andrew from the Air Reviews technical support team,/);
  assert.throws(() => assertCommentIsClean('Hachimi đã kiểm tra'));
  assert.throws(() => assertCommentIsClean('Theo TS Elite 2 thì'));
  assert.throws(() => formatDraftComment('done', '', '   '));
});

test('Slack links and AI evidence', () => {
  assert.deepEqual(parseSlackThreadLink('https://avadaio.slack.com/archives/C020QJ7F7RN/p1790549617631169'),
    { channel: 'C020QJ7F7RN', ts: '1790549617.631169', link: 'https://avadaio.slack.com/archives/C020QJ7F7RN/p1790549617631169' });
  assert.throws(() => parseSlackThreadLink('https://example.com/x'));
  const messages = Array.from({ length: 200 }, (_, index) => message(`${1790000000 + index}.000100`, `m${index}`));
  const data = assessmentEvidence({ slot: { label: 'x' }, evidence: { ticketId: 'T-1', subject: 's', description: 'd'.repeat(7000), comments: [] }, thread: { latestAt: '', users: {}, messages } });
  assert.equal(data.slack.messages.length, 150);
  assert.equal(data.slack.omittedMessages, 50);
  assert.equal(data.slack.messages.at(-1).text, 'm199');
  assert.ok(data.ticket.description.length < 6100);
});

test('the AI sees which ticket comments a person typed, so it can carry their image link into the mail', async () => {
  const actions = [
    { id: 'a1', author: { displayName: 'Andrew', memberId: 'm1' }, metadata: { content: '[DEV FOLLOW | 10:00 01/10/2026] Dev báo done' }, createdAt: '2026-10-01T03:00:00.000Z' },
    { id: 'a2', author: { displayName: 'Andrew', memberId: 'm1', authUid: 'uid-1' }, metadata: { content: 'Dev fix roài\nhttps://capture.avada.io/i/abc123' }, createdAt: '2026-10-01T04:00:00.000Z' },
  ];
  const paths = [];
  const evidence = await readFollowEvidence('T-1', async path => { paths.push(path); return path.includes('/actions?') ? { actions } : { ticket: { id: 'i1', ticketId: 'T-1', subject: 's' } }; });
  assert.equal(paths.length, 2);
  assert.deepEqual(evidence.comments.map(comment => comment.typed), [false, true]);
  assert.ok(!JSON.stringify(evidence).includes('uid-1'));
  const data = assessmentEvidence({ slot: { label: 'x' }, evidence, thread: { latestAt: '', users: {}, messages: [] } });
  assert.deepEqual(data.ticket.comments.map(comment => comment.typed), [false, true]);
  assert.ok(data.ticket.comments[1].content.includes('https://capture.avada.io/i/abc123'));
  // Evidence from an older reader, without the mark, counts as not typed.
  const plain = assessmentEvidence({ slot: { label: 'x' }, evidence: { ticketId: 'T-1', comments: [{ content: 'c', createdAt: 'x', author: 'A' }] }, thread: { latestAt: '', users: {}, messages: [] } });
  assert.equal(plain.ticket.comments[0].typed, false);
  assert.match(readFileSync(new URL('../skills/dev-fix-follow/SKILL.md', import.meta.url), 'utf8'), /Carry the evidence image/);
});

function fakeIO({ tickets, threads, answers, failPost = () => false }) {
  const calls = { assess: [], post: [], notify: [] };
  let state = { version: 1, tickets: {} };
  const comments = {};
  const io = {
    calls, comments, threads, answers, state: () => state,
    loadState: async () => structuredClone(state),
    saveState: async next => { state = structuredClone(next); },
    listTickets: async () => tickets.map(ticket => ({ id: ticket.id, ticketId: ticket.ticketId, subject: ticket.subject })),
    evidence: async reference => {
      const ticket = tickets.find(item => item.ticketId === reference || item.id === reference);
      if (!ticket) throw new Error('Helpdesk read failed.');
      return { appName: 'Air Reviews', ...ticket, comments: [...(comments[ticket.id] || [])] };
    },
    slackThread: async link => { if (!threads[link]) throw new Error('Không kết nối được Slack API.'); return threads[link]; },
    assess: async input => { calls.assess.push(input.evidence.ticketId); return answers[input.evidence.ticketId]; },
    post: async (id, content) => {
      if (failPost(id, content)) throw new Error('Helpdesk POST outcome is unknown.');
      calls.post.push({ id, content });
      (comments[id] ||= []).push({ content, createdAt: new Date(io.clock()).toISOString(), author: 'Andrew' });
    },
    notify: async run => { calls.notify.push(run); },
    clock: () => Date.now(),
  };
  return io;
}

const ticket = (id, ticketId, extra = {}) => ({ id, ticketId, subject: `Subject ${ticketId}`, description: '', tsStatus: 'dev_fixing', slackLink: `https://x.slack.com/archives/C1/p179000000000${id.length}00`, ...extra });
const thread = (...messages) => ({ link: 'l', rootTs: messages[0].ts, latestAt: messages.at(-1).at, users: {}, messages });

test('run: preview writes nothing, post saves the draft before the progress comment', async () => {
  const done = ticket('a', 'WISH-1');
  const io = fakeIO({ tickets: [done], threads: { [done.slackLink]: thread(message('1790571629.131000', 'fix xong, đã verify trên store')) },
    answers: { 'WISH-1': assessment({ status: 'done', progress: 'Dev đã fix và verify.', waitingFor: '', draftKind: 'done', draftMail: 'Hi Kaela, the issue is resolved.' }) } });
  const preview = await executeRun(io, CONFIG, { mode: 'preview', now: at('2026-09-28T18:05') });
  assert.equal(io.calls.post.length, 0);
  assert.equal(io.calls.notify.length, 0);
  assert.deepEqual(io.state().tickets, {});
  assert.match(preview.results[0].draft.content, /^\[DRAFT — dev báo done/);

  io.clock = () => at('2026-09-28T18:01').getTime();
  const run = await executeRun(io, CONFIG, { mode: 'scheduled', now: at('2026-09-28T18:00') });
  assert.equal(run.results[0].error, undefined);
  assert.deepEqual(io.calls.post.map(call => call.content.slice(0, 12)), ['[DRAFT — dev', '[DEV FOLLOW ']);
  assert.match(io.calls.post[1].content, /\] Dev báo done\n\nDev đã fix và verify\./);
  assert.equal(io.calls.notify.length, 1);
  assert.match(summaryText(run), /WISH-1 — Dev báo done · đã lưu mail nháp/);

  // Same slot again: nothing happens.
  const again = await executeRun(io, CONFIG, { mode: 'scheduled', now: at('2026-09-28T18:20') });
  assert.equal(again.skipped, 'slot_already_completed');

  // Next slot, unchanged thread: no AI call, no comment.
  io.clock = () => at('2026-09-28T22:01').getTime();
  const later = await executeRun(io, CONFIG, { mode: 'scheduled', now: at('2026-09-28T22:00') });
  assert.equal(io.calls.assess.length, 2); // preview + first scheduled run only
  assert.equal(io.calls.post.length, 2);
  assert.equal(later.results[0].progress.reason, 'unchanged_today');

  // A bot reminder is read by the AI again but is not news: no comment, no second draft.
  const fixedAt = io.threads[done.slackLink].messages[0].at;
  io.threads[done.slackLink] = thread(io.threads[done.slackLink].messages[0], message('1790590000.000000', 'Bot: nhắc cập nhật case'));
  io.answers['WISH-1'] = { ...io.answers['WISH-1'], latestMeaningfulAt: fixedAt };
  io.clock = () => at('2026-09-28T23:01').getTime();
  const reminded = await executeRun(io, CONFIG, { mode: 'post', now: at('2026-09-28T23:00') });
  assert.equal(io.calls.assess.length, 3);
  assert.equal(io.calls.post.length, 2);
  assert.deepEqual([reminded.results[0].draft.action, reminded.results[0].progress.reason], ['exists', 'unchanged_today']);

  // Next morning: the daily update, still without a new draft.
  io.clock = () => at('2026-09-29T10:01').getTime();
  const morning = await executeRun(io, CONFIG, { mode: 'scheduled', now: at('2026-09-29T10:00') });
  assert.equal(io.calls.assess.length, 3);
  assert.equal(io.calls.post.length, 3);
  assert.match(io.calls.post[2].content, /Thread Slack chưa có cập nhật mới/);
  assert.match(io.calls.post[2].content, /Slack cập nhật gần nhất lúc 12:00 28\/09\/2026/);
  assert.equal(morning.results[0].draft.action, 'exists');
});

test('run: failures stay visible and do not claim a draft', async () => {
  const waiting = ticket('b', 'JOY-2');
  const broken = ticket('cc', 'CB-3');
  const noThread = ticket('ddd', 'AIR-4', { slackLink: '' });
  const io = fakeIO({ tickets: [waiting, broken, noThread], threads: { [waiting.slackLink]: thread(message('1790571629.131000', 'cần khách gửi link sản phẩm')) },
    answers: { 'JOY-2': assessment({ status: 'awaiting_customer', waitingFor: 'khách', customerRequests: ['Link sản phẩm'], draftKind: 'customer_info', draftMail: 'Hi, could you share the product link?' }) },
    failPost: (id, content) => content.startsWith('[DRAFT') });
  const run = await executeRun(io, CONFIG, { mode: 'post', now: at('2026-09-28T15:30') });
  const [first, second, third] = run.results;
  assert.equal(first.draft.action, 'failed');
  assert.match(io.calls.post.find(call => call.id === 'b').content, /Chưa lưu được mail nháp/);
  assert.equal(io.state().tickets.b.draftPending, 'customer_info');
  assert.match(second.error, /Slack/);
  assert.equal(io.calls.post.some(call => call.id === 'cc'), false);
  assert.equal(third.status, 'missing_thread');
  assert.match(io.calls.post.find(call => call.id === 'ddd').content, /Thiếu Slack thread/);
  assert.equal(io.state().lastCompletedSlot, undefined);
  assert.match(summaryText(run), /Chưa xử lý được:\n• CB-3/);
});
