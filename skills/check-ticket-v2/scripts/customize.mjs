// Pure helpers for Customize tickets (13/10/2026, user order "cần đưa ra css code": a Customize report must carry a
// complete, copy-ready code block built on real selectors). Shared by the tools server (css_preview), the prompts,
// the verify phase and the postcheck; no I/O here so everything is unit-testable.

// Fenced code blocks in a comment body: ```lang\n…\n```.
export const CODE_FENCE = /```([a-zA-Z0-9_-]*)[^\n]*\n([\s\S]*?)```/g;
export const CODE_LANG_ALIASES = { css: 'css', scss: 'css', less: 'css', js: 'js', javascript: 'js', liquid: 'liquid', html: 'html' };

// Subject/description words that mean "change how it looks" (the Customize category, decided by the investigator later;
// this early hint only switches the browser tools on so the DOM can be read).
const CUSTOMIZE_WORDS = /\[customize\]|customi[sz]e|custom css|tùy chỉnh|tuỳ chỉnh|chỉnh sửa giao diện|đổi màu|ẩn\b|hide|căn (?:trái|phải|giữa)|align|font|color|màu|kích thước|size|vị trí|position|style|giao diện|layout/i;
export function customizeHint(ticket = {}) {
  return CUSTOMIZE_WORDS.test(`${ticket.subject || ''}\n${ticket.description || ''}`);
}

// All fenced blocks of a body → [{ lang, code }], lang normalised (scss → css, javascript → js, '' when unknown).
export function codeBlocks(body) {
  const blocks = [];
  for (const match of String(body || '').matchAll(CODE_FENCE)) {
    const lang = CODE_LANG_ALIASES[String(match[1] || '').toLowerCase()] || String(match[1] || '').toLowerCase();
    const code = String(match[2] || '').trim();
    if (code) blocks.push({ lang, code });
  }
  return blocks;
}

