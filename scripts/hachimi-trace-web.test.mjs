#!/usr/bin/env node
// Tests for the tracing web: payload validation (no DB) + HTTP/DB integration when the Hachimi database is reachable.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeIngest, recordTrace, purgeExpired, getSession, deleteSession, listSessions, lookupSession } from './hachimi-trace-store.mjs';
import { createTraceWeb } from './hachimi-trace-web.mjs';
import { query, closePool } from './hachimi-db.mjs';
import { undeliveredTrace } from './hachimi-trace-sync.mjs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve as resolvePath } from 'node:path';

test('normalizeIngest validates and normalizes payloads', () => {
  const trace = normalizeIngest({ source: 'Manual', id: 'abc-1', ticketReference: 'JOY-1', events: [{ kind: 'THINKING', text: 'x', phase: 'elite' }, { kind: 'done', at: 'bad-date' }] });
  assert.equal(trace.source, 'manual');
  assert.equal(trace.events[0].kind, 'thinking');
  assert.equal(trace.events[0].phase, 'elite');
  assert.ok(Number.isFinite(Date.parse(trace.events[1].at)));
  assert.equal(trace.terminal, true);
  assert.equal(normalizeIngest({ source: 'widget', id: 'w1', event: { kind: 'text', text: 'one' } }).events.length, 1);
  assert.throws(() => normalizeIngest({ source: 'bad source', id: 'x' }), /Invalid source/);
  assert.throws(() => normalizeIngest({ source: 'manual', id: '../x' }), /Invalid id/);
  assert.throws(() => normalizeIngest({ source: 'manual', id: 'x', events: [{ kind: 'nope' }] }), /Unknown event kind/);
  assert.throws(() => normalizeIngest({ source: 'manual', id: 'x', events: [{ kind: 'text', text: 5 }] }), /text must be a string/);
});

test('warning is a timeline kind that does not end the session', () => {
  const trace = normalizeIngest({ source: 'automatic', id: 'job-1', events: [{ kind: 'warning', text: 'Lần thử 1/3 dừng ở pha elite', payload: { attempt: 1 } }] });
  assert.equal(trace.events[0].kind, 'warning');
  assert.equal(trace.terminal, null);
  assert.equal(normalizeIngest({ source: 'automatic', id: 'job-1', events: [{ kind: 'warning' }, { kind: 'error' }] }).terminal, true);
});

