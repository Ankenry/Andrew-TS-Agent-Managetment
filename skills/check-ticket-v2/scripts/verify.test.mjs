// node --test skills/check-ticket-v2/scripts/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { quoteFound, scoreQuote, verifyLink, checkGap, verifyFindings, mergeFindings, searchMatched, stripLineNumbers, SCORES } from './verify.mjs';
import { validateFindings } from './schema.mjs';

const FILES = {
  'apps_doc/joy/packages/scripttag/RedeemCartAdapter.js': `const selector = settings.cartDrawerRedeemInline || 'cart-drawer';\nif (!document.querySelector(selector)) return null; // no drawer, nothing to mount\n`,
  'knowledge-base/knowledge/joy/on-site-content_cart-drawer.md': `# Cart drawer\n\nHide block when customer doesn't have enough points hides it until the cart meets the minimum.\n`,
};
const toolLog = [
  { tool: 'rg_search', args: { query: 'cartDrawerRedeemInline', app: 'joy' }, output: "apps_doc/joy/packages/scripttag/RedeemCartAdapter.js:1: const selector = settings.cartDrawerRedeemInline || 'cart-drawer';" },
  { tool: 'read_file', args: { path: 'apps_doc/joy/packages/scripttag/RedeemCartAdapter.js', lines: '1-40' }, output: FILES['apps_doc/joy/packages/scripttag/RedeemCartAdapter.js'] },
  { tool: 'browser_check', args: { url: 'https://example.myshopify.com/' }, output: 'title: Example store\nselector joy-redeem-cart: 0 elements\nconsole errors: none' },
];
const ctx = { readSource: ref => FILES[ref] ?? null, ticketText: 'Khách báo: khối redeem không hiện trong cart drawer do khách tự tùy chỉnh.', toolLog };

test('quoteFound ignores whitespace, quotes and case, supports … fragments', () => {
  assert.equal(quoteFound("settings.cartDrawerRedeemInline || 'cart-drawer'", FILES['apps_doc/joy/packages/scripttag/RedeemCartAdapter.js']), true);
  assert.equal(quoteFound('const selector … nothing to mount', FILES['apps_doc/joy/packages/scripttag/RedeemCartAdapter.js']), true);
  assert.equal(quoteFound('nothing to mount ... const selector', FILES['apps_doc/joy/packages/scripttag/RedeemCartAdapter.js']), false, 'fragments must appear in order');
  assert.equal(quoteFound('', 'anything'), false);
});

test('scoreQuote: file 1.0, kb 0.9, ticket 0.7, browser 0.6, tool name only 0.4, nothing 0', () => {
  assert.equal(scoreQuote({ quote: 'cartDrawerRedeemInline || \'cart-drawer\'', source: { type: 'file', ref: 'apps_doc/joy/packages/scripttag/RedeemCartAdapter.js' } }, ctx).score, SCORES.file);
  assert.equal(scoreQuote({ quote: "Hide block when customer doesn't have enough points", source: { type: 'kb', ref: 'knowledge-base/knowledge/joy/on-site-content_cart-drawer.md' } }, ctx).score, SCORES.kb);
  assert.equal(scoreQuote({ quote: 'cart drawer do khách tự tùy chỉnh', source: { type: 'ticket', ref: 'ticket' } }, ctx).score, SCORES.ticket);
  assert.equal(scoreQuote({ quote: 'joy-redeem-cart: 0 elements', source: { type: 'browser', ref: 'browser:https://example.myshopify.com/' } }, ctx).score, SCORES.browser);
  assert.equal(scoreQuote({ quote: 'something the tool never printed', source: { type: 'tool', ref: 'rg_search' } }, ctx).score, SCORES['tool-name']);
  assert.equal(scoreQuote({ quote: 'something the tool never printed', source: { type: 'tool', ref: 'helpdesk_ticket' } }, ctx).score, SCORES.none, 'tool never called → 0');
});

