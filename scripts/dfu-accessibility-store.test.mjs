// node --test scripts/dfu-accessibility-store.test.mjs — DFU Accessibility: md report parser, prompt/answer shaping,
// ticket filter (pure, no network) and, when Postgres hachimi is reachable, the report versions + analysis state
// (with a fake analyser; the real Codex worker is never launched here).
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { resolveCodexBin, readKnowledge, knowledgeBlocks, CHECKLIST_FILE, LESSONS_FILE, stripGreeting, parseReport, parseIssueBlock, groupIssues, compactForPrompt, analysisPrompt, normalizeAnalysis, validateUpload, DEDUCTIONS, saveReport, currentReport, listVersions, reportSummaries, startAnalysis, awaitAnalysis, getReport, ConflictError, purgeExpired, retentionDays, DEFAULT_RETENTION_DAYS } from './dfu-accessibility-store.mjs';
import { ROOT, query, closePool } from './hachimi-db.mjs';
import { protectHtml, verifyPageUrls, validateImageUrl, selectorHints, pageCandidates, sectionFile, checkPrompt, normalizeCheck, buildComment, startIssueCheck, awaitCheck, getCheck, listChecks, CHECK_SCHEMA } from './dfu-accessibility-check.mjs';

const SAMPLE = resolve(ROOT, 'report_accessibility_scan/accessibility_report_1791623915729.md');
const sample = await readFile(SAMPLE, 'utf8');

test('header of the scanner export: store url, date, score, totals, legal risk, breakdown', () => {
  const { header } = parseReport(sample);
  assert.equal(header.url, 'https://horizon-brands.com/');
  assert.equal(header.scannedAt, '10/8/2026, 7:24:37 AM');
  assert.equal(header.score, 20); assert.equal(header.totalIssues, 7); assert.equal(header.legalRisk, 'HIGH');
  assert.deepEqual(header.breakdown, { critical: 7, major: 0, minor: 1 });
});

test('every "Issue Details" block becomes an issue; blocks are grouped per WCAG criterion', () => {
  const parsed = parseReport(sample);
  assert.equal(parsed.issues.length, 13);
  assert.equal(parsed.groups.length, 6);
  const wcag = parsed.groups.map(group => group.wcag).sort();
  assert.deepEqual(wcag, ['1.1.1', '1.3.1', '1.4.13', '2.4.11', '3.3.2', '4.1.2']);
  const info = parsed.groups.find(group => group.wcag === '1.3.1');
  assert.equal(info.title, 'Info and Relationships'); assert.equal(info.severity, 'critical'); assert.equal(info.entries, 5); assert.equal(info.instances, 35);
  assert.equal(info.deduction, 10); assert.equal(info.hint, 'fix_real');
  assert.ok(info.pages.includes('/koda'), 'affected pages are kept');
  assert.ok(info.elements.some(text => /Heading level skipped/.test(text)), 'heading evidence kept as element sample');
  const hover = parsed.groups.find(group => group.wcag === '1.4.13');
  assert.equal(hover.hint, 'verify_fp'); assert.equal(hover.deduction, 5); assert.equal(hover.entries, 3);
  assert.ok(hover.descriptions.length >= 2, 'distinct descriptions of the same criterion are kept');
  const alt = parsed.groups.find(group => group.wcag === '1.1.1');
  assert.match(alt.actions.join(' '), /alt text/i); assert.ok(alt.elements[0].startsWith('<img'));
  assert.equal(parsed.stats.criteria, 6); assert.ok(parsed.stats.instances > 500);
  // Critical first, then checklist deduction, then instances.
  assert.equal(parsed.groups[0].wcag, '1.3.1');
});

