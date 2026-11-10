// Tiền tra (14/10/2026, user order "tối ưu luồng search docs code api app … hiện tại AI đang check ticket khá lâu"):
// before the investigator's first turn, code pulls search keywords out of the ticket (quoted strings, identifiers,
// setting keys, error phrases, the feature named in the subject) and runs ONE multi_search on the app's latest source.
// The result goes into the prompt as data and into tool-log.jsonl (round 0) so quotes and `searched` entries can be
// matched against it. Pure helpers here are unit-tested; the API call is injected.

import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { formatSearch } from './source-api.mjs';

export const DEFAULT_PRE_SEARCH = { enabled: true, maxQueries: 10, maxChars: 3000, timeoutMs: 10000 };

const STOP = new Set(['avada', 'shopify', 'the', 'and', 'for', 'with', 'this', 'that', 'from', 'have', 'not', 'are', 'was', 'but', 'when', 'then', 'please', 'help', 'hello', 'thanks', 'thank', 'customer', 'merchant', 'shop', 'store', 'app', 'ticket', 'issue', 'problem', 'error', 'bug', 'customize', 'question', 'feature', 'request', 'khách', 'muốn', 'không', 'được', 'hiển', 'thị', 'trên', 'trang', 'của', 'cho', 'này', 'khi', 'thì', 'với', 'như', 'cần', 'nhờ', 'check', 'kiểm', 'tra', 'xem', 'giúp', 'lỗi', 'yêu', 'cầu', 'true', 'false', 'null', 'http', 'https', 'www', 'com', 'myshopify', 'shopify', 'admin', 'products', 'collections', 'pages', 'cart', 'checkout']);
const APP_WORDS = /\b(air|reviews?|joy|loyalty|subscriptions?|chatty|wishlist|pdf|invoice|sea|sun|luna|avada|accessibility|cookie|bar|shopvid|order|limit|tracking|survey|booking|email|marketing|estimated|delivery|date|withdrawal|forms?|fraud|filter|age|verification|online|course|affiliate)\b/i;

const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
// Opaque identifiers are useless search terms: session ids, uuid fragments, hashes, shop handles, long base62 ids.
const ID_LIKE = /^(?:session|sess|sid|id|ref|trace|req|order|token|key|uid|cid|gid)[_-]|[0-9a-f]{6,}-[0-9a-f]{3,}|^[0-9a-f]{12,}$|\d{4,}|^(?=.*\d)[A-Za-z0-9]{10,}$|myshopify|\.(com|net|io|au|de|vn|org|co)\b/i;
const stripUrls = value => String(value || '').replace(/https?:\/\/\S+/gi, ' ').replace(/\b[\w.-]+\.(?:com|net|io|au|de|vn|org|co|shop|store)(?:\/\S*)?/gi, ' ');
const normalizeKey = value => clean(value).toLowerCase();

