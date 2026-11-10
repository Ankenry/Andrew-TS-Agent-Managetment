#!/usr/bin/env node
// Probe of the TS Elite 2 Source API (POST https://ts2.avada.net/api/v1/source/search) for the feasibility
// assessment "replace apps_doc reading with the Source API". Read-only: it only sends search/grep/tree/read
// requests. The Bearer key is read from .env_my (BEARER_Auth) and never printed or written anywhere.
// Usage: node scripts/source-api-probe.mjs [--apps pdf-invoice,cookie-bar,joy-subs] [--repeat 3] [--out runtime/source-api-probe]
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENDPOINT = process.env.SOURCE_API_URL || 'https://ts2.avada.net/api/v1/source/search';
const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const PROBE_APPS = opt('--apps', 'pdf-invoice,cookie-bar,joy-subs').split(',').map(s => s.trim()).filter(Boolean);
const REPEAT = Math.max(1, Number(opt('--repeat', 3)) || 3);
const OUT_DIR = resolve(ROOT, opt('--out', 'runtime/source-api-probe'));

async function loadKey() {
  const env = await readFile(resolve(ROOT, '.env_my'), 'utf8');
  const line = env.split(/\r?\n/).find(l => /^\s*(export\s+)?BEARER_Auth\s*=/.test(l));
  if (!line) throw new Error('BEARER_Auth not found in .env_my');
  let value = line.replace(/^\s*(export\s+)?BEARER_Auth\s*=\s*/, '').trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
  return value.replace(/^Bearer\s+/i, '');
}
const KEY = await loadKey();
const scrub = text => String(text ?? '').split(KEY).join('<key>');

