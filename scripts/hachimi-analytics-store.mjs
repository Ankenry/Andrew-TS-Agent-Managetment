#!/usr/bin/env node
import { canonicalReview } from '../skills/check-ticket/scripts/canonical-review.mjs';
// AI check analytics: which AI-posted review comments Đại tá marked correct (👍) or incorrect (😢) on Helpdesk,
// the accuracy figures for the Analytics section (extension + TS Management web), and the feedback that trains
// later checks. Reads Helpdesk only (comment actions + their reactions); never posts, reacts or edits anything.
import { isHanCompactComment, HANDLING_COMMENT_VERSION } from '../skills/check-ticket/scripts/han-report.mjs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ROOT, query, loadEnv, getPool } from './hachimi-db.mjs';
import { helpdeskFetch } from './helpdesk-http.mjs';
import { runHelpdeskFlow } from './helpdesk-usage.mjs';
import { readReactionSettings, reactionSyncEnabled } from './reaction-analytics-settings.mjs';
import { loadEffectiveAssessmentRows, assessmentTotals } from './han-auto-assessment-projection.mjs';
import { sendTelegramText } from './telegram-send.mjs';

const HELPDESK_API = 'https://helpdesk.avada.net/api/external';
const STATE_FILE = resolve(ROOT, 'runtime/check-ticket/state.json');
const LESSONS_FILE = resolve(ROOT, 'knowledge-base/feedback/ai-check-lessons.md');
// The Helpdesk account whose reactions count (Andrew = Đại tá). Override with AI_CHECK_REVIEWER_IDS (comma separated).
export const ANDREW_ID = 'HEYWuzF9rTdG59pE8TNtBKL6W1x1';
export const REVIEW_PREFIX = 'Sau khi TS check thì thấy như sau:';
const LIKE = new Set(['👍', '❤️', '❤', '👏', '✅', '💯']);
const CRY = new Set(['😢', '😭', '😿', '🥲', '😥', '👎', '❌']);
const SYNC_WINDOW_DAYS = 90;
// Helpdesk rate-limits bursts (HTTP 429): one request at a time, spaced out, with a short backoff on 429.
const SYNC_CONCURRENCY = 1;
const SYNC_GAP_MS = 250;
const RETRY_DELAYS_MS = [2000, 5000, 10000];
const MAX_DESCRIPTION = 6000;
const TICKET_RE = /\b([A-Z]{2,10}-\d{6}-[A-Za-z0-9]{4,12})\b/;

export function reviewerIds() {
  const raw = process.env.AI_CHECK_REVIEWER_IDS || loadEnv().AI_CHECK_REVIEWER_IDS || ANDREW_ID;
  return raw.split(',').map(value => value.trim()).filter(Boolean);
}

// Skin tones and variation selectors do not change the meaning of a reaction.
export const normalizeEmoji = value => String(value || '').replace(/[\u{1F3FB}-\u{1F3FF}️‍]/gu, '').trim();

// reactions: { "👍": [uid, ...] } as returned by GET /tickets/:id/actions. A cry outranks a like when both are present.
export function verdictFromReactions(reactions, reviewers = reviewerIds()) {
  const judges = new Set(reviewers);
  let like = ''; let cry = '';
  for (const [emoji, users] of Object.entries(reactions && typeof reactions === 'object' ? reactions : {})) {
    if (!(Array.isArray(users) && users.some(uid => judges.has(String(uid))))) continue;
    const plain = normalizeEmoji(emoji);
    if (CRY.has(plain)) cry ||= emoji;
    else if (LIKE.has(plain)) like ||= emoji;
  }
  if (cry) return { verdict: 'incorrect', emoji: cry };
  if (like) return { verdict: 'correct', emoji: like };
  return { verdict: 'pending', emoji: '' };
}

// A comment Đại tá typed on the Helpdesk web carries author.authUid; comments posted through the API key do not.
export function isAiReviewComment(action, authorId = ANDREW_ID) {
  if (action?.type && action.type !== 'commentTicket') return false;
  if (action?.author?.memberId !== authorId || action?.author?.authUid) return false;
  const text = String(action?.metadata?.content || action?.content || '').trimStart();
  return text.startsWith(REVIEW_PREFIX) || isHanCompactComment(text);
}

