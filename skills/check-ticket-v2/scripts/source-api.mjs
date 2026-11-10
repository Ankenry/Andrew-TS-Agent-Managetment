// TS Elite 2 Source API client for the investigate phase of check-ticket-v2.
// POST https://ts2.avada.net/api/v1/source/search — grep / multi_search / tree run on a clone refreshed every
// ~15 minutes (the answer carries `commit` and `age_minutes`); read fetches the latest file straight from GitLab.
// This module is pure code around fetch so it can be unit-tested with a mock: it never logs, never prints the
// key, and classifies every failure so the tools server can decide when to fall back to apps_doc/.
//
// Key handling: the key is taken from the SOURCE_API_KEY variable (tests) or read from a .env_my-style file
// (`BEARER_Auth=`) named by SOURCE_API_KEY_FILE. It is kept in a closure and the formatted outputs are scrubbed.

import { readFileSync } from 'node:fs';

export const DEFAULT_ENDPOINT = 'https://ts2.avada.net/api/v1/source/search';
export const DEFAULT_TIMEOUT_MS = 8000;
export const SOURCE_TOOLS = ['source_search', 'source_read'];
export const MAX_SEARCH_RESULTS = 40;
export const MAX_READ_LINES = 400;
export const MAX_LINE_CHARS = 240;
export const MAX_OUTPUT_CHARS = 30_000;

// Failure kinds. shouldFallback() says which ones send the tool to the local apps_doc copy.
export const ERROR_KINDS = ['network', 'timeout', 'server', 'unknown_app', 'not_found', 'bad_request', 'unauthorized', 'unavailable', 'disabled', 'bad_response'];
const FALLBACK_KINDS = new Set(['network', 'timeout', 'server', 'unknown_app', 'unavailable', 'bad_response']);

export class SourceApiError extends Error {
  constructor(kind, message, { status = 0, apps = null } = {}) {
    super(message);
    this.name = 'SourceApiError';
    this.kind = ERROR_KINDS.includes(kind) ? kind : 'server';
    this.status = status;
    this.apps = apps;
  }
}
export const shouldFallback = error => error instanceof SourceApiError && FALLBACK_KINDS.has(error.kind);

// Reads BEARER_Auth from a .env_my-style file. Returns null when missing; never throws, never logs.
export function readKeyFile(path) {
  let contents;
  try { contents = readFileSync(path, 'utf8'); } catch { return null; }
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?BEARER_Auth\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[1].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    value = value.replace(/^Bearer\s+/i, '').trim();
    return value || null;
  }
  return null;
}
export const hasKeyFile = path => Boolean(readKeyFile(path));

// Resolve the key the way the tools server does: explicit variable first, then the key file.
export function resolveKey(env = process.env) {
  if (env.SOURCE_API_KEY && String(env.SOURCE_API_KEY).trim()) return String(env.SOURCE_API_KEY).trim();
  if (env.SOURCE_API_KEY_FILE) return readKeyFile(env.SOURCE_API_KEY_FILE);
  return null;
}

const KNOWN_APPS_RE = /Known:\s*([a-z0-9-,\s]+)/i;

function classify(status, body, text) {
  const message = (body && (typeof body.error === 'string' ? body.error : body.error?.message || body.message)) || String(text || '').slice(0, 200) || `HTTP ${status}`;
  if (status === 401 || status === 403) return new SourceApiError('unauthorized', `Source API ${status}: ${message}`, { status });
  if (status === 400) return new SourceApiError('bad_request', `Source API 400: ${message}`, { status });
  if (status === 404) {
    const known = KNOWN_APPS_RE.exec(message);
    if (/unknown app/i.test(message) || known) return new SourceApiError('unknown_app', `Source API 404: ${message}`, { status, apps: known ? known[1].split(/[,\s]+/).filter(Boolean) : null });
    return new SourceApiError('not_found', `Source API 404: ${message}`, { status });
  }
  if (status === 503) return new SourceApiError('unavailable', `Source API 503: ${message}`, { status });
  if (status >= 500) return new SourceApiError('server', `Source API ${status}: ${message}`, { status });
  return new SourceApiError('server', `Source API ${status}: ${message}`, { status });
}

