import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkWriterOutput, checkCustomizeCode, composeComment, letterFindingAllowed, OPENING } from './postcheck.mjs';
import { codeBlocks, missingCodeLines, selectorsFromCss, customizeHint, findingCodePool } from './customize.mjs';

const settings = { commentMaxChars: 4000, commentMinChars: 40, letterMinScore: 0.9 };
// Generic fixture is a Bug: Customize has its own code-block rule (13/10/2026), tested below.
const verified = {
  category: 'Bug',
  findings: [
    { id: 'F1', kind: 'fact', verified: true, inference: false, score: 1 },
    { id: 'F2', kind: 'fact', verified: true, inference: true, score: 1 },
    { id: 'G1', kind: 'gap', verified: false, inference: false, score: null },
    { id: 'T1', kind: 'fact', verified: true, inference: false, score: 0.7 },
  ],
};

test('accepts a clean body whose claims map to verified findings', () => {
  const body = 'Khối redeem chưa hiện vì selector mặc định không khớp drawer của theme.\n- Adapter tìm phần tử cart-drawer mặc định.\n- Suy luận: drawer custom không có tag này nên không có chỗ gắn.';
  const result = checkWriterOutput({
    body,
    claims: [
      { text: 'Adapter tìm phần tử cart-drawer mặc định.', finding_ids: ['F1'], inference: false },
      { text: 'Suy luận: drawer custom không có tag này nên không có chỗ gắn.', finding_ids: ['F2'], inference: true },
    ],
    customer_letter: 'Hi, the block looks for a cart-drawer element by default.',
    letter_finding_ids: ['F1'],
  }, verified, settings);
  assert.deepEqual(result.violations, []);
  assert.equal(result.ok, true);
});

test('rejects provider names, personal address, headings, bold, Sources, opening lines and greetings', () => {
  const body = `${OPENING}\n# Kết luận\n**Quan trọng**: theo TS Elite 2 thì Hachimi thấy lỗi.\nSources: a\n`;
  const result = checkWriterOutput({ body, claims: [{ text: 'theo TS Elite 2 thì Hachimi thấy lỗi.', finding_ids: ['F1'], inference: false }], customer_letter: null, letter_finding_ids: [] }, verified, settings);
  for (const needle of ['Elite', 'xưng hô', 'Markdown', 'in đậm', 'Sources', 'mở đầu cố định']) assert.ok(result.violations.some(item => item.includes(needle)), `missing violation for ${needle}`);
});

test('rejects claims not in body, unknown ids, gap-only claims without inference; a letter on weak findings is dropped with a warning', () => {
  const body = 'Chưa rõ nguyên nhân chậm, cần dev xem log. Khách đã bật embed theo ticket.';
  const result = checkWriterOutput({
    body,
    claims: [
      { text: 'Câu này không có trong body.', finding_ids: ['F1'], inference: false },
      { text: 'Chưa rõ nguyên nhân chậm, cần dev xem log.', finding_ids: ['G1'], inference: false },
      { text: 'Khách đã bật embed theo ticket.', finding_ids: ['X9'], inference: false },
    ],
    customer_letter: 'We found the cause.',
    letter_finding_ids: ['G1', 'T1'],
  }, verified, settings);
  assert.ok(result.violations.some(item => item.includes('không có nguyên văn')));
  assert.ok(result.violations.some(item => item.includes('inference=false')));
  assert.ok(result.violations.some(item => item.includes('không tồn tại: X9')));
  assert.ok(!result.violations.some(item => item.includes('thư khách')), 'letter problems are warnings, not violations (12/10/2026)');
  assert.ok(result.warnings.some(item => item.includes('bỏ thư khách') && item.includes('thư khách dùng G1')), 'gap without reply_needed cannot carry a letter');
  assert.ok(result.warnings.some(item => item.includes('thư khách dùng T1')), 'ticket-only fact (0.7) is below the letter threshold');
  assert.equal(result.letter, null, 'the letter is dropped');
});