test('undelivered trace lines are read from the job log, complete lines only', async t => {
  const dir = await mkdtemp(resolvePath(tmpdir(), 'trace-log-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const file = resolvePath(dir, 'trace.jsonl');
  assert.deepEqual(await undeliveredTrace(file), []);
  await writeFile(file, [
    JSON.stringify({ kind: 'start', text: 'sent', delivered: true }),
    JSON.stringify({ kind: 'warning', text: 'kept', runId: 'r1', delivered: false }),
    'not json',
    JSON.stringify({ kind: 'note', text: 'half written', delivered: false }).slice(0, 20),
  ].join('\n'));
  assert.deepEqual((await undeliveredTrace(file)).map(event => event.text), ['kept']);
});

let dbAvailable = true;
try { await query('SELECT 1'); } catch { dbAvailable = false; }

test('record, append, expire and purge a trace session', { skip: !dbAvailable && 'Hachimi database not reachable' }, async () => {
  const id = `test-${Date.now()}`;
  const first = await recordTrace({ source: 'manual', id, ticketReference: 'JOY-TEST', events: [{ kind: 'start', text: 'a' }, { kind: 'thinking', text: 'b' }] });
  const second = await recordTrace({ source: 'manual', id, events: [{ kind: 'done', text: 'c' }] });
  assert.equal(first.sessionId, second.sessionId);
  assert.deepEqual(second.events.map(e => e.seq), [2]);
  const detail = await getSession(first.sessionId);
  assert.equal(detail.session.terminal, true);
  assert.equal(detail.events.length, 3);
  assert.ok(Date.parse(detail.session.expires_at) > Date.now() + 9 * 86400e3);
  await query("UPDATE trace_sessions SET expires_at = now() - interval '1 second' WHERE id = $1", [first.sessionId]);
  const purge = await purgeExpired({ trigger: 'test' });
  assert.ok(purge.deletedSessions >= 1);
  assert.equal(await getSession(first.sessionId), null);
});

test('HTTP ingest, list, stream and delete', { skip: !dbAvailable && 'Hachimi database not reachable' }, async () => {
  const app = createTraceWeb({ sync: false, purge: false, log: () => {} });
  const { port } = await app.listen(0);
  const base = `http://127.0.0.1:${port}`;
  try {
    const id = `http-${Date.now()}`;
    const stream = await fetch(`${base}/api/stream`);
    const reader = stream.body.getReader();
    await reader.read(); // hello
    const created = await fetch(`${base}/api/trace/events`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source: 'manual', id, subject: 'HTTP test', events: [{ kind: 'thinking', text: 'via http' }] }) });
    assert.equal(created.status, 201);
    const body = await created.json();
    assert.equal(typeof body.sessionId, 'number');
    const { value } = await reader.read();
    assert.match(Buffer.from(value).toString(), /"type":"events"/);
    reader.cancel();
    const bad = await fetch(`${base}/api/trace/events`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"source":"manual","id":"x","events":[{"kind":"nope"}]}' });
    assert.equal(bad.status, 400);
    const list = await (await fetch(`${base}/api/sessions?q=${id}`)).json();
    assert.equal(list.total, 1);
    assert.equal(list.sessions[0].event_count, 1);
    const events = await (await fetch(`${base}/api/sessions/${body.sessionId}/events?after=-1`)).json();
    assert.equal(events.length, 1);
    assert.equal((await fetch(`${base}/../etc/passwd`)).status, 404);
    assert.equal((await fetch(`${base}/`)).headers.get('content-type'), 'text/html; charset=utf-8');
    const removed = await (await fetch(`${base}/api/sessions/${body.sessionId}`, { method: 'DELETE' })).json();
    assert.equal(removed.deleted, 1);
  } finally { await app.close(); }
});

test('chatId filter groups widget turns and lookup resolves source:id', { skip: !dbAvailable && 'Hachimi database not reachable' }, async () => {
  const chatId = `chat-${Date.now()}`;
  const a = await recordTrace({ source: 'widget', id: `${chatId}-turn1`, metadata: { chatId }, events: [{ kind: 'start', text: 'turn 1' }] });
  const b = await recordTrace({ source: 'widget', id: `${chatId}-turn2`, metadata: { chatId }, events: [{ kind: 'start', text: 'turn 2' }] });
  try {
    const { sessions, total } = await listSessions({ chatId });
    assert.equal(total, 2);
    assert.deepEqual(sessions.map(s => s.id).sort(), [a.sessionId, b.sessionId].sort());
    assert.equal(await lookupSession('widget', `${chatId}-turn2`), b.sessionId);
    const c = await recordTrace({ source: 'manual', id: `${chatId}-manual`, ticketReference: `T-${chatId}`, events: [{ kind: 'start', text: 'manual' }] });
    try { assert.equal((await listSessions({ ticket: `T-${chatId}` })).total, 1); assert.equal((await listSessions({ ticket: 'T-none' })).total, 0); }
    finally { await deleteSession(c.sessionId); }
    assert.equal(await lookupSession('widget', 'missing'), null);
  } finally { await deleteSession(a.sessionId); await deleteSession(b.sessionId); }
});

test.after(async () => { await closePool(); });

