// "CSS nộp = CSS đã thử" (14/10/2026, user order "Sau khi hoàn thành css thì bạn hãy dùng mcp để test lại xem có apply được
// đúng ko (… chỉ cần test ở phía bạn để đảm bảo css đó work đúng như mong đợi)"): the CSS a finding submits must equal a
// css_preview trial of the job, and that trial must have no property really overridden (✗).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeCss, cssTrialsFromLog, lastCssCallUnusable, matchCssTrial, cssTrialProblems, untriedReason } from './customize.mjs';
import { validateFindings } from './schema.mjs';
import { verifyFindings } from './verify.mjs';
import { checkCustomizeCss } from './postcheck.mjs';
import { codeBlocks } from './customize.mjs';
import { investigatorPrompt, writerPrompt } from './prompts.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FINAL = '#AirReviews-BlockWrapper .AirReviews-Widget__V2 .AirReviews-Blocks--Rate,\n#AirReviews-BlockWrapper .AirReviews-Widget__V2 .AirReviews-Blocks--List {\n  display: none;\n}\n#AirReviews-BlockWrapper .AirReviews-Widget__V2 .AirReviews-Blocks__SummaryWrapper {\n  justify-content: flex-start;\n}';
const FIRST = '.AirReviews-Widget__V2 .AirReviews-Blocks--Rate { display: none; }';
const trialEntry = (seq, css, extra = {}) => ({ seq, round: 1, at: '2026-10-14T06:00:00.000Z', tool: 'css_preview', args: { url: 'https://shop.example/products/a', css }, ok: true, ms: 4800, output: 'x', trial: { css, url: 'https://shop.example/products/a', mobile: false, props: [], overridden: [], unknown: [], zeroSelectors: [], unusable: null, ...extra } });
const finding = (code, extra = {}) => ({ id: 'S1', kind: 'suggestion', claim: 'CSS ẩn khối thống kê và căn trái phần tóm tắt', quote: null, source: null, link: null, blocker: null, searched: null, reply_needed: null, offer_fix: true, details: 'Dán vào DevZone → Custom CSS for review box.', code, code_lang: 'css', ...extra });
const submission = findings => ({ category: 'Customize', category_reason: 'r', summary: 's', browser_impact: true, infeasible_reason: null, sources: [], findings });

test('MCP tool-server accepts persisted official CSS evidence and forbids the legacy browser-off exemption', async () => {
  const root = mkdtempSync(join(tmpdir(), 'v2-mcp-css-trial-'));
  const jobDir = join(root, 'job'); mkdirSync(jobDir);
  writeFileSync(join(jobDir, 'prepare.json'), JSON.stringify({ reference: 'AIR-1', ticket: { ticketId: 'AIR-1', subject: 's', comments: [] },
    app: { slug: 'air-reviews', kb: 'air-reviews' }, mcpV2: { app: 'air-reviews', ticketId: 'AIR-1', browser: { available: true }, tools: [] } }));
  const entry = trialEntry(19, FINAL);
  entry.tool = 'mcp_v2_read'; entry.args = { tool: 'ts_local_browser', arguments: { action: 'try_css', css: FINAL } };
  writeFileSync(join(jobDir, 'tool-log.jsonl'), JSON.stringify(entry) + '\n');
  const client = rpcClient({ V2_ROOT: root, V2_JOB_DIR: jobDir, V2_APP: 'air-reviews', V2_KB_SLUG: 'air-reviews', V2_BROWSER_ALLOWED: '0', V2_MCP_ENGINE: '1', V2_MAX_CSS_PREVIEW: '4', V2_ROUND: '2' });
  try {
    await client.request('initialize', { protocolVersion: '2025-06-18' });
    const refused = await client.call('submit_findings', submission([finding(FIRST, { details: 'Chưa thử được trên storefront vì browser tắt cho ticket này.' })]));
    assert.equal(refused.isError, true);
    assert.ok(!existsSync(join(jobDir, 'findings.json')));
    const accepted = await client.call('submit_findings', submission([finding(FINAL)]));
    assert.ok(!accepted.isError, accepted.content[0].text);
    assert.equal(JSON.parse(readFileSync(join(jobDir, 'findings-round2.json'), 'utf8')).findings[0].code, FINAL);
  } finally { await client.close(); }
});