test('a letter resting on weak findings never blocks an otherwise clean body: ok=true, letter=null, warnings listed (AIR-261011-XRfXC3 case)', () => {
  const verified = { category: 'Bug', findings: [
    { id: 'F1', kind: 'fact', verified: true, inference: false, score: 0.7 },
    { id: 'F7', kind: 'gap', verified: false, inference: false, score: null, reply_needed: false, gap_ok: true },
    { id: 'F8', kind: 'suggestion', verified: true, inference: false, score: 0.7 },
  ] };
  const body = 'Khách đã xoá và thêm lại block nhưng vẫn báo lỗi; cần xác định đúng block và theme trước khi sửa.';
  const result = checkWriterOutput({ body, claims: [{ text: body, finding_ids: ['F1'], inference: false }], customer_letter: 'Please send a new collaborator code.', letter_finding_ids: ['F1', 'F8'] }, verified, settings);
  assert.deepEqual(result.violations, []);
  assert.equal(result.ok, true);
  assert.equal(result.letter, null);
  assert.equal(result.warnings.length, 2);
  for (const needle of ['bỏ thư khách: thư khách dùng F1', 'bỏ thư khách: thư khách dùng F8']) assert.ok(result.warnings.some(item => item.includes(needle)), needle);
  const provider = checkWriterOutput({ body, claims: [{ text: body, finding_ids: ['F1'], inference: false }], customer_letter: 'TS Elite found it.', letter_finding_ids: ['F1'] }, verified, settings);
  assert.equal(provider.ok, true); assert.equal(provider.letter, null);
  assert.ok(provider.warnings.some(item => item.includes('nguồn phân tích')));
  const noIds = checkWriterOutput({ body, claims: [{ text: body, finding_ids: ['F1'], inference: false }], customer_letter: 'Hello.', letter_finding_ids: [] }, verified, settings);
  assert.equal(noIds.letter, null); assert.ok(noIds.warnings.some(item => item.includes('không gắn letter_finding_ids')));
  const none = checkWriterOutput({ body, claims: [{ text: body, finding_ids: ['F1'], inference: false }], customer_letter: null, letter_finding_ids: [] }, verified, settings);
  assert.deepEqual(none.warnings, []); assert.equal(none.letter, null);
});

test('an information-request letter may rest on a gap with reply_needed=true (and a verified fact), not on other gaps', () => {
  const verified = { category: 'Bug', findings: [
    { id: 'F1', kind: 'fact', verified: true, inference: false, score: 1 },
    { id: 'F7', kind: 'gap', verified: false, inference: false, score: null, reply_needed: true, gap_ok: true, blocker: 'shop_access' },
    { id: 'G2', kind: 'gap', verified: false, inference: false, score: null, reply_needed: true, gap_ok: false },
    { id: 'G3', kind: 'gap', verified: false, inference: false, score: null, reply_needed: null, gap_ok: true },
  ] };
  const body = 'Chưa xác định được block lỗi thuộc app nào; cần khách cấp quyền Themes để TS kiểm tra tiếp.';
  const claims = [{ text: body, finding_ids: ['F7'], inference: true }];
  const letter = 'Please send a new 4-digit collaborator request code and grant access to Online Store → Themes.';
  const ok = checkWriterOutput({ body, claims, customer_letter: letter, letter_finding_ids: ['F7'] }, verified, settings);
  assert.equal(ok.ok, true); assert.equal(ok.letter, letter); assert.deepEqual(ok.warnings, []);
  const mixed = checkWriterOutput({ body, claims, customer_letter: letter, letter_finding_ids: ['F1', 'F7'] }, verified, settings);
  assert.equal(mixed.letter, letter); assert.deepEqual(mixed.warnings, []);
  assert.equal(letterFindingAllowed(verified.findings[2], settings), false, 'gap without a valid reason');
  assert.equal(letterFindingAllowed(verified.findings[3], settings), false, 'gap without reply_needed');
  const bad = checkWriterOutput({ body, claims, customer_letter: letter, letter_finding_ids: ['G2'] }, verified, settings);
  assert.equal(bad.ok, true); assert.equal(bad.letter, null); assert.ok(bad.warnings.some(item => item.includes('thư khách dùng G2')));
  const bad3 = checkWriterOutput({ body, claims, customer_letter: letter, letter_finding_ids: ['G3'] }, verified, settings);
  assert.equal(bad3.letter, null);
});

test('composeComment adds the two fixed opening lines', () => {
  assert.equal(composeComment('Bug', ' body '), `${OPENING}\nĐây là loại ticket gì : Bug\n\nbody`);
});