/* ---------- data sources ---------- */
import { normalizeSource, normalizeSources, parseSourcesSection, eventsFromCodexJsonl, sourcesFromPathsInText, readSourceFile, isAllowedPath } from './hachimi-trace-sources.mjs';
import { getSource, getSessionSources } from './hachimi-trace-store.mjs';
import { insertEvents } from './hachimi-trace-sync.mjs';
import { withTransaction } from './hachimi-db.mjs';

test('normalizeSource validates types, paths and urls', () => {
  assert.deepEqual(normalizeSource('skills/check-ticket/SKILL.md'), { type: 'skill', label: 'SKILL.md', path: 'skills/check-ticket/SKILL.md', url: null, locator: null, excerpt: null, metadata: null });
  assert.equal(normalizeSource({ path: './knowledge-base/knowledge/joy/x.md' }).type, 'docs');
  assert.equal(normalizeSource({ url: 'https://ts2.avada.net/chat?app=joy' }).type, 'elite');
  assert.equal(normalizeSource({ url: 'https://helpdesk.avada.net/tickets/JOY-1' }).type, 'ticket');
  assert.equal(normalizeSource({ type: 'elite', label: 'Prior chat evidence' }).label, 'Prior chat evidence');
  assert.throws(() => normalizeSource({ path: '../etc/passwd' }), /Invalid source path/);
  assert.throws(() => normalizeSource({ path: '/etc/passwd' }), /Invalid source path/);
  assert.throws(() => normalizeSource({ url: 'javascript:alert(1)' }), /Invalid source url/);
  assert.throws(() => normalizeSource({ type: 'magic', label: 'x' }), /Unknown source type/);
  assert.throws(() => normalizeSource({ type: 'docs' }), /needs a label/);
  assert.equal(normalizeSources([{ path: 'skills/a.md' }, { path: 'skills/a.md' }]).length, 1);
  assert.throws(() => normalizeSources('nope'), /must be an array/);
  assert.ok(isAllowedPath('knowledge-base/knowledge/joy/x.md'));
  assert.ok(!isAllowedPath('scripts/hachimi-db.mjs'));
  assert.ok(!isAllowedPath('knowledge-base/.env_secret'));
  assert.ok(!isAllowedPath('runtime/check-ticket/state.json'));
});

test('parseSourcesSection extracts TS Elite 2 citations', () => {
  const answer = `Kết luận…\n\n---\n\nSources\n\n- ✓ Ticket JOY-260918-gdwvRt (prefetched) — 3 requests\n- ✓ [\`RedeemSection.js:52\`](https://ts2.avada.net/chat?app=joy&path=extensions%2Fx.js&line=52) — chunk hardcoded\n- ✗ ibb.co screenshot — 404\n- ◦ knowledge/joy/faq.md — đọc thêm\n- https://example.com/page\n\n---\n⚠️ **Citation audit (harness):** ignored\n- https://should-not-appear.example\n`;
  const sources = parseSourcesSection(answer);
  assert.deepEqual(sources.map(s => s.type), ['ticket', 'elite', 'elite', 'docs', 'url']);
  assert.equal(sources[0].url, 'https://helpdesk.avada.net/tickets/JOY-260918-gdwvRt');
  assert.equal(sources[0].metadata.status, 'used');
  assert.equal(sources[1].label, 'RedeemSection.js:52');
  assert.equal(sources[2].metadata.status, 'unavailable');
  assert.equal(sources[3].label, 'knowledge/joy/faq.md');
  assert.equal(parseSourcesSection('no sources here').length, 0);
});

