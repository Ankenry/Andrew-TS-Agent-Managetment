// Read-only Han auto API. No AI, posting, state repair or retrospective conversion.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { renderHanReport } from './han-report.mjs';
import { canonicalReview } from './canonical-review.mjs';

const SAFE_ID = /^[A-Za-z0-9_-]{1,100}$/;
const STATUSES = new Set(['queued', 'running', 'ready', 'posting', 'done', 'uncertain', 'needs_attention', 'cancelled']);
const reviewJob = job => job && STATUSES.has(job.status) && SAFE_ID.test(job.id || '')
  && (!job.mode || job.mode === 'review') && job.command?.kind !== 'refused';
const metadata = (job, jobs) => ({ id: job.id, runId: job.runId || '', ticketId: job.ticketId || job.id, ticket: job.reference || '', subject: job.subject || '',
  category: job.category || '', status: job.status, statusLabel: canonicalReview(job, { jobs }).statusLabel, createdAt: job.createdAt || '', finishedAt: job.finishedAt || '',
  hasReport: Boolean(job.report), legacy: !job.report && Boolean(job.comment), commentId: job.commentId || null });

export async function readHanReports({ root, statePath = resolve(root, 'runtime/check-ticket/state.json'), id = null, runId = null, now = Date.now(), days = 10 } = {}) {
  if (id !== null && !SAFE_ID.test(id)) throw new Error('Invalid report ID.');
  let state;
  try { state = JSON.parse(await readFile(statePath, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') state = { jobs: {} }; else throw error; }
  const jobs = Object.values(state.jobs || {}).filter(reviewJob);
  if (id !== null) {
    const job = jobs.find(job => job.id === id);
    if (!job) return null;
    if (runId !== null && runId !== (job.runId || '')) throw new Error('Lượt check đã thay đổi; tải lại danh sách để xem đúng report.');
    const canonical = canonicalReview(job, { jobs: Object.values(state.jobs || {}) });
    // Keep the source report separately. Its shape/formatter must not replace or hide the saved comment.
    let fullReport = null;
    try { if (job.report) fullReport = renderHanReport(job.report); } catch { /* Source remains available as stored. */ }
    return { ...metadata(job, jobs), ...canonical, report: job.report || null, fullReport };
  }
  const cutoff = now - days * 86400000;
  const items = jobs.filter(job => Date.parse(job.finishedAt || job.createdAt || '') >= cutoff)
    .sort((a, b) => String(b.finishedAt || b.createdAt).localeCompare(String(a.finishedAt || a.createdAt)))
    .slice(0, 100).map(job => metadata(job, Object.values(state.jobs || {})));
  return { reports: items };
}

// Event-driven automatic reviews only. Keep the legacy reports API/History contract unchanged.
export const AUTO_TRIGGERS = new Set(['ticket_created', 'ticket_assigned', 'assigned_roster']);
const isAutoReview = job => reviewJob(job) && AUTO_TRIGGERS.has(job.trigger)
  && SAFE_ID.test(job.ticketId || job.id) && (!job.runId || SAFE_ID.test(job.runId));
export async function allControllerJobs(root) {
  let state;
  try { state = JSON.parse(await readFile(resolve(root, 'runtime/check-ticket/state.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  return Object.values(state.jobs || {});
}
export async function autoReviewJobs(root) { return (await allControllerJobs(root)).filter(isAutoReview); }
export async function autoReviewBinding(root, { ticketId, jobId, runId }) {
  if (!SAFE_ID.test(ticketId || '') || !SAFE_ID.test(jobId || '') || typeof runId !== 'string' || (runId && !SAFE_ID.test(runId)))
    throw Object.assign(new Error('Định danh ticket/lượt check không hợp lệ.'), { status: 400 });
  const all = await allControllerJobs(root), jobs = all.filter(isAutoReview);
  const job = jobs.find(j => j.id === jobId && (j.ticketId || j.id) === ticketId);
  if (!job || (job.runId || '') !== runId) throw Object.assign(new Error('Lượt check đã thay đổi hoặc không thuộc auto. Tải lại danh sách.'), { status: 409 });
  const review = canonicalReview(job, { jobs: all });
  return { job, binding: { ticketId, jobId, runId, commentId: job.commentId || null }, review };
}
export async function readAutoTickets({ root, q = '', scope = 'completed', cursor = '', limit = 50 } = {}) {
  const { createHash } = await import('node:crypto');
  q = String(q).trim().slice(0, 200).toLocaleLowerCase('vi');
  scope = scope === 'all' ? 'all' : 'completed';
  const all = await allControllerJobs(root), jobs = all.filter(isAutoReview), grouped = new Map();
  for (const job of jobs) {
    const id = job.ticketId || job.id;
    if (!grouped.has(id)) grouped.set(id, []);
    grouped.get(id).push(job);
  }
  const time = j => String(j.finishedAt || j.createdAt || '');
  const rows = [...grouped].map(([ticketId, runs]) => {
    runs.sort((a,b) => time(b).localeCompare(time(a)) || b.id.localeCompare(a.id));
    const job = runs.find(j => j.status === 'done') || runs[0];
    const selected = metadata(job, all);
    return { ...selected, ticketId, jobId: job.id, trigger: job.trigger,
      appName: typeof job.appName === 'string' ? job.appName : '',
      hasCompleted: runs.some(j => j.status === 'done'),
      incompleteCount: runs.filter(j => j.status !== 'done').length,
      runs: runs.map(j => ({ ...metadata(j, all), jobId: j.id, trigger: j.trigger })),
      runHistoryNotice: 'Chỉ các lượt còn metadata trong controller; không suy diễn lượt cũ đã bị thay thế.' };
  }).filter(row => (scope === 'all' || row.hasCompleted) && (!q || `${row.ticket} ${row.subject}`.toLocaleLowerCase('vi').includes(q)))
    .sort((a,b) => String(b.finishedAt || b.createdAt).localeCompare(String(a.finishedAt || a.createdAt)) || a.ticketId.localeCompare(b.ticketId));
  const revision = createHash('sha256').update(JSON.stringify([q,scope,rows])).digest('hex');
  let offset = 0;
  if (cursor) {
    let parsed; try { parsed = JSON.parse(Buffer.from(String(cursor), 'base64url').toString()); } catch {}
    if (!parsed || parsed.revision !== revision || !Number.isSafeInteger(parsed.offset) || parsed.offset < 0 || parsed.offset > rows.length)
      throw Object.assign(new Error('Danh sách đã đổi. Tải lại từ đầu.'), { status: 409 });
    offset = parsed.offset;
  }
  limit = Math.max(1, Math.min(100, Number(limit) || 50));
  const tickets = rows.slice(offset, offset + limit), next = offset + tickets.length;
  return { tickets, totalTickets: rows.length, scope, revision,
    nextCursor: next < rows.length ? Buffer.from(JSON.stringify({revision,offset:next})).toString('base64url') : null };
}
