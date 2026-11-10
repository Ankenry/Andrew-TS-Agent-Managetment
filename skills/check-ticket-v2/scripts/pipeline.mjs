// check-ticket-v2 orchestrator: Chuẩn bị (code) → Điều tra (Codex + MCP tools) → Kiểm (code) →
// [one extra investigate round when a gap lacks a valid reason] → Viết (Codex, no tools) → Hậu kiểm (code).
// Preview only: nothing is posted anywhere. Every phase is timed; artifacts live under runtime/check-ticket-v2/.

import { readFile, writeFile, mkdir, appendFile } from 'node:fs/promises';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseHanReport, reportArtifacts } from '../../check-ticket/scripts/han-report.mjs';
import { ROOT } from '../../check-ticket/scripts/adapters.mjs';
import { ticketReference } from '../../check-ticket/scripts/core.mjs';
import { FINDINGS_SCHEMA, WRITER_SCHEMA, validateFindings } from './schema.mjs';
import { verifyFindings, mergeFindings } from './verify.mjs';
import { investigatorPrompt, finalizePrompt, writerPrompt } from './prompts.mjs';
import { checkWriterOutput, composeComment } from './postcheck.mjs';
import { runCodex } from './codex.mjs';
import { prepare } from './prepare.mjs';
import { loadCommentStyle } from '../../check-ticket/scripts/comment-style.mjs';
import { hasKeyFile, readKeyFile, createSourceApi, DEFAULT_ENDPOINT, DEFAULT_TIMEOUT_MS } from './source-api.mjs';
import { slackCoverage, slackRequirement } from './slack-evidence.mjs';
import { preSearch, DEFAULT_PRE_SEARCH } from './pre-search.mjs';
import { snapshotMcpEngine } from '../../../scripts/mcp-v2-settings.mjs';
import { prepareMcpContext, mcpPrompt } from '../../mcp-v2/scripts/engine.mjs';

export const V2_ROOT = resolve(ROOT, 'runtime/check-ticket-v2');
export const METRICS_FILE = resolve(V2_ROOT, 'metrics.jsonl');

export const DEFAULT_SOURCE_API = { enabled: true, endpoint: DEFAULT_ENDPOINT, timeoutMs: DEFAULT_TIMEOUT_MS, maxRetries: 1, keyFile: '.env_my' };

// `sourceApi` block of workflow.json merged with defaults; CHECK_TICKET_SOURCE_API=0|1 overrides `enabled` for one process.
export function normalizeSourceApi(value = {}, env = process.env) {
  const merged = { ...DEFAULT_SOURCE_API, ...(value && typeof value === 'object' ? value : {}) };
  if (env.CHECK_TICKET_SOURCE_API === '0' || env.CHECK_TICKET_SOURCE_API === 'false') merged.enabled = false;
  else if (env.CHECK_TICKET_SOURCE_API === '1' || env.CHECK_TICKET_SOURCE_API === 'true') merged.enabled = true;
  merged.enabled = merged.enabled !== false;
  merged.timeoutMs = Math.min(30000, Math.max(1000, Number(merged.timeoutMs) || DEFAULT_TIMEOUT_MS));
  merged.maxRetries = Math.min(3, Math.max(0, Number(merged.maxRetries) || 0));
  merged.endpoint = typeof merged.endpoint === 'string' && /^https?:\/\//.test(merged.endpoint) ? merged.endpoint : DEFAULT_ENDPOINT;
  merged.keyFile = typeof merged.keyFile === 'string' && merged.keyFile.trim() ? merged.keyFile.trim() : '.env_my';
  return merged;
}

export async function loadSettings() {
  const value = JSON.parse(await readFile(resolve(ROOT, 'skills/check-ticket-v2/workflow.json'), 'utf8'));
  // Hard ceilings from the ticket-review rule: 5 minutes per investigation phase.
  value.investigateTimeoutMs = Math.min(300000, Number(value.investigateTimeoutMs) || 300000);
  value.extraRoundTimeoutMs = Math.min(300000, Number(value.extraRoundTimeoutMs) || 180000);
  value.sourceApi = normalizeSourceApi(value.sourceApi);
  // 14/10/2026 speed work: scope lock, pre-search, Codex options (reasoning per phase, stop after submit).
  value.scopeLock = value.scopeLock !== false;
  value.preSearch = { ...DEFAULT_PRE_SEARCH, ...(value.preSearch && typeof value.preSearch === 'object' ? value.preSearch : {}) };
  value.codex = { investigateReasoning: '', writeReasoning: '', stopAfterSubmit: true, ...(value.codex && typeof value.codex === 'object' ? value.codex : {}) };
  for (const key of ['investigateReasoning', 'writeReasoning']) value.codex[key] = /^(minimal|low|medium|high|xhigh)$/.test(String(value.codex[key] || '')) ? String(value.codex[key]) : '';
  value.codex.stopAfterSubmit = value.codex.stopAfterSubmit !== false;
  return value;
}