test('eventsFromCodexJsonl maps commands and MCP calls to tool events with repo sources', () => {
  const jsonl = [
    JSON.stringify({ type: 'thread.started', thread_id: 't1' }),
    JSON.stringify({ type: 'item.completed', item: { type: 'reasoning', text: 'secret thoughts' } }),
    JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', command: 'cat skills/check-ticket/SKILL.md knowledge-base/README.md scripts/hachimi-db.mjs', exit_code: 0, status: 'completed' } }),
    JSON.stringify({ type: 'item.completed', item: { type: 'mcp_tool_call', server: 'playwright', tool: 'browser_navigate', arguments: { url: 'https://shop.example.com/pages/x', token: 'abc' }, status: 'completed' } }),
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'final' } }),
    'not json',
  ].join('\n');
  const events = eventsFromCodexJsonl(jsonl, { phase: 'customize' });
  assert.equal(events.length, 2);
  assert.equal(events[0].kind, 'tool');
  assert.match(events[0].text, /^\$ cat skills/);
  assert.deepEqual(events[0].sources.map(s => s.path), ['skills/check-ticket/SKILL.md', 'knowledge-base/README.md']);
  assert.equal(events[1].sources[0].url, 'https://shop.example.com/pages/x');
  assert.equal(events[1].payload.arguments.token, 'abc'); // strings are kept; secrets never reach worker env in the first place
  assert.ok(!JSON.stringify(events).includes('secret thoughts'));
  assert.deepEqual(sourcesFromPathsInText('rg -n "x" ./knowledge-base/knowledge/joy/ knowledge-base/missing.md'), []);
});

test('readSourceFile only serves allowed repo files', async () => {
  const skill = await readSourceFile('skills/check-ticket/SKILL.md');
  assert.equal(skill.format, 'markdown');
  assert.ok(skill.content.length > 100);
  await assert.rejects(readSourceFile('.env_my'), /not readable/);
  await assert.rejects(readSourceFile('../../etc/passwd'), /not readable/);
  await assert.rejects(readSourceFile('scripts/hachimi-db.mjs'), /not readable/);
  await assert.rejects(readSourceFile('skills/check-ticket'), /not a file|not readable|not found/);
  await assert.rejects(readSourceFile('knowledge-base/does-not-exist.md'), /not found/);
});

test('sources are stored per event, listed, served, and file sync keeps a per-channel cursor', { skip: !dbAvailable && 'Hachimi database not reachable' }, async () => {
  const app = createTraceWeb({ sync: false, purge: false, log: () => {} });
  const { port } = await app.listen(0);
  const base = `http://127.0.0.1:${port}`;
  const id = `src-${Date.now()}`;
  let sessionId;
  try {
    const created = await recordTrace({ source: 'widget', id, events: [
      { kind: 'tool', text: 'retrieval', phase: 'retrieval', sources: [{ type: 'docs', path: 'knowledge-base/README.md', excerpt: 'knowledge' }, { url: 'https://ts2.avada.net/chat?app=joy', label: 'Elite link' }] },
      { kind: 'text', text: 'answer' },
    ], sources: [{ type: 'skill', path: 'skills/check-ticket/SKILL.md' }] });
    sessionId = created.sessionId;
    assert.equal(created.events[0].sources.length, 2);
    assert.equal(created.sources.length, 1);
    const again = await recordTrace({ source: 'widget', id, events: [{ kind: 'tool', text: 'dup', sources: [{ type: 'docs', path: 'knowledge-base/README.md' }] }] });
    assert.equal(again.events[0].sources.length, 1); // different event → stored again; same event would dedupe
    const detail = await getSession(sessionId);
    assert.equal(detail.sources.length, 4);
    assert.equal(detail.events[0].sources.length, 2);
    assert.equal(detail.events[1].sources.length, 0);
    assert.equal((await getSessionSources(sessionId)).length, 4);
    const docSource = detail.events[0].sources.find(s => s.type === 'docs');
    const one = await getSource(docSource.id);
    assert.equal(one.session.id, sessionId);
    assert.equal(one.event.seq, 0);
    const served = await (await fetch(`${base}/api/sources/${docSource.id}`)).json();
    assert.equal(served.content.kind, 'file');
    assert.equal(served.content.format, 'markdown');
    assert.ok(served.content.content.length > 0);
    const linkSource = detail.events[0].sources.find(s => s.type === 'elite');
    assert.equal((await (await fetch(`${base}/api/sources/${linkSource.id}`)).json()).content.kind, 'link');
    assert.equal((await fetch(`${base}/source/${docSource.id}`)).headers.get('content-type'), 'text/html; charset=utf-8');
    assert.equal((await fetch(`${base}/api/sources/999999999`)).status, 404);
    const list = await (await fetch(`${base}/api/sessions?q=${id}`)).json();
    assert.equal(list.sessions[0].source_count, 4);
    // File sync after live events: cursor starts at 0 (no actor-less rows), new file events append after seq 2.
    const fileEvents = [{ kind: 'start', text: 'w0', at: new Date().toISOString() }, { kind: 'phase', text: 'w1', at: new Date().toISOString() }];
    const first = await withTransaction(client => insertEvents(client, sessionId, fileEvents, 'widget'));
    assert.equal(first, 2);
    const second = await withTransaction(client => insertEvents(client, sessionId, [...fileEvents, { kind: 'done', text: 'w2' }], 'widget'));
    assert.equal(second, 1);
    const after = await getSession(sessionId);
    assert.deepEqual(after.events.map(e => e.seq), [0, 1, 2, 3, 4, 5]);
    assert.deepEqual(after.events.slice(3).map(e => e.text), ['w0', 'w1', 'w2']);
    assert.equal(after.session.metadata.synced.widget, 3);
  } finally { if (sessionId) await deleteSession(sessionId); await app.close(); }
});

