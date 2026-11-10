import { readCommentEvidence } from './comment-evidence.mjs';
import { readFile, writeFile, appendFile, mkdir, readdir, realpath } from 'node:fs/promises';
import { resolve, dirname, join, sep, basename } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { runWorker } from './worker.mjs';
import { getHelpdeskCommentAuthor } from '../../../scripts/helpdesk-comment-author.mjs';
import { ANDREW_ID } from './handoff.mjs';
import { assertReportHasNoProviderName, normalizeLimits } from './core.mjs';
import { helpdeskFetch, safeHelpdeskDiagnostics } from '../../../scripts/helpdesk-http.mjs';
import { snapshotMcpEngine } from '../../../scripts/mcp-v2-settings.mjs';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
export { ANDREW_ID };
export const STATE_PATH = resolve(ROOT, 'runtime/check-ticket/state.json');
const API = 'https://helpdesk.avada.net/api/external';

export async function settings() {
  const value = JSON.parse(await readFile(resolve(ROOT, 'skills/check-ticket/workflow.json'), 'utf8'));
  value.enabled = value.enabled === true && process.env.CHECK_TICKET_AUTOMATION_ENABLED !== 'false';
  // Configuration may shorten deadlines for tests/operations, never exceed user limits.
  for (const [key, max] of Object.entries({ branchTimeoutMs:300000, demoTimeoutMs:120000, eliteTimeoutMs:190000, classificationTimeoutMs:90000 })) {
    value[key] = Math.min(max, Math.max(1, Number(value[key]) || max));
  }
  // `analysis` (hancal | elite) and hancalTimeoutMs; CHECK_TICKET_ANALYSIS overrides the file for one process.
  if (process.env.CHECK_TICKET_ANALYSIS) value.analysis = process.env.CHECK_TICKET_ANALYSIS;
  return normalizeLimits(value);
}

async function envFile() {
  const text = await readFile(resolve(ROOT, '.env_my'), 'utf8');
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (match) values[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return values;
}

export async function helpdesk(path, { method = 'GET', body, signal } = {}) {
  const env = await envFile();
  const token = process.env.API_AVADA_TICKET || env.API_AVADA_TICKET;
  if (!token) throw new Error('Missing Helpdesk credential.');
  let response;
  try {
    response = await helpdeskFetch(API + path, {
      method, headers: { 'X-API-Key':token, 'Content-Type':'application/json' },
      ...(body === undefined ? {} : { body:JSON.stringify(body) }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000),
    });
  } catch (error) { throw Object.assign(new Error(method === 'POST' ? 'Helpdesk POST outcome is unknown.' : 'Helpdesk read failed.'), {detail:safeHelpdeskDiagnostics(error.detail)}); }
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.success) throw Object.assign(new Error(`Helpdesk ${method} failed (HTTP ${response.status}).`),
    {detail:safeHelpdeskDiagnostics({...response.diagnostics,phase:'api',errorCode:!response.ok?'HTTP_ERROR':payload?'API_REJECTED':'INVALID_JSON'})});
  return payload.data;
}

export async function readEvidence(reference, get = helpdesk, options = {}) {
  const data = await get(`/tickets/${encodeURIComponent(reference)}`);
  const ticket = data?.ticket || data;
  if (!ticket?.id) throw new Error('Helpdesk did not return a ticket ID.');
  const comments = await readCommentEvidence(ticket.id, get, options);
  if (!options.allComments && comments.meta.error && comments.meta.error !== 'snapshot_incomplete' && comments.meta.error !== 'missing_cursor_or_count' && comments.meta.error !== 'unproven_end') throw new Error('Helpdesk comments read failed.');
  return {
    id:ticket.id, ticketId:ticket.ticketId, subject:ticket.subject, description:ticket.description,
    appName:ticket.appName, type:ticket.type, storeDomains:ticket.storeDomains,
    chatLink:ticket.chatLink, slackLink:ticket.slackLink, tsStatus:ticket.tsStatus, ticketStatus:ticket.ticketStatus,
    comments:comments.actions.map(a => ({ id:a.id, content:a.metadata?.content || a.content || '', author:a.author?.displayName || '', authorId:a.author?.memberId || '', createdAt:a.createdAt })),
    createdAt:ticket.createdAt || null, updatedAt:ticket.updatedAt || null,
    commentLimit: options.allComments ? null : 100, commentEvidence: comments.meta,
  };
}

