// Tests for the 14/10/2026 speed work (user order "tối ưu luồng search docs code api app, phân loại app theo ticket …
// hiện tại AI đang check ticket khá lâu"): keyword pre-search, Codex stop-after-submit / optional schema / reasoning,
// scope lock + batch read + settings cache + atomic submit in the tools server, and the new prompt blocks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractKeywords, preSearch } from './pre-search.mjs';
import { runCodex } from './codex.mjs';
import { investigatorPrompt, writerPrompt } from './prompts.mjs';
import { FINDINGS_SCHEMA, validateFindings } from './schema.mjs';
import { normalizeSourceApi } from './pipeline.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

test('extractKeywords: quoted strings and identifiers first, then error phrases, then the subject feature; app names and noise left out', () => {
  const queries = extractKeywords({
    subject: '[Bug] Air Reviews - Send discount email not received',
    description: 'Merchant enabled "Send discount via email right after reviews are created" but the customer never gets it. Console shows "Something went wrong in Meta Pixel". Key reviewWidget.hideNoStarRating is false; class .AirReviews-Blocks__List hidden. See https://capture.avada.io/i/abc.png',
    settingHint: true,
  });
  assert.equal(queries[0], 'Send discount via email right after reviews are created');
  assert.ok(queries.includes('Something went wrong in Meta Pixel'));
  assert.ok(queries.includes('reviewWidget.hideNoStarRating'));
  assert.ok(queries.includes('AirReviews-Blocks__List'));
  assert.ok(!queries.some(query => /capture\.avada|https?:/.test(query)), 'links are not keywords');
  assert.ok(!queries.some(query => /^air reviews$/i.test(query)), 'the app name is not a keyword');
  assert.ok(queries.length <= 10);
  assert.deepEqual(extractKeywords({ subject: '', description: 'hi' }), []);
  const noisy = extractKeywords({ subject: 'ORDL - multiples', description: 'session_583de245 on thorlo-socks-b2b.myshopify.com, id e4b4-490a-b88a-97692efd9053, see https://x.com/a-b-c-d; key applyAllVariant and add-to-cart flow' });
  assert.ok(noisy.includes('applyAllVariant') && noisy.includes('add-to-cart'), JSON.stringify(noisy));
  assert.ok(!noisy.some(query => /session_|thorlo|e4b4|a-b-c-d/.test(query)), `ids, shop handles and url parts are not keywords: ${JSON.stringify(noisy)}`);
  assert.equal(extractKeywords({ subject: 'JOY Loyalty - points expired too early', description: '' }).pop(), 'points expired too early');
});

