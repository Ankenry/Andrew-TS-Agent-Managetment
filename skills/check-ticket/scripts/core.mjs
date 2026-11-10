import { isHanReport, parseHanReport, reportArtifacts } from './han-report.mjs';
import { CATEGORIES, formatReviewComment } from './handoff.mjs';
import { parseSourcesSection } from '../../../scripts/hachimi-trace-sources.mjs';

export { CATEGORIES };
export const BUG_TYPES = ['ui_theme', 'logic_theme', 'logic_internal', 'unknown'];
export const BROWSER_CHECKS = ['none', 'storefront', 'error_code', 'block_missing'];
export function needsBugBrowser(result) {
  // Internal-only app failures take precedence over generic error/block words.
  return result.bugType !== 'logic_internal' && (
    ['ui_theme', 'logic_theme'].includes(result.bugType)
    || ['storefront', 'error_code', 'block_missing'].includes(result.browserCheck));
}
export const DEMO_FALLBACK = 'Chưa thể đưa ra Demo nhờ Andew tự custom lấy demo';
// Who analyses a ticket: `hancal` = local 3-role pipeline (skills/check-ticket-v2) on apps_doc/ + knowledge-base/,
// `elite` = the former flow (one "Check ticket" request to TS Elite 2 + worker phases). The controller shell is the same.
export const ANALYSIS_MODES = ['hancal', 'elite'];
export const HANCAL_TIMEOUT_MAX_MS = 600000;
export function normalizeLimits(value = {}) {
  const limits = { ...value };
  limits.analysis = ANALYSIS_MODES.includes(limits.analysis) ? limits.analysis : 'hancal';
  limits.hancalTimeoutMs = Math.min(HANCAL_TIMEOUT_MAX_MS, Math.max(1, Number(limits.hancalTimeoutMs) || HANCAL_TIMEOUT_MAX_MS));
  return limits;
}

// Human-readable summary of the verified findings, saved as analysis.txt for the chat-bot History view.
export function describeHancalFindings(analysis) {
  const verified = analysis?.verified;
  if (!verified?.findings) return '';
  const lines = [`Điều tra (${verified.category}): ${verified.summary || ''}`.trim(), ''];
  for (const finding of verified.findings) {
    const score = finding.score === null || finding.score === undefined ? '-' : Number(finding.score).toFixed(1);
    lines.push(`${finding.id} [${finding.kind}${finding.demoted ? ' ←fact' : ''}] điểm ${score}${finding.inference ? ' · suy luận' : ''}${finding.kind === 'gap' ? ` · ${finding.blocker || '?'}${finding.gap_ok === false ? ' (thiếu lý do)' : ''}` : ''}: ${finding.claim}${finding.source?.ref ? ` (${finding.source.ref}${finding.source.line ? `:${finding.source.line}` : ''})` : ''}`);
  }
  return lines.join('\n');
}
export const RESULT_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    category: { type: 'string', enum: CATEGORIES },
    canCustomize: { type: ['boolean', 'null'] },
    bugType: { type: 'string', enum: BUG_TYPES },
    browserCheck: { type: 'string', enum: BROWSER_CHECKS },
    verificationNotes: { type: 'string' },
    reason: { type: 'string' }, comment: { type: 'string' }, css: { type: 'string' },
    storefrontUrl: { type: 'string' }, verified: { type: 'boolean' },
    screenshotPath: { type: 'string' }, screenshotVerified: { type: 'boolean' },
  },
  required: ['category', 'canCustomize', 'bugType', 'browserCheck', 'verificationNotes', 'reason', 'comment', 'css', 'storefrontUrl', 'verified', 'screenshotPath', 'screenshotVerified'],
};

export function assertReportHasNoProviderName(content) {
  // CSS/code identifiers are not prose attribution and must remain unchanged.
  const prose = String(content).replace(/```[\s\S]*?```/g, '');
  if (/\b(?:TS[\s_-]*)?Elite(?:[\s_-]*2)?\b/i.test(prose)) throw new Error('Ticket report must not mention the analysis provider.');
}