test('normalizeCss ignores whitespace, comments, trailing semicolons and case; matchCssTrial picks the latest equal trial', () => {
  assert.equal(normalizeCss('/* c */ .A .B {\n  display : none ;\n}\n'), normalizeCss('.a .b{display:none}'));
  assert.notEqual(normalizeCss('.a .b{display:none}'), normalizeCss('.a .b{display:none !important}'));
  const log = [trialEntry(18, FIRST, { overridden: [{ selector: '.AirReviews-Widget__V2 .AirReviews-Blocks--Rate', property: 'display' }] }), trialEntry(19, FINAL), trialEntry(21, FINAL, { mobile: true })];
  const trials = cssTrialsFromLog(log);
  assert.deepEqual(trials.map(trial => trial.seq), [18, 19, 21]);
  assert.equal(matchCssTrial(`${FINAL}\n`, trials).seq, 21, 'the latest equal trial wins');
  assert.equal(matchCssTrial(FIRST, trials).seq, 18);
  assert.equal(matchCssTrial('.other { color: red }', trials), null);
  assert.equal(lastCssCallUnusable(log), null);
  assert.match(lastCssCallUnusable([...log, { seq: 22, tool: 'css_preview', ok: false, output: 'lỗi' }]), /seq 22\) lỗi/);
  assert.match(lastCssCallUnusable([trialEntry(5, FIRST, { unusable: 'trang mật khẩu' })]), /trang mật khẩu/);
  assert.ok(untriedReason('Chưa thử được trên storefront vì trang mật khẩu.') && untriedReason('không thể thử trên storefront') && !untriedReason('Đã thử trên storefront'));
});

test('cssTrialProblems: submitted CSS must equal a tried block with no real ✗; messages carry the last trial for copying; the untried sentence only counts with a real reason', () => {
  const trials = cssTrialsFromLog([trialEntry(18, FIRST, { overridden: [{ selector: '.AirReviews-Widget__V2 .AirReviews-Blocks--Rate', property: 'display' }] }), trialEntry(19, FINAL, { unknown: [{ selector: '.x', property: 'margin' }] })]);
  const live = { cssTrials: trials, browserAllowed: true, budgetLeft: 2, lastUnusable: null };
  assert.deepEqual(cssTrialProblems([finding(`  ${FINAL.replace(/\n/g, ' ')}  `)], live), [], 'whitespace-different copy of the final trial is accepted; unknown properties are not ✗');
  const other = cssTrialProblems([finding('.AirReviews-Widget__V2 .AirReviews-Blocks--List { display: none }')], live);
  assert.equal(other.length, 1); assert.match(other[0], /CSS nộp khác bản đã thử; chạy css_preview với đúng khối này \(còn 2 lượt\)/); assert.match(other[0], /Bản thử cuối \(css_preview seq 19, mọi thuộc tính đo được ✓\)/); assert.ok(other[0].includes(FINAL), 'the tried block is quoted for copying');
  const overridden = cssTrialProblems([finding(FIRST)], live);
  assert.equal(overridden.length, 1); assert.match(overridden[0], /đã thử ở css_preview seq 18 nhưng còn thuộc tính ✗ bị ghi đè thật: \.AirReviews-Widget__V2 \.AirReviews-Blocks--Rate → display/);
  const fakeUntried = cssTrialProblems([finding('.x .y { color: red }', { details: 'Chưa thử được trên storefront vì hết thời gian.' })], live);
  assert.equal(fakeUntried.length, 1); assert.match(fakeUntried[0], /browser đang bật và còn 2 lượt css_preview/);
  assert.deepEqual(cssTrialProblems([finding('.x .y { color: red }', { details: 'Chưa thử được trên storefront vì đã hết lượt.' })], { ...live, budgetLeft: 0 }), [], 'budget used up: the sentence is enough');
  assert.deepEqual(cssTrialProblems([finding('.x .y { color: red }', { details: 'Chưa thử được trên storefront vì browser tắt.' })], { cssTrials: [], browserAllowed: false, budgetLeft: 0 }), []);
  assert.deepEqual(cssTrialProblems([finding('.x .y { color: red }', { details: 'Chưa thử được trên storefront vì trang mật khẩu.' })], { ...live, lastUnusable: 'lần css_preview cuối (seq 20): trang mật khẩu' }), []);
  const noSentence = cssTrialProblems([finding('.x .y { color: red }')], { cssTrials: [], browserAllowed: false, budgetLeft: 0 });
  assert.equal(noSentence.length, 1); assert.match(noSentence[0], /chưa được thử \(browser tắt cho ticket này\) → ghi vào details câu "chưa thử được trên storefront vì browser tắt cho ticket này"/); assert.match(noSentence[0], /Chưa có lần css_preview nào/);
  assert.deepEqual(cssTrialProblems([finding('document.querySelector(".x").remove()', { code_lang: 'js' })], live), [], 'JS code is outside this rule');
  assert.deepEqual(validateFindings(submission([finding('.x .y { color: red }')])), [], 'without a context (finalize path) the trial rule is not judged');
  assert.equal(validateFindings(submission([finding('.x .y { color: red }')]), live).length, 1);
});

