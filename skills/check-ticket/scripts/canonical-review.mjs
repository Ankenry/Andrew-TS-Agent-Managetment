import { readFile, realpath } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { renderHanReport, parseHanReport, HANDLING_COMMENT_VERSION } from './han-report.mjs';
// Presentation only: never regenerate a comment, read another run, or repair controller state.
import { createHash } from 'node:crypto';

const SAFE_ID = /^[A-Za-z0-9_-]{1,100}$/;
const labels = { queued: 'Đang chờ', running: 'Đang check', ready: 'Comment đã chuẩn bị, chưa xác nhận gửi', posting: 'Đang gửi comment', done: 'Chưa xác nhận comment', uncertain: 'Chưa xác nhận comment', needs_attention: 'Cần kiểm tra — chưa xác nhận comment', cancelled: 'Đã hủy' };

export function canonicalReview(job, { jobs = [] } = {}) {
  const ticketId = job.ticketId || job.id;
  const runId = job.runId || '';
  const saved = typeof job.comment === 'string' && job.comment.trim() ? job.comment : null;
  const conflicts = [];
  if (!SAFE_ID.test(job.id || '') || !SAFE_ID.test(ticketId || '') || (runId && !SAFE_ID.test(runId))) conflicts.push('Định danh ticket/job/run không hợp lệ.');
  // artifactDir is evidence of the controller binding only; never follow it as a file path.
  const bound = Boolean(runId && typeof job.artifactDir === 'string'
    && job.artifactDir.endsWith(`/runtime/check-ticket/jobs/${job.id}/${runId}`));
  if (job.artifactDir && !bound) conflicts.push('Artifact không thuộc job/run đang chọn.');
  if (job.report?.category && job.category && job.report.category !== job.category) conflicts.push('Phân loại report không khớp job.');
  if (job.commentId && jobs.some(other => other.id !== job.id && other.commentId === job.commentId)) conflicts.push('Receipt comment đang gắn với nhiều job.');
  if (job.commentFormatVersion === HANDLING_COMMENT_VERSION) {
    const binding = job.presentationBinding;
    if (!binding || binding.jobId !== job.id || binding.ticketId !== ticketId || binding.runId !== runId
      || binding.commentSha256 !== (saved ? createHash('sha256').update(saved).digest('hex') : null)) conflicts.push('Binding/hash comment xử lý không khớp job/run.');
  }
  const provenance = conflicts.length ? 'conflict' : runId && bound ? 'bound' : 'legacy';
  const comment = provenance === 'conflict' ? null : saved;
  const hasReceipt = SAFE_ID.test(job.commentId || '') && Number.isFinite(Date.parse(job.finishedAt || ''))
    && Date.parse(job.finishedAt) >= Date.parse(job.createdAt || '');
  // Existing controller reconciliation stores the exact comment + commentId on this job/run.
  // This is a saved receipt, not a fresh Helpdesk readback. No body alone proves delivery.
  const receipt = job.deliveryReceipt;
  const handlingReceipt = job.commentFormatVersion !== HANDLING_COMMENT_VERSION || Boolean(receipt
    && receipt.jobId === job.id && receipt.ticketId === ticketId && receipt.runId === runId
    && receipt.commentId === job.commentId && receipt.commentSha256 === job.presentationBinding?.commentSha256
    && Date.parse(receipt.commentAt || '') >= Date.parse(job.presentationBinding?.preparedAt || '')
    && Date.parse(receipt.commentAt || '') <= Date.parse(job.finishedAt || ''));
  const confirmed = Boolean(handlingReceipt && comment && provenance === 'bound' && job.status === 'done' && hasReceipt);
  const notice = conflicts.length ? `Chưa xác minh được comment của lượt này: ${conflicts.join(' ')}`
    : !comment ? 'Chưa có bản comment lưu của lượt này; chưa thể đối chiếu kết quả với ticket.'
    : provenance === 'legacy' ? 'Bản comment đã lưu; thiếu dữ liệu ràng buộc run/receipt để xác minh đầy đủ.' : '';
  return { comment, commentFormatVersion: job.commentFormatVersion || null,
    canonical: { jobId: job.id, ticketId, runId, commentId: job.commentId || null, provenance,
      sha256: comment ? createHash('sha256').update(comment).digest('hex') : null, notice },
    delivery: { confirmed, source: confirmed ? 'saved-controller-receipt' : 'unconfirmed', commentId: confirmed ? job.commentId : null, runId },
    statusLabel: confirmed ? (job.commentFormatVersion === HANDLING_COMMENT_VERSION ? 'Đã xác nhận comment xử lý (receipt đã lưu); full report lưu riêng' : 'Đã xác nhận comment định dạng cũ (receipt đã lưu); full report lưu riêng') : labels[job.status] || 'Chưa xác nhận comment' };
}


