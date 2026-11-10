// NEWS: fetches the configured sources (scripts/news-sources.json), parses them with small built-in parsers
// (RSS/Atom, Hacker News API, the Anthropic news page, the Claude Code changelog), normalizes the items and builds
// the day's bulletin: at most `maxItems` items in three groups — Claude, new AI models, technology.
// Pure functions are exported for tests; only fetchSource() touches the network.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const SOURCES_FILE = resolve(ROOT, 'scripts/news-sources.json');
export const GROUPS = ['claude', 'models', 'tech'];
export const GROUP_LABELS = { claude: 'Claude', models: 'Model AI mới', tech: 'Công nghệ' };
const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';
const FETCH_TIMEOUT_MS = 20_000;
const MAX_DESCRIPTION = 300;
const MAX_TITLE = 200;

export async function loadSources(file = SOURCES_FILE) {
  const config = JSON.parse(await readFile(file, 'utf8'));
  return { windowHours: Number(config.windowHours) || 48, maxItems: Number(config.maxItems) || 15, perGroup: Number(config.perGroup) || 5, sources: (config.sources || []).filter(source => source && source.id && source.url) };
}

// --- text helpers ------------------------------------------------------------
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#8217': '’', '#8216': '‘', '#8220': '“', '#8221': '”', '#8211': '–', '#8212': '—', '#8230': '…', '#039': "'" };
export function decodeEntities(text) {
  return String(text || '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code) => {
    if (ENTITIES[code] !== undefined) return ENTITIES[code];
    if (/^#x/i.test(code)) return String.fromCodePoint(parseInt(code.slice(2), 16));
    if (/^#\d+$/.test(code)) return String.fromCodePoint(Number(code.slice(1)));
    return match;
  });
}
export const stripTags = html => decodeEntities(String(html || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
const clip = (text, max) => { const value = String(text || '').trim(); return value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value; };
const isoOrNull = value => { const ms = Date.parse(String(value || '')); return Number.isFinite(ms) ? new Date(ms).toISOString() : null; };
const tag = (xml, name) => { const match = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, 'i').exec(xml); return match ? match[1] : ''; };
const attr = (xml, name, attribute) => { const match = new RegExp(`<${name}\\b[^>]*\\b${attribute}="([^"]*)"[^>]*\\/?>`, 'i').exec(xml); return match ? decodeEntities(match[1]) : ''; };

export function itemId(url, title) {
  return createHash('sha1').update(String(url || title || '').trim().toLowerCase()).digest('hex').slice(0, 12);
}

// A normalized item: { id, title, url, source, sourceLabel, group, publishedAt, description, summary }
export function normalizeItem(raw, source) {
  const title = clip(stripTags(raw.title), MAX_TITLE);
  const url = String(raw.url || '').trim();
  if (!title || !/^https?:\/\//i.test(url)) return null;
  return {
    id: itemId(url, title), title, url, source: source.id, sourceLabel: source.label || source.id, group: source.group || 'tech',
    publishedAt: isoOrNull(raw.publishedAt), description: clip(stripTags(raw.description), MAX_DESCRIPTION), summary: '',
    ...(raw.extra ? { extra: raw.extra } : {}),
  };
}

// --- parsers ---------------------------------------------------------------
// RSS 2.0 <item> and Atom <entry>.
export function parseRss(xml) {
  const text = String(xml || '');
  const blocks = text.match(/<item\b[\s\S]*?<\/item>/gi) || text.match(/<entry\b[\s\S]*?<\/entry>/gi) || [];
  return blocks.map(block => {
    const link = tag(block, 'link').trim() || attr(block, 'link', 'href') || tag(block, 'guid').trim();
    return {
      title: tag(block, 'title'), url: stripTags(link),
      publishedAt: stripTags(tag(block, 'pubDate') || tag(block, 'published') || tag(block, 'updated') || tag(block, 'dc:date')),
      description: tag(block, 'description') || tag(block, 'summary') || tag(block, 'content:encoded') || tag(block, 'content'),
    };
  });
}

// Hacker News Algolia search response; keeps stories whose title mentions one of the keywords.
export function parseHackerNews(json, keywords = []) {
  const data = typeof json === 'string' ? JSON.parse(json) : json;
  const words = keywords.map(word => String(word).toLowerCase()).filter(Boolean);
  return (data?.hits || []).filter(hit => hit?.title && hit.url).filter(hit => !words.length || words.some(word => ` ${hit.title.toLowerCase()} `.includes(` ${word} `) || hit.title.toLowerCase().includes(word.length > 4 ? word : `${word} `)))
    .map(hit => ({ title: hit.title, url: hit.url, publishedAt: hit.created_at, description: `${hit.points || 0} điểm · ${hit.num_comments || 0} bình luận trên Hacker News`, extra: { points: hit.points || 0, comments: hit.num_comments || 0, hnUrl: `https://news.ycombinator.com/item?id=${hit.objectID}` } }));
}

// anthropic.com/news: cards link to /news/<slug>; the card text holds the title and a "Mon D, YYYY" date.
export function parseAnthropicNews(html) {
  const text = String(html || '');
  const seen = new Set(); const items = [];
  const re = /<a\b[^>]*href="(\/news\/[a-z0-9-]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = re.exec(text))) {
    const path = match[1]; if (seen.has(path)) continue;
    const inner = stripTags(match[2]);
    const date = /([A-Z][a-z]{2} \d{1,2}, \d{4})/.exec(stripTags(tag(match[2], 'time')) || inner);
    const titleSpan = /<span\b[^>]*class="[^"]*__title[^"]*"[^>]*>([\s\S]*?)<\/span>/i.exec(match[2]);
    const title = (titleSpan ? stripTags(titleSpan[1]) : inner.replace(date ? date[1] : '', '')).replace(/^(Announcements|Product|Policy|Research|Interpretability|Alignment|Societal Impacts|Education|Economic Research|Case Study|Event|Customer story|News)\b\s*/i, '').trim();
    if (title.length < 8) continue;
    seen.add(path);
    items.push({ title, url: `https://www.anthropic.com${path}`, publishedAt: date ? `${date[1]} 12:00:00 UTC` : null, description: '' });
  }
  return items;
}

// Claude Code CHANGELOG.md: "## <version>" followed by bullets. Returns one item per version, newest first.
export function parseChangelog(markdown, { maxBullets = 5 } = {}) {
  const sections = String(markdown || '').split(/^## +/m).slice(1);
  return sections.map(section => {
    const [head, ...rest] = section.split('\n');
    const version = head.trim();
    const bullets = rest.map(line => line.trim()).filter(line => /^[-*] /.test(line)).map(line => line.replace(/^[-*] /, '').replace(/`/g, ''));
    if (!/^\d+\.\d+/.test(version) || !bullets.length) return null;
    return { title: `Claude Code ${version}`, url: `https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md#${version.replace(/\./g, '')}`, publishedAt: null, description: bullets.slice(0, maxBullets).join(' · '), extra: { version, bullets: bullets.slice(0, maxBullets), bulletCount: bullets.length } };
  }).filter(Boolean);
}

export function parseSource(source, body, { lastSeenVersion = '' } = {}) {
  if (source.type === 'rss') return parseRss(body);
  if (source.type === 'hn') return parseHackerNews(body, source.keywords || []);
  if (source.type === 'html-anthropic') return parseAnthropicNews(body);
  if (source.type === 'changelog') {
    const versions = parseChangelog(body);
    const fresh = lastSeenVersion ? versions.filter(item => compareVersions(item.extra.version, lastSeenVersion) > 0) : versions.slice(0, 1);
    return fresh.map(item => ({ ...item, publishedAt: new Date().toISOString() }));
  }
  throw new Error(`Unknown source type: ${source.type}`);
}

export function compareVersions(left, right) {
  const a = String(left).split('.').map(Number); const b = String(right).split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) { const diff = (a[i] || 0) - (b[i] || 0); if (diff) return diff; }
  return 0;
}

// --- classification + bulletin ------------------------------------------------
const CLAUDE_RE = /\b(claude|anthropic|opus \d|sonnet \d|haiku \d)\b/i;
const MODELS_RE = /\b(model|models|llm|gpt-?\d|gpt|gemini|llama|mistral|deepseek|qwen|grok|open[- ]weight|openai|chatgpt|sora|o\d\b|benchmark|reasoning model|foundation model|frontier)\b/i;
export function classify(item) {
  const text = `${item.title} ${item.description}`;
  if (CLAUDE_RE.test(text)) return 'claude';
  if (item.group === 'claude') return 'claude';
  if (MODELS_RE.test(text)) return 'models';
  return item.group === 'models' ? 'models' : 'tech';
}

// itemsBySource: [{ source, items (raw) }] → { groups, sources } for one day.
export function buildBulletin(results, { date, now = Date.now(), windowHours = 48, maxItems = 15, perGroup = 5, lastSeenVersion = '' } = {}) {
  const seenUrls = new Set(); const seenTitles = new Set(); const all = [];
  const sources = [];
  let newestVersion = lastSeenVersion;
  for (const result of results) {
    const source = result.source;
    // A source may keep older items (Anthropic publishes a few times a month) through its own windowHours.
    const since = now - (Number(source.windowHours) || windowHours) * 3_600_000;
    const normalized = (result.items || []).map(raw => normalizeItem(raw, source)).filter(Boolean)
      .filter(item => source.type === 'changelog' || !item.publishedAt || Date.parse(item.publishedAt) >= since)
      .sort((left, right) => String(right.publishedAt || '').localeCompare(String(left.publishedAt || '')))
      .slice(0, Number(source.max) || 6);
    for (const item of normalized) {
      const urlKey = item.url.replace(/[?#].*$/, '').replace(/\/$/, '').toLowerCase(); const titleKey = item.title.toLowerCase().replace(/[^a-z0-9à-ỹ]+/gi, ' ').trim();
      if (seenUrls.has(urlKey) || seenTitles.has(titleKey)) continue;
      seenUrls.add(urlKey); seenTitles.add(titleKey);
      all.push({ ...item, group: classify(item) });
      if (source.type === 'changelog' && item.extra?.version && compareVersions(item.extra.version, newestVersion || '0') > 0) newestVersion = item.extra.version;
    }
    sources.push({ id: source.id, label: source.label || source.id, ok: !result.error, count: normalized.length, ...(result.error ? { error: String(result.error) } : {}) });
  }
  const byTime = (left, right) => String(right.publishedAt || '').localeCompare(String(left.publishedAt || ''));
  const groups = Object.fromEntries(GROUPS.map(group => [group, all.filter(item => item.group === group).sort(byTime)]));
  // Fill each group up to perGroup first, then hand the remaining slots to the groups with more news.
  const picked = Object.fromEntries(GROUPS.map(group => [group, groups[group].slice(0, perGroup)]));
  let total = GROUPS.reduce((sum, group) => sum + picked[group].length, 0);
  for (const group of GROUPS) { while (total < maxItems && picked[group].length < groups[group].length) { picked[group].push(groups[group][picked[group].length]); total += 1; } }
  return { date, builtAt: new Date(now).toISOString(), summarized: false, groups: picked, sources, lastSeenVersion: newestVersion || '', total };
}

// --- network -----------------------------------------------------------------
export async function fetchSource(source, { fetchImpl = globalThis.fetch, timeoutMs = FETCH_TIMEOUT_MS, lastSeenVersion = '' } = {}) {
  try {
    const response = await fetchImpl(source.url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, application/json, text/html;q=0.9, */*;q=0.8' }, redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.text();
    return { source, items: parseSource(source, body, { lastSeenVersion }) };
  } catch (error) {
    return { source, items: [], error: error?.name === 'TimeoutError' ? `timeout sau ${Math.round(timeoutMs / 1000)}s` : (error?.message || String(error)) };
  }
}

export async function fetchAll(config, options = {}) {
  const enabled = config.sources.filter(source => source.enabled !== false);
  return Promise.all(enabled.map(source => fetchSource(source, options)));
}
