// node --test scripts/news-feed.test.mjs — NEWS parsers, classification and bulletin building on sample data (no network).
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRss, parseHackerNews, parseAnthropicNews, parseChangelog, parseSource, classify, buildBulletin, normalizeItem, decodeEntities, compareVersions, fetchSource } from './news-feed.mjs';

const NOW = Date.parse('2026-10-06T03:00:00Z');
const RSS = `<?xml version="1.0"?><rss><channel><item><title>OpenAI will start watermarking ChatGPT&#8217;s text in the EU</title><link>https://techcrunch.com/2026/10/05/openai-watermark/</link><pubDate>Mon, 05 Oct 2026 20:36:48 +0000</pubDate><description><![CDATA[OpenAI will watermark <b>ChatGPT</b> text in the EU.]]></description></item>
<item><title>Old story</title><link>https://techcrunch.com/2026/09/01/old/</link><pubDate>Tue, 01 Sep 2026 10:00:00 +0000</pubDate><description>Too old.</description></item></channel></rss>`;
const ATOM = `<feed xmlns="http://www.w3.org/2005/Atom"><entry><title type="html"><![CDATA[Gemini Call for Me might tell your mom you&#8217;re late]]></title><link rel="alternate" type="text/html" href="https://www.theverge.com/ai/1005177/gemini-call" /><id>https://www.theverge.com/?p=1005177</id><published>2026-10-05T19:09:55-04:00</published><summary type="html"><![CDATA[Google may be expanding its "Call for Me" AI feature.]]></summary></entry></feed>`;
const HN = { hits: [
  { title: 'Reflection debuts Beam, an open-weight model', url: 'https://example.com/beam', points: 120, num_comments: 40, created_at: '2026-10-05T19:33:53Z', objectID: '1' },
  { title: 'Show HN: A faster grep', url: 'https://example.com/grep', points: 90, num_comments: 10, created_at: '2026-10-05T18:00:00Z', objectID: '2' },
  { title: 'Ask HN: no url', points: 500, created_at: '2026-10-05T18:00:00Z', objectID: '3' },
] };
const ANTHROPIC = `<div><a href="/news/claude-frontier-academy" class="x__listItem"><div class="x__meta"><time class="x__date">Oct 2, 2026</time><span class="x__subject">Announcements</span></div><span class="x__title body-3">Introducing Claude Frontier Academy</span></a><a href="/news/claude-frontier-academy">dup</a><a href="/news/enterprise-frontier-safeguards"><span>Product</span><span>Enterprise frontier safeguards for Claude</span><span>Oct 1, 2026</span></a></div>`;
const CHANGELOG = `# Changelog\n\n## 2.1.291\n\n- Fixed a regression in 2.1.290 where cloud sessions could drop answers\n- Fixed the last messages of a session being lost\n\n## 2.1.290\n\n- Added \`serverToolUses\` to the result of a mod's hook\n- Added \`agentId\` to the tool.check event\n- Added \`ceiling\`\n- Added ThemeKey\n- Added validate\n- Added Deny button\n- Fixed proxies\n`;
const source = (id, type, group, extra = {}) => ({ id, label: id, type, group, url: `https://${id}.test/`, max: 6, ...extra });

test('RSS 2.0 and Atom feeds are parsed into title, link, date and description', () => {
  const rss = parseRss(RSS);
  assert.equal(rss.length, 2);
  assert.equal(rss[0].url, 'https://techcrunch.com/2026/10/05/openai-watermark/');
  assert.equal(normalizeItem(rss[0], source('tc', 'rss', 'models')).title, 'OpenAI will start watermarking ChatGPT’s text in the EU');
  assert.equal(normalizeItem(rss[0], source('tc', 'rss', 'models')).description, 'OpenAI will watermark ChatGPT text in the EU.');
  const atom = parseRss(ATOM);
  assert.equal(atom.length, 1);
  assert.equal(atom[0].url, 'https://www.theverge.com/ai/1005177/gemini-call');
  assert.equal(normalizeItem(atom[0], source('verge', 'rss', 'models')).publishedAt, '2026-10-05T23:09:55.000Z');
  assert.equal(decodeEntities('a &amp; b &#8212; c &lt;d&gt;'), 'a & b — c <d>');
});

test('Hacker News stories are filtered by keyword and need a URL', () => {
  const items = parseHackerNews(HN, ['model', 'llm']);
  assert.deepEqual(items.map(item => item.title), ['Reflection debuts Beam, an open-weight model']);
  assert.equal(items[0].extra.hnUrl, 'https://news.ycombinator.com/item?id=1');
  assert.equal(parseHackerNews(HN, []).length, 2, 'no keywords keeps every story with a URL');
});

test('the Anthropic news page yields one item per article with its date', () => {
  const items = parseAnthropicNews(ANTHROPIC);
  assert.equal(items.length, 2);
  assert.equal(items[0].title, 'Introducing Claude Frontier Academy');
  assert.equal(items[0].url, 'https://www.anthropic.com/news/claude-frontier-academy');
  assert.equal(normalizeItem(items[0], source('anthropic', 'html-anthropic', 'claude')).publishedAt, '2026-10-02T12:00:00.000Z');
  assert.equal(items[1].title, 'Enterprise frontier safeguards for Claude');
});

