// Pha Kiểm — pure code, no model. Every finding the investigator submitted is checked against the
// sources it names: does the quote exist, is a cause→effect link backed by two quotes from the same
// source, does every gap carry an allowed reason (and the searches that justify it).
// Inputs are plain data so the whole phase is unit-testable: see verify.test.mjs.

import { slackMessage, slackText, slackCoverage, claimsNoDevReply, noReplyAllowed, correctionConflicts } from './slack-evidence.mjs';
import { BLOCKERS, BLOCKERS_NEED_SEARCH } from './schema.mjs';
import { cssTrialsFromLog, matchCssTrial, untriedReason, looksLikeCss } from './customize.mjs';

// Where a quote was found → score. Below MIN_FACT_SCORE a fact is demoted to a gap.
// `api` = latest source read through the Source API (ref api:<app>/<path>); the quote is checked against what
// source_read/source_search actually returned (no second API call), so it scores like a file.
export const SCORES = { file: 1.0, api: 1.0, 'tool-output': 1.0, kb: 0.9, ticket: 0.7, browser: 0.6, 'tool-name': 0.4, none: 0 };
export const SOURCE_API_TOOLS = ['source_read', 'source_search'];
// Tools whose output is an observation rather than a document (score `browser`): DOM reads, CSS trials (css_preview),
// shop configuration (shop_settings), screen captures looked at (view_image) and the Crisp chat (crisp_read), 13/10/2026.
export const BROWSER_TOOLS = ['browser_check', 'css_preview', 'shop_settings', 'view_image', 'crisp_read'];
const isBrowserTool = entry => BROWSER_TOOLS.includes(entry.tool);
export const MIN_FACT_SCORE = 0.4;
// Phrases that reveal the investigator did not actually read the thing it reports on.
const SELF_ADMITTED_UNREAD = /\b(chưa|không)\s+(đọc|xem|mở|kiểm tra)\b|\bnot (yet )?(read|opened|checked)\b|\bdid not (read|open|check)\b/i;

