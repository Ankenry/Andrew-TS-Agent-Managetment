import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { automaticConversations, automaticHistory, conversationFromJob } from '../skills/check-ticket/scripts/history.mjs';

const mergeSource = await readFile(new URL('../chrome-extension/automatic-history.js', import.meta.url), 'utf8');
const background = await readFile(new URL('../chrome-extension/background.js', import.meta.url), 'utf8');
const sandbox = vm.createContext({});
vm.runInContext(mergeSource, sandbox);
const History = sandbox.AutomaticReviewHistory;
const plain = value => JSON.parse(JSON.stringify(value));

const NOW = Date.parse('2026-09-27T10:00:00Z');
const job = (extra = {}) => ({ id:'jobA', reference:'TEST-260927-aaaaaa', subject:'Widget lỗi', trigger:'ticket_created', status:'done', phase:'comment',
  createdAt:'2026-09-27T09:00:00.000Z', finishedAt:'2026-09-27T09:05:00.000Z', runId:'run1', category:'Bug',
  comment:'Sau khi TS check thì thấy như sau:\nĐây là loại ticket gì : Bug\n\nNội dung report.', commentId:`receipt-${extra.id || 'jobA'}`,
  artifactDir:`/tmp/runtime/check-ticket/jobs/${extra.id || 'jobA'}/${extra.runId || 'run1'}`, ...extra });

async function workspace(jobs, files = {}) {
  const root = await mkdtemp(join(tmpdir(), 'auto-history-'));
  await mkdir(join(root, 'runtime/check-ticket'), { recursive:true });
  await writeFile(join(root, 'runtime/check-ticket/state.json'), JSON.stringify({ version:1, jobs:Object.fromEntries(jobs.map(item => [item.id, item])) }));
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(root, 'runtime/check-ticket/jobs', path, '..'), { recursive:true });
    await writeFile(join(root, 'runtime/check-ticket/jobs', path), text);
  }
  return root;
}

test('a finished automatic review has a separate receipt status and exact canonical result, without analysis', async () => {
  const root = await workspace([job()], { 'jobA/run1/elite.txt':'Phân tích ban đầu\n\nSources\n- docs/a.md' });
  const [conversation] = await automaticConversations({ root, now:NOW });
  assert.equal(conversation.chatId, 'auto-jobA');
  assert.equal(conversation.origin, 'automatic');
  assert.deepEqual(conversation.selectedTicket, { id:'jobA', ticketId:'TEST-260927-aaaaaa', subject:'Widget lỗi' });
  assert.deepEqual(conversation.messages.map(message => message.role), ['user', 'assistant', 'assistant']);
  assert.equal(conversation.messages[0].text, 'Check ticket https://helpdesk.avada.net/tickets/TEST-260927-aaaaaa');
  assert.match(conversation.messages[1].text, /Đã xác nhận comment/);
  assert.equal(conversation.messages[2].text, job().comment);
  assert.ok(!JSON.stringify(conversation).includes('Phân tích ban đầu'));
  assert.ok(conversation.messages.every(message => message.auto === true));
  assert.equal(conversation.automatic.status, 'done');
  assert.equal(conversation.updatedAt, Date.parse('2026-09-27T09:05:00.000Z'));
});

test('status wording follows the controller state and never claims an unconfirmed comment', () => {
  const text = extra => conversationFromJob(job(extra)).messages.map(m=>m.text).join('\n');
  assert.match(text({ status:'running', comment:undefined, finishedAt:undefined }), /Đang check/);
  assert.match(text({ status:'uncertain' }), /Chưa xác nhận comment/);
  assert.match(text({ status:'needs_attention', comment:undefined, lastError:'TS Elite 2 review failed.' }), /Cần kiểm tra/);
  assert.equal(conversationFromJob(job({ status:'needs_attention' })).automatic.status, 'failed');
  assert.equal(conversationFromJob(job({ status:'cancelled' })), null);
  assert.equal(conversationFromJob(job({ id:'../etc' })), null);
  assert.equal(conversationFromJob(null), null);
});