// Valid findings file of a round → stop the investigator (its submit_findings already wrote it atomically).
async function submittedFindings(jobDir, round) {
  const value = await readJson(resolve(jobDir, `findings-round${round}.json`));
  return value && !validateFindings(value).length ? value : null;
}

// Decide per run whether the Source API tools are offered: setting on, app known, key file present.
export function sourceApiPlan(settings, prep, root = ROOT) {
  const config = normalizeSourceApi(settings?.sourceApi, {});
  if (!settings?.sourceApi || settings.sourceApi.enabled === false) return { enabled: false, reason: 'tắt trong workflow.json', config };
  if (!prep?.app?.slug) return { enabled: false, reason: 'chưa xác định app', config };
  const keyFile = resolve(root, config.keyFile);
  if (!hasKeyFile(keyFile)) return { enabled: false, reason: `không có BEARER_Auth trong ${config.keyFile}`, config };
  return { enabled: true, reason: null, config, keyFile };
}

async function readJson(path) { try { return JSON.parse(await readFile(path, 'utf8')); } catch { return null; } }
async function readToolLog(jobDir) {
  const text = await readFile(resolve(jobDir, 'tool-log.jsonl'), 'utf8').catch(() => '');
  return text.split('\n').filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
}
const shortArgs = args => JSON.stringify(args || {}).slice(0, 160);