export function parseTicketReference(input) {
  const match = TICKET_RE.exec(String(input || ''));
  return match ? match[1] : '';
}

export function categoryFromComment(content) {
  const match = /Đây là loại ticket gì\s*:\s*([^\n]+)/i.exec(String(content || ''));
  return match ? match[1].trim().slice(0, 40) : '';
}

export const reviewExcerpt = (content, version) => (version === HANDLING_COMMENT_VERSION ? String(content || '') : String(content || '').split('\n').slice(2).join('\n')).trim().slice(0, 400);

// --- Helpdesk --------------------------------------------------------------
const sleep = ms => new Promise(done => setTimeout(done, ms));
async function helpdesk(path) {
  const token = process.env.API_AVADA_TICKET || loadEnv().API_AVADA_TICKET;
  if (!token) throw new Error('Missing Helpdesk credential.');
  for (let attempt = 0; ; attempt += 1) {
    const response = await helpdeskFetch(HELPDESK_API + path, { method: 'GET', headers: { 'X-API-Key': token } });
    const payload = await response.json().catch(() => null);
    if (response.ok && payload?.success) return payload.data;
    if (response.status === 429 && attempt < RETRY_DELAYS_MS.length) { await sleep(RETRY_DELAYS_MS[attempt]); continue; }
    throw new Error(`Helpdesk GET failed (HTTP ${response.status}).`);
  }
}

export function analyticsControllerJob(job, jobs = []) {
  if (!job?.id || !job.commentId || (job.mode && job.mode !== 'review') || job.command?.kind === 'refused') return null;
  const handling = job.commentFormatVersion === HANDLING_COMMENT_VERSION;
  if (!handling && !(job.status === 'done' && (isHanCompactComment(job.comment) || String(job.comment || '').trimStart().startsWith(REVIEW_PREFIX)))) return null;
  const canonical = handling ? canonicalReview(job, {jobs}) : null;
  return { ticketId:String(job.ticketId || job.id), reference:String(job.reference || ''), subject:String(job.subject || ''),
    category:String(job.category || ''), commentId:String(job.commentId), finishedAt:job.finishedAt || job.createdAt || null,
    controller:true, commentFormatVersion:job.commentFormatVersion || null,
    ...(handling ? {comment:canonical.comment, canonical:canonical.canonical, delivery:canonical.delivery} : {}) };
}

export function matchesHandlingReview(action, job, ticketId, authorId = ANDREW_ID) {
  return Boolean(job?.commentFormatVersion === HANDLING_COMMENT_VERSION && job.delivery?.confirmed
    && job.canonical?.provenance === 'bound' && job.canonical.runId && job.delivery.runId === job.canonical.runId
    && job.ticketId === ticketId && job.canonical.ticketId === ticketId
    && job.commentId === action?.id && job.delivery.commentId === action.id && job.canonical.commentId === action.id
    && (!action.type || action.type === 'commentTicket') && action.author?.memberId === authorId && !action.author?.authUid
    && String(action.metadata?.content || action.content || '') === job.comment);
}

async function controllerJobs() {
  let state; try { state = JSON.parse(await readFile(STATE_FILE, 'utf8')); } catch { return []; }
  const jobs = Object.values(state?.jobs || {});
  return jobs.map(job => analyticsControllerJob(job, jobs)).filter(Boolean);
}