const hash = text => createHash('sha256').update(text).digest('hex');
// Full result and posted comment have independent hashes. A receipt never proves full-report delivery.
export function reviewPresentation(job, { jobs = [], sources = [], sourceError = '' } = {}) {
  const canonical = canonicalReview(job, { jobs });
  const result = { jobId:job.id, ticketId:job.ticketId || job.id, runId:job.runId || '',
    kind:'missing', source:null, sha256:null, provenance:canonical.canonical.provenance, notice:'' };
  const candidates = [...sources]; let error = sourceError;
  if (job.report) {
    try { candidates.unshift({source:'job.report', text:renderHanReport(job.report)}); }
    catch { error ||= 'Report lưu trong job không đúng schema; chưa xác minh full report.'; }
  }
  if (canonical.canonical.provenance === 'conflict') error ||= canonical.canonical.notice;
  if (candidates.length && canonical.canonical.provenance !== 'bound') error ||= 'Full report thiếu binding ticket/job/run; chưa xác minh.';
  if (candidates.some(c => typeof c.text !== 'string' || !c.text.trim())) error ||= 'Full report rỗng.';
  if (new Set(candidates.map(c => hash(c.text))).size > 1) error ||= 'Các nguồn full report cùng run không khớp; không tự chọn/ghép nguồn.';
  const chosen = candidates[0];
  if (chosen && job.commentFormatVersion === HANDLING_COMMENT_VERSION
    && job.presentationBinding?.fullReportSha256 !== hash(chosen.text)) error ||= 'Hash full report không khớp binding cùng run.';
  let fullReport = null;
  if (error) { result.kind = 'conflict'; result.notice = error; }
  else if (chosen) { fullReport = chosen.text; Object.assign(result, {kind:'full', source:chosen.source, sha256:hash(fullReport)}); }
  else { result.kind = canonical.comment === null ? 'missing' : 'comment-only'; result.notice = canonical.comment === null
    ? 'Chưa có full report hoặc comment đã xác minh của lượt này.' : 'Thiếu full report; chỉ có comment đã lưu, không phải báo cáo đầy đủ.'; }
  return { ...canonical, fullReport, result };
}

// Only read the exact job/run directory under this workspace; never follow a state-supplied arbitrary path.
export async function readReviewPresentation(job, { root, jobs = [] } = {}) {
  const base = reviewPresentation(job, { jobs });
  if (!root || base.canonical.provenance !== 'bound') return base;
  const dir = resolve(root, 'runtime/check-ticket/jobs', job.id, job.runId);
  if (resolve(job.artifactDir) !== dir) return reviewPresentation(job, {jobs, sourceError:'Artifact không thuộc workspace/job/run đang đọc.'});
  const sources = []; let sourceError = '';
  for (const name of ['report.json', 'report.md']) {
    const path = resolve(dir, name);
    try {
      const actual = await realpath(path);
      if (actual !== path || !actual.startsWith(dir + sep)) throw new Error('Artifact symlink/path mismatch');
      const raw = await readFile(actual, 'utf8');
      const report = name.endsWith('.json') ? JSON.parse(raw) : parseHanReport(raw, job.category);
      if (report.category !== job.category) throw new Error('Artifact category mismatch');
      const rendered = renderHanReport(report);
      sources.push({source:name, text:name.endsWith('.md') ? raw : rendered});
    } catch (error) { if (error.code !== 'ENOENT') sourceError = `Không xác minh được ${name} của đúng run (${error.code || 'schema/path mismatch'}).`; }
  }
  return reviewPresentation(job, {jobs, sources, sourceError});
}
