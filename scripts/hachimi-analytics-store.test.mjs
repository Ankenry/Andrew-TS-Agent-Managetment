// node --test scripts/hachimi-analytics-store.test.mjs — pure parts of the AI check analytics (no database, no Helpdesk).
import test from 'node:test';
import assert from 'node:assert/strict';
import { verdictFromReactions, isAiReviewComment, parseTicketReference, categoryFromComment, bucketize, parseRange, lessonsMarkdown, normalizeEmoji, pickRecentAssigned, feedbackNotice, feedbackNoticeEnabled, scheduleFeedbackNotice, DISCOVERY_DAYS, ANDREW_ID } from './hachimi-analytics-store.mjs';
import { sendTelegramText } from './telegram-send.mjs';
import { lessonsPromptSection } from '../skills/check-ticket/scripts/worker.mjs';

const me = [ANDREW_ID];

test('a 👍 from Đại tá marks the check correct, a 😢 marks it incorrect, a cry outranks a like', () => {
  assert.deepEqual(verdictFromReactions({ '👍': [ANDREW_ID] }, me), { verdict: 'correct', emoji: '👍' });
  assert.deepEqual(verdictFromReactions({ '😢': [ANDREW_ID] }, me), { verdict: 'incorrect', emoji: '😢' });
  assert.deepEqual(verdictFromReactions({ '👍': [ANDREW_ID], '😭': [ANDREW_ID] }, me).verdict, 'incorrect');
  assert.equal(verdictFromReactions({ '👍🏻': [ANDREW_ID] }, me).verdict, 'correct', 'skin tone ignored');
});

test('reactions from other members or other emoji do not judge the check', () => {
  assert.equal(verdictFromReactions({ '👍': ['someone-else'] }, me).verdict, 'pending');
  assert.equal(verdictFromReactions({ '🔥': [ANDREW_ID] }, me).verdict, 'pending');
  assert.equal(verdictFromReactions(undefined, me).verdict, 'pending');
  assert.equal(normalizeEmoji('❤️'), '❤');
});

test('an AI review comment is Andrew without authUid and starts with the fixed opening line', () => {
  const ai = { type: 'commentTicket', author: { memberId: ANDREW_ID, displayName: 'Andrew', photoURL: 'https://x' }, metadata: { content: 'Sau khi TS check thì thấy như sau:\nĐây là loại ticket gì : Bug\n\nbody' } };
  const typed = { ...ai, author: { ...ai.author, authUid: ANDREW_ID }, metadata: { content: 'Sau khi TS check thì thấy như sau:\nĐây là loại ticket gì : Bug' } };
  const other = { ...ai, metadata: { content: 'Chỗ này cần báo dev thêm' } };
  assert.equal(isAiReviewComment(ai), true);
  assert.equal(isAiReviewComment(typed), false, 'typed on the Helpdesk web');
  assert.equal(isAiReviewComment(other), false);
  assert.equal(categoryFromComment(ai.metadata.content), 'Bug');
});

test('ticket references are read from links and plain ids', () => {
  assert.equal(parseTicketReference('https://helpdesk.avada.net/t/AIR-261002-QSGTPD'), 'AIR-261002-QSGTPD');
  assert.equal(parseTicketReference('  JOY-261001-8Xpbw2 '), 'JOY-261001-8Xpbw2');
  assert.equal(parseTicketReference('https://helpdesk.avada.net/tickets/lBNiaRGbAJqgb0JLk0GU'), '');
});

test('daily buckets for a week, weekly buckets for a quarter, rate = correct / judged', () => {
  const range = { from: '2026-09-27T00:00:00.000Z', to: '2026-10-03T12:00:00.000Z' };
  const rows = [
    { comment_at: '2026-10-01T03:00:00.000Z', verdict: 'correct' }, { comment_at: '2026-10-01T05:00:00.000Z', verdict: 'incorrect' },
    { comment_at: '2026-10-01T06:00:00.000Z', verdict: 'pending' }, { comment_at: '2026-10-02T06:00:00.000Z', verdict: 'correct' },
  ];
  const daily = bucketize(rows, range);
  assert.ok(daily.length >= 7 && daily.length <= 8);
  const first = daily.find(bucket => bucket.correct === 1 && bucket.incorrect === 1);
  assert.equal(first.rate, 50); assert.equal(first.pending, 1); assert.equal(first.judged, 2);
  assert.equal(daily.find(bucket => bucket.correct === 1 && bucket.incorrect === 0).rate, 100);
  assert.equal(daily.find(bucket => bucket.judged === 0).rate, null);
  const weekly = bucketize(rows, { from: '2026-07-01T00:00:00.000Z', to: '2026-10-03T00:00:00.000Z' });
  assert.ok(weekly.length >= 13 && weekly.length <= 15, `weekly buckets: ${weekly.length}`);
  assert.equal(weekly.reduce((sum, bucket) => sum + bucket.correct, 0), 2);
});

