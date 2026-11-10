// Data sources attached to trace events (docs / skill / kb / TS Elite citation / ticket / url / artifact).
// Pure helpers (no DB): validation, path safety, safe file reading, citation parsing and Codex `exec --json` parsing.
import { existsSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { resolve, relative, sep, basename, extname, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const SOURCE_TYPES = new Set(['docs', 'skill', 'kb', 'elite', 'ticket', 'url', 'artifact', 'file']);
export const SOURCE_LABELS = { docs: 'Docs', skill: 'Skill', kb: 'KB', elite: 'TS Elite 2', ticket: 'Ticket', url: 'Link', artifact: 'Artifact', file: 'File' };
// Only these repo-relative roots may be opened by the source viewer.
export const ALLOWED_ROOTS = ['knowledge-base', 'skills', 'docs', 'runtime/check-ticket/jobs', 'runtime/sla-skill-rules.json', 'AGENTS.md'];
const DENY_NAME = /(^\.env|secret|token|credential|password|\.pem$|\.key$)/i;
const MAX_CONTENT = 400_000;
const MAX_SOURCES_PER_EVENT = 40;
const HELPDESK = 'https://helpdesk.avada.net/tickets/';
const TICKET_RE = /\b[A-Z]{2,6}-\d{6}-[A-Za-z0-9]{4,}\b/;
const clean = (value, max) => value === undefined || value === null ? null : String(value).trim().slice(0, max) || null;

export function normalizePath(value) {
  if (typeof value !== 'string') return null;
  let path = value.trim().replaceAll('\\', '/');
  if (!path || path.includes('\0') || path.length > 500) return null;
  path = posix.normalize(path).replace(/^\.\//, '').replace(/\/+$/, '');
  if (!path || path === '.' || path.startsWith('/') || path === '..' || path.startsWith('../') || /^[A-Za-z]:/.test(path)) return null;
  return path;
}

export function classifyPath(path) {
  if (path.startsWith('skills/') || path.startsWith('knowledge-base/skills/')) return 'skill';
  if (path.startsWith('knowledge-base/')) return 'docs';
  if (path.startsWith('runtime/check-ticket/jobs/')) return 'artifact';
  return 'file';
}

export function isAllowedPath(path) {
  return ALLOWED_ROOTS.some(root => path === root || path.startsWith(root + '/')) && !DENY_NAME.test(basename(path));
}

export function classifyUrl(url) {
  try {
    const { hostname } = new URL(url);
    if (hostname === 'helpdesk.avada.net') return 'ticket';
    if (/(^|\.)avada\.net$/.test(hostname)) return 'elite';
  } catch { /* fallthrough */ }
  return 'url';
}

export function normalizeUrl(value) {
  if (typeof value !== 'string' || value.length > 2000) return null;
  try { const url = new URL(value.trim()); return ['http:', 'https:'].includes(url.protocol) ? url.href : null; } catch { return null; }
}

// Accepts { type?, label?, path?, url?, locator?, excerpt?, metadata? } or a bare repo-relative path string.
export function normalizeSource(raw) {
  if (typeof raw === 'string') raw = { path: raw };
  if (!raw || typeof raw !== 'object') throw new TypeError('Source must be an object.');
  const path = raw.path === undefined || raw.path === null || raw.path === '' ? null : normalizePath(raw.path);
  if (raw.path && !path) throw new TypeError('Invalid source path.');
  const url = raw.url === undefined || raw.url === null || raw.url === '' ? null : normalizeUrl(raw.url);
  if (raw.url && !url) throw new TypeError('Invalid source url.');
  let type = String(raw.type || '').toLowerCase();
  if (!type) type = path ? classifyPath(path) : url ? classifyUrl(url) : '';
  if (!SOURCE_TYPES.has(type)) throw new TypeError(`Unknown source type: ${type || '(empty)'}`);
  let label = clean(raw.label, 200);
  if (!label) {
    if (path) label = basename(path);
    else if (url) { try { const u = new URL(url); label = (u.hostname + u.pathname).slice(0, 200); } catch { label = url.slice(0, 200); } }
  }
  if (!label) throw new TypeError('Source needs a label, path or url.');
  let metadata = null;
  if (raw.metadata && typeof raw.metadata === 'object' && !Array.isArray(raw.metadata)) {
    const encoded = JSON.stringify(raw.metadata);
    if (encoded.length <= 4000) metadata = raw.metadata;
  }
  return { type, label, path, url, locator: clean(raw.locator, 200), excerpt: clean(raw.excerpt, 2000), metadata };
}

export function normalizeSources(list) {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) throw new TypeError('sources must be an array.');
  if (list.length > MAX_SOURCES_PER_EVENT) throw new TypeError(`At most ${MAX_SOURCES_PER_EVENT} sources per event.`);
  const seen = new Set(); const out = [];
  for (const raw of list) {
    const source = normalizeSource(raw);
    const key = [source.type, source.path || '', source.url || '', source.locator || ''].join('\n');
    if (seen.has(key)) continue;
    seen.add(key); out.push(source);
  }
  return out;
}

function markdownTitle(content) {
  return content.match(/^\s*#\s+(.+?)\s*$/m)?.[1] || '';
}

// Reads a repo file for the viewer. Throws for paths outside ALLOWED_ROOTS, secrets, symlink escapes and non-files.
export async function readSourceFile(rawPath) {
  const path = normalizePath(rawPath);
  if (!path || !isAllowedPath(path)) throw new Error('Source path is not readable.');
  const rootReal = await realpath(ROOT);
  let real;
  try { real = await realpath(resolve(ROOT, path)); } catch { throw new Error('Source file not found.'); }
  if (!real.startsWith(rootReal + sep)) throw new Error('Source path is not readable.');
  const resolvedRelative = relative(rootReal, real).split(sep).join('/');
  if (!isAllowedPath(resolvedRelative)) throw new Error('Source path is not readable.');
  const info = await stat(real);
  if (!info.isFile()) throw new Error('Source is not a file.');
  const fd = openSync(real, 'r');
  let buffer;
  try {
    const length = Math.min(info.size, MAX_CONTENT);
    buffer = Buffer.alloc(length); readSync(fd, buffer, 0, length, 0);
  } finally { closeSync(fd); }
  const binary = buffer.subarray(0, 1000).includes(0);
  const content = binary ? '' : buffer.toString('utf8');
  const ext = extname(path).toLowerCase();
  const format = binary ? 'binary' : ext === '.md' ? 'markdown' : ext === '.json' ? 'json' : ext === '.css' ? 'css' : 'text';
  return { path: resolvedRelative, format, content, truncated: info.size > MAX_CONTENT, size: info.size, title: format === 'markdown' ? markdownTitle(content) : '' };
}

// Repo-relative file paths mentioned in a shell command (only under ALLOWED_ROOTS, only existing files).
const PATH_TOKEN_RE = /(?:^|[\s'"`=(:,])((?:\.\/)?(?:knowledge-base|skills|docs|runtime\/check-ticket\/jobs|AGENTS\.md)(?:\/[^\s'"`;|&<>()*?[\]]+)?)/g;
export function sourcesFromPathsInText(text, { limit = 20 } = {}) {
  const out = []; const seen = new Set();
  for (const match of String(text || '').matchAll(PATH_TOKEN_RE)) {
    const path = normalizePath(match[1].replace(/[.,:]+$/, ''));
    if (!path || seen.has(path) || !isAllowedPath(path)) continue;
    try { if (!statSync(resolve(ROOT, path)).isFile()) continue; } catch { continue; }
    seen.add(path);
    out.push({ type: classifyPath(path), label: basename(path), path });
    if (out.length >= limit) break;
  }
  return out;
}

const SOURCES_HEADING_RE = /^\s*(?:#{1,6}\s*)?[*_]*\s*(?:sources?|nguồn(?: tham khảo| dữ liệu)?|references?)\s*[*_]*\s*:?\s*$/i;
const STOP_RE = /^\s*(?:---+\s*$|#{1,6}\s|(?:\*\*)?(?:⚠️?\s*)?(?:\*\*)?citation audit)/i;
const STATUS_RE = /^\s*([✓✔✅]|[✗✘❌]|[◦○•·])\s*/;
const LINK_RE = /\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g;
const BARE_URL_RE = /https?:\/\/[^\s)<>"'\]]+/g;
const KB_PATH_RE = /(?:knowledge-base\/)?((?:knowledge|app-guides|skills|memory|docs|content|_docs)\/[\w./-]+\.[A-Za-z0-9]+)/;

// Extracts citations from an answer's trailing "Sources" section (TS Elite 2 / Codex answers).
export function parseSourcesSection(text, { limit = 40 } = {}) {
  const lines = String(text || '').split(/\r?\n/);
  let start = -1;
  for (let i = lines.length - 1; i >= 0; i--) if (SOURCES_HEADING_RE.test(lines[i])) { start = i; break; }
  if (start < 0) return [];
  const sources = []; const seen = new Set();
  const push = source => {
    try {
      const normalized = normalizeSource(source);
      const key = [normalized.type, normalized.path || '', normalized.url || '', normalized.label].join('\n');
      if (seen.has(key)) return;
      seen.add(key); sources.push(normalized);
    } catch { /* skip unusable citation */ }
  };
  for (let i = start + 1; i < lines.length && sources.length < limit && i < start + 80; i++) {
    const line = lines[i];
    if (STOP_RE.test(line)) break;
    const bullet = line.match(/^\s*(?:[-*+]|\d+[.)])\s+(.*)$/);
    if (!bullet) continue;
    let body = bullet[1].trim();
    const status = body.match(STATUS_RE);
    let metadata = null;
    if (status) {
      body = body.slice(status[0].length).trim();
      metadata = { status: /[✓✔✅]/.test(status[1]) ? 'used' : /[✗✘❌]/.test(status[1]) ? 'unavailable' : 'read' };
    }
    const excerpt = body.replace(LINK_RE, '$1').replace(/[*`]/g, '').trim().slice(0, 300) || null;
    const links = [...body.matchAll(LINK_RE)];
    if (links.length) {
      for (const [, label, url] of links) push({ type: classifyUrl(url), label: label.replace(/[*`]/g, '').trim() || url, url, excerpt, metadata });
      continue;
    }
    const bare = body.match(BARE_URL_RE);
    if (bare) { for (const url of bare) push({ type: classifyUrl(url), label: url, url, excerpt, metadata }); continue; }
    const kbPath = body.match(KB_PATH_RE);
    if (kbPath) {
      const candidate = `knowledge-base/${kbPath[1]}`;
      const exists = existsSync(resolve(ROOT, candidate));
      push({ type: kbPath[1].startsWith('skills/') ? 'skill' : 'docs', label: kbPath[1], path: exists ? candidate : null, excerpt, metadata });
      continue;
    }
    const ticket = body.match(TICKET_RE);
    if (ticket) { push({ type: 'ticket', label: `Ticket ${ticket[0]}`, url: HELPDESK + ticket[0], excerpt, metadata }); continue; }
    if (/ts elite|elite 2|elite2|retrieval/i.test(body)) { push({ type: 'elite', label: body.replace(/[*`]/g, '').slice(0, 200), excerpt, metadata }); continue; }
    if (body.length >= 4) push({ type: 'elite', label: body.replace(/[*`]/g, '').slice(0, 200), excerpt, metadata });
  }
  return sources;
}

// Knowledge chunks from elite2-knowledge-retrieval / hachimi-docs-search → docs/kb sources.
export function sourcesFromKnowledgeChunks(chunks, { type = 'docs', root = 'knowledge-base' } = {}) {
  return (chunks || []).slice(0, MAX_SOURCES_PER_EVENT).map(chunk => {
    const sourcePath = String(chunk.sourcePath || '').replaceAll('\\', '/');
    const candidate = sourcePath ? `${root}/${sourcePath}` : null;
    return {
      type: type === 'kb' ? 'kb' : (sourcePath.startsWith('skills/') ? 'skill' : 'docs'),
      label: chunk.heading ? `${basename(sourcePath) || sourcePath} › ${chunk.heading}` : (chunk.title || basename(sourcePath) || sourcePath),
      path: candidate && existsSync(resolve(ROOT, candidate)) ? candidate : (type === 'kb' ? sourcePath : null),
      locator: chunk.heading || null,
      excerpt: String(chunk.content || '').slice(0, 600),
      metadata: { ...(chunk.id !== undefined ? { chunkId: chunk.id } : {}), ...(chunk.appSlug ? { appSlug: chunk.appSlug } : {}), ...(chunk.score !== undefined ? { score: Number(Number(chunk.score).toFixed(4)) } : {}), ...(chunk.signals ? { signals: chunk.signals } : {}), sourcePath },
    };
  });
}

// Codex `exec --json` JSONL → timeline "tool" events (commands, MCP calls, file changes, web searches) with the repo files they touched.
// Reasoning and agent messages are intentionally not exported.
export function eventsFromCodexJsonl(stdout, { phase = null, actor = 'worker', limit = 60 } = {}) {
  const events = [];
  let skipped = 0;
  for (const line of String(stdout || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event; try { event = JSON.parse(line); } catch { continue; }
    if (event?.type !== 'item.completed' || !event.item) continue;
    const item = event.item;
    let text = ''; let payload = null; let sources = [];
    if (item.type === 'command_execution') {
      const command = String(item.command || '').trim();
      text = `$ ${command.slice(0, 600)}`;
      payload = { exitCode: item.exit_code ?? null, status: item.status || null };
      sources = sourcesFromPathsInText(command);
    } else if (item.type === 'mcp_tool_call') {
      text = `MCP ${item.server || ''}.${item.tool || ''}`.trim();
      const args = item.arguments && typeof item.arguments === 'object' ? item.arguments : {};
      const safeArgs = Object.fromEntries(Object.entries(args).filter(([, value]) => ['string', 'number', 'boolean'].includes(typeof value)).map(([key, value]) => [key, String(value).slice(0, 300)]));
      payload = { status: item.status || null, arguments: safeArgs };
      const url = normalizeUrl(args.url);
      if (url) sources = [{ type: classifyUrl(url), label: url.slice(0, 200), url }];
    } else if (item.type === 'file_change') {
      const paths = (item.changes || []).map(change => String(change.path || '')).filter(Boolean);
      text = `Sửa file: ${paths.join(', ').slice(0, 600)}`;
      payload = { status: item.status || null };
    } else if (item.type === 'web_search') {
      text = `Web search: ${String(item.query || '').slice(0, 300)}`;
    } else continue;
    if (events.length >= limit) { skipped++; continue; }
    events.push({ kind: 'tool', text, phase, actor, payload, sources });
  }
  if (skipped) events.push({ kind: 'note', text: `… còn ${skipped} lệnh/tool khác không hiển thị`, phase, actor });
  return events;
}