test('scoreQuote: api:<app>/<path> scores 1.0 from source_read/source_search output, never re-reads a file', () => {
  const apiLog = [...toolLog,
    { tool: 'source_search', args: { queries: ['cartDrawerRedeemInline'] }, output: '[nguồn API: app joy · clone 2 phút · commit 958ffb09 · ref master] 1 dòng khớp\napi:joy/packages/scripttag/RedeemCartAdapter.js:1: const selector = settings.cartDrawerRedeemInline || …;' },
    { tool: 'source_read', args: { file: 'packages/scripttag/RedeemCartAdapter.js', lines: '1-2' }, output: "api:joy/packages/scripttag/RedeemCartAdapter.js (dòng 1-2 / 2 · GitLab bản mới nhất, ref master)\n1| const selector = settings.cartDrawerRedeemInline || 'cart-drawer-live';\n2| return selector;" },
  ];
  const apiCtx = { ...ctx, toolLog: apiLog, readSource: () => { throw new Error('verify must not read a file for api refs'); } };
  const ref = 'api:joy/packages/scripttag/RedeemCartAdapter.js';
  const live = scoreQuote({ quote: "cartDrawerRedeemInline || 'cart-drawer-live'", source: { type: 'api', ref, line: 1 } }, apiCtx);
  assert.equal(live.score, SCORES.api); assert.equal(live.where, 'api');
  const invented = scoreQuote({ quote: 'text the API never returned', source: { type: 'api', ref, line: 1 } }, apiCtx);
  assert.equal(invented.score, 0); assert.match(invented.reason, /không có trong kết quả API nguồn/);
  const fromTicket = scoreQuote({ quote: 'khách tự tùy chỉnh', source: { type: 'api', ref, line: 1 } }, apiCtx);
  assert.equal(fromTicket.score, SCORES.ticket, 'falls through the usual chain');
  assert.equal(scoreQuote({ quote: 'cartDrawerRedeemInline', source: { type: 'api', ref, line: 1 } }, ctx).score, SCORES['tool-output'], 'no source_* call in the log → ordinary tool-output fallback');
  const multiLine = scoreQuote({ quote: "cartDrawerRedeemInline || 'cart-drawer-live';\nreturn selector;", source: { type: 'api', ref, line: 1 } }, apiCtx);
  assert.equal(multiLine.score, SCORES.api, 'a quote spanning two numbered lines still matches (line-number prefixes stripped)');
  assert.equal(stripLineNumbers(' 9| a\n10| b\nplain:12| c'), 'a\nb\nplain:12| c');
  assert.equal(verifyLink({ source: { type: 'api', ref }, link: { cause_quote: 'cartDrawerRedeemInline', effect_quote: 'return selector' } }, apiCtx).verified, true);
  assert.equal(verifyLink({ source: { type: 'api', ref }, link: { cause_quote: 'cartDrawerRedeemInline', effect_quote: 'enough points' } }, apiCtx).verified, false);
});

test('scoreQuote falls back to real tool output when the declared file does not hold the quote', () => {
  const scored = scoreQuote({ quote: 'nothing to mount', source: { type: 'file', ref: 'knowledge-base/knowledge/joy/on-site-content_cart-drawer.md' } }, ctx);
  assert.equal(scored.score, SCORES['tool-output']);
  assert.match(scored.reason, /không có trong knowledge-base/);
  const missing = scoreQuote({ quote: 'phrase that exists nowhere', source: { type: 'file', ref: 'apps_doc/joy/missing.js' } }, ctx);
  assert.equal(missing.score, 0);
});

test('verifyLink keeps a cause→effect only when both quotes share one source', () => {
  const ref = 'apps_doc/joy/packages/scripttag/RedeemCartAdapter.js';
  assert.equal(verifyLink({ source: { type: 'file', ref }, link: { cause_quote: 'cartDrawerRedeemInline', effect_quote: 'return null' } }, ctx).verified, true);
  assert.equal(verifyLink({ source: { type: 'file', ref }, link: { cause_quote: 'cartDrawerRedeemInline', effect_quote: 'enough points' } }, ctx).verified, false);
  assert.equal(verifyLink({ source: null, link: null }, ctx).verified, null);
});

