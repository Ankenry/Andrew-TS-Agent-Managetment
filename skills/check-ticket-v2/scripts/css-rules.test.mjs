// CSS writing rules of 14/10/2026 (user order: "hạn chế !important mà dùng class cha …; nếu class cha không thể ưu tiên css
// thì mới dùng !important; khi css không sử dụng id dạng số, biến động hoặc class id của element đó, ví dụ #1234545, #44492").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lintCss, specificity, unstableName, importantReason, cssRules, looksLikeCss } from './customize.mjs';
import { validateFindings, cssCodeProblems } from './schema.mjs';
import { checkWriterOutput, checkCustomizeCss } from './postcheck.mjs';
import { codeBlocks } from './customize.mjs';
import { investigatorPrompt, writerPrompt } from './prompts.mjs';

test('unstableName: numeric, template, generated and hash-like names fail; real app class names with short numbers pass', () => {
  const bad = ['1234545', '44492', 'shopify-section-template--17283928__main', 'ProductInfo-template--17283', 'Slider-template--16', 'product-12345', 'variant-98765432', 'block-3f9a1c2d', 'css-1a2b3c', 'sc-bdVaJa', 'jsx-1234', '_abc12d', 'shopify-section-123abc'];
  for (const name of bad) assert.ok(unstableName(name), `${name} should be refused`);
  const good = ['AirReviews-Widget__V2', 'AirReviews-Blocks--Rate', 'AirReviews-BlockWrapper', 'Joy-Wishlist-BlockStack--Gap-400', 'Joy-Wishlist-Text--variant-heading3xl', 'Sea-Accessibility-text_size_125', 'Avada-Faqs_Button--size-40px', 'statusBlock2025', 'joy-lpv2-skel__sh', 'shopify-section-header', 'product__info', 'header__icon', 'quantity__input', 'AVADA_JOY'];
  for (const name of good) assert.equal(unstableName(name), null, `${name} is a stable name`);
});

test('specificity counts ids, classes/attributes/pseudo-classes and elements', () => {
  assert.deepEqual(specificity('#AirReviews-BlockWrapper .AirReviews-Blocks--Rate:hover::before'), [1, 2, 1]);
  assert.deepEqual(specificity('[data-block-type="reviews"] .stars'), [0, 2, 0]);
  assert.deepEqual(specificity('div'), [0, 0, 1]);
  assert.deepEqual(specificity('.a:not(.b) > p'), [0, 2, 1]);
  assert.deepEqual(specificity('.AirReviews-Widget .AirReviews-Blocks__List'), [0, 2, 0]);
});

test('lintCss: errors for unstable selectors, warnings for shallow/tag selectors, !important counted, rules inside @media seen', () => {
  const css = `#1234545 .x { color: red !important }
.AirReviews-Blocks__List { display: none }
.AirReviews-Widget .AirReviews-Blocks__List { display: none }
[data-product-id="123456"] { margin: 0 }
p { margin: 0 }
@media (max-width: 600px) { #shopify-section-template--17283928__main .y { display: none !important } }`;
  const lint = lintCss(css);
  assert.deepEqual(lint.errors.map(error => error.token), ['#1234545', '[data-product-id="123456"]', '#shopify-section-template--17283928__main']);
  assert.ok(lint.errors.every(error => /class cha ổn định/.test(error.suggestion)), 'every error carries the replacement advice');
  assert.deepEqual(lint.warnings.map(warning => [warning.kind, warning.selector]), [['shallow', '.AirReviews-Blocks__List'], ['tag_only', 'p']]);
  assert.equal(lint.importantCount, 2);
  assert.equal(cssRules(css).length, 6);
  const clean = lintCss('.AirReviews-Widget .AirReviews-Blocks__List { display: none }\n#shopify-section-header .header__icon { color: #ff6b00 }\n[data-block-type="reviews"] .stars { opacity: 0 }');
  assert.deepEqual(clean.errors, []); assert.deepEqual(clean.warnings, []); assert.equal(clean.importantCount, 0);
  assert.equal(lintCss('.a { color: red; background: #FFB800 }').errors.length, 0, 'a hex colour value is not an id');
  assert.ok(looksLikeCss('.a { color: red }') && !looksLikeCss('const a = () => { return 1 }') && !looksLikeCss('{% if a %}<div>{{ b }}</div>{% endif %}'));
});