test('parseRange defaults to the last 7 days and swaps reversed bounds', () => {
  const range = parseRange({});
  assert.ok(Date.parse(range.to) - Date.parse(range.from) === 7 * 86_400_000);
  const reversed = parseRange({ from: '2026-10-03', to: '2026-10-01' });
  assert.ok(Date.parse(reversed.from) < Date.parse(reversed.to));
  const month = parseRange({ days: 30 });
  assert.equal(Date.parse(month.to) - Date.parse(month.from), 30 * 86_400_000);
});

test('lessons are rendered as markdown and as a bounded prompt section', () => {
  const rows = [{ ticket: 'AIR-261002-QSGTPD', category: 'Question', verdict: 'incorrect', subject: 'Review request', description: 'Phải xem ảnh trước khi kết luận.', createdAt: '2026-10-03T01:00:00.000Z' }];
  const markdown = lessonsMarkdown(rows);
  assert.match(markdown, /## AIR-261002-QSGTPD · Question · AI check chưa đúng/);
  assert.match(markdown, /Phải xem ảnh trước khi kết luận\./);
  const section = lessonsPromptSection(rows.map(row => ({ ...row, feedback: row.description })));
  assert.match(section, /\[AIR-261002-QSGTPD · Question · bị đánh giá chưa đúng\] Phải xem ảnh trước khi kết luận\./);
  assert.equal(lessonsPromptSection([]), '');
});

test('discovery keeps tickets assigned to the reviewer, updated inside the window and not yet read at that updatedAt', () => {
  const since = Date.parse('2026-10-04T00:00:00Z');
  const tickets = [
    { id: 'manual1', ticketId: 'AIR-261011-Nf2D6y', subject: 'Air Reviews', memberIds: [ANDREW_ID, 'other'], updatedAt: '2026-10-11T10:51:35.829Z' },
    { id: 'old', ticketId: 'OLD-260901-aaaa', memberIds: [ANDREW_ID], updatedAt: '2026-09-01T00:00:00Z' },
    { id: 'notmine', ticketId: 'X-261011-bbbb', memberIds: ['other'], updatedAt: '2026-10-11T00:00:00Z' },
    { id: 'gone', ticketId: 'X-261011-cccc', memberIds: [ANDREW_ID], updatedAt: '2026-10-11T00:00:00Z', deletedAt: '2026-10-11T01:00:00Z' },
    { id: 'seen', ticketId: 'X-261011-dddd', memberIds: [ANDREW_ID], updatedAt: '2026-10-10T00:00:00Z' },
    { id: 'changed', ticketId: 'X-261011-eeee', memberIds: [ANDREW_ID], updatedAt: '2026-10-10T12:00:00Z' },
  ];
  const seen = new Map([['seen', '2026-10-10T00:00:00Z'], ['changed', '2026-10-09T00:00:00Z']]);
  const picked = pickRecentAssigned(tickets, { since, reviewers: [ANDREW_ID], seen });
  assert.deepEqual(picked.map(item => item.ticketId), ['manual1', 'changed']);
  assert.deepEqual(picked[0], { ticketId: 'manual1', updatedAt: '2026-10-11T10:51:35.829Z', reference: 'AIR-261011-Nf2D6y', subject: 'Air Reviews' });
  assert.equal(DISCOVERY_DAYS, 7);
  assert.deepEqual(pickRecentAssigned(null, { since }), []);
});

test('the Train AI Telegram notice names the ticket, category, verdict, a short description and the ticket link', () => {
  const text = feedbackNotice({ id: 7, ticket: 'AIR-261013-cSz4B8', category: 'Bug', verdict: 'incorrect', description: '  AI kết luận sai: ' + 'x'.repeat(300) });
  const [first, second, third] = text.split('\n');
  assert.match(first, /^✅ Đã nhận feedback Train AI cho AIR-261013-cSz4B8 \(Bug, AI check chưa đúng\): AI kết luận sai: x+…$/);
  assert.equal(first.split('): ').pop().length, 200, 'description shortened to 200 chars');
  assert.equal(second, 'Bài học đã lưu, áp dụng từ lượt check tiếp theo.');
  assert.equal(third, 'https://helpdesk.avada.net/tickets/AIR-261013-cSz4B8');
  assert.match(feedbackNotice({ ticket: 'JOY-1', verdict: 'pending', description: 'ok' }), /JOY-1 \(chưa đánh giá\): ok/);
  assert.equal(feedbackNoticeEnabled({}), true, 'on by default');
  assert.equal(feedbackNoticeEnabled({ AI_CHECK_FEEDBACK_TELEGRAM: 'off' }), false);
  assert.equal(feedbackNoticeEnabled({ AI_CHECK_FEEDBACK_TELEGRAM: '0' }), false);
  assert.equal(feedbackNoticeEnabled({ AI_CHECK_FEEDBACK_TELEGRAM: 'on' }), true);
});

test('scheduleFeedbackNotice sends once per feedback id, in the background, retries once and only logs failures', async () => {
  const sent = []; const logs = [];
  const send = async text => { sent.push(text); return { messageId: 1 }; };
  const feedback = { id: 901, ticket: 'CHAT-261013-gnn4mp', category: 'Customize', verdict: 'correct', description: 'Đúng rồi' };
  assert.equal(scheduleFeedbackNotice(feedback, { send, enabled: true, log: m => logs.push(m) }), true);
  assert.equal(scheduleFeedbackNotice(feedback, { send, enabled: true, log: m => logs.push(m) }), false, 'a retried save does not send twice');
  assert.equal(scheduleFeedbackNotice({ ...feedback, id: 902 }, { send, enabled: false, log: m => logs.push(m) }), false, 'switched off');
  assert.equal(scheduleFeedbackNotice({ ...feedback, id: 902 }, { send, enabled: true, log: m => logs.push(m) }), true, 'a new feedback on the same ticket is announced again');
  await new Promise(done => setTimeout(done, 10));
  assert.equal(sent.length, 2); assert.match(sent[0], /CHAT-261013-gnn4mp \(Customize, AI check đúng\): Đúng rồi/);
  let calls = 0;
  const flaky = async () => { calls += 1; if (calls === 1) throw new Error('Telegram transport failed (TypeError).'); return { messageId: 2 }; };
  assert.equal(scheduleFeedbackNotice({ ...feedback, id: 903 }, { send: flaky, enabled: true, log: m => logs.push(m), retryDelayMs: 5 }), true);
  await new Promise(done => setTimeout(done, 40));
  assert.equal(calls, 2, 'one retry'); assert.equal(logs.length, 0);
  const dead = async () => { throw new Error('Telegram sendMessage failed: chat not found.'); };
  assert.equal(scheduleFeedbackNotice({ ...feedback, id: 904 }, { send: dead, enabled: true, log: m => logs.push(m), retryDelayMs: 5 }), true);
  await new Promise(done => setTimeout(done, 40));
  assert.equal(logs.length, 1); assert.match(logs[0], /feedback 904: Telegram sendMessage failed: chat not found/);
});

test('sendTelegramText never puts the token in an error and reports Telegram refusals', async () => {
  await assert.rejects(sendTelegramText('x', { token: '', chatId: '1' }), /Thiếu TELEGRAM_BOT_TOKEN/);
  const refusing = async () => ({ ok: false, status: 400, json: async () => ({ ok: false, description: 'Bad Request: chat not found' }) });
  await assert.rejects(sendTelegramText('x', { token: 'SECRET123', chatId: '1', fetchImpl: refusing }), error => !error.message.includes('SECRET123') && /chat not found/.test(error.message));
  const broken = async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }); };
  await assert.rejects(sendTelegramText('x', { token: 'SECRET123', chatId: '1', fetchImpl: broken }), error => !error.message.includes('SECRET123') && /transport failed \(TypeError\)/.test(error.message));
  let seen = null;
  const ok = async (url, options) => { seen = { url, body: JSON.parse(options.body) }; return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 42 } }) }; };
  assert.deepEqual(await sendTelegramText('hello', { token: 'T', chatId: '99', fetchImpl: ok }), { messageId: 42 });
  assert.equal(seen.body.chat_id, '99'); assert.equal(seen.body.text, 'hello'); assert.ok(seen.url.endsWith('/botT/sendMessage'));
});
