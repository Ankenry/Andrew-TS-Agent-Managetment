// "@han" follow-up inside check-ticket-v2 (13/10/2026): prepare context, prompts, tools-server (view_image, crisp_read),
// verify scoring of image:/crisp: refs and the postcheck warning.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { followUpContext, prepare } from './prepare.mjs';
import { investigatorPrompt, writerPrompt, finalizePrompt } from './prompts.mjs';
import { checkWriterOutput } from './postcheck.mjs';
import { sourceClass, scoreQuote, SCORES, BROWSER_TOOLS } from './verify.mjs';
import { TOOL_NAMES } from './schema.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ticket = () => ({
  id: 't1', ticketId: 'JOY-261012-yaATZq', subject: 'Point Calculator không hiển thị trên trang sản phẩm', description: 'khách bật rồi mà không thấy', appName: 'Joy', storeDomains: ['shop.myshopify.com'], chatLink: 'https://app.crisp.chat/website/w/inbox/session_x/',
  comments: [
    { id: 'c4', author: 'Andrew', authorId: 'A', createdAt: '2026-10-13T09:44:00.000Z', content: '@han check tiếp' },
    { id: 'c3', author: 'Alice', authorId: 'B', createdAt: '2026-10-13T09:30:00.000Z', content: 'Khách đã add block nhưng console báo lỗi https://capture.avada.io/i/3zq9g9JJTbLl' },
    { id: 'c2', author: 'Andrew', authorId: 'A', createdAt: '2026-10-12T07:54:00.000Z', content: 'Sau khi TS check thì thấy như sau:\nĐây là loại ticket gì : Bug\n\nKết luận cũ' },
    { id: 'c1', author: 'Alice', authorId: 'B', createdAt: '2026-10-12T07:00:00.000Z', content: 'Mở ticket' },
  ],
});

test('followUpContext keeps only the comments after the window start, drops the command comment, lists image links', () => {
  const follow = followUpContext(ticket(), { instruction: 'check tiếp', defaultInstruction: true, commentId: 'c4', commentAt: '2026-10-13T09:44:00.000Z', sinceAt: '2026-10-12T08:00:00.000Z', previousReport: 'Báo cáo cũ', previousCategory: 'Bug' });
  assert.deepEqual(follow.newComments.map(comment => comment.id), ['c3']);
  assert.equal(follow.commandComment.id, 'c4');
  assert.deepEqual(follow.imageLinks, ['https://capture.avada.io/i/3zq9g9JJTbLl']);
  assert.equal(follow.previousReport, 'Báo cáo cũ'); assert.equal(follow.sinceAt, '2026-10-12T08:00:00.000Z');
  const all = followUpContext(ticket(), { instruction: 'x', commentId: null, sinceAt: null });
  assert.deepEqual(all.newComments.map(comment => comment.id), ['c1', 'c2', 'c3', 'c4'], 'no window → every comment is new, oldest first');
  assert.deepEqual(all.newComments.map(comment => comment.tsReport), [false, true, false, false], 'a posted TS report under Andrew\'s account is marked');
  assert.equal(followUpContext(ticket(), null), null);
});

test('prepare in follow-up mode: hints use the new comments and the instruction; image links are collected without follow-up too', async () => {
  const evidence = async () => ({ ...ticket(), comments: [...ticket().comments, { id: 'c5', author: 'Alice', authorId: 'B', createdAt: '2026-10-13T09:40:00.000Z', content: 'Khách muốn ẩn phần star bằng CSS' }] });
  const lessons = async () => [];
  const statePath = join(mkdtempSync(join(tmpdir(), 'v2-fu-')), 'state.json');
  const plain = await prepare({ reference: 'JOY-261012-yaATZq', url: 'https://helpdesk.avada.net/tickets/JOY-261012-yaATZq' }, { evidence, lessons, statePath });
  assert.equal(plain.followUp, null); assert.equal(plain.customizeHint, false, 'without follow-up the comments do not set the Customize hint');
  assert.deepEqual(plain.imageLinks, ['https://capture.avada.io/i/3zq9g9JJTbLl']);
  const follow = await prepare({ reference: 'JOY-261012-yaATZq', url: 'https://helpdesk.avada.net/tickets/JOY-261012-yaATZq' }, { evidence, lessons, statePath, followUp: { instruction: 'check tiếp', commentId: 'c4', sinceAt: '2026-10-12T08:00:00.000Z' } });
  assert.deepEqual(follow.followUp.newComments.map(comment => comment.id), ['c3', 'c5']);
  assert.equal(follow.customizeHint, true, 'the new comment asks for CSS'); assert.equal(follow.browserAllowed, true);
});

