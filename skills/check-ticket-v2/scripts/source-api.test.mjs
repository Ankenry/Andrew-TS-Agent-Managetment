// node --test skills/check-ticket-v2/scripts/ — Source API client, formatting, fallback to apps_doc and key hygiene.
// The integration part starts a fake Source API on 127.0.0.1 and drives the real tools-server over stdio.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSourceApi, formatSearch, formatRead, fallbackHeader, readKeyFile, resolveKey, shouldFallback, SourceApiError, readManifest, MAX_SEARCH_RESULTS } from './source-api.mjs';
import { normalizeSourceApi, sourceApiPlan } from './pipeline.mjs';
import { investigatorPrompt } from './prompts.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const KEY = 'tsk_test_key_DO_NOT_LEAK_9f8e7d';

function fakeFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, auth: init.headers.Authorization, body });
    const { status = 200, json } = await handler(body, calls.length);
    return { status, text: async () => (typeof json === 'string' ? json : JSON.stringify(json)) };
  };
  return { fetchImpl, calls };
}
const grepResult = (n, { app = 'joy', text = 'const x = settings.cartDrawerRedeemInline;' } = {}) => ({
  ok: true, app, action: 'grep', source: 'local_clone', ref: 'master', commit: 'abcdef1234567890', fetched_at: '2026-10-09T09:00:00Z', age_minutes: 4, truncated: n > 50, total_matches: n,
  matches: Array.from({ length: n }, (_, i) => ({ path: `packages/scripttag/file${i % 7}.js`, line: i + 1, text: `${text} // ${'x'.repeat(i === 0 ? 400 : 10)}`, before: ['// before'], after: ['// after'] })),
});

test('readKeyFile / resolveKey read BEARER_Auth from a .env_my-style file and never throw', () => {
  const dir = mkdtempSync(join(tmpdir(), 'v2-key-'));
  writeFileSync(join(dir, '.env_my'), `# comment\nAPI_AVADA_TICKET=other\nexport BEARER_Auth="Bearer ${KEY}"\n`);
  assert.equal(readKeyFile(join(dir, '.env_my')), KEY);
  assert.equal(readKeyFile(join(dir, 'missing')), null);
  assert.equal(resolveKey({ SOURCE_API_KEY: ' explicit ' }), 'explicit');
  assert.equal(resolveKey({ SOURCE_API_KEY_FILE: join(dir, '.env_my') }), KEY);
  assert.equal(resolveKey({}), null);
});

test('search: regex → grep, strings → multi_search; results normalized with commit and age', async () => {
  const { fetchImpl, calls } = fakeFetch(async body => {
    if (body.action === 'grep') return { json: grepResult(3) };
    return { json: { ok: true, app: 'joy', action: 'multi_search', source: 'local_clone', ref: 'master', commit: 'fedcba9876543210', age_minutes: 1, results: [{ query: 'Accept all', matches: [{ path: 'a.js', line: 2, text: 'Accept all' }] }, { query: 'acceptAll', matches: [{ path: 'b.js', line: 5, text: 'acceptAll()' }] }] } };
  });
  const api = createSourceApi({ key: KEY, fetchImpl, endpoint: 'https://example.test/search' });
  const regex = await api.search({ app: 'joy', query: 'cart.*Inline', regex: true, glob: ['packages/**'], context: 2, max: 20 });
  assert.equal(calls[0].body.action, 'grep'); assert.equal(calls[0].body.format, 'json'); assert.deepEqual(calls[0].body.glob, ['packages/**']); assert.equal(calls[0].body.context, 2);
  assert.equal(calls[0].auth, `Bearer ${KEY}`);
  assert.equal(regex.commit, 'abcdef1234567890'); assert.equal(regex.ageMinutes, 4); assert.equal(regex.matches.length, 3); assert.equal(regex.mode, 'regex');
  const fixed = await api.search({ app: 'joy', queries: ['Accept all', 'acceptAll'] });
  assert.equal(calls[1].body.action, 'multi_search'); assert.deepEqual(calls[1].body.queries, ['Accept all', 'acceptAll']);
  assert.deepEqual(fixed.matches.map(match => `${match.path}:${match.line}[${match.query}]`), ['a.js:2[Accept all]', 'b.js:5[acceptAll]']);
});

