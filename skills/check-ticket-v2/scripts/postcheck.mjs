// Hậu kiểm pha Viết — pure code. The writer's JSON is accepted only when every claim maps to a verified
// finding, inference is labelled, the customer letter holds facts only, and the Helpdesk comment format holds.

import { isHanReport, parseHanReport, renderHelpdeskReport, helpdeskProse, reportProse } from '../../check-ticket/scripts/han-report.mjs';
import { normalizeText } from './verify.mjs';
import { checkCommentStyle } from '../../check-ticket/scripts/comment-style.mjs';
import { slackCoverage, claimsNoDevReply, noReplyAllowed, claimsCustomerSaved, technicalMessages, correctionConflicts, writerCorrectionCoverage } from './slack-evidence.mjs';
import { codeBlocks, findingCodePool, missingCodeLines, lintCss, importantReason, untriedReason } from './customize.mjs';
import { hasSettingsFinding } from './shop-settings.mjs';

export const OPENING = 'Sau khi TS check thì thấy như sau:';
const PROVIDER = /\b(?:TS[\s_-]*)?Elite(?:[\s_-]*2)?\b/i;
const ADDRESS = /Đại tá|Hoàng Thượng|Đại ca|bệ hạ|Hachimi|Hanlead|Hanlite|Hancal|Hanbui|Support by/i;
// A claim resting only on gaps/inference must say so. Sentences that state plainly what is unknown or needed
// ("chưa xác minh", "cần dev", "cần TS đối chiếu"…) are honest, not hidden inference (widened 09/10/2026; any
// "cần …" hedge accepted since 12/10/2026 — the old list missed "cần TS", Hanlead approval, báo cáo số 204).
// 14/10/2026: a suggestion written as "đề xuất …"/"khuyến nghị …" and a plain "chưa thực hiện/chạy/thử/gửi" count as hedges too (the writer prompt's hedge list names them; 41/49 rewrites were a missing hedge).
const INFERENCE_WORDS = /suy luận|có thể|chưa (?:được |hề )?(?:xác nhận|xác minh|kiểm|rõ|đủ|thực hiện|chạy|thử|gửi|áp dụng|tái hiện)|chưa thể|chưa có cơ sở|chưa chắc|khả năng|giả thuyết|có vẻ|đề xuất|khuyến nghị|gợi ý|(?:^|[^\p{L}])cần(?![\p{L}])/iu;
const prose = reportProse;

export function composeComment(category, body) {
  if (isHanReport(body)) return renderHelpdeskReport(parseHanReport(body, category));
  return `${OPENING}\nĐây là loại ticket gì : ${category}\n\n${String(body).trim()}`;
}