test('preSearch runs one multi_search, formats it as data, writes a round-0 tool-log entry, and never throws', async () => {
  const jobDir = mkdtempSync(join(tmpdir(), 'v2-pre-'));
  const calls = [];
  const api = { search: async args => { calls.push(args); return { app: 'joy', ref: 'master', source: 'local_clone', commit: 'abc12345', ageMinutes: 3, truncated: false, totalMatches: 2, mode: 'fixed', queries: args.queries, matches: [{ path: 'packages/a.js', line: 3, text: 'const pointExpiredAfter = 30;', before: [], after: [], query: 'pointExpiredAfter' }, { path: 'packages/b.js', line: 9, text: 'pointExpiredAfter', before: [], after: [], query: 'pointExpiredAfter' }] }; } };
  const result = await preSearch({ ticket: { subject: 'JOY - "Point expiration" wrong', description: 'key pointExpiredAfter' }, app: 'joy', api, jobDir, settings: { maxChars: 3000 } });
  assert.equal(result.ok, true); assert.equal(calls.length, 1); assert.deepEqual(calls[0].queries.slice(0, 2), ['Point expiration', 'pointExpiredAfter']);
  assert.match(result.output, /^\[nguồn API: app joy/); assert.match(result.output, /api:joy\/packages\/a\.js:3: const pointExpiredAfter = 30;/);
  assert.deepEqual(result.files.map(file => file.path), ['packages/a.js', 'packages/b.js']);
  const log = readFileSync(join(jobDir, 'tool-log.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(log.length, 1); assert.equal(log[0].round, 0); assert.equal(log[0].tool, 'source_search'); assert.equal(log[0].args.preSearch, true); assert.equal(log[0].ok, true);
  const failing = await preSearch({ ticket: { subject: 'JOY - "Point expiration"', description: '' }, app: 'joy', api: { search: async () => { throw new Error('boom'); } }, jobDir: null, settings: {} });
  assert.equal(failing.ok, false); assert.equal(failing.reason, 'boom'); assert.equal(failing.output, null);
  assert.equal(await preSearch({ ticket: {}, app: 'joy', api, jobDir: null, settings: { enabled: false } }), null);
  assert.equal(await preSearch({ ticket: {}, app: null, api, jobDir: null }), null);
});

// A stand-in for `codex exec`: prints a thread.started event, writes the findings file after 300 ms (as submit_findings
// would), then keeps running for 20 s; a turn.completed event would follow only if nobody stopped it.
function fakeCodex(dir, findings) {
  const bin = join(dir, 'codex');
  writeFileSync(bin, `#!/usr/bin/env -S "${process.execPath}"
const fs = require('node:fs'); const path = require('node:path');
const args = process.argv.slice(2); const jobDir = args[args.indexOf('-C') + 1];
fs.writeFileSync(path.join(jobDir, 'argv.json'), JSON.stringify(args));
let input = ''; process.stdin.on('data', chunk => { input += chunk; }); process.stdin.on('end', () => fs.writeFileSync(path.join(jobDir, 'prompt.txt'), input));
process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 't1' }) + '\\n');
setTimeout(() => { const tmp = path.join(jobDir, '.f.tmp'); fs.writeFileSync(tmp, ${JSON.stringify(JSON.stringify(findings))}); fs.renameSync(tmp, path.join(jobDir, 'findings-round1.json')); }, 300);
setTimeout(() => { process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1 } }) + '\\n'); const out = args[args.indexOf('--output-last-message') + 1]; fs.writeFileSync(out, '"OK"'); process.exit(0); }, 20000);
`);
  chmodSync(bin, 0o755);
  return bin;
}

const FINDINGS = { category: 'Bug', category_reason: 'r', summary: 's', browser_impact: false, infeasible_reason: null, sources: [], findings: [{ id: 'F1', kind: 'gap', claim: 'c', quote: null, source: null, link: null, blocker: 'customer', searched: null, reply_needed: true, offer_fix: null, details: null, code: null, code_lang: null }] };

test('runCodex: stopWhen ends the run as soon as the findings file parses; schema null drops --output-schema; reasoning adds the config override', async () => {
  assert.deepEqual(validateFindings(FINDINGS), []);
  const dir = mkdtempSync(join(tmpdir(), 'v2-codex-')); const jobDir = join(dir, 'job'); mkdirSync(jobDir);
  const previous = process.env.CODEX_BIN; process.env.CODEX_BIN = fakeCodex(dir, FINDINGS);
  try {
    const started = Date.now();
    const run = await runCodex({ root: dir, jobDir, label: 'investigate', prompt: 'hello', schema: null, deadline: Date.now() + 60000, signal: null, reasoning: 'medium', stopPollMs: 200,
      stopWhen: async () => { try { const value = JSON.parse(readFileSync(join(jobDir, 'findings-round1.json'), 'utf8')); return !validateFindings(value).length; } catch { return false; } } });
    const elapsed = Date.now() - started;
    assert.equal(run.stopped, true, 'stopped by the watcher'); assert.equal(run.failure, null, 'a stop is not a failure');
    assert.ok(elapsed < 8000, `stopped early (${elapsed} ms), not after the 20 s the fake would run`);
    assert.equal(run.threadId, 't1', 'events produced before the stop are kept'); assert.equal(run.usage, null, 'no turn.completed: the run was cut');
    assert.ok(existsSync(join(jobDir, 'investigate-events.jsonl')));
    const argv = JSON.parse(readFileSync(join(jobDir, 'argv.json'), 'utf8'));
    assert.ok(!argv.includes('--output-schema'), 'no schema for the investigator'); assert.ok(argv.includes('--output-last-message'));
    assert.ok(argv.includes('model_reasoning_effort="medium"'), 'reasoning override passed as -c');
    assert.ok(!existsSync(join(jobDir, 'investigate-schema.json')));
    assert.equal(readFileSync(join(jobDir, 'prompt.txt'), 'utf8'), 'hello');
    // Without a watcher and with a schema the old behaviour holds (the fake finishes by itself at 20 s → use a short deadline instead).
    const timed = await runCodex({ root: dir, jobDir, label: 'write', prompt: 'x', schema: { type: 'object' }, deadline: Date.now() + 2000, signal: null });
    assert.equal(timed.stopped, false); assert.ok(timed.failure, 'the timeout is still a failure');
    const argv2 = JSON.parse(readFileSync(join(jobDir, 'argv.json'), 'utf8'));
    assert.ok(argv2.includes('--output-schema') && !argv2.some(arg => arg.includes('model_reasoning_effort')));
  } finally { if (previous === undefined) delete process.env.CODEX_BIN; else process.env.CODEX_BIN = previous; }
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

test('tools-server with V2_SCOPE_LOCK: rg_search/read_file stay in the app\'s KB + common folders, other apps are refused, source_read batches, settings come from the prepare cache, submit writes atomically', async () => {
  const root = mkdtempSync(join(tmpdir(), 'v2-scope-'));
  for (const dir of ['knowledge-base/knowledge/joy', 'knowledge-base/knowledge/wishlist', 'knowledge-base/skills/investigate/_common', 'knowledge-base/app-guides', 'apps_doc/joy', 'apps_doc/wishlist']) mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, 'knowledge-base/knowledge/joy/points.md'), 'needleValue in joy KB\n');
  writeFileSync(join(root, 'knowledge-base/knowledge/wishlist/w.md'), 'needleValue in wishlist KB\n');
  writeFileSync(join(root, 'knowledge-base/skills/investigate/_common/thinking.md'), 'needleValue in common\n');
  writeFileSync(join(root, 'knowledge-base/app-guides/joy.md'), 'needleValue in joy guide\n');
  writeFileSync(join(root, 'knowledge-base/app-guides/wishlist.md'), 'needleValue in wishlist guide\n');
  writeFileSync(join(root, 'apps_doc/joy/a.js'), 'const needleValue = 1;\n'); writeFileSync(join(root, 'apps_doc/joy/b.js'), 'const other = 2;\n');
  writeFileSync(join(root, 'apps_doc/wishlist/w.js'), 'needleValue\n');
  const jobDir = join(root, 'job'); mkdirSync(jobDir);
  writeFileSync(join(jobDir, 'prepare.json'), JSON.stringify({ reference: 'JOY-1', ticket: { ticketId: 'JOY-1', subject: 's', comments: [], storeDomains: ['shop.example'] }, storeUrls: ['https://shop.example/'],
    app: { slug: 'joy', kb: 'joy' }, scope: { locked: true, kbRoots: ['knowledge-base/knowledge/joy', 'knowledge-base/app-guides/joy.md'], commonRoots: ['knowledge-base/skills/investigate/_common'], codeRoot: 'apps_doc/joy' },
    settingsPre: { url: 'https://shop.example/', status: 200, password: false, at: '2026-10-14T05:00:00.000Z', found: [{ name: 'AVADA_JOY', value: { pointExpiration: { deductByEarnedTime: true }, shop: 'x' } }], lines: [] } }));
  const client = rpcClient({ V2_ROOT: root, V2_JOB_DIR: jobDir, V2_APP: 'joy', V2_KB_SLUG: 'joy', V2_SCOPE_LOCK: '1', V2_MAX_TURNS: '50', V2_MAX_SHOP_SETTINGS: '3' });
  try {
    await client.request('initialize', { protocolVersion: '2025-06-18' });
    const hit = await client.call('rg_search', { query: 'needleValue', scope: 'all' });
    const out = hit.content[0].text;
    assert.match(out, /Phạm vi khóa theo app joy/);
    assert.ok(out.includes('knowledge-base/knowledge/joy/points.md:1') && out.includes('knowledge-base/app-guides/joy.md:1') && out.includes('_common/thinking.md:1') && out.includes('apps_doc/joy/a.js:1'), out);
    assert.ok(!out.includes('wishlist'), 'nothing from another app, even though the whole tree has matches');
    const refused = await client.call('rg_search', { query: 'needleValue', app: 'wishlist' });
    assert.equal(refused.isError, true); assert.match(refused.content[0].text, /không tra app khác/);
    const outside = await client.call('read_file', { path: 'knowledge-base/knowledge/wishlist/w.md' });
    assert.equal(outside.isError, true); assert.match(outside.content[0].text, /Ngoài phạm vi app joy/);
    const inside = await client.call('read_file', { path: 'knowledge-base/skills/investigate/_common/thinking.md' });
    assert.match(inside.content[0].text, /1\| needleValue in common/);
    const guide = await client.call('read_file', { path: 'knowledge-base/app-guides/joy.md' });
    assert.equal(guide.isError, undefined, guide.content[0].text);
    // Batch read on the fallback copy (no Source API in this process): two files, one turn.
    const batch = await client.call('source_read', { files: [{ file: 'a.js', lines: '1-1' }, { file: 'b.js' }, { file: 'missing.js' }] });
    const text = batch.content[0].text;
    assert.match(text, /=== \[1\/3\] a\.js\n/); assert.match(text, /1\| const needleValue = 1;/); assert.match(text, /=== \[2\/3\] b\.js\n/); assert.match(text, /=== \[3\/3\] missing\.js \(lỗi\)/);
    assert.equal(batch.isError, undefined, 'one readable file makes the batch a success');
    const otherApp = await client.call('source_read', { file: 'w.js', app: 'wishlist' });
    assert.equal(otherApp.isError, true); assert.match(otherApp.content[0].text, /không tra app khác/);
    // shop_settings answers from the prepare-phase cache: no browser, same page.
    const settings = await client.call('shop_settings', { source: 'storefront', path: 'pointExpiration' });
    assert.equal(settings.isError, undefined, settings.content[0].text);
    assert.match(settings.content[0].text, /không tải lại/); assert.match(settings.content[0].text, /\[nguồn: settings:joy\/storefront · https:\/\/shop\.example\/ · HTTP 200 · đọc lúc 2026-10-14T05:00:00\.000Z\]/);
    assert.match(settings.content[0].text, /AVADA_JOY\.pointExpiration\.deductByEarnedTime = true/);
    const submitted = await client.call('submit_findings', FINDINGS);
    assert.match(submitted.content[0].text, /^Đã nhận 1 findings/);
  } finally { await client.close(); }
  assert.ok(!readdirSync(jobDir).some(name => name.endsWith('.tmp')), 'no temp file left behind');
  assert.deepEqual(JSON.parse(readFileSync(join(jobDir, 'findings-round1.json'), 'utf8')).category, 'Bug');
  const log = readFileSync(join(jobDir, 'tool-log.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(log.filter(call => call.tool === 'source_read').length, 2, 'a batch is one log entry');
});

test('prompts: scope line, pre-search and pre-read settings blocks, OK ack for the investigator; hedge list for the writer', () => {
  const prep = { reference: 'JOY-1', ticket: { ticketId: 'JOY-1', subject: 's', description: 'd', comments: [], storeDomains: [] }, app: { slug: 'joy', kb: 'joy', codeRoot: 'apps_doc/joy', kbRoots: ['knowledge-base/knowledge/joy'], by: 'appName', appConflict: { appName: 'JOY Loyalty', prefix: 'JSUB', appNameSlug: 'joy', prefixSlug: 'joy-subs', chosen: 'joy' } },
    scope: { locked: true, kbRoots: ['knowledge-base/knowledge/joy'], commonRoots: ['knowledge-base/feedback'], codeRoot: 'apps_doc/joy' },
    preSearch: { ok: true, queries: ['pointExpiredAfter'], output: '[nguồn API: app joy …]\napi:joy/packages/a.js:3: const pointExpiredAfter = 30;', truncated: false },
    settingsPre: { url: 'https://shop.example/', status: 200, password: false, at: '2026-10-14T05:00:00.000Z', lines: ['AVADA_JOY.pointExpiration.deductByEarnedTime = true'] },
    oldCases: [], lessons: [], imageLinks: [] };
  const prompt = investigatorPrompt(prep, { deadline: Date.now() + 1000, maxTurns: 25, browserAllowed: false, sourceApi: true });
  assert.match(prompt, /Phạm vi tra ĐÃ KHÓA theo app của ticket: tool mã nguồn chỉ đọc app joy; rg_search\/read_file chỉ trong knowledge-base\/knowledge\/joy, knowledge-base\/feedback/);
  assert.match(prompt, /tiền tố JSUB trỏ app khác \(joy-subs\), chọn theo trường app/);
  assert.match(prompt, /Tiền tra \(code đã chạy source_search với từ khóa rút từ ticket: "pointExpiredAfter"\)/); assert.match(prompt, /api:joy\/packages\/a\.js:3: const pointExpiredAfter = 30;/);
  assert.match(prompt, /Cấu hình shop đọc trước bằng code/); assert.match(prompt, /AVADA_JOY\.pointExpiration\.deductByEarnedTime = true/);
  assert.match(prompt, /kết thúc ngay bằng câu trả lời đúng một chữ: OK/); assert.ok(!prompt.includes('trả lời cuối cùng đúng JSON findings vừa nộp'));
  const round2 = investigatorPrompt(prep, { deadline: Date.now() + 1000, maxTurns: 6, browserAllowed: false, round: 2, gaps: [{ id: 'G1', claim: 'c', reason: 'r' }], previous: FINDINGS, sourceApi: true });
  assert.ok(!round2.includes('Tiền tra ('), 'the extra round does not repeat the pre-search block');
  const open = investigatorPrompt({ ...prep, app: { slug: null, kb: null, codeRoot: null, kbRoots: [], by: null, appConflict: null }, scope: { locked: false, kbRoots: [], commonRoots: [], codeRoot: null }, preSearch: null, settingsPre: null }, { deadline: Date.now() + 1000, maxTurns: 25, browserAllowed: false, sourceApi: false });
  assert.match(open, /Phạm vi tra: app chưa xác định được nên tool tìm trên toàn bộ knowledge-base\//);
  const verified = { category: 'Bug', summary: 's', findings: [{ id: 'F1', kind: 'fact', verified: true, inference: false, claim: 'a', quote: 'q', source: { ref: 'api:joy/a.js' }, score: 1 }, { id: 'F2', kind: 'fact', verified: true, inference: true, claim: 'b', quote: 'q', source: { ref: 'api:joy/a.js' }, score: 1 }, { id: 'G1', kind: 'gap', verified: false, inference: false, claim: 'c', blocker: 'dev', gap_ok: true }, { id: 'S1', kind: 'suggestion', verified: false, inference: false, claim: 'd', score: 0.5 }] };
  const writer = writerPrompt(prep, verified, { maxChars: 4000, minChars: 150 });
  assert.match(writer, /KIỂM TRA TRƯỚC KHI NỘP: mọi câu dùng F2, G1, S1 \(gap, chưa kiểm, suy luận hoặc đề xuất\) phải chứa từ rào/);
  assert.ok(!/mọi câu dùng F1,/.test(writer), 'a verified fact is not in the hedge list');
});

test('loadSettings-style normalisation keeps the Source API defaults untouched by the new keys', () => {
  const api = normalizeSourceApi({ enabled: true, timeoutMs: 8000 });
  assert.equal(api.enabled, true); assert.equal(api.timeoutMs, 8000);
  assert.deepEqual(Object.keys(FINDINGS_SCHEMA.properties), ['category', 'category_reason', 'summary', 'browser_impact', 'infeasible_reason', 'findings', 'sources']);
});
