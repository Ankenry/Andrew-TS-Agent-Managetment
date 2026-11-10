// node --test skills/check-ticket/scripts/bot-command.test.mjs — "@han" comment commands (13/10/2026): parsing, refusal
// list, detection on Helpdesk comment actions (Andrew only, baseline, dedupe), follow-up window, image links.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBotCommand, findBotCommands, followUpWindow, extractImageLinks, normalizeBotCommand, plainText, DEFAULT_INSTRUCTION, classifyInstruction, classifyChat, isReplyKind } from './bot-command.mjs';

const ANDREW = 'HEYWuzF9rTdG59pE8TNtBKL6W1x1';

test('parseBotCommand: keyword position, default forms and a free instruction', () => {
  assert.equal(parseBotCommand('Anh check thấy khách chưa add block'), null, 'no keyword → not a command');
  assert.equal(parseBotCommand('xem @hantom nhé'), null, '@hantom is not @han');
  for (const content of ['@han', '@han ', '@Han check tiếp', '@han check tiếp yêu cầu', 'Khách báo lại rồi @han check', '<p>@han</p>', '@han tiếp nhé']) {
    const parsed = parseBotCommand(content);
    assert.equal(parsed.kind, 'follow_up', content); assert.equal(parsed.defaultInstruction, true, content); assert.equal(parsed.instruction, DEFAULT_INSTRUCTION);
  }
  const free = parseBotCommand('@han check tiếp theo comment mới, khách đã add block nhưng console báo lỗi https://capture.avada.io/i/3zq9g9JJTbLl');
  assert.equal(free.kind, 'follow_up'); assert.equal(free.defaultInstruction, false);
  assert.match(free.instruction, /^check tiếp theo comment mới, khách đã add block/);
  assert.deepEqual(free.reasons, []);
  const html = parseBotCommand('<div>Em ơi&nbsp;<b>@han</b> xem lại CSS<br>giúp anh</div>');
  assert.equal(html.instruction, 'xem lại CSS giúp anh');
  const long = parseBotCommand(`@han ${'x'.repeat(3000)}`, { maxInstructionChars: 100 });
  assert.equal(long.instruction.length, 100); assert.equal(long.truncated, true);
  assert.equal(parseBotCommand('@hanski check tiếp', { keyword: '@hanski' }).kind, 'follow_up');
  assert.equal(parseBotCommand('@han check tiếp', { keyword: '@hanski' }), null);
});

test('parseBotCommand refuses instructions that need a write and names the reason', () => {
  const cases = [
    ['@han đổi status sang done', 'đổi status/trạng thái ticket'],
    ['@han tick done ticket này', 'tick Done / đánh dấu solved'],
    ['@han mark as solved', 'tick Done / đánh dấu solved'],
    ['@han close ticket', 'đóng ticket'],
    ['@han nhắn cho khách là đã fix', 'nhắn/gửi mail cho khách'],
    ['@han gửi mail cho merchant', 'nhắn/gửi mail cho khách'],
    ['@han gửi telegram cho Hanlead', 'gửi tin nhắn Telegram/Slack'],
    ['@han xóa comment cũ', 'xóa dữ liệu'],
    ['@han theme push bản sửa', 'lưu code/CSS vào shop/theme/app'],
    ['@han lưu css này vào DevZone', 'lưu code/CSS vào shop/theme/app'],
    ['@han bật setting hideNoStarRating', 'bật/tắt setting của shop'],
    ['@han quick login vào admin xem', 'đăng nhập vào admin/app của khách (chỉ khi Đại tá cho phép trong phiên)'],
  ];
  for (const [content, reason] of cases) {
    const parsed = parseBotCommand(content);
    assert.equal(parsed.kind, 'refused', content); assert.ok(parsed.reasons.includes(reason), `${content} → ${parsed.reasons.join('; ')}`);
  }
  // Reading about a setting or hiding an element with CSS is fine (a check verb → follow_up; no verb → the model decides).
  for (const content of ['@han check xem setting hideNoStarRating đã bật chưa', '@han khách xóa app rồi cài lại, check tiếp', '@han đọc comment mới và check console']) {
    assert.equal(parseBotCommand(content).kind, 'follow_up', content);
  }
  assert.equal(parseBotCommand('@han xem cách ẩn phần star bằng CSS').kind, 'unsure');
});