export function validateResult(value) {
  if (!value || !CATEGORIES.includes(value.category) || !BUG_TYPES.includes(value.bugType)
    || !BROWSER_CHECKS.includes(value.browserCheck)
    || ![true, false, null].includes(value.canCustomize)
    || ['reason', 'comment', 'css', 'storefrontUrl', 'screenshotPath', 'verificationNotes'].some(k => typeof value[k] !== 'string')
    || typeof value.verified !== 'boolean' || typeof value.screenshotVerified !== 'boolean'
    || !value.comment.trim()) throw new Error('Worker returned an invalid ticket review.');
  if (value.comment.length > 15000 || value.css.length > 15000) throw new Error('Review is too long to post.');
  assertReportHasNoProviderName(value.comment);
  assertReportHasNoProviderName(value.verificationNotes);
  if (/^\s*#{0,6}\s*Sources\s*:?\s*$/im.test(value.comment)
    || /Hoàng Thượng|Hachimi|Support by/i.test(value.comment)) throw new Error('Review violates Helpdesk comment format.');
  return value;
}

export class DeadlineError extends Error {
  constructor(phase) { super(`Deadline exceeded: ${phase}`); this.name = 'DeadlineError'; }
}

export async function withinDeadline(phase, ms, work) {
  const controller = new AbortController();
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(() => work({ signal: controller.signal, deadline: Date.now() + ms })),
      new Promise((_, reject) => { timer = setTimeout(() => {
        controller.abort(new DeadlineError(phase)); reject(new DeadlineError(phase));
      }, ms); }),
    ]);
  } finally { clearTimeout(timer); }
}

export function ticketReference(value) {
  const source = String(value || '').trim();
  if (/^https?:\/\//i.test(source)) {
    const url = new URL(source);
    const match = url.pathname.match(/^\/(?:t|tickets)\/([A-Za-z0-9_-]+)\/?$/);
    if (url.hostname !== 'helpdesk.avada.net' || url.username || url.password || !match) throw new Error('Invalid Helpdesk ticket URL.');
    return { reference: match[1], url: url.href };
  }
  if (!/^[A-Za-z0-9_-]+$/.test(source)) throw new Error('Invalid ticket reference.');
  return { reference: source, url: `https://helpdesk.avada.net/tickets/${source}` };
}

export function composeReviewPresentation(result, { demoUrl = '', demoRequired = false } = {}) {
  if (isHanReport(result.comment)) {
    const report = parseHanReport(result.comment, result.category);
    if (result.verified && result.verificationNotes.trim()) report.sections[3].body += `\n\n${result.verificationNotes.trim()}`;
    if (result.category === 'Customize' && result.canCustomize === true && result.css.trim() && !report.sections[3].body.includes(result.css.trim())) report.sections[3].body += `\n\n\`\`\`css\n${result.css.trim()}\n\`\`\``;
    if (demoRequired) {
      const demo = demoUrl ? `Demo: ${demoUrl}` : 'Han chưa có demo đã kiểm chứng để chia sẻ.';
      report.sections[3].body += `\n\n${demo}`;
      report.sections[6].body += `\n\n${demo}`;
    }
    return reportArtifacts(report);
  }
  let content = result.comment.trim();
  if (result.verified && result.verificationNotes.trim()) {
    content += `\n\n${result.verificationNotes.trim()}`;
  }
  if (result.category === 'Customize' && result.canCustomize === true && result.css.trim() && !content.includes(result.css.trim())) {
    content += `\n\nDùng đoạn CSS này cho phần giao diện vừa nêu:\n\n\`\`\`css\n${result.css.trim()}\n\`\`\``;
  }
  if (demoRequired) {
    if (demoUrl) content += `\n\nDemo: ${demoUrl}`;
    else if (!content.includes(DEMO_FALLBACK)) content += `\n\n${DEMO_FALLBACK}`;
  }
  if (content.length > 20000) throw new Error('Final comment exceeds 20000 characters.');
  assertReportHasNoProviderName(content);
  return { comment: formatReviewComment(content, result.category) };
}