test('read: lines are capped at 400 and the answer keeps total/start/end', async () => {
  const { fetchImpl, calls } = fakeFetch(async body => ({ json: { ok: true, app: 'joy', action: 'read', source: 'gitlab_live', ref: 'master', file: body.file, total_lines: 1000, start_line: 10, end_line: 409, truncated: false, content: 'line a\nline b\n' } }));
  const api = createSourceApi({ key: KEY, fetchImpl });
  const result = await api.read({ app: 'joy', file: 'packages/x.js', start: 10, end: 2000 });
  assert.equal(calls[0].body.lines, '10-409');
  assert.equal(result.totalLines, 1000); assert.equal(result.start, 10);
  assert.match(formatRead(result), /^api:joy\/packages\/x\.js \(dòng 10-11 \/ 1000 · GitLab bản mới nhất, ref master\)\n10\| line a\n11\| line b$/);
});

test('errors are classified; only transient ones fall back; transient ones are retried once', async () => {
  let attempts = 0;
  const { fetchImpl } = fakeFetch(async (body) => {
    attempts++;
    if (body.app === 'nope') return { status: 404, json: { ok: false, error: 'Unknown app slug "nope". Known: joy, chatty, cookie-bar.' } };
    if (body.app === 'missing-file') return { status: 404, json: { ok: false, error: 'GitLab read HTTP 404 for x@master' } };
    if (body.app === 'bad') return { status: 400, json: { ok: false, error: 'invalid regex' } };
    if (body.app === 'auth') return { status: 403, json: { error: 'Forbidden' } };
    if (body.app === 'busy') return { status: 503, json: { ok: false, error: 'clone not ready' } };
    if (body.app === 'boom') return { status: 500, json: 'Internal error' };
    return { json: grepResult(1) };
  });
  const api = createSourceApi({ key: KEY, fetchImpl, maxRetries: 1 });
  const kind = async (app, fn = 'search') => api[fn]({ app, query: 'x', regex: true, file: 'x' }).then(() => null, error => error);
  const unknown = await kind('nope'); assert.equal(unknown.kind, 'unknown_app'); assert.deepEqual(unknown.apps, ['joy', 'chatty', 'cookie-bar']); assert.equal(shouldFallback(unknown), true);
  const notFound = await kind('missing-file', 'read'); assert.equal(notFound.kind, 'not_found'); assert.equal(shouldFallback(notFound), false);
  const bad = await kind('bad'); assert.equal(bad.kind, 'bad_request'); assert.equal(shouldFallback(bad), false);
  const auth = await kind('auth'); assert.equal(auth.kind, 'unauthorized'); assert.equal(shouldFallback(auth), false);
  const busy = await kind('busy'); assert.equal(busy.kind, 'unavailable'); assert.equal(shouldFallback(busy), true);
  attempts = 0;
  const boom = await kind('boom'); assert.equal(boom.kind, 'server'); assert.equal(shouldFallback(boom), true); assert.equal(attempts, 2, 'one retry for 5xx');
  const timeoutApi = createSourceApi({ key: KEY, timeoutMs: 20, maxRetries: 0, fetchImpl: (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))) });
  const timeout = await timeoutApi.search({ app: 'joy', query: 'x' }).then(() => null, error => error); assert.equal(timeout.kind, 'timeout'); assert.equal(shouldFallback(timeout), true);
  const netApi = createSourceApi({ key: KEY, maxRetries: 0, fetchImpl: async () => { throw new Error(`ECONNREFUSED while sending ${KEY}`); } });
  const net = await netApi.search({ app: 'joy', query: 'x' }).then(() => null, error => error); assert.equal(net.kind, 'network'); assert.ok(!net.message.includes(KEY), 'key scrubbed from error text');
  assert.throws(() => createSourceApi({ key: '' }), SourceApiError);
});