test('the Claude Code changelog gives one item per version; only versions newer than the last seen one are new', () => {
  const versions = parseChangelog(CHANGELOG);
  assert.equal(versions.length, 2);
  assert.equal(versions[0].title, 'Claude Code 2.1.291');
  assert.equal(versions[1].extra.bullets.length, 5); assert.equal(versions[1].extra.bulletCount, 7);
  assert.equal(parseSource(source('cc', 'changelog', 'claude'), CHANGELOG, { lastSeenVersion: '2.1.290' }).length, 1);
  assert.equal(parseSource(source('cc', 'changelog', 'claude'), CHANGELOG, { lastSeenVersion: '2.1.291' }).length, 0);
  assert.equal(parseSource(source('cc', 'changelog', 'claude'), CHANGELOG, {}).length, 1, 'first run: latest version only');
  assert.ok(compareVersions('2.1.291', '2.1.29') > 0);
});

test('items are grouped: Claude/Anthropic first, then model news, else technology', () => {
  const make = (title, group = 'tech', description = '') => ({ title, description, group });
  assert.equal(classify(make('Barclays scales Claude across teams')), 'claude');
  assert.equal(classify(make('Reflection debuts Beam, an open-weight model')), 'models');
  assert.equal(classify(make('A faster grep', 'tech')), 'tech');
  assert.equal(classify(make('Gemini Call for Me', 'models')), 'models');
  assert.equal(classify(make('Something from Anthropic blog', 'claude')), 'claude');
});

test('buildBulletin keeps the 48-hour window, removes duplicates, fills groups and records source errors', () => {
  const tc = source('techcrunch', 'rss', 'models'); const verge = source('verge', 'rss', 'models'); const hn = source('hn', 'hn', 'tech', { keywords: ['model'] }); const cc = source('cc', 'changelog', 'claude'); const broken = source('broken', 'rss', 'tech');
  const results = [
    { source: tc, items: parseRss(RSS) }, { source: verge, items: parseRss(ATOM) },
    { source: verge, items: [{ title: 'OpenAI will start watermarking ChatGPT’s text in the EU', url: 'https://techcrunch.com/2026/10/05/openai-watermark/?utm=x', publishedAt: '2026-10-05T21:00:00Z' }] },
    { source: hn, items: parseHackerNews(HN, ['model']) }, { source: cc, items: parseSource(cc, CHANGELOG, {}) },
    { source: broken, items: [], error: 'HTTP 503' },
  ];
  const bulletin = buildBulletin(results, { date: '2026-10-06', now: NOW, windowHours: 48, maxItems: 15, perGroup: 5 });
  const titles = Object.values(bulletin.groups).flat().map(item => item.title);
  assert.ok(!titles.includes('Old story'), 'older than 48h dropped');
  assert.equal(titles.filter(title => title.startsWith('OpenAI will start')).length, 1, 'duplicate url (query string) dropped');
  assert.deepEqual(bulletin.groups.claude.map(item => item.title), ['Claude Code 2.1.291']);
  assert.equal(bulletin.lastSeenVersion, '2.1.291');
  assert.ok(bulletin.groups.models.length >= 2);
  assert.deepEqual(bulletin.sources.find(item => item.id === 'broken'), { id: 'broken', label: 'broken', ok: false, count: 0, error: 'HTTP 503' });
  assert.equal(bulletin.total, Object.values(bulletin.groups).flat().length);
  assert.equal(bulletin.summarized, false);
});

test('maxItems caps the bulletin and spare slots go to groups with more news', () => {
  const many = source('many', 'rss', 'tech', { max: 50 });
  const items = Array.from({ length: 20 }, (_, i) => ({ title: `Tech story ${i}`, url: `https://many.test/${i}`, publishedAt: '2026-10-05T20:00:00Z' }));
  const bulletin = buildBulletin([{ source: many, items }], { date: '2026-10-06', now: NOW, maxItems: 8, perGroup: 3 });
  assert.equal(bulletin.total, 8); assert.equal(bulletin.groups.tech.length, 8);
});

test('a source may widen the time window for itself (Anthropic posts a few times a month)', () => {
  const anthropic = source('anthropic', 'html-anthropic', 'claude', { windowHours: 336 });
  const items = parseAnthropicNews(ANTHROPIC);
  const narrow = buildBulletin([{ source: { ...anthropic, windowHours: undefined }, items }], { date: '2026-10-06', now: NOW, windowHours: 48 });
  const wide = buildBulletin([{ source: anthropic, items }], { date: '2026-10-06', now: NOW, windowHours: 48 });
  assert.equal(narrow.total, 0); assert.equal(wide.total, 2);
  assert.equal(classify({ title: 'Opus 5.5 agents discover two semiconductors', description: '', group: 'tech' }), 'claude');
});

test('fetchSource never throws: a failing source becomes an error entry', async () => {
  const failing = await fetchSource(source('x', 'rss', 'tech'), { fetchImpl: async () => ({ ok: false, status: 503 }) });
  assert.equal(failing.items.length, 0); assert.equal(failing.error, 'HTTP 503');
  const ok = await fetchSource(source('y', 'rss', 'tech'), { fetchImpl: async () => ({ ok: true, status: 200, text: async () => RSS }) });
  assert.equal(ok.items.length, 2); assert.equal(ok.error, undefined);
});
