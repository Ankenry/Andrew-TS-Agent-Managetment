#!/usr/bin/env node
// Local web for Hachimi check-ticket tracing: ingest API, live stream (SSE), UI, and 10-day retention purge.
// Usage: node scripts/hachimi-trace-web.mjs [--port 5077] [--no-sync] [--no-purge]
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, closePool, loadEnv, query, getPool } from './hachimi-db.mjs';
import { recordTrace, listSessions, lookupSession, getSession, getEvents, getArtifact, getSessionSources, getSource, getKnowledgeChunk, deleteSession, stats, purgeExpired, retentionDays, EVENT_KINDS } from './hachimi-trace-store.mjs';
import { readSourceFile, SOURCE_TYPES, ALLOWED_ROOTS } from './hachimi-trace-sources.mjs';
import { syncTraces } from './hachimi-trace-sync.mjs';
import { summary as analyticsSummary, listReviews, effectiveReviewPage, listFeedback, trainFeedback, lessons as analyticsLessons, syncReactions, syncStatus as reactionSyncStatus } from './hachimi-analytics-store.mjs';
import { isAllowedHost, friendlyTraceUrl, isLoopbackAddress, isTraceLanKey, traceLanAddresses, traceLanEnabled, traceLanKeyRequired, traceLanName, TRACE_KEY_COOKIE, TRACE_SERVICE_NAME } from './hachimi-trace-domain.mjs';
import { startMdnsResponder } from './ts-web-mdns.mjs';
import { recordHelpdeskUsage, summarizeHelpdeskUsage } from './helpdesk-usage.mjs';
import { reconcileEvaluationReceipts } from './han-auto-assessment-projection.mjs';
import { readReactionSettings, reactionSyncEnabled, updateReactionSettings } from './reaction-analytics-settings.mjs';

const WEB_DIR = resolve(ROOT, 'web/trace'); // logo-*.png here are generated from Asset/ by scripts/generate-trace-logo.py
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8' };
const MAX_BODY = 2 * 1024 * 1024;

export function defaultPort() {
  const raw = Number(process.env.HACHIMI_TRACE_WEB_PORT || loadEnv().HACHIMI_TRACE_WEB_PORT);
  return Number.isInteger(raw) && raw > 0 ? raw : 5077;
}

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }

export function createTraceWeb({ purgeIntervalMs = 60 * 60 * 1000, syncIntervalMs = 15 * 1000, reactionSyncIntervalMs = 10 * 60 * 1000, sync = true, purge = true, mdnsName = traceLanName(), log = console.log } = {}) {
  const clients = new Set();
  const timers = [];
  let lastSyncTotals = '';
  let lastPurge = null;
  let mdns = null;

  // Devices on the LAN may only read. With TS_WEB_PIN set they also present that key once (?key=), kept in a cookie.
  function guardLanClient(req, res, url) {
    if (isLoopbackAddress(req.socket.remoteAddress)) return;
    if (!traceLanEnabled()) throw new HttpError(403, 'LAN access is disabled.');
    if (!['GET', 'HEAD'].includes(req.method)) throw new HttpError(403, 'Read-only from other devices.');
    if (!traceLanKeyRequired()) return;
    const given = url.searchParams.get('key');
    const cookie = String(req.headers.cookie || '').split(';').map(part => part.trim().split('=')).find(([name]) => name === TRACE_KEY_COOKIE)?.[1];
    if (given !== null && isTraceLanKey(given)) res.setHeader('Set-Cookie', `${TRACE_KEY_COOKIE}=${encodeURIComponent(given)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`);
    else if (!isTraceLanKey(decodeURIComponent(cookie || ''))) throw new HttpError(401, 'Access key required: open Tracing from the TS Management web.');
  }

  const broadcast = message => {
    const chunk = `data: ${JSON.stringify(message)}\n\n`;
    for (const client of clients) client.write(chunk);
  };

  async function runPurge(trigger = 'scheduled') {
    const result = await purgeExpired({ trigger });
    lastPurge = { ...result, at: new Date().toISOString() };
    if (result.deletedSessions) log(`[trace-web] purged ${result.deletedSessions} expired session(s) (${trigger})`);
    broadcast({ type: 'purge', ...lastPurge });
    return result;
  }

  async function runSync(trigger = 'scheduled') {
    const result = await syncTraces();
    try { await reconcileEvaluationReceipts({root:ROOT,pool:getPool()}); } catch { log('[evaluation] receipt metadata reconciliation unavailable; scores unchanged'); }
    const { rows: [totals] } = await query('SELECT (SELECT count(*) FROM trace_sessions)::int AS sessions, (SELECT count(*) FROM trace_events)::int AS events, (SELECT count(*) FROM trace_artifacts)::int AS artifacts, (SELECT max(updated_at) FROM trace_sessions) AS updated');
    const signature = JSON.stringify(totals);
    if (signature !== lastSyncTotals) { lastSyncTotals = signature; broadcast({ type: 'sync', trigger, ...result, totals }); }
    return { ...result, totals };
  }

  const readBody = req => new Promise((done, fail) => {
    const chunks = []; let size = 0;
    req.on('data', chunk => { size += chunk.length; if (size > MAX_BODY) { fail(new HttpError(413, 'Body too large.')); req.destroy(); } else chunks.push(chunk); });
    req.on('end', () => { try { done(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { fail(new HttpError(400, 'Invalid JSON body.')); } });
    req.on('error', fail);
  });

  const json = (res, status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
  const intParam = (value, name) => { const n = Number(value); if (!Number.isInteger(n) || n < 0) throw new HttpError(400, `Invalid ${name}.`); return n; };

  // Resolve what the viewer shows for one source: a repo file (docs/skill/artifact), a knowledge chunk (kb), or just a link.
  async function sourceContent(source) {
    const chunkId = Number(source.metadata?.chunkId);
    if (source.type === 'kb' && Number.isInteger(chunkId) && chunkId > 0) {
      const chunk = await getKnowledgeChunk(chunkId);
      if (chunk) {
        let file = null;
        try { file = await readSourceFile(`knowledge-base/${chunk.source_path}`); } catch { /* chunk only */ }
        return { kind: 'chunk', chunk, file };
      }
    }
    if (source.path) {
      try { return { kind: 'file', ...(await readSourceFile(source.path)) }; }
      catch (error) { return { kind: 'error', error: error.message, url: source.url || null }; }
    }
    if (source.url) return { kind: 'link', url: source.url };
    return { kind: 'none' };
  }

  async function serveStatic(res, pathname) {
    if (/^\/source\/\d+$/.test(pathname)) pathname = '/source.html';
    const target = resolve(WEB_DIR, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!target.startsWith(WEB_DIR + sep)) throw new HttpError(404, 'Not found.');
    let info; try { info = await stat(target); } catch { throw new HttpError(404, 'Not found.'); }
    if (!info.isFile()) throw new HttpError(404, 'Not found.');
    res.writeHead(200, { 'Content-Type': MIME[extname(target)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(await readFile(target));
  }

  async function handleApi(req, res, url) {
    const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]
    const method = req.method;
    if (parts[1] === 'helpdesk-usage') {
      if (method === 'GET') {
        const hours = Math.min(168, Math.max(1, Number(url.searchParams.get('hours')) || 24));
        return json(res, 200, await summarizeHelpdeskUsage({ since: Date.now() - hours * 3600_000 }));
      }
      if (method === 'POST') {
        if (!isLoopbackAddress(req.socket.remoteAddress)) throw new HttpError(403, 'Loopback only.');
        const body = await readBody(req);
        if (!['chrome-extension-background','chrome-extension-widget'].includes(body?.processName)) throw new HttpError(400, 'Unknown process.');
        await recordHelpdeskUsage(body);
        return json(res, 201, { ok: true });
      }
      throw new HttpError(405, 'Method not allowed.');
    }
    if (method === 'GET' && parts[1] === 'health') return json(res, 200, { ok: true, service: TRACE_SERVICE_NAME, url: friendlyTraceUrl(), now: new Date().toISOString(), retentionDays: retentionDays(), clients: clients.size, lastPurge });
    if (method === 'GET' && parts[1] === 'stats') return json(res, 200, { ...(await stats()), last_purge_local: lastPurge, read_only: !isLoopbackAddress(req.socket.remoteAddress) });
    if (method === 'GET' && parts[1] === 'kinds') return json(res, 200, [...EVENT_KINDS]);
    if (method === 'GET' && parts[1] === 'source-types') return json(res, 200, { types: [...SOURCE_TYPES], allowedRoots: ALLOWED_ROOTS });
    if (method === 'GET' && parts[1] === 'sources' && parts.length === 3) {
      const data = await getSource(intParam(parts[2], 'source id'));
      if (!data) throw new HttpError(404, 'Source not found.');
      return json(res, 200, { ...data, content: await sourceContent(data.source) });
    }
    if (method === 'GET' && parts[1] === 'stream') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(`data: ${JSON.stringify({ type: 'hello', retentionDays: retentionDays() })}\n\n`);
      clients.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 25000);
      req.on('close', () => { clearInterval(ping); clients.delete(res); });
      return undefined;
    }
    if (parts[1] === 'trace' && method === 'POST' && (parts.length === 2 || parts[2] === 'events')) {
      const body = await readBody(req);
      let result;
      try { result = await recordTrace(body); } catch (error) {
        if (!(error instanceof TypeError)) throw error;
        // The sender is best-effort and ignores the answer, so a refused batch is only visible here.
        log(`[trace-web] rejected ${Array.isArray(body?.events) ? body.events.length : 0} event(s) from ${String(body?.source || '?').slice(0, 32)}:${String(body?.id || '?').slice(0, 120)}: ${error.message}`);
        throw new HttpError(400, error.message);
      }
      broadcast({ type: 'events', sessionId: result.sessionId, source: result.source, externalId: result.externalId, ticketReference: result.ticketReference, events: result.events });
      return json(res, 201, result);
    }
    if (parts[1] === 'sessions') {
      if (method === 'GET' && parts.length === 2) return json(res, 200, await listSessions(Object.fromEntries(url.searchParams)));
      if (method === 'GET' && parts[2] === 'lookup') {
        const id = await lookupSession(String(url.searchParams.get('source') || ''), String(url.searchParams.get('id') || ''));
        if (id === null) throw new HttpError(404, 'Session not found.');
        return json(res, 200, { id });
      }
      const id = intParam(parts[2], 'session id');
      if (method === 'GET' && parts.length === 3) { const data = await getSession(id); if (!data) throw new HttpError(404, 'Session not found.'); return json(res, 200, data); }
      if (method === 'GET' && parts[3] === 'events') return json(res, 200, await getEvents(id, Number(url.searchParams.get('after') ?? -1)));
      if (method === 'GET' && parts[3] === 'sources') return json(res, 200, await getSessionSources(id));
      if (method === 'GET' && parts[3] === 'artifacts') { const artifact = await getArtifact(id, intParam(parts[4], 'artifact id')); if (!artifact) throw new HttpError(404, 'Artifact not found.'); return json(res, 200, artifact); }
      if (method === 'DELETE' && parts.length === 3) { const deleted = await deleteSession(id); broadcast({ type: 'deleted', sessionId: id }); return json(res, 200, { deleted }); }
    }
    // Analytics: Đại tá's 👍/😢 reactions on AI review comments + feedback used to train later checks (hachimi-analytics-store.mjs).
    if (parts[1] === 'analytics') {
      const params = Object.fromEntries(url.searchParams);
      if (parts[2] === 'reaction-settings') {
        if (method === 'GET') return json(res, 200, await readReactionSettings());
        if (method === 'PUT') {
          if (!isLoopbackAddress(req.socket.remoteAddress)) throw new HttpError(403, 'Loopback only.');
          try { return json(res, 200, await updateReactionSettings(await readBody(req))); }
          catch (error) { throw new HttpError(error.message === 'REACTION_SETTINGS_CONFLICT' ? 409 : error.message === 'REACTION_SETTINGS_INVALID' ? 400 : 500, error.message); }
        }
      }
      if (method === 'GET' && parts[2] === 'summary') { const data = await analyticsSummary(params); data.sync = { ...data.sync, enabled: (await readReactionSettings()).enabled }; return json(res, 200, data); }
      if (method === 'GET' && parts[2] === 'tickets') return json(res, 200, await effectiveReviewPage(params));
      if (method === 'GET' && parts[2] === 'feedback') return json(res, 200, { feedback: await listFeedback(params) });
      if (method === 'GET' && parts[2] === 'lessons') return json(res, 200, await analyticsLessons(params));
      if (method === 'GET' && parts[2] === 'sync') return json(res, 200, { ...reactionSyncStatus(), enabled: (await readReactionSettings()).enabled });
      // A sync can take a minute (one Helpdesk read per ticket): it runs in the background and the page follows `sync.running` in /summary.
      if (method === 'POST' && parts[2] === 'sync') {
        if (!(await readReactionSettings()).enabled) throw new HttpError(409, 'REACTION_ANALYTICS_DISABLED');
        const body = await readBody(req);
        const options = { force: body?.force === true, recentDays: Math.max(0, Math.min(30, Number(body?.recentDays) || 0)), ticketIds: Array.isArray(body?.ticketIds) ? body.ticketIds.map(String) : [] };
        if (body?.wait === true) return json(res, 200, await syncReactions(options));
        void syncReactions(options).catch(error => log(`[trace-web] reaction sync failed: ${error.message}`));
        return json(res, 202, { ...reactionSyncStatus(), started: true });
      }
      if (method === 'POST' && parts[2] === 'train') {
        const body = await readBody(req);
        let saved;
        try { saved = await trainFeedback({ ticket: body?.ticket, description: body?.description }); }
        catch (error) { if (error instanceof TypeError) throw new HttpError(400, error.message); throw error; }
        return json(res, 201, saved);
      }
    }
    if (method === 'POST' && parts[1] === 'retention' && parts[2] === 'run') return json(res, 200, await runPurge('manual'));
    if (method === 'POST' && parts[1] === 'sync') return json(res, 200, await runSync('manual'));
    throw new HttpError(404, 'Unknown API route.');
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    try {
      // Only loopback names (incl. *.localhost), the optional custom domain and this machine's LAN names may address this server (DNS-rebinding guard).
      if (!isAllowedHost(req.headers.host)) throw new HttpError(421, 'Unknown host.');
      guardLanClient(req, res, url);
      if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
      else if (req.method === 'GET') await serveStatic(res, url.pathname);
      else throw new HttpError(405, 'Method not allowed.');
    } catch (error) {
      const status = error.status || 500;
      if (status >= 500) log(`[trace-web] ${req.method} ${url.pathname} failed: ${error.message}`);
      if (!res.headersSent) json(res, status, { error: error.message });
      else res.end();
    }
  });

  // Loopback unless the caller asks for the LAN (the CLI does, see below); only a LAN listener publishes the mDNS name.
  async function listen(port = defaultPort(), host = '127.0.0.1') {
    await readReactionSettings();
    await new Promise((done, fail) => { server.once('error', fail); server.listen(port, host, () => { server.off('error', fail); done(); }); });
    if (host !== '127.0.0.1' && mdnsName) {
      try { mdns = startMdnsResponder({ name: mdnsName, log, label: 'trace-web' }); }
      catch (error) { log(`[trace-web] mDNS name disabled: ${error.message}`); }
    }
    if (purge) {
      runPurge('startup').catch(error => log(`[trace-web] purge failed: ${error.message}`));
      timers.push(setInterval(() => runPurge().catch(error => log(`[trace-web] purge failed: ${error.message}`)), purgeIntervalMs));
    }
    if (sync) {
      // Reactions on review comments: refreshed on start and every 10 minutes; the Analytics page can also ask for a sync.
      const syncReactionsIfEnabled = () => {
        if (reactionSyncEnabled()) syncReactions().catch(error => log(`[trace-web] reaction sync failed: ${error.message}`));
      };
      syncReactionsIfEnabled();
      timers.push(setInterval(syncReactionsIfEnabled, reactionSyncIntervalMs));
    }
    if (sync) {
      runSync('startup').catch(error => log(`[trace-web] sync failed: ${error.message}`));
      timers.push(setInterval(() => runSync().catch(error => log(`[trace-web] sync failed: ${error.message}`)), syncIntervalMs));
    }
    return { port: server.address().port, host };
  }

  async function close() {
    for (const timer of timers) clearInterval(timer);
    mdns?.stop();
    for (const client of clients) client.end();
    await new Promise(done => server.close(done));
    await closePool();
  }

  return { server, listen, close, runPurge, runSync, broadcast };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const port = argv.includes('--port') ? Number(argv[argv.indexOf('--port') + 1]) : defaultPort();
  const app = createTraceWeb({ sync: !argv.includes('--no-sync'), purge: !argv.includes('--no-purge') });
  try {
    const address = await app.listen(port, traceLanEnabled() ? '0.0.0.0' : '127.0.0.1');
    console.log(`[trace-web] Hachimi tracing web listening on http://${address.host}:${address.port} (retention ${retentionDays()} days); open ${friendlyTraceUrl(address.port)}`);
    if (address.host !== '127.0.0.1') console.log(`[trace-web] other devices (read-only${traceLanKeyRequired() ? ', access key required' : ''}): ${[traceLanName(), ...traceLanAddresses()].filter(Boolean).map(name => `http://${name}:${address.port}`).join(', ') || 'no LAN address right now'}`);
  } catch (error) {
    console.error(`[trace-web] cannot start: ${error.message}`);
    process.exit(1);
  }
  const stop = () => app.close().finally(() => process.exit(0));
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}