export function normalizeText(value) {
  return String(value ?? '')
    .replace(/[`'"“”‘’«»]/g, '')
    .replace(/[ \s]+/g, ' ')
    .trim()
    .toLowerCase();
}

// A quote may abbreviate with "…" or "..."; each fragment must then appear in order.
export function quoteFragments(quote) {
  return String(quote ?? '').split(/…|\.\.\./).map(normalizeText).filter(fragment => fragment.length >= 3);
}

export function quoteFound(quote, text) {
  const haystack = normalizeText(text);
  if (!haystack) return false;
  const fragments = quoteFragments(quote);
  if (!fragments.length) return false;
  let cursor = 0;
  for (const fragment of fragments) {
    const index = haystack.indexOf(fragment, cursor);
    if (index === -1) return false;
    cursor = index + fragment.length;
  }
  return true;
}

export function sourceClass(ref) {
  const path = String(ref ?? '').replace(/^\.\//, '');
  if (path.startsWith('apps_doc/')) return 'file';
  if (path.startsWith('api:')) return 'api';
  if (path.startsWith('knowledge-base/')) return 'kb';
  if (path === 'ticket' || path.startsWith('ticket')) return 'ticket';
  if (path.startsWith('slack:')) return 'slack';
  if (path.startsWith('browser')) return 'browser';
  if (path.startsWith('settings:')) return 'browser'; // shop_settings output (API or storefront) scores like a browser observation
  if (path.startsWith('image:') || path.startsWith('crisp:')) return 'browser'; // view_image / crisp_read output (13/10/2026)
  return 'tool';
}

// read_file / source_read print `  12| code`; a quote spanning lines must still match, so the prefixes are removed first.
export const stripLineNumbers = text => String(text ?? '').replace(/^[ \t]*\d+\| ?/gm, '');
function toolOutputs(toolLog, filter = () => true) {
  return (toolLog || []).filter(entry => entry && typeof entry.output === 'string' && filter(entry)).map(entry => stripLineNumbers(entry.output));
}

// TS2 GitLabResearch action=read uses `123: code`, unlike local `123| code`.
// Remove presentation line numbers only for this exact successful source read;
// numeric values in shop observations must remain part of their evidence.
function mcpEvidenceText(entry) {
  return entry?.args?.tool === 'ts_app_read' && entry.args.arguments?.tool === 'GitLabResearch' && entry.args.arguments.arguments?.action === 'read'
    ? String(entry.output || '').replace(/^[ \t]*\d+: ?/gm, '') : entry?.output;
}
function mcpEvidenceCandidates(entry) {
  if (!entry) return [];
  const candidates = [entry.output, mcpEvidenceText(entry)];
  // JSON object values escape newlines. Compare a multiline quote within one
  // decoded leaf, never concatenate unrelated fields or different tool calls.
  try {
    const data = JSON.parse(String(entry.output).replace(/^\[nguồn:[^\n]*\]\n(?:\[đọc lúc:[^\n]*\]\n)?/, ''));
    const visit = (value, depth = 0) => {
      if (depth > 20 || candidates.length >= 2000) return;
      if (typeof value === 'string') candidates.push(value);
      else if (value && typeof value === 'object') for (const child of Object.values(value)) visit(child, depth + 1);
    };
    visit(data);
  } catch { /* Plain source/document text is already included. */ }
  return candidates;
}

// ctx: { readSource(ref) → text|null, ticketText, toolLog: [{ tool, args, output }] }
export function scoreQuote(finding, ctx) {
  const quote = finding.quote;
  if (!quoteFragments(quote).length) return { score: SCORES.none, where: 'none', reason: 'không có quote' };
  const ref = finding.source?.ref || '';
  const declared = sourceClass(ref);
  if (ref.startsWith('mcp-v2:')) {
    const entry = (ctx.toolLog || []).find(item => item.tool === 'mcp_v2_read' && item.ok === true && item.evidence?.ref === ref);
    const matches = mcpEvidenceCandidates(entry).some(text => quoteFound(quote, text));
    return matches
      ? { score: entry.evidence.kind === 'document' ? SCORES.kb : SCORES.browser, where: 'tool-output', reason: `quote có trong đúng MCP evidence ${ref}; playbook không chứng minh cấu hình shop` }
      : { score: 0, where: 'none', reason: `quote không khớp MCP evidence ${ref}` };
  }
  if (declared === 'slack') {
    const message = slackMessage(ctx.slack, ref);
    return message && quoteFound(quote, slackText(message))
      ? { score: 0.7, where: 'slack', reason: `quote có trong đúng message ${ref} (${message.at}); lời người gửi, không phải kiểm chứng shop` }
      : { score: 0, where: 'none', reason: `Slack quote không khớp đúng message hoặc thread thiếu: ${ref}` };
  }
  if (ref.startsWith('solar:')) {
    const outputs = toolOutputs(ctx.toolLog, entry => ['release_knowledge', 'rg_search'].includes(entry.tool));
    const matching = outputs.flatMap(output => output.split(/(?=\[solar:\d+\])/)).filter(block => block.startsWith(`[${ref}]`)).map(block => block.split('--- KB files')[0]);
    return quoteFound(quote, matching.join('\n'))
      ? { score: SCORES.kb, where: 'kb', reason: `quote có trong release đã truy xuất (${ref})` }
      : { score: SCORES.none, where: 'none', reason: `quote không có trong đúng release ${ref}` };
  }
  if (declared === 'file' || declared === 'kb') {
    const text = ctx.readSource ? ctx.readSource(ref) : null;
    if (text === null || text === undefined) {
      // The file the investigator cites does not exist (or is outside the allowed roots).
      const fallback = fallbackScore(finding, ctx);
      return fallback.score > 0 ? { ...fallback, reason: `nguồn ${ref} không mở được; ${fallback.reason}` } : { score: SCORES.none, where: 'none', reason: `nguồn ${ref} không mở được` };
    }
    if (quoteFound(quote, text)) return { score: SCORES[declared], where: declared, reason: `quote có trong ${ref}` };
    const fallback = fallbackScore(finding, ctx);
    return fallback.score > 0 ? { ...fallback, reason: `quote không có trong ${ref}; ${fallback.reason}` } : { score: SCORES.none, where: 'none', reason: `quote không có trong ${ref}` };
  }
  if (declared === 'api') {
    const outputs = toolOutputs(ctx.toolLog, entry => SOURCE_API_TOOLS.includes(entry.tool));
    if (!outputs.length) return fallbackScore(finding, ctx, `nguồn ${ref} khai báo nhưng không có lần gọi source_read/source_search nào`);
    if (quoteFound(quote, outputs.join('\n'))) return { score: SCORES.api, where: 'api', reason: `quote có trong kết quả API nguồn (${ref})` };
    return fallbackScore(finding, ctx, `quote không có trong kết quả API nguồn (${ref})`);
  }
  if (declared === 'ticket') {
    if (quoteFound(quote, ctx.ticketText)) return { score: SCORES.ticket, where: 'ticket', reason: 'quote có trong ticket' };
    return fallbackScore(finding, ctx, 'quote không có trong ticket');
  }
  if (declared === 'browser') {
    if (quoteFound(quote, toolOutputs(ctx.toolLog, isBrowserTool).join('\n'))) return { score: SCORES.browser, where: 'browser', reason: 'quote có trong kết quả browser_check/css_preview' };
    return fallbackScore(finding, ctx, 'quote không có trong kết quả browser_check/css_preview');
  }
  return fallbackScore(finding, ctx);
}

// Not found where declared: look through everything the tools actually returned, then the ticket, then the browser.
function fallbackScore(finding, ctx, prefix = '') {
  const quote = finding.quote;
  const join = reason => (prefix ? `${prefix}; ${reason}` : reason);
  if (quoteFound(quote, toolOutputs(ctx.toolLog, entry => !isBrowserTool(entry) && !['helpdesk_ticket', 'mcp_v2_read'].includes(entry.tool)).join('\n'))) return { score: SCORES['tool-output'], where: 'tool-output', reason: join('quote có trong kết quả tool') };
  if (quoteFound(quote, ctx.ticketText)) return { score: SCORES.ticket, where: 'ticket', reason: join('quote có trong ticket') };
  if (quoteFound(quote, toolOutputs(ctx.toolLog, isBrowserTool).join('\n'))) return { score: SCORES.browser, where: 'browser', reason: join('quote có trong kết quả browser_check/css_preview') };
  const toolName = finding.source?.type === 'tool' ? finding.source.ref : null;
  if (toolName && toolName !== 'mcp_v2_read' && (ctx.toolLog || []).some(entry => entry.tool === toolName)) return { score: SCORES['tool-name'], where: 'tool-name', reason: join(`chỉ có tên tool ${toolName}, không thấy quote trong output`) };
  return { score: SCORES.none, where: 'none', reason: join('không thấy quote ở đâu') };
}

// "X gây ra / khớp với Y" is kept only when both quotes come from the same source text.
export function verifyLink(finding, ctx) {
  if (!finding.link) return { verified: null, reason: null };
  const { cause_quote: cause, effect_quote: effect } = finding.link;
  const ref = finding.source?.ref || '';
  const declared = sourceClass(ref);
  let text = null;
  if (ref.startsWith('mcp-v2:')) {
    const entry = (ctx.toolLog || []).find(item => item.tool === 'mcp_v2_read' && item.ok === true && item.evidence?.ref === ref);
    return mcpEvidenceCandidates(entry).some(value => quoteFound(cause, value) && quoteFound(effect, value))
      ? { verified: true, reason: `cả hai quote có trong đúng MCP evidence ${ref}` }
      : { verified: false, reason: `cause_quote và effect_quote không khớp cùng MCP evidence ${ref}` };
  }
  else if (declared === 'file' || declared === 'kb') text = ctx.readSource ? ctx.readSource(ref) : null;
  else if (declared === 'api') text = toolOutputs(ctx.toolLog, entry => SOURCE_API_TOOLS.includes(entry.tool)).join('\n');
  else if (declared === 'slack') { const m = slackMessage(ctx.slack, ref); text = m ? slackText(m) : null; }
  else if (declared === 'ticket') text = ctx.ticketText;
  else if (declared === 'browser') text = toolOutputs(ctx.toolLog, isBrowserTool).join('\n');
  else text = toolOutputs(ctx.toolLog, entry => entry.tool !== 'mcp_v2_read').join('\n');
  if (text && quoteFound(cause, text) && quoteFound(effect, text)) return { verified: true, reason: `cả hai quote có trong ${ref || 'kết quả tool'}` };
  return { verified: false, reason: 'cause_quote và effect_quote không cùng nằm trong một nguồn → suy luận' };
}

// A searched entry {tool, query} is honoured when the tool log holds a call of that tool whose arguments carry the query.
// Since 14/10/2026 the match is tolerant: the model writes "packages/a.js:1-170", "file lines 1-200", "part=all, max_comments=8"
// or "app=joy; queries=[…]" while the args are JSON — so a file path alone, or every token (≥ 3 chars) of the query found in
// the args text, counts. (17/17 extra rounds measured on 14/10 came from such shape mismatches or the rule below.)
const SEARCH_TOOL_FAMILY = { source_read: ['source_read', 'read_file'], read_file: ['read_file', 'source_read'], source_search: ['source_search', 'rg_search'], rg_search: ['rg_search', 'source_search'] };
export function searchMatched(entry, toolLog) {
  if (!entry || typeof entry !== 'object') return false;
  const tools = SEARCH_TOOL_FAMILY[entry.tool] || [entry.tool];
  const calls = (toolLog || []).filter(call => tools.includes(call.tool));
  if (!calls.length) return false;
  const query = normalizeText(entry.query).replace(/\bapi:[a-z0-9-]+\//g, '').replace(/\bapps_doc\/[a-z0-9-]+\//g, '');
  if (!query) return true;
  const argsTexts = calls.map(call => normalizeText(JSON.stringify(call.args || {})));
  if (argsTexts.some(text => text.includes(query))) return true;
  const paths = query.match(/[\w./-]+\.[a-z]{1,6}\b/g) || [];
  if (paths.length && argsTexts.some(text => paths.every(path => text.includes(path)))) return true;
  const tokens = query.split(/[^\p{L}\p{N}_.\/-]+/u).map(token => token.replace(/^[.\/-]+|[.\/-]+$/g, '')).filter(token => token.length >= 3 && !/^(lines?|part|max_comments|queries|app|regex|scope|true|false|all|docs|code)$/.test(token));
  if (!tokens.length) return true; // the query carried no searchable content (e.g. "part=all"): the tool was called, that is what counts
  return argsTexts.some(text => tokens.every(token => text.includes(token)));
}

// Searches that were really run in the log, as {tool, query} entries — used to fill `searched` for the model (14/10/2026).
const SEARCH_TOOLS = ['source_search', 'source_read', 'rg_search', 'read_file', 'helpdesk_ticket', 'shop_settings', 'browser_check', 'crisp_read', 'view_image'];
SEARCH_TOOLS.push('release_knowledge');
SEARCH_TOOLS.push('mcp_v2_read');
export function searchesFromLog(toolLog) {
  return (toolLog || []).filter(call => SEARCH_TOOLS.includes(call.tool)).map(call => {
    const args = call.args || {};
    const query = Array.isArray(args.queries) ? args.queries.join(' | ') : typeof args.query === 'string' ? args.query : typeof args.file === 'string' ? `${args.file}${args.lines ? `:${args.lines}` : args.start ? `:${args.start}-${args.end || ''}` : ''}` : typeof args.path === 'string' ? args.path : Array.isArray(args.files) ? args.files.map(item => item?.file || item).join(' | ') : typeof args.url === 'string' ? args.url : JSON.stringify(args).slice(0, 120);
    return { tool: call.tool, query: String(query).slice(0, 300) };
  });
}

// Blockers whose "not read" is the very thing the blocker states (the shop's configuration, the merchant's answer, a write):
// the self-admitted-unread rule does not apply to them once the log shows the model did try (a shop_settings call).
const ACCESS_BLOCKERS = ['shop_access', 'customer', 'write_action'];
function isMcpSettingsAttempt(call) {
  if (call?.tool === 'mcp_v2_read' && call.args?.tool === 'ts_shop_settings') return true;
  if (call.tool !== 'mcp_v2_read' || call.args?.tool !== 'ts_app_read') return false;
  const read = call.args.arguments || {}; const args = read.arguments || {};
  return /Config$/.test(read.tool || '') || /^(get|read)[-_](settings|config)$/.test(args.action || '')
    || (read.tool === 'StorefrontSource' && /settings|config|AVADA_WISHLIST|AIR_REVIEWS/i.test(args.grep || ''));
}
export function checkGap(finding, toolLog) {
  if (!BLOCKERS.includes(finding.blocker)) return { ok: false, reason: `blocker "${finding.blocker ?? ''}" không nằm trong danh sách ${BLOCKERS.join(', ')}` };
  const triedSettings = (toolLog || []).some(call => call.tool === 'shop_settings' || isMcpSettingsAttempt(call));
  if (SELF_ADMITTED_UNREAD.test(`${finding.claim || ''} ${finding.details || ''}`) && !(ACCESS_BLOCKERS.includes(finding.blocker) && triedSettings)) return { ok: false, reason: 'tự nhận chưa đọc/chưa xem → phải tra thêm' };
  if (BLOCKERS_NEED_SEARCH.includes(finding.blocker)) {
    const searched = Array.isArray(finding.searched) ? finding.searched : [];
    const unmatched = searched.filter(entry => !searchMatched(entry, toolLog));
    if (!searched.length || unmatched.length) {
      // 14/10/2026: the searches really run are in the log; fill them in instead of sending the model on another round.
      const fromLog = searchesFromLog(toolLog);
      if (!fromLog.length) return { ok: false, reason: `blocker ${finding.blocker} cần kèm lần tra đã chạy (searched) nhưng log tool không có lần tra nào` };
      return { ok: true, reason: null, searched: fromLog.slice(0, 20), searchedAuto: true, note: !searched.length ? 'searched trống → điền từ log tool' : `searched ghi ${unmatched.length} lần tra không khớp log (${unmatched.map(entry => `${entry?.tool}:${String(entry?.query ?? '').slice(0, 60)}`).join(' | ')}) → thay bằng log tool` };
    }
  }
  return { ok: true, reason: null };
}

// Calls that touched the cited source: used to fill `searched` when a fact is demoted to a gap.
export function callsTouching(ref, toolLog) {
  const needle = normalizeText(String(ref || '').split('/').pop());
  if (!needle) return [];
  return (toolLog || []).filter(call => normalizeText(JSON.stringify(call.args || {})).includes(needle)).map(call => ({ tool: call.tool, query: typeof call.args?.query === 'string' ? call.args.query : typeof call.args?.path === 'string' ? call.args.path : '' }));
}

// Main entry. Returns the annotated result plus the list of findings that need one more tool round.
export function verifyFindings(result, ctx) {
  const toolLog = ctx.toolLog || [];
  const findings = [];
  const needsInvestigation = [];
  const stats = { total: 0, facts: 0, suggestions: 0, gaps: 0, demoted: 0, brokenQuotes: 0, inferences: 0, gapsInvalid: 0, searchedAuto: 0 };
  // CSS nộp = CSS đã thử (14/10/2026): every CSS code block is matched against the css_preview trials of the log.
  const cssTrials = cssTrialsFromLog(toolLog);
  stats.cssTried = 0; stats.cssUntried = 0;
  for (const original of result.findings || []) {
    stats.total++;
    const finding = { ...original, score: null, evidence_where: null, evidence_reason: null, inference: false, verified: false, demoted: false, gap_ok: null, gap_reason: null };
    // Derive this marker from the verified local operation, never from model input.
    finding.shop_config_observation = false;
    if (finding.kind === 'fact') {
      const scored = scoreQuote(finding, ctx);
      finding.score = scored.score; finding.evidence_where = scored.where; finding.evidence_reason = scored.reason;
      if (scored.score < MIN_FACT_SCORE) {
        stats.brokenQuotes++; stats.demoted++;
        finding.kind = 'gap'; finding.demoted = true; finding.blocker = 'searched_not_found';
        finding.searched = callsTouching(finding.source?.ref, toolLog);
        finding.details = [finding.details, `Bằng chứng ban đầu không kiểm được: ${scored.reason}`].filter(Boolean).join(' · ');
      } else {
        finding.verified = true;
        finding.shop_config_observation = toolLog.some(call => call.ok === true && call.evidence?.ref === finding.source?.ref && call.tool === 'mcp_v2_read' && call.args?.tool === 'ts_shop_settings');
        if (finding.link) {
          const link = verifyLink(finding, ctx);
          finding.link = { ...finding.link, verified: link.verified, reason: link.reason };
          if (!link.verified) { finding.inference = true; stats.inferences++; }
        }
      }
    } else if (finding.kind === 'suggestion') {
      // A suggestion is advice; it is verified only when it quotes a real source, otherwise it is flagged unsourced (not demoted).
      if (quoteFragments(finding.quote).length) {
        const scored = scoreQuote(finding, ctx);
        finding.score = scored.score; finding.evidence_where = scored.where; finding.evidence_reason = scored.reason;
        finding.verified = scored.score >= MIN_FACT_SCORE;
      } else { finding.score = 0.5; finding.evidence_where = 'none'; finding.evidence_reason = 'đề xuất không kèm nguồn'; }
      if (finding.link) {
        const link = verifyLink(finding, ctx);
        finding.link = { ...finding.link, verified: link.verified, reason: link.reason };
        if (!link.verified) { finding.inference = true; stats.inferences++; }
      }
    }
    if (finding.kind === 'gap') {
      const gap = checkGap(finding, toolLog);
      finding.gap_ok = gap.ok; finding.gap_reason = gap.reason;
      if (gap.searchedAuto) { finding.searched = gap.searched; finding.searched_auto = true; finding.searched_note = gap.note; stats.searchedAuto = (stats.searchedAuto || 0) + 1; }
      if (!gap.ok) { stats.gapsInvalid++; needsInvestigation.push({ id: finding.id, claim: finding.claim, reason: gap.reason, source: finding.source?.ref || null }); }
    }
    if (typeof finding.code === 'string' && finding.code.trim() && (finding.code_lang ? finding.code_lang === 'css' : looksLikeCss(finding.code))) {
      const trial = matchCssTrial(finding.code, cssTrials);
      finding.css_trial = trial
        ? { matched: true, seq: trial.seq, round: trial.round, mobile: Boolean(trial.mobile), url: trial.url || null, overridden: (trial.overridden || []).map(item => (typeof item === 'string' ? item : `${item.selector} → ${item.property}`)) }
        : { matched: false, untried_reason: untriedReason(`${finding.details || ''}\n${finding.claim || ''}`) };
      if (trial) stats.cssTried++; else if (!finding.css_trial.untried_reason) stats.cssUntried++;
    }
    if (finding.kind === 'fact') stats.facts++; else if (finding.kind === 'suggestion') stats.suggestions++; else stats.gaps++;
    findings.push(finding);
  }
  const slackProblems = slackCoverage(ctx.slack, findings);
  for (const finding of findings) {
    if (finding.verified && finding.source?.ref?.startsWith("slack:")) finding.slackHistorical = correctionConflicts(ctx.slack, finding.claim, finding.quote).length > 0;
    if (claimsNoDevReply(`${finding.claim} ${finding.details || ''}`) && !noReplyAllowed(ctx.slack)) slackProblems.push(`${finding.id}: không có bằng chứng cho kết luận dev chưa phản hồi/cập nhật`);
  }
  return { ...result, findings, needsInvestigation, stats, slack: ctx.slack || null, slackProblems }; 
}

// Merge a follow-up submission into the previous one: same id replaces, new ids append.
export function mergeFindings(previous, next) {
  const byId = new Map((previous.findings || []).map(finding => [finding.id, finding]));
  for (const finding of next.findings || []) byId.set(finding.id, finding);
  return { ...previous, ...next, findings: [...byId.values()], sources: [...(previous.sources || []), ...(next.sources || [])] };
}