export async function findPostedComment(ticketId, content, get = helpdesk, { since = null, until = null, receiptId = null, requireReceiptId = false, excludeIds = [], exactBody = false } = {}) {
  if (requireReceiptId && !receiptId) throw new Error('ACK receipt ID required; text-only reconciliation is unsafe.');
  const data = await get(`/tickets/${encodeURIComponent(ticketId)}/actions?type=commentTicket&limit=100`);
  if (!Array.isArray(data?.actions)) throw new Error('Comment reconciliation read unavailable.');
  const matches = (data?.actions || []).filter(action => action.author?.memberId === ANDREW_ID
    && (!receiptId || action.id === receiptId)
    && (!until || Date.parse(action.createdAt || '') < Date.parse(until))
    && !excludeIds.includes(action.id)
    && (!since || Date.parse(action.createdAt || '') >= Date.parse(since))
    && (!exactBody || (!action.author?.authUid && (!action.type || action.type === 'commentTicket')))
    && (exactBody ? String(action.metadata?.content || action.content || '') === content : String(action.metadata?.content || action.content || '').trim() === content.trim()));
  if (since && matches.length > 1) throw new Error('Multiple comments match this delivery; manual reconciliation required.');
  return matches[0] || null;
}

export async function postComment(ticketId, content, request = helpdesk, mentions = []) {
  assertReportHasNoProviderName(content);
  let author;
  try { author = await getHelpdeskCommentAuthor(request, ANDREW_ID); }
  catch (error) { error.deliveryPhase = 'author_lookup'; error.postAttempted = false; throw error; }
  try { return await request(`/tickets/${encodeURIComponent(ticketId)}/comments`, { method:'POST', body:{ content, author,
    ...(mentions.length ? { mentions:mentions.map(({memberId,displayName}) => ({memberId,displayName})) } : {}) } }); }
  catch (error) { error.deliveryPhase = 'post'; error.postAttempted = true; throw error; }
}

async function playwrightPath() {
  const require = createRequire(import.meta.url);
  try { return require.resolve('playwright'); } catch {}
  const cache = resolve(homedir(), '.npm/_npx');
  for (const name of await readdir(cache).catch(() => [])) {
    const path = join(cache, name, 'node_modules/playwright/index.mjs');
    try { await readFile(path); return path; } catch {}
  }
  throw new Error('Playwright is not installed; using Elite fallback.');
}