async function upsertReview(row) {
  const { rows: [saved] } = await query(`
    INSERT INTO ai_check_reviews (comment_id, ticket_id, ticket_reference, subject, category, source, comment_excerpt, comment_at, verdict, reaction_emoji, reactions, judged_at, synced_at, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, CASE WHEN $9 = 'pending' THEN NULL ELSE now() END, now(), now())
    ON CONFLICT (comment_id) DO UPDATE SET
      ticket_reference = CASE WHEN EXCLUDED.ticket_reference <> '' THEN EXCLUDED.ticket_reference ELSE ai_check_reviews.ticket_reference END,
      subject = CASE WHEN EXCLUDED.subject <> '' THEN EXCLUDED.subject ELSE ai_check_reviews.subject END,
      category = CASE WHEN EXCLUDED.category <> '' THEN EXCLUDED.category ELSE ai_check_reviews.category END,
      comment_excerpt = CASE WHEN EXCLUDED.comment_excerpt <> '' THEN EXCLUDED.comment_excerpt ELSE ai_check_reviews.comment_excerpt END,
      comment_at = COALESCE(EXCLUDED.comment_at, ai_check_reviews.comment_at),
      verdict = EXCLUDED.verdict, reaction_emoji = EXCLUDED.reaction_emoji, reactions = EXCLUDED.reactions,
      judged_at = CASE WHEN EXCLUDED.verdict = 'pending' THEN NULL WHEN ai_check_reviews.verdict = EXCLUDED.verdict THEN ai_check_reviews.judged_at ELSE now() END,
      synced_at = now(), updated_at = now()
    RETURNING id::int AS id, verdict`, [row.commentId, row.ticketId, row.reference, row.subject, row.category, row.source, row.excerpt, row.commentAt, row.verdict, row.emoji, JSON.stringify(row.reactions || {})]);
  return saved;
}

// Tickets assigned to the reviewer (Andrew) and updated in the last days. A review comment an agent posted by hand
// (Hancal, Handfy… outside the automatic controller) lives on a ticket that neither the controller state nor the table
// knows yet; this listing is how such a ticket gets its first read. `seen` holds tickets already read at that same
// updatedAt without any review comment: a new comment bumps updatedAt, so an unchanged ticket is skipped.
export const DISCOVERY_DAYS = 7;
const DISCOVERY_MAX_PAGES = 5;
const discoverySeen = new Map();
export function pickRecentAssigned(tickets, { since, reviewers = reviewerIds(), seen = new Map() } = {}) {
  const judges = new Set(reviewers);
  return (Array.isArray(tickets) ? tickets : [])
    .filter(ticket => ticket?.id && !ticket.deletedAt && (ticket.memberIds || []).some(id => judges.has(String(id)))
      && Date.parse(ticket.updatedAt || ticket.createdAt || '') > since
      && seen.get(String(ticket.id)) !== String(ticket.updatedAt || ''))
    .map(ticket => ({ ticketId: String(ticket.id), updatedAt: String(ticket.updatedAt || ''), reference: String(ticket.ticketId || ''), subject: String(ticket.subject || '') }));
}

async function recentAssignedTickets(since, reviewers, seen) {
  const found = []; let cursor = '';
  for (let page = 0; page < DISCOVERY_MAX_PAGES; page += 1) {
    const data = await helpdesk('/tickets?' + new URLSearchParams({ limit: '100', ...(cursor ? { cursor } : {}) }));
    const tickets = Array.isArray(data?.tickets) ? data.tickets : [];
    found.push(...pickRecentAssigned(tickets, { since, reviewers, seen }));
    // The listing is roughly newest-first: a page without any recent ticket ends the walk.
    if (!data?.nextCursor || !tickets.some(ticket => Date.parse(ticket?.updatedAt || ticket?.createdAt || '') > since)) break;
    cursor = data.nextCursor;
    await sleep(SYNC_GAP_MS);
  }
  return found;
}

