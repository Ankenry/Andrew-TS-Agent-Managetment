import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { HAN_REPORT_VERSION, HANDLING_COMMENT_VERSION, HELPDESK_COMMENT_VERSION, parseHanReport, reportArtifacts } from './han-report.mjs';
import { reviewPresentation } from './canonical-review.mjs';
import { executeReview } from './core.mjs';
import { formatReviewComment } from './handoff.mjs';
import { reviewNoticeText, splitTelegramText } from './notifications.mjs';
import { ROOT, STATE_PATH, ANDREW_ID, settings, helpdesk, createIO, postComment, findPostedComment, jobTraceEmitter, readEvidence } from './adapters.mjs';
import { normalizeBotCommand, findBotCommands, followUpWindow, isReplyKind, CHECK_ACK, jobCommandKeyword } from './bot-command.mjs';
import { chatReply, generateReply } from './bot-reply.mjs';
import { CUSTOMER_MAIL_FORMAT_VERSION } from '../../../scripts/customer-mail-format.mjs';
import { generateDraft, commandDraftComment } from './bot-draft.mjs';
import { ACK_DELIVERY_VERSION, assertAckCommand, ackHasIntent, ackReceiptId, isolatedAckFor } from './ack-recovery.mjs';
import { safeHelpdeskDiagnostics } from '../../../scripts/helpdesk-http.mjs';

// Internal ticket id a job works on: lifecycle jobs are keyed by it; "@han" command jobs (cmd-<commentId>) carry it in ticketId.
export const jobTicketId = job => job?.ticketId || job?.id;
export const commandJobId = commentId => `cmd-${commentId}`;