test('tracing web serves its logo generated from Asset/', async () => {
  const app = createTraceWeb({ sync: false, purge: false, log: () => {} });
  const { port } = await app.listen(0);
  try {
    for (const name of ['logo-32.png', 'logo-128.png', 'logo-256.png']) {
      const icon = await fetch(`http://127.0.0.1:${port}/${name}`);
      assert.equal(icon.status, 200);
      assert.equal(icon.headers.get('content-type'), 'image/png');
    }
    assert.equal((await fetch(`http://127.0.0.1:${port}/icons/bigmouse2-rounded-128.png`)).status, 404);
    for (const page of ['/', '/source/1']) assert.match(await (await fetch(`http://127.0.0.1:${port}${page}`)).text(), /src="\/logo-128\.png"/);
  } finally { await app.close(); }
});

/* ---------- local friendly domain ---------- */
import { isAllowedHost, publicTraceUrl, friendlyTraceUrl, isLoopbackAddress, traceUrlForClient, traceLanAddresses, traceWebPort } from './hachimi-trace-domain.mjs';
import { request as httpRequest } from 'node:http';

test('friendly *.localhost address; host allowlist accepts loopback names and the optional custom domain only', async () => {
  assert.equal(friendlyTraceUrl(5077), 'http://andrewtstracing.localhost:5077');
  assert.ok(!isAllowedHost('andrewtstracing.com', ''));
  assert.ok(isAllowedHost('andrewtstracing.localhost:5077', ''));
  for (const host of ['127.0.0.1:5077', '127.0.0.77', 'localhost:5077', '[::1]:5077', 'andrewtstracing.localhost:5077', 'andrewtstracing.com', 'www.andrewtstracing.com', 'ANDREWTSTRACING.COM:80']) assert.ok(isAllowedHost(host, 'andrewtstracing.com'), host);
  for (const host of ['', 'evil.example', 'andrewtstracing.com.evil.example', 'notandrewtstracing.com', '192.168.1.5:5077', '127.0.0.1.evil.example']) assert.ok(!isAllowedHost(host, 'andrewtstracing.com'), host);
  // A name that does not resolve to loopback is never probed and falls back to the loopback URL.
  assert.equal(await publicTraceUrl({ domain: 'example.com', timeoutMs: 500 }), friendlyTraceUrl());
  const app = createTraceWeb({ sync: false, purge: false, log: () => {} });
  const { port } = await app.listen(0);
  const get = host => new Promise((done, fail) => {
    const req = httpRequest({ host: '127.0.0.1', port, path: '/api/health', headers: { Host: host } }, res => { let body = ''; res.on('data', c => { body += c; }); res.on('end', () => done({ status: res.statusCode, body })); });
    req.on('error', fail); req.end();
  });
  try {
    const ok = await get('andrewtstracing.localhost:5077');
    assert.equal(ok.status, 200);
    assert.equal(JSON.parse(ok.body).service, 'hachimi-trace-web');
    assert.match(JSON.parse(ok.body).url, /^http:\/\/andrewtstracing\.localhost:\d+$/);
    assert.equal((await get('evil.example')).status, 421);
    assert.equal((await get('andrewtstracing.com')).status, 421); // custom domain is opt-in via HACHIMI_TRACE_WEB_DOMAIN
  } finally { await app.close(); }
});