// Refresh every review comment of a ticket from its Helpdesk action log. Known comments come from the automatic
// controller's state; other AI review comments on the same ticket are picked up by their shape. `hint` carries the
// reference/subject already read from a ticket listing so a discovered ticket costs one request, not two.
async function syncTicket(ticketId, known, reviewers, hint = null) {
  const data = await helpdesk(`/tickets/${encodeURIComponent(ticketId)}/actions?type=commentTicket&limit=100`);
  const actions = Array.isArray(data?.actions) ? data.actions : [];
  let count = 0; let info = hint?.reference ? { reference: hint.reference, subject: hint.subject || '' } : null;
  for (const action of actions) {
    const job = known.find(item => item.commentId === action.id);
    if (job?.commentFormatVersion === HANDLING_COMMENT_VERSION) {
      if (!matchesHandlingReview(action, job, ticketId, reviewers[0])) continue;
    } else if (!job?.controller && !isAiReviewComment(action, reviewers[0])) continue;
    const content = String(action.metadata?.content || action.content || '');
    // A comment the controller did not post: take the reference and subject from the ticket itself (one read per ticket).
    if (!job?.reference && !parseTicketReference(content) && !info) { const ticket = await helpdesk(`/tickets/${encodeURIComponent(ticketId)}`).catch(() => null); info = { reference: String((ticket?.ticket || ticket)?.ticketId || ''), subject: String((ticket?.ticket || ticket)?.subject || '') }; }
    const { verdict, emoji } = verdictFromReactions(action.reactions, reviewers);
    await upsertReview({
      commentId: String(action.id), ticketId: String(ticketId), reference: job?.reference || parseTicketReference(content) || info?.reference || '', subject: job?.subject || info?.subject || '',
      category: job?.category || categoryFromComment(content), source: job ? 'automatic' : 'detected', excerpt: reviewExcerpt(content, job?.commentFormatVersion),
      commentAt: action.createdAt || job?.finishedAt || null, verdict, emoji, reactions: action.reactions || {},
    });
    count += 1;
  }
  // The posted comment vanished from Helpdesk (deleted): drop the verdict so the figures stop counting it. A full page
  // (100 actions) may simply not include it, so only a complete action log can prove the comment is gone.
  if (actions.length < 100) for (const job of known) if (!actions.some(action => action.id === job.commentId)) await query('DELETE FROM ai_check_reviews WHERE comment_id = $1', [job.commentId]);
  return count;
}

let syncState = { running: false, lastRun: null, lastError: '', tickets: 0, discovered: 0, comments: 0 };
// A "recent" sync (the Analytics page asks for one while it is open) is cheap but must not hammer Helpdesk.
let lastRecentRun = 0;
const RECENT_MIN_INTERVAL_MS = 45_000;
export const syncStatus = () => ({ ...syncState });

