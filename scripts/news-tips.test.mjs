// node --test scripts/news-tips.test.mjs — NEWS tips sections: prompt, validation, repeat window and history (no network, no Codex).
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTitle, tipsPrompt, parseTipsResult, recordHistory, recentEntries, emptyHistory, tipsCount, checkLink, verifyLinks, TIPS_SECTIONS, TIPS_PER_SECTION, TIPS_REPEAT_AFTER_DAYS, TOOL_KINDS } from './news-tips.mjs';

const NOW = Date.parse('2026-10-13T01:00:00Z');
const items = (prefix, n, extra = {}) => Array.from({ length: n }, (_, i) => ({ title: `${prefix} ${i + 1}`, body: `Cách làm ${i + 1}.`, url: '', tool: '', ...extra }));
const history = {
  version: 1,
  aiTips: [{ key: normalizeTitle('Mẹo cũ gần đây'), title: 'Mẹo cũ gần đây', date: '2026-10-10' }, { key: normalizeTitle('Mẹo rất cũ'), title: 'Mẹo rất cũ', date: '2026-07-01' }],
  toolFeatures: [{ key: normalizeTitle('Claude Code: /compact'), title: 'Claude Code: /compact', date: '2026-10-12' }],
  aiTools: [{ key: normalizeTitle('Playwright MCP'), title: 'Playwright MCP', date: '2026-10-12' }],
};
const tools = (n, offset = 0) => Array.from({ length: n }, (_, i) => ({ title: `Tool ${i + 1 + offset}`, body: `Làm việc ${i + 1}.`, url: `https://github.com/org/tool-${i + 1 + offset}`, tool: '', kind: 'cli' }));

test('titles are compared without diacritics, case or punctuation', () => {
  assert.equal(normalizeTitle('Mẹo: Đừng tin AI 100%!'), 'meo dung tin ai 100');
  assert.equal(normalizeTitle('  Claude Code — /compact  '), 'claude code compact');
  assert.equal(TIPS_SECTIONS.map(s => s.key).join(','), 'aiTips,toolFeatures,aiTools');
  assert.equal(TOOL_KINDS.mcp, 'MCP server');
  assert.equal(TIPS_PER_SECTION, 10);
});

test('the prompt lists only titles used within the repeat window and carries the Claude Code context', () => {
  const bulletin = { date: '2026-10-13', lastSeenVersion: '2.1.296', groups: { claude: [
    { title: 'Claude Code 2.1.296', url: 'https://example.test/changelog', source: 'claude-code-changelog', extra: { bullets: ['Added /foo', 'Fixed bar'] } },
    { title: 'Anthropic news item', source: 'anthropic-news' },
  ] } };
  const prompt = tipsPrompt({ date: '2026-10-13', history, bulletin, now: NOW });
  assert.match(prompt, /Mẹo cũ gần đây/);
  assert.doesNotMatch(prompt, /Mẹo rất cũ/, `older than ${TIPS_REPEAT_AFTER_DAYS} days may come back`);
  assert.match(prompt, /Claude Code: \/compact/); assert.match(prompt, /aiTools đã dùng: Playwright MCP/); assert.match(prompt, /MỤC 3 "aiTools"/);
  assert.match(prompt, /2\.1\.296/); assert.match(prompt, /Added \/foo/); assert.match(prompt, /Anthropic news item/);
  assert.match(prompt, /đúng 10 phần tử/);
  assert.equal(recentEntries(history, 'aiTips', { now: NOW }).length, 1);
  assert.match(tipsPrompt({ date: '2026-10-13', now: NOW }), /\(chưa có\)/);
});

test('parseTipsResult keeps 10 clean items per section, drops repeats and non-official links, notes shortfalls', () => {
  const parsed = {
    aiTips: [
      { title: 'Mẹo cũ gần đây', body: 'trùng lịch sử' }, { title: 'Mẹo rất cũ', body: 'cũ đủ lâu, được dùng lại' },
      { title: '', body: 'không tiêu đề' }, { title: 'Không có body', body: '' },
      ...items('Mẹo mới', 9), { title: 'mẹo mới 1', body: 'trùng trong ngày' }, { title: 'Mẹo thừa', body: 'quá 10' },
    ],
    toolFeatures: [
      { title: 'Claude Code: hooks', body: 'Chạy lệnh trước/sau tool.', url: 'https://docs.anthropic.com/en/docs/claude-code/hooks', tool: 'Claude' },
      { title: 'Codex: codex exec', body: 'Chạy không tương tác.', url: 'http://developers.openai.com/codex', tool: 'codex' },
      { title: 'Codex: sandbox', body: 'Giới hạn ghi.', url: 'https://random.blog/x', tool: 'weird' },
      ...items('Tính năng', 7, { tool: 'both' }),
    ],
    aiTools: [
      { title: 'Playwright MCP', body: 'trùng lịch sử', url: 'https://github.com/microsoft/playwright-mcp', kind: 'mcp' },
      { title: 'Không có link', body: 'bị bỏ', url: '', kind: 'cli' },
      { title: 'Link http', body: 'bị bỏ', url: 'http://example.com/x', kind: 'cli' },
      { title: 'Link hỏng', body: 'bị bỏ', url: 'not a url', kind: 'cli' },
      { title: 'Chrome DevTools MCP', body: 'Cho AI điều khiển Chrome.', url: 'https://github.com/ChromeDevTools/chrome-devtools-mcp', kind: 'MCP' },
      { title: 'Loại lạ', body: 'kind không hợp lệ → other', url: 'https://example.com/', kind: 'weird' },
      ...tools(9, 10),
    ],
  };
  const result = parseTipsResult(parsed, { history, now: NOW });
  assert.equal(result.aiTips.length, 10);
  assert.equal(result.aiTips[0].title, 'Mẹo rất cũ');
  assert.ok(!result.aiTips.some(item => item.title === 'Mẹo cũ gần đây' || item.title === 'Mẹo thừa' || item.title === 'mẹo mới 1'));
  assert.equal(result.toolFeatures.length, 10);
  assert.equal(result.toolFeatures[0].tool, 'claude'); assert.equal(result.toolFeatures[0].url, 'https://docs.anthropic.com/en/docs/claude-code/hooks');
  assert.equal(result.toolFeatures[1].url, '', 'http link dropped'); assert.equal(result.toolFeatures[2].url, '', 'unknown host dropped'); assert.equal(result.toolFeatures[2].tool, '');
  assert.equal(result.aiTools.length, 10);
  assert.equal(result.aiTools[0].title, 'Chrome DevTools MCP'); assert.equal(result.aiTools[0].kind, 'mcp'); assert.equal(result.aiTools[0].linkStatus, 'unchecked');
  assert.equal(result.aiTools[1].kind, 'other');
  assert.ok(!result.aiTools.some(item => /Playwright MCP|Không có link|Link http|Link hỏng|Tool 19/.test(item.title)));
  assert.equal(result.error, '');
  assert.equal(tipsCount(result), 30);

  const short = parseTipsResult({ aiTips: items('A', 4), toolFeatures: [] }, { history: emptyHistory(), now: NOW });
  assert.equal(short.aiTips.length, 4);
  assert.match(short.error, /"10 mẹo dùng AI" chỉ có 4\/10/); assert.match(short.error, /"10 tính năng hay của Claude và Codex" chỉ có 0\/10/); assert.match(short.error, /"10 tool\/extension hay dùng với AI" chỉ có 0\/10/); assert.match(short.error, /Làm mới/);
  assert.equal(parseTipsResult(null, { now: NOW }).aiTips.length, 0);
});