test('checkGap: blocker must be allowed; dev/searched_not_found get their searches from the log when the model\'s list is empty or wrong (14/10/2026)', () => {
  assert.equal(checkGap({ blocker: 'customer', claim: 'Chưa có mã collaborator' }, toolLog).ok, true);
  assert.equal(checkGap({ blocker: 'maybe_later', claim: 'x' }, toolLog).ok, false);
  const empty = checkGap({ blocker: 'dev', claim: 'Cần dev xem log', searched: [] }, toolLog);
  assert.equal(empty.ok, true, 'searched empty → filled from the tool log instead of another round'); assert.equal(empty.searchedAuto, true); assert.ok(empty.searched.length >= 1); assert.match(empty.note, /điền từ log tool/);
  assert.equal(checkGap({ blocker: 'dev', claim: 'Cần dev xem log', searched: [] }, []).ok, false, 'no search in the log at all → still rejected');
  const plain = checkGap({ blocker: 'searched_not_found', claim: 'Không thấy fallback selector', searched: [{ tool: 'rg_search', query: 'cartDrawerRedeemInline' }] }, toolLog);
  assert.equal(plain.ok, true); assert.equal(plain.searchedAuto, undefined, 'a matching list is kept as the model wrote it');
  const fake = checkGap({ blocker: 'searched_not_found', claim: 'Không thấy', searched: [{ tool: 'rg_search', query: 'neverSearchedThis' }] }, toolLog);
  assert.equal(fake.ok, true); assert.equal(fake.searchedAuto, true); assert.match(fake.note, /không khớp log.*neverSearchedThis/);
  assert.equal(checkGap({ blocker: 'shop_access', claim: 'Chưa đọc theme nên không biết selector' }, toolLog).ok, false, 'self-admitted unread without any shop_settings attempt still forces another round');
  const tried = [...toolLog, { tool: 'shop_settings', args: { path: 'reviewWidget' }, output: 'Không đọc được cấu hình shop.' }];
  assert.equal(checkGap({ blocker: 'shop_access', claim: 'chưa đọc được cấu hình shop' }, tried).ok, true, 'the mandated shop_access phrase is accepted once shop_settings was tried');
  assert.equal(checkGap({ blocker: 'dev', claim: 'Chưa đọc file nên không biết', searched: [{ tool: 'rg_search', query: 'cartDrawerRedeemInline' }] }, tried).ok, false, 'self-admitted unread on a dev gap is still rejected');
  assert.equal(searchMatched({ tool: 'read_file', query: 'RedeemCartAdapter' }, toolLog), true);
});

test('searchMatched tolerates the shapes the model writes (file:lines, key=value, app=…; queries=[…]) and crosses read_file/source_read (14/10/2026)', () => {
  const log = [
    { tool: 'source_read', args: { file: 'packages/scripttag/points-calculator/index.js', lines: '1-170' } },
    { tool: 'helpdesk_ticket', args: { part: 'all', max_comments: 8 } },
    { tool: 'source_search', args: { app: 'joy', queries: ['listenOnCartChange', 'window.AVADA_JOY ='] } },
    { tool: 'source_read', args: { files: [{ file: 'packages/a.js', lines: '1-50' }, { file: 'packages/b.js' }] } },
  ];
  assert.equal(searchMatched({ tool: 'source_read', query: 'packages/scripttag/points-calculator/index.js:1-170' }, log), true);
  assert.equal(searchMatched({ tool: 'source_read', query: 'api:joy/packages/scripttag/points-calculator/index.js lines 1-170' }, log), true);
  assert.equal(searchMatched({ tool: 'read_file', query: 'packages/scripttag/points-calculator/index.js' }, log), true, 'read_file ↔ source_read are one family');
  assert.equal(searchMatched({ tool: 'helpdesk_ticket', query: 'part=all, max_comments=8' }, log), true);
  assert.equal(searchMatched({ tool: 'source_search', query: 'app=joy; queries=["listenOnCartChange","window.AVADA_JOY ="]' }, log), true);
  assert.equal(searchMatched({ tool: 'source_read', query: 'packages/b.js' }, log), true, 'a file inside a batch read counts');
  assert.equal(searchMatched({ tool: 'rg_search', query: 'fbq\\(.{0,25}123' }, log), false, 'a query that never ran does not match');
  assert.equal(searchMatched({ tool: 'browser_check', query: 'https://x' }, log), false, 'a tool never called does not match');
});