// Startup log only: whether the v2 pipeline will read app source through the TS Elite 2 Source API (never prints the key).
async function describeSourceApi(){
  const { readFile } = await import('node:fs/promises');
  const { resolve, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  const { normalizeSourceApi } = await import('../../check-ticket-v2/scripts/pipeline.mjs');
  const { hasKeyFile } = await import('../../check-ticket-v2/scripts/source-api.mjs');
  const workflow = JSON.parse(await readFile(resolve(root, 'skills/check-ticket-v2/workflow.json'), 'utf8'));
  const config = normalizeSourceApi(workflow.sourceApi);
  const key = hasKeyFile(resolve(root, config.keyFile));
  return `Source API: ${config.enabled && key ? `enabled (${config.endpoint}, timeout ${config.timeoutMs}ms, fallback apps_doc)` : config.enabled ? `disabled (no BEARER_Auth in ${config.keyFile}; apps_doc only)` : 'disabled by workflow.json (apps_doc only)'}`;
}

export class TicketReviewService {
  constructor({ root=ROOT, statePath=STATE_PATH, config, get=helpdesk, review, reply, draft, post=(id,content,mentions)=>postComment(id,content,helpdesk,mentions), find=(id,content,scope)=>findPostedComment(id,content,helpdesk,scope), notify=null, trace=null, now=()=>Date.now(), sessionStartedAt=null, resumeSession=false } = {}) {
    Object.assign(this, { root, statePath, config, get, post, find, notify, trace, now, sessionStartedAt, resumeSession });
    // "@han" comment commands (13/10/2026): keyword, instruction cap, optional own poll interval (default: the scan cycle).
    this.bot = normalizeBotCommand(config?.botCommand);
    this.review = review || (async (reference, jobDir, progress, options={}) => executeReview(reference, await createIO(jobDir,progress,{reference}),this.config,{publishDemo:true,followUp:options.followUp || null}));
    // Natural reply to a chat/question "@han" comment (14/10/2026): one Codex turn without tools over data already at hand.
    this.reply = reply || (async (job, followUp, jobDir) => {
      const ticket = await readEvidence(job.reference, this.get);
      return generateReply({ ticket, followUp, config: this.bot, jobDir, root: this.root, jobs: this.state.jobs, deadline: this.now() + this.bot.replyTimeoutMs, log: text => this.log(job, 'note', text, { phase: 'reply' }) });
    });
    this.draft = draft || ((job, jobDir) => generateDraft({ job, jobDir, root: this.root, get: this.get, timeoutMs: this.bot.replyTimeoutMs }));
    this.state = null; this.writes = Promise.resolve(); this.scanning = false; this.processing = false;
    this.ackWork = new Map();
    this.timers = []; this.lastError = ''; this.started = false;
  }
  // Tracing only (best-effort): controller milestones of one job. `trace` is job => emitter; nothing is traced without it.
  log(job, kind, text, extra={}) {
    try { void this.trace?.(job)?.(kind, text, {actor:'controller',...extra}); } catch { /* tracing never affects the review */ }
  }
  deliveryFailure(job, error) {
    const detail = safeHelpdeskDiagnostics(error.detail);
    job.deliveryErrors ||= [];
    job.deliveryErrors.push({at:new Date(this.now()).toISOString(),...detail,
      postAttempted:typeof error.postAttempted === 'boolean' ? error.postAttempted : null});
    return detail;
  }
  async change(fn) {
    const work = this.writes.then(async () => {
      fn(this.state);
      await mkdir(dirname(this.statePath),{recursive:true,mode:0o700});
      const temp = this.statePath + '.tmp';
      await writeFile(temp,JSON.stringify(this.state,null,2)+'\n',{mode:0o600});
      await rename(temp,this.statePath);
    });
    this.writes=work.catch(()=>{}); return work;
  }
  async roster() {
    const all = []; let cursor = '';
    for (let page=0; page<20; page++) {
      const data = await this.get('/tickets?'+new URLSearchParams({limit:'10000',...(cursor?{cursor}:{})}));
      all.push(...(data?.tickets || []));
      if (!data?.nextCursor) {
        if (Number(data?.total)>all.length) throw new Error('Assigned roster was truncated; baseline unchanged.');
        return all.filter(t => (t.memberIds || []).includes(ANDREW_ID) && !t.deletedAt);
      }
      cursor = data.nextCursor;
    }
    throw new Error('Assigned roster pagination limit exceeded.');
  }
  async notifications(cutoff) {
    const all=[]; let cursor='';
    for (let page=0;page<20;page++) {
      const data=await this.get('/notifications?'+new URLSearchParams({memberId:ANDREW_ID,limit:'100',...(cursor?{cursor}:{})}));
      const items=data?.notifications || []; all.push(...items);
      if (!data?.nextCursor || items.some(n=>Date.parse(n.createdAt)<=cutoff)) return all;
      cursor=data.nextCursor;
    }
    throw new Error('Notification history incomplete; scan cutoff unchanged.');
  }
  async initialize() {
    if (this.state) return;
    try { this.state=JSON.parse(await readFile(this.statePath,'utf8')); }
    catch(error) { if(error.code!=='ENOENT') throw error; }
    if (this.state) {
      if(this.state.version!==1 || !this.state.jobs || !Array.isArray(this.state.assignedTicketIds)) throw new Error('Unsupported workflow state; refusing to reset or replay.');
      // Fresh connections baseline offline history. Maintenance restarts keep
      // the existing scan cursor and durable jobs so live events are not lost.
      const freshSession = this.sessionStartedAt && !this.resumeSession;
      const baseline = freshSession ? await this.roster() : null;
      await this.change(state => {
        if (freshSession) {
          state.sessionStartedAt = this.sessionStartedAt;
          state.lastScanAt = this.sessionStartedAt;
          state.assignedTicketIds = baseline.map(t => t.id);
          state.pendingEvents = {};
        }
        // "@han" commands: a state written before this feature (or a fresh session) starts its comment cursor now, so
        // comments Andrew wrote earlier are never replayed. Handled comment ids live in state.commands for good.
        state.commands ||= {};
        if (freshSession || !state.commandScanAt) state.commandScanAt = this.sessionStartedAt || new Date(this.now()).toISOString();
        if ((state.commandKeyword || '@bot') !== this.bot.keyword) {
          // The old process may have scanned past new-keyword comments while waiting for activation.
          // Rewind only this keyword to its explicit cutover; keep handled IDs, jobs and lifecycle cursor.
          const cutover = freshSession ? this.sessionStartedAt : this.bot.keywordSinceAt || new Date(this.now()).toISOString();
          state.commandKeywordSinceAt = cutover;
          state.commandScanAt = cutover;
          for (const pending of Object.values(state.commandPending || {})) pending.sinceAt = cutover;
        }
        state.commandKeyword = this.bot.keyword;
        for (const job of Object.values(state.jobs)) {
          if(job.status==='running') {
            const stoppedAt=job.phase;
            job.status=job.attempts>=this.config.maxAttempts?'needs_attention':'queued';
            job.phase='interrupted';
            if(job.status==='needs_attention') job.failedAt=new Date(this.now()).toISOString();
            this.log(job,'warning',`Controller khởi động lại khi lần thử ${job.attempts}/${this.config.maxAttempts} đang ở pha ${stoppedAt || 'không rõ'}; ${job.status==='queued'?'job được xếp lại hàng chờ':'đã hết lượt thử'}`,
              {phase:'interrupted',payload:{attempt:job.attempts,maxAttempts:this.config.maxAttempts,stoppedAt:stoppedAt || null,status:job.status}});
          }
          if(job.status==='posting') {
            job.status='uncertain';
            this.log(job,'warning','Controller khởi động lại khi đang đăng comment; sẽ đối chiếu trên Helpdesk trước, không tự đăng lại',{phase:'comment',payload:{status:'uncertain'}});
          }
          if (job.ack?.status === 'posting') job.ack.status = 'uncertain';
          for (const notice of Object.values(job.telegram || {})) {
            if (notice.status === 'sending') notice.status = 'uncertain';
          }
        }
      });
      return;
    }
    const activatedAt=this.sessionStartedAt || new Date(this.now()).toISOString();
    const assigned=await this.roster();
    this.state={version:1,activatedAt,lastScanAt:activatedAt,assignedTicketIds:assigned.map(t=>t.id),seenNotificationIds:[],jobs:{},commands:{},commandScanAt:activatedAt,commandKeyword:this.bot.keyword,commandKeywordSinceAt:activatedAt};
    await this.change(()=>{});
  }
  // "@han" commands (13/10/2026). Andrew's own comments raise no Helpdesk notification, so the roster the scan already
  // fetched is the change signal: a new comment bumps the ticket's updatedAt. Only tickets updated after the comment
  // cursor get one actions read; a command is a comment by Andrew's account that carries the keyword, created after
  // the cursor and not handled before (state.commands). Each command becomes exactly one job, keyed by its comment id.
  async scanCommands(tickets, scanStarted) {
    if (!this.bot.enabled) return;
    const since = Date.parse(this.state.commandScanAt || '');
    if (!Number.isFinite(since)) { await this.change(state => { state.commands ||= {}; state.commandScanAt = scanStarted; }); return; }
    const changed = tickets.filter(t => t?.id && t.ticketId && !t.deletedAt && Date.parse(t.updatedAt || '') > since);
    const pending = { ...(this.state.commandPending || {}) };
    for (const ticket of changed) pending[ticket.id] = { reference: ticket.ticketId, subject: ticket.subject || '', createdAt: ticket.createdAt || null, failedAt: pending[ticket.id]?.failedAt || null, sinceAt: pending[ticket.id]?.sinceAt || this.state.commandScanAt };
    for (const [ticketId, item] of Object.entries(pending)) {
      try {
        const data = await this.get(`/tickets/${encodeURIComponent(ticketId)}/actions?type=commentTicket&limit=100`);
        const commands = findBotCommands(data?.actions || [], { authorId: ANDREW_ID, since: item.sinceAt || since, seen: new Set([...Object.keys(this.state.commands || {}), ...Object.values(this.state.jobs).flatMap(job=>[job.commentId,job.ack?.commentId]).filter(Boolean)]), keyword: this.bot.keyword, maxInstructionChars: this.bot.maxInstructionChars });
        for (const command of commands) await this.enqueueCommand({ id: ticketId, ticketId: item.reference, subject: item.subject, createdAt: item.createdAt }, command);
        delete pending[ticketId];
      } catch (error) {
        // One unreadable ticket must not block the others; it is retried on the next scan.
        pending[ticketId] = { ...item, lastError: error.message, failedAt: scanStarted };
      }
    }
    await this.change(state => { state.commandPending = pending; state.commandScanAt = scanStarted; });
  }
  async enqueueCommand(ticket, command) {
    const jobId = commandJobId(command.commentId);
    await this.change(state => {
      if (state.commands[command.commentId] || state.jobs[jobId]) return;
      const window = followUpWindow({ jobs: state.jobs, ticketId: ticket.id, commentAt: command.createdAt, ticketCreatedAt: ticket.createdAt });
      const refused = command.kind === 'refused';
      state.commands[command.commentId] = { jobId, ticketId: ticket.id, reference: ticket.ticketId, at: command.createdAt, kind: command.kind, seenAt: new Date(this.now()).toISOString() };
      state.jobs[jobId] = {
        // mode 'reply' (chat/question/unsure, 14/10/2026): one natural comment without the report wrapper, no pipeline;
        // mode 'review': the follow-up check. The model may still turn an unsure text into a review (see processReply).
        id: jobId, ticketId: ticket.id, reference: ticket.ticketId, subject: ticket.subject || '', trigger: 'bot_command', mode: refused ? 'refused' : command.kind === 'draft' ? 'draft' : isReplyKind(command.kind) ? 'reply' : 'review',
        command: { keyword: this.bot.keyword, commentId: command.commentId, createdAt: command.createdAt, instruction: command.instruction, defaultInstruction: command.defaultInstruction, kind: command.kind, chatGroup: command.chatGroup || null, reasons: command.reasons || [], excerpt: String(command.content || '').slice(0, 500) },
        ack: { status: 'pending', content: CHECK_ACK, attempts: 0 },
        followUp: { sinceAt: window.sinceAt, previousJobId: window.previousJobId, previousCategory: window.previousCategory },
        status: 'queued', phase: 'ack', attempts: 0, createdAt: new Date(this.now()).toISOString(), ...(this.notify ? { telegram: {} } : {}),
      };
    });
    const job = this.state.jobs[jobId];
    this.log(job, command.kind === 'refused' ? 'warning' : 'start', command.kind === 'refused'
      ? `Lệnh @han bị từ chối (${command.reasons.join('; ')}): "${command.instruction.slice(0, 200)}"`
      : job.mode === 'draft' ? `Nhận lệnh soạn mail nháp từ ${command.commentId}; không gửi email cho khách`
      : job.mode === 'reply' ? `Nhận comment @han (${command.kind}${command.chatGroup ? `/${command.chatGroup}` : ''}) từ ${command.commentId}: "${command.instruction.slice(0, 200)}" → trả lời tự nhiên, không chạy check`
      : `Nhận lệnh @han từ comment ${command.commentId}: "${command.instruction.slice(0, 200)}"${job.followUp.sinceAt ? ` · xét comment mới từ ${job.followUp.sinceAt}` : ''}`,
      { phase: job.phase, payload: { commentId: command.commentId, kind: command.kind, reasons: command.reasons, defaultInstruction: command.defaultInstruction, sinceAt: job.followUp.sinceAt, previousJobId: job.followUp.previousJobId } });
    if (await this.ensureCommandAck(job) && job.mode === 'refused' && job.status === 'queued') {
      await this.change(()=>{job.status='cancelled';job.phase='refused';});
    }
  }
  // What the pipeline needs to check a ticket again after a "@han" comment: the instruction (data), the comment id to
  // leave out of "new comments", the window start and the report posted last time (data, never evidence).
  followUpFor(job) {
    if (job?.trigger !== 'bot_command' || !job.command) return null;
    const previous = job.followUp?.previousJobId ? this.state.jobs[job.followUp.previousJobId] : null;
    return { keyword: jobCommandKeyword(job), instruction: job.command.instruction, defaultInstruction: job.command.defaultInstruction, kind: job.command.kind || 'follow_up', acknowledgementIds: Object.values(this.state.jobs).filter(other=>jobTicketId(other)===jobTicketId(job)).map(other=>other.ack?.commentId).filter(Boolean), commentId: job.command.commentId, commentAt: job.command.createdAt,
      sinceAt: job.followUp?.sinceAt || null, previousReport: previous?.comment || null, previousCategory: previous?.category || job.followUp?.previousCategory || null, previousFinishedAt: previous?.finishedAt || null };
  }
  async enqueue(ticket,trigger) {
    if (!ticket?.id || !ticket.ticketId || ticket.deletedAt) return;
    // A ticket lifecycle receives a single report even when creation and
    // assignment arrive through different notifications/snapshot scans.
    await this.change(state => {
      if(state.jobs[ticket.id]) return;
      state.jobs[ticket.id]={id:ticket.id,reference:ticket.ticketId,subject:ticket.subject || '',trigger,status:'queued',phase:'queued',attempts:0,createdAt:new Date(this.now()).toISOString(),...(this.notify?{telegram:{}}:{})};
    });
  }
  async notice(job, event) {
    // Old jobs are not opted into the new notification sequence on restart.
    if (!this.notify || !job.telegram) return true;
    let entry = job.telegram[event];
    if (!entry) {
      const parts = splitTelegramText(reviewNoticeText(job, event));
      await this.change(() => { entry = job.telegram[event] = {status:'pending',parts,nextPart:0,messageIds:[],attempts:0}; });
    }
    if (entry.status === 'sent') return true;
    if (['uncertain','needs_attention'].includes(entry.status) || (entry.nextAttemptAt || 0) > this.now()) return false;
    while (entry.nextPart < entry.parts.length) {
      await this.change(() => { entry.status='sending';entry.attempts++; });
      let receipt;
      try {
        receipt = await this.notify(entry.parts[entry.nextPart]);
        if (!Number.isInteger(receipt?.messageId)) throw new Error('Telegram receipt is missing.');
      } catch (error) {
        await this.change(() => {
          const knownFailure = error.deliveryUncertain === false;
          entry.status = !knownFailure ? 'uncertain' : entry.attempts >= this.config.maxAttempts ? 'needs_attention' : 'pending';
          entry.lastError = knownFailure ? 'Telegram rejected delivery.' : 'Telegram delivery is unconfirmed; no automatic resend.';
          entry.nextAttemptAt = this.now() + Math.max(Number(error.retryAfterMs) || 0, Math.min(300000,30000*2**Math.min(entry.attempts-1,4)));
        });
        this.log(job,'warning',`Telegram chưa nhận thông báo "${event}": ${entry.lastError}`,
          {phase:'telegram',payload:{notice:event,status:entry.status,part:entry.nextPart+1,parts:entry.parts.length,attempt:entry.attempts,retryInMs:entry.status==='pending'?entry.nextAttemptAt-this.now():null}});
        return false;
      }
      await this.change(() => {
        entry.messageIds.push(receipt.messageId);entry.nextPart++;entry.attempts=0;delete entry.lastError;delete entry.nextAttemptAt;
        entry.status=entry.nextPart===entry.parts.length?'sent':'pending';
      });
    }
    this.log(job,'note',`Telegram đã nhận thông báo "${event}"${entry.parts.length>1?` (${entry.parts.length} phần)`:''}`,{phase:'telegram',payload:{notice:event,messageIds:entry.messageIds}});
    return true;
  }
  async terminalNotice(job) {
    const reply = job.trigger === 'bot_command' && job.mode === 'reply';
    if (job.mode === 'draft' && ['done','needs_attention'].includes(job.status)) return this.notice(job, job.status === 'done' ? 'drafted' : 'draft_failed');
    if (job.status === 'done') return this.notice(job, reply ? 'replied' : 'completed');
    if (job.status === 'needs_attention') return this.notice(job, reply ? 'reply_failed' : 'failed');
    if (job.status === 'cancelled' && job.phase === 'refused') return this.notice(job, 'refused');
  }
  async scan() {
    if(this.scanning || !this.config.enabled) return;
    this.scanning=true;
    try {
      await this.initialize();
      const scanStarted=new Date(this.now()).toISOString();
      const cutoff=Date.parse(this.state.lastScanAt);
      const notifications=await this.notifications(cutoff);
      const seen=new Set(this.state.seenNotificationIds);
      const pending = this.state.pendingEvents || {};
      const events = new Map(Object.values(pending).map(item => [item.event.id, item.event]));
      for (const event of [...notifications].reverse()) {
        if (event.id && !seen.has(event.id) && Date.parse(event.createdAt)>cutoff) events.set(event.id,event);
      }
      for(const event of events.values()) {
        if(!['ticket_created','ticket_assigned'].includes(event.type)) continue;
        if(event.userId && event.userId!==ANDREW_ID) continue;
        const reference=event.metadata?.ticketId;
        if(!reference) continue;
        try {
          const data=await this.get('/tickets/'+encodeURIComponent(reference));
          const ticket=data?.ticket || data;
        // Assignment events must refer to Andrew's current membership. Creation
        // events come from his scoped notification inbox.
          if(event.type!=='ticket_assigned' || (ticket.memberIds || []).includes(ANDREW_ID)) await this.enqueue(ticket,event.type);
          await this.change(state => { if(state.pendingEvents) delete state.pendingEvents[event.id]; });
        } catch(error) {
          // One inaccessible ticket must not starve all newer notifications.
          // Retain the event even after advancing the scan cursor for retry.
          await this.change(state => {
            state.pendingEvents ||= {};
            state.pendingEvents[event.id] = {event,lastError:error.message,failedAt:scanStarted};
          });
        }
      }
      const assigned=await this.roster();
      const previous=new Set(this.state.assignedTicketIds);
      for(const ticket of assigned) if(!previous.has(ticket.id)) await this.enqueue(ticket,'assigned_roster');
      await this.scanCommands(assigned, scanStarted);
      await this.change(state=>{
        state.assignedTicketIds=assigned.map(t=>t.id);
        state.seenNotificationIds=[...new Set([...notifications.map(n=>n.id).filter(Boolean),...state.seenNotificationIds])].slice(0,2000);
        state.lastScanAt=scanStarted;
      });
      const blocked=Object.values(this.state.pendingEvents || {});
      this.lastError=blocked.length ? `${blocked.length} ticket event(s) pending: ${blocked[0].lastError}` : '';
    } catch(error) {this.lastError=error.message;throw error;}
    finally {this.scanning=false;}
  }
  commentScope(job, ack = false) {
    if (!ack && job.commentFormatVersion === HANDLING_COMMENT_VERSION) {
      if (!Number.isFinite(Date.parse(job.presentationBinding?.preparedAt || ''))) throw new Error('Handling prepared time is missing.');
      return {since:job.presentationBinding.preparedAt, exactBody:true,
        excludeIds:Object.values(this.state.jobs).flatMap(other => [other.id !== job.id ? other.commentId : null, other.ack?.commentId, other.command?.commentId]).filter(Boolean)};
    }
    if (job.trigger !== 'bot_command') return undefined;
    const excludeIds = Object.values(this.state.jobs).flatMap(other => [
      other.id !== job.id ? other.commentId : null,
      other.id !== job.id || !ack ? other.ack?.commentId : null,
      other.command?.commentId,
    ]).filter(Boolean);
    if (ack) excludeIds.push(...(job.ack?.beforeIds || []));
    const later = ack ? Object.values(this.state.jobs).filter(other => other.id !== job.id
      && jobTicketId(other) === jobTicketId(job) && other.ack?.startedAt
      && Date.parse(other.ack.startedAt) > Date.parse(job.ack?.startedAt || job.command.createdAt))
      .map(other => other.ack.startedAt).sort()[0] : null;
    return { since: ack ? job.ack?.startedAt || job.command.createdAt : job.command.createdAt, excludeIds,
      ...(ack ? { until: later, receiptId: job.ack?.receiptId, requireReceiptId: job.ack?.requireReceiptId === true } : {}) };
  }
  async confirmAck(job) {
    const found = await this.find(jobTicketId(job), job.ack.content, this.commentScope(job, true));
    if (!found) return false;
    await this.change(() => { job.ack.status='sent';job.ack.commentId=found.id;
      job.ack.confirmedAt=new Date(this.now()).toISOString();delete job.ack.lastError;delete job.ack.nextAttemptAt; });
    return true;
  }
  // ACK is independent of the review queue. Serialize by ticket: two identical ACKs must never claim each other.
  async ensureCommandAck(job) {
    if (job?.trigger !== 'bot_command' || !job.ack) return true;
    if (['done','cancelled','needs_attention'].includes(job.status)) return false;
    const ticketId = jobTicketId(job);
    const previous = this.ackWork.get(ticketId) || Promise.resolve();
    const work = previous.catch(()=>{}).then(()=>this.deliverCommandAck(job));
    this.ackWork.set(ticketId, work);
    try { return await work; }
    finally { if (this.ackWork.get(ticketId) === work) this.ackWork.delete(ticketId); }
  }
  async deliverCommandAck(job) {
    if (['done','cancelled','needs_attention'].includes(job.status)) return false;
    const ack = job.ack;
    if (ack.status === 'sent') return true;
    if ((ack.nextAttemptAt || 0) > this.now()) return false;
    // Keep a later command from claiming an earlier ambiguous POST on this same ticket.
    try {
      if (ack.status === 'pending') {
        await this.change(()=>{ack.attempts++;ack.phase='preflight';});
        for (const other of Object.values(this.state.jobs).filter(other => other.id !== job.id
          && jobTicketId(other) === jobTicketId(job) && ackHasIntent(other.ack)
          && ['posting','uncertain','needs_attention'].includes(other.ack?.status))) {
          // Explicit recovery exemptions apply to one target only. Never claim the old ACK by text afterwards.
          if (isolatedAckFor(other, job)) continue;
          await this.change(()=>{ack.phase='prior_ack_reconcile';});
          if (!await this.confirmAck(other)) {
            throw new Error('An earlier ACK on this ticket is unconfirmed; refusing another identical ACK.');
          }
        }
        await this.change(()=>{ack.phase='preflight';});
        const current = await this.get('/tickets/'+encodeURIComponent(jobTicketId(job)));
        const ticket = current?.ticket || current;
        if (!ticket?.id || ticket.deletedAt) throw new Error('Ticket unavailable; ACK not posted.');
        const before = await this.get(`/tickets/${encodeURIComponent(jobTicketId(job))}/actions?type=commentTicket&limit=100`);
        if (!Array.isArray(before?.actions) || before.nextCursor || before.hasMore || Number(before.total)>before.actions.length || (before.total == null && before.actions.length>=100)) throw new Error('ACK baseline incomplete; no POST attempted.');
        assertAckCommand(job, before.actions);
        // Persist intent before POST. Never automatically repost after this boundary, even after a crash.
        await this.change(()=>{ack.status='posting';ack.startedAt=new Date(this.now()).toISOString();ack.beforeIds=before.actions.map(a=>a.id).filter(Boolean);ack.phase='post';});
        const response = await this.post(jobTicketId(job), ack.content, []);
        const receiptId = ackReceiptId(response, jobTicketId(job));
        await this.change(()=>{if(receiptId)ack.receiptId=receiptId;ack.postAcceptedAt=new Date(this.now()).toISOString();ack.responseKind=response?.id===jobTicketId(job)?'ticket':'comment_or_other';ack.phase='reconcile';});
      }
      await this.change(()=>{ack.phase='reconcile';});
      if (!await this.confirmAck(job)) throw new Error('ACK delivery is unconfirmed; no automatic repost.');
      this.log(job,'note',`Đã xác nhận comment nhận lệnh (${ack.commentId}): ${ack.content}`,{phase:'ack',payload:{commentId:ack.commentId}});
      return true;
    } catch (error) {
      await this.change(()=>{
        ack.lastError=error.message;
        ack.lastErrorPhase=error.deliveryPhase || ack.phase;
        ack.errors ||= [];
        ack.errors.push({at:new Date(this.now()).toISOString(),phase:ack.lastErrorPhase,message:error.message,
          ...(typeof error.postAttempted === 'boolean' ? {postAttempted:error.postAttempted} : {})});
        if (error.postAttempted === false && error.deliveryPhase === 'author_lookup') {
          // The adapter proves no POST was attempted; preserve the abandoned intent in the audit trail.
          ack.abortedIntents ||= [];
          ack.abortedIntents.push({startedAt:ack.startedAt,beforeIds:ack.beforeIds,reason:error.message});
          delete ack.startedAt;delete ack.beforeIds;ack.status='pending';
        }
        if (ack.status !== 'pending') { ack.status='uncertain'; ack.reconcileAttempts=(ack.reconcileAttempts || 0)+1; }
        const exhausted = ack.status === 'pending' ? ack.attempts >= this.config.maxAttempts : ack.reconcileAttempts >= this.config.maxAttempts;
        if (exhausted) { ack.status='needs_attention';job.status='needs_attention';job.phase='ack';job.failedAt=new Date(this.now()).toISOString();job.lastError=error.message; }
        ack.nextAttemptAt=this.now()+60000;job.nextAttemptAt=ack.nextAttemptAt;
      });
      this.log(job,'warning',`Chưa xác nhận ACK: ${error.message}`,{phase:'ack',payload:{status:ack.status}});
      return false;
    }
  }
  handlingReceipt(job, found) {
    if (job.commentFormatVersion !== HANDLING_COMMENT_VERSION) return null;
    if (!found?.id || found.author?.memberId !== ANDREW_ID || found.author?.authUid
      || (found.type && found.type !== 'commentTicket') || String(found.metadata?.content || found.content || '') !== job.comment
      || !(Date.parse(found.createdAt || '') >= Date.parse(job.presentationBinding?.preparedAt || ''))) throw new Error('Handling receipt does not match the prepared run/comment.');
    return {jobId:job.id, ticketId:jobTicketId(job), runId:job.runId, commentId:found.id, commentAt:found.createdAt,
      commentSha256:createHash('sha256').update(job.comment).digest('hex')};
  }
  async reconcile(job) {
    const found=await this.find(jobTicketId(job),job.comment,this.commentScope(job));
    const receipt=found ? this.handlingReceipt(job,found) : null;
    await this.change(()=>{
      if(found) {if(receipt)job.deliveryReceipt=receipt;job.status='done';job.commentId=found.id;job.finishedAt=new Date(this.now()).toISOString();delete job.lastError;}
      else {job.status='needs_attention';job.failedAt=new Date(this.now()).toISOString();job.lastError='Comment delivery is unconfirmed; no automatic repost to avoid duplicates.';}
    });
    if(!found) this.log(job,'warning','Không tìm thấy comment vừa gửi trên Helpdesk; không tự đăng lại để tránh trùng',{phase:'comment',payload:{status:'needs_attention',deliveryAttempts:job.deliveryAttempts || 0}});
  }
  // Reply branch of a "@han" comment (14/10/2026): no 📥/🔎 notices, no pipeline, no wrapper. A chat uses a template (unless
  // botCommand.chatTemplates is false); a question/unsure text gets one model turn over existing data. When the model says the
  // text really asks for a check, the job switches to mode 'review' and the next processOne runs the follow-up as usual.
  // The ACK is confirmed first; one plain reply follows. A failed reply keeps its ACK and warns on Telegram.
  async processReply(job, ticketId) {
    if(job.status==='queued') {
      await this.change(()=>{job.status='running';job.phase=job.mode==='draft'?'draft':'reply';job.attempts++;job.runId=randomUUID();});
      const followUp=this.followUpFor(job);
      this.log(job,'start',`Lần thử ${job.attempts}/${this.config.maxAttempts} • ${job.reference} • ${job.mode==='draft'?'soạn mail nháp':'trả lời'} @han (${job.command.kind}): "${String(job.command.instruction).slice(0,160)}"`,
        {phase:job.mode==='draft'?'draft':'reply',payload:{attempt:job.attempts,maxAttempts:this.config.maxAttempts,runId:job.runId,trigger:job.trigger,kind:job.command.kind,chatGroup:job.command.chatGroup || null,commentId:job.command.commentId}});
      const jobDir=resolve(this.root,'runtime/check-ticket/jobs',job.id,job.runId);
      let result;
      if(job.mode==='draft') {
        result=await this.draft(job,jobDir);
        if(result?.ticketId!==ticketId) throw new Error('Draft returned a different ticket.');
        result={...result,kind:'draft',body:commandDraftComment(result.body,job.command.commentId,result.appName)};
      }
      else if(this.bot.chatTemplates && job.command.kind==='chat') result={kind:'chat',body:chatReply({group:job.command.chatGroup,reference:job.reference,keyword:this.bot.keyword}),source:'template',attempts:0};
      else result=await this.reply(job,followUp,jobDir);
      if(result?.kind==='follow_up') {
        // The model read a real check request: hand the job to the review branch (received/checking notices, pipeline, wrapper).
        await this.change(()=>{job.mode='review';job.status='queued';job.phase='queued';job.attempts=0;delete job.runId;job.command.kind='follow_up';job.command.resolvedBy='model';});
        this.log(job,'note','Model đọc comment là yêu cầu check tiếp → chuyển sang luồng check tiếp (follow-up)',{phase:'queued',payload:{resolvedBy:'model'}});
        await this.ensureCommandAck(job);
        return;
      }
      if(!result?.body) throw new Error('Reply worker returned no body.');
      await this.change(()=>{job.status='ready';job.comment=String(result.body).trim();job.replySource=result.source || 'model';job.command.kind=result.kind || job.command.kind;job.artifactDir=jobDir;});
    }
    await this.change(()=>{job.deliveryAttempts=(job.deliveryAttempts || 0)+1;});
    const existing=await this.find(ticketId,job.comment,this.commentScope(job));
    if(existing) {
      await this.change(()=>{job.status='done';job.phase='already_posted';job.commentId=existing.id;job.finishedAt=new Date(this.now()).toISOString();});
      this.log(job,'note',`Câu trả lời này đã có trên Helpdesk (${existing.id}); không đăng lại`,{phase:'already_posted',payload:{commentId:existing.id}});
      return;
    }
    const current=await this.get('/tickets/'+encodeURIComponent(ticketId));
    if((current?.ticket || current)?.deletedAt) throw new Error('Ticket was deleted; reply not posted.');
    // Plain text: a natural reply never carries the "Sau khi TS check" report wrapper.
    await this.change(()=>{job.mentions=[];job.status='posting';job.phase='comment';});
    this.log(job,'tool',`Đăng câu trả lời @han lên Helpdesk (lần gửi ${job.deliveryAttempts}, ${job.comment.length} ký tự, nguồn ${job.replySource})`,{phase:'comment',payload:{deliveryAttempt:job.deliveryAttempts,length:job.comment.length,source:job.replySource}});
    try {
      await this.post(ticketId,job.comment,job.mentions);
      await this.reconcile(job);
    } catch(error) {
      let detail;
      await this.change(()=>{job.status='uncertain';job.lastError=error.message;detail=this.deliveryFailure(job,error);});
      this.log(job,'warning',`Chưa xác nhận được việc đăng câu trả lời: ${error.message}; sẽ đối chiếu trên Helpdesk, không tự đăng lại`,{phase:'comment',payload:{status:'uncertain',deliveryAttempt:job.deliveryAttempts,detail}});
    }
  }
  async processOne() {
    if(this.processing || !this.config.enabled || !this.state) return;
    this.processing=true;
    let job;
    try {
      for (const terminal of Object.values(this.state.jobs).filter(j=>j.telegram && (['done','needs_attention'].includes(j.status) || (j.status==='cancelled' && j.phase==='refused')))) {
        await this.terminalNotice(terminal);
      }
      job=Object.values(this.state.jobs).find(j=>['queued','ready','uncertain'].includes(j.status) && (j.nextAttemptAt || 0)<=this.now()
        && ['received','checking'].every(event=>!j.telegram?.[event] || (['pending','sent'].includes(j.telegram[event].status) && (j.telegram[event].nextAttemptAt || 0)<=this.now())));
      if(!job) return;
      if(job.status==='uncertain') {await this.reconcile(job);return;}
      const ticketId=jobTicketId(job);
      if (!await this.ensureCommandAck(job)) return;
      if (job.command?.kind === 'refused') {
        await this.change(()=>{job.status='cancelled';job.phase='refused';});
        return;
      }
      if(job.trigger==='bot_command' && ['reply','draft'].includes(job.mode)) {await this.processReply(job,ticketId);return;}
      if (['ticket_assigned','assigned_roster'].includes(job.trigger)) {
        const assigned = await this.get('/tickets/'+encodeURIComponent(ticketId));
        if (!((assigned?.ticket || assigned)?.memberIds || []).includes(ANDREW_ID)) {
          await this.change(()=>{job.status='cancelled';job.phase='assignment_removed';});
          this.log(job,'note','Ticket không còn gán cho Andrew; hủy lượt check trước khi chạy',{phase:'assignment_removed'});
          return;
        }
      }
      if(job.status==='queued') {
        if (!await this.notice(job,'received') || !await this.notice(job,'checking')) return;
        await this.change(()=>{job.status='running';job.attempts++;job.runId=randomUUID();});
        const followUp=this.followUpFor(job);
        this.log(job,'start',`Lần thử ${job.attempts}/${this.config.maxAttempts} • ${job.reference}${job.subject?` • ${job.subject}`:''}${followUp?` • check tiếp theo lệnh @han: "${followUp.instruction.slice(0,160)}"`:''}`,
          {phase:'queued',payload:{attempt:job.attempts,maxAttempts:this.config.maxAttempts,runId:job.runId,trigger:job.trigger,...(followUp?{commentId:followUp.commentId,sinceAt:followUp.sinceAt}:{})}});
        const jobDir=resolve(this.root,'runtime/check-ticket/jobs',job.id,job.runId);
        const review=await this.review(job.reference,jobDir,phase=>this.change(()=>{job.phase=phase;}),{followUp});
        if(review.ticketId!==ticketId) throw new Error('Review returned a different ticket; refusing to comment.');
        const presentation = reportArtifacts(review.report || parseHanReport(review.fullReport || review.result?.comment || review.comment, review.category));
        await this.change(()=>{job.status='ready';job.comment=presentation.comment;job.report=presentation.report;job.reportVersion=HAN_REPORT_VERSION;job.commentFormatVersion=presentation.commentFormatVersion;job.category=review.category;job.artifactDir=jobDir;});
      }
      if (job.commentFormatVersion === HANDLING_COMMENT_VERSION && reviewPresentation(job,{jobs:Object.values(this.state.jobs)}).result.kind !== 'full') throw new Error('Prepared handling payload binding/hash is invalid; refusing delivery.');
      await this.change(()=>{job.comment=formatReviewComment(job.comment,job.category,{prepared:true,commentFormatVersion:job.commentFormatVersion});job.deliveryAttempts=(job.deliveryAttempts || 0)+1;});
      const existing = await this.find(ticketId,job.comment,this.commentScope(job));
      if(existing) {
        const receipt=this.handlingReceipt(job,existing);
        await this.change(()=>{if(receipt)job.deliveryReceipt=receipt;job.status='done';job.phase='already_posted';job.commentId=existing.id;job.finishedAt=new Date(this.now()).toISOString();});
        this.log(job,'note',`Comment này đã có trên Helpdesk (${existing.id}); không đăng lại`,{phase:'already_posted',payload:{commentId:existing.id}});
        return;
      }
      // Recheck ticket existence before posting a prepared review.
      const current=await this.get('/tickets/'+encodeURIComponent(ticketId));
      if((current?.ticket || current)?.deletedAt) throw new Error('Ticket was deleted; comment not posted.');
      if (['ticket_assigned','assigned_roster'].includes(job.trigger)
        && !((current?.ticket || current)?.memberIds || []).includes(ANDREW_ID)) {
        await this.change(()=>{job.status='cancelled';job.phase='assignment_removed';});
        this.log(job,'note','Ticket không còn gán cho Andrew; báo cáo đã soạn không được đăng',{phase:'assignment_removed'});
        return;
      }
      // Persist the exact formatted content before POST so uncertain
      // delivery is reconciled against what was actually sent after a restart.
      await this.change(()=>{job.comment=formatReviewComment(job.comment,job.category,{prepared:true,commentFormatVersion:job.commentFormatVersion});job.mentions=[];job.status='posting';job.phase='comment';});
      this.log(job,'tool',`Đăng comment lên Helpdesk (lần gửi ${job.deliveryAttempts}, ${job.comment.length} ký tự)`,{phase:'comment',payload:{deliveryAttempt:job.deliveryAttempts,length:job.comment.length}});
      try {
        await this.post(ticketId,job.comment,job.mentions);
        await this.reconcile(job);
      } catch(error) {
        let detail;
        await this.change(()=>{job.status='uncertain';job.lastError=error.message;detail=this.deliveryFailure(job,error);});
        this.log(job,'warning',`Chưa xác nhận được việc đăng comment: ${error.message}; sẽ đối chiếu trên Helpdesk, không tự đăng lại`,{phase:'comment',payload:{status:'uncertain',deliveryAttempt:job.deliveryAttempts,detail}});
      }
    } catch(error) {
      this.lastError=error.message;
      if(job) {
        await this.change(()=>{
          job.lastError=error.message;
          if(['posting','uncertain'].includes(job.status)) job.status='uncertain';
          else if(job.attempts>=this.config.maxAttempts || job.deliveryAttempts>=this.config.maxAttempts) {job.status='needs_attention';job.failedAt=new Date(this.now()).toISOString();}
          else {job.status=job.comment?'ready':'queued';job.nextAttemptAt=this.now()+60000*Math.max(1,job.attempts);}
        });
        const retryInMs=['queued','ready'].includes(job.status)?job.nextAttemptAt-this.now():null;
        const next=retryInMs!==null?`thử lại sau ${Math.round(retryInMs/1000)}s`:job.status==='uncertain'?'sẽ đối chiếu comment trên Helpdesk':'đã hết lượt thử, cần kiểm tra thủ công';
        this.log(job,'warning',`Lần thử ${job.attempts}/${this.config.maxAttempts} dừng ở pha ${job.phase || 'không rõ'}: ${error.message} → ${next}`,
          {phase:job.phase || null,payload:{attempt:job.attempts,maxAttempts:this.config.maxAttempts,deliveryAttempts:job.deliveryAttempts || 0,status:job.status,retryInMs,runId:job.runId || null,...(error.detail || {})}});
      }
    } finally {
      try { if(job) await this.terminalNotice(job); }
      finally { this.processing=false; }
    }
  }
  health() {
    const jobs=Object.values(this.state?.jobs || {});
    const notices=jobs.flatMap(j=>Object.values(j.telegram || {}));
    return {reportVersion:HAN_REPORT_VERSION,commentFormatVersion:HELPDESK_COMMENT_VERSION,enabled:this.config.enabled,started:this.started,queued:jobs.filter(j=>['queued','ready'].includes(j.status)).length,
      running:jobs.filter(j=>['running','posting'].includes(j.status)).length,needsAttention:jobs.filter(j=>['uncertain','needs_attention'].includes(j.status)).length,
      completed:jobs.filter(j=>j.status==='done').length,telegramNotificationsEnabled:Boolean(this.notify),
      telegramPending:notices.filter(n=>['pending','sending'].includes(n.status)).length,
      telegramNeedsAttention:notices.filter(n=>['uncertain','needs_attention'].includes(n.status)).length,
      pendingTicketEvents:Object.keys(this.state?.pendingEvents || {}).length,
      botCommands:{enabled:this.bot.enabled,keyword:this.bot.keyword,handled:Object.keys(this.state?.commands || {}).length,pendingTickets:Object.keys(this.state?.commandPending || {}).length,scanAt:this.state?.commandScanAt || '',
        draftMailFormat:CUSTOMER_MAIL_FORMAT_VERSION,ackDeliveryVersion:ACK_DELIVERY_VERSION,
        drafts:jobs.filter(j=>j.mode==='draft' && j.status==='done').length,
        replies:jobs.filter(j=>j.trigger==='bot_command' && j.mode==='reply' && j.status==='done').length,chatTemplates:this.bot.chatTemplates,ackText:CHECK_ACK,ackScope:'all_commands',keywordSinceAt:this.state?.commandKeywordSinceAt || null,
        acknowledgements:jobs.filter(j=>j.ack?.status==='sent').length,ackNeedsAttention:jobs.filter(j=>['uncertain','needs_attention'].includes(j.ack?.status)).length},
      lastScanAt:this.state?.lastScanAt || '',lastError:this.lastError};
  }
  async start() {
    if(!this.config.enabled) return this;
    await this.initialize(); this.started=true;
    console.log(`[check-ticket] Automatic review started: analysis=${this.config.analysis || 'elite'}${this.config.analysis==='hancal'?` (hancalTimeoutMs=${this.config.hancalTimeoutMs})`:''}, maxAttempts=${this.config.maxAttempts}, poll=${this.config.pollIntervalMs}ms, jobs queued=${Object.values(this.state.jobs).filter(j=>['queued','ready'].includes(j.status)).length}`);
    if(this.config.analysis==='hancal') await describeSourceApi().then(line=>console.log(`[check-ticket] ${line}`)).catch(()=>{});
    console.log(`[check-ticket] @han commands: ${this.bot.enabled?`enabled (keyword "${this.bot.keyword}", Andrew's comments only, cursor ${this.state.commandScanAt || 'now'}, ${Object.keys(this.state.commands || {}).length} handled; all-command ACK: ${CHECK_ACK}; natural replies: chat ${this.bot.chatTemplates?'templates':'model'}, question/unsure model ≤ ${this.bot.replyTimeoutMs}ms, ≤ ${this.bot.replyMaxChars} chars)`:'disabled by workflow.json'}`);
    // Weekly apps_doc catch-up (fallback copy for the Source API): starts a detached sync only when the Sunday slot was missed.
    await import('../../../scripts/apps-doc-sync-if-due.mjs').then(({ startIfDue })=>startIfDue()).then(result=>{ if(result?.started) console.log(`[check-ticket] apps_doc catch-up sync started in background (pid ${result.pid}; last sync ${result.last?.at||'none'}).`); }).catch(()=>{});
    const scan=()=>this.scan().catch(error=>{this.lastError=error.message;console.error('[check-ticket] '+error.message);});
    const process=()=>this.processOne().catch(error=>{this.lastError=error.message;console.error('[check-ticket] '+error.message);});
    this.timers.push(setInterval(scan,this.config.pollIntervalMs),setInterval(process,this.config.queueIntervalMs));
    // Optional faster "@han" detection (botCommand.pollIntervalMs): only the roster + changed-ticket comment reads, no notification scan.
    if (this.bot.enabled && this.bot.pollIntervalMs && this.bot.pollIntervalMs < this.config.pollIntervalMs) {
      const commandScan=async()=>{ if(this.scanning) return; this.scanning=true; try { const started=new Date(this.now()).toISOString(); await this.scanCommands(await this.roster(), started); } catch(error) { this.lastError=error.message; console.error('[check-ticket] @han scan: '+error.message); } finally { this.scanning=false; } };
      this.timers.push(setInterval(commandScan,this.bot.pollIntervalMs));
    }
    await scan(); void process(); return this;
  }
  stop() {for(const timer of this.timers) clearInterval(timer);this.timers=[];this.started=false;}
}

export async function startTicketReviewAutomation({notify=null,sessionStartedAt=null,resumeSession=false} = {}) {
  const config=await settings();
  // One trace.jsonl per job folder; the run id tells the attempts apart.
  const trace=job=>jobTraceEmitter(resolve(ROOT,'runtime/check-ticket/jobs',job.id),{jobId:job.id,reference:job.reference,runId:job.runId || null});
  return new TicketReviewService({config,notify,trace,sessionStartedAt,resumeSession}).start();
}
