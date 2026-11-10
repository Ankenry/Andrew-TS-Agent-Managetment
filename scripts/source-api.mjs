#!/usr/bin/env node
// Thin CLI over skills/check-ticket-v2/scripts/source-api.mjs for agents checking a ticket by hand (Hancal):
// read the LATEST app source through the TS Elite 2 Source API instead of the apps_doc/ copy.
//
//   node scripts/source-api.mjs grep  --app joy [--glob "packages/scripttag/**"] [--context 2] [--max 40] [--case] "<regex>"
//   node scripts/source-api.mjs search --app joy "a string" ["another" …]        # fixed strings, case-insensitive (multi_search)
//   node scripts/source-api.mjs multi_search --app joy "a" "b"                   # same as search
//   node scripts/source-api.mjs tree  --app joy [--path packages/scripttag] [--glob "*.js"]
//   node scripts/source-api.mjs read  --app joy --file packages/scripttag/src/index.js [--lines 100-160]
//   node scripts/source-api.mjs apps                                              # slugs the API knows
//   --json prints the normalized result as JSON. The key (BEARER_Auth in .env_my) is never printed.
// Search/grep/tree run on a clone ≤ ~15 min old (commit + age printed); read is live from GitLab: read before quoting.
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSourceApi, readKeyFile, formatSearch, formatRead, readManifest, shouldFallback, SourceApiError, DEFAULT_ENDPOINT, MAX_SEARCH_RESULTS } from '../skills/check-ticket-v2/scripts/source-api.mjs';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const ACTIONS = ['grep', 'search', 'multi_search', 'tree', 'read', 'apps'];
const FLAGS_WITH_VALUE = new Set(['app', 'glob', 'context', 'max', 'path', 'file', 'lines', 'timeout']);
const BOOL_FLAGS = new Set(['json', 'case', 'help']);

// Pure: argv (after node + script) → { action, flags, positionals } or { error }.
export function parseArgs(argv) {
  const [action, ...rest] = argv;
  if (!action || action === '--help' || action === '-h') return { action: null, flags: { help: true }, positionals: [] };
  if (!ACTIONS.includes(action)) return { error: `Action không hợp lệ "${action}"; dùng ${ACTIONS.join(' | ')}.` };
  const flags = { glob: [] }; const positionals = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--') { positionals.push(...rest.slice(i + 1)); break; }
    if (!arg.startsWith('--')) { positionals.push(arg); continue; }
    const eq = arg.indexOf('=');
    const name = (eq >= 0 ? arg.slice(2, eq) : arg.slice(2)).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (BOOL_FLAGS.has(name)) { flags[name] = true; continue; }
    if (!FLAGS_WITH_VALUE.has(name)) return { error: `Cờ không hợp lệ --${name}.` };
    const value = eq >= 0 ? arg.slice(eq + 1) : rest[++i];
    if (value === undefined) return { error: `Thiếu giá trị cho --${name}.` };
    if (name === 'glob') flags.glob.push(...value.split(',').map(item => item.trim()).filter(Boolean));
    else flags[name] = value;
  }
  if (action === 'grep' && positionals.length !== 1) return { error: 'grep cần đúng một regex (đặt trong dấu nháy).' };
  if ((action === 'search' || action === 'multi_search') && (!positionals.length || positionals.length > 10)) return { error: 'search/multi_search cần 1–10 chuỗi.' };
  if (action === 'read' && !flags.file) return { error: 'read cần --file <đường dẫn trong repo app>.' };
  if (action !== 'apps' && !flags.app) return { error: `${action} cần --app <slug>.` };
  if (flags.glob.some(item => item.includes('..') || item.startsWith('/'))) return { error: 'glob không được chứa ".." hoặc bắt đầu bằng "/".' };
  if (flags.context !== undefined && !/^[0-3]$/.test(String(flags.context))) return { error: '--context nhận 0–3.' };
  if (flags.lines !== undefined && !/^\d+(-\d+)?$/.test(String(flags.lines))) return { error: '--lines dạng "100-160".' };
  return { action, flags, positionals };
}

export function parseLines(value) {
  if (!value) return { start: 1, end: 200 };
  const [a, b] = String(value).split('-').map(Number);
  const start = Math.max(1, a || 1);
  return { start, end: Math.max(start, b || start + 199) };
}

export function fallbackHint(app, manifest) {
  const entry = manifest?.[app];
  if (!entry) return `Dự phòng: không có bản sao apps_doc/${app} trên máy (app này chỉ có knowledge-base/).`;
  return `Dự phòng: đọc bản sao apps_doc/${app} (commit ${String(entry.commit || '?').slice(0, 8)}, tải ${String(entry.fetchedAt || '?').slice(0, 10)}) — có thể cũ, ghi rõ khi trích dẫn.`;
}