test('findBotCommands: only Andrew, only after the cursor, never twice, oldest first', () => {
  const action = (id, memberId, content, createdAt) => ({ id, type: 'commentTicket', author: { memberId, displayName: memberId === ANDREW ? 'Andrew' : 'Alice' }, metadata: { content }, createdAt });
  const actions = [
    action('c4', ANDREW, '@han xem lại console', '2026-10-13T10:30:00.000Z'),
    action('c3', 'alice', '@han check giúp em', '2026-10-13T10:20:00.000Z'),
    action('c2', ANDREW, '@han', '2026-10-13T10:10:00.000Z'),
    action('c1', ANDREW, '@han check tiếp', '2026-10-13T09:00:00.000Z'),
    action('c0', ANDREW, 'không có lệnh', '2026-10-13T10:40:00.000Z'),
    { id: 'u1', type: 'updateTicket', author: { memberId: ANDREW }, metadata: { content: '@han' }, createdAt: '2026-10-13T10:50:00.000Z' },
  ];
  const found = findBotCommands(actions, { authorId: ANDREW, since: '2026-10-13T10:00:00.000Z' });
  assert.deepEqual(found.map(item => item.commentId), ['c2', 'c4'], 'c1 is before the cursor, c3 is not Andrew, c0 has no keyword, u1 is not a comment');
  assert.equal(found[0].defaultInstruction, true); assert.equal(found[1].instruction, 'xem lại console');
  assert.deepEqual(findBotCommands(actions, { authorId: ANDREW, since: '2026-10-13T10:00:00.000Z', seen: new Set(['c2']) }).map(item => item.commentId), ['c4']);
  assert.deepEqual(findBotCommands(actions, { authorId: ANDREW, since: '2026-10-13T10:30:00.000Z' }), [], 'a comment at the cursor is baseline');
  assert.deepEqual(findBotCommands(actions, { authorId: '', since: 0 }), [], 'no owner id → nothing is a command');
});

test('followUpWindow starts after the latest finished check of that ticket before the command', () => {
  const jobs = {
    t1: { id: 't1', status: 'done', finishedAt: '2026-10-12T08:00:00.000Z', comment: 'báo cáo 1', category: 'Bug' },
    'cmd-a': { id: 'cmd-a', ticketId: 't1', trigger: 'bot_command', status: 'done', finishedAt: '2026-10-12T12:00:00.000Z', comment: 'báo cáo 2', category: 'Question' },
    'cmd-b': { id: 'cmd-b', ticketId: 't1', trigger: 'bot_command', status: 'queued' },
    t2: { id: 't2', status: 'done', finishedAt: '2026-10-13T08:00:00.000Z', comment: 'khác' },
    late: { id: 't1', ticketId: 't1', status: 'done', finishedAt: '2026-10-13T09:00:00.000Z', comment: 'sau lệnh' },
  };
  const window = followUpWindow({ jobs, ticketId: 't1', commentAt: '2026-10-13T08:30:00.000Z', ticketCreatedAt: '2026-10-10T00:00:00.000Z' });
  assert.equal(window.sinceAt, '2026-10-12T12:00:00.000Z'); assert.equal(window.previousJobId, 'cmd-a'); assert.equal(window.previousReport, 'báo cáo 2'); assert.equal(window.previousCategory, 'Question');
  const fresh = followUpWindow({ jobs: {}, ticketId: 't9', commentAt: '2026-10-13T08:30:00.000Z', ticketCreatedAt: '2026-10-10T00:00:00.000Z' });
  assert.equal(fresh.sinceAt, '2026-10-10T00:00:00.000Z'); assert.equal(fresh.previousReport, null);
  assert.equal(followUpWindow({ jobs: {}, ticketId: 't9', commentAt: '2026-10-13T08:30:00.000Z' }).sinceAt, null);
});

test('extractImageLinks, plainText and normalizeBotCommand', () => {
  assert.deepEqual(extractImageLinks('lỗi console https://capture.avada.io/i/3zq9g9JJTbLl. và ảnh https://cdn.shopify.com/s/files/a.png?v=1 lặp https://capture.avada.io/i/3zq9g9JJTbLl'),
    ['https://capture.avada.io/i/3zq9g9JJTbLl', 'https://cdn.shopify.com/s/files/a.png?v=1']);
  assert.deepEqual(extractImageLinks(''), []);
  assert.equal(plainText('<p>a&amp;b</p><p>c</p>'), 'a&b\nc\n');
  const config = normalizeBotCommand({ keyword: ' @han ', maxInstructionChars: 10, pollIntervalMs: 1000 });
  assert.deepEqual(config, { enabled: true, keyword: '@han', keywordSinceAt: null, maxInstructionChars: 50, pollIntervalMs: null, replyTimeoutMs: 120000, replyMaxChars: 1200, chatTemplates: true });
  assert.deepEqual(normalizeBotCommand({ replyTimeoutMs: 5000, replyMaxChars: 99999, chatTemplates: false }), { enabled: true, keyword: '@han', keywordSinceAt: null, maxInstructionChars: 2000, pollIntervalMs: null, replyTimeoutMs: 10000, replyMaxChars: 4000, chatTemplates: false });
  assert.equal(normalizeBotCommand({ enabled: false }).enabled, false);
  assert.equal(normalizeBotCommand(undefined).keyword, '@han');
  assert.equal(normalizeBotCommand({ pollIntervalMs: 120000 }).pollIntervalMs, 120000);
});