// Pull reactions for every review comment of the last 90 days (controller state + rows already stored + tickets assigned
// to the reviewer and updated in the last DISCOVERY_DAYS, where review comments posted by hand are found). recentDays limits the pass to tickets whose comment is that recent (page-driven refresh), rate-limited to one per 45 s.
export async function syncReactions({ ticketIds = [], force = false, recentDays = 0 } = {}) {
  return runHelpdeskFlow(ticketIds.length ? 'analytics-selected' : recentDays > 0 ? 'analytics-recent' : 'analytics-full', async () => {
  const reactionSettings = await readReactionSettings();
  if (!reactionSettings.enabled) return { ...syncStatus(), enabled: false, skipped: true };
  if (syncState.running) return syncStatus();
  if (recentDays > 0 && !force && Date.now() - lastRecentRun < RECENT_MIN_INTERVAL_MS) return { ...syncStatus(), skipped: true };
  if (recentDays > 0) lastRecentRun = Date.now();
  syncState = { ...syncState, running: true, lastError: '' };
  try {
    const reviewers = reviewerIds();
    const jobs = await controllerJobs();
    const { rows: stored } = await query(`
      SELECT ticket_id, ticket_reference, subject, category, comment_id, comment_at FROM ai_check_reviews
      WHERE comment_at IS NULL OR comment_at > now() - make_interval(days => $1)`, [SYNC_WINDOW_DAYS]);
    const since = Date.now() - SYNC_WINDOW_DAYS * 86_400_000;
    const byTicket = new Map();
    const add = item => { if (!byTicket.has(item.ticketId)) byTicket.set(item.ticketId, []); const list = byTicket.get(item.ticketId); if (!list.some(known => known.commentId === item.commentId)) list.push(item); };
    for (const job of jobs) if (force || !job.finishedAt || Date.parse(job.finishedAt) > since) add(job);
    for (const row of stored) add({ ticketId: row.ticket_id, reference: row.ticket_reference, subject: row.subject, category: row.category, commentId: row.comment_id, finishedAt: row.comment_at });
    // An explicitly named ticket is read even when the controller never reviewed it (its AI comments are found by shape).
    for (const id of ticketIds) if (!byTicket.has(id)) byTicket.set(id, []);
    // Tickets assigned to the reviewer and updated lately: review comments posted by hand are found here (2026-10-11).
    const discovered = new Map(); let discoveryError = '';
    if (!ticketIds.length) {
      const seen = force ? new Map() : discoverySeen;
      const discoverySince = Date.now() - Math.min(recentDays > 0 ? recentDays : DISCOVERY_DAYS, DISCOVERY_DAYS) * 86_400_000;
      try {
        for (const ticket of await recentAssignedTickets(discoverySince, reviewers, seen)) {
          if (byTicket.has(ticket.ticketId)) continue;
          byTicket.set(ticket.ticketId, []); discovered.set(ticket.ticketId, ticket);
        }
      } catch (error) { discoveryError = `danh sách ticket: ${error.message}`; }
    }
    const recentSince = recentDays > 0 ? Date.now() - Math.min(recentDays, SYNC_WINDOW_DAYS) * 86_400_000 : 0;
    const targets = (ticketIds.length ? [...byTicket].filter(([id]) => ticketIds.includes(id)) : [...byTicket])
      .filter(([, list]) => !recentSince || !list.length || list.some(item => !item.finishedAt || Date.parse(item.finishedAt) > recentSince));
    let comments = 0, processed = 0, stopped = false; const errors = discoveryError ? [discoveryError] : [];
    const queue = targets.slice();
    await Promise.all(Array.from({ length: SYNC_CONCURRENCY }, async () => {
      while (queue.length) {
        if (!reactionSyncEnabled()) { stopped = true; break; }
        const [ticketId, known] = queue.shift();
        const hint = discovered.get(ticketId) || null;
        try {
          const found = await syncTicket(ticketId, known, reviewers, hint);
          processed += 1;
          comments += found;
          // A discovered ticket without any review comment is not read again until Helpdesk changes it.
          if (hint && !found) discoverySeen.set(ticketId, hint.updatedAt);
        } catch (error) { errors.push(`${known[0]?.reference || hint?.reference || ticketId}: ${error.message}`); }
        if (queue.length) await sleep(SYNC_GAP_MS);
      }
    }));
    syncState = { running: false, lastRun: new Date().toISOString(), lastError: errors.length ? `${errors.length} ticket(s) không đồng bộ được (${errors[0]})` : '', tickets: stopped ? processed : targets.length, discovered: discovered.size, comments };
  } catch (error) {
    syncState = { ...syncState, running: false, lastRun: new Date().toISOString(), lastError: error.message };
  }
  return syncStatus();
  });
}

// --- figures ---------------------------------------------------------------
const DAY = 86_400_000;
export function parseRange({ from, to, days } = {}) {
  let end = Number.isFinite(Date.parse(to)) ? new Date(Date.parse(to)) : new Date();
  let start = Number.isFinite(Date.parse(from)) ? new Date(Date.parse(from)) : null;
  if (!start) { const span = Math.min(Math.max(Number(days) || 7, 1), 366); start = new Date(end.getTime() - span * DAY); }
  if (start > end) [start, end] = [end, start];
  return { from: start.toISOString(), to: end.toISOString() };
}