test('formatSearch caps lines (40 max, 6 per file), clips long lines, labels paths api:<app>/… and shows commit/age', () => {
  const api = createSourceApi({ key: KEY, fetchImpl: async () => ({ status: 200, text: async () => JSON.stringify(grepResult(120)) }) });
  return api.search({ app: 'joy', query: 'x', regex: true, max: 100 }).then(result => {
    const out = formatSearch(result, { max: 100 });
    const hits = out.split('\n').filter(line => /^api:joy\/packages\/scripttag\/file\d\.js:\d+: /.test(line));
    assert.equal(hits.length, MAX_SEARCH_RESULTS);
    assert.match(out, /^\[nguồn API: app joy · clone 4 phút · commit abcdef12 · ref master\] 120 dòng khớp \(API cắt bớt\) trong 7 file; hiển thị 40\./);
    assert.ok(hits.every(line => line.length <= 240 + 60), 'long match text clipped');
    assert.match(out, /api:joy\/packages\/scripttag\/file0\.js-0- \/\/ before/);
    assert.ok(!out.includes(KEY));
    const perFile = {}; for (const line of hits) { const file = line.split(':')[1]; perFile[file] = (perFile[file] || 0) + 1; }
    assert.ok(Object.values(perFile).every(count => count <= 6), `per-file cap: ${JSON.stringify(perFile)}`);
  });
});

test('fallbackHeader names the apps_doc copy, its commit and why the API was not used', () => {
  assert.equal(fallbackHeader('joy', 'a05b7566abcdef', '2026-10-07T04:03:02.581Z', new SourceApiError('timeout', 'Source API không trả lời trong 8000 ms')), '[nguồn: apps_doc@a05b7566 (bản sao tải 2026-10-07) · app joy · dự phòng vì API nguồn timeout: Source API không trả lời trong 8000 ms]');
  assert.match(fallbackHeader('joy', null, null, null), /apps_doc@\? \(bản sao\) · app joy · dự phòng vì API nguồn API tắt\]/);
});

test('normalizeSourceApi / sourceApiPlan: defaults, env override, app and key file requirements', () => {
  assert.deepEqual(normalizeSourceApi(undefined, {}), { enabled: true, endpoint: 'https://ts2.avada.net/api/v1/source/search', timeoutMs: 8000, maxRetries: 1, keyFile: '.env_my' });
  assert.equal(normalizeSourceApi({ enabled: true }, { CHECK_TICKET_SOURCE_API: '0' }).enabled, false);
  assert.equal(normalizeSourceApi({ enabled: false }, { CHECK_TICKET_SOURCE_API: '1' }).enabled, true);
  assert.equal(normalizeSourceApi({ timeoutMs: 999999, endpoint: 'ftp://x' }, {}).timeoutMs, 30000);
  assert.equal(normalizeSourceApi({ endpoint: 'ftp://x' }, {}).endpoint, 'https://ts2.avada.net/api/v1/source/search');
  const root = mkdtempSync(join(tmpdir(), 'v2-plan-'));
  const settings = { sourceApi: normalizeSourceApi({}, {}) };
  assert.equal(sourceApiPlan(settings, { app: { slug: 'joy' } }, root).enabled, false, 'no key file → off');
  writeFileSync(join(root, '.env_my'), `BEARER_Auth=${KEY}\n`);
  const plan = sourceApiPlan(settings, { app: { slug: 'joy' } }, root);
  assert.equal(plan.enabled, true); assert.equal(plan.keyFile, resolve(root, '.env_my'));
  assert.equal(sourceApiPlan(settings, { app: { slug: null } }, root).enabled, false, 'unknown app → off');
  assert.equal(sourceApiPlan({ sourceApi: { enabled: false } }, { app: { slug: 'joy' } }, root).enabled, false);
});