export async function openBrowser({ signal, deadline }) {
  const modulePath = await playwrightPath();
  const { chromium } = await import(pathToFileURL(modulePath).href);
  if (signal.aborted) throw signal.reason;
  const server = await chromium.launchServer({
    executablePath:process.env.TICKET_CHROME_BIN || '/usr/bin/google-chrome',
    headless:true, host:'127.0.0.1', timeout:Math.max(1, Math.min(20000, deadline-Date.now())),
    args:['--disable-extensions', '--no-first-run', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0'],
  });
  const close = async () => {
    let timer;
    try { await Promise.race([server.close(), new Promise(resolveClose => { timer=setTimeout(() => { server.kill().catch(() => {}); resolveClose(); }, 3000); })]); }
    finally { clearTimeout(timer); }
  };
  if (signal.aborted) { await close(); throw signal.reason; }
  const abort = () => { server.kill().catch(() => {}); };
  signal.addEventListener('abort', abort, { once:true });
  let endpoint;
  try {
    // CDP shares the same disposable preview page across customize/demo workers.
    // Separate Playwright protocol clients cannot see one another's contexts.
    const profileArg = server.process().spawnargs.find(arg => arg.startsWith('--user-data-dir='));
    if (!profileArg) throw new Error('Missing isolated browser profile path.');
    const [port] = (await readFile(resolve(profileArg.slice('--user-data-dir='.length), 'DevToolsActivePort'), 'utf8')).split('\n');
    if (!/^\d+$/.test(port)) throw new Error('Invalid isolated browser endpoint.');
    endpoint = `http://127.0.0.1:${port}`;
    const connection = await chromium.connectOverCDP(endpoint, { timeout:Math.max(1,Math.min(20000,deadline-Date.now())) });
    const context = connection.contexts()[0];
    if (!context) throw new Error('Missing isolated browser context.');
    const page = context.pages()[0] || await context.newPage();
    await page.setViewportSize({ width:1365, height:900 });
  } catch (error) { await close(); throw error; }
  finally { signal.removeEventListener('abort',abort); }
  if (signal.aborted) { await close(); throw signal.reason; }
  return { info:{ endpoint, playwrightModule:modulePath, connectionMethod:'chromium.connectOverCDP', extensionsDisabled:true, headless:true }, close };
}

async function uploadConfig() {
  const env = await envFile();
  return { url:process.env.TICKET_DEMO_UPLOAD_URL || env.TICKET_DEMO_UPLOAD_URL || '', token:process.env.TICKET_DEMO_UPLOAD_TOKEN || env.TICKET_DEMO_UPLOAD_TOKEN || '' };
}

export async function uploadDemo(file, screenshotDir, { signal }) {
  const { url, token } = await uploadConfig();
  if (!url || new URL(url).protocol !== 'https:') throw new Error('No HTTPS demo uploader configured.');
  const actual = await realpath(file);
  const allowed = await realpath(screenshotDir);
  if (!actual.startsWith(allowed + sep) || !actual.endsWith('.png')) throw new Error('Screenshot is outside this review job.');
  const bytes = await readFile(actual);
  if (bytes.length > 15_000_000 || !bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw new Error('Invalid screenshot PNG.');
  const form = new FormData(); form.append('file', new Blob([bytes], { type:'image/png' }), 'ticket-demo.png');
  const response = await fetch(url, { method:'POST', headers:token ? { Authorization:`Bearer ${token}` } : {}, body:form, signal });
  if (!response.ok) throw new Error('Screenshot upload failed.');
  const data = await response.json();
  const link = String(data.url || data.data?.url || '');
  if (!link || new URL(link).protocol !== 'https:') throw new Error('Uploader returned no HTTPS demo URL.');
  const verification = await fetch(link, { method:'HEAD', signal });
  if (!verification.ok) throw new Error('Demo URL could not be verified.');
  return link;
}

// Best-effort tracing into the local Hachimi tracing web (scripts/hachimi-trace-web.mjs). Never throws, never blocks the review.
// trace(kind, text, { phase, payload, sources, actor }) or trace([{ kind, text, phase, payload, sources, actor }, ...]).
// `sources` lists the data consulted at that step ({ type: docs|skill|kb|elite|ticket|url|artifact, path|url, label, excerpt }).
// Events carry the time they were emitted and leave in that order. Each one is also appended to <job>/trace.jsonl;
// the file sync stores the lines marked delivered:false later, so a stopped tracing web does not lose them.
const TRACE_ROOT = resolve(ROOT, 'runtime/check-ticket') + sep;
export const TRACE_LOG = 'trace.jsonl';
let traceQueue = Promise.resolve();
export function jobTraceEmitter(jobRoot, { jobId = basename(jobRoot), reference, runId = null } = {}) {
  // Only real job/preview folders are traced, never a temporary directory.
  if (!resolve(jobRoot).startsWith(TRACE_ROOT)) return () => Promise.resolve();
  const deliver = async events => {
    let delivered = false;
    try {
      const { sendTrace } = await import('../../../scripts/hachimi-trace-client.mjs');
      delivered = (await sendTrace({ source:'automatic', id:jobId, ticketReference:reference || undefined, phase:events.at(-1)?.phase, ...(runId ? { metadata:{ runId } } : {}), events },
        { timeoutMs:3000, fallback:false })).ok;
    } catch { /* tracing must not affect the review */ }
    try {
      await mkdir(jobRoot, { recursive:true, mode:0o700 });
      await appendFile(resolve(jobRoot, TRACE_LOG), events.map(event => JSON.stringify({ ...event, runId, delivered }) + '\n').join(''), { mode:0o600 });
    } catch { /* same: the local log is best-effort too */ }
  };
  return (kind, text, extra = {}) => {
    const at = new Date().toISOString();
    const events = (Array.isArray(kind) ? kind : [{ kind, text, ...extra }])
      .map(event => ({ kind:event.kind, text:event.text, phase:event.phase, actor:event.actor || 'controller', payload:event.payload, sources:event.sources, at:event.at || at }));
    traceQueue = traceQueue.then(() => deliver(events));
    return traceQueue;
  };
}
export const traceEmitter = (jobDir, reference) => jobTraceEmitter(dirname(jobDir), { reference, runId:basename(jobDir) });

// A short, printable failure reason: no line breaks, no long opaque strings (tokens, signed URLs).
export function safeReason(value, max = 300) {
  return String(value ?? '').replace(/\s+/g, ' ').replace(/[A-Za-z0-9_\-+/=.]{40,}/g, '[…]').trim().slice(0, max);
}
const ELITE_BRIDGE = 'http://127.0.0.1:39541/codex-ts-elite/review';
const BRIDGE_HINTS = {
  AI_LOGIN_REQUIRED: 'bên nhận job chưa kết nối TS Elite 2 hoặc token của nó bị từ chối',
};

export async function createIO(jobDir, progress, { reference } = {}) {
  await mkdir(resolve(jobDir, 'screenshots'), { recursive:true, mode:0o700 });
  const trace = traceEmitter(jobDir, reference);
  return {
    progress:async phase => { await progress?.(phase); trace('phase', `Bắt đầu pha ${phase}`, { phase }); },
    trace,
    evidence:readEvidence,
    elite:async (target, { signal }) => {
      const started = Date.now();
      trace('tool', `Gửi "Check ticket ${target.reference}" qua bridge nội bộ, chờ bên nhận job trả lời`, { phase:'elite', payload:{ endpoint:ELITE_BRIDGE, summaryOnly:true } });
      const response = await fetch(ELITE_BRIDGE, {
        method:'POST', headers:{ 'Content-Type':'application/json', 'X-Codex-TS-Elite-Bridge':'1' },
        body:JSON.stringify({ ticketId:target.reference, message:`Check ticket ${target.url}`, summaryOnly:true }), signal,
      });
      const body = await response.json().catch(() => ({}));
      const detail = { httpStatus:response.status ?? null, consumer:safeReason(body.consumer, 40) || null, bridgeJobId:safeReason(body.jobId, 60) || null, elapsedMs:Date.now() - started };
      if (!response.ok || !body.answer) {
        // Keep the reason the bridge gave: the controller stores it as lastError and the trace shows it.
        const code = safeReason(body.error) || (response.ok ? 'bridge không trả về câu trả lời' : '');
        throw Object.assign(new Error(`TS Elite 2 review failed${code ? `: ${code}` : ''} (HTTP ${response.status}).`),
          { detail:{ ...detail, code:code || null, hint:BRIDGE_HINTS[code] || null } });
      }
      trace('note', `Bridge đã trả lời${detail.consumer ? ` • bên xử lý: ${detail.consumer}` : ''}`, { phase:'elite', payload:detail });
      return body.answer;
    },
    worker:(phase,data,context) => runWorker(ROOT,jobDir,phase,data,{ ...context, trace }),
    // Hancal analysis: the 3-role pipeline of skills/check-ticket-v2 run in-process, artifacts under <job>/v2,
    // trace through this job's emitter (source automatic, same id) so Checking/History show one run.
    // followUp (optional, "@bot" command): instruction + window passed to the pipeline as data for a follow-up check.
    selectEngine: () => snapshotMcpEngine(),
    hancal:async (target, { signal, engineSnapshot, commentFormatVersion }, followUp = null) => {
      const { runPipeline, loadSettings } = await import('../../check-ticket-v2/scripts/pipeline.mjs');
      trace('tool', `Chạy luồng Hancal (check-ticket-v2) cho ${target.reference}${followUp ? ' (check tiếp theo lệnh @bot)' : ''}: điều tra có tool trên apps_doc/ + knowledge-base/ → kiểm bằng code → viết`, { phase:'hancal', payload:{ mode:'automatic', followUp:Boolean(followUp) } });
      return runPipeline(target.url, { settings:await loadSettings(), jobDir:resolve(jobDir, 'v2'), signal, mode:'automatic', preview:true, log:() => {}, followUp, engineSnapshot, commentFormatVersion,
        trace:(kind, text, extra = {}) => trace(kind, text, { actor:extra.actor || 'hancal', ...extra }) });
    },
    browser:openBrowser,
    demoAvailable:async () => Boolean((await uploadConfig()).url),
    upload:(file,context) => uploadDemo(file,resolve(jobDir,'screenshots'),context),
    save:(name,value) => writeFile(resolve(jobDir,name),typeof value === 'string' ? value : JSON.stringify(value,null,2),{mode:0o600}),
  };
}