test('verifyFindings annotates css_trial and counts tried/untried; postcheck warns when an untried block is described without the sentence', () => {
  const toolLog = [trialEntry(19, FINAL)];
  const result = submission([finding(FINAL), { ...finding('.x .y { color: red }'), id: 'S2' }, { ...finding('.x .y { color: blue }', { details: 'Chưa thử được trên storefront vì hết lượt.' }), id: 'S3' }]);
  const verified = verifyFindings(result, { readSource: () => null, ticketText: '', toolLog });
  const byId = Object.fromEntries(verified.findings.map(item => [item.id, item]));
  assert.deepEqual(byId.S1.css_trial, { matched: true, seq: 19, round: 1, mobile: false, url: 'https://shop.example/products/a', overridden: [] });
  assert.deepEqual(byId.S2.css_trial, { matched: false, untried_reason: false });
  assert.deepEqual(byId.S3.css_trial, { matched: false, untried_reason: true });
  assert.equal(verified.stats.cssTried, 1); assert.equal(verified.stats.cssUntried, 1);
  const blocks = codeBlocks('```css\n.x .y { color: red }\n```');
  const warned = checkCustomizeCss(blocks, 'Dán CSS dưới đây; đã thử trên trang sản phẩm.', [byId.S2]);
  assert.ok(warned.warnings.some(item => /khối CSS của S2 không khớp bản css_preview nào đã thử/.test(item)), warned.warnings.join(' | '));
  assert.ok(!checkCustomizeCss(blocks, 'Chưa thử được trên storefront vì hết lượt.', [byId.S2]).warnings.some(item => /không khớp bản css_preview/.test(item)));
  assert.ok(!checkCustomizeCss(blocks, 'Đã thử.', [byId.S1]).warnings.some(item => /không khớp bản css_preview/.test(item)));
});

