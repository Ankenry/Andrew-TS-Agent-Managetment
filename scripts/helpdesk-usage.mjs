// Local request accounting for Helpdesk External API. Records metadata only:
// no credential, ticket id, URL query, response body, or request body.
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AsyncLocalStorage } from 'node:async_hooks';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const USAGE_FILE = resolve(ROOT, 'runtime/helpdesk-usage.jsonl');
const flowContext = new AsyncLocalStorage();
export const runHelpdeskFlow = (name, fn) => flowContext.run(name, fn);
export const currentHelpdeskFlow = () => flowContext.getStore() || '';

export function usageRoute(input) {
  let path;
  try { path = new URL(String(input), 'https://helpdesk.avada.net').pathname; }
  catch { return '[invalid]'; }
  path = path.replace(/^\/api\/external/, '');
  if (/^\/tickets\/[^/]+\/actions$/.test(path)) return '/tickets/:id/actions';
  if (/^\/tickets\/[^/]+\/comments$/.test(path)) return '/tickets/:id/comments';
  if (/^\/tickets\/[^/]+$/.test(path) && !['/tickets/admin','/tickets/by-status'].includes(path)) return '/tickets/:id';
  return ['/tickets','/tickets/admin','/tickets/by-status','/members','/notifications'].includes(path) ? path : '[other]';
}

export function usageCaller(stack = new Error().stack) {
  const frames = String(stack || '').split('\n').slice(1);
  const skip = new Set(['recordHelpdeskUsage','usageCaller','helpdeskFetch','helpdesk','helpdeskGet','helpdeskRequest','apiRequest','apiGet','helpdeskManagementRequest']);
  for (const frame of frames) {
    const name = /^\s*at\s+(?:async\s+)?([^\s(]+)/.exec(frame)?.[1] || '';
    if (!name || skip.has(name) || name.includes('helpdesk-usage')) continue;
    return name.replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 80) || 'unknown';
  }
  return 'unknown';
}

export async function recordHelpdeskUsage({ processName = basename(process.argv[1] || 'node'), flow = 'unknown', method = 'GET', path, status = 0 } = {}) {
  const entry = {
    at: new Date().toISOString(), pid: String(processName).startsWith('chrome-extension') ? 'browser' : process.pid,
    process: String(processName).replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 80) || 'unknown',
    flow: String(flow).replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 80) || 'unknown',
    method: String(method).toUpperCase().slice(0, 8), route: usageRoute(path),
    status: Number.isInteger(Number(status)) ? Number(status) : 0,
  };
  await mkdir(dirname(USAGE_FILE), { recursive: true });
  await appendFile(USAGE_FILE, JSON.stringify(entry) + '\n', { mode: 0o600 });
  return entry;
}

export async function summarizeHelpdeskUsage({ since = Date.now() - 24 * 60 * 60 * 1000, file = USAGE_FILE } = {}) {
  const raw = await readFile(file, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
  const byProcess = new Map(), byInstance = new Map(), byFlow = new Map(), byRoute = new Map(), byHour = new Map();
  let total = 0, firstAt = '', lastAt = '', badLines = 0;
  for (const line of raw.split('\n')) {
    if (!line) continue;
    let item; try { item = JSON.parse(line); } catch { badLines++; continue; }
    const ms = Date.parse(item.at || '');
    if (!Number.isFinite(ms) || ms < since) continue;
    const proc = String(item.process || 'unknown');
    const flow = String(item.flow || 'unknown');
    const route = String(item.route || '[other]');
    const hour = new Date(ms).toISOString().slice(0, 13) + ':00Z';
    total++;
    if (!firstAt || item.at < firstAt) firstAt = item.at;
    if (!lastAt || item.at > lastAt) lastAt = item.at;
    byProcess.set(proc, (byProcess.get(proc) || 0) + 1);
    const instance = `${proc} · ${item.pid ?? 'unknown'}`;
    byInstance.set(instance, (byInstance.get(instance) || 0) + 1);
    byFlow.set(`${proc} · ${flow}`, (byFlow.get(`${proc} · ${flow}`) || 0) + 1);
    byRoute.set(route, (byRoute.get(route) || 0) + 1);
    byHour.set(hour, (byHour.get(hour) || 0) + 1);
  }
  const rows = map => [...map].map(([name, count]) => ({ name, count })).sort((a,b) => b.count - a.count || a.name.localeCompare(b.name));
  return { since: new Date(since).toISOString(), firstAt, lastAt, total, badLines,
    processes: rows(byProcess), instances: rows(byInstance), flows: rows(byFlow), routes: rows(byRoute), hours: rows(byHour).sort((a,b) => a.name.localeCompare(b.name)) };
}
