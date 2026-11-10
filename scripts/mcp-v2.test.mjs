import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { readMcpSettings, updateMcpSettings, snapshotMcpEngine, settingsAction, nativeSettingsAction } from './mcp-v2-settings.mjs';
import { maybeMcpReview, reviewRequest } from './mcp-v2-review.mjs';
import { createClient, httpTransport, connection, matchApp, McpError } from '../skills/mcp-v2/scripts/client.mjs';
import { prepareMcpContext, evidenceLog } from '../skills/mcp-v2/scripts/engine.mjs';
import { browserSkillSetup } from '../skills/mcp-v2/scripts/browser-skill.mjs';
import { scoreQuote, verifyLink } from '../skills/check-ticket-v2/scripts/verify.mjs';
import { filteredEnv } from '../skills/check-ticket-v2/scripts/codex.mjs';
import { executeReview } from '../skills/check-ticket/scripts/core.mjs';

const ready = async () => ({ available: true, reason: null });
const unavailable = async () => ({ available: false, reason: 'MCP_CONNECTION_MISSING' });
const unavailableCapabilities = {
  remoteMcp: { available: false },
  browser: { available: false, reason: 'BSK_OFFICIAL_ADAPTER_NOT_INSTALLED', verifiedAt: null, isolatedProfileVerified: false },
  cssPreview: { available: false, reason: 'BROWSER_NOT_VERIFIED' },
};
const root = () => mkdtemp(resolve(tmpdir(), 'mcp-v2-test-'));
const definitions = [
  { name: 'ts_list_apps', inputSchema: { type: 'object', properties: {} } },
  { name: 'ts_app_playbook', inputSchema: { type: 'object', properties: { app: { type: 'string' } }, required: ['app'] } },
  { name: 'ts_read_document', inputSchema: { type: 'object', properties: { app: { type: 'string' }, path: { type: 'string' } }, required: ['app', 'path'] } },
  { name: 'ts_delete_shop', inputSchema: {} },
];
const config = { transport: 'streamable-http', url: 'https://ts2.avada.net/fixture-not-a-live-endpoint', authHeader: 'Authorization', authPrefix: 'Bearer ', readTools: {
  ts_list_apps: { scope: 'catalog', kind: 'document' },
  ts_app_playbook: { scope: 'app', appArgument: 'app', kind: 'document' },
  ts_read_document: { scope: 'app', appArgument: 'app', kind: 'document' },
} };
const secret = 'fixture-private-key-never-log';
const fixtureConnection = async () => ({ config, key: secret });
function wire(overrides = {}) {
  const calls = [];
  return { calls, initialize: async () => {}, async rpc(method, args) {
    calls.push({ method, args });
    if (overrides.rpc) return overrides.rpc(method, args);
    if (method === 'tools/list') return { tools: definitions };
    if (args.name === 'ts_list_apps') return { structuredContent: { apps: [{ slug: 'new-app', name: 'New App' }, { slug: 'joy', name: 'JOY Loyalty' }] } };
    return { content: [{ type: 'text', text: `Document says use stable class. ${secret}` }] };
  } };
}
test('GET default is OFF, read-only and separates readiness from selection', async () => {
  const path = await root();
  assert.deepEqual(await readMcpSettings({ root: path, readiness: unavailable }), { enabled: false, revision: 0, effectiveEngine: 'current', available: false, reason: 'MCP_CONNECTION_MISSING', capabilities: unavailableCapabilities });
  await assert.rejects(stat(resolve(path, 'runtime')), { code: 'ENOENT' });
  let probes = 0;
  assert.equal((await snapshotMcpEngine({ root: path, readiness: async () => { probes++; return ready(); } })).enabled, false);
  assert.equal(probes, 0);
});
test('capability contract separates remote readiness from browser support for GET, PUT and native readback', async () => {
  const path = await root();
  const proposed = { enabled: false, effectiveEngine: 'current', revision: 0, available: true, reason: null, capabilities: { ...unavailableCapabilities, remoteMcp: { available: true } } };
  const options = { root: path, readiness: ready };
  assert.deepEqual(await readMcpSettings(options), proposed);
  await assert.rejects(stat(resolve(path, 'runtime')), { code: 'ENOENT' });
  const changed = await settingsAction('PUT', { enabled: true, expectedRevision: 0 }, options);
  assert.equal(changed.status, 200);
  assert.deepEqual(changed.body.capabilities, proposed.capabilities);
  assert.equal(changed.body.effectiveEngine, 'mcp-v2');
  const native = await nativeSettingsAction({ action: 'mcp-v2-settings-get' }, options);
  assert.deepEqual(native.capabilities, proposed.capabilities);
  assert.equal(native.enabled, true); assert.equal(native.revision, 1);
  const stale = await settingsAction('PUT', { enabled: false, expectedRevision: 0 }, options);
  assert.equal(stale.status, 409); assert.deepEqual(stale.body.current.capabilities, proposed.capabilities);
  const lost = { root: path, readiness: unavailable };
  const state = await readMcpSettings(lost);
  assert.equal(state.enabled, true); assert.equal(state.effectiveEngine, 'mcp-v2');
  assert.deepEqual(state.capabilities, unavailableCapabilities);
  const rejected = await settingsAction('PUT', { enabled: true, expectedRevision: 1 }, lost);
  assert.equal(rejected.status, 503); assert.deepEqual(rejected.body.current.capabilities, unavailableCapabilities);
  assert.equal((await readMcpSettings(lost)).revision, 1);
});
test('readiness metadata or caller mutation cannot enable browser/CSS capability', async () => {
  const path = await root();
  const forged = async () => ({ available: true, capabilities: { browser: { available: true }, cssPreview: { available: true } } });
  const first = await readMcpSettings({ root: path, readiness: forged });
  assert.equal(first.capabilities.browser.available, false);
  assert.equal(first.capabilities.cssPreview.available, false);
  first.capabilities.browser.available = true;
  assert.equal((await readMcpSettings({ root: path, readiness: forged })).capabilities.browser.available, false);
  const malformed = { root: path, readiness: async () => ({ available: 'true' }) };
  assert.equal((await readMcpSettings(malformed)).capabilities.remoteMcp.available, false);
  const result = await settingsAction('PUT', { enabled: true, expectedRevision: 0 }, malformed);
  assert.equal(result.status, 503); await assert.rejects(stat(resolve(path, 'runtime/mcp-v2/settings.json')), { code: 'ENOENT' });
});
test('shared persistence, concurrent revision CAS and running snapshot', async () => {
  const path = await root(); const options = { root: path, readiness: ready };
  const writes = await Promise.allSettled([updateMcpSettings({ enabled: true, expectedRevision: 0 }, options), updateMcpSettings({ enabled: true, expectedRevision: 0 }, options)]);
  assert.equal(writes.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal(writes.find(item => item.status === 'rejected').reason.status, 409);
  const snapshot = await snapshotMcpEngine(options);
  await updateMcpSettings({ enabled: false, expectedRevision: 1 }, options);
  assert.equal(snapshot.enabled, true); assert.equal(snapshot.revision, 1); assert.equal(Object.isFrozen(snapshot), true);
  assert.equal((await readMcpSettings(options)).revision, 2);
  assert.equal((await stat(resolve(path, 'runtime/mcp-v2/settings.json'))).mode & 0o777, 0o600);
});
test('ON unavailable does not write; selected ON loss does not become fallback', async () => {
  const path = await root(); const options = { root: path, readiness: unavailable };
  const rejected = await settingsAction('PUT', { enabled: true, expectedRevision: 0 }, options);
  assert.equal(rejected.status, 503); assert.equal(rejected.body.current.enabled, false);
  await assert.rejects(readFile(resolve(path, 'runtime/mcp-v2/settings.json')), { code: 'ENOENT' });
  await updateMcpSettings({ enabled: true, expectedRevision: 0 }, { ...options, readiness: ready });
  const blocked = await readMcpSettings(options);
  assert.equal(blocked.enabled, true); assert.equal(blocked.effectiveEngine, 'mcp-v2'); assert.equal(blocked.available, false);
  await assert.rejects(snapshotMcpEngine(options), { status: 503 });
  assert.equal((await updateMcpSettings({ enabled: false, expectedRevision: 1 }, options)).enabled, false);
});
test('bad inputs and corrupt store fail without resetting or widening config', async () => {
  const path = await root(); const options = { root: path, readiness: ready };
  for (const value of [{ enabled: 'true', expectedRevision: 0 }, { enabled: true }, { enabled: true, expectedRevision: -1 }, { enabled: true, expectedRevision: 0, url: 'https://evil.test' }]) assert.equal((await settingsAction('PUT', value, options)).status, 400);
  await mkdir(resolve(path, 'runtime/mcp-v2'), { recursive: true });
  await writeFile(resolve(path, 'runtime/mcp-v2/settings.json'), '{broken');
  assert.equal((await settingsAction('GET', null, options)).status, 500);
  assert.equal(await readFile(resolve(path, 'runtime/mcp-v2/settings.json'), 'utf8'), '{broken');
});
test('ordinary questions, mail, selected ticket and old history never select MCP', async () => {
  for (const message of ['Hi', 'Ticket này sao rồi?', 'viết mail', 'check ticket AIR-261027-Abc']) {
    let touched = false;
    const result = await maybeMcpReview({ message, ticket: { ticketId: 'AIR-261027-Abc' }, history: [{ intent: 'ticket-review' }] }, { snapshot: async () => { touched = true; } });
    assert.equal(result, null); assert.equal(touched, false);
  }
});
test('explicit review validates ticket, OFF preserves route, ON passes locked snapshot and explicit follow-up', async () => {
  assert.throws(() => reviewRequest({ intent: 'ticket-review', ticket: { id: 'internal' } }), { status: 400 });
  assert.throws(() => reviewRequest({ intent: 'ticket-review', ticket: { ticketId: '../secret' } }), { status: 400 });
  const body = { intent: 'ticket-review', ticket: { ticketId: 'AIR-261027-Abc', appName: 'untrusted' }, message: 'check tiếp', reviewFollowUp: true };
  assert.equal(await maybeMcpReview(body, { snapshot: async () => ({ enabled: false }), run: () => assert.fail('OFF ran engine') }), null);
  const snapshot = Object.freeze({ enabled: true, revision: 4 });
  const answer = await maybeMcpReview(body, { snapshot: async () => snapshot, run: async (request, engine) => { assert.equal(engine, snapshot); assert.deepEqual(request, { reference: 'AIR-261027-Abc', followUp: { instruction: 'check tiếp' } }); return { answer: 'verified' }; } });
  assert.equal(answer.answer, 'verified');
  assert.equal(reviewRequest({ ...body, reviewFollowUp: false }).followUp, null);
});
test('MCP allowlist, app lock and output redaction are enforced before evidence', async () => {
  const transport = wire(); const client = await createClient('', { transport, loadConnection: fixtureConnection });
  assert.equal(client.tools.some(tool => tool.name === 'ts_delete_shop'), false);
  await assert.rejects(client.call('ts_delete_shop', {}, 'joy'), { code: 'MCP_TOOL_FORBIDDEN' });
  await assert.rejects(client.call('ts_read_document', { app: 'new-app', path: 'x' }, 'joy'), { code: 'MCP_APP_MISMATCH' });
  await assert.rejects(client.call('ts_read_document', { path: 'x', shell: 'secret' }, 'joy'), { code: 'MCP_ARGUMENTS_INVALID' });
  const result = await client.call('ts_read_document', { path: 'x' }, 'joy');
  assert.equal(result.output.includes(secret), false); assert.equal(result.output.includes('[redacted]'), true);
  assert.equal(transport.calls.at(-1).args.arguments.app, 'joy');
});
test('MCP schema pagination and failure are explicit', async () => {
  let page = 0;
  const client = await createClient(await root(), { loadConnection: fixtureConnection, transport: wire({ rpc: async () => ++page === 1 ? { tools: definitions.slice(0, 1), nextCursor: 'next' } : { tools: definitions.slice(1) } }) });
  assert.equal(client.tools.length, 3);
  await assert.rejects(createClient('', { loadConnection: fixtureConnection, transport: wire({ rpc: async () => ({ tools: [], nextCursor: 'same' }) }) }), { code: 'MCP_TOOL_LIST_INCOMPLETE' });
  await assert.rejects(createClient('', { loadConnection: fixtureConnection, transport: wire({ rpc: async () => ({ tools: [] }) }) }), { code: 'MCP_REQUIRED_TOOL_MISSING' });
});
test('HTTP transport initialization/auth, redirects, unauthorized and remote errors do not leak key', async () => {
  const seen = [];
  const transport = httpTransport({ config, key: secret, fetchImpl: async (url, options) => {
    const body = JSON.parse(options.body); seen.push({ url, options, body });
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-03-26' } }), { headers: { 'content-type': 'application/json', 'mcp-session-id': 'session-1' } });
  } });
  await transport.initialize(); await transport.rpc('tools/list');
  assert.equal(seen[0].options.headers.Authorization, 'Bearer ' + secret);
  assert.equal(seen[0].options.redirect, 'error'); assert.equal(seen.at(-1).options.headers['Mcp-Session-Id'], 'session-1');
  const denied = httpTransport({ config, key: secret, fetchImpl: async () => new Response(secret, { status: 401 }) });
  await assert.rejects(denied.initialize(), error => error.code === 'MCP_HTTP_401' && !error.message.includes(secret));
  const failed = httpTransport({ config, key: secret, fetchImpl: async () => { throw new Error(secret); } });
  await assert.rejects(failed.initialize(), { code: 'MCP_TRANSPORT_FAILED' });
});
test('connection is absent by default and disallows secret-bearing URLs and unsafe tool policy', async () => {
  const path = await root();
  await assert.rejects(connection(path), { code: 'MCP_CONNECTION_MISSING' });
  await mkdir(resolve(path, 'skills/mcp-v2'), { recursive: true });
  await writeFile(resolve(path, '.env_my'), `Andrew_TS2_Keys=${secret}\n`);
  for (const bad of [{ ...config, url: 'https://evil.test/mcp' }, { ...config, url: config.url + '?key=secret' }, { ...config, readTools: { ...config.readTools, ts_update_shop: { scope: 'catalog', kind: 'document' } } }]) {
    await writeFile(resolve(path, 'skills/mcp-v2/connection.json'), JSON.stringify(bad));
    await assert.rejects(connection(path), McpError);
  }
  await writeFile(resolve(path, 'skills/mcp-v2/connection.json'), JSON.stringify(config));
  assert.equal((await connection(path)).key, secret);
});
test('new apps resolve dynamically; unavailable or ambiguous app never defaults to Joy', () => {
  const apps = [{ slug: 'new-product', name: 'Future Product' }, { slug: 'joy', name: 'Joy Loyalty' }];
  assert.equal(matchApp({ apps }, ['Future Product']), 'new-product');
  assert.throws(() => matchApp(apps, ['Unknown']), { code: 'MCP_APP_UNSUPPORTED' });
  assert.throws(() => matchApp([...apps, { slug: 'duplicate', name: 'Future Product' }], ['Future Product']), { code: 'MCP_APP_AMBIGUOUS' });
});
test('prepare obtains catalog then app playbook and saves redacted evidence from actual calls', async () => {
  const path = await root(); const transport = wire();
  const prep = { ticket: { appName: 'New App' }, app: { slug: null } };
  const context = await prepareMcpContext(path, prep, path, { clientFactory: () => createClient('', { transport, loadConnection: fixtureConnection }) });
  assert.equal(context.app, 'new-app');
  const calls = transport.calls.filter(item => item.method === 'tools/call');
  assert.deepEqual(calls.map(item => item.args.name), ['ts_list_apps', 'ts_app_playbook']);
  assert.equal(calls[1].args.arguments.app, 'new-app');
  const evidence = await readFile(resolve(path, 'tool-log.jsonl'), 'utf8');
  assert.equal(evidence.includes(secret), false);
  assert.equal(evidence.trim().split('\n').length, 2);
});
test('MCP verification binds quote to exact successful ref and evidence type', () => {
  const result = { ref: 'mcp-v2:joy/one', kind: 'document', app: 'joy', tool: 'ts_app_playbook', output: 'Only show reviews when enabled.', at: 'now', args: {} };
  const finding = { quote: 'Only show reviews when enabled.', source: { type: 'tool', ref: result.ref } };
  assert.equal(scoreQuote(finding, { toolLog: [evidenceLog(result)] }).score, 0.9);
  assert.equal(scoreQuote({ ...finding, source: { ref: 'mcp-v2:joy/other' } }, { toolLog: [evidenceLog(result)] }).score, 0);
  assert.equal(scoreQuote(finding, { toolLog: [{ ...evidenceLog(result), ok: false }] }).score, 0);
  assert.equal(scoreQuote({ ...finding, source: { type: 'tool', ref: 'mcp_v2_read' } }, { toolLog: [evidenceLog(result)] }).score, 0);
  const other = { ...result, ref: 'mcp-v2:joy/two', output: 'Unrelated effect exists.' };
  assert.equal(verifyLink({ ...finding, link: { cause_quote: finding.quote, effect_quote: other.output } }, { toolLog: [evidenceLog(result), evidenceLog(other)] }).verified, false);
});
test('MCP key environment is not passed into model process', () => {
  process.env.Andrew_TS2_Keys = secret;
  try { assert.equal(filteredEnv().Andrew_TS2_Keys, undefined); } finally { delete process.env.Andrew_TS2_Keys; }
});
test('BrowserSkill inspection does not start browser/daemon when CLI absent', async () => {
  const home = await root(); let runs = 0;
  const status = await browserSkillSetup({ root: home, env: { PATH: '' }, home, run: async () => { runs++; } });
  assert.equal(status.reason, 'BSK_CLI_MISSING'); assert.equal(status.localBrowserEnabled, false); assert.equal(status.connected, null); assert.equal(runs, 0);
});
test('actual web GET/PUT and native actions share one store and conflicts (isolated server, no schedulers)', async () => {
  const path = await root(); const options = { root: path, readiness: ready };
  const { createTsManagementWeb } = await import('./ts-management-web.mjs');
  const app = createTsManagementWeb({ mcpSettingsOptions: options, log: () => {} });
  // Direct listen avoids production start(): no scheduler, database purge, mDNS,
  // notifier or browser starts during this test.
  await new Promise(done => app.server.listen(0, '127.0.0.1', done));
  const url = `http://127.0.0.1:${app.server.address().port}/api/mcp-v2/settings`;
  const { loadEnv } = await import('./hachimi-db.mjs');
  const pin = process.env.TS_WEB_PIN || loadEnv().TS_WEB_PIN || '';
  const headers = { 'Content-Type': 'application/json', ...(pin ? { 'X-TS-Web-Key': pin } : {}) };
  try {
    const get = await fetch(url, { headers }); assert.equal(get.status, 200); const initial = await get.json(); assert.equal(initial.enabled, false);
    assert.deepEqual(initial.capabilities, { ...unavailableCapabilities, remoteMcp: { available: true } });
    const put = await fetch(url, { method: 'PUT', headers, body: JSON.stringify({ enabled: true, expectedRevision: 0 }) });
    assert.equal(put.status, 200); const enabled = await put.json(); assert.equal(enabled.revision, 1);
    assert.deepEqual(enabled.capabilities, initial.capabilities);
    assert.equal((await nativeSettingsAction({ action: 'mcp-v2-settings-get' }, options)).enabled, true);
    const stale = await nativeSettingsAction({ action: 'mcp-v2-settings-set', enabled: false, expectedRevision: 0 }, options);
    assert.equal(stale.status, 409); assert.equal(stale.current.revision, 1);
    const off = await nativeSettingsAction({ action: 'mcp-v2-settings-set', enabled: false, expectedRevision: 1 }, options);
    assert.equal(off.ok, true);
    const readback = await (await fetch(url, { headers })).json(); assert.equal(readback.enabled, false); assert.equal(readback.revision, 2);
    assert.deepEqual(readback.capabilities, initial.capabilities);
  } finally { app.server.closeAllConnections(); await new Promise(done => app.server.close(done)); }
});
test('automatic and explicit follow-up choose MCP once and retain existing report contract', async () => {
  let selections = 0; let calls = 0;
  const snapshot = Object.freeze({ enabled: true, revision: 8 });
  const followUp = { instruction: 'check tiếp', commentId: 'c1' };
  const io = {
    selectEngine: async () => { selections++; return snapshot; },
    hancal: async (target, context, follow) => { calls++; assert.equal(context.engineSnapshot, snapshot); assert.equal(follow, followUp); return { status: 'ok', ticketId: 'internal', category: 'Question', writer: { body: 'Cần xác minh cấu hình shop.' }, counts: {}, verified: { findings: [] } }; },
    elite: () => assert.fail('ON called legacy engine'),
  };
  const review = await executeReview('AIR-261027-Abc', io, { analysis: 'elite', hancalTimeoutMs: 1000 }, { followUp });
  assert.equal(selections, 1); assert.equal(calls, 1); assert.equal(review.engine, 'mcp-v2'); assert.equal(review.engineRevision, 8);
  assert.match(review.comment, /^Sau khi TS check/);
});
test('failed MCP snapshot stops automatic review before any engine, with no fallback', async () => {
  await assert.rejects(executeReview('AIR-261027-Abc', { selectEngine: async () => { throw new McpError('MCP_HTTP_401'); }, elite: () => assert.fail('fallback'), hancal: () => assert.fail('fallback') }, { analysis: 'elite' }), { code: 'MCP_HTTP_401' });
});
test('argument types and inherited tool names cannot escape explicit MCP policy', async () => {
  const transport = wire({ rpc: async method => method === 'tools/list' ? { tools: [...definitions, { name: 'constructor', inputSchema: { type: 'object', properties: {} } }] } : assert.fail('invalid call left gateway') });
  const client = await createClient('', { transport, loadConnection: fixtureConnection });
  assert.equal(client.tools.some(tool => tool.name === 'constructor'), false);
  await assert.rejects(client.call('ts_read_document', { path: { query: 'unsafe' } }, 'joy'), { code: 'MCP_ARGUMENTS_INVALID' });
});
test('extension ON preflight racing with OFF or a newer revision never falls through to legacy', async () => {
  const request = { intent: 'ticket-review', ticket: { ticketId: 'AIR-261027-Abc' }, message: 'check', expectedEngineRevision: 7 };
  for (const engine of [{ enabled: false, revision: 8 }, { enabled: true, revision: 9 }]) {
    await assert.rejects(maybeMcpReview(request, { snapshot: async () => engine, run: () => assert.fail('stale request ran') }), { status: 409, code: 'MCP_ENGINE_CHANGED' });
  }
  const value = await maybeMcpReview(request, { snapshot: async () => ({ enabled: true, revision: 7 }), run: async () => ({ answer: 'ok' }) });
  assert.equal(value.answer, 'ok');
  assert.throws(() => reviewRequest({ ...request, expectedEngineRevision: '7' }), { status: 400 });
});
test('unknown settings blocks explicit reviews; generic chat never requests readiness', async () => {
  const snapshot = async () => { throw new Error('MCP_SETTINGS_UNREADABLE'); };
  await assert.rejects(maybeMcpReview({ intent: 'ticket-review', ticket: { ticketId: 'AIR-261027-Abc' } }, { snapshot, run: () => assert.fail('unknown state ran') }), /MCP_SETTINGS_UNREADABLE/);
  assert.equal(await maybeMcpReview({ message: 'viết mail', ticket: { ticketId: 'AIR-261027-Abc' } }, { snapshot }), null);
});
test('actual /chat bridge rejects stale/malformed revisions before either engine and freezes admitted revision', async () => {
  const { createCodexTicketBridge } = await import('./codex-ticket-bridge.mjs');
  let state = { enabled: false, revision: 8 }; let mcpCalls = 0; let legacyCalls = 0; let snapshots = 0;
  const server = createCodexTicketBridge({
    reviewHandler: body => maybeMcpReview(body, { snapshot: async () => { snapshots++; return Object.freeze({ ...state }); },
      run: async (request, snapshot) => { mcpCalls++; state = { enabled: false, revision: snapshot.revision + 1 }; return { answer: 'MCP fixture', engine: 'mcp-v2', revision: snapshot.revision }; } }),
    legacyRun: async () => { legacyCalls++; return 'legacy fixture'; },
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const endpoint = `http://127.0.0.1:${server.address().port}/chat`;
  const headers = { 'Content-Type': 'application/json', Origin: 'chrome-extension://fixture', 'X-TS-Management-Codex-Bridge': '1' };
  const request = { chatId: 'fixture', message: 'Check ticket AIR-261027-Abc', ticket: { ticketId: 'AIR-261027-Abc' }, intent: 'ticket-review', expectedEngineRevision: 7 };
  const post = async body => { const result = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(body) }); return { status: result.status, body: await result.json() }; };
  try {
    for (const next of [{ enabled: false, revision: 8 }, { enabled: true, revision: 9 }]) {
      state = next; const result = await post(request);
      assert.equal(result.status, 409); assert.equal(result.body.error, 'MCP_ENGINE_CHANGED');
      assert.equal(mcpCalls, 0); assert.equal(legacyCalls, 0);
    }
    const before = snapshots;
    const malformed = await post({ ...request, expectedEngineRevision: '7' });
    assert.equal(malformed.status, 400); assert.equal(snapshots, before); assert.equal(mcpCalls + legacyCalls, 0);
    state = { enabled: true, revision: 7 };
    const valid = await post(request);
    assert.equal(valid.status, 200); assert.equal(valid.body.revision, 7); assert.equal(state.revision, 8); assert.equal(mcpCalls, 1); assert.equal(legacyCalls, 0);
    const off = { ...request }; delete off.expectedEngineRevision;
    assert.equal((await post(off)).body.answer, 'legacy fixture'); assert.equal(legacyCalls, 1);
    state = { enabled: true, revision: 9 };
    const beforeChat = snapshots;
    assert.equal((await post({ chatId: 'ordinary', message: 'viết mail', ticket: request.ticket })).body.answer, 'legacy fixture');
    assert.equal(legacyCalls, 2); assert.equal(snapshots, beforeChat);
  } finally { server.closeAllConnections(); await new Promise(done => server.close(done)); }
});