test('recordHistory adds today\'s titles once, refreshes the date of a repeated key and keeps older entries', () => {
  const tips = { aiTips: [{ title: 'Mẹo rất cũ', body: 'x' }, { title: 'Mẹo hoàn toàn mới', body: 'y' }], toolFeatures: [] };
  const next = recordHistory(history, tips, '2026-10-13');
  assert.equal(next.aiTips.length, 3);
  assert.equal(next.aiTips.find(entry => entry.title === 'Mẹo rất cũ').date, '2026-10-13');
  assert.equal(next.aiTips.at(-1).title, 'Mẹo hoàn toàn mới');
  assert.equal(next.toolFeatures.length, 1, 'untouched section kept'); assert.equal(next.aiTools.length, 1);
  const withTools = recordHistory(next, { aiTools: tools(2) }, '2026-10-13');
  assert.equal(withTools.aiTools.length, 3);
  assert.equal(parseTipsResult({ aiTools: tools(2) }, { history: withTools, now: NOW }).aiTools.length, 0, 'tool titles are remembered too');
  assert.deepEqual(recordHistory(null, { aiTips: [], toolFeatures: [] }, '2026-10-13'), emptyHistory());
  // After recording, the same title is excluded again by parseTipsResult.
  assert.equal(parseTipsResult({ aiTips: [{ title: 'Mẹo hoàn toàn mới', body: 'z' }], toolFeatures: [] }, { history: next, now: NOW }).aiTips.length, 0);
});

test('verifyLinks marks 2xx/3xx links ok, retries HEAD refusals with GET, and never throws on dead links', async () => {
  const calls = [];
  const fetchImpl = async (url, { method }) => {
    calls.push(`${method} ${url}`);
    const response = status => ({ status, body: { cancel: async () => {} } });
    if (url.includes('/ok')) return response(200);
    if (url.includes('/redirect')) return response(301);
    if (url.includes('/head-refused')) return method === 'HEAD' ? response(405) : response(200);
    if (url.includes('/head-404')) return method === 'HEAD' ? response(404) : response(200);
    if (url.includes('/forbidden')) return response(403);
    if (url.includes('/missing')) return response(404);
    throw new Error('ECONNRESET');
  };
  const items = [
    { title: 'A', url: 'https://x.test/ok' }, { title: 'B', url: 'https://x.test/redirect' }, { title: 'C', url: 'https://x.test/head-refused' },
    { title: 'D', url: 'https://x.test/forbidden' }, { title: 'E', url: 'https://x.test/missing' }, { title: 'F', url: 'https://x.test/down' }, { title: 'G', url: '' }, { title: 'H', url: 'https://x.test/head-404' },
  ];
  const summary = await verifyLinks(items, { fetchImpl, concurrency: 3, timeoutMs: 1000 });
  assert.deepEqual(items.map(item => item.linkStatus || null), ['ok', 'ok', 'ok', 'unverified', 'unverified', 'unverified', null, 'ok']);
  assert.deepEqual(summary, { checked: 7, ok: 4, unverified: 3 });
  assert.ok(calls.includes('GET https://x.test/head-refused') && calls.includes('GET https://x.test/forbidden') && calls.includes('GET https://x.test/head-404'), 'a HEAD that is not 2xx/3xx falls back to GET');
  assert.ok(!calls.includes('GET https://x.test/ok'), 'a good HEAD needs no GET');
  assert.equal(await checkLink('https://x.test/ok', { fetchImpl }), 'ok');
  const slow = () => new Promise(() => {});
  assert.equal(await checkLink('https://x.test/slow', { fetchImpl: slow, timeoutMs: 20 }), 'unverified', 'timeout → unverified');
  assert.deepEqual(await verifyLinks([], { fetchImpl }), { checked: 0, ok: 0, unverified: 0 });
});