test('other devices on the LAN get a reachable address and read-only access', async t => {
  const lan = { lan: true, addresses: ['192.168.1.8'], names: ['andrewtstracing.local', 'andrewtsmanagement.local'] };
  for (const host of ['192.168.1.8:5077', 'andrewtstracing.local:5077', 'ANDREWTSMANAGEMENT.LOCAL:5077', 'andrewtstracing.localhost:5077']) assert.ok(isAllowedHost(host, '', lan), host);
  for (const host of ['192.168.1.9:5077', 'evil.local:5077', 'andrewtstracing.local.evil.example', '8.8.8.8']) assert.ok(!isAllowedHost(host, '', lan), host);
  assert.ok(!isAllowedHost('192.168.1.8:5077', '', { lan: false }));
  for (const address of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '127.0.0.77']) assert.ok(isLoopbackAddress(address), address);
  for (const address of ['192.168.1.20', '::ffff:192.168.1.20', '', '10.0.0.1']) assert.ok(!isLoopbackAddress(address), address);

  const port = traceWebPort();
  assert.equal(await traceUrlForClient({ remoteAddress: '127.0.0.1', host: 'andrewtsmanagement.com:5088' }), friendlyTraceUrl());
  assert.equal(await traceUrlForClient({ remoteAddress: '192.168.1.20', host: 'andrewtsmanagement.local:5088' }), `http://andrewtstracing.local:${port}`);
  const [address] = traceLanAddresses();
  if (!address) return t.diagnostic('no LAN address: HTTP part skipped');
  assert.equal(await traceUrlForClient({ remoteAddress: '192.168.1.20', host: `${address}:5088` }), `http://${address}:${port}`);
  assert.equal(await traceUrlForClient({ remoteAddress: '192.168.1.20', host: 'andrewtsmanagement.com:5088' }), `http://${address}:${port}`);

  const app = createTraceWeb({ sync: false, purge: false, mdnsName: '', log: () => {} });
  const { port: listening } = await app.listen(0, '0.0.0.0');
  const call = (host, method, path) => new Promise((done, fail) => {
    const req = httpRequest({ host, port: listening, path, method }, res => { let body = ''; res.on('data', c => { body += c; }); res.on('end', () => done({ status: res.statusCode, body })); });
    req.on('error', fail); req.end(method === 'GET' ? undefined : '{}');
  });
  try {
    // Through the LAN address the client is not loopback, exactly like a phone on the same Wi-Fi.
    assert.equal((await call(address, 'GET', '/')).status, 200);
    assert.equal((await call(address, 'GET', '/api/health')).status, 200);
    for (const [method, path] of [['POST', '/api/trace'], ['POST', '/api/sync'], ['POST', '/api/retention/run'], ['DELETE', '/api/sessions/1']]) assert.equal((await call(address, method, path)).status, 403, `${method} ${path}`);
    assert.notEqual((await call('127.0.0.1', 'POST', '/api/trace')).status, 403);
  } finally { await app.close(); }
});
