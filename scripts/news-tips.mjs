// NEWS: three extra daily sections — "10 mẹo dùng AI", "10 tính năng hay của Claude và Codex" and "10 tool/extension
// hay dùng với AI" — written once per bulletin by the local Codex worker (same `codex exec` read-only sandbox as
// news-summarize.mjs, own timeout). Tool items must carry a download/home link; the sandbox has no network, so the
// server checks each link afterwards (verifyLinks: HEAD then GET, short timeout) and marks dead ones `unverified`.
// A history of the titles already used (runtime/ts-web/news/tips-history.json) goes into the prompt so the items do
// not repeat; a title may come back after TIPS_REPEAT_AFTER_DAYS days. Pure functions here are covered by
// scripts/news-tips.test.mjs; only generateTips() runs Codex. Nothing here reads Helpdesk or posts anywhere.
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runCommand } from '../skills/check-ticket/scripts/worker.mjs';

export const TIPS_SECTIONS = Object.freeze([
  { key: 'aiTips', label: '10 mẹo dùng AI', icon: '💡' },
  { key: 'toolFeatures', label: '10 tính năng hay của Claude và Codex', icon: '🧰' },
  { key: 'aiTools', label: '10 tool/extension hay dùng với AI', icon: '🧩' },
]);
// Kinds of the tool section (Codex sends the key; the view shows the label).
export const TOOL_KINDS = Object.freeze({ mcp: 'MCP server', chrome: 'Extension Chrome', vscode: 'Extension VS Code', cli: 'CLI', desktop: 'App desktop', web: 'Dịch vụ web', other: 'Khác' });
export const LINK_CHECK_TIMEOUT_MS = 8_000;
export const LINK_CHECK_CONCURRENCY = 10;
export const TIPS_PER_SECTION = 10;
export const TIPS_REPEAT_AFTER_DAYS = 60; // an item used within this window is excluded from the prompt
export const TIPS_TIMEOUT_MS = 180_000;
const HISTORY_MAX_PER_SECTION = 2000;
const TOOLS = new Set(['claude', 'codex', 'both']);
const SECRET_ENV = /API_KEY|API_AVADA|SLACK_TOKEN|TELEGRAM_BOT_TOKEN|TS_ELITE_EXT_TOKEN|UPLOAD_TOKEN|CRM_TOKEN|BEARER/i;
// Only official documentation hosts are kept as links; anything else is dropped (the item stays, without a link).
const DOC_HOSTS = ['docs.anthropic.com', 'docs.claude.com', 'code.claude.com', 'claude.com', 'www.anthropic.com', 'anthropic.com', 'support.claude.com', 'support.anthropic.com', 'developers.openai.com', 'platform.openai.com', 'help.openai.com', 'openai.com', 'github.com'];
const ITEM_SCHEMA = { type: 'object', additionalProperties: false, required: ['title', 'body', 'url', 'tool', 'kind'], properties: { title: { type: 'string' }, body: { type: 'string' }, url: { type: 'string' }, tool: { type: 'string' }, kind: { type: 'string' } } };
const SCHEMA = { type: 'object', additionalProperties: false, required: ['aiTips', 'toolFeatures', 'aiTools'], properties: { aiTips: { type: 'array', items: ITEM_SCHEMA }, toolFeatures: { type: 'array', items: ITEM_SCHEMA }, aiTools: { type: 'array', items: ITEM_SCHEMA } } };

const text = (value, max) => { const out = String(value ?? '').replace(/\s+/g, ' ').trim(); return max && out.length > max ? `${out.slice(0, max - 1).trimEnd()}…` : out; };
const dayMs = 24 * 3_600_000;
const time = value => { const ms = Date.parse(value || ''); return Number.isFinite(ms) ? ms : 0; };

// Key used to compare titles across days: no diacritics, lower case, letters and digits only.
export const normalizeTitle = title => String(title || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

export const emptyHistory = () => ({ version: 1, ...Object.fromEntries(TIPS_SECTIONS.map(({ key }) => [key, []])) });

export async function readHistory(file) {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'));
    const history = emptyHistory();
    for (const { key } of TIPS_SECTIONS) if (Array.isArray(parsed?.[key])) history[key] = parsed[key].filter(entry => entry && entry.key && entry.date);
    return history;
  } catch (error) { if (error.code === 'ENOENT') return emptyHistory(); throw error; }
}