// Creates a client bound to one key. `fetchImpl` lets tests inject a fake fetch.
export function createSourceApi({ key, endpoint = DEFAULT_ENDPOINT, timeoutMs = DEFAULT_TIMEOUT_MS, maxRetries = 1, fetchImpl = globalThis.fetch } = {}) {
  if (!key) throw new SourceApiError('disabled', 'Source API: thiếu key');
  const scrub = value => String(value ?? '').split(key).join('<key>');

  async function once(body, timeout) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    let response;
    try {
      response = await fetchImpl(endpoint, {
        method: 'POST', signal: controller.signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({ format: 'json', ...body }),
      });
    } catch (error) {
      clearTimeout(timer);
      if (error?.name === 'AbortError') throw new SourceApiError('timeout', `Source API không trả lời trong ${timeout} ms`);
      throw new SourceApiError('network', `Source API lỗi mạng: ${scrub(error?.message || error)}`);
    }
    let text = '';
    try { text = await response.text(); } catch (error) { clearTimeout(timer); throw new SourceApiError('network', `Source API lỗi đọc phản hồi: ${scrub(error?.message || error)}`); }
    clearTimeout(timer);
    let json = null;
    try { json = JSON.parse(text); } catch { json = null; }
    if (response.status >= 400 || (json && json.ok === false)) throw classify(response.status, json, scrub(text));
    if (!json || typeof json !== 'object') throw new SourceApiError('bad_response', `Source API trả về không phải JSON (HTTP ${response.status})`, { status: response.status });
    return json;
  }

  // One retry only for transient failures (network/timeout/5xx); never for 4xx.
  async function call(body) {
    let attempt = 0; let lastError;
    while (attempt <= maxRetries) {
      try { return await once(body, timeoutMs); }
      catch (error) {
        lastError = error;
        if (!(error instanceof SourceApiError) || !['network', 'timeout', 'server'].includes(error.kind)) throw error;
        attempt++;
      }
    }
    throw lastError;
  }

  return {
    scrub,
    // regex → grep; plain string(s) → multi_search (fixed string, case-insensitive). Returns a normalized match list.
    async search({ app, query, queries = null, regex = false, glob = null, context = 0, max = 20, caseSensitive = false }) {
      const ctx = Math.min(3, Math.max(0, Number(context) || 0));
      const limit = Math.min(MAX_SEARCH_RESULTS, Math.max(1, Number(max) || 20));
      let json;
      if (regex) {
        json = await call({ action: 'grep', app, pattern: query, ...(Array.isArray(glob) && glob.length ? { glob } : {}), context: ctx, max_results: Math.min(2000, limit * 5), case_sensitive: Boolean(caseSensitive) });
        return normalize(json, (json.matches || []).map(match => ({ ...match, query })), { mode: 'regex' });
      }
      const list = (Array.isArray(queries) && queries.length ? queries : [query]).map(item => String(item || '').trim()).filter(Boolean).slice(0, 10);
      json = await call({ action: 'multi_search', app, queries: list });
      const flat = [];
      for (const group of json.results || []) for (const match of group.matches || []) flat.push({ ...match, query: group.query });
      return normalize(json, flat, { mode: 'fixed', queries: list });
    },
    // Directory listing on the clone (path relative to the repo root, optional globs). Used by the CLI only.
    async tree({ app, path = '', glob = null }) {
      const json = await call({ action: 'tree', app, path: String(path || ''), ...(Array.isArray(glob) && glob.length ? { glob } : {}) });
      return { app: json.app, ref: json.ref || null, source: json.source || null, commit: json.commit ? String(json.commit) : null, ageMinutes: json.age_minutes ?? null, path: json.path || path || '/', truncated: Boolean(json.truncated), files: (json.files || []).map(entry => (typeof entry === 'string' ? entry : entry?.path || String(entry))) };
    },
    // App slugs the API knows, read from its own 404 answer (there is no list endpoint).
    async apps() {
      try { await call({ action: 'tree', app: '__list_apps__', path: '' }); return []; }
      catch (error) { if (error instanceof SourceApiError && error.kind === 'unknown_app' && error.apps) return error.apps; throw error; }
    },
    async read({ app, file, start = 1, end = null }) {
      const first = Math.max(1, Number(start) || 1);
      const last = Math.min(first + MAX_READ_LINES - 1, Math.max(first, Number(end) || first + 199));
      const json = await call({ action: 'read', app, file, lines: `${first}-${last}` });
      return { app, file: json.file || file, ref: json.ref || null, source: json.source || null, totalLines: Number(json.total_lines) || null, start: Number(json.start_line) || first, end: Number(json.end_line) || last, truncated: Boolean(json.truncated), content: String(json.content ?? '') };
    },
  };

  function normalize(json, matches, extra) {
    return {
      app: json.app, ref: json.ref || null, source: json.source || null, commit: json.commit ? String(json.commit) : null, ageMinutes: json.age_minutes ?? null, fetchedAt: json.fetched_at || null,
      truncated: Boolean(json.truncated), totalMatches: json.total_matches ?? matches.length,
      matches: matches.map(match => ({ path: String(match.path || match.file || ''), line: Number(match.line) || 0, text: String(match.text ?? ''), before: Array.isArray(match.before) ? match.before : [], after: Array.isArray(match.after) ? match.after : [], query: match.query })),
      ...extra,
    };
  }
}

