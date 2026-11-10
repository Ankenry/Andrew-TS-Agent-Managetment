// Shapes shared by the three roles of check-ticket-v2: the investigator submits FINDINGS_SCHEMA,
// the verifier (verify.mjs) annotates it, the writer returns WRITER_SCHEMA.
// Codex --output-schema requires strict objects: every property listed, additionalProperties false,
// optional values expressed as nullable types.

import { lintCss, importantReason, looksLikeCss, cssTrialProblems } from './customize.mjs';

export const CATEGORIES = ['Customize', 'Bug', 'Feature request', 'Question'];
export const FINDING_KINDS = ['fact', 'suggestion', 'gap'];
// `api` = source read through the TS Elite 2 Source API (ref `api:<app>/<path>`, latest commit); `file` = local copy under apps_doc/.
export const SOURCE_TYPES = ['file', 'api', 'kb', 'ticket', 'browser', 'tool', 'slack'];
// Fixed list of reasons a gap may stay unverified. dev / searched_not_found must name the searches that were run.
export const BLOCKERS = ['customer', 'shop_access', 'dev', 'write_action', 'searched_not_found'];
export const BLOCKERS_NEED_SEARCH = ['dev', 'searched_not_found'];
export const TOOL_NAMES = ['rg_search', 'read_file', 'source_search', 'source_read', 'helpdesk_ticket', 'browser_check', 'css_preview', 'shop_settings', 'view_image', 'crisp_read', 'submit_findings'];
// Languages a finding's `code` block may carry (Customize tickets must ship a complete block, 13/10/2026).
export const CODE_LANGS = ['css', 'js', 'liquid', 'html'];

const nullable = (type, extra = {}) => ({ type: [type, 'null'], ...extra });

export const SEARCH_ENTRY_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: { tool: { type: 'string', enum: TOOL_NAMES.filter(name => name !== 'submit_findings') }, query: { type: 'string' } },
  required: ['tool', 'query'],
};

export const FINDING_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    id: { type: 'string', description: 'Short unique id, e.g. F1, F2.' },
    kind: { type: 'string', enum: FINDING_KINDS },
    claim: { type: 'string', description: 'One line: what is asserted (fact), proposed (suggestion) or unknown (gap).' },
    quote: nullable('string', { description: 'Verbatim text from the source that supports the claim. Code must match the file byte for byte (whitespace may differ).' }),
    source: nullable('object', {
      additionalProperties: false,
      properties: {
        type: { type: 'string', enum: SOURCE_TYPES },
        ref: { type: 'string', description: 'Source path as the tool printed it: "api:<app>/<path>" (Source API), repo-relative "apps_doc/..." or "knowledge-base/...", "ticket", "browser:<url>", "settings:<app>/<api|storefront>" (shop_settings, type browser) or the tool name.' },
        line: nullable('integer'),
      },
      required: ['type', 'ref', 'line'],
    }),
    link: nullable('object', {
      description: 'Only for a claim of the form "X causes / matches Y": both quotes must come from the same source.',
      additionalProperties: false,
      properties: { cause_quote: { type: 'string' }, effect_quote: { type: 'string' } },
      required: ['cause_quote', 'effect_quote'],
    }),
    blocker: nullable('string', { enum: [...BLOCKERS, null] }),
    searched: nullable('array', { items: SEARCH_ENTRY_SCHEMA }),
    reply_needed: nullable('boolean', { description: 'True when the merchant must answer or act before TS can continue.' }),
    offer_fix: nullable('boolean', { description: 'True when the suggestion is a theme/code change TS would make for the merchant.' }),
    details: nullable('string', { description: 'Steps, paths, selectors, where to paste the code (DevZone field / theme file). No prose for the merchant.' }),
    code: nullable('string', { description: 'Complete, copy-ready code block (CSS/JS/Liquid) built on real selectors from browser_check/css_preview or the app source. Required on at least one finding of a Customize ticket unless infeasible_reason is set. Code only, no prose.' }),
    code_lang: nullable('string', { enum: [...CODE_LANGS, null], description: 'Language of `code`.' }),
  },
  required: ['id', 'kind', 'claim', 'quote', 'source', 'link', 'blocker', 'searched', 'reply_needed', 'offer_fix', 'details', 'code', 'code_lang'],
};

export const FINDINGS_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    category: { type: 'string', enum: CATEGORIES },
    category_reason: { type: 'string' },
    summary: { type: 'string', description: 'Two or three sentences for TS: what was found, what is still open.' },
    browser_impact: { type: 'boolean', description: 'True when the reported symptom is visible on the storefront.' },
    infeasible_reason: nullable('string', { description: 'Customize only: why the request cannot be done with CSS/JS at all (business logic, data, permission). null when a code block is provided.' }),
    findings: { type: 'array', items: FINDING_SCHEMA },
    sources: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { type: { type: 'string', enum: SOURCE_TYPES }, ref: { type: 'string' } }, required: ['type', 'ref'] } },
  },
  required: ['category', 'category_reason', 'summary', 'browser_impact', 'infeasible_reason', 'findings', 'sources'],
};

export const WRITER_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    body: { type: 'string', description: 'Full Vietnamese Han Support report: exact greeting and seven numbered bold headings. Helpdesk summarizes the entire same-run report with the TS wrapper, preserving evidence, code and caveats.' },
    claims: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          text: { type: 'string', description: 'A sentence copied verbatim from body that asserts something.' },
          finding_ids: { type: 'array', items: { type: 'string' } },
          inference: { type: 'boolean' },
        },
        required: ['text', 'finding_ids', 'inference'],
      },
    },
    customer_letter: nullable('string', { description: 'English mail draft for the merchant, facts only, or null when none is needed.' }),
    letter_finding_ids: { type: 'array', items: { type: 'string' } },
  },
  required: ['body', 'claims', 'customer_letter', 'letter_finding_ids'],
};