test('a block whose description sits inside the locations section (PDF interleaving) still gets prose', () => {
  const issue = parseIssueBlock([
    '**Info and Relationships CRITICAL 13 instances** ', '', 'WCAG: 1.3.1 ', '', '**Description:**   ', '**Locations & Elements Affected Pages:** ', '',
    '**/koda** ', 'Entire page ', '**/michelin** ', 'Content structure and relationships are presented visually  ', 'Entire page   ', 'but not coded in ways accessible technologies can  understand. ',
    '**Action Needed:** ', 'Use the Page Structure feature in our widget to quickly  review. • Don\'t jump from H3 to H5 ',
  ]);
  assert.equal(issue.title, 'Info and Relationships'); assert.equal(issue.severity, 'critical'); assert.equal(issue.instances, 13); assert.equal(issue.wcag, '1.3.1');
  assert.deepEqual(issue.pages, ['/koda', '/michelin']);
  assert.match(issue.description, /Content structure and relationships/);
  assert.match(issue.action, /Page Structure/); assert.match(issue.action, /\n• Don't jump/);
});

test('a plain Markdown export (## headings, no bold) parses too', () => {
  const md = ['# Accessibility Audit Report', 'https://demo.myshopify.com/', '1/2/2026, 10:00:00 AM', 'Accessibility Score: 88', 'Total Issues: 2', 'Legal Risk: LOW', 'Critical: 1 issues', 'Major: 1 issues', 'Minor: 0 issues',
    '## Issue Details', 'Page Titled', 'MINOR 1 instance', 'WCAG: 2.4.2', 'Description:', 'Page has no title.', 'Action Needed:', 'Add <title>.', 'Locations & Elements', 'Affected Pages:', '/', 'Entire page',
    '## Issue Details', 'Language of Page', 'MAJOR 1 instance', 'WCAG: 3.1.1', 'Description:', 'No lang attribute.'].join('\n');
  const parsed = parseReport(md);
  assert.equal(parsed.header.score, 88); assert.equal(parsed.header.legalRisk, 'LOW'); assert.equal(parsed.header.breakdown.major, 1);
  assert.equal(parsed.groups.length, 2);
  assert.equal(parsed.groups.find(group => group.wcag === '2.4.2').deduction, DEDUCTIONS['2.4.2']);
  assert.equal(parsed.groups.find(group => group.wcag === '3.1.1').severity, 'major');
});

test('the prompt carries the checklist as knowledge and a compact JSON of the issues, not the raw file', () => {
  const parsed = parseReport(sample);
  const compact = compactForPrompt(parsed);
  assert.equal(compact.issues.length, 6);
  assert.ok(compact.issues.every(issue => issue.pages.length <= 25 && issue.sampleElements.length <= 5));
  const prompt = analysisPrompt(parsed, '# CHECKLIST\n* 1.4.13 thường FP', { ticket: { reference: 'ACCS-1', subject: '[DFY] shop' } });
  assert.ok(prompt.includes('=== CHECKLIST DFY (knowledge'));
  assert.ok(prompt.includes('"wcag":"1.4.13"'));
  assert.ok(prompt.includes('Ticket: ACCS-1 · [DFY] shop'));
  assert.ok(!prompt.includes('lazyautosizes lazyloaded" src="//horizon... <img class="lazyload'), 'location noise is not pasted wholesale');
  assert.ok(prompt.length < 60_000);
});

test('the AI answer is normalised: unknown verdicts become verify, every criterion gets a row, order follows the report', () => {
  const parsed = parseReport(sample);
  const analysis = normalizeAnalysis({
    overview: 'ok', scoreNote: 'note', priorities: ['a', '', 'b'],
    issues: [
      { key: '1.4.13', wcag: '1.4.13', title: 'x', summary: 's', verdict: 'false_positive', confidence: 'high', analysis: 'a', action: 'b', owner: 'CS' },
      { key: '1.3.1', wcag: '1.3.1', title: 'y', summary: 's', verdict: 'nonsense', confidence: 'huge', analysis: 'a', action: 'b', owner: 'Nobody' },
    ],
  }, parsed);
  assert.equal(analysis.issues.length, 6);
  assert.equal(analysis.issues[0].key, '1.3.1', 'report order kept'); assert.equal(analysis.issues[0].verdict, 'verify'); assert.equal(analysis.issues[0].owner, 'TS'); assert.equal(analysis.issues[0].confidence, 'low');
  assert.equal(analysis.issues.find(issue => issue.key === '1.4.13').verdict, 'false_positive');
  assert.equal(analysis.issues.find(issue => issue.key === '2.4.11').analysis, 'AI chưa phân tích mục này.');
  assert.deepEqual(analysis.priorities, ['a', 'b']);
  assert.equal(analysis.deductionTotal, 15, '1.3.1 (10) + 1.4.13 (5)');
  assert.throws(() => normalizeAnalysis(null, parsed), TypeError);
});

test('a worker greeting at the start of a text is dropped', () => {
  assert.equal(stripGreeting('Báo cáo Đại tá, Hachimi có mặt! Scan ghi nhận điểm 20.'), 'Scan ghi nhận điểm 20.');
  assert.equal(stripGreeting('Thưa Đại tá, Hanbui có mặt. Điểm 20.'), 'Điểm 20.');
  assert.equal(stripGreeting('Điểm 20, risk HIGH.'), 'Điểm 20, risk HIGH.');
  assert.equal(stripGreeting(''), '');
});

test('uploads: only .md text files of a sane size', () => {
  assert.throws(() => validateUpload({ filename: 'report.pdf', content: 'x' }), /\.md/);
  assert.throws(() => validateUpload({ filename: 'report.md', content: '   ' }), /rỗng/);
  assert.throws(() => validateUpload({ filename: 'report.md', content: 'a\u0000b' }), /văn bản/);
  assert.equal(validateUpload({ filename: ' scan.MD ', content: '# ok' }).filename, 'scan.MD');
});

test('Done For You ticket filter of the web server: the Helpdesk Done tick (dueDateDone) decides', async () => {
  const { isDfuTicket } = await import('./ts-management-web.mjs');
  assert.equal(isDfuTicket({ subject: '[DFY] shop.myshopify.com', tsStatus: 'doing', ticketStatus: 'open' }), true);
  assert.equal(isDfuTicket({ subject: 'Widget broken', tsStatus: 'done_for_you', ticketStatus: 'open' }), true);
  assert.equal(isDfuTicket({ subject: 'DFY setup', tsStatus: 'pending', ticketStatus: 'open' }), true);
  assert.equal(isDfuTicket({ subject: '[DFY] shop', tsStatus: 'done', ticketStatus: 'closed', dueDateDone: false }), true, 'not ticked: listed whatever the status');
  assert.equal(isDfuTicket({ subject: '[DFY] shop', tsStatus: 'doing', ticketStatus: 'open', dueDateDone: true }), false, 'Done ticked on Helpdesk');
  assert.equal(isDfuTicket({ subject: '[DFY] shop', tsStatus: 'doing', ticketStatus: 'open', deletedAt: '2026-10-01' }), false);
  assert.equal(isDfuTicket({ subject: 'Widget broken', tsStatus: 'doing', ticketStatus: 'open' }), false, 'not a DFY ticket');
});

// --- database (skipped when Postgres hachimi is not reachable) -------------
const dbReady = await query('SELECT 1').then(() => true).catch(() => false);
const TICKET = `test-dfu-${process.pid}-${Date.now()}`;
after(async () => { if (dbReady) await closePool(); });
test('report versions, conflict without replace, analysis state with a fake analyser', { skip: !dbReady && 'Postgres hachimi not reachable' }, async t => {
  t.after(async () => { await query('DELETE FROM dfu_accessibility_reports WHERE ticket_id = $1', [TICKET]); });
  const first = await saveReport({ ticketId: TICKET, ticketReference: 'ACCS-TEST-1', subject: '[DFY] test', store: 'demo', filename: 'scan.md', content: sample });
  assert.equal(first.report.version, 1); assert.equal(first.replaced, null); assert.equal(first.report.analysisStatus, 'pending'); assert.equal(first.report.mdContent, undefined);
  assert.equal(first.report.parsed.header.score, 20);
  await assert.rejects(saveReport({ ticketId: TICKET, filename: 'scan.md', content: sample }), ConflictError);
  const second = await saveReport({ ticketId: TICKET, filename: 'scan2.md', content: sample, replace: true });
  assert.equal(second.report.version, 2); assert.equal(second.replaced, 1); assert.equal(second.sameAsPrevious, true);
  assert.equal(second.report.ticketReference, 'ACCS-TEST-1', 'reference carried over from the first version');
  const current = await currentReport(TICKET, { withContent: true });
  assert.equal(current.version, 2); assert.equal(current.mdContent, sample);
  assert.equal((await listVersions(TICKET)).length, 2);
  assert.equal((await reportSummaries([TICKET, 'nope']))[TICKET].version, 2);
  await assert.rejects(saveReport({ ticketId: TICKET, filename: 'bad.md', content: 'nothing here', replace: true }), /cấu trúc report/);
  // analysis: fake analyser, resolves after the row was marked running
  let resolveWork; const work = new Promise(done => { resolveWork = done; });
  const started = await startAnalysis(current.id, { analyze: async parsed => { await work; return normalizeAnalysis({ overview: 'o', scoreNote: 's', priorities: [], issues: [] }, parsed); } });
  assert.deepEqual(started, { id: current.id, started: true, running: true });
  assert.equal((await getReport(current.id)).analysisStatus, 'running');
  assert.equal((await startAnalysis(current.id)).started, false, 'second call while running');
  resolveWork(); await awaitAnalysis(current.id);
  const done = await getReport(current.id);
  assert.equal(done.analysisStatus, 'done'); assert.equal(done.analysis.issues.length, 6); assert.ok(done.analyzedAt);
  // failure path
  await startAnalysis(current.id, { analyze: async () => { throw new Error('codex missing'); } });
  await awaitAnalysis(current.id).catch(() => {});
  const failed = await getReport(current.id);
  assert.equal(failed.analysisStatus, 'error'); assert.match(failed.analysisError, /codex missing/);
  await assert.rejects(startAnalysis(999999999), RangeError);
});

test('retention: a ticket is purged 60 days after its FIRST upload, replacing the report does not reset the clock', { skip: !dbReady && 'Postgres hachimi not reachable' }, async t => {
  const OLD = `${TICKET}-old`; const FRESH = `${TICKET}-fresh`;
  t.after(async () => { await query('DELETE FROM dfu_accessibility_reports WHERE ticket_id = ANY($1::text[])', [[OLD, FRESH]]); });
  assert.equal(retentionDays(), Number(process.env.DFU_RETENTION_DAYS) || DEFAULT_RETENTION_DAYS);
  await saveReport({ ticketId: OLD, ticketReference: 'ACCS-TEST-OLD', filename: 'scan.md', content: sample });
  await query('UPDATE dfu_accessibility_reports SET uploaded_at = now() - interval \'61 days\' WHERE ticket_id = $1', [OLD]);
  await saveReport({ ticketId: OLD, filename: 'scan2.md', content: sample, replace: true }); // version 2, uploaded today
  await saveReport({ ticketId: FRESH, ticketReference: 'ACCS-TEST-FRESH', filename: 'scan.md', content: sample });
  const dry = await purgeExpired({ days: 90, trigger: 'test' });
  assert.equal(dry.deletedReports, 0, 'nothing older than 90 days');
  const result = await purgeExpired({ days: 60, trigger: 'test' });
  assert.equal(result.deletedTickets, 1); assert.equal(result.deletedReports, 2, 'both versions of the old ticket go');
  assert.deepEqual(result.tickets.map(r => r.ticketReference), ['ACCS-TEST-OLD']);
  assert.equal(await currentReport(OLD), null);
  assert.equal((await currentReport(FRESH)).version, 1, 'fresh ticket untouched');
});

// --- "Start check" of one issue (dfu-accessibility-check.mjs) ------------------------------------------------
const parsedSample = parseReport(sample);
const FAKE_BODY = 'Thưa Đại tá, Hanbui có mặt! Lỗi: ba trang thiếu H1; footer dùng <h6> cho ba nhóm link nên heading nhảy cấp.\n\nPage bị lỗi:\nhttps://horizon-brands.com/pages/koda\n\nCách khắc phục:\n- `sections/footer.liquid` (chưa xác định dòng): thêm aria-level, giữ `h6`.\n```\n<h6>Horizon Brands</h6>\n<h6 aria-level="2">Horizon Brands</h6>\n```\nLưu ý: thêm H1 xong rescan có thể lộ lỗi nhảy cấp bị che.';
const FAKE_ANSWER = { body: FAKE_BODY, tsAction: 'TS sẽ thực hiện đổi H6 thành H2 ở footer rồi rescan.', pages: ['https://horizon-brands.com/pages/koda', 'not a url'], fixOption: 'theme_code' };

test('check: image url validation, selector hints, page candidates, section file', () => {
  assert.equal(validateImageUrl(' https://capture.avada.io/i/abc '), 'https://capture.avada.io/i/abc');
  assert.throws(() => validateImageUrl(''), /Dán URL/); assert.throws(() => validateImageUrl('capture.avada.io/i/abc'), /không hợp lệ/); assert.throws(() => validateImageUrl('https://x.y/a b'), /không hợp lệ/);
  const group = parsedSample.groups.find(g => g.key === '1.3.1');
  const hints = selectorHints(group);
  assert.ok(hints.tags.includes('h1') && hints.tags.includes('h6'), JSON.stringify(hints));
  assert.ok(hints.classes.includes('one-whole'), 'PDF artefact ".one whole" becomes .one-whole: ' + JSON.stringify(hints));
  assert.deepEqual(pageCandidates('https://horizon-brands.com/', '/koda'), ['https://horizon-brands.com/koda', 'https://horizon-brands.com/pages/koda', 'https://horizon-brands.com/collections/koda', 'https://horizon-brands.com/products/koda']);
  assert.deepEqual(pageCandidates('https://horizon-brands.com', '/home')[0], 'https://horizon-brands.com/');
  assert.deepEqual(pageCandidates('https://x.com', '/pages/koda'), ['https://x.com/pages/koda']);
  assert.equal(sectionFile('shopify-section-template--15939482648622__main-page'), 'sections/main-page.liquid');
  assert.equal(sectionFile('shopify-section-footer'), 'sections/footer.liquid');
  assert.equal(sectionFile(''), '');
});

test('check: prompt carries the issue, the evidence, the rule note, the checklist and the image link; the AI body is cleaned; comment = fixed first line + body + image + TS line', () => {
  const group = parsedSample.groups.find(g => g.key === '1.3.1');
  const evidence = { baseUrl: 'https://horizon-brands.com/', hints: selectorHints(group), pages: [{ url: 'https://horizon-brands.com/koda', finalUrl: 'https://horizon-brands.com/pages/koda', status: 200, title: 'Koda', template: '', h1Count: 0, headings: [{ tag: 'h6', text: 'Horizon Brands', section: 'shopify-section-footer', visible: true, style: { fontSize: '18px', fontWeight: '700', color: 'rgb(184, 184, 184)' } }], matches: [], sections: ['shopify-section-footer'] }], crossPage: null, files: [{ file: 'sections/footer.liquid', pages: ['https://horizon-brands.com/pages/koda'] }], errors: [] };
  const prompt = checkPrompt({ report: { ticketReference: 'ACCS-1', subject: '[DFY] x', store: 'horizon', parsed: parsedSample }, group, ai: { summary: 's', verdict: 'real', analysis: 'a', action: 'b', owner: 'TS' }, imageUrl: 'https://capture.avada.io/i/abc', evidence, rule: { ok: false, note: 'Source Code API quá 20 giây, bỏ qua.' }, checklist: 'CHECKLIST BODY' });
  for (const needle of ['"wcag":"1.3.1"', 'sections/footer.liquid', 'rgb(184, 184, 184)', 'không đọc được: Source Code API quá 20 giây', 'CHECKLIST BODY', 'https://capture.avada.io/i/abc', 'đổi tag thì giữ style', 'Online Store > Pages', 'Customize theme', 'VIẾT THẲNG PHẦN THÂN', 'KHÔNG viết trong body', 'tsAction', 'fence ```', '2.000–3.000 ký tự', 'Cách khắc phục:']) assert.ok(prompt.includes(needle), needle);
  assert.ok(!prompt.includes('BÀI HỌC SỬA LỖI DFY ĐÃ KIỂM CHỨNG'), 'no lessons block without lessons');
  const withLessons = checkPrompt({ report: { parsed: parsedSample }, group, ai: null, imageUrl: 'https://x.y/z', evidence, rule: { ok: false, note: 'x' }, knowledge: { checklist: 'CL', lessons: 'LESSON 11 aria-level' } });
  for (const needle of ['=== CHECKLIST DFY', 'CL', 'BÀI HỌC SỬA LỖI DFY ĐÃ KIỂM CHỨNG', 'LESSON 11 aria-level', 'KIẾN THỨC ĐÃ KIỂM CHỨNG', 'page.content', 'heading rỗng', 'diff 0']) assert.ok(withLessons.includes(needle), needle);
  assert.ok(prompt.length < 60_000);
  assert.deepEqual(CHECK_SCHEMA.required, ['body', 'tsAction', 'pages', 'fixOption']);
  const result = normalizeCheck(FAKE_ANSWER);
  assert.ok(result.body.startsWith('Lỗi: ba trang thiếu H1'), 'greeting stripped: ' + result.body.slice(0, 60));
  assert.ok(result.body.includes('footer dùng `<h6>` cho ba nhóm'), 'bare tag in prose wrapped in backticks');
  assert.ok(result.body.includes('```\n<h6>Horizon Brands</h6>\n<h6 aria-level="2">Horizon Brands</h6>\n```'), 'fenced code untouched');
  assert.ok(result.body.endsWith('Lưu ý: thêm H1 xong rescan có thể lộ lỗi nhảy cấp bị che.'));
  assert.equal(protectHtml('a `<p>` b <span class="x">c</span> d'), 'a `<p>` b `<span class="x">`c`</span>` d');
  // page URLs: only pages Playwright opened keep the full URL; other report paths stay as the report writes them
  const urlOpts = { baseUrl: 'https://horizon-brands.com/', verified: ['https://horizon-brands.com/pages/koda', 'https://horizon-brands.com/'], reportPaths: ['/koda', '/home', '/careers', '/accessibility-statement'] };
  assert.equal(verifyPageUrls('A https://horizon-brands.com/pages/koda B https://horizon-brands.com/pages/home C https://horizon-brands.com/pages/careers. D https://horizon-brands.com/ E https://capture.avada.io/i/x F https://horizon-brands.com/collections/all', urlOpts),
    'A https://horizon-brands.com/pages/koda B /home C /careers. D https://horizon-brands.com/ E https://capture.avada.io/i/x F /collections/all');
  const checked = normalizeCheck({ ...FAKE_ANSWER, body: 'Lỗi: x.\n\nPage bị lỗi:\nhttps://horizon-brands.com/pages/koda\nhttps://horizon-brands.com/pages/careers', pages: ['https://horizon-brands.com/pages/koda', 'https://horizon-brands.com/pages/careers'] }, { evidence: { baseUrl: 'https://horizon-brands.com/', pages: [{ finalUrl: 'https://horizon-brands.com/pages/koda', status: 200 }, { finalUrl: 'https://horizon-brands.com/pages/careers', status: 404 }] }, group: { pages: ['/koda', '/careers'] } });
  assert.ok(checked.body.endsWith('https://horizon-brands.com/pages/koda\n/careers'), checked.body); assert.deepEqual(checked.pages, ['https://horizon-brands.com/pages/koda', '/careers']);
  const long = normalizeCheck({ ...FAKE_ANSWER, body: 'Lỗi: x.\n\n' + 'Dòng dài. '.repeat(500) + '\n```\n<h6>a</h6>\n' + 'code\n'.repeat(50) + '```' });
  assert.ok(long.body.length <= 3_700, `body capped: ${long.body.length}`); assert.equal((long.body.match(/```/g) || []).length % 2, 0, 'fence closed after the cut');
  assert.deepEqual(result.pages, ['https://horizon-brands.com/pages/koda'], 'non-URL dropped');
  assert.equal(normalizeCheck({ ...FAKE_ANSWER, fixOption: 'magic' }).fixOption, 'theme_code');
  assert.match(normalizeCheck({ ...FAKE_ANSWER, tsAction: '' }).tsAction, /^TS sẽ thực hiện/);
  assert.equal(normalizeCheck({ ...FAKE_ANSWER, tsAction: 'sửa footer' }).tsAction, 'TS sẽ thực hiện sửa footer');
  // a stray first line / image link / closing sentence inside the body are removed (the server adds them)
  const stray = normalizeCheck({ ...FAKE_ANSWER, body: 'Lỗi mã 1.3.1 - "x"\nhttps://capture.avada.io/i/abc\n\nNguyên nhân thật.\n\nTS sẽ thực hiện gì đó.' });
  assert.equal(stray.body, 'Nguyên nhân thật.');
  assert.throws(() => normalizeCheck({ ...FAKE_ANSWER, body: '' }), /không trả thân comment/);
  const text = buildComment({ group, result, imageUrl: 'https://capture.avada.io/i/abc' });
  const lines = text.split('\n');
  assert.equal(lines[0], 'Lỗi mã 1.3.1 - "Content structure and relationships are presented visually but not coded in ways accessible technologies can understand."');
  assert.equal(lines[1], 'Lỗi: ba trang thiếu H1; footer dùng `<h6>` cho ba nhóm link nên heading nhảy cấp.');
  assert.ok(text.includes('\n\nhttps://capture.avada.io/i/abc\n\n'), 'image link on its own line');
  const multi = buildComment({ group, result: { ...result, body: 'Đoạn nguyên nhân.\n\nĐoạn cách sửa.' }, imageUrl: 'https://x.y/img' });
  assert.equal(multi.split('\n').slice(1, 6).join('|'), 'Đoạn nguyên nhân.||https://x.y/img||Đoạn cách sửa.', 'image after the first paragraph, rest of the body after it');
  assert.ok(text.includes('```\n<h6>Horizon Brands</h6>\n<h6 aria-level="2">Horizon Brands</h6>\n```'), 'code block kept verbatim');
  assert.ok(text.length < 4_000);
  assert.ok(text.endsWith('TS sẽ thực hiện đổi H6 thành H2 ở footer rồi rescan.'));
  assert.ok(!/Đại tá|Hanbui|Hachimi|Elite/.test(text));
  assert.throws(() => buildComment({ group, result: { ...result, body: 'Theo TS Elite thì…' }, imageUrl: 'https://x.y/z' }), /Elite/);
});

test('check: run with fake evidence/rule/analyser/poster → posted; running and posted conflicts; force; dry run; post failure keeps the text; cascade delete', { skip: !dbReady && 'Postgres hachimi not reachable' }, async t => {
  const CT = `${TICKET}-check`;
  t.after(async () => { await query('DELETE FROM dfu_accessibility_reports WHERE ticket_id = $1', [CT]); });
  const { report } = await saveReport({ ticketId: CT, ticketReference: 'ACCS-TEST-CHECK', filename: 'scan.md', content: sample });
  const collect = async () => ({ baseUrl: 'https://horizon-brands.com/', hints: {}, pages: [], crossPage: null, files: [], errors: ['test: no browser'] });
  const rule = async () => ({ ok: false, text: '', note: 'test' });
  const posted = [];
  const post = async (ticketId, text) => { posted.push({ ticketId, text }); return { id: 'cmt-1' }; };
  await assert.rejects(startIssueCheck(report.id, { issueKey: '9.9.9', imageUrl: 'https://x.y/z', collect, rule, analyze: async () => FAKE_ANSWER, post }), /Không có issue/);
  await assert.rejects(startIssueCheck(report.id, { issueKey: '1.3.1', imageUrl: 'nope', collect, rule, analyze: async () => FAKE_ANSWER, post }), TypeError);
  await assert.rejects(startIssueCheck(999999999, { issueKey: '1.3.1', imageUrl: 'https://x.y/z' }), RangeError);
  // slow analyser → the row is running; a second start is refused
  let release; const gate = new Promise(done => { release = done; });
  const started = await startIssueCheck(report.id, { issueKey: '1.3.1', imageUrl: 'https://capture.avada.io/i/abc', collect, rule, analyze: async () => { await gate; return FAKE_ANSWER; }, post, checklist: 'c' });
  assert.deepEqual({ started: started.started, running: started.running, issueKey: started.issueKey }, { started: true, running: true, issueKey: '1.3.1' });
  assert.equal((await getCheck(started.id)).status, 'running');
  await assert.rejects(startIssueCheck(report.id, { issueKey: '1.3.1', imageUrl: 'https://x.y/z', collect, rule, analyze: async () => FAKE_ANSWER, post }), ConflictError);
  // progress while waiting for the AI: step 3, 50 %
  const waiting = await getCheck(started.id);
  assert.equal(waiting.progress, 50); assert.match(waiting.step, /^Bước 3\/5 · AI/);
  release(); await awaitCheck(started.id);
  const first = await getCheck(started.id);
  assert.equal(first.status, 'posted'); assert.equal(first.progress, 100); assert.equal(first.step, 'Đã đăng comment'); assert.equal(first.commentId, 'cmt-1'); assert.ok(first.postedAt); assert.equal(first.imageUrl, 'https://capture.avada.io/i/abc');
  assert.equal(posted.length, 1); assert.equal(posted[0].ticketId, CT); assert.equal(posted[0].text, first.commentText);
  assert.match(first.commentText, /^Lỗi mã 1\.3\.1 - /); assert.ok(first.commentText.includes('https://capture.avada.io/i/abc'));
  assert.deepEqual(first.evidence.errors, ['test: no browser']); assert.equal(first.result.ruleNote, 'test');
  assert.equal((await listChecks(report.id))['1.3.1'].id, first.id);
  // posted → needs force; force posts a new comment (new row)
  await assert.rejects(startIssueCheck(report.id, { issueKey: '1.3.1', imageUrl: 'https://x.y/z', collect, rule, analyze: async () => FAKE_ANSWER, post }), /đã được comment/);
  const again = await startIssueCheck(report.id, { issueKey: '1.3.1', imageUrl: 'https://x.y/z2', force: true, collect, rule, analyze: async () => FAKE_ANSWER, post, checklist: 'c' });
  await awaitCheck(again.id);
  assert.notEqual(again.id, first.id); assert.equal((await getCheck(again.id)).status, 'posted'); assert.equal(posted.length, 2);
  assert.equal((await listChecks(report.id))['1.3.1'].id, again.id, 'latest per issue');
  // dry run: done, nothing posted
  const dry = await startIssueCheck(report.id, { issueKey: '1.1.1', imageUrl: 'https://x.y/z', dryRun: true, collect, rule, analyze: async () => FAKE_ANSWER, post, checklist: 'c' });
  await awaitCheck(dry.id);
  assert.equal((await getCheck(dry.id)).status, 'done'); assert.equal(posted.length, 2);
  // post failure: error, comment text kept; not a conflict for the next run
  const failing = await startIssueCheck(report.id, { issueKey: '2.4.11', imageUrl: 'https://x.y/z', collect, rule, analyze: async () => FAKE_ANSWER, post: async () => { throw new Error('Helpdesk 500'); }, checklist: 'c' });
  await awaitCheck(failing.id).catch(() => {});
  const failed = await getCheck(failing.id);
  assert.equal(failed.status, 'error'); assert.match(failed.error, /Đăng comment thất bại: Helpdesk 500/); assert.ok(failed.commentText.length > 50);
  assert.equal(failed.progress, 90, 'error keeps the progress of the failing step'); assert.match(failed.step, /^Bước 5\/5/);
  assert.equal((await getCheck(dry.id)).progress, 100); assert.equal((await getCheck(dry.id)).step, 'Hoàn tất (chưa đăng)');
  // evidence progress: the collector reports pages, the row moves inside step 1 (3–45 %)
  const seen = [];
  const slowCollect = async (g, h, { onProgress }) => { onProgress({ index: 0, total: 5, label: 'trang 1/5' }); seen.push((await getCheck(seen.length ? seen[0].id : evidenceRun.id)).progress); onProgress({ index: 4, total: 5, label: 'trang đối chứng 5/5' }); seen.push((await getCheck(evidenceRun.id)).progress); return collect(); };
  const evidenceRun = await startIssueCheck(report.id, { issueKey: '1.4.13', imageUrl: 'https://x.y/z', dryRun: true, collect: slowCollect, rule, analyze: async () => FAKE_ANSWER, post, checklist: 'c' });
  await awaitCheck(evidenceRun.id);
  assert.deepEqual(seen, [3, 37], 'progress 3 % at page 1, 37 % before the cross-check page');
  // analyser failure
  const broken = await startIssueCheck(report.id, { issueKey: '4.1.2', imageUrl: 'https://x.y/z', collect, rule, analyze: async () => { throw new Error('codex missing'); }, post, checklist: 'c' });
  await awaitCheck(broken.id).catch(() => {});
  assert.match((await getCheck(broken.id)).error, /codex missing/);
  // the 60-day purge removes the checks with the report (ON DELETE CASCADE)
  await query('DELETE FROM dfu_accessibility_reports WHERE id = $1', [report.id]);
  assert.equal(await getCheck(first.id), null);
});

test('knowledge: the structured DFY checklist and the fix lessons are read and both prompts carry them', async () => {
  const know = await readKnowledge();
  assert.ok(know.checklist.includes('Nhóm 1') && know.checklist.includes('1.3.1'), 'structured checklist read from ' + CHECKLIST_FILE);
  assert.ok(know.lessons.includes('aria-level') && know.lessons.includes('[source'), 'lessons read from ' + LESSONS_FILE);
  assert.deepEqual(know.sources, ['knowledge-base/app-guides/accessibility-dfy-checklist.md', 'knowledge-base/app-guides/accessibility-dfy-fix-lessons.md']);
  const blocks = knowledgeBlocks(know);
  assert.equal(blocks.length, 4); assert.ok(blocks[3].startsWith('=== BÀI HỌC SỬA LỖI DFY'));
  assert.equal(knowledgeBlocks({ checklist: 'c' }).length, 3, 'no lessons → no lessons block');
  const prompt = analysisPrompt(parsedSample, know, { ticket: { reference: 'ACCS-1' } });
  assert.ok(prompt.includes('=== CHECKLIST DFY') && prompt.includes('=== BÀI HỌC SỬA LỖI DFY') && prompt.includes('kiến thức đã kiểm chứng'));
  assert.ok(prompt.length < 80_000, `analysis prompt ${prompt.length} chars`);
  assert.ok(analysisPrompt(parsedSample, 'plain string checklist').includes('plain string checklist'), 'old string form still accepted');
});

test('codex binary is resolved to an absolute path even when PATH lacks ~/.local/bin (boot-time service, exit 127)', () => {
  assert.equal(resolveCodexBin({ env: { PATH: '/usr/bin', CODEX_BIN: '/opt/x/codex' } }), '/opt/x/codex', 'CODEX_BIN wins');
  const found = resolveCodexBin({ env: { PATH: '/usr/bin' } });
  assert.ok(found === 'codex' || found.startsWith('/'), found);
  assert.equal(resolveCodexBin({ env: { PATH: '/nonexistent' }, home: '/nonexistent' }), 'codex', 'bare name when nothing is found');
});

test('ticket list progress: statuses weighted by their page count (last load or default), a running status never completes', async () => {
  const { dfuProgressPercent } = await import('./ts-management-web.mjs');
  assert.equal(dfuProgressPercent({ pending: { pages: 0, done: false }, done: { pages: 0, done: false } }), 0);
  // defaults: pending 2 pages, done 20 → pending finished = 2/22
  assert.equal(dfuProgressPercent({ pending: { pages: 1, done: true }, done: { pages: 0, done: false } }), 9);
  assert.equal(dfuProgressPercent({ pending: { pages: 1, done: true }, done: { pages: 10, done: false } }), 55, 'half of the long list read');
  assert.equal(dfuProgressPercent({ pending: { pages: 1, done: true }, done: { pages: 20, done: false } }), 98, 'never 100 while running');
  assert.equal(dfuProgressPercent({ pending: { pages: 1, done: true }, done: { pages: 20, done: true } }), 100);
  // history from the previous load replaces the defaults
  assert.equal(dfuProgressPercent({ pending: { pages: 1, done: true, weight: 1 }, done: { pages: 6, done: false, weight: 12 } }), 54);
});