const startOfDay = ms => { const date = new Date(ms); date.setHours(0, 0, 0, 0); return date; };
// Buckets of one day for ranges up to 31 days, otherwise ISO weeks (Monday start). Rate = correct / judged per bucket.
export function bucketize(rows, { from, to }) {
  const start = startOfDay(Date.parse(from)); const end = new Date(Date.parse(to));
  const days = Math.ceil((end - start) / DAY);
  const weekly = days > 31;
  if (weekly) start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  const buckets = [];
  for (let cursor = new Date(start); cursor <= end; ) {
    const next = new Date(cursor); if (weekly) next.setDate(next.getDate() + 7); else next.setDate(next.getDate() + 1);
    const label = weekly ? `${String(cursor.getDate()).padStart(2, '0')}/${String(cursor.getMonth() + 1).padStart(2, '0')}` : `${String(cursor.getDate()).padStart(2, '0')}/${String(cursor.getMonth() + 1).padStart(2, '0')}`;
    buckets.push({ label, start: cursor.toISOString(), end: next.toISOString(), correct: 0, incorrect: 0, pending: 0 });
    cursor = next;
  }
  for (const row of rows) {
    const at = Date.parse(row.comment_at || row.commentAt || '');
    const bucket = buckets.find(item => at >= Date.parse(item.start) && at < Date.parse(item.end));
    if (bucket) bucket[row.verdict] = (bucket[row.verdict] || 0) + 1;
  }
  return buckets.map(bucket => { const judged = bucket.correct + bucket.incorrect; return { ...bucket, judged, rate: judged ? Math.round((bucket.correct / judged) * 1000) / 10 : null }; });
}

const ticketView = row => ({
  id: row.id, commentId: row.comment_id, ticketId: row.ticket_id, ticket: row.ticket_reference, subject: row.subject, category: row.category, source: row.source,
  excerpt: row.comment_excerpt, commentAt: row.comment_at, verdict: row.verdict, emoji: row.reaction_emoji, judgedAt: row.judged_at,
  url: row.ticket_reference ? `https://helpdesk.avada.net/t/${encodeURIComponent(row.ticket_reference)}` : `https://helpdesk.avada.net/tickets/${encodeURIComponent(row.ticket_id)}`,
  feedbackCount: Number(row.feedback_count) || 0,
});

export async function listReviews({ verdict = '', from, to, limit = 200 } = {}) {
  const where = ['1=1']; const params = [];
  if (from) { params.push(from); where.push(`r.comment_at >= $${params.length}`); }
  if (to) { params.push(to); where.push(`r.comment_at <= $${params.length}`); }
  if (verdict) { params.push(verdict); where.push(`r.verdict = $${params.length}`); }
  params.push(Math.min(Math.max(Number(limit) || 200, 1), 1000));
  const { rows } = await query(`
    SELECT r.*, r.id::int AS id, (SELECT count(*) FROM ai_check_feedback f WHERE f.review_id = r.id)::int AS feedback_count
    FROM ai_check_reviews r WHERE ${where.join(' AND ')} ORDER BY r.comment_at DESC NULLS LAST, r.id DESC LIMIT $${params.length}`, params);
  return rows.map(ticketView);
}

export async function effectiveReviewPage({verdict='',from,to,limit=100,cursor=''}={}, {root=ROOT,pool=getPool()}={}) {
  const {rows,schemaReady}=await loadEffectiveAssessmentRows({root,pool});
  const filtered=rows.filter(r=>!r.excludedFromTotals&&(!verdict||r.verdict===verdict)&&(!from||Date.parse(r.commentAt)>=Date.parse(from))&&(!to||Date.parse(r.commentAt)<=Date.parse(to)));
  let start=0;if(cursor){const index=filtered.findIndex(r=>r.effectiveId===cursor);if(index<0)throw Object.assign(new Error('Danh sách đã đổi; tải lại.'),{status:409});start=index+1;}
  limit=Math.min(1000,Math.max(1,Number(limit)||100));const tickets=filtered.slice(start,start+limit);
  return {tickets,total:filtered.length,nextCursor:start+tickets.length<filtered.length?tickets.at(-1).effectiveId:null,assessmentSchemaReady:schemaReady};
}
export async function summary(rangeInput = {}, {root=ROOT,pool=getPool()}={}) {
  const range=parseRange(rangeInput),all=await loadEffectiveAssessmentRows({root,pool});
  const rows=all.rows.filter(r=>!r.excludedFromTotals&&Date.parse(r.commentAt)>=Date.parse(range.from)&&Date.parse(r.commentAt)<=Date.parse(range.to));
  const groups=Object.fromEntries(['correct','incorrect','pending'].map(v=>[v,rows.filter(r=>r.verdict===v)]));
  return {range,totals:assessmentTotals(rows),allTime:assessmentTotals(all.rows),buckets:bucketize(rows,range),
    ...Object.fromEntries(Object.entries(groups).map(([v,items])=>[v,items.slice(0,100)])),
    listPages:Object.fromEntries(Object.entries(groups).map(([v,items])=>[v,{total:items.length,nextCursor:items.length>100?items[99].effectiveId:null}])),
    excludedCount:all.rows.filter(r=>r.excludedFromTotals).length,excludedRows:all.rows.filter(r=>r.excludedFromTotals).slice(0,100),assessmentSchemaReady:all.schemaReady,sync:syncStatus(),reviewers:reviewerIds()};
}