// Selectors named in a stylesheet (text before each `{`, split on commas; at-rules skipped), max 10.
export function selectorsFromCss(css) {
  const out = [];
  const body = String(css || '').replace(/\/\*[\s\S]*?\*\//g, '');
  const rule = /([^{}]+)\{[^{}]*\}/g;
  let match;
  while ((match = rule.exec(body)) && out.length < 10) {
    const head = match[1].trim();
    if (!head || head.startsWith('@')) continue;
    for (const part of head.split(',')) { const selector = part.trim(); if (selector && !out.includes(selector)) out.push(selector); }
  }
  return out.slice(0, 10);
}

// Code the investigator submitted (finding.code, plus details/quote where older findings stashed code), one pool to
// check the writer's blocks against so the writer cannot invent CSS the investigation never produced.
export function findingCodePool(findings = []) {
  return findings.map(finding => [finding?.code, finding?.details, finding?.quote].filter(value => typeof value === 'string').join('\n')).join('\n');
}

const normalizeLine = value => String(value).replace(/\s+/g, ' ').replace(/\s*([{}:;,>!])\s*/g, '$1').trim().toLowerCase();

// Lines of a body code block that no finding carries. Blank lines and comment-only lines are ignored.
export function missingCodeLines(code, pool) {
  const haystack = normalizeLine(pool);
  return String(code).split('\n').map(normalizeLine).filter(line => line && !/^\/\*.*\*\/$/.test(line) && !/^\/\//.test(line)).filter(line => !haystack.includes(line));
}

// --- CSS writing rules (14/10/2026, user order: "hạn chế !important mà dùng class cha …, nếu class cha không thể ưu tiên
// css thì mới dùng !important; khi css không sử dụng id dạng số, biến động hoặc class id của element đó, ví dụ #1234545") ---
// Pure helpers shared by submit_findings (schema.validateFindings), the postcheck, css_preview and the prompts.

// Text that explains why `!important` was needed (written by the investigator in details/claim or by the writer in the body).
export const IMPORTANT_REASON = /class cha[^.\n]{0,80}?(?:không|chưa|vẫn)[^.\n]{0,40}?(?:thắng|ưu tiên|đủ|áp dụng)|(?:vẫn|bị|đang|còn)\s+(?:bị\s+)?ghi đè|độ ưu tiên|specificity|inline style|style=|theme (?:dùng|có|đặt|set)\s+!important|!important (?:của|trong|từ) theme|không thắng được|overridden|override|thắng được rule của theme|rule của theme (?:thắng|đè)/i;
export const importantReason = text => IMPORTANT_REASON.test(String(text || ''));

// Rules of a stylesheet, innermost blocks (so rules inside @media count): [{ head, selectors[], declarations[{property, value, important}], important }].
export function cssRules(css) {
  const body = String(css || '').replace(/\/\*[\s\S]*?\*\//g, '');
  const out = [];
  const rule = /([^{}]+)\{([^{}]*)\}/g;
  let match;
  while ((match = rule.exec(body))) {
    const head = match[1].trim();
    if (!head || head.startsWith('@')) continue;
    const selectors = head.split(',').map(part => part.trim()).filter(Boolean);
    const declarations = match[2].split(';').map(part => part.trim()).filter(Boolean).map(part => {
      const index = part.indexOf(':');
      if (index < 1) return null;
      const value = part.slice(index + 1).trim();
      return { property: part.slice(0, index).trim().toLowerCase(), value: value.replace(/\s*!\s*important\s*$/i, '').trim(), important: /!\s*important\s*$/i.test(value) };
    }).filter(Boolean);
    out.push({ head, selectors, declarations, important: declarations.filter(item => item.important).length });
  }
  return out;
}

// (ids, classes+attributes+pseudo-classes, elements+pseudo-elements) of one selector; :not/:is/:where/:has are not counted themselves.
export function specificity(selector) {
  let text = String(selector || '').trim();
  let a = 0; let b = 0; let c = 0;
  text = text.replace(/\[[^\]]*\]/g, () => { b++; return ' '; });
  text = text.replace(/::[a-zA-Z-]+(\([^)]*\))?/g, () => { c++; return ' '; });
  text = text.replace(/:(not|is|where|has)\(/gi, ' (');
  text = text.replace(/:[a-zA-Z-]+(\([^)]*\))?/g, () => { b++; return ' '; });
  text = text.replace(/#[A-Za-z0-9_-]+/g, () => { a++; return ' '; });
  text = text.replace(/\.[A-Za-z0-9_-]+/g, () => { b++; return ' '; });
  for (const token of text.split(/[\s>+~(),]+/)) if (/^[a-zA-Z][a-zA-Z0-9-]*$/.test(token) && token !== '*') c++;
  return [a, b, c];
}

// Opaque / unstable name test for one id or class name (without # or .). Stable app names with a short number in them
// (.AirReviews-Widget__V2, .Joy-Wishlist-BlockStack--Gap-400, .Sea-Accessibility-text_size_125, .statusBlock2025) pass.
const WORD_THEN_NUMBER = /^[a-z]+\d+$/i; const NUMBER_THEN_WORD = /^\d+[a-z]+$/i;
export function unstableName(name) {
  const value = String(name || '');
  if (/^\d/.test(value)) return 'bắt đầu bằng chữ số';
  if (/template--/i.test(value)) return 'tên do theme sinh theo template (template--…), đổi khi đổi theme/section';
  if (/^shopify-section-.*\d/i.test(value) || /^shopify-block-/i.test(value)) return 'tên section/block do theme sinh tự động';
  if (/\d{5,}/.test(value)) return 'chứa dãy ≥ 5 chữ số (id sản phẩm/biến thể/thời gian)';
  if (/(^|[-_])(product|variant|block|section|collection|article|customer|order|shop|store|id)[-_]?\d{3,}/i.test(value)) return 'chứa id số của product/variant/block/section';
  if (/^css-[a-z0-9]{4,}$/i.test(value) || /^sc-[A-Za-z]{6,}$/.test(value) || /^jsx-\d+$/.test(value) || /^_[a-z0-9]{5,}$/i.test(value) || /^[a-z]+_[a-z0-9]{5,}__/i.test(value)) return 'class sinh tự động (CSS-in-JS / CSS module)';
  for (const segment of value.split(/[-_]+/)) {
    if (segment.length >= 6 && /^[a-z0-9]+$/.test(segment) && (segment.match(/\d/g) || []).length >= 2 && (segment.match(/[a-z]/g) || []).length >= 2 && !WORD_THEN_NUMBER.test(segment) && !NUMBER_THEN_WORD.test(segment)) return `đoạn "${segment}" giống hash sinh tự động`;
    if (segment.length >= 8 && /^[0-9a-f]+$/i.test(segment) && /\d/.test(segment) && /[a-f]/i.test(segment)) return `đoạn "${segment}" giống hash hex`;
  }
  return null;
}

export const SELECTOR_SUGGESTION = 'dùng class cha ổn định của app/theme rồi class con (ví dụ `.AirReviews-Widget .AirReviews-Blocks__List`, `#shopify-section-header .header__icon`), hoặc data-attribute ổn định (`[data-block-type="reviews"] .stars`); không dùng id số/biến động hay class riêng của một element';

// Lint one stylesheet against the user's CSS rules. errors → the code is refused (submit_findings / postcheck for ids);
// warnings → advice only. `importantCount` lets the caller demand a reason when > 0.
export function lintCss(css) {
  const errors = []; const warnings = []; const selectors = [];
  const rules = cssRules(css);
  let importantCount = 0;
  const seen = new Set();
  for (const rule of rules) {
    importantCount += rule.important;
    for (const selector of rule.selectors) {
      if (seen.has(selector)) continue; seen.add(selector);
      const spec = specificity(selector);
      const tokens = [...selector.matchAll(/([#.])([A-Za-z0-9_-]+)/g)].map(match => ({ kind: match[1] === '#' ? 'id' : 'class', name: match[2], token: match[0] }));
      const problems = [];
      for (const token of tokens) {
        const why = unstableName(token.name);
        if (why) problems.push({ token: token.token, why: `${token.kind === 'id' ? 'id' : 'class'} ${why}` });
      }
      for (const match of selector.matchAll(/\[[^\]]*?=\s*["']?(\d{3,})["']?\s*\]/g)) problems.push({ token: match[0], why: 'attribute so với một id số' });
      for (const problem of problems) errors.push({ selector, token: problem.token, kind: 'unstable_selector', message: `selector "${selector}": ${problem.token} là ${problem.why}`, suggestion: SELECTOR_SUGGESTION });
      const compounds = selector.replace(/\[[^\]]*\]/g, '[]').replace(/\([^)]*\)/g, '()').split(/\s*[\s>+~]\s*/).filter(Boolean);
      if (!problems.length) {
        if (compounds.length === 1 && spec[0] === 0 && spec[1] === 0) warnings.push({ selector, kind: 'tag_only', message: `selector "${selector}" chỉ có tên tag: dễ đụng cả trang, nên thêm class cha của app/theme` });
        else if (compounds.length === 1 && spec[0] === 0) warnings.push({ selector, kind: 'shallow', message: `selector "${selector}" không có class cha: dễ thua rule của theme, nên viết dạng \`.<class cha ổn định> ${selector}\` trước khi nghĩ tới !important` });
      }
      selectors.push({ selector, specificity: spec, compounds: compounds.length, unstable: problems.length > 0 });
    }
  }
  if (!rules.length && String(css || '').trim()) warnings.push({ selector: null, kind: 'unparsed', message: 'không tách được rule CSS nào (thiếu dấu { } ?)' });
  return { errors, warnings, importantCount, selectors, rules };
}

// The CSS pieces of a findings submission (code_lang css, or code that looks like CSS).
export const looksLikeCss = code => /\{[^}]*:[^}]*\}/.test(String(code || '')) && !/\bfunction\b|=>|\bconst\b|\blet\b|<\/?[a-z]+>|\{\{|\{%/.test(String(code || ''));

// --- "CSS nộp = CSS đã thử" (14/10/2026, user order "Sau khi hoàn thành css thì bạn hãy dùng mcp để test lại xem có apply
// được đúng ko … chỉ cần test ở phía bạn để đảm bảo css đó work đúng như mong đợi") -------------------------------------
// css_preview records each trial in its tool-log entry (`trial`); submit_findings refuses a CSS block that no trial
// tried, or whose trial still has a property really overridden (✗); verify/postcheck annotate and warn.

// Whitespace/comment-insensitive form used to compare the submitted block with a tried block. Case-insensitive on purpose:
// only the rules matter, not how the model typed them.
export function normalizeCss(css) {
  return String(css || '').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\s+/g, ' ').replace(/\s*([{}:;,>~+!])\s*/g, '$1').replace(/;+}/g, '}').replace(/;;+/g, ';').trim().toLowerCase();
}

// The sentence that explains why the storefront could not be tried (kept from the 13/10/2026 rule).
export const UNTRIED_REASON = /(?:chưa|không)\s+(?:thể\s+)?(?:thử|kiểm thử|test)\s+(?:được\s+)?trên\s+storefront/i;
export const untriedReason = text => UNTRIED_REASON.test(String(text || ''));

// Trials from a tool log (entries written by tools-server css_preview with a `trial` field), oldest first.
export function cssTrialsFromLog(toolLog) {
  return (toolLog || []).filter(entry => entry && (entry.tool === 'css_preview' || entry.tool === 'mcp_v2_read' && entry.args?.tool === 'ts_local_browser' && entry.args?.arguments?.action === 'try_css') && entry.trial && typeof entry.trial === 'object').map(entry => ({ seq: entry.seq, round: entry.round, at: entry.at, ok: entry.ok !== false, ...entry.trial }));
}

// Was the last css_preview call (tried or not) unusable: tool error, password page, HTTP error, every selector 0 elements?
export function lastCssCallUnusable(toolLog) {
  const calls = (toolLog || []).filter(entry => entry && (entry.tool === 'css_preview' || entry.tool === 'mcp_v2_read' && entry.args?.tool === 'ts_local_browser' && entry.args?.arguments?.action === 'try_css'));
  const last = calls[calls.length - 1];
  if (!last) return null;
  if (last.ok === false) return `lần css_preview cuối (seq ${last.seq}) lỗi`;
  if (last.trial?.unusable) return `lần css_preview cuối (seq ${last.seq}): ${last.trial.unusable}`;
  return null;
}

// The trial whose CSS equals `code` (normalised); the latest one wins. Returns null when none matches.
export function matchCssTrial(code, trials) {
  const wanted = normalizeCss(code);
  if (!wanted) return null;
  for (const trial of [...(trials || [])].reverse()) if (trial && normalizeCss(trial.css) === wanted) return trial;
  return null;
}

const isCssFinding = finding => {
  const code = typeof finding?.code === 'string' ? finding.code : '';
  if (!code.trim()) return false;
  if (finding.code_lang) return finding.code_lang === 'css';
  return looksLikeCss(code);
};

// Problems for submit_findings. ctx: { cssTrials, browserAllowed, budgetLeft, lastUnusable }. A finding escapes the rule
// only with the "chưa thử được trên storefront vì …" sentence AND a real reason the page could not be tried (browser off,
// budget used up, last call unusable); with the browser on and budget left, that sentence is refused too.
export function cssTrialProblems(findings, ctx = {}) {
  const problems = [];
  const trials = (ctx.cssTrials || []).filter(trial => trial.ok !== false);
  const last = trials[trials.length - 1] || null;
  const budgetLeft = Number.isFinite(ctx.budgetLeft) ? ctx.budgetLeft : 0;
  const cannotTry = ctx.browserAllowed === false ? 'browser tắt cho ticket này' : budgetLeft <= 0 ? 'đã hết lượt css_preview' : ctx.lastUnusable || null;
  (Array.isArray(findings) ? findings : []).forEach((finding, index) => {
    if (!isCssFinding(finding)) return;
    const where = `findings[${index}]${finding.id ? ` (${finding.id})` : ''}.code`;
    const untried = untriedReason(`${finding.details || ''}\n${finding.claim || ''}`);
    const match = matchCssTrial(finding.code, trials);
    if (match) {
      const overridden = (match.overridden || []).map(item => (typeof item === 'string' ? item : `${item.selector} → ${item.property}`));
      if (overridden.length) problems.push(`${where}: khối này đã thử ở css_preview seq ${match.seq} nhưng còn thuộc tính ✗ bị ghi đè thật: ${overridden.join(', ')} → sửa CSS (thêm class cha ổn định trước, !important có lý do nếu vẫn ✗) rồi css_preview lại đúng bản sửa và nộp đúng bản đó`);
      return;
    }
    if (untried && cannotTry) return; // honest "chưa thử được trên storefront vì …" with a real reason
    const tried = last ? `Bản thử cuối (css_preview seq ${last.seq}${last.mobile ? ', mobile' : ''}${(last.overridden || []).length ? `, còn ✗: ${last.overridden.map(item => (typeof item === 'string' ? item : item.property)).join(', ')}` : ', mọi thuộc tính đo được ✓'}):\n\`\`\`css\n${String(last.css || '').slice(0, 2000)}\n\`\`\`` : 'Chưa có lần css_preview nào trong lượt này.';
    if (untried) problems.push(`${where} ghi "chưa thử được trên storefront" nhưng browser đang bật và còn ${budgetLeft} lượt css_preview → chạy css_preview với đúng khối này rồi nộp lại; câu đó chỉ dùng khi browser tắt, hết lượt hay lần thử cuối lỗi/trang mật khẩu`);
    else if (cannotTry) problems.push(`${where}: CSS nộp chưa được thử (${cannotTry}) → ghi vào details câu "chưa thử được trên storefront vì ${cannotTry}" nếu giữ khối này${last ? ', hoặc nộp đúng khối đã thử cuối' : ''}. ${tried}`);
    else problems.push(`${where}: CSS nộp khác bản đã thử; chạy css_preview với đúng khối này (còn ${budgetLeft} lượt) rồi nộp lại, hoặc nộp đúng khối đã thử. ${tried}`);
  });
  return problems;
}