test('investigatorPrompt tells the model to locate with source_search and quote from source_read when the API is on', () => {
  const prep = { reference: 'JOY-1', ticket: { subject: 's', comments: [] }, app: { slug: 'joy', codeRoot: 'apps_doc/joy', kbRoots: [] }, oldCases: [], lessons: [] };
  const on = investigatorPrompt(prep, { deadline: Date.now() + 1000, maxTurns: 5, browserAllowed: false, sourceApi: true });
  assert.match(on, /source_search/); assert.match(on, /source_read đúng file quanh dòng khớp/); assert.match(on, /type "api"/); assert.match(on, /API nguồn app joy \(bản mới nhất/);
  const off = investigatorPrompt(prep, { deadline: Date.now() + 1000, maxTurns: 5, browserAllowed: false });
  assert.ok(!off.includes('source_search')); assert.match(off, /mã nguồn: apps_doc\/joy/);
});

test('readManifest maps slug → commit/fetchedAt and tolerates a missing file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'v2-manifest-'));
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ apps: { joy: { slug: 'joy', commit: 'a05b7566abc', fetchedAt: '2026-10-07T04:03:02Z' }, 'withdrawal-forms': { slug: 'withdrawal-forms', ok: false, error: 'HTTP 404', fetchedAt: '2026-10-07T04:03:02Z' } }, updatedAt: 'x' }));
  assert.deepEqual(readManifest(join(dir, 'manifest.json')), { joy: { commit: 'a05b7566abc', fetchedAt: '2026-10-07T04:03:02Z' } });
  assert.deepEqual(readManifest(join(dir, 'none.json')), {});
});