test('verifyFindings annotates, demotes broken facts to gaps and lists gaps that need another round', () => {
  const result = {
    category: 'Customize', category_reason: '', summary: 's', browser_impact: true, sources: [],
    findings: [
      { id: 'F1', kind: 'fact', claim: 'Adapter mặc định tìm cart-drawer', quote: "settings.cartDrawerRedeemInline || 'cart-drawer'", source: { type: 'file', ref: 'apps_doc/joy/packages/scripttag/RedeemCartAdapter.js', line: 1 }, link: { cause_quote: 'cartDrawerRedeemInline', effect_quote: 'return null' }, blocker: null, searched: null, reply_needed: null, offer_fix: null, details: null },
      { id: 'F2', kind: 'fact', claim: 'Bịa', quote: 'this text is nowhere', source: { type: 'file', ref: 'apps_doc/joy/packages/scripttag/RedeemCartAdapter.js', line: 9 }, link: null, blocker: null, searched: null, reply_needed: null, offer_fix: null, details: null },
      { id: 'F3', kind: 'fact', claim: 'Khớp', quote: 'cartDrawerRedeemInline', source: { type: 'file', ref: 'apps_doc/joy/packages/scripttag/RedeemCartAdapter.js', line: 1 }, link: { cause_quote: 'cartDrawerRedeemInline', effect_quote: 'enough points' }, blocker: null, searched: null, reply_needed: null, offer_fix: null, details: null },
      { id: 'G1', kind: 'gap', claim: 'Cần dev', quote: null, source: null, link: null, blocker: 'dev', searched: [], reply_needed: null, offer_fix: null, details: null },
      { id: 'G2', kind: 'gap', claim: 'Chờ khách gửi mã', quote: null, source: null, link: null, blocker: 'customer', searched: null, reply_needed: true, offer_fix: null, details: null },
      { id: 'S1', kind: 'suggestion', claim: 'Nhập selector vào DevZone', quote: null, source: null, link: null, blocker: null, searched: null, reply_needed: null, offer_fix: false, details: 'cartDrawerRedeemInline' },
    ],
  };
  const verified = verifyFindings(result, ctx);
  const byId = Object.fromEntries(verified.findings.map(finding => [finding.id, finding]));
  assert.equal(byId.F1.verified, true); assert.equal(byId.F1.score, 1); assert.equal(byId.F1.link.verified, true); assert.equal(byId.F1.inference, false);
  assert.equal(byId.F2.kind, 'gap'); assert.equal(byId.F2.demoted, true); assert.equal(byId.F2.blocker, 'searched_not_found');
  assert.equal(byId.F2.gap_ok, true, 'demoted fact gets the read_file/rg_search calls that touched the file as searched');
  assert.equal(byId.F3.inference, true, 'link not in one source → suy luận');
  assert.equal(byId.G1.gap_ok, true, 'dev gap with empty searched → filled from the log (14/10/2026)'); assert.equal(byId.G1.searched_auto, true); assert.ok(byId.G1.searched.length >= 1); assert.equal(byId.G2.gap_ok, true);
  assert.equal(byId.S1.score, 0.5); assert.equal(byId.S1.verified, false);
  assert.deepEqual(verified.needsInvestigation.map(item => item.id), [], 'no extra round when the log holds the searches');
  assert.deepEqual(verified.stats, { total: 6, facts: 2, suggestions: 1, gaps: 3, demoted: 1, brokenQuotes: 1, inferences: 1, gapsInvalid: 0, searchedAuto: 1, cssTried: 0, cssUntried: 0 });
  const bare = verifyFindings({ ...result, findings: [result.findings[3]] }, { ...ctx, toolLog: [] });
  assert.deepEqual(bare.needsInvestigation.map(item => item.id), ['G1'], 'an empty log still sends the gap to the extra round');
});