test('prompts: investigator must retry the final block and compare with the request; writer copies the final trial result and never describes an untried block as tried', () => {
  const prep = { reference: 'AIR-1', ticket: { ticketId: 'AIR-1', subject: '[Customize] hide stars', description: 'd', comments: [], storeDomains: ['a.myshopify.com'] }, app: { slug: 'air-reviews', kb: 'air-reviews', codeRoot: null, kbRoots: [], by: 'appName', appConflict: null }, scope: { locked: true, kbRoots: [], commonRoots: [], codeRoot: null }, customizeHint: true, oldCases: [], lessons: [], imageLinks: [] };
  const investigator = investigatorPrompt(prep, { deadline: Date.now() + 1000, maxTurns: 25, browserAllowed: true, sourceApi: true });
  assert.match(investigator, /Thử lại bản cuối \(14\/10\/2026/); assert.match(investigator, /gọi css_preview lại với ĐÚNG khối đó/); assert.match(investigator, /đối chiếu dòng kết quả với yêu cầu ticket/); assert.match(investigator, /code nộp phải bằng đúng khối đã thử/);
  const offline = investigatorPrompt(prep, { deadline: Date.now() + 1000, maxTurns: 25, browserAllowed: false, sourceApi: true });
  assert.match(offline, /chưa thử được trên storefront vì browser tắt cho ticket này/);
  const verified = { category: 'Customize', summary: 's', infeasible_reason: null, findings: [{ ...finding(FINAL), verified: true, score: 0.5, inference: false, css_trial: { matched: true, seq: 19, round: 1, mobile: false, overridden: [] } }] };
  const writer = writerPrompt(prep, verified, { maxChars: 4000, minChars: 150 });
  assert.match(writer, /css_trial\.matched = true/); assert.match(writer, /không viết như đã thử/); assert.ok(writer.includes('"seq": 19'), 'css_trial is passed to the writer');
});

function rpcClient(env) {
  const child = spawn(process.execPath, [resolve(HERE, 'tools-server.mjs')], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  let buffer = ''; let stderr = ''; let nextId = 1; const waiters = new Map();
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdout.on('data', chunk => {
    buffer += chunk; let index;
    while ((index = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, index); buffer = buffer.slice(index + 1); if (!line.trim()) continue; const message = JSON.parse(line); const waiter = waiters.get(message.id); if (waiter) { waiters.delete(message.id); waiter(message); } }
  });
  const request = (method, params) => new Promise((resolveRequest, reject) => { const id = nextId++; const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}; stderr: ${stderr}`)), 20000); waiters.set(id, message => { clearTimeout(timer); resolveRequest(message); }); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
  const call = async (name, args) => { const message = await request('tools/call', { name, arguments: args }); return message.result; };
  const close = () => new Promise(resolveClose => { child.on('close', resolveClose); child.stdin.end(); });
  return { request, call, close, stderr: () => stderr };
}

test('tools-server submit_findings reads the css_preview trials of earlier rounds from tool-log.jsonl: a different block is refused with the tried block, the tried block is accepted; with the browser off the untried sentence is required', async () => {
  const root = mkdtempSync(join(tmpdir(), 'v2-css-trial-'));
  mkdirSync(join(root, 'knowledge-base'), { recursive: true }); mkdirSync(join(root, 'apps_doc'), { recursive: true });
  const jobDir = join(root, 'job'); mkdirSync(jobDir);
  writeFileSync(join(jobDir, 'prepare.json'), JSON.stringify({ reference: 'AIR-1', ticket: { ticketId: 'AIR-1', subject: 's', comments: [], storeDomains: ['shop.example'] }, storeUrls: ['https://shop.example/'], app: { slug: 'air-reviews', kb: 'air-reviews' } }));
  writeFileSync(join(jobDir, 'tool-log.jsonl'), JSON.stringify(trialEntry(19, FINAL)) + '\n');
  const client = rpcClient({ V2_ROOT: root, V2_JOB_DIR: jobDir, V2_APP: 'air-reviews', V2_KB_SLUG: 'air-reviews', V2_BROWSER_ALLOWED: '1', V2_MAX_CSS_PREVIEW: '4', V2_MAX_TURNS: '50', V2_ROUND: '2' });
  try {
    await client.request('initialize', { protocolVersion: '2025-06-18' });
    const refused = await client.call('submit_findings', submission([finding('.AirReviews-Widget__V2 .AirReviews-Blocks--List { display: none }')]));
    assert.equal(refused.isError, true); assert.match(refused.content[0].text, /CSS nộp khác bản đã thử; chạy css_preview với đúng khối này \(còn 4 lượt\)/); assert.ok(refused.content[0].text.includes(FINAL));
    assert.ok(!existsSync(join(jobDir, 'findings.json')), 'nothing written when refused');
    const accepted = await client.call('submit_findings', submission([finding(`${FINAL}\n`)]));
    assert.ok(!accepted.isError, accepted.content[0].text); assert.match(accepted.content[0].text, /Đã nhận 1 findings/);
    assert.equal(JSON.parse(readFileSync(join(jobDir, 'findings-round2.json'), 'utf8')).findings[0].code, `${FINAL}\n`);
  } finally { await client.close(); }
  const offline = rpcClient({ V2_ROOT: root, V2_JOB_DIR: join(root, 'job2'), V2_APP: 'air-reviews', V2_KB_SLUG: 'air-reviews', V2_BROWSER_ALLOWED: '0', V2_MAX_TURNS: '50' });
  try {
    mkdirSync(join(root, 'job2')); writeFileSync(join(root, 'job2', 'prepare.json'), JSON.stringify({ reference: 'AIR-2', ticket: { ticketId: 'AIR-2', subject: 's', comments: [], storeDomains: [] }, storeUrls: [], app: { slug: 'air-reviews', kb: 'air-reviews' } }));
    await offline.request('initialize', { protocolVersion: '2025-06-18' });
    const refused = await offline.call('submit_findings', submission([finding(FIRST)]));
    assert.equal(refused.isError, true); assert.match(refused.content[0].text, /chưa được thử \(browser tắt cho ticket này\)/);
    const accepted = await offline.call('submit_findings', submission([finding(FIRST, { details: 'Dán vào DevZone. Chưa thử được trên storefront vì browser tắt cho ticket này.' })]));
    assert.ok(!accepted.isError, accepted.content[0].text);
  } finally { await offline.close(); }
});