// Light structural validation used by the MCP server (so the model gets errors it can fix in the same run)
// and by the pipeline when it falls back to the final message. Returns a list of problems; empty means valid.
// context (optional, from tools-server): { cssTrials, browserAllowed, budgetLeft, lastUnusable } → CSS code must equal a tried block (14/10/2026).
export function validateFindings(value, context = null) {
  const problems = [];
  if (!value || typeof value !== 'object') return ['result is not an object'];
  if (!CATEGORIES.includes(value.category)) problems.push(`category must be one of ${CATEGORIES.join(', ')}`);
  if (typeof value.summary !== 'string' || !value.summary.trim()) problems.push('summary is required');
  if (!Array.isArray(value.findings)) return [...problems, 'findings must be an array'];
  if (!value.findings.length) problems.push('findings is empty: submit at least one fact, suggestion or gap');
  const ids = new Set();
  value.findings.forEach((finding, index) => {
    const where = `findings[${index}]`;
    if (!finding || typeof finding !== 'object') { problems.push(`${where} is not an object`); return; }
    if (typeof finding.id !== 'string' || !finding.id.trim()) problems.push(`${where}.id is required`);
    else if (ids.has(finding.id)) problems.push(`${where}.id "${finding.id}" is duplicated`);
    else ids.add(finding.id);
    if (!FINDING_KINDS.includes(finding.kind)) problems.push(`${where}.kind must be fact, suggestion or gap`);
    if (typeof finding.claim !== 'string' || !finding.claim.trim()) problems.push(`${where}.claim is required`);
    if (finding.kind === 'fact') {
      if (typeof finding.quote !== 'string' || !finding.quote.trim()) problems.push(`${where} (fact) needs a verbatim quote`);
      if (!finding.source || !SOURCE_TYPES.includes(finding.source.type) || typeof finding.source.ref !== 'string' || !finding.source.ref.trim()) problems.push(`${where} (fact) needs source {type, ref}`);
    }
    if (finding.kind === 'gap') {
      if (!BLOCKERS.includes(finding.blocker)) problems.push(`${where} (gap) needs blocker in ${BLOCKERS.join(', ')}`);
      if (BLOCKERS_NEED_SEARCH.includes(finding.blocker) && !(Array.isArray(finding.searched) && finding.searched.length)) problems.push(`${where} (gap, ${finding.blocker}) needs searched: [{tool, query}] listing the searches you ran`);
    }
    if (finding.link && (typeof finding.link.cause_quote !== 'string' || typeof finding.link.effect_quote !== 'string')) problems.push(`${where}.link needs cause_quote and effect_quote`);
    if (finding.searched && !Array.isArray(finding.searched)) problems.push(`${where}.searched must be an array`);
    if (finding.code !== undefined && finding.code !== null && typeof finding.code !== 'string') problems.push(`${where}.code must be a string or null`);
    if (finding.code_lang && !CODE_LANGS.includes(finding.code_lang)) problems.push(`${where}.code_lang must be one of ${CODE_LANGS.join(', ')}`);
  });
  // Customize (13/10/2026, user order "cần đưa ra css code"): the report must carry a complete code block, so at least
  // one finding has `code`; the only way out is to state why CSS/JS cannot do it at all.
  if (value.category === 'Customize' && !hasCode(value) && !(typeof value.infeasible_reason === 'string' && value.infeasible_reason.trim())) {
    problems.push('category Customize needs at least one finding with `code` (complete CSS/JS block built on real selectors from browser_check/css_preview or the source; details = where to paste it), or infeasible_reason explaining why CSS/JS cannot do it');
  }
  // CSS writing rules (14/10/2026, user order: parent class instead of !important; no numeric/dynamic ids or per-element
  // classes). Refused here so the investigator fixes the code in the same turn.
  problems.push(...cssCodeProblems(value.findings));
  // CSS nộp = CSS đã thử (14/10/2026, user order "dùng mcp để test lại xem có apply được đúng ko"): only when the caller knows
  // the css_preview trials (tools-server); the finalize path without that context does not judge it.
  if (context && context.cssTrials !== undefined) problems.push(...cssTrialProblems(value.findings, context));
  return problems;
}

export function cssCodeProblems(findings) {
  const problems = [];
  (Array.isArray(findings) ? findings : []).forEach((finding, index) => {
    const code = typeof finding?.code === 'string' ? finding.code : '';
    if (!code.trim() || (finding.code_lang && finding.code_lang !== 'css') || (!finding.code_lang && !looksLikeCss(code))) return;
    const where = `findings[${index}]${finding.id ? ` (${finding.id})` : ''}.code`;
    const lint = lintCss(code);
    for (const error of lint.errors) problems.push(`${where}: ${error.message} → ${error.suggestion}`);
    if (lint.importantCount > 0 && !importantReason(`${finding.details || ''}\n${finding.claim || ''}`)) {
      problems.push(`${where} dùng !important ${lint.importantCount} lần mà details/claim không nêu lý do: trước hết viết selector có class cha ổn định của app/theme và thử bằng css_preview; chỉ giữ !important cho thuộc tính css_preview báo vẫn bị ghi đè, và ghi vào details câu như "class cha … vẫn không thắng được rule … của theme nên cần !important cho <thuộc tính>"`);
    }
  });
  return problems;
}

export function hasCode(value) {
  return Array.isArray(value?.findings) && value.findings.some(finding => typeof finding?.code === 'string' && finding.code.trim());
}