async function call(body, { timeoutMs = 30000, auth = true } = {}) {
  const started = performance.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let status = 0, json = null, text = '', error = null;
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST', signal: controller.signal,
      headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${KEY}` } : {}) },
      body: JSON.stringify({ format: 'json', ...body }),
    });
    status = res.status; text = await res.text();
    try { json = JSON.parse(text); } catch { json = null; }
  } catch (err) { error = err.name === 'AbortError' ? `timeout ${timeoutMs}ms` : String(err.message || err); }
  finally { clearTimeout(timer); }
  const ms = Math.round(performance.now() - started);
  const summary = { action: body.action, app: body.app, status, ms, ok: Boolean(json?.ok), error: error || (json && json.ok === false ? scrub(json.error || json.message || text.slice(0, 200)) : (status >= 400 ? scrub(text.slice(0, 200)) : null)) };
  if (json) {
    summary.source = json.source; summary.ref = json.ref; summary.commit = (json.commit || '').slice(0, 8); summary.age_minutes = json.age_minutes; summary.truncated = json.truncated;
    for (const k of ['matches', 'results', 'entries', 'files', 'items']) if (Array.isArray(json[k])) summary[`${k}`] = json[k].length;
    if (json.content !== undefined) summary.contentChars = String(json.content).length;
    if (json.lines !== undefined && !Array.isArray(json.lines)) summary.linesField = typeof json.lines === 'string' ? json.lines : typeof json.lines;
    if (Array.isArray(json.lines)) summary.contentLines = json.lines.length;
    if (Array.isArray(json.apps)) summary.apps = json.apps;
    if (json.error && typeof json.error === 'object') summary.errorObject = JSON.parse(scrub(JSON.stringify(json.error)).slice(0, 2000));
  }
  summary.bytes = text.length;
  return { summary, json, text: scrub(text) };
}

const median = arr => { const s = [...arr].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };
const report = { startedAt: new Date().toISOString(), endpoint: ENDPOINT, repeat: REPEAT, probes: [], latency: [], coverage: [], errors: [], samples: {} };
const log = (...a) => console.log(...a.map(x => typeof x === 'string' ? x : JSON.stringify(x)));

// ---- 1. per-app probes: grep, search, multi_search, tree, read (REPEAT times each, median latency)
for (const app of PROBE_APPS) {
  const timings = {};
  const add = (name, s) => { (timings[name] ||= []).push(s.ms); report.probes.push(s); };
  let firstFile = null;
  for (let i = 0; i < REPEAT; i++) {
    const tree = await call({ action: 'tree', app, path: '', glob: [] });
    add('tree', tree.summary);
    if (i === 0) { report.samples[`tree:${app}`] = tree.text.slice(0, 1500); log(`[${app}] tree`, tree.summary); }
    const grep = await call({ action: 'grep', app, pattern: 'shopify', glob: ['packages/**', 'extensions/**'], context: 1, max_results: 50 });
    add('grep', grep.summary);
    if (i === 0) {
      report.samples[`grep:${app}`] = grep.text.slice(0, 1500); log(`[${app}] grep`, grep.summary);
      const m = grep.json?.matches?.[0]; firstFile = m?.path || m?.file || null;
    }
    const grepWide = await call({ action: 'grep', app, pattern: 'useEffect|useState', context: 0, max_results: 200 });
    add('grep-wide', grepWide.summary); if (i === 0) log(`[${app}] grep-wide`, grepWide.summary);
    const search = await call({ action: 'search', app, query: 'settings', max_results: 50 });
    add('search', search.summary); if (i === 0) { report.samples[`search:${app}`] = search.text.slice(0, 1200); log(`[${app}] search`, search.summary); }
    const multi = await call({ action: 'multi_search', app, queries: ['scripttag', 'app embed', 'theme app extension'] });
    add('multi_search', multi.summary); if (i === 0) { report.samples[`multi_search:${app}`] = multi.text.slice(0, 1500); log(`[${app}] multi_search`, multi.summary); }
    if (firstFile) {
      const read = await call({ action: 'read', app, file: firstFile, lines: '1-80' });
      add('read', read.summary); if (i === 0) { read.summary.file = firstFile; report.samples[`read:${app}`] = read.text.slice(0, 1500); log(`[${app}] read`, read.summary); }
    }
  }
  for (const [name, arr] of Object.entries(timings)) report.latency.push({ app, action: name, n: arr.length, medianMs: median(arr), minMs: Math.min(...arr), maxMs: Math.max(...arr) });
}

// ---- 2. coverage: every app known to apps_doc / fetch script / prepare map → tree root
let manifestApps = [];
try { const m = JSON.parse(await readFile(resolve(ROOT, 'apps_doc/manifest.json'), 'utf8')); manifestApps = Object.values(m.apps || m).map(a => a.slug).filter(Boolean); } catch {}
const KNOWN = [...new Set([...manifestApps, 'joy-subscriptions', 'joy-subs', 'air-reviews', 'aem', 'shopvid', 'booking', 'order-limits', 'cookie-bar', 'pdf-invoice', 'survey', 'accessibility', 'age-verification', 'air-edd', 'order-tracking', 'affily', 'fraud-filter', 'online-course', 'shipping-labels', 'backups-restore', 'withdrawal-forms', 'order-editing', 'joy', 'wishlist', 'chatty'])];
const unknown = await call({ action: 'tree', app: '__no_such_app__', path: '' });
report.errors.push(unknown.summary); report.samples['404-app-list'] = unknown.text.slice(0, 3000); log('[404 probe]', unknown.summary);
const apiAppList = unknown.summary.apps || unknown.summary.errorObject?.apps || (() => { const m = /apps?[^\[]*(\[[^\]]*\])/i.exec(unknown.text); try { return m ? JSON.parse(m[1]) : null; } catch { return null; } })();
report.apiAppList = apiAppList;
for (const app of KNOWN) {
  const t = await call({ action: 'tree', app, path: '', glob: [] });
  report.coverage.push({ app, status: t.summary.status, ok: t.summary.ok, entries: t.summary.entries ?? t.summary.files ?? t.summary.items ?? null, commit: t.summary.commit, age_minutes: t.summary.age_minutes, ms: t.summary.ms, error: t.summary.error, inManifest: manifestApps.includes(app), inApiList: Array.isArray(apiAppList) ? apiAppList.includes(app) : null });
  log('[coverage]', report.coverage.at(-1));
}

// ---- 3. error probes and limits
const badRegex = await call({ action: 'grep', app: PROBE_APPS[0], pattern: '(' , max_results: 5 }); report.errors.push(badRegex.summary); log('[400 regex]', badRegex.summary);
const badGlob = await call({ action: 'grep', app: PROBE_APPS[0], pattern: 'x', glob: ['../**'] }); report.errors.push(badGlob.summary); log('[400 glob]', badGlob.summary);
const noAuth = await call({ action: 'tree', app: PROBE_APPS[0], path: '' }, { auth: false }); report.errors.push(noAuth.summary); log('[401 no key]', noAuth.summary);
const missingFile = await call({ action: 'read', app: PROBE_APPS[0], file: 'no/such/file.js' }); report.errors.push(missingFile.summary); log('[404 file]', missingFile.summary);
const bigRead = await call({ action: 'read', app: PROBE_APPS[0], file: 'package.json', lines: '1-2000' }); report.errors.push(bigRead.summary); report.samples['read:package.json'] = bigRead.text.slice(0, 800); log('[read package.json]', bigRead.summary);

// ---- 4. burst: 10 parallel greps (rate limit / contention)
const burstStart = performance.now();
const burst = await Promise.all(Array.from({ length: 10 }, (_, i) => call({ action: 'grep', app: PROBE_APPS[i % PROBE_APPS.length], pattern: 'metafield', context: 0, max_results: 20 })));
report.burst = { totalMs: Math.round(performance.now() - burstStart), statuses: burst.map(b => b.summary.status), ms: burst.map(b => b.summary.ms), medianMs: median(burst.map(b => b.summary.ms)) };
log('[burst 10 parallel grep]', report.burst);

// ---- write
report.finishedAt = new Date().toISOString();
await mkdir(OUT_DIR, { recursive: true });
const stamp = report.startedAt.replace(/[:.]/g, '-');
const file = resolve(OUT_DIR, `probe-${stamp}.json`);
const serialized = scrub(JSON.stringify(report, null, 2));
if (serialized.includes(KEY)) throw new Error('refusing to write: key leaked into report');
await writeFile(file, serialized, { mode: 0o600 });
log('\n=== LATENCY (median ms) ===');
for (const row of report.latency) log(`${row.app.padEnd(12)} ${row.action.padEnd(13)} n=${row.n} median=${row.medianMs} min=${row.minMs} max=${row.maxMs}`);
log('\n=== COVERAGE ===');
for (const row of report.coverage) log(`${row.app.padEnd(18)} HTTP ${row.status} ${row.ok ? 'OK ' : 'NO '} entries=${row.entries} commit=${row.commit || '-'} age=${row.age_minutes ?? '-'}m manifest=${row.inManifest} apiList=${row.inApiList}`);
log(`\nreport: ${file}`);
