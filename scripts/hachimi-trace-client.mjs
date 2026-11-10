#!/usr/bin/env node
// Send tracing events to the local Hachimi tracing web (falls back to writing the DB directly when the web is down).
// CLI: node scripts/hachimi-trace-client.mjs --source manual --id <trace id> --kind thinking --text "..." [--ticket JOY-260925-xxxx] [--subject "..."] [--category Bug] [--phase elite] [--actor hachimi] [--status running] [--no-fallback]
//      Data sources consulted at that step: --doc <path[,path]> --skill <path[,path]> --kb <path[,path]> --url <url[,url]> --artifact <path[,path]>
//      or --sources '[{"type":"docs","path":"knowledge-base/knowledge/joy/x.md","excerpt":"..."}]' (paths are repo-relative).
//      echo '{"source":"manual","id":"x","events":[...]}' | node scripts/hachimi-trace-client.mjs --stdin
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from './hachimi-db.mjs';

export function traceWebUrl() {
  const env = loadEnv();
  const port = Number(process.env.HACHIMI_TRACE_WEB_PORT || env.HACHIMI_TRACE_WEB_PORT) || 5077;
  return process.env.HACHIMI_TRACE_WEB_URL || env.HACHIMI_TRACE_WEB_URL || `http://127.0.0.1:${port}`;
}

// Best-effort: never throws unless { strict } is set. Returns { ok, via, result|error }.
export async function sendTrace(body, { timeoutMs = 2000, fallback = true, strict = false } = {}) {
  try {
    const response = await fetch(`${traceWebUrl()}/api/trace/events`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
    return { ok: true, via: 'http', result };
  } catch (httpError) {
    if (fallback) {
      try {
        const { recordTrace } = await import('./hachimi-trace-store.mjs');
        return { ok: true, via: 'db', result: await recordTrace(body), httpError: String(httpError.message) };
      } catch (dbError) {
        if (strict) throw dbError;
        return { ok: false, via: 'none', error: `${httpError.message}; db: ${dbError.message}` };
      }
    }
    if (strict) throw httpError;
    return { ok: false, via: 'none', error: String(httpError.message) };
  }
}

// Convenience for one event.
export const traceEvent = (source, id, event, session = {}, options) => sendTrace({ source, id, ...session, events: [event] }, options);

function parseArgs(argv) {
  const args = {}; const flags = new Set();
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (!key.startsWith('--')) continue;
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) flags.add(key.slice(2)); else { args[key.slice(2)] = next; i++; }
  }
  return { args, flags };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { args, flags } = parseArgs(process.argv.slice(2));
  let body;
  if (flags.has('stdin')) {
    const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk);
    body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } else {
    if (!args.source || !args.id) { console.error('Usage: --source <source> --id <id> --kind <kind> --text "..." [--ticket ...] [--subject ...] [--category ...] [--phase ...] [--actor ...] [--status ...] [--terminal]'); process.exit(2); }
    const sources = args.sources ? JSON.parse(args.sources) : [];
    for (const [flag, type] of [['doc', 'docs'], ['skill', 'skill'], ['kb', 'kb'], ['artifact', 'artifact']]) {
      for (const path of String(args[flag] || '').split(',').map(value => value.trim()).filter(Boolean)) sources.push({ type, path });
    }
    for (const url of String(args.url || '').split(',').map(value => value.trim()).filter(Boolean)) sources.push({ url });
    body = {
      source: args.source, id: args.id, ticketReference: args.ticket, subject: args.subject, category: args.category, status: args.status, phase: args.phase,
      terminal: flags.has('terminal') ? true : undefined,
      events: [{ kind: args.kind || 'text', text: args.text || '', phase: args.phase, actor: args.actor || 'hachimi', payload: args.payload ? JSON.parse(args.payload) : undefined, sources: sources.length ? sources : undefined }],
    };
  }
  const outcome = await sendTrace(body, { fallback: !flags.has('no-fallback') });
  console.log(JSON.stringify({ ok: outcome.ok, via: outcome.via, sessionId: outcome.result?.sessionId, seq: outcome.result?.events?.map(e => e.seq), error: outcome.error, httpError: outcome.httpError }));
  if (outcome.via === 'db') { const { closePool } = await import('./hachimi-db.mjs'); await closePool(); }
  process.exit(outcome.ok ? 0 : 1);
}