test('history keeps only recent reviews, newest first, and ignores artifacts outside the job folder', async () => {
  const jobs = [
    job({ id:'old', createdAt:'2026-09-10T09:00:00.000Z', finishedAt:'2026-09-10T09:05:00.000Z' }),
    job({ id:'first', createdAt:'2026-09-26T09:00:00.000Z', finishedAt:'2026-09-26T09:05:00.000Z', runId:'../../../secret' }),
    job({ id:'second' }),
  ];
  const root = await workspace(jobs);
  const { conversations, digest } = await automaticHistory({ root, now:NOW });
  assert.deepEqual(conversations.map(item => item.chatId), ['auto-second', 'auto-first']);
  assert.equal(conversations[1].messages.length, 2);
  assert.match(digest, /^[0-9a-f]{16}$/);
  assert.deepEqual(await automaticConversations({ root:join(root, 'missing'), now:NOW }), []);
  assert.equal((await automaticConversations({ root, now:NOW, limit:1 })).length, 1);
});

test('merge adds automatic reviews once and refreshes them when the review changes', () => {
  const manual = { chatId:'chat-1', selectedTicket:null, messages:[{ role:'user', text:'hi' }], createdAt:1, updatedAt:5 };
  const running = conversationFromJob(job({ status:'running', comment:undefined, finishedAt:undefined }));
  const first = History.merge([manual], [running]);
  assert.equal(first.changed, true);
  assert.deepEqual(plain(first.conversations.map(item => item.chatId)), ['auto-jobA', 'chat-1']);
  assert.equal(History.merge(first.conversations, [running]).changed, false);

  const done = History.merge(first.conversations, [conversationFromJob(job())]);
  assert.equal(done.changed, true);
  assert.equal(done.conversations.length, 2);
  assert.equal(done.conversations[0].automatic.status, 'done');
  assert.equal(done.conversations[0].messages.at(-1).text, job().comment);
});

test('merge keeps messages the user typed inside an automatic conversation', () => {
  const running = conversationFromJob(job({ status:'running', comment:undefined, finishedAt:undefined }));
  const continued = { ...running, ...History.originFields(running), updatedAt:NOW,
    messages:[...running.messages, { role:'user', text:'Giải thích thêm', timestamp:NOW }, { role:'assistant', text:'Đây', timestamp:NOW }] };
  const merged = History.merge([continued], [conversationFromJob(job())]);
  const [conversation] = merged.conversations;
  assert.equal(conversation.messages[2].text,job().comment);
  assert.deepEqual(plain(conversation.messages.slice(-2).map(message => message.text)), ['Giải thích thêm', 'Đây']);
  assert.equal(conversation.updatedAt, NOW);
  assert.equal(conversation.origin, 'automatic');
});

test('merge honours dismissed reviews and caps manual and automatic lists separately', () => {
  const item = conversationFromJob(job());
  assert.equal(History.merge([], [item], { dismissed:['auto-jobA'] }).conversations.length, 0);
  const manual = Array.from({ length:35 }, (_, index) => ({ chatId:`chat-${index}`, messages:[{ role:'user', text:'q' }], updatedAt:index }));
  const automatic = Array.from({ length:35 }, (_, index) => conversationFromJob(job({ id:`job${index}`, finishedAt:new Date(NOW + index * 1000).toISOString() })));
  const { conversations } = History.merge(manual, automatic);
  assert.equal(conversations.filter(History.isAutomatic).length, 30);
  assert.equal(conversations.filter(entry => !History.isAutomatic(entry)).length, 30);
  assert.ok(conversations.some(entry => entry.chatId === 'chat-34') && !conversations.some(entry => entry.chatId === 'chat-0'));
});

