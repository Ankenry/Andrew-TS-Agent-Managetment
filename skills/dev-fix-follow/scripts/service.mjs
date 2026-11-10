// Controller of one follow run (dev-fix-follow or feature-follow, chosen by
// the profile). All side effects go through `io`, so the decisions here can be
// tested without Helpdesk, Slack or the AI worker.
import {
  DEV_PROFILE, statusLabels, MISSING_THREAD_KEY, currentSlot, manualSlot, threadKey, meaningfulAt, progressKey, normalizeAssessment,
  decideDraft, decideProgress, formatDraftComment, formatProgressComment,
} from './core.mjs';

const STATE_TTL_MS = 14 * 86_400_000;

async function mapWithConcurrency(values, limit, mapper) {
  const results = new Array(values.length);
  let next = 0;
  const worker = async () => { while (next < values.length) { const index = next++; results[index] = await mapper(values[index]); } };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, values.length)) }, worker));
  return results;
}

const reason = error => String(error?.message || error).replace(/\s+/g, ' ').slice(0, 300);

async function processTicket(ticket, { io, config, slot, write, force, entries, deadline, profile }) {
  const labels = statusLabels(profile);
  const reference = String(ticket.ticketId || ticket.id || '');
  const result = { id: String(ticket.id || ''), reference, subject: String(ticket.subject || ''), status: '', assessed: false, draft: { kind: 'none', action: 'none' }, progress: { action: 'none' } };
  const trace = (kind, text, extra) => io.trace?.(kind, `${reference}: ${text}`, extra);
  try {
    if (Date.now() > deadline) throw new Error('Hết thời gian của lượt quét trước khi tới ticket này.');
    const evidence = await io.evidence(reference);
    result.id = evidence.id; result.reference = evidence.ticketId || reference; result.subject = evidence.subject || result.subject;
    const entry = { ...(entries[evidence.id] || {}) };
    let key = MISSING_THREAD_KEY; let thread = null; let assessment = null; let status = 'missing_thread'; let latestSlackAt = '';
    if (evidence.slackLink) {
      thread = await io.slackThread(evidence.slackLink);
      const readKey = threadKey(thread.messages);
      assessment = entry.assessedKey === readKey && !force ? entry.assessment : null;
      if (!assessment) {
        trace('tool', 'thread có thay đổi, gửi cho AI đánh giá', { phase: 'assess' });
        assessment = normalizeAssessment(await io.assess({ evidence, thread, slot }), profile);
        result.assessed = true;
        Object.assign(entry, { assessedKey: readKey, assessment, assessedAt: new Date().toISOString() });
      }
      status = assessment.status;
      latestSlackAt = meaningfulAt(assessment, thread);
      key = progressKey(status, latestSlackAt);
    }
    result.status = status; result.statusLabel = labels[status];

    let draft = { kind: 'none', action: 'none' };
    if (assessment) {
      draft = decideDraft({ assessment, comments: evidence.comments, latestSlackAt, assessed: result.assessed, pendingKind: entry.draftPending || '', profile });
      if (draft.action === 'post') {
        draft.content = formatDraftComment(draft.kind, latestSlackAt, assessment.draftMail, profile, evidence.appName);
        if (write) {
          try { await io.post(evidence.id, draft.content); entry.draftPending = ''; trace('result', `đã lưu mail nháp (${draft.kind})`, { phase: 'draft' }); }
          catch (error) { draft = { ...draft, action: 'failed', error: reason(error) }; entry.draftPending = draft.kind; trace('error', `chưa lưu được mail nháp: ${draft.error}`, { phase: 'draft' }); }
        }
      } else if (draft.action !== 'none' || result.assessed) entry.draftPending = '';
    }
    result.draft = draft;

    const decision = decideProgress({ policy: config.commentPolicy, slot, comments: evidence.comments, postedKey: entry.postedKey, postedSlot: entry.postedSlot, key, draftPosted: draft.action === 'post', timeZone: config.timeZone, profile });
    result.progress = { action: decision.post ? 'post' : 'skip', changed: decision.changed, reason: decision.reason };
    if (decision.post) {
      result.progress.content = formatProgressComment({ slot, status, assessment, latestSlackAt, changed: decision.changed, draft, timeZone: config.timeZone, profile });
      if (write) {
        await io.post(evidence.id, result.progress.content);
        Object.assign(entry, { postedKey: key, postedSlot: slot.key, postedAt: new Date().toISOString() });
        trace('result', `đã cập nhật tiến độ: ${labels[status]}`, { phase: 'progress' });
      }
    }
    Object.assign(entry, { reference: result.reference, latestSlackAt, lastSeenAt: new Date().toISOString() });
    // A preview must not change what the next real run decides.
    if (write) entries[evidence.id] = entry;
    await io.save?.(result.reference, { evidence: { id: evidence.id, reference: result.reference, slackLink: evidence.slackLink || '' }, key, assessment, result });
  } catch (error) {
    result.error = reason(error);
    trace('error', result.error, { phase: 'ticket' });
  }
  return result;
}

export async function executeRun(io, config, { mode = 'preview', only = '', force = false, now = new Date(), profile = io.profile || DEV_PROFILE } = {}) {
  if (!['preview', 'post', 'scheduled'].includes(mode)) throw new Error('Unknown run mode.');
  const write = mode !== 'preview';
  const slot = mode === 'scheduled' ? currentSlot(now, config.slots, config.timeZone) : manualSlot(now, config.timeZone);
  const state = await io.loadState();
  state.tickets ||= {};
  if (mode === 'scheduled' && state.lastCompletedSlot === slot.key && !force) return { slot, mode, skipped: 'slot_already_completed', results: [] };

  await io.trace?.('start', `${profile.startText} ${slot.label} (${mode})`, { phase: 'start' });
  const tickets = only ? [{ id: only, ticketId: only }] : await io.listTickets();
  const deadline = Date.now() + config.runTimeoutMs;
  const results = await mapWithConcurrency(tickets, config.concurrency, ticket => processTicket(ticket, { io, config, slot, write, force, entries: state.tickets, deadline, profile }));

  const run = { slot, mode, startedAt: now.toISOString(), finishedAt: new Date().toISOString(), results };
  if (write) {
    const cutoff = Date.now() - STATE_TTL_MS;
    for (const [id, entry] of Object.entries(state.tickets)) if (Date.parse(entry.lastSeenAt || '') < cutoff) delete state.tickets[id];
    if (mode === 'scheduled' && !only) state.lastCompletedSlot = slot.key;
    state.lastRun = { slot: slot.key, mode, finishedAt: run.finishedAt, tickets: results.length, failed: results.filter(item => item.error).length };
    await io.saveState(state);
    if (config.telegramSummary && !only) {
      try { await io.notify(run); run.notified = true; }
      catch (error) { run.notified = false; run.notifyError = reason(error); }
    }
  }
  await io.trace?.('done', `Xong lượt ${slot.label}: ${results.length} ticket, ${results.filter(item => item.error).length} lỗi`, { phase: 'done', terminal: true });
  return run;
}