// --- feedback / training ---------------------------------------------------
export async function listFeedback({ ticket = '', limit = 100 } = {}) {
  const params = []; const where = ['1=1'];
  if (ticket) { params.push(ticket); where.push(`f.ticket_reference = $${params.length}`); }
  params.push(Math.min(Math.max(Number(limit) || 100, 1), 500));
  const { rows } = await query(`SELECT f.id::int AS id, f.ticket_reference, f.ticket_id, f.review_id::int AS review_id, f.verdict, f.category, f.subject, f.description, f.status, f.created_at
    FROM ai_check_feedback f WHERE ${where.join(' AND ')} ORDER BY f.created_at DESC LIMIT $${params.length}`, params);
  return rows.map(row => ({ id: row.id, ticket: row.ticket_reference, ticketId: row.ticket_id, reviewId: row.review_id, verdict: row.verdict, category: row.category, subject: row.subject, description: row.description, status: row.status, createdAt: row.created_at }));
}

// "Train AI": store the feedback against the ticket's review and refresh the lessons file the worker prompt cites.
export async function trainFeedback({ ticket, description }) {
  const reference = parseTicketReference(ticket);
  if (!reference) throw new TypeError('Cần link hoặc mã ticket hợp lệ (ví dụ AIR-261002-QSGTPD).');
  const text = String(description || '').trim();
  if (!text) throw new TypeError('Cần nhập nội dung feedback.');
  if (text.length > MAX_DESCRIPTION) throw new TypeError(`Feedback dài quá ${MAX_DESCRIPTION} ký tự.`);
  const { rows: [review] } = await query('SELECT id::int AS id, ticket_id, verdict, category, subject FROM ai_check_reviews WHERE ticket_reference = $1 ORDER BY comment_at DESC NULLS LAST LIMIT 1', [reference]);
  const { rows: [saved] } = await query(`INSERT INTO ai_check_feedback (ticket_reference, ticket_id, review_id, verdict, category, subject, description, status)
    VALUES ($1, $2, $3, $4, $5, $6, $7, 'trained') RETURNING id::int AS id, created_at`, [reference, review?.ticket_id || '', review?.id || null, review?.verdict || 'pending', review?.category || '', review?.subject || '', text]);
  let lessonsFile = '';
  try { lessonsFile = await writeLessonsFile(); } catch { /* the database row is the source of truth; the file is a convenience copy */ }
  const result = { id: saved.id, ticket: reference, verdict: review?.verdict || 'pending', category: review?.category || '', subject: review?.subject || '', createdAt: saved.created_at, lessonsFile };
  // Đại tá's order of 13/10/2026: tell the Telegram bot the feedback arrived. Fire-and-forget: the save never waits for Telegram.
  result.telegram = scheduleFeedbackNotice({ ...result, description: text }) ? 'queued' : 'off';
  return result;
}