test('prompts carry the follow-up block, the new comments and the tools view_image / crisp_read', () => {
  const prep = { reference: 'JOY-1', url: 'u', ticket: ticket(), app: { slug: 'joy', kb: 'joy', codeRoot: 'apps_doc/joy', kbRoots: [] }, browserAllowed: true, customizeHint: false, settingHint: true, storeUrls: [], oldCases: [], lessons: [], imageLinks: ['https://capture.avada.io/i/3zq9g9JJTbLl'],
    followUp: followUpContext(ticket(), { instruction: 'xem lại console theo ảnh', defaultInstruction: false, commentId: 'c4', commentAt: '2026-10-13T09:44:00.000Z', sinceAt: '2026-10-12T08:00:00.000Z', previousReport: 'Báo cáo cũ nói A', previousCategory: 'Bug' }) };
  const prompt = investigatorPrompt(prep, { deadline: Date.now() + 1000, maxTurns: 5, browserAllowed: true, sourceApi: true, crisp: true });
  assert.match(prompt, /CHẾ ĐỘ CHECK TIẾP theo lệnh "@han"/); assert.match(prompt, /Chỉ thị: "xem lại console theo ảnh"/);
  assert.match(prompt, /Báo cáo cũ nói A/); assert.match(prompt, /KHÔNG trích làm bằng chứng/);
  assert.match(prompt, /console báo lỗi https:\/\/capture\.avada\.io\/i\/3zq9g9JJTbLl/); assert.match(prompt, /BẮT BUỘC view_image/);
  assert.match(prompt, /view_image \(/); assert.match(prompt, /crisp_read \(/); assert.match(prompt, /chưa đọc được Crisp/);
  assert.ok(!/Kết luận cũ\n/.test(prompt.split('Dữ liệu ticket:')[0]), 'old comments are not in the new-comments block');
  const noCrisp = investigatorPrompt({ ...prep, followUp: null }, { deadline: Date.now() + 1000, maxTurns: 5, browserAllowed: false, sourceApi: false, crisp: false });
  assert.ok(!/crisp_read/.test(noCrisp)); assert.match(noCrisp, /Ticket có link ảnh chụp/);
  assert.match(finalizePrompt(prep, [], null, 1), /CHẾ ĐỘ CHECK TIẾP/);
  const writer = writerPrompt(prep, { category: 'Bug', summary: 's', findings: [] }, { maxChars: 4000, minChars: 150 });
  assert.match(writer, /lượt CHECK TIẾP theo lệnh @han/); assert.match(writer, /Comment mới phải được trả lời \(1\)/); assert.match(writer, /theo ảnh chụp/);
});

test('verify: image:/crisp: refs score like browser observations from the matching tool output', () => {
  assert.equal(sourceClass('image:https://capture.avada.io/i/x'), 'browser'); assert.equal(sourceClass('crisp:https://app.crisp.chat/x'), 'browser');
  assert.ok(BROWSER_TOOLS.includes('view_image') && BROWSER_TOOLS.includes('crisp_read'));
  assert.ok(TOOL_NAMES.includes('view_image') && TOOL_NAMES.includes('crisp_read'));
  const toolLog = [{ tool: 'view_image', args: {}, output: 'ảnh: https://capture.avada.io/i/x (đã xem lúc 2026-10-13T10:00:00.000Z)\nkích thước gốc 1200x800px' }, { tool: 'crisp_read', args: {}, output: '[nguồn: crisp:https://app.crisp.chat/x]\nKhách: I want the widget on the left side' }];
  assert.equal(scoreQuote({ quote: 'ảnh: https://capture.avada.io/i/x (đã xem', source: { type: 'browser', ref: 'image:https://capture.avada.io/i/x' } }, { toolLog, ticketText: '' }).score, SCORES.browser);
  assert.equal(scoreQuote({ quote: 'I want the widget on the left side', source: { type: 'browser', ref: 'crisp:https://app.crisp.chat/x' } }, { toolLog, ticketText: '' }).score, SCORES.browser);
  assert.equal(scoreQuote({ quote: 'không có trong output', source: { type: 'browser', ref: 'image:https://capture.avada.io/i/x' } }, { toolLog, ticketText: '' }).score, SCORES.none);
});

test('postcheck warns (never rejects) when a follow-up body ignores the new comments', () => {
  const settings = { commentMaxChars: 4000, commentMinChars: 20, letterMinScore: 0.9 };
  const findings = [{ id: 'F1', kind: 'fact', verified: true, inference: false, score: 1 }];
  const silent = checkWriterOutput({ body: 'Widget vẫn chưa hiện vì app embed tắt trong theme.', claims: [{ text: 'Widget vẫn chưa hiện vì app embed tắt trong theme.', finding_ids: ['F1'], inference: false }], customer_letter: null, letter_finding_ids: [] }, { category: 'Bug', findings, followUp: { newComments: 1 } }, settings);
  assert.equal(silent.ok, true); assert.ok(silent.warnings.some(item => item.includes('1 comment mới')));
  const answered = checkWriterOutput({ body: 'Theo comment mới của CS, khách đã add block; theo ảnh chụp console báo lỗi 404 khi tải script.', claims: [{ text: 'Theo comment mới của CS, khách đã add block; theo ảnh chụp console báo lỗi 404 khi tải script.', finding_ids: ['F1'], inference: false }], customer_letter: null, letter_finding_ids: [] }, { category: 'Bug', findings, followUp: { newComments: 1 } }, settings);
  assert.deepEqual(answered.warnings, []);
  const first = checkWriterOutput({ body: 'Widget vẫn chưa hiện vì app embed tắt trong theme.', claims: [{ text: 'Widget vẫn chưa hiện vì app embed tắt trong theme.', finding_ids: ['F1'], inference: false }], customer_letter: null, letter_finding_ids: [] }, { category: 'Bug', findings, followUp: null }, settings);
  assert.deepEqual(first.warnings, []);
});

function rpcClient(env) {
  const child = spawn(process.execPath, [resolve(HERE, 'tools-server.mjs')], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  let buffer = ''; const waiters = new Map(); let nextId = 1; let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdout.on('data', chunk => {
    buffer += chunk; let index;
    while ((index = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, index); buffer = buffer.slice(index + 1); if (!line.trim()) continue; const message = JSON.parse(line); const waiter = waiters.get(message.id); if (waiter) { waiters.delete(message.id); waiter(message); } }
  });
  const request = (method, params) => new Promise((resolveRequest, reject) => { const id = nextId++; const timer = setTimeout(() => reject(new Error(`timeout ${method}; stderr: ${stderr}`)), 20000); waiters.set(id, message => { clearTimeout(timer); resolveRequest(message); }); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
  const call = async (name, args) => (await request('tools/call', { name, arguments: args })).result;
  const close = () => new Promise(resolveClose => { child.on('close', resolveClose); child.stdin.end(); });
  return { request, call, close };
}

test('tools-server: view_image accepts only capture/image links; crisp_read needs a Crisp link and a token; budgets apply', async () => {
  const root = mkdtempSync(join(tmpdir(), 'v2-root-fu-'));
  mkdirSync(join(root, 'apps_doc/joy'), { recursive: true }); mkdirSync(join(root, 'knowledge-base'), { recursive: true });
  const jobDir = join(root, 'job'); mkdirSync(jobDir);
  writeFileSync(join(jobDir, 'prepare.json'), JSON.stringify({ reference: 'JOY-1', ticket: { ticketId: 'JOY-1', subject: 's', storeDomains: [] }, storeUrls: [] }));
  const envFile = join(root, 'crisp.env'); writeFileSync(envFile, '# test\nOTHER=1\n');
  const client = rpcClient({ V2_ROOT: root, V2_JOB_DIR: jobDir, V2_APP: 'joy', V2_KB_SLUG: 'joy', V2_MAX_VIEW_IMAGE: '2', V2_CRISP_URL: 'https://app.crisp.chat/website/w/inbox/session_x/', V2_CRISP_ENV_FILE: envFile, V2_CRISP_SCRIPT: join(root, 'missing.py') });
  try {
    const list = await client.request('tools/list', {});
    const names = list.result.tools.map(tool => tool.name);
    for (const name of ['view_image', 'crisp_read', 'shop_settings', 'submit_findings']) assert.ok(names.includes(name), name);
    const badHost = await client.call('view_image', { url: 'https://example.com/page' });
    assert.equal(badHost.isError, true); assert.match(badHost.content[0].text, /chỉ mở link ảnh/);
    const internal = await client.call('view_image', { url: 'http://127.0.0.1/x.png' });
    assert.equal(internal.isError, true);
    const noScript = await client.call('crisp_read', {});
    assert.equal(noScript.isError, true); assert.match(noScript.content[0].text, /chưa đọc được Crisp: thiếu script/);
  } finally { await client.close(); }
  const noLink = rpcClient({ V2_ROOT: root, V2_JOB_DIR: jobDir, V2_APP: 'joy', V2_KB_SLUG: 'joy', V2_MAX_VIEW_IMAGE: '0' });
  try {
    const result = await noLink.call('crisp_read', { mode: 'summary' });
    assert.equal(result.isError, true); assert.match(result.content[0].text, /không có link Crisp/);
    const list = await noLink.request('tools/list', {});
    assert.match(list.result.tools.find(tool => tool.name === 'crisp_read').description, /không có link Crisp/);
    const spent = await noLink.call('view_image', { url: 'https://capture.avada.io/i/abc' });
    assert.match(spent.content[0].text, /hết 0 lượt/);
  } finally { await noLink.close(); }
  // Token present but script fails fast: the model gets the "chưa đọc được Crisp" wording, never the token.
  writeFileSync(envFile, 'AGENT-TS-TOKEN=secret-token-value-123456\n');
  const failing = join(root, 'fail.py'); writeFileSync(failing, 'import os,sys\nprint("token seen:", "AGENT-TS-TOKEN" in os.environ, file=sys.stderr)\nsys.exit(3)\n');
  const withToken = rpcClient({ V2_ROOT: root, V2_JOB_DIR: jobDir, V2_APP: 'joy', V2_KB_SLUG: 'joy', V2_CRISP_URL: 'https://app.crisp.chat/website/w/inbox/session_x/', V2_CRISP_ENV_FILE: envFile, V2_CRISP_SCRIPT: failing, V2_CRISP_MAX: '1' });
  try {
    const result = await withToken.call('crisp_read', {});
    assert.equal(result.isError, true); assert.match(result.content[0].text, /chưa đọc được Crisp \(token seen: True\)/);
    assert.ok(!result.content[0].text.includes('secret-token-value-123456'));
    const spent = await withToken.call('crisp_read', {});
    assert.match(spent.content[0].text, /hết 1 lượt/);
  } finally { await withToken.close(); }
});


test('follow-up excludes confirmed controller ACK ids from merchant evidence', () => {
  const data=ticket();data.comments.push({id:'ack',author:'Andrew',createdAt:'2026-10-13T09:45:00.000Z',content:'Dạ chờ em check xíu nha'});
  const follow=followUpContext(data,{commentId:'c4',acknowledgementIds:['ack']});
  assert.ok(!follow.newComments.some(c=>c.id==='ack'));
  assert.ok(!follow.newText.includes('Dạ chờ em'));
});