// Sources for the verify phase are read straight from disk, limited to the two search roots.
function sourceReader(root) {
  const cache = new Map();
  const roots = ['apps_doc', 'knowledge-base'].map(name => resolve(root, name));
  return ref => {
    const rel = String(ref || '').replace(/^\.\//, '');
    if (cache.has(rel)) return cache.get(rel);
    const abs = resolve(root, rel);
    let text = null;
    if (roots.some(base => abs.startsWith(base + sep)) && existsSync(abs)) { try { text = readFileSync(abs, 'utf8'); } catch { text = null; } }
    cache.set(rel, text);
    return text;
  };
}

function scoreSummary(verified) {
  return verified.findings.map(finding => ({ id: finding.id, kind: finding.kind, score: finding.score, where: finding.evidence_where, inference: finding.inference, demoted: finding.demoted || false, gap_ok: finding.gap_ok, blocker: finding.blocker || null }));
}

// Pha Viết + Hậu kiểm; also used by rewriteJob() to redo only this part of an existing job.
export async function writeReport({ prep, verified, jobDir, settings, trace = async () => {}, log = () => {}, counts = {}, signal = null }) {
  if (slackRequirement(prep.ticket, prep.followUp).required && !prep.slack?.complete) return { writer: null, check: { ok: false, violations: ['Thiếu Slack evidence bắt buộc; không được rewrite artifact cũ thành report thành công'], warnings: [] } };
  const coverage = slackCoverage(prep.slack, verified.findings || []);
  if (coverage.length || verified.slackProblems?.length) return { writer: null, check: { ok: false, violations: [...coverage, ...(verified.slackProblems || [])], warnings: [] } };
  verified.slack = prep.slack || verified.slack || null;
  let writer = null; let check = null; let violations = []; let previous = null;
  const attempts = [];
  const style = await loadCommentStyle({ root: ROOT });
  if (style.enabled) await trace('note', `Nạp phong cách comment của người dùng (${style.rules.length} ký tự quy tắc, ${style.examples.length} ví dụ, ${style.config.sentencesMin}-${style.config.sentencesMax} câu)`, { phase: 'write', sources: [{ type: 'kb', path: style.config.profilePath, label: 'andrew-comment-style.md' }] });
  for (let attempt = 0; attempt <= settings.maxWriterRetries; attempt++) {
    if (attempt) { counts.writerRetries = (counts.writerRetries || 0) + 1; log(`write retry ${attempt}`); await trace('warning', `Hậu kiểm từ chối bản viết: ${violations.join('; ')} → viết lại (${attempt}/${settings.maxWriterRetries})`, { phase: 'write' }); }
    const deadline = Date.now() + settings.writeTimeoutMs;
    if (signal?.aborted) throw signal.reason || new Error('check-ticket-v2 aborted');
    const run = await runCodex({ root: ROOT, jobDir, label: attempt ? `write-${attempt}` : 'write', schema: WRITER_SCHEMA, deadline, signal, reasoning: settings.codex?.writeReasoning || '',
      prompt: writerPrompt(prep, verified, { violations, previous, maxChars: settings.commentMaxChars, minChars: settings.commentMinChars, letterMinScore: settings.letterMinScore, style }) });
    if (run.failure) await trace('warning', `Codex viết kết thúc bất thường: ${run.failure.message}`, { phase: 'write' });
    writer = run.last;
    check = checkWriterOutput(writer, verified, { ...settings, hanReport: true }, style);
    if (!writer && run.failure) check.violations.push(`codex: ${run.failure.message}`);
    attempts.push({ attempt, ok: check.ok, violations: check.violations, warnings: check.warnings || [], bodyChars: writer?.body ? String(writer.body).length : 0 });
    if (check.ok) { if (check.warnings?.length) await trace('warning', `Hậu kiểm giữ body, ${check.warnings.join('; ')}`, { phase: 'write' }); break; }
    violations = check.violations; previous = writer;
  }
  return { writer, check: { ...check, attempts } };
}

// Redo only the write phase of a finished job (same prepare.json + verified.json); for measuring the writer.
export async function rewriteJob(jobDir, { settings, log = () => {}, trace = async () => {} } = {}) {
  const prep = await readJson(resolve(jobDir, 'prepare.json'));
  const verified = await readJson(resolve(jobDir, 'verified.json'));
  if (!prep || !verified) throw new Error('Job thiếu prepare.json hoặc verified.json.');
  const counts = {}; const started = Date.now();
  const { writer, check } = await writeReport({ prep, verified, jobDir, settings, trace, log, counts });
  const result = { reference: prep.reference, jobDir, verified, writer, postcheck: check, timings: { write: Date.now() - started }, counts, totalMs: Date.now() - started };
  result.status = check?.ok ? 'ok' : (writer ? 'writer_rejected' : 'failed');
  if (check?.ok) {
    Object.assign(result, reportArtifacts(parseHanReport(writer.body, verified.category)));
    result.customerLetter = check?.letter || null;
    await writeFile(resolve(jobDir, 'comment.txt'), result.comment, { mode: 0o600 });
    await writeFile(resolve(jobDir, 'report.json'), JSON.stringify(result.report, null, 2), { mode: 0o600 });
    await writeFile(resolve(jobDir, 'report.md'), result.fullReport, { mode: 0o600 });
  }
  await writeFile(resolve(jobDir, 'writer.json'), JSON.stringify({ writer, check }, null, 2), { mode: 0o600 });
  return result;
}

// mode: 'manual' (CLI preview) or 'automatic' (called by the check-ticket controller, which then owns posting).
// jobDir: where artifacts go (default runtime/check-ticket-v2/<ticket>/<runId>); signal: abort from the caller's deadline.
// followUp (13/10/2026, "@bot" comment command): { instruction, commentId, commentAt, sinceAt, previousReport, … } — data for a
// follow-up check of the same ticket (new comments since sinceAt, screen captures, the instruction); see prepare.followUpContext.
export async function runPipeline(input, { settings, log = () => {}, trace = async () => {}, preview = true, jobDir: jobDirOverride = null, signal = null, mode = 'manual', followUp = null, prepareTicket = prepare, engineSnapshot = null } = {}) {
  engineSnapshot ||= await snapshotMcpEngine();
  const target = ticketReference(input);
  const runId = randomUUID();
  const jobDir = jobDirOverride ? resolve(jobDirOverride) : resolve(V2_ROOT, target.reference, runId);
  const checkAbort = () => { if (signal?.aborted) throw signal.reason || new Error('check-ticket-v2 aborted'); };
  await mkdir(resolve(jobDir, 'screenshots'), { recursive: true, mode: 0o700 });
  const timings = {}; const counts = { findings: 0, facts: 0, suggestions: 0, gaps: 0, demoted: 0, brokenQuotes: 0, inferences: 0, gapsInvalid: 0, searchedAuto: 0, extraRounds: 0, finalizeAttempts: 0, writerRetries: 0, toolCalls: 0, shellCommands: 0, browserCalls: 0, cssPreviewCalls: 0, codeFindings: 0, cssTried: 0, cssUntried: 0, shopSettingsCalls: 0, settingsFindings: 0, viewImageCalls: 0, crispCalls: 0, stoppedAfterSubmit: 0, preSearchMs: 0, preSearchOk: false, settingsPreOk: false };
  const timed = async (name, work) => { const started = Date.now(); try { return await work(); } finally { timings[name] = Date.now() - started; } };
  const save = (name, value) => writeFile(resolve(jobDir, name), typeof value === 'string' ? value : JSON.stringify(value, null, 2), { mode: 0o600 });
  const result = { reference: target.reference, url: target.url, runId, jobDir, status: 'running', preview, mode, followUp: followUp ? { instruction: String(followUp.instruction || '').slice(0, 500), commentId: followUp.commentId || null, sinceAt: followUp.sinceAt || null } : null };
  await trace('start', `check-ticket-v2 bắt đầu cho ${target.reference} (preview, 3 vai: điều tra → kiểm → viết${followUp ? `; CHECK TIẾP theo lệnh @bot: "${String(followUp.instruction || '').slice(0, 160)}"` : ''})`, { phase: 'prepare', payload: { runId, followUp: result.followUp } });

  // 1. Chuẩn bị -------------------------------------------------------------
  log('prepare');
  checkAbort();
  const prep = await timed('prepare', () => prepareTicket(target, { followUp, signal, preSettings: !engineSnapshot.enabled && settings.shopSettings?.enabled !== false && settings.shopSettings?.preRead !== false }));
  result.ticketId = prep.ticket.id; result.subject = prep.ticket.subject;
  await save('prepare.json', prep);
  await save('slack-evidence.json', prep.slack);
  if (prep.slack?.required && !prep.slack.complete) {
    result.status = 'incomplete'; result.error = `Chưa đọc đầy đủ thread dev: ${(prep.slack.errors || []).map(e => e.code).join(', ')}`;
    await finish(); return result;
  }
  if (engineSnapshot.enabled) {
    prep.mcpV2 = await prepareMcpContext(ROOT, prep, jobDir, { signal });
    prep.browserAllowed = false; // No standalone browser may bypass the official MCP adapter.
    // New catalog apps must not inherit the legacy unknown-app global search.
    if (!prep.app.slug) prep.app = { ...prep.app, slug: prep.mcpV2.app, codeRoot: null, kbRoots: [] };
    prep.scope = { ...(prep.scope || {}), locked: true, kbRoots: prep.app.kbRoots || [], commonRoots: prep.scope?.commonRoots || [], codeRoot: prep.app.codeRoot || null };
    result.engine = 'mcp-v2'; result.engineRevision = engineSnapshot.revision;
    await save('engine.json', engineSnapshot);
  }
  if (prep.app.appConflict) await trace('note', `App theo trường app của ticket (${prep.app.appConflict.appName} → ${prep.app.appConflict.appNameSlug}) khác tiền tố ${prep.app.appConflict.prefix} (${prep.app.appConflict.prefixSlug}); chọn ${prep.app.appConflict.chosen}`, { phase: 'prepare', payload: prep.app.appConflict });
  if (prep.settingsPre && !prep.settingsPre.error && (prep.settingsPre.lines || []).length) {
    // The pre-read is quoted from the prompt, so the verifier must see it as a shop_settings output: one round-0 log line.
    const header = `[nguồn: settings:${prep.app.slug}/storefront · ${prep.settingsPre.url} · HTTP ${prep.settingsPre.status ?? '?'}${prep.settingsPre.password ? ' · TRANG MẬT KHẨU' : ''} · đọc lúc ${prep.settingsPre.at}]`;
    await appendFile(resolve(jobDir, 'tool-log.jsonl'), JSON.stringify({ seq: 0, round: 0, at: prep.settingsPre.at, tool: 'shop_settings', args: { app: prep.app.slug, url: prep.settingsPre.url, source: 'storefront', preRead: true }, ok: true, ms: 0, output: [header, ...prep.settingsPre.lines].join('\n') }) + '\n', { mode: 0o600 }).catch(() => {});
  }
  if (prep.settingsPre) { counts.settingsPreOk = !prep.settingsPre.error && (prep.settingsPre.lines || []).length > 0; await trace('note', prep.settingsPre.error ? `Đọc trước cấu hình shop: không được (${prep.settingsPre.error})` : `Đọc trước cấu hình shop trên ${prep.settingsPre.url}: ${(prep.settingsPre.lines || []).length} dòng key = value${prep.settingsPre.password ? ' (trang mật khẩu)' : ''}`, { phase: 'prepare', payload: { url: prep.settingsPre.url, lines: (prep.settingsPre.lines || []).length, error: prep.settingsPre.error || null } }); }
  if (prep.followUp) result.followUp = { ...result.followUp, newComments: prep.followUp.newComments.length, imageLinks: prep.followUp.imageLinks.length };
  // Crisp (13/10/2026 rule: read the chat when the ticket is unclear): the tool exists only when the ticket has a Crisp link.
  const crispEnabled = !engineSnapshot.enabled && settings.crisp?.enabled !== false && /^https:\/\/app\.crisp\.chat\//.test(String(prep.ticket.chatLink || ''));
  await trace('phase', `Chuẩn bị xong: app ${prep.app.slug || '?'} (code ${prep.app.codeRoot || 'không'}, KB ${prep.app.kbRoots.length} nguồn), ${prep.oldCases.length} case cũ, ${prep.lessons.length} bài học, browser ${prep.browserAllowed ? 'bật' : 'tắt'}${prep.customizeHint ? ', dấu hiệu Customize → bắt buộc có khối code' : ''}${prep.settingHint ? ', dấu hiệu setting → phải đọc cấu hình shop' : ''}${prep.followUp ? `, check tiếp: ${prep.followUp.newComments.length} comment mới từ ${prep.followUp.sinceAt || 'đầu ticket'}, ${prep.followUp.imageLinks.length} link ảnh` : ''}${crispEnabled ? ', có link Crisp (crisp_read sẵn)' : ''}`,
    { phase: 'prepare', payload: { app: prep.app, browserAllowed: prep.browserAllowed, oldCases: prep.oldCases.map(item => item.reference), followUp: result.followUp, crisp: crispEnabled }, sources: [{ type: 'ticket', url: target.url, label: target.reference }, ...prep.app.kbRoots.map(path => ({ type: 'kb', path, label: path }))] });
  result.app = prep.app; result.browserAllowed = prep.browserAllowed;
  const sourceApi = engineSnapshot.enabled ? { enabled: false, reason: 'MCP_V2_USE_GITLAB_RESEARCH' } : sourceApiPlan(settings, prep);
  result.sourceApi = { enabled: sourceApi.enabled, reason: sourceApi.reason, endpoint: sourceApi.enabled ? sourceApi.config.endpoint : null };
  await trace('note', sourceApi.enabled ? `Mã nguồn đọc qua API nguồn (bản mới nhất; apps_doc${prep.app.codeRoot ? '' : ' không có'} làm dự phòng)` : `Mã nguồn đọc từ apps_doc (API nguồn không dùng: ${sourceApi.reason})`, { phase: 'prepare', payload: result.sourceApi });
  const scopeLocked = (engineSnapshot.enabled || settings.scopeLock !== false) && Boolean(prep.scope?.locked);
  await trace('note', scopeLocked ? `Phạm vi tra khóa theo app ${prep.app.slug}: ${prep.scope.kbRoots.length} nguồn KB + ${prep.scope.commonRoots.length} nguồn chung, mã nguồn chỉ app này` : 'Phạm vi tra mở (app chưa xác định hoặc scopeLock tắt)', { phase: 'prepare', payload: { locked: scopeLocked, scope: prep.scope } });
  // Tiền tra (14/10/2026): one multi_search by code with keywords from the ticket, before the model's first turn.
  if (sourceApi.enabled && settings.preSearch?.enabled !== false && !followUp) {
    checkAbort();
    const key = readKeyFile(sourceApi.keyFile);
    const api = key ? createSourceApi({ key, endpoint: sourceApi.config.endpoint, timeoutMs: sourceApi.config.timeoutMs, maxRetries: 0 }) : null;
    prep.preSearch = await timed('preSearch', () => preSearch({ ticket: prep.ticket, app: prep.app.slug, settingHint: prep.settingHint, api, jobDir, settings: settings.preSearch }));
    if (prep.preSearch) { counts.preSearchMs = prep.preSearch.ms; counts.preSearchOk = Boolean(prep.preSearch.ok); await trace(prep.preSearch.ok ? 'tool' : 'note', prep.preSearch.ok ? `Tiền tra source_search ${JSON.stringify(prep.preSearch.queries)} → ${prep.preSearch.files.length} file có kết quả (${(prep.preSearch.ms / 1000).toFixed(1)}s)` : `Tiền tra không có kết quả: ${prep.preSearch.reason}`, { phase: 'prepare', actor: 'prepare', payload: { queries: prep.preSearch.queries, files: prep.preSearch.files, ms: prep.preSearch.ms, ok: prep.preSearch.ok } }); }
  } else prep.preSearch = null;
  await save('prepare.json', prep);

  // 2. Điều tra -------------------------------------------------------------
  log('investigate');
  // The key itself never goes into this env (it would land on Codex's command line); the server reads the key file.
  const serverEnv = round => ({
    V2_MCP_ENGINE: engineSnapshot.enabled ? '1' : '0',
    V2_ROOT: ROOT, V2_JOB_DIR: jobDir, V2_APP: prep.app.slug || '', V2_KB_SLUG: prep.app.kb || '', V2_BROWSER_ALLOWED: prep.browserAllowed ? '1' : '0',
    V2_MAX_TURNS: String(round === 1 ? settings.maxTurns : settings.extraRoundMaxTurns), V2_MAX_BROWSER: String(settings.maxBrowserCalls), V2_MAX_CSS_PREVIEW: String(settings.maxCssPreviewCalls ?? 4), V2_ROUND: String(round),
    ...(settings.shopSettings?.enabled !== false ? { V2_MAX_SHOP_SETTINGS: String(settings.shopSettings?.maxCalls ?? 3), V2_SHOP_SETTINGS_TIMEOUT_MS: String(settings.shopSettings?.timeoutMs ?? 10000), V2_SHOP_SETTINGS_KEY_FILE: resolve(ROOT, settings.shopSettings?.keyFile || '.env_my') } : { V2_MAX_SHOP_SETTINGS: '0' }),
    V2_MAX_VIEW_IMAGE: String(settings.maxViewImageCalls ?? 4), V2_SCOPE_LOCK: scopeLocked ? '1' : '0',
    ...(crispEnabled ? { V2_CRISP_URL: String(prep.ticket.chatLink).trim(), V2_CRISP_MAX: String(settings.crisp?.maxCalls ?? 2), V2_CRISP_TIMEOUT_MS: String(settings.crisp?.timeoutMs ?? 120000), V2_CRISP_SCRIPT: resolve(ROOT, settings.crisp?.script || 'apps_doc/chatty-check-skills/skills/read-crisp-chat/scripts/read_crisp_chat.py'), V2_CRISP_ENV_FILE: resolve(ROOT, settings.crisp?.envFile || 'apps_doc/chatty-check-skills/.env') } : {}),
    ...(process.env.V2_RG ? { V2_RG: process.env.V2_RG } : {}), ...(process.env.TICKET_CHROME_BIN ? { TICKET_CHROME_BIN: process.env.TICKET_CHROME_BIN } : {}),
    ...(sourceApi.enabled ? { SOURCE_API_ENABLED: '1', SOURCE_API_URL: sourceApi.config.endpoint, SOURCE_API_TIMEOUT_MS: String(sourceApi.config.timeoutMs), SOURCE_API_RETRIES: String(sourceApi.config.maxRetries), SOURCE_API_KEY_FILE: sourceApi.keyFile } : {}),
  });
  let findings = null; let lastText = null;
  checkAbort();
  await timed('investigate', async () => {
    const deadline = Date.now() + settings.investigateTimeoutMs;
    const stopAfterSubmit = settings.codex?.stopAfterSubmit !== false;
    const run = await runCodex({ root: ROOT, jobDir, label: 'investigate', schema: stopAfterSubmit ? null : FINDINGS_SCHEMA, deadline, signal, serverEnv: { ...serverEnv(1), V2_DEADLINE: String(deadline) }, reasoning: settings.codex?.investigateReasoning || '',
      stopWhen: stopAfterSubmit ? () => submittedFindings(jobDir, 1) : null,
      prompt: investigatorPrompt(prep, { deadline, maxTurns: settings.maxTurns, browserAllowed: prep.browserAllowed, sourceApi: sourceApi.enabled, crisp: crispEnabled }) + mcpPrompt(prep.mcpV2) });
    counts.shellCommands += run.items.filter(item => item.type === 'command_execution').length;
    if (run.stopped) { counts.stoppedAfterSubmit++; await trace('note', 'Điều tra đã nộp findings → dừng Codex ngay, không chờ câu trả lời cuối', { phase: 'investigate' }); }
    if (run.failure) await trace('warning', `Codex điều tra kết thúc bất thường: ${run.failure.message}`, { phase: 'investigate' });
    findings = await submittedFindings(jobDir, 1);
    if (!findings && run.last && !validateFindings(run.last).length) { findings = run.last; await trace('note', 'Điều tra không gọi submit_findings nhưng trả lời cuối đúng schema → dùng câu trả lời cuối', { phase: 'investigate' }); }
    lastText = run.last ? JSON.stringify(run.last) : run.items.filter(item => item.type === 'agent_message').map(item => item.text).join('\n');
  });
  let toolLog = await readToolLog(jobDir);
  for (const call of toolLog) await trace('tool', `${call.tool} ${shortArgs(call.args)}${call.ok ? '' : ' (lỗi)'}`, { phase: 'investigate', actor: 'investigator', payload: { ms: call.ms, ok: call.ok, output: String(call.output).slice(0, 600) } });

  // 2b. Finalize: no valid submission → remind up to N times, without tools, from the tool log.
  await timed('finalize', async () => {
    for (let attempt = 1; !findings && attempt <= settings.maxFinalizeAttempts; attempt++) {
      checkAbort();
      counts.finalizeAttempts++;
      log(`finalize ${attempt}`);
      await trace('warning', `Điều tra chưa nộp findings hợp lệ → nhắc nộp lần ${attempt}/${settings.maxFinalizeAttempts}`, { phase: 'investigate' });
      const deadline = Date.now() + settings.finalizeTimeoutMs;
      const run = await runCodex({ root: ROOT, jobDir, label: `finalize-${attempt}`, schema: FINDINGS_SCHEMA, deadline, signal, prompt: finalizePrompt(prep, toolLog, lastText, attempt) });
      if (run.last && !validateFindings(run.last).length) findings = run.last;
      else lastText = run.last ? JSON.stringify(run.last) : lastText;
    }
  });
  if (!findings) {
    result.status = 'failed'; result.error = 'Điều tra không nộp được findings hợp lệ sau các lần nhắc.';
    await finish();
    return result;
  }
  await save('findings.json', findings);
  result.category = findings.category;
  await trace('observation', `Điều tra nộp ${findings.findings.length} findings · loại ${findings.category} · ${findings.summary}`, { phase: 'investigate', actor: 'investigator', payload: { category: findings.category, categoryReason: findings.category_reason, browserImpact: findings.browser_impact, sources: findings.sources } });

  // 3. Kiểm -----------------------------------------------------------------
  log('verify');
  const ctx = { readSource: sourceReader(ROOT), ticketText: prep.ticketText, toolLog, slack: prep.slack };
  let verified = await timed('verify', async () => verifyFindings(findings, ctx));
  await trace('observation', `thinking_scores: ${verified.stats.facts} fact (${verified.stats.demoted} hạ thành gap vì quote hỏng), ${verified.stats.suggestions} đề xuất, ${verified.stats.gaps} gap (${verified.stats.gapsInvalid} thiếu lý do${verified.stats.searchedAuto ? `, ${verified.stats.searchedAuto} gap được điền searched từ log tool` : ''}), ${verified.stats.inferences} câu nối thành suy luận`,
    { phase: 'verify', payload: { kind: 'thinking_scores', stats: verified.stats, scores: scoreSummary(verified), needsInvestigation: verified.needsInvestigation } });

  // 3b. Exactly one extra tool round for gaps without a valid reason.
  if (verified.needsInvestigation.length) {
    log('extra round');
    counts.extraRounds = 1;
    await trace('phase', `Gap thiếu lý do (${verified.needsInvestigation.map(item => item.id).join(', ')}) → chạy thêm đúng 1 vòng điều tra có tool`, { phase: 'investigate-extra', payload: { gaps: verified.needsInvestigation } });
    checkAbort();
    await timed('extraRound', async () => {
      const deadline = Date.now() + settings.extraRoundTimeoutMs;
      const stopAfterSubmit = settings.codex?.stopAfterSubmit !== false;
      const run = await runCodex({ root: ROOT, jobDir, label: 'investigate-extra', schema: stopAfterSubmit ? null : FINDINGS_SCHEMA, deadline, signal, serverEnv: { ...serverEnv(2), V2_DEADLINE: String(deadline) }, reasoning: settings.codex?.investigateReasoning || '',
        stopWhen: stopAfterSubmit ? () => submittedFindings(jobDir, 2) : null,
        prompt: investigatorPrompt(prep, { deadline, maxTurns: settings.extraRoundMaxTurns, browserAllowed: prep.browserAllowed, round: 2, gaps: verified.needsInvestigation, previous: findings, sourceApi: sourceApi.enabled, crisp: crispEnabled }) + mcpPrompt(prep.mcpV2) });
      counts.shellCommands += run.items.filter(item => item.type === 'command_execution').length;
      if (run.stopped) { counts.stoppedAfterSubmit++; await trace('note', 'Vòng bổ sung đã nộp findings → dừng Codex ngay', { phase: 'investigate-extra' }); }
      if (run.failure) await trace('warning', `Codex vòng bổ sung kết thúc bất thường: ${run.failure.message}`, { phase: 'investigate-extra' });
      let extra = await submittedFindings(jobDir, 2);
      if (!extra && run.last && !validateFindings(run.last).length) extra = run.last;
      const before = toolLog.length;
      toolLog = await readToolLog(jobDir);
      for (const call of toolLog.slice(before)) await trace('tool', `${call.tool} ${shortArgs(call.args)}${call.ok ? '' : ' (lỗi)'}`, { phase: 'investigate-extra', actor: 'investigator', payload: { ms: call.ms, ok: call.ok, output: String(call.output).slice(0, 600) } });
      if (extra) {
        findings = mergeFindings(findings, extra);
        await save('findings.json', findings);
        verified = verifyFindings(findings, { ...ctx, toolLog });
        await trace('observation', `thinking_scores sau vòng bổ sung: ${verified.stats.gaps} gap (${verified.stats.gapsInvalid} vẫn thiếu lý do), ${verified.stats.demoted} fact bị hạ`, { phase: 'verify', payload: { kind: 'thinking_scores', stats: verified.stats, scores: scoreSummary(verified), needsInvestigation: verified.needsInvestigation } });
      } else await trace('warning', 'Vòng bổ sung không nộp findings → giữ kết quả kiểm trước đó', { phase: 'investigate-extra' });
    });
  }
  // Source API bookkeeping: commit/age of the clone each api: finding came from, counts for metrics.
  const sourceState = await readJson(resolve(jobDir, 'source-api.json'));
  if (sourceState) {
    for (const finding of verified.findings) {
      const match = /^api:([a-z0-9-]+)\//.exec(String(finding.source?.ref || ''));
      const app = match ? sourceState.apps?.[match[1]] : null;
      if (app) { finding.source_commit = app.commit || null; finding.source_age_minutes = app.ageMinutes ?? null; finding.source_ref_name = app.ref || null; }
    }
    counts.sourceApiCalls = Number(sourceState.calls) || 0; counts.sourceApiFallbacks = Number(sourceState.fallbacks) || 0;
    result.sourceApi = { ...result.sourceApi, calls: counts.sourceApiCalls, fallbacks: counts.sourceApiFallbacks, keyMissing: Boolean(sourceState.keyMissing), apps: Object.fromEntries(Object.entries(sourceState.apps || {}).map(([slug, info]) => [slug, { commit: info.commit, ageMinutes: info.ageMinutes, ref: info.ref }])), errors: (sourceState.errors || []).slice(0, 5) };
  }
  await save('verified.json', verified);
  Object.assign(counts, { findings: verified.stats.total, facts: verified.stats.facts, suggestions: verified.stats.suggestions, gaps: verified.stats.gaps, demoted: verified.stats.demoted, brokenQuotes: verified.stats.brokenQuotes, inferences: verified.stats.inferences, gapsInvalid: verified.stats.gapsInvalid, searchedAuto: verified.stats.searchedAuto || 0, cssTried: verified.stats.cssTried || 0, cssUntried: verified.stats.cssUntried || 0 });
  counts.toolCalls = toolLog.filter(call => call.tool !== 'submit_findings' && call.round !== 0).length;
  counts.browserCalls = toolLog.filter(call => call.tool === 'browser_check' && call.ok).length;
  counts.cssPreviewCalls = toolLog.filter(call => call.tool === 'css_preview' && call.ok).length;
  counts.codeFindings = verified.findings.filter(finding => typeof finding.code === 'string' && finding.code.trim()).length;
  counts.shopSettingsCalls = toolLog.filter(call => call.tool === 'shop_settings' && call.ok && call.round !== 0).length;
  counts.settingsFindings = verified.findings.filter(finding => /^settings:/.test(String(finding.source?.ref || ''))).length;
  counts.viewImageCalls = toolLog.filter(call => call.tool === 'view_image' && call.ok).length;
  counts.crispCalls = toolLog.filter(call => call.tool === 'crisp_read' && call.ok).length;
  verified.settingHint = Boolean(prep.settingHint); // the postcheck warns when a settings-looking ticket has no configuration finding
  verified.followUp = prep.followUp ? { newComments: prep.followUp.newComments.length, instruction: prep.followUp.instruction } : null; // postcheck warning only
  result.verified = verified;
  if (verified.slackProblems?.length) {
    result.status = 'incomplete'; result.error = verified.slackProblems.join('; ');
    await finish(); return result;
  }

  // 4. Viết + 5. Hậu kiểm ------------------------------------------------------
  log('write');
  checkAbort();
  let writer = null; let check = null;
  await timed('write', async () => { ({ writer, check } = await writeReport({ prep, verified, jobDir, settings, trace, log, counts, signal })); });
  await save('writer.json', { writer, check });
  result.writer = writer; result.postcheck = check;
  if (check?.ok) {
    Object.assign(result, reportArtifacts(parseHanReport(writer.body, verified.category)));
    await save('report.json', result.report);
    await save('report.md', result.fullReport);
    result.customerLetter = check?.letter || null;
    await save('comment.txt', result.comment);
  }
  result.status = check?.ok ? 'ok' : (writer ? 'writer_rejected' : 'failed');
  if (result.status === 'ok') await trace('result', result.comment, { phase: 'write', actor: 'writer', payload: { letter: result.customerLetter || null } });
  else await trace('error', `Viết không đạt hậu kiểm: ${(check?.violations || ['không có đầu ra']).join('; ')}`, { phase: 'write' });
  await finish();
  return result;

  async function finish() {
    result.timings = timings; result.counts = counts;
    result.totalMs = Object.values(timings).reduce((sum, value) => sum + value, 0);
    const metrics = { at: new Date().toISOString(), mode, reference: target.reference, runId, status: result.status, category: result.category || null, app: prep?.app?.slug || null, appBy: prep?.app?.by || null, appConflict: Boolean(prep?.app?.appConflict), scopeLocked: Boolean(settings.scopeLock !== false && prep?.scope?.locked), timings, counts, totalMs: result.totalMs, followUp: Boolean(followUp),
      sourceApi: result.sourceApi ? { enabled: result.sourceApi.enabled, calls: result.sourceApi.calls ?? 0, fallbacks: result.sourceApi.fallbacks ?? 0, apps: result.sourceApi.apps || {} } : null };
    await save('metrics.json', metrics);
    await appendFile(METRICS_FILE, JSON.stringify(metrics) + '\n', { mode: 0o600 }).catch(() => {});
    await trace(result.status === 'ok' ? 'done' : 'error', `Kết thúc (${result.status}) sau ${(result.totalMs / 1000).toFixed(1)}s · ${Object.entries(timings).map(([name, ms]) => `${name} ${(ms / 1000).toFixed(1)}s`).join(', ')}`, { phase: 'done', payload: metrics });
  }
}