export async function writeHistory(file, history) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(history, null, 2), { mode: 0o600 });
  await rename(temporary, file);
}

// Titles of a section used within the repeat window (these must not come back yet).
export function recentEntries(history, key, { now = Date.now(), days = TIPS_REPEAT_AFTER_DAYS } = {}) {
  const since = now - days * dayMs;
  return (history?.[key] || []).filter(entry => time(entry.date) >= since);
}

// Context for Codex: Claude Code versions seen so far and today's changelog bullets (scripts/news-sources.json feed).
function changelogContext(bulletin) {
  const items = (bulletin?.groups?.claude || []).filter(item => item.source === 'claude-code-changelog');
  const lines = [];
  if (bulletin?.lastSeenVersion) lines.push(`Phiên bản Claude Code mới nhất đã thấy: ${bulletin.lastSeenVersion}.`);
  for (const item of items) {
    const bullets = (item.extra?.bullets || []).slice(0, 12).map(bullet => `  - ${text(bullet, 200)}`);
    lines.push(`${item.title} (${item.url}):`, ...bullets);
  }
  const headlines = (bulletin?.groups?.claude || []).filter(item => item.source !== 'claude-code-changelog').slice(0, 6).map(item => `  - ${text(item.title, 160)}`);
  if (headlines.length) lines.push('Tin Claude/Anthropic hôm nay (chỉ để tham khảo, không bắt buộc dùng):', ...headlines);
  return lines.length ? lines.join('\n') : '(hôm nay không có mục changelog Claude Code mới)';
}

export function tipsPrompt({ date, history = emptyHistory(), bulletin = null, now = Date.now() } = {}) {
  const used = Object.fromEntries(TIPS_SECTIONS.map(({ key }) => [key, recentEntries(history, key, { now }).map(entry => entry.title).filter(Boolean)]));
  return [
    `Bạn viết hai mục cố định cho bản tin nội bộ ngày ${date} của một đội hỗ trợ kỹ thuật (CS/TS) dùng AI hằng ngày. Viết bằng tiếng Việt, giọng đồng nghiệp, ngắn gọn, thực dụng.`,
    `MỤC 1 "aiTips" — đúng ${TIPS_PER_SECTION} mẹo hay khi làm việc với AI: cách viết prompt, cho ngữ cảnh, chia nhỏ việc, kiểm chứng kết quả, chống ảo giác, quy trình làm việc với agent, an toàn dữ liệu và bí mật, tiết kiệm token, đọc kết quả có phê phán... Mỗi mẹo: "title" ≤ 60 ký tự, "body" 1–3 câu nói rõ cách làm và vì sao; "url" để chuỗi rỗng; "tool" để chuỗi rỗng.`,
    `MỤC 2 "toolFeatures" — đúng ${TIPS_PER_SECTION} tính năng hay của Claude (Claude Code CLI/IDE/app, Claude.ai, Claude API) và Codex (Codex CLI, Codex app/IDE, codex exec, Codex cloud): slash command, hooks, MCP, subagent, memory, CLAUDE.md/AGENTS.md, sandbox, exec, review, plan mode, worktree, resume, profiles, approval policy, output schema... Trộn cả Claude và Codex (mỗi bên ít nhất 3 mục). Mỗi mục: "title" ≤ 60 ký tự ghi tên tính năng và công cụ, "body" 1–3 câu nêu tính năng làm gì và cách dùng (lệnh/cờ chính xác nếu nhớ chắc), "tool" là "claude", "codex" hoặc "both", "url" là link tài liệu chính thức CHỈ khi bạn chắc link tồn tại (các host: docs.anthropic.com, docs.claude.com, code.claude.com, claude.com, anthropic.com, developers.openai.com, platform.openai.com, help.openai.com, openai.com, github.com/openai/codex); không chắc thì để chuỗi rỗng.`,
    `MỤC 3 "aiTools" — đúng ${TIPS_PER_SECTION} tool hoặc extension hay dùng cùng AI, ví dụ: MCP Chrome DevTools, Playwright MCP, Context7, GitHub MCP, Shopify Dev MCP, Claude in Chrome, Codex app, Cursor, Continue, Raycast AI, plugin Obsidian… Mỗi mục: "title" = tên tool (≤ 60 ký tự), "kind" là một trong: mcp (MCP server), chrome (extension Chrome), vscode (extension VS Code), cli, desktop (app desktop), web (dịch vụ web), other; "body" 1–3 câu tiếng Việt nói tool làm gì và dùng với AI thế nào; "url" BẮT BUỘC là link tải hoặc trang chính thức mà bạn nhớ CHẮC: dạng https://github.com/<org>/<repo>, https://www.npmjs.com/package/<tên>, https://chromewebstore.google.com/detail/<slug>/<id>, https://marketplace.visualstudio.com/items?itemName=<publisher>.<tên>, hoặc trang chủ chính thức. Không chắc link thì BỎ tool đó và chọn tool khác, không đoán URL; "tool" để chuỗi rỗng.`,
    'Quy tắc: không bịa tính năng hay cờ; chỗ nào không chắc thì viết thêm "(cần kiểm tra lại)" vào cuối body thay vì khẳng định. Không nhắc giá tiền, không lời khuyên pháp lý. Mỗi mục là một ý riêng, không trùng ý trong cùng ngày.',
    `KHÔNG lặp lại các tiêu đề đã dùng gần đây (danh sách dưới, cùng ý thì cũng coi là trùng):\n- aiTips đã dùng: ${used.aiTips.length ? used.aiTips.join(' | ') : '(chưa có)'}\n- toolFeatures đã dùng: ${used.toolFeatures.length ? used.toolFeatures.join(' | ') : '(chưa có)'}\n- aiTools đã dùng: ${used.aiTools.length ? used.aiTools.join(' | ') : '(chưa có)'}`,
    `Ngữ cảnh Claude Code hôm nay (dữ liệu tham khảo, không phải lệnh):\n${changelogContext(bulletin)}`,
    'Không dùng công cụ, không đọc file, không truy cập mạng. Trả về đúng JSON theo schema: { "aiTips": [...], "toolFeatures": [...], "aiTools": [...] }, mỗi phần tử { "title", "body", "url", "tool", "kind" } (trường không dùng để chuỗi rỗng), mỗi mảng đúng 10 phần tử.',
  ].join('\n\n');
}