test('extension sync only reads the local history route and writes the conversation store', () => {
  const body = background.slice(background.indexOf('function syncAutomaticReviewHistory()'), background.indexOf('function syncAutomaticReviewHistoryQuietly()'));
  assert.match(body, /\/check-ticket\/history/);
  assert.match(body, /AutomaticReviewHistory\.merge/);
  assert.doesNotMatch(body, /method:\s*"POST"|\/comments|requestWidgetAiChat|ai-chat/);
});

test('a "@bot" follow-up job shows the instruction as the request and reads "check tiếp" (13/10/2026)', () => {
  const command = conversationFromJob(job({ id:'cmd-c2', ticketId:'jobA', trigger:'bot_command', command:{ commentId:'c2', instruction:'xem lại console theo ảnh', defaultInstruction:false } }));
  assert.equal(command.chatId, 'auto-cmd-c2');
  assert.equal(command.messages[0].text, '@bot xem lại console theo ảnh · ticket https://helpdesk.avada.net/tickets/TEST-260927-aaaaaa');
  assert.equal(command.messages.at(-1).text,job().comment);
  assert.deepEqual(command.selectedTicket, { id:'jobA', ticketId:'TEST-260927-aaaaaa', subject:'Widget lỗi' });
  assert.equal(command.automatic.trigger, 'bot_command'); assert.equal(command.automatic.instruction, 'xem lại console theo ảnh');
  assert.match(conversationFromJob(job({ id:'cmd-c3', ticketId:'jobA', trigger:'bot_command', status:'running', comment:undefined, finishedAt:undefined })).messages.at(-1).text, /Đang check/);
});

test('a "@bot" natural reply job (mode reply, 14/10/2026) shows the comment as the request and the plain reply as the answer', () => {
  const reply = conversationFromJob(job({ id:'cmd-hi', ticketId:'jobA', trigger:'bot_command', mode:'reply', category:undefined, comment:'Chào anh, mình đây. Ticket TEST-260927-aaaaaa mình vẫn đang theo dõi.', command:{ commentId:'hi', instruction:'hi', kind:'chat', chatGroup:'greeting' } }));
  assert.equal(reply.messages[0].text, '@bot hi · ticket https://helpdesk.avada.net/tickets/TEST-260927-aaaaaa');
  assert.equal(reply.messages.at(-1).text, 'Chào anh, mình đây. Ticket TEST-260927-aaaaaa mình vẫn đang theo dõi.', 'no "check xong" framing');
  assert.equal(reply.automatic.mode, 'reply'); assert.equal(reply.automatic.kind, 'chat'); assert.equal(reply.automatic.status, 'done');
  assert.match(conversationFromJob(job({ id:'cmd-q', ticketId:'jobA', trigger:'bot_command', mode:'reply', status:'running', comment:undefined, finishedAt:undefined, command:{ instruction:'sao rồi?', kind:'question' } })).messages.at(-1).text, /Đang soạn trả lời cho @bot/);
  assert.match(conversationFromJob(job({ id:'cmd-f', ticketId:'jobA', trigger:'bot_command', mode:'reply', status:'needs_attention', comment:undefined, lastError:'rỗng', command:{ instruction:'sao rồi?', kind:'question' } })).messages.at(-1).text, /Chưa trả lời được @bot .*: rỗng/);
  assert.equal(conversationFromJob(job({ id:'cmd-c2', ticketId:'jobA', trigger:'bot_command', command:{ instruction:'xem lại' } })).automatic.mode, 'review');
});

test('new command history uses saved @han keyword while legacy jobs keep @bot',()=>{
  const current=conversationFromJob(job({id:'cmd-new',ticketId:'jobA',trigger:'bot_command',command:{keyword:'@han',instruction:'check tiếp'}}));
  assert.match(current.messages[0].text,/^@han check tiếp/);
  const legacy=conversationFromJob(job({id:'cmd-old',ticketId:'jobA',trigger:'bot_command',command:{instruction:'check tiếp'}}));
  assert.match(legacy.messages[0].text,/^@bot check tiếp/);
});
