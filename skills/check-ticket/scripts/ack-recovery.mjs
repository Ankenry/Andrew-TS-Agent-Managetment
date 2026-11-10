import { ANDREW_ID } from './handoff.mjs';
import { parseBotCommand } from './bot-command.mjs';

export const ACK_DELIVERY_VERSION = 'receipt-scoped-recovery-v1';
export const ackHasIntent = ack => Boolean(ack && (ack.startedAt || ack.receiptId || ack.commentId || ['posting','uncertain','sent'].includes(ack.status)));
export function ackReceiptId(response, ticketId = null) {
  // Helpdesk can return the updated TICKET, not the comment. Its id is never an ACK receipt.
  const id = response?.commentId || response?.actionId || response?.comment?.id || response?.action?.id
    || (!response?.ticketId && !Object.hasOwn(response || {}, 'subject') ? response?.id : null);
  return typeof id === 'string' && id !== ticketId && /^[a-zA-Z0-9_-]+$/.test(id) ? id : null;
}
export function assertAckCommand(job, actions) {
  const command = actions.find(a => a.id === job.command?.commentId);
  if (!command || command.author?.memberId !== ANDREW_ID) throw new Error('ACK command disappeared or author changed; no POST attempted.');
  const parsed = parseBotCommand(String(command.metadata?.content ?? command.content ?? ''));
  if (!parsed || parsed.instruction !== job.command.instruction) throw new Error('ACK command changed; no POST attempted.');
  return command;
}
export function isolatedAckFor(other, target) {
  return target.ack?.requireReceiptId === true && (other.ack?.isolatedFor || []).some(item =>
    item.targetJobId === target.id && item.approval && item.reason && item.at);
}

// Operator-only recovery. Never called by scans/startup. Caller must hold the stopped-controller boundary.
// All validation precedes mutations; old jobs/receipts/errors and global cursors/dedup remain intact.
export function recoverAckDraft(state, { targetJobId, historicalJobIds, actions, approval, reason, now }) {
  if (!approval || !reason || !Number.isFinite(Date.parse(now))) throw new Error('Explicit recovery approval, reason and timestamp required.');
  const target = state.jobs[targetJobId];
  if (!target || target.trigger !== 'bot_command' || target.mode !== 'draft' || target.command?.kind !== 'draft'
    || target.status !== 'needs_attention' || target.phase !== 'ack' || target.ack?.status !== 'needs_attention'
    || target.attempts || target.deliveryAttempts || target.comment || target.commentId || ackHasIntent(target.ack)
    || target.ackRecovery) throw new Error('Recovery target is not a never-posted draft blocked at ACK.');
  if (!Array.isArray(actions)) throw new Error('Complete current comments required.');
  assertAckCommand(target, actions);
  if (actions.some(a => String(a.metadata?.content ?? a.content ?? '').includes(`Command: ${target.command.commentId}]`)))
    throw new Error('Target draft already exists; refusing recovery.');
  const history = [...new Set(historicalJobIds)].map(id => state.jobs[id]);
  if (history.length !== historicalJobIds.length || history.some(j => !j || j.id === targetJobId
    || j.ticketId !== target.ticketId || j.trigger !== 'bot_command' || j.status !== 'needs_attention'
    || j.phase !== 'ack' || j.ack?.status !== 'needs_attention' || j.attempts || j.comment || j.commentId))
    throw new Error('Historical isolation scope is invalid.');
  const blockers = Object.values(state.jobs).filter(j => j.id !== target.id && j.ticketId === target.ticketId
    && ackHasIntent(j.ack) && ['posting','uncertain','needs_attention'].includes(j.ack?.status));
  if (blockers.some(j => !historicalJobIds.includes(j.id))) throw new Error('Another unresolved ACK is outside approved recovery scope.');
  const audit = {at:now,approval,reason,targetJobId,historicalJobIds:[...historicalJobIds],
    commandVerified:{id:target.command.commentId,authorId:ANDREW_ID},
    before:{status:target.status,phase:target.phase,ack:structuredClone(target.ack),nextAttemptAt:target.nextAttemptAt,
      lastError:target.lastError,failedAt:target.failedAt},
    history:history.map(j=>({id:j.id,commandPresent:actions.some(a=>a.id===j.command.commentId),ack:structuredClone(j.ack)}))};
  for (const old of history) {
    old.ack.isolatedFor ||= [];
    old.ack.isolatedFor.push({targetJobId,at:now,approval,reason});
  }
  target.ackRecovery = audit;
  target.ack = {status:'pending',content:target.ack.content,attempts:0,requireReceiptId:true};
  target.status = 'queued';target.phase='ack_recovery';target.nextAttemptAt=0;
  return audit;
}