export function formatTree(result, { max = 200 } = {}) {
  const head = `[nguồn API: app ${result.app} · clone ${result.ageMinutes ?? '?'} phút · commit ${String(result.commit || '?').slice(0, 8)} · ref ${result.ref || '?'}] ${result.files.length} mục dưới ${result.path || '/'}${result.truncated ? ' (API cắt bớt)' : ''}${result.files.length > max ? `; hiển thị ${max}` : ''}`;
  return [head, ...result.files.slice(0, max)].join('\n');
}

export function usage() {
  return [
    'node scripts/source-api.mjs <action> [cờ] [tham số]   (mã nguồn MỚI NHẤT qua TS Elite 2 Source API; key BEARER_Auth trong .env_my)',
    '  grep         --app <slug> [--glob "packages/**"] [--context 0-3] [--max 40] [--case] "<regex>"',
    '  search       --app <slug> "chuỗi" ["chuỗi 2" …]   (nguyên văn, không phân biệt hoa thường; alias multi_search)',
    '  tree         --app <slug> [--path packages/scripttag] [--glob "*.js"]',
    '  read         --app <slug> --file <đường dẫn trong repo> [--lines 100-160]   (bản mới nhất từ GitLab; đọc trước khi trích dẫn)',
    '  apps                                                   (danh sách slug API biết)',
    '  --json in JSON thô; --timeout <ms> (mặc định 8000).',
  ].join('\n');
}

export async function main(argv, { stdout = console.log, stderr = console.error, env = process.env } = {}) {
  const parsed = parseArgs(argv);
  if (parsed.error) { stderr(parsed.error); stderr(usage()); return 2; }
  if (parsed.flags.help) { stdout(usage()); return 0; }
  const { action, flags, positionals } = parsed;
  const key = env.SOURCE_API_KEY || readKeyFile(resolve(ROOT, '.env_my'));
  if (!key) { stderr('Thiếu BEARER_Auth trong .env_my (scope source:read). ' + fallbackHint(flags.app, readManifest(resolve(ROOT, 'apps_doc/manifest.json')))); return 3; }
  const api = createSourceApi({ key, endpoint: env.SOURCE_API_URL || DEFAULT_ENDPOINT, timeoutMs: Number(flags.timeout) || 8000, maxRetries: 1 });
  const max = Math.min(MAX_SEARCH_RESULTS, Math.max(1, Number(flags.max) || 20));
  try {
    let result; let text;
    if (action === 'grep') { result = await api.search({ app: flags.app, query: positionals[0], regex: true, glob: flags.glob, context: Number(flags.context) || 0, max, caseSensitive: Boolean(flags.case) }); text = formatSearch(result, { max }); }
    else if (action === 'search' || action === 'multi_search') { result = await api.search({ app: flags.app, queries: positionals, max }); text = formatSearch(result, { max }); }
    else if (action === 'tree') { result = await api.tree({ app: flags.app, path: flags.path || '', glob: flags.glob }); text = formatTree(result); }
    else if (action === 'read') { const { start, end } = parseLines(flags.lines); result = await api.read({ app: flags.app, file: flags.file, start, end }); text = formatRead(result); }
    else { result = await api.apps(); text = result.length ? `API biết ${result.length} app: ${result.join(', ')}` : 'API không trả danh sách app.'; }
    stdout(flags.json ? JSON.stringify(result, null, 2) : text);
    return 0;
  } catch (error) {
    const manifest = readManifest(resolve(ROOT, 'apps_doc/manifest.json'));
    if (error instanceof SourceApiError) {
      const hint = error.kind === 'unknown_app' ? `App API biết: ${(error.apps || []).join(', ') || '?'}. ${fallbackHint(flags.app, manifest)}`
        : error.kind === 'not_found' ? 'File không có trong bản mới nhất; tìm lại đường dẫn bằng search/grep/tree (bản sao apps_doc có thể đã đổi tên file).'
        : error.kind === 'bad_request' ? 'Sửa regex/glob/tham số rồi gọi lại; đây không phải "không có kết quả".'
        : error.kind === 'unauthorized' ? 'Key thiếu scope source:read hoặc hết hạn; tạo key mới ở ts2.avada.net → Settings → API keys. ' + fallbackHint(flags.app, manifest)
        : shouldFallback(error) ? `${error.kind === 'unavailable' ? 'Clone chưa sẵn sàng (thử search thay grep). ' : ''}${fallbackHint(flags.app, manifest)}` : '';
      stderr(`Lỗi API nguồn (${error.kind}${error.status ? `, HTTP ${error.status}` : ''}): ${api.scrub(error.message)}${hint ? `\n${hint}` : ''}`);
      return error.kind === 'bad_request' || error.kind === 'not_found' ? 4 : 5;
    }
    stderr(`Lỗi: ${api.scrub(error.message || error)}`); return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; });
}