test('mergeFindings replaces by id and appends new ones', () => {
  const merged = mergeFindings({ findings: [{ id: 'A', claim: 'old' }, { id: 'B', claim: 'b' }], sources: [{ type: 'kb', ref: 'x' }] }, { findings: [{ id: 'A', claim: 'new' }, { id: 'C', claim: 'c' }], sources: [] });
  assert.deepEqual(merged.findings.map(finding => `${finding.id}:${finding.claim}`), ['A:new', 'B:b', 'C:c']);
});

test('validateFindings reports the problems the model can fix', () => {
  assert.deepEqual(validateFindings({ category: 'Bug', summary: 'ok', findings: [{ id: 'F1', kind: 'fact', claim: 'c', quote: 'q', source: { type: 'file', ref: 'apps_doc/x.js', line: null } }] }), []);
  const problems = validateFindings({ category: 'Nope', summary: '', findings: [{ id: 'F1', kind: 'fact', claim: 'c', quote: '' }, { id: 'F1', kind: 'gap', claim: 'g', blocker: 'dev', searched: [] }] });
  assert.ok(problems.some(problem => /category/.test(problem)));
  assert.ok(problems.some(problem => /quote/.test(problem)));
  assert.ok(problems.some(problem => /duplicated/.test(problem)));
  assert.ok(problems.some(problem => /searched/.test(problem)));
});

test('validateFindings: Customize needs a finding with code or an infeasible_reason; code_lang is checked (13/10/2026)', () => {
  const base = { category: 'Customize', summary: 'ok', findings: [{ id: 'F1', kind: 'fact', claim: 'c', quote: 'q', source: { type: 'browser', ref: 'browser:https://x.test/', line: null } }] };
  assert.ok(validateFindings(base).some(problem => /Customize needs at least one finding with `code`/.test(problem)));
  assert.deepEqual(validateFindings({ ...base, findings: [...base.findings, { id: 'S1', kind: 'suggestion', claim: 's', code: '.a { display: none }', code_lang: 'css' }] }), []);
  assert.deepEqual(validateFindings({ ...base, infeasible_reason: 'đổi logic, không làm được bằng CSS' }), []);
  assert.ok(validateFindings({ ...base, findings: [...base.findings, { id: 'S1', kind: 'suggestion', claim: 's', code: '.a {}', code_lang: 'python' }] }).some(problem => /code_lang/.test(problem)));
  assert.deepEqual(validateFindings({ ...base, category: 'Bug' }), [], 'only Customize requires code');
});

test('scoreQuote: css_preview output counts as browser evidence (0.6)', () => {
  const log = [{ tool: 'css_preview', args: { url: 'https://x.test/p', css: '.a{display:none}' }, output: 'url: https://x.test/p\n- .a: 1 phần tử, 1 hiển thị → 1 phần tử, 0 hiển thị, display none' }];
  const scored = scoreQuote({ quote: '.a: 1 phần tử, 1 hiển thị → 1 phần tử, 0 hiển thị, display none', source: { type: 'browser', ref: 'browser:https://x.test/p' } }, { toolLog: log, ticketText: '' });
  assert.equal(scored.score, SCORES.browser);
  assert.equal(scored.where, 'browser');
});