// 14/10/2026 ("Tôi chỉ @han hi mà sao không trả lời 1 cách tự nhiên mà lại thành check ticket vậy"): three branches.
test('classifyInstruction: chat, question and check are told apart by rules; the rest is unsure (model decides)', () => {
  const kinds = {
    'hi': 'chat', 'Hi anh': 'chat', 'hello bot': 'chat', 'hiii bot': 'chat', 'cảm ơn nhé': 'chat', 'ok cảm ơn em nhiều': 'chat', 'thanks!': 'chat', 'ok': 'chat', '👍': 'chat', 'haha': 'chat', '=))': 'chat',
    'có đó không bot': 'chat', 'test': 'chat', 'chào buổi sáng': 'chat', 'good job': 'chat',
    'ticket này sao rồi?': 'question', 'khách trả lời chưa': 'question', 'lần trước kết luận gì': 'question', 'tóm tắt ticket này giúp': 'question', 'why is the widget hidden?': 'question', 'tình hình thế nào': 'question',
    'check tiếp': 'follow_up', 'check lại xem khách đã trả lời chưa': 'follow_up', 'xem lại console': 'follow_up', 'kiểm tra lại giúp anh': 'follow_up', 'verify the fix': 'follow_up', 'theo dõi tiếp nhé': 'follow_up', 'điều tra xem sao': 'follow_up',
    'ok anh xem rồi': 'unsure', 'hide star': 'unsure', 'khách bảo vẫn lỗi': 'unsure', 'xem cách ẩn phần star bằng CSS': 'unsure', 'hello world this is a long sentence with many words indeed': 'unsure',
  };
  for (const [text, kind] of Object.entries(kinds)) assert.equal(classifyInstruction(text).kind, kind, JSON.stringify(text));
  assert.deepEqual(classifyInstruction('').slice?.() ?? classifyInstruction(''), { kind: 'follow_up', defaultInstruction: true, chatGroup: null });
  assert.equal(classifyInstruction('check tiếp').defaultInstruction, true);
  assert.equal(classifyInstruction('check lại xem khách đã trả lời chưa').defaultInstruction, false);
  assert.deepEqual(classifyChat('hi, thanks!'), { group: 'thanks' }, 'the most specific group wins');
  assert.deepEqual(classifyChat('hey bot ơi'), { group: 'greeting' });
  assert.deepEqual(classifyChat('ping'), { group: 'ping' });
  assert.equal(classifyChat('hide'), null, '"hi" inside a word is not a greeting');
  assert.equal(classifyChat('hi khách bảo lỗi'), null);
  // The samples Hanlead asked for, end to end through parseBotCommand.
  const expect = { '@han hi': 'chat', '@han hello bot': 'chat', '@han cảm ơn nhé': 'chat', '@han ticket này sao rồi?': 'question', '@han check tiếp': 'follow_up', '@han check lại xem khách đã trả lời chưa': 'follow_up', '@han': 'follow_up', '@han đổi status sang done': 'refused', '@han cảm ơn, tick done nhé': 'refused' };
  for (const [content, kind] of Object.entries(expect)) assert.equal(parseBotCommand(content).kind, kind, content);
  const hi = parseBotCommand('@han hi');
  assert.equal(hi.instruction, 'hi', 'a chat keeps the text as typed, not the default instruction'); assert.equal(hi.chatGroup, 'greeting'); assert.equal(hi.defaultInstruction, false);
  assert.equal(parseBotCommand('@han ticket này sao rồi?').chatGroup, null);
  assert.ok(isReplyKind('chat') && isReplyKind('question') && isReplyKind('unsure') && !isReplyKind('follow_up') && !isReplyKind('refused'));
});

test('@han replaces @bot without an alias and keeps strict keyword boundaries',()=>{
  assert.equal(parseBotCommand('@bot check'),null);
  assert.equal(parseBotCommand('@han check').kind,'follow_up');
  assert.equal(parseBotCommand('@Han hi').kind,'chat');
  assert.equal(parseBotCommand('@han hello han').kind,'chat');
  for(const text of ['@hanski check','@han123 check','@han.foo check','@han-other check'])assert.equal(parseBotCommand(text),null,text);
});