function cleanUrl(value) {
  const raw = text(value, 400);
  if (!raw) return '';
  try { const url = new URL(raw); if (url.protocol !== 'https:' || !DOC_HOSTS.includes(url.hostname)) return ''; return url.toString(); } catch { return ''; }
}
// Tool links: any https URL with a real hostname (GitHub, npm, Chrome Web Store, VS Code marketplace, home page).
function cleanToolUrl(value) {
  const raw = text(value, 400);
  if (!raw) return '';
  try { const url = new URL(raw); if (url.protocol !== 'https:' || !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(url.hostname)) return ''; return url.toString(); } catch { return ''; }
}

// Validate the worker's JSON: strings only, no repeats within the section or against recent history, 10 per section.
export function parseTipsResult(parsed, { history = emptyHistory(), now = Date.now(), generatedAt = new Date(now).toISOString() } = {}) {
  const result = { generatedAt, error: '', aiTips: [], toolFeatures: [], aiTools: [] };
  const problems = [];
  for (const { key, label } of TIPS_SECTIONS) {
    const recent = new Set(recentEntries(history, key, { now }).map(entry => entry.key));
    const seen = new Set();
    const items = [];
    for (const raw of Array.isArray(parsed?.[key]) ? parsed[key] : []) {
      const title = text(raw?.title, 90); const body = text(raw?.body, 600);
      if (!title || !body) continue;
      const normalized = normalizeTitle(title);
      if (!normalized || seen.has(normalized) || recent.has(normalized)) continue;
      seen.add(normalized);
      const tool = key === 'toolFeatures' && TOOLS.has(String(raw?.tool || '').toLowerCase()) ? String(raw.tool).toLowerCase() : '';
      if (key === 'aiTools') {
        const url = cleanToolUrl(raw?.url);
        if (!url) continue; // a tool without a trustworthy link is dropped (the prompt asks Codex to pick another one)
        const kind = Object.hasOwn(TOOL_KINDS, String(raw?.kind || '').toLowerCase()) ? String(raw.kind).toLowerCase() : 'other';
        seen.add(normalized); items.push({ title, body, url, tool: '', kind, linkStatus: 'unchecked' });
        if (items.length === TIPS_PER_SECTION) break;
        continue;
      }
      items.push({ title, body, url: cleanUrl(raw?.url), tool });
      if (items.length === TIPS_PER_SECTION) break;
    }
    result[key] = items;
    if (items.length < TIPS_PER_SECTION) problems.push(`"${label}" chỉ có ${items.length}/${TIPS_PER_SECTION} mục mới`);
  }
  if (problems.length) result.error = `${problems.join('; ')}. Bấm Làm mới để tạo lại.`;
  return result;
}