// ---- integration: real tools-server + fake API --------------------------------------------------------------
function rpcClient(env) {
  const child = spawn(process.execPath, [resolve(HERE, 'tools-server.mjs')], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  let buffer = ''; const waiters = new Map(); let nextId = 1; let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdout.on('data', chunk => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      const waiter = waiters.get(message.id);
      if (waiter) { waiters.delete(message.id); waiter(message); }
    }
  });
  const request = (method, params) => new Promise((resolveRequest, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}; stderr: ${stderr}`)), 20000);
    waiters.set(id, message => { clearTimeout(timer); resolveRequest(message); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const call = async (name, args) => { const message = await request('tools/call', { name, arguments: args }); return message.result; };
  const close = () => new Promise(resolveClose => { child.on('close', resolveClose); child.stdin.end(); });
  return { request, call, close, stderr: () => stderr };
}

test('tools-server: source tools use the API, fall back to apps_doc on 5xx/unknown app, never leak the key', async () => {
  const root = mkdtempSync(join(tmpdir(), 'v2-root-'));
  mkdirSync(join(root, 'apps_doc/joy/packages/scripttag'), { recursive: true });
  mkdirSync(join(root, 'knowledge-base/knowledge/joy'), { recursive: true });
  writeFileSync(join(root, 'apps_doc/joy/packages/scripttag/RedeemCartAdapter.js'), "const selector = settings.cartDrawerRedeemInline || 'cart-drawer';\nif (!document.querySelector(selector)) return null;\n");
  writeFileSync(join(root, 'apps_doc/manifest.json'), JSON.stringify({ apps: { joy: { slug: 'joy', commit: 'a05b7566abcdef', fetchedAt: '2026-10-07T04:03:02Z' } } }));
  writeFileSync(join(root, 'knowledge-base/knowledge/joy/cart-drawer.md'), '# Cart drawer\ncartDrawerRedeemInline is the DevZone key.\n');
  writeFileSync(join(root, '.env_my'), `BEARER_Auth="${KEY}"\n`);
  const jobDir = join(root, 'job'); mkdirSync(jobDir);
  writeFileSync(join(jobDir, 'prepare.json'), JSON.stringify({ reference: 'JOY-1', ticket: { ticketId: 'JOY-1', subject: 's', comments: [] } }));

  let mode = 'ok'; const seen = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const payload = JSON.parse(body); seen.push({ auth: req.headers.authorization, payload });
      const reply = (status, json) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(json)); };
      if (mode === '500') return reply(500, { ok: false, error: 'tool crashed' });
      if (mode === 'unknown') return reply(404, { ok: false, error: 'Unknown app slug "joy". Known: chatty, cookie-bar.' });
      if (payload.action === 'read') {
        if (payload.file === 'gone.js') return reply(404, { ok: false, error: 'GitLab read HTTP 404 for gone.js@master' });
        return reply(200, { ok: true, app: 'joy', action: 'read', source: 'gitlab_live', ref: 'master', file: payload.file, total_lines: 2, start_line: 1, end_line: 2, truncated: false, content: "const selector = settings.cartDrawerRedeemInline || 'cart-drawer-live';\nreturn selector;\n" });
      }
      if (payload.action === 'grep') return reply(200, grepResult(3));
      return reply(200, { ok: true, app: 'joy', action: 'multi_search', source: 'local_clone', ref: 'master', commit: '958ffb09aaaa', age_minutes: 2, results: [{ query: payload.queries[0], matches: [{ path: 'packages/scripttag/RedeemCartAdapter.js', line: 1, text: 'const selector = settings.cartDrawerRedeemInline || …;' }] }] });
    });
  });
  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
  after(() => server.close());
  const endpoint = `http://127.0.0.1:${server.address().port}/api/v1/source/search`;

  const client = rpcClient({ V2_ROOT: root, V2_JOB_DIR: jobDir, V2_APP: 'joy', V2_KB_SLUG: 'joy', V2_MAX_TURNS: '50', SOURCE_API_ENABLED: '1', SOURCE_API_URL: endpoint, SOURCE_API_TIMEOUT_MS: '3000', SOURCE_API_RETRIES: '0', SOURCE_API_KEY_FILE: join(root, '.env_my') });
  try {
    await client.request('initialize', { protocolVersion: '2025-06-18' });
    const list = await client.request('tools/list', {});
    const names = list.result.tools.map(tool => tool.name);
    assert.ok(['source_search', 'source_read'].every(name => names.includes(name)), 'Source API tools remain exposed alongside other read-only tools');
    assert.ok(names.includes('rg_search') && names.includes('submit_findings'));

    const search = await client.call('source_search', { queries: ['cartDrawerRedeemInline'] });
    assert.equal(search.isError, undefined, search.content[0].text);
    assert.match(search.content[0].text, /^\[nguồn API: app joy · clone 2 phút · commit 958ffb09 · ref master\]/);
    assert.match(search.content[0].text, /api:joy\/packages\/scripttag\/RedeemCartAdapter\.js:1: /);
    assert.equal(seen[0].auth, `Bearer ${KEY}`, 'server sends the key from the key file');
    assert.equal(seen[0].payload.action, 'multi_search');

    const read = await client.call('source_read', { file: 'api:joy/packages/scripttag/RedeemCartAdapter.js', lines: '1-2' });
    assert.match(read.content[0].text, /^api:joy\/packages\/scripttag\/RedeemCartAdapter\.js \(dòng 1-2 \/ 2 · GitLab bản mới nhất, ref master\)\n1\| const selector = settings\.cartDrawerRedeemInline \|\| 'cart-drawer-live';/);
    assert.equal(seen[1].payload.file, 'packages/scripttag/RedeemCartAdapter.js', 'api: prefix stripped before calling the API');

    const gone = await client.call('source_read', { file: 'gone.js' });
    assert.equal(gone.isError, true); assert.match(gone.content[0].text, /không có file gone\.js trong bản mới nhất/);

    mode = '500';
    const fallback = await client.call('source_search', { query: 'cartDrawerRedeemInline' });
    assert.equal(fallback.isError, undefined, fallback.content[0].text);
    assert.match(fallback.content[0].text, /^\[nguồn: apps_doc@a05b7566 \(bản sao tải 2026-10-07\) · app joy · dự phòng vì API nguồn server: /);
    assert.match(fallback.content[0].text, /apps_doc\/joy\/packages\/scripttag\/RedeemCartAdapter\.js:1: const selector/);
    const fallbackRead = await client.call('source_read', { file: 'packages/scripttag/RedeemCartAdapter.js', lines: '1-1' });
    assert.match(fallbackRead.content[0].text, /^\[nguồn: apps_doc@a05b7566.*\napps_doc\/joy\/packages\/scripttag\/RedeemCartAdapter\.js \(dòng 1-1 \/ 3\)\n1\| const selector/);

    mode = 'unknown';
    const unknown = await client.call('source_search', { query: 'cartDrawerRedeemInline' });
    assert.match(unknown.content[0].text, /dự phòng vì API nguồn unknown_app/);

    mode = 'ok';
    const kb = await client.call('rg_search', { query: 'cartDrawerRedeemInline' });
    assert.match(kb.content[0].text, /Phạm vi: knowledge-base\//);
    assert.match(kb.content[0].text, /knowledge-base\/knowledge\/joy\/cart-drawer\.md:2:/);
    assert.ok(!kb.content[0].text.includes('apps_doc/'), 'rg_search defaults to KB when the API is on');
    const code = await client.call('rg_search', { query: 'cartDrawerRedeemInline', scope: 'code' });
    assert.match(code.content[0].text, /apps_doc\/joy\/packages\/scripttag\/RedeemCartAdapter\.js:1:/);
  } finally { await client.close(); }

  const log = readFileSync(join(jobDir, 'tool-log.jsonl'), 'utf8');
  assert.ok(log.split('\n').filter(Boolean).length >= 7);
  assert.ok(!log.includes(KEY), 'tool log must not contain the key');
  const state = JSON.parse(readFileSync(join(jobDir, 'source-api.json'), 'utf8'));
  assert.equal(state.enabled, true); assert.equal(state.calls, 2); assert.equal(state.fallbacks, 3);
  assert.equal(state.apps.joy.commit, '958ffb09aaaa'); assert.equal(state.apps.joy.ageMinutes, 2);
  assert.ok(state.errors.some(error => error.kind === 'server' && error.fallback === true));
  assert.ok(!JSON.stringify(state).includes(KEY));
  assert.ok(!existsSync(join(jobDir, 'prepare.json')) || !readFileSync(join(jobDir, 'prepare.json'), 'utf8').includes(KEY));
});

test('tools-server without SOURCE_API_ENABLED lists no source tools and rg_search keeps the old default scope', async () => {
  const root = mkdtempSync(join(tmpdir(), 'v2-root-off-'));
  mkdirSync(join(root, 'apps_doc/joy'), { recursive: true }); mkdirSync(join(root, 'knowledge-base'), { recursive: true });
  writeFileSync(join(root, 'apps_doc/joy/a.js'), 'needleValue\n');
  const jobDir = join(root, 'job'); mkdirSync(jobDir);
  const client = rpcClient({ V2_ROOT: root, V2_JOB_DIR: jobDir, V2_APP: 'joy', V2_KB_SLUG: 'joy' });
  try {
    const list = await client.request('tools/list', {});
    const names = list.result.tools.map(tool => tool.name);
    assert.ok(!names.includes('source_search') && !names.includes('source_read'));
    const hit = await client.call('rg_search', { query: 'needleValue' });
    assert.match(hit.content[0].text, /apps_doc\/joy\/a\.js:1: needleValue/);
    assert.match(hit.content[0].text, /Xếp: code của app/);
  } finally { await client.close(); }
  assert.ok(!existsSync(join(jobDir, 'source-api.json')));
});