// --- Telegram notice for a saved feedback -----------------------------------
// AI_CHECK_FEEDBACK_TELEGRAM=off|0|false (env or .env_my) switches the notice off; default on.
export function feedbackNoticeEnabled(env = { ...loadEnv(), ...process.env }) {
  return !/^(off|0|false|no)$/i.test(String(env.AI_CHECK_FEEDBACK_TELEGRAM || '').trim());
}
const VERDICT_LABEL = { correct: 'AI check đúng', incorrect: 'AI check chưa đúng', pending: 'chưa đánh giá' };
const shorten = (value, max) => { const text = String(value || '').replace(/\s+/g, ' ').trim(); return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text; };
// One message per feedback: ticket, category/verdict of the review it trains, the description (≤ 200 chars) and the ticket link.
export function feedbackNotice(feedback) {
  const reference = String(feedback?.ticket || '').trim();
  const bits = [feedback?.category, VERDICT_LABEL[feedback?.verdict] || ''].filter(Boolean).join(', ');
  return [
    `✅ Đã nhận feedback Train AI cho ${reference}${bits ? ` (${bits})` : ''}: ${shorten(feedback?.description, 200)}`,
    'Bài học đã lưu, áp dụng từ lượt check tiếp theo.',
    `https://helpdesk.avada.net/tickets/${encodeURIComponent(reference)}`,
  ].join('\n');
}
const notifiedFeedback = new Set(); // feedback ids already announced in this process (a retried save does not send twice)
// Returns true when a notice was queued. `send` and `enabled` are injectable for tests; failures are logged, never thrown.
export function scheduleFeedbackNotice(feedback, { send = sendTelegramText, enabled = feedbackNoticeEnabled(), log = message => console.warn(message), retryDelayMs = 3000 } = {}) {
  const id = feedback?.id;
  if (!enabled || id == null || notifiedFeedback.has(id)) return false;
  notifiedFeedback.add(id);
  if (notifiedFeedback.size > 5000) notifiedFeedback.delete(notifiedFeedback.values().next().value);
  const text = feedbackNotice(feedback);
  // One retry after a short pause covers a transient transport error; after that the failure is only logged.
  Promise.resolve().then(() => send(text))
    .catch(() => new Promise(done => setTimeout(done, retryDelayMs)).then(() => send(text)))
    .catch(error => log(`[analytics] Telegram feedback notice failed for feedback ${id}: ${error.message}`));
  return true;
}

const appOf = reference => String(reference || '').split('-')[0].toUpperCase();
// Lessons for a worker prompt: same app first, then newest; bounded so the prompt stays small.
export async function lessons({ ticket = '', limit = 40, maxChars = 6000 } = {}) {
  const app = appOf(parseTicketReference(ticket) || ticket);
  const rows = await listFeedback({ limit: 300 });
  const ranked = rows.sort((left, right) => Number(appOf(right.ticket) === app) - Number(appOf(left.ticket) === app) || String(right.createdAt).localeCompare(String(left.createdAt)));
  const picked = []; let chars = 0;
  for (const row of ranked) {
    if (picked.length >= limit) break;
    const size = row.description.length + 80; if (chars + size > maxChars) continue;
    chars += size; picked.push({ ticket: row.ticket, verdict: row.verdict, category: row.category, subject: row.subject, feedback: row.description, createdAt: row.createdAt });
  }
  return { lessons: picked, total: rows.length };
}

export function lessonsMarkdown(rows) {
  const lines = ['# Bài học từ feedback của Đại tá về các lượt AI check ticket', '', `Cập nhật: ${new Date().toISOString()} · ${rows.length} feedback. Tạo tự động từ mục Analytics (bảng ai_check_feedback); không sửa tay.`, ''];
  for (const row of rows) lines.push(`## ${row.ticket}${row.category ? ` · ${row.category}` : ''} · ${row.verdict === 'correct' ? 'AI check đúng' : row.verdict === 'incorrect' ? 'AI check chưa đúng' : 'chưa đánh giá'}`, '', row.subject ? `Ticket: ${row.subject}` : '', row.description.trim(), '');
  return lines.filter(line => line !== null).join('\n');
}

export async function writeLessonsFile() {
  const rows = await listFeedback({ limit: 500 });
  await mkdir(resolve(LESSONS_FILE, '..'), { recursive: true });
  await writeFile(LESSONS_FILE, lessonsMarkdown(rows), 'utf8');
  return LESSONS_FILE.slice(ROOT.length);
}