// Keywords, most specific first: quoted strings → code-like identifiers → error phrases → feature phrase of the subject.
export function extractKeywords({ subject = '', description = '', comments = [], settingHint = false } = {}, { maxQueries = 10 } = {}) {
  const text = stripUrls([subject, description, ...(comments || []).slice(0, 5).map(comment => (typeof comment === 'string' ? comment : comment?.content || ''))].join('\n'));
  const out = []; const seen = new Set();
  const push = (value, kind) => {
    const query = clean(value).replace(/^[\s"'“”‘’`]+|[\s"'“”‘’`.,;:!?]+$/g, '');
    if (query.length < 4 || query.length > 60) return;
    const key = normalizeKey(query);
    if (seen.has(key) || STOP.has(key)) return;
    if (/^[\d\s.,-]+$/.test(query)) return; // numbers alone
    if (/^https?:/i.test(query) || /\.(png|jpe?g|gif|webp)$/i.test(query)) return;
    if (kind !== 'quoted' && kind !== 'error' && ID_LIKE.test(query)) return; // opaque ids, hashes, shop handles
    seen.add(key); out.push({ query, kind });
  };
  // 1. Quoted strings: "Only show review star", “Sell in multiples”, 'Save'.
  for (const match of text.matchAll(/["“]([^"“”\n]{4,60})["”]/g)) push(match[1], 'quoted');
  for (const match of text.matchAll(/(?<![\w])'([^'\n]{4,60})'(?![\w])/g)) push(match[1], 'quoted');
  // 2. Identifiers: camelCase, snake_case, dotted keys, CSS classes/ids, kebab-case attribute names.
  for (const match of text.matchAll(/\b[a-z]+(?:[A-Z][a-z0-9]+){1,}(?:\.[A-Za-z][A-Za-z0-9]*)*\b/g)) push(match[0], 'identifier');
  for (const match of text.matchAll(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+){1,}\b/g)) push(match[0], 'identifier');
  for (const match of text.matchAll(/(?<![\w-])[.#][A-Za-z][\w-]{3,}(?:__[\w-]+)?(?![\w-])/g)) if (!/\.(js|css|liquid|json|html|png|jpe?g|webp|svg|md|txt)$/i.test(match[0])) push(match[0].replace(/^[.#]/, ''), 'selector');
  for (const match of text.matchAll(/\b[a-z][a-z0-9]+(?:-[a-z0-9]+){2,}\b/g)) if (!/^(https?|www|myshopify|\d)/.test(match[0]) && !APP_WORDS.test(match[0])) push(match[0], 'identifier');
  // 3. Error phrases: "Something went wrong …", "failed to load …", "could not …".
  for (const match of text.matchAll(/\b((?:something went wrong|failed to [a-z]+|could not [a-z]+|cannot [a-z]+|unable to [a-z]+|not found|is not defined|undefined is not|permission denied|invalid [a-z]+)[^.\n"”]{0,40})/gi)) push(match[1], 'error');
  // 4. Feature phrase from the subject: strip [tags] and the app name, keep up to 5 words.
  const feature = clean(String(subject || '').replace(/\[[^\]]*\]/g, ' ').split(/\s[-–—:|]\s/).pop() || '').split(' ').filter(word => word.length >= 3 && !STOP.has(word.toLowerCase()) && !APP_WORDS.test(word)).slice(0, 5).join(' ');
  if (feature.split(' ').length >= 1) push(feature, 'feature');
  // 5. Settings-looking ticket: single capitalised UI words from the subject too (e.g. "Recycle bin").
  if (settingHint) for (const match of String(subject || '').matchAll(/\b([A-Z][a-z]+(?: [A-Z]?[a-z]+){1,3})\b/g)) if (!APP_WORDS.test(match[1])) push(match[1], 'label');
  const order = { quoted: 0, identifier: 1, selector: 1, error: 2, label: 3, feature: 4 };
  return out.sort((a, b) => order[a.kind] - order[b.kind]).slice(0, Math.max(1, Math.min(10, maxQueries))).map(item => item.query);
}

// Runs the one multi_search and appends a round-0 entry to the job's tool log. `api` is a createSourceApi() client.
// Returns null when there is nothing to search or the setting is off; errors are returned, never thrown.
export async function preSearch({ ticket, app, settingHint = false, api, jobDir, settings = {}, now = () => Date.now() }) {
  const config = { ...DEFAULT_PRE_SEARCH, ...(settings || {}) };
  if (config.enabled === false || !api || !app) return null;
  const queries = extractKeywords({ subject: ticket?.subject, description: ticket?.description, comments: ticket?.comments, settingHint }, { maxQueries: config.maxQueries });
  if (!queries.length) return { queries: [], output: null, ok: false, reason: 'không rút được từ khóa', ms: 0 };
  const started = now();
  let output = null; let ok = false; let reason = null; let files = [];
  try {
    const result = await Promise.race([
      api.search({ app, queries, max: 30 }),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`quá ${Math.round(config.timeoutMs / 1000)} giây`)), config.timeoutMs)),
    ]);
    output = formatSearch(result, { max: 30, perFile: 4 });
    const counts = new Map();
    for (const match of result.matches) counts.set(match.path, (counts.get(match.path) || 0) + 1);
    files = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([path, count]) => ({ path, count }));
    ok = true;
  } catch (error) { reason = String(error?.message || error).slice(0, 200); }
  const ms = now() - started;
  if (jobDir) {
    try {
      mkdirSync(jobDir, { recursive: true, mode: 0o700 });
      appendFileSync(join(jobDir, 'tool-log.jsonl'), JSON.stringify({ seq: 0, round: 0, at: new Date().toISOString(), tool: 'source_search', args: { app, queries, preSearch: true }, ok, ms, output: ok ? output.slice(0, 30_000) : `tiền tra lỗi: ${reason}` }) + '\n', { mode: 0o600 });
    } catch { /* logging must not break prepare */ }
  }
  return { queries, output: ok ? output.slice(0, config.maxChars) : null, ok, reason, ms, files, truncated: ok && output.length > config.maxChars };
}