test('importantReason recognises the sentences that justify !important', () => {
  assert.equal(importantReason('class cha .AirReviews-Widget vẫn không thắng được rule .product__info của theme nên cần !important cho display'), true);
  assert.equal(importantReason('selector có class cha vẫn bị ghi đè bởi inline style của theme'), true);
  assert.equal(importantReason('Theme đặt !important trên .quantity__input'), true);
  assert.equal(importantReason('Dán vào DevZone → Custom CSS for review box.'), false);
  assert.equal(importantReason(''), false);
});

const finding = (code, extra = {}) => ({ id: 'S1', kind: 'suggestion', claim: 'CSS ẩn khối thống kê', quote: null, source: null, link: null, blocker: null, searched: null, reply_needed: null, offer_fix: true, details: 'Dán vào DevZone → Custom CSS for review box.', code, code_lang: 'css', ...extra });
const submission = findings => ({ category: 'Customize', category_reason: 'r', summary: 's', browser_impact: true, infeasible_reason: null, sources: [], findings });

test('validateFindings refuses CSS with unstable ids or unexplained !important, names the selector and the fix; accepts explained !important and clean CSS', () => {
  const numeric = validateFindings(submission([finding('#1234545 .AirReviews-Blocks--Rate { display: none }')]));
  assert.equal(numeric.length, 1); assert.match(numeric[0], /findings\[0\] \(S1\)\.code: selector "#1234545 \.AirReviews-Blocks--Rate": #1234545 là id bắt đầu bằng chữ số → dùng class cha ổn định/);
  const dynamic = validateFindings(submission([finding('#shopify-section-template--17283928__main .stars { opacity: 0 }')]));
  assert.match(dynamic[0], /template--/);
  const unexplained = validateFindings(submission([finding('.AirReviews-Widget .AirReviews-Blocks--Rate { display: none !important }')]));
  assert.equal(unexplained.length, 1); assert.match(unexplained[0], /dùng !important 1 lần mà details\/claim không nêu lý do/); assert.match(unexplained[0], /css_preview/);
  const explained = validateFindings(submission([finding('.AirReviews-Widget .AirReviews-Blocks--Rate { display: none !important }', { details: 'Dán vào DevZone. Class cha .AirReviews-Widget vẫn không thắng được rule .product__info của theme nên cần !important cho display.' })]));
  assert.deepEqual(explained, []);
  assert.deepEqual(validateFindings(submission([finding('.AirReviews-Widget .AirReviews-Blocks--Rate { display: none }')])), []);
  assert.deepEqual(validateFindings(submission([finding('document.querySelector("#1234545").remove()', { code_lang: 'js' })])), [], 'JS code is not linted as CSS');
  assert.deepEqual(cssCodeProblems([finding('#AirReviews-BlockWrapper .AirReviews-Blocks--Rate { display: none }', { code_lang: null })]), [], 'a stable app id is fine');
  const bug = validateFindings({ ...submission([finding('#44492 { display: none }')]), category: 'Bug' });
  assert.equal(bug.length, 1, 'the CSS rule applies to any category that ships CSS code');
});

test('postcheck: a numeric/dynamic id in the body CSS block is a violation; !important without a reason sentence and shallow selectors are warnings', () => {
  const settings = { commentMaxChars: 4000, commentMinChars: 50, letterMinScore: 0.9 };
  const css = '.AirReviews-Widget .AirReviews-Blocks--Rate { display: none !important; }';
  const verified = { category: 'Customize', infeasible_reason: null, findings: [{ id: 'S1', kind: 'suggestion', verified: true, inference: false, score: 0.9, offer_fix: true, code: css, code_lang: 'css', details: 'Class cha vẫn bị ghi đè nên cần !important.' }] };
  const body = reason => `Khách muốn ẩn khối thống kê review.\n\nDán CSS dưới đây vào DevZone, trường \`Custom CSS for review box\`:\n\n\`\`\`css\n${css}\n\`\`\`\n\n${reason}`;
  const claims = text => [{ text: 'Dán CSS dưới đây vào DevZone, trường `Custom CSS for review box`:', finding_ids: ['S1'], inference: false }, { text, finding_ids: ['S1'], inference: false }];
  const noReason = checkWriterOutput({ body: body('Đã thử trên trang sản phẩm, khối thống kê ẩn.'), claims: claims('Đã thử trên trang sản phẩm, khối thống kê ẩn.'), customer_letter: null, letter_finding_ids: [] }, verified, settings);
  assert.deepEqual(noReason.violations, []); assert.ok(noReason.warnings.some(item => /!important 1 lần nhưng body không nêu lý do/.test(item)), noReason.warnings.join(' | '));
  const withReason = checkWriterOutput({ body: body('Cần !important vì class cha .AirReviews-Widget vẫn không thắng được rule của theme cho display.'), claims: claims('Cần !important vì class cha .AirReviews-Widget vẫn không thắng được rule của theme cho display.'), customer_letter: null, letter_finding_ids: [] }, verified, settings);
  assert.deepEqual(withReason.violations, []); assert.ok(!withReason.warnings.some(item => /!important/.test(item)));
  const quotedCurrent = checkWriterOutput({ body: `CSS hiện tại của shop đọc từ storefront:\n\n\`\`\`css\ndiv#AirReviews-BlockWrapper .AirReviews-Blocks--Rate { display: none !important; }\n\`\`\`\n\nĐề xuất thay bằng khối dưới đây:\n\n\`\`\`css\n.AirReviews-Widget .AirReviews-Blocks--Rate { display: none; }\n\`\`\`\n\nĐã thử trên trang sản phẩm, khối thống kê ẩn.`, claims: [{ text: 'Đã thử trên trang sản phẩm, khối thống kê ẩn.', finding_ids: ['S1'], inference: false }], customer_letter: null, letter_finding_ids: [] }, { ...verified, findings: [{ ...verified.findings[0], code: '.AirReviews-Widget .AirReviews-Blocks--Rate { display: none; }' }] }, settings);
  assert.ok(!quotedCurrent.warnings.some(item => /!important/.test(item)), `the merchant's current CSS quoted in the body is not judged: ${quotedCurrent.warnings.join(' | ')}`);
  const numeric = checkCustomizeCss(codeBlocks('```css\n#1234545 .x { display: none }\n```'), 'x');
  assert.equal(numeric.violations.length, 1); assert.match(numeric.violations[0], /#1234545 là id bắt đầu bằng chữ số/);
  const shallow = checkCustomizeCss(codeBlocks('```css\n.AirReviews-Blocks__List { display: none }\n```'), 'x');
  assert.deepEqual(shallow.violations, []); assert.match(shallow.warnings[0], /không có class cha/);
  assert.deepEqual(checkCustomizeCss(codeBlocks('```js\nconsole.log("#1234545")\n```'), 'x'), { violations: [], warnings: [] }, 'JS blocks are not linted');
});

test('prompts carry the CSS rules for the investigator and the !important reason rule for the writer', () => {
  const prep = { reference: 'AIR-1', ticket: { ticketId: 'AIR-1', subject: '[Customize] ẩn review', description: 'd', comments: [], storeDomains: ['a.myshopify.com'] }, app: { slug: 'air-reviews', kb: 'air-reviews', codeRoot: null, kbRoots: [], by: 'appName', appConflict: null }, scope: { locked: true, kbRoots: [], commonRoots: [], codeRoot: null }, customizeHint: true, oldCases: [], lessons: [], imageLinks: [] };
  const prompt = investigatorPrompt(prep, { deadline: Date.now() + 1000, maxTurns: 25, browserAllowed: true, sourceApi: true });
  assert.match(prompt, /Luật viết CSS \(14\/10\/2026/); assert.match(prompt, /KHÔNG dùng id dạng số hay biến động/); assert.match(prompt, /HẠN CHẾ !important/); assert.match(prompt, /ghi lý do vào details/);
  const withImportant = writerPrompt(prep, { category: 'Customize', summary: 's', findings: [{ id: 'S1', kind: 'suggestion', verified: true, inference: false, code: '.a .b { display: none !important }', code_lang: 'css', details: 'class cha vẫn bị ghi đè' }] }, { maxChars: 4000, minChars: 150 });
  assert.match(withImportant, /Code có !important: body phải có một câu nêu lý do chép từ details của S1/);
  const without = writerPrompt(prep, { category: 'Customize', summary: 's', findings: [{ id: 'S1', kind: 'suggestion', verified: true, inference: false, code: '.a .b { display: none }', code_lang: 'css' }] }, { maxChars: 4000, minChars: 150 });
  assert.match(without, /Code không dùng !important: không tự thêm/);
});