// output: writer JSON; verified: result of verifyFindings; settings: { commentMaxChars, commentMinChars, letterMinScore };
// style: loaded comment style (optional) whose soft checks (sentences, bullets, pronouns…) are added to the violations.
export function checkWriterOutput(output, verified, settings, style = null) {
  const violations = [];
  if (!output || typeof output !== 'object') return { ok: false, violations: ['writer không trả JSON'] };
  const body = String(output.body || '').trim();
  const plain = prose(body);
  let report = null;
  if (settings.hanReport || isHanReport(body)) {
    try { report = parseHanReport(body, verified.category); } catch (error) { violations.push(error.message); }
  }
  const byId = Object.fromEntries((verified.findings || []).map(finding => [finding.id, finding]));
  if (body.length < settings.commentMinChars) violations.push(`body quá ngắn (${body.length} < ${settings.commentMinChars})`);
  if (body.length > settings.commentMaxChars) violations.push(`body quá dài (${body.length} > ${settings.commentMaxChars})`);
  if (PROVIDER.test(plain)) violations.push('body nhắc tên nguồn phân tích (Elite)');
  if (ADDRESS.test(plain)) violations.push('body có xưng hô cá nhân/tên agent');
  if (/^\s*#{0,6}\s*Sources\s*:?\s*$/im.test(body) || /\bSources\s*:/i.test(plain)) violations.push('body có mục Sources');
  if (/^\s*#{1,6}\s/m.test(body)) violations.push('body có tiêu đề Markdown (#)');
  if (!report && /\*\*[^*\n]+\*\*/.test(body)) violations.push('body có chữ in đậm (**)');
  if (/^\s*\|.*\|\s*$/m.test(body)) violations.push('body có bảng');
  if (/@Andrew\b/i.test(body)) violations.push('body mention Andrew');
  if (new RegExp(`^${OPENING.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'm').test(body) || /Đây là loại ticket gì/i.test(body)) violations.push('body lặp lại hai dòng mở đầu cố định');
  if (!report && /^\s*(xin chào|chào|hi|hello|kính gửi)/i.test(body)) violations.push('body mở đầu bằng lời chào');
  if (!report && style?.enabled) violations.push(...checkCommentStyle(body, style.config).map(item => `phong cách: ${item}`));

  // Customize (13/10/2026, user order "cần đưa ra css code"): the body must carry the investigator's code block
  // verbatim, unless the investigation declared the request infeasible with CSS/JS. Code lines are not claims.
  const blocks = codeBlocks(body);
  if (verified.category === 'Customize') violations.push(...checkCustomizeCode(blocks, verified));
  // CSS writing rules (14/10/2026): numeric/dynamic ids in a body code block are a hard rule → violation; !important
  // without a reason sentence and shallow selectors → warnings (the writer may not rewrite code, so no rewrite loop).
  const cssCheck = verified.category === 'Customize' ? checkCustomizeCss(blocks, body, verified.findings) : { violations: [], warnings: [] };
  violations.push(...cssCheck.violations);
  const codeText = normalizeText(blocks.map(block => block.code).join('\n'));

  const claims = Array.isArray(output.claims) ? output.claims : [];
  if (!claims.length) violations.push('claims rỗng: mọi câu khẳng định phải gắn finding');
  const normalizedBody = normalizeText(body);
  violations.push(...slackCoverage(verified.slack, verified.findings || []));
  if (claimsNoDevReply(body) && !noReplyAllowed(verified.slack)) violations.push('Không có bằng chứng cho kết luận dev chưa phản hồi/cập nhật');
  if (verified.slack?.required) {
    for (const message of technicalMessages(verified.slack)) {
      const ref = message.ref;
      const ids = (verified.findings || []).filter(f => f.verified && f.source?.ref === ref).map(f => f.id);
      if (!claims.some(c => (c.finding_ids || []).some(id => ids.includes(id)))) violations.push(`Body bỏ qua phản hồi kỹ thuật Slack ${ref}`);
    }
  }
  violations.push(...writerCorrectionCoverage(verified.slack, verified.findings || [], claims));
  violations.push(...correctionConflicts(verified.slack, body));
  claims.forEach((claim, index) => {
    const label = `claims[${index}]`;
    const textValue = normalizeText(claim?.text);
    if (!textValue || textValue.length < 8) { violations.push(`${label}.text thiếu/quá ngắn`); return; }
    if (codeText && codeText.includes(textValue)) return; // a line of a code block is not a claim
    if (!normalizedBody.includes(textValue)) violations.push(`${label}.text không có nguyên văn trong body: "${String(claim.text).slice(0, 80)}"`);
    const ids = Array.isArray(claim.finding_ids) ? claim.finding_ids : [];
    if (!ids.length) violations.push(`${label} không gắn finding_ids`);
    const unknown = ids.filter(id => !byId[id]);
    if (unknown.length) violations.push(`${label} gắn finding không tồn tại: ${unknown.join(', ')}`);
    const known = ids.filter(id => byId[id]).map(id => byId[id]);
    violations.push(...correctionConflicts(verified.slack, claim.text, known.map(f => `${f.claim} ${f.quote || ""}`).join(" ")));
    if (verified.slack?.required && claimsCustomerSaved(claim.text) && !known.some(f => f.verified && claimsCustomerSaved(f.quote))) violations.push(`${label}: hướng dẫn Add/Edit/Save không chứng minh khách đã lưu`);
    const weak = known.length && known.every(finding => finding.kind === 'gap' || finding.verified === false || finding.inference);
    if (weak && !claim.inference) violations.push(`${label} chỉ dựa vào gap/finding chưa kiểm/suy luận nhưng inference=false`);
    if (claim.inference && !INFERENCE_WORDS.test(claim.text)) violations.push(`${label} là suy luận nhưng câu không ghi "suy luận"/"có thể"/"chưa xác nhận"/"chưa xác minh"/"cần …"/"đề xuất …" — câu: "${String(claim.text).slice(0, 120)}" (finding ${ids.join(', ') || '?'})`);
  });

  if (report) {
    let compact = null;
    try { compact = renderHelpdeskReport(report); } catch (error) { violations.push(error.message); }
    if (compact !== null) {
      const compactClaims = claims.filter(c => normalizeText(compact).includes(normalizeText(helpdeskProse(c.text))));
      const covered = new Set(compactClaims.flatMap(c => c.finding_ids || []));
      for (const c of claims) for (const id of c.finding_ids || []) {
        if (!covered.has(id)) violations.push(`Bản Helpdesk thiếu evidence/caveat từ ${id} trong toàn bộ báo cáo.`);
      }
      if (verified.category === 'Customize') violations.push(...checkCustomizeCode(codeBlocks(compact), verified));
      violations.push(...writerCorrectionCoverage(verified.slack, verified.findings || [], compactClaims.map(c => ({ ...c, text: helpdeskProse(c.text) }))));
      if (compact.length > 20000) violations.push('Bản Helpdesk vượt 20000 ký tự; không được cắt code/evidence.');
      if (/Xin chào cạ nhà|Han Support|(?:^|[^\p{L}])cạ nhà(?![\p{L}])/iu.test(prose(compact))) violations.push('Helpdesk dùng định dạng TS cũ, không lời chào/giọng Han Support.');
      if (/^\s*(?:\*\*|#{1,6} |\d+[.)] )/m.test(prose(compact))) violations.push('Helpdesk không giữ heading in đậm/đánh số.');
    }
  }

  // Customer letter (12/10/2026, Hanlead approval): a letter problem no longer rejects the whole output — the
  // comment still posts and the letter is dropped (letter=null) with a warning. A letter may rest on verified
  // facts at or above letterMinScore, or on a gap with reply_needed=true (a request for information the
  // merchant must answer — the letter then asks, it does not conclude).
  const { letter, warnings } = checkCustomerLetter(output, byId, settings);
  warnings.push(...cssCheck.warnings);
  // Shop configuration (13/10/2026): a settings-looking ticket should carry a finding read from the shop's real
  // configuration (shop_settings → ref settings:<app>/…). Only a warning, never a rejection, so no run is lost.
  if (verified.settingHint && !hasSettingsFinding(verified.findings)) warnings.push('ticket có dấu hiệu setting/tính năng nhưng không có finding cấu hình shop (shop_settings, ref settings:…): báo cáo chưa xác nhận setting đang bật/tắt từ cấu hình thật');
  // Follow-up after a "@bot" comment (13/10/2026): the body should answer the new comments. Warning only, never a rejection.
  if (verified.followUp?.newComments > 0 && !FOLLOW_UP_WORDS.test(plain)) warnings.push(`lượt check tiếp có ${verified.followUp.newComments} comment mới nhưng body không nhắc tới comment/phản hồi mới hay lần check trước`);
  return { ok: violations.length === 0, violations, warnings, body, letter };
}
const FOLLOW_UP_WORDS = /comment|phản hồi|check tiếp|lần (?:check|kiểm) trước|cập nhật|bổ sung|theo yêu cầu|ảnh (?:chụp|capture)|capture/i;

// Customize: at least one fenced code block, and every block must come from the findings (finding.code, or the
// details/quote of older findings). Up to a quarter of a block's lines may differ (whitespace, a comment) so a
// re-indented copy passes; more than that means the writer wrote its own code. With no code block, the output is
// accepted only when the investigation set infeasible_reason.
export function checkCustomizeCode(blocks, verified) {
  const problems = [];
  if (!blocks.length) {
    if (String(verified.infeasible_reason || '').trim()) return problems;
    problems.push('ticket Customize nhưng body không có khối code ```css/```js/```liquid: chép nguyên văn finding.code vào một khối fenced, kèm chỗ dán và kết quả đã thử trên storefront (hoặc "chưa thử được trên storefront vì …")');
    return problems;
  }
  const pool = findingCodePool(verified.findings || []);
  blocks.forEach((block, index) => {
    const lines = block.code.split('\n').filter(line => line.trim()).length;
    const missing = missingCodeLines(block.code, pool);
    if (missing.length && missing.length > Math.ceil(lines * 0.25)) problems.push(`khối code thứ ${index + 1} trong body có ${missing.length}/${lines} dòng không có trong finding nào (không tự viết code, chép nguyên văn finding.code): ${missing.slice(0, 3).map(line => line.slice(0, 80)).join(' | ')}`);
  });
  return problems;
}

// CSS blocks of the body against the 14/10/2026 CSS rules. Returns { violations, warnings }. Only the PROPOSED code is
// judged: a block that mirrors no finding.code (e.g. the merchant's current CSS quoted from shop_settings, which may well
// carry !important or odd ids) is left alone. With no coded finding at all, every block counts as a proposal.
export function checkCustomizeCss(blocks, body, findings = []) {
  const violations = []; const warnings = [];
  // CSS nộp = CSS đã thử (14/10/2026): a coded finding that matches no css_preview trial may only be described as untried.
  for (const finding of findings || []) if (finding?.css_trial && finding.css_trial.matched === false && !untriedReason(body)) warnings.push(`khối CSS của ${finding.id} không khớp bản css_preview nào đã thử (CSS nộp ≠ CSS đã thử); body phải ghi "chưa thử được trên storefront vì …" đúng như details, không mô tả như đã thử`);
  const codePool = (findings || []).map(finding => (typeof finding?.code === 'string' ? finding.code : '')).filter(Boolean).join('\n');
  const isProposal = block => { if (!codePool) return true; const lines = block.code.split('\n').filter(line => line.trim()).length; return missingCodeLines(block.code, codePool).length <= Math.floor(lines * 0.25); };
  const cssBlocks = blocks.filter(block => (block.lang === 'css' || (!block.lang && /\{[^}]*:[^}]*\}/.test(block.code))) && isProposal(block));
  if (!cssBlocks.length) return { violations, warnings };
  let important = 0;
  cssBlocks.forEach((block, index) => {
    const lint = lintCss(block.code);
    important += lint.importantCount;
    for (const error of lint.errors) violations.push(`khối CSS thứ ${index + 1}: ${error.message} (luật: không dùng id số/biến động hay class riêng của element; ${error.suggestion})`);
    for (const warning of lint.warnings) if (warning.kind !== 'unparsed') warnings.push(`khối CSS thứ ${index + 1}: ${warning.message}`);
  });
  if (important > 0 && !importantReason(prose(body))) warnings.push(`khối CSS dùng !important ${important} lần nhưng body không nêu lý do (class cha không thắng được rule của theme / vẫn bị ghi đè…): người viết chép lý do từ details của finding`);
  return { violations, warnings };
}

// Returns { letter: string|null, warnings: [] }; letter is null when none was written or when it was dropped.
export function letterFindingAllowed(finding, settings) {
  if (!finding) return false;
  if (finding.kind === 'gap') return finding.reply_needed === true && finding.gap_ok !== false;
  return finding.kind === 'fact' && finding.verified === true && !finding.inference && (finding.score ?? 0) >= settings.letterMinScore;
}

export function checkCustomerLetter(output, byId, settings) {
  const warnings = [];
  const letter = output.customer_letter === null || output.customer_letter === undefined ? null : String(output.customer_letter).trim();
  if (!letter) return { letter: null, warnings };
  const letterIds = Array.isArray(output.letter_finding_ids) ? output.letter_finding_ids : [];
  if (PROVIDER.test(letter)) warnings.push('thư khách nhắc tên nguồn phân tích');
  if (!letterIds.length) warnings.push('thư khách không gắn letter_finding_ids');
  for (const id of letterIds) {
    const finding = byId[id];
    if (!finding) { warnings.push(`thư khách gắn finding không tồn tại: ${id}`); continue; }
    if (!letterFindingAllowed(finding, settings)) warnings.push(`thư khách dùng ${id} không phải fact đã kiểm hay gap cần khách trả lời (kind=${finding.kind}, score=${finding.score}, inference=${finding.inference}, reply_needed=${finding.reply_needed ?? false})`);
  }
  if (!warnings.length) return { letter, warnings };
  return { letter: null, warnings: warnings.map(item => `bỏ thư khách: ${item}`) };
}