test('an inference claim may state plainly what is unverified or needed (chưa xác minh / cần dev) instead of "suy luận"', () => {
  const verified = { category: 'Bug', summary: 's', findings: [{ id: 'G1', kind: 'gap', claim: 'Chưa xem được log', blocker: 'dev', gap_ok: true, verified: false, inference: false, score: null }], stats: { total: 1 } };
  const settings = { commentMaxChars: 4000, commentMinChars: 20, letterMinScore: 0.9 };
  const make = text => ({ body: `${text}\nThêm một câu tình huống cho đủ độ dài tối thiểu của body.`, claims: [{ text, finding_ids: ['G1'], inference: true }], customer_letter: null, letter_finding_ids: [] });
  for (const text of ['Chưa xác minh kết quả bằng browser vì ticket không có URL công khai.', 'Cần dev đối chiếu log của job để biết vì sao không chạy.', 'TS cần xin quyền app/shop từ người có thẩm quyền để kiểm tra tiếp.', 'Chưa có cơ sở khẳng định thêm Liquid sẽ lấy được PO.',
    'Khi có quyền, cần TS đối chiếu theme editor với theme live, đọc `templates/product*.json` để xác định chủ sở hữu block.', 'Cần TS kiểm tra app embed và `showProductPageBlock` trên cùng theme/product để làm rõ nguyên nhân.', 'Việc này cần PM xác nhận trước.', 'Review Box đang được kiểm tra; nguyên nhân block báo không tìm thấy chưa được xác nhận.', 'Chưa rõ bên nào render ba review này.']) {
    const check = checkWriterOutput(make(text), verified, settings);
    assert.ok(!check.violations.some(item => item.includes('là suy luận nhưng')), `${text} → ${check.violations.join(' | ')}`);
  }
  for (const text of ['Lỗi là do cron bị tắt.', 'Khách cầnx bật lại embed theo hướng dẫn.']) {
    const hidden = checkWriterOutput(make(text), verified, settings);
    assert.ok(hidden.violations.some(item => item.includes('là suy luận nhưng')), `a bare assertion on a gap is still rejected: ${text}`);
  }
});

// --- Customize must ship a code block (13/10/2026, user order "cần đưa ra css code" after AIR-261013-cSz4B8) ---------
const CSS = '#AirReviews-BlockWrapper .AirReviews-Blocks--Rate,\n#AirReviews-BlockWrapper .AirReviews-Blocks--List { display: none !important; }\n#AirReviews-BlockWrapper .AirReviews-Blocks--Actions { margin-left: 0 !important; text-align: left !important; }';
const customize = {
  category: 'Customize', infeasible_reason: null,
  findings: [
    { id: 'F2', kind: 'fact', verified: true, inference: false, score: 0.6, quote: '- #AirReviews-BlockWrapper .AirReviews-Blocks--Rate: 1 phần tử, 1 hiển thị → 1 phần tử, 0 hiển thị, display none' },
    { id: 'F6', kind: 'suggestion', verified: true, inference: false, score: 0.9, offer_fix: true, code: CSS, code_lang: 'css', details: 'Dán vào DevZone → Custom CSS for review box.' },
  ],
};
const customizeBody = code => `Khách muốn ẩn thống kê review và giữ nút viết review bên trái.\n\nDán CSS dưới đây vào DevZone, trường \`Custom CSS for review box\`:\n\n\`\`\`css\n${code}\n\`\`\`\n\nĐã thử trên trang sản phẩm: khối thống kê ẩn, vùng viết review còn hiển thị.`;
const customizeClaims = [
  { text: 'Dán CSS dưới đây vào DevZone, trường `Custom CSS for review box`:', finding_ids: ['F6'], inference: false },
  { text: 'Đã thử trên trang sản phẩm: khối thống kê ẩn, vùng viết review còn hiển thị.', finding_ids: ['F2'], inference: false },
];