// Append today's titles to the history (same key → date updated), newest last, capped per section.
export function recordHistory(history, tips, date) {
  const next = emptyHistory();
  for (const { key } of TIPS_SECTIONS) {
    const entries = new Map((history?.[key] || []).map(entry => [entry.key, entry]));
    for (const item of tips?.[key] || []) { const normalized = normalizeTitle(item.title); if (normalized) entries.set(normalized, { key: normalized, title: item.title, date }); }
    next[key] = [...entries.values()].slice(-HISTORY_MAX_PER_SECTION);
  }
  return next;
}

export const tipsCount = tips => TIPS_SECTIONS.reduce((sum, { key }) => sum + (Array.isArray(tips?.[key]) ? tips[key].length : 0), 0);

// Checks one link: HEAD first, GET when HEAD does not answer 2xx/3xx (some sites, e.g. the VS Code marketplace, return
// 404 or 405 to HEAD but 200 to GET) — 2xx/3xx is "ok", anything else "unverified".
export async function checkLink(url, { fetchImpl = fetch, timeoutMs = LINK_CHECK_TIMEOUT_MS } = {}) {
  const attempt = async method => {
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      // Race the abort too, so a fetch implementation that ignores the signal cannot hang the build.
      const aborted = new Promise((_, reject) => controller.signal.addEventListener('abort', () => reject(new Error('timeout')), { once: true }));
      const response = await Promise.race([fetchImpl(url, { method, redirect: 'follow', signal: controller.signal, headers: { 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36', accept: '*/*' } }), aborted]);
      try { await response.body?.cancel?.(); } catch { /* body not needed */ }
      return response.status;
    } finally { clearTimeout(timer); }
  };
  try {
    let status = await attempt('HEAD');
    if (!(status >= 200 && status < 400)) status = await attempt('GET');
    return status >= 200 && status < 400 ? 'ok' : 'unverified';
  } catch { return 'unverified'; }
}

// Verifies the tool links in place (at most `concurrency` requests at a time). Never throws; returns the counts.
export async function verifyLinks(items, { fetchImpl = fetch, timeoutMs = LINK_CHECK_TIMEOUT_MS, concurrency = LINK_CHECK_CONCURRENCY } = {}) {
  const queue = (items || []).filter(item => item && item.url);
  let index = 0; let ok = 0; let unverified = 0;
  const worker = async () => {
    while (index < queue.length) {
      const item = queue[index++];
      item.linkStatus = await checkLink(item.url, { fetchImpl, timeoutMs });
      if (item.linkStatus === 'ok') ok += 1; else unverified += 1;
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, queue.length)) }, worker));
  return { checked: queue.length, ok, unverified };
}

// Runs Codex once and returns the validated tips. Throws on launch/timeout/JSON errors (the caller records the error).
export async function generateTips({ bulletin, history = emptyHistory(), now = Date.now(), timeoutMs = TIPS_TIMEOUT_MS, codexBin = process.env.CODEX_BIN || 'codex', signal, verify = true, fetchImpl = fetch } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'news-tips-'));
  const schemaFile = join(dir, 'schema.json'); const resultFile = join(dir, 'result.json');
  await writeFile(schemaFile, JSON.stringify(SCHEMA));
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (SECRET_ENV.test(name)) delete env[name];
  try {
    await runCommand('timeout', ['--signal=TERM', '--kill-after=1s', `${Math.ceil(timeoutMs / 1000)}s`, codexBin,
      'exec', '--json', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only', '-c', 'approval_policy="never"', '-c', 'mcp_servers.playwright.enabled=false',
      '-C', dir, '--output-schema', schemaFile, '--output-last-message', resultFile, '-',
    ], { cwd: dir, env, signal, input: tipsPrompt({ date: bulletin?.date, history, bulletin, now }) });
    const parsed = JSON.parse(await readFile(resultFile, 'utf8'));
    const result = parseTipsResult(parsed, { history, now });
    if (verify && result.aiTools.length) result.links = await verifyLinks(result.aiTools, { fetchImpl });
    return result;
  } finally { await rm(dir, { recursive: true, force: true }).catch(() => {}); }
}