export function composeComment(result, options = {}) { return composeReviewPresentation(result, options).comment; }

// followUp (13/10/2026, "@bot" comment command): { instruction, commentId, commentAt, sinceAt, previousReport, … } — data the
// Hancal pipeline uses to check the ticket again against the comments written since the last check. Only the hancal mode supports it.
export async function executeReview(reference, io, limits, { publishDemo = false, followUp = null } = {}) {
  const target = ticketReference(reference);
  const engineSnapshot = await io.selectEngine?.();
  if (engineSnapshot?.enabled) limits = { ...limits, analysis: 'hancal' };
  const audit = [];
  if (followUp && limits.analysis !== 'hancal') throw new Error('Follow-up (@bot) reviews need analysis mode hancal.');
  // Tracing only (best-effort): how long each phase took and why it stopped.
  const seconds = ms => `${(ms / 1000).toFixed(1)}s`;
  const phase = async (name, timeout, work) => {
    await io.progress?.(name);
    const start = Date.now();
    try {
      const value = await withinDeadline(name, timeout, work);
      const elapsedMs = Date.now() - start;
      audit.push({ phase: name, status: 'complete', elapsedMs });
      io.trace?.('note', `Hoàn tất pha ${name} sau ${seconds(elapsedMs)}`, { phase: name, payload: { status: 'complete', elapsedMs, timeoutMs: timeout } });
      return value;
    } catch (error) {
      const elapsedMs = Date.now() - start;
      const status = error.name === 'DeadlineError' ? 'timeout' : 'failed';
      audit.push({ phase: name, status, elapsedMs });
      io.trace?.('warning', status === 'timeout' ? `Pha ${name} quá hạn ${seconds(timeout)}` : `Pha ${name} lỗi sau ${seconds(elapsedMs)}: ${error.message}`,
        { phase: name, payload: { status, elapsedMs, timeoutMs: timeout, ...(error.detail || {}) } });
      throw error;
    }
  };
  // `analysis` is set by adapters.settings() (workflow.json, default hancal); callers that pass bare timeouts keep the former flow.
  if (limits.analysis === 'hancal') {
    // Hancal: one bounded run of the 3-role pipeline (investigate with tools → code verification → write), preview
    // inside the pipeline; the controller composes and posts. No TS Elite 2 request, no worker phases.
    if (typeof io.hancal !== 'function') throw new Error('Hancal analysis is not available in this IO.');
    const analysis = await phase('hancal', limits.hancalTimeoutMs, context => io.hancal(target, { ...context, engineSnapshot }, followUp));
    const problems = analysis?.postcheck?.violations?.length ? `: ${analysis.postcheck.violations.slice(0, 3).join('; ')}` : analysis?.error ? `: ${analysis.error}` : '';
    if (!analysis || analysis.status !== 'ok' || !String(analysis.writer?.body || '').trim() || !CATEGORIES.includes(analysis.category)) {
      throw new Error(`Hancal analysis produced no usable report (${analysis?.status || 'no result'}${problems}).`);
    }
    if (!analysis.ticketId) throw new Error('Hancal analysis did not return the ticket ID.');
    const category = analysis.category;
    let content = String(analysis.writer.body).trim();
    // Customize keeps the demo rule of the automatic workflow: no verified Playwright demo → fixed fallback sentence.
    if (!isHanReport(content) && category === 'Customize' && !content.includes(DEMO_FALLBACK)) content += `\n\n${DEMO_FALLBACK}`;
    assertReportHasNoProviderName(content);
    const comment = formatReviewComment(content, category);
    const counts = analysis.counts || {};
    const result = { category, canCustomize: null, bugType: 'unknown', browserCheck: analysis.browserAllowed ? 'storefront' : 'none', verificationNotes: '',
      reason: analysis.verified?.summary || '', comment: content, css: '', storefrontUrl: '', verified: (counts.browserCalls || 0) > 0, screenshotPath: '', screenshotVerified: false };
    const review = { target, ticketId: analysis.ticketId, category, result, comment, demoUrl: '', audit, analysis: 'hancal',
      ...(engineSnapshot?.enabled ? { engine: 'mcp-v2', engineRevision: engineSnapshot.revision } : {}),
      ...(followUp ? { followUp: { instruction: followUp.instruction, commentId: followUp.commentId || null, sinceAt: followUp.sinceAt || null, newComments: analysis.followUp?.newComments ?? null } } : {}),
      hancal: { runId: analysis.runId, jobDir: analysis.jobDir, status: analysis.status, timings: analysis.timings, counts, stats: analysis.verified?.stats || null, customerLetter: analysis.customerLetter || null } };
    if (isHanReport(content)) {
      Object.assign(review, reportArtifacts(parseHanReport(content, category)));
      await io.save?.('report.json', review.report);
      await io.save?.('report.md', review.fullReport);
    }
    await io.save?.('analysis.txt', describeHancalFindings(analysis));
    await io.save?.('review.json', review);
    await io.save?.('comment.txt', comment);
    io.trace?.('observation', `Đã soạn xong báo cáo ${category} (${comment.length} ký tự) từ ${analysis.verified?.stats?.total ?? '?'} findings đã kiểm${result.verified ? ' • có kiểm tra trình duyệt' : ''}`,
      { phase: 'compose', payload: { category, verified: result.verified, demo: false, analysis: 'hancal', stats: analysis.verified?.stats || null, timings: analysis.timings || null, audit } });
    return review;
  }
  const elite = await phase('elite', limits.eliteTimeoutMs, context => io.elite(target, context));
  if (!String(elite).trim()) throw new Error('TS Elite 2 returned no review.');
  await io.save?.('elite.txt', elite);
  // Tracing only (best-effort): which citations the initial answer relied on, and the ticket evidence read next.
  io.trace?.('observation', `Đã nhận câu trả lời ban đầu (${String(elite).length} ký tự)`, { phase: 'elite', sources: parseSourcesSection(elite) });
  const evidence = await io.evidence(target.reference);
  await io.save?.('input.json', { target, elite, evidence });
  io.trace?.('tool', `Đọc ticket Helpdesk ${evidence.ticketId || target.reference}${evidence.subject ? ` • ${evidence.subject}` : ''} (${(evidence.comments || []).length} comment)`, {
    phase: 'evidence', sources: [{ type: 'ticket', label: `Ticket ${evidence.ticketId || target.reference}`, url: target.url, excerpt: evidence.subject || null }],
  });
  const fallback = validateResult(await phase('classify', limits.classificationTimeoutMs, context =>
    io.worker('classify', { target, elite, evidence }, context)));
  // The classifier only reads Elite/ticket data; it cannot establish live verification.
  fallback.verified = false;
  fallback.screenshotVerified = false;
  fallback.screenshotPath = '';
  fallback.verificationNotes = '';
  await io.save?.('elite-fallback.json', fallback);
  let result = fallback;
  let browser;
  let demoUrl = '';
  const state = () => ({ target, elite, evidence, fallback, result, browser: browser?.info || null });
  const investigate = async (name, useBrowser = false, requireVerification = false) => {
    try {
      const next = validateResult(await phase(name, limits.branchTimeoutMs, async context => {
        if (useBrowser && !browser) browser = await io.browser(context);
        return io.worker(name, state(), context);
      }));
      if (next.category !== fallback.category) throw new Error('Worker changed the routed category.');
      if (requireVerification && !next.verified) throw new Error('Independent browser verification was incomplete.');
      result = next;
    } catch (error) {
      const reason = error.name === 'DeadlineError' ? 'timeout' : 'verification_incomplete';
      audit.push({ phase: name, status: 'elite_fallback', reason });
      io.trace?.('warning', `Pha ${name} không cho kết quả dùng được (${error.message}); giữ báo cáo từ bước phân loại`, { phase: name, payload: { status: 'elite_fallback', reason } });
      result = { ...fallback };
    }
  };
  // Explicit bug reports retain bug routing even if classified as a question.
  const isBugReview = fallback.category === 'Bug' || /^\s*\[bug\]/i.test(evidence.subject || '') || /^bug$/i.test(evidence.type || '')
    || (fallback.category !== 'Customize' && needsBugBrowser(fallback));
  const summarizeBugReport = async () => {
    const browserRequired = needsBugBrowser(fallback);
    const name = browserRequired ? 'bug-browser' : 'bug-report';
    try {
      result = await phase(name, limits.branchTimeoutMs, async context => {
        const report = validateResult(await io.worker(name, {
          target, elite, fallback, ...(browserRequired ? { evidence } : {}),
        }, context));
        if (report.category !== fallback.category) throw new Error('Bug report changed category.');
        if (browserRequired && (!report.verified || !report.verificationNotes.trim())) {
          throw new Error('MCP Playwright verification was incomplete.');
        }
        return { ...report, bugType:fallback.bugType, browserCheck:fallback.browserCheck,
          verified:browserRequired, verificationNotes:browserRequired ? report.verificationNotes : '',
          screenshotVerified:false, screenshotPath:'', css:'' };
      });
    } catch (error) {
      const reason = error.name === 'DeadlineError' ? 'timeout' : 'synthesis_failed';
      audit.push({ phase:name, status:'elite_fallback', reason });
      io.trace?.('warning', `Pha ${name} không cho kết quả dùng được (${error.message}); giữ báo cáo từ bước phân loại`, { phase:name, payload:{ status:'elite_fallback', reason } });
      result = { ...fallback, css:'', canCustomize:null };
    }
  };
  try {
    if (isBugReview) {
      await summarizeBugReport();
    } else if (fallback.category === 'Customize') {
      if (fallback.canCustomize === true) {
        await investigate('customize', true, true);
        if (result.verified && publishDemo) {
          try {
            demoUrl = await phase('demo', limits.demoTimeoutMs, async context => {
              if (!await io.demoAvailable()) throw new Error('Demo uploader is not configured.');
              const capture = validateResult(await io.worker('demo', state(), context));
              if (!capture.screenshotVerified || !capture.screenshotPath) throw new Error('No inspected Playwright demo screenshot.');
              return io.upload(capture.screenshotPath, context);
            });
          } catch (error) {
            demoUrl = '';
            io.trace?.('warning', `Không tạo được demo (${error.message}); comment dùng câu dự phòng`, { phase: 'demo', payload: { status: 'demo_fallback' } });
          }
        }
      } else {
        await investigate('customize-feasibility');
      }
    } else {
      await investigate(fallback.category === 'Feature request' ? 'feature-request' : 'question');
    }
  } finally {
    await browser?.close().catch(() => {});
  }
  const presentation = composeReviewPresentation(result, { demoUrl, demoRequired: !isBugReview && fallback.category === 'Customize' && fallback.canCustomize === true });
  const { comment } = presentation;
  const review = { target, ticketId: evidence.id, category: fallback.category, result, ...presentation, demoUrl, audit };
  if (review.report) { await io.save?.('report.json', review.report); await io.save?.('report.md', review.fullReport); }
  await io.save?.('review.json', review);
  await io.save?.('comment.txt', comment);
  io.trace?.('observation', `Đã soạn xong báo cáo ${fallback.category} (${comment.length} ký tự)${result.verified ? ' • có kiểm tra trình duyệt' : ''}${demoUrl ? ' • có demo' : ''}`,
    { phase: 'compose', payload: { category: fallback.category, verified: result.verified, demo: Boolean(demoUrl), audit } });
  return review;
}