const clipLine = line => (line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…` : line);
const clipOutput = (value, max = MAX_OUTPUT_CHARS) => (value.length > max ? `${value.slice(0, max)}\n… (cắt bớt, ${value.length - max} ký tự nữa)` : value);
export const apiRef = (app, path) => `api:${app}/${String(path).replace(/^\/+/, '')}`;
const shortCommit = commit => (commit ? String(commit).slice(0, 8) : '?');

// Text for the model. Paths are written as api:<app>/<path> so the verifier knows where the quote came from.
export function formatSearch(result, { max = 20, perFile = 6 } = {}) {
  const limit = Math.min(MAX_SEARCH_RESULTS, Math.max(1, Number(max) || 20));
  const counts = new Map(); const shown = []; const seen = new Set();
  for (const match of result.matches) {
    const key = `${match.path}:${match.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const count = counts.get(match.path) || 0;
    counts.set(match.path, count + 1);
    if (count >= perFile) continue;
    if (shown.length < limit) shown.push(match);
  }
  const header = `[nguồn API: app ${result.app} · ${result.source === 'local_clone' ? `clone ${result.ageMinutes ?? '?'} phút` : result.source || '?'} · commit ${shortCommit(result.commit)} · ref ${result.ref || '?'}] ${result.totalMatches} dòng khớp${result.truncated ? ' (API cắt bớt)' : ''} trong ${counts.size} file; hiển thị ${shown.length}. Trích quote thì gọi source_read đúng file/dòng trước.`;
  if (!shown.length) return `${header}\nKhông có kết quả cho ${result.mode === 'regex' ? 'regex' : JSON.stringify(result.queries || [])}${result.mode === 'regex' ? '' : ' (so khớp nguyên văn, không phân biệt hoa thường; thử từ khác hoặc regex:true)'}.`;
  const files = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([path, count]) => `  ${apiRef(result.app, path)} (${count})`).join('\n');
  const multi = (result.queries || []).length > 1;
  const body = shown.map(match => {
    const lines = [];
    match.before.forEach((text, index) => lines.push(`${apiRef(result.app, match.path)}-${match.line - match.before.length + index}- ${clipLine(String(text))}`));
    lines.push(`${apiRef(result.app, match.path)}:${match.line}: ${clipLine(match.text.trim())}${multi ? `  [${match.query}]` : ''}`);
    match.after.forEach((text, index) => lines.push(`${apiRef(result.app, match.path)}-${match.line + 1 + index}- ${clipLine(String(text))}`));
    return lines.join('\n');
  }).join('\n');
  return clipOutput(`${header}\nFile có nhiều kết quả:\n${files}\n\n${body}`);
}

export function formatRead(result) {
  const lines = result.content.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === '' && result.content.endsWith('\n')) lines.pop();
  if (!lines.length) return `${apiRef(result.app, result.file)}: không có dòng ${result.start}-${result.end} (file có ${result.totalLines ?? '?'} dòng).`;
  const width = String(result.start + lines.length - 1).length;
  const body = lines.map((line, index) => `${String(result.start + index).padStart(width)}| ${line.length > 400 ? `${line.slice(0, 400)}…` : line}`).join('\n');
  return clipOutput(`${apiRef(result.app, result.file)} (dòng ${result.start}-${result.start + lines.length - 1} / ${result.totalLines ?? '?'} · GitLab bản mới nhất, ref ${result.ref || '?'})\n${body}`, 45_000);
}

// Header line for a result served from the local copy because the API failed.
export function fallbackHeader(app, manifestCommit, fetchedAt, error) {
  const why = error ? `${error.kind || 'lỗi'}: ${String(error.message || error).slice(0, 160)}` : 'API tắt';
  return `[nguồn: apps_doc@${shortCommit(manifestCommit)}${fetchedAt ? ` (bản sao tải ${String(fetchedAt).slice(0, 10)})` : ' (bản sao)'} · app ${app} · dự phòng vì API nguồn ${why}]`;
}

// apps_doc/manifest.json → { [slug]: { commit, fetchedAt } }; empty when the manifest is missing.
export function readManifest(path) {
  try {
    const manifest = JSON.parse(readFileSync(path, 'utf8'));
    const apps = manifest.apps || manifest;
    const out = {};
    // Entries the fetch script marked ok:false (archive 404) have no copy on disk and are left out.
    for (const entry of Array.isArray(apps) ? apps : Object.values(apps)) if (entry?.slug && entry.ok !== false) out[entry.slug] = { commit: entry.commit || null, fetchedAt: entry.fetchedAt || entry.fetched_at || manifest.fetchedAt || null };
    return out;
  } catch { return {}; }
}