test('Customize: a body without a fenced code block is rejected, unless the investigation set infeasible_reason', () => {
  const prose = 'Khách muốn ẩn thống kê review. Đề xuất dùng CSS giới hạn trong #AirReviews-BlockWrapper để ẩn .AirReviews-Blocks--Rate (CSS khởi điểm chưa được kiểm thử).';
  const result = checkWriterOutput({ body: prose, claims: [{ text: prose, finding_ids: ['F6'], inference: false }], customer_letter: null, letter_finding_ids: [] }, customize, settings);
  assert.equal(result.ok, false);
  assert.ok(result.violations.some(item => item.includes('không có khối code')), result.violations.join(' | '));
  const infeasible = { ...customize, infeasible_reason: 'Yêu cầu đổi logic tính điểm, không làm được bằng CSS/JS.', findings: [{ id: 'G1', kind: 'gap', blocker: 'dev', gap_ok: true, verified: false, inference: false, score: null }] };
  const body = 'Yêu cầu này đổi cách tính điểm nên không làm được bằng CSS/JS; cần dev xem xét như feature.';
  const ok = checkWriterOutput({ body, claims: [{ text: body, finding_ids: ['G1'], inference: true }], customer_letter: null, letter_finding_ids: [] }, infeasible, settings);
  assert.deepEqual(ok.violations, []);
  const bug = checkWriterOutput({ body: prose, claims: [{ text: prose, finding_ids: ['F1'], inference: false }], customer_letter: null, letter_finding_ids: [] }, verified, settings);
  assert.ok(!bug.violations.some(item => item.includes('khối code')), 'other categories are not asked for code');
});

test('Customize: the code block copied from finding.code passes; code lines are not claims; re-indented copies pass', () => {
  const result = checkWriterOutput({ body: customizeBody(CSS), claims: customizeClaims, customer_letter: null, letter_finding_ids: [] }, customize, settings);
  assert.deepEqual(result.violations, []);
  assert.equal(result.ok, true);
  const reflowed = CSS.replace(/,\n/, ', ').replace('{ display', '{\n  display').replace('; }', ';\n}');
  const okReflow = checkWriterOutput({ body: customizeBody(reflowed), claims: customizeClaims, customer_letter: null, letter_finding_ids: [] }, customize, settings);
  assert.deepEqual(okReflow.violations, [], 'whitespace/line breaks may differ');
  const codeClaim = checkWriterOutput({ body: customizeBody(CSS), claims: [...customizeClaims, { text: '#AirReviews-BlockWrapper .AirReviews-Blocks--Actions { margin-left: 0 !important; text-align: left !important; }', finding_ids: [], inference: false }], customer_letter: null, letter_finding_ids: [] }, customize, settings);
  assert.deepEqual(codeClaim.violations, [], 'a claim that is a code line is ignored, even without finding_ids');
});

test('Customize: a code block the investigation never produced is rejected (writer must not invent CSS)', () => {
  const invented = '.AirReviews-Widget { display: none; }\n.AirReviews-Form { float: left; }\n.AirReviews-Title { color: red; }\n.AirReviews-Foo { margin: 0; }';
  const result = checkWriterOutput({ body: customizeBody(invented), claims: customizeClaims, customer_letter: null, letter_finding_ids: [] }, customize, settings);
  assert.ok(result.violations.some(item => item.includes('không có trong finding nào')), result.violations.join(' | '));
  assert.deepEqual(checkCustomizeCode(codeBlocks(customizeBody(CSS + '\n/* ghi chú */')), customize), [], 'one extra comment line is within the tolerance');
  const legacy = { ...customize, findings: [{ id: 'F6', kind: 'suggestion', details: `CSS khởi điểm: ${CSS.replace(/\n/g, ' ')}` }] };
  assert.deepEqual(checkCustomizeCode(codeBlocks(customizeBody(CSS)), legacy), [], 'code stashed in details (older findings) still counts');
});

test('customize helpers: codeBlocks, selectorsFromCss, missingCodeLines, customizeHint, findingCodePool', () => {
  assert.deepEqual(codeBlocks('a\n```css\n.x { color: red }\n```\nb\n```javascript\nlet a = 1;\n```\n```\n\n```').map(block => block.lang), ['css', 'js']);
  assert.deepEqual(selectorsFromCss('/* c */ @media (max-width: 600px) { .m { display: none } } .a .b, .c:hover { x: y } .a .b { z: 1 }'), ['.m', '.a .b', '.c:hover'], 'rules inside @media are measured too');
  assert.deepEqual(missingCodeLines('.a { display: none !important; }\n.zz { color: red }', '.a{display:none!important;}'), ['.zz{color:red}']);
  assert.equal(customizeHint({ subject: '[Customize] Air Reviews - review box', description: '' }), true);
  assert.equal(customizeHint({ subject: 'Air Reviews - cron không chạy', description: 'webhook lỗi' }), false);
  assert.ok(findingCodePool(customize.findings).includes('display: none !important'));
});
