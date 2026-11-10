// Pure rules of the follow skills (dev-fix-follow and feature-follow): slots,
// change detection, result validation and the exact text of the comments. No
// network, no file access. Every rule takes a `profile` (statuses, labels,
// comment prefixes); the default is the dev-fix-follow profile, so callers
// that predate feature-follow keep working unchanged.
import { DEV_PROFILE } from './profile.mjs';
import { formatCustomerMail } from '../../../scripts/customer-mail-format.mjs';

export { DEV_PROFILE };
export const AI_STATUSES = DEV_PROFILE.aiStatuses;
export const CONTROLLER_STATUSES = { missing_thread: 'Thiếu Slack thread' };
export const STATUS_LABELS = { ...AI_STATUSES, ...CONTROLLER_STATUSES };
export const DRAFT_KINDS = ['none', 'done', 'customer_info'];
export const CONFIDENCES = ['high', 'medium', 'low'];
export const DRAFT_PREFIX = DEV_PROFILE.draftPrefix;
export const DRAFT_STATUS = { done: 'done', customer_info: 'awaiting_customer' };
export const PROGRESS_PREFIX = DEV_PROFILE.progressPrefix;
export const COMMENT_POLICIES = ['on-change-or-daily', 'every-slot'];
export const MISSING_THREAD_KEY = 'missing-thread';

export const statusLabels = (profile = DEV_PROFILE) => ({ ...profile.aiStatuses, ...CONTROLLER_STATUSES });

export function resultSchema(profile = DEV_PROFILE) {
  return {
    type: 'object', additionalProperties: false,
    properties: {
      status: { type: 'string', enum: Object.keys(profile.aiStatuses) },
      progress: { type: 'string' },
      latestUpdate: { type: 'string' },
      latestMeaningfulAt: { type: 'string' },
      waitingFor: { type: 'string' },
      customerRequests: { type: 'array', items: { type: 'string' } },
      draftKind: { type: 'string', enum: DRAFT_KINDS },
      draftMail: { type: 'string' },
      confidence: { type: 'string', enum: CONFIDENCES },
      evidence: { type: 'string' },
    },
    required: ['status', 'progress', 'latestUpdate', 'latestMeaningfulAt', 'waitingFor', 'customerRequests', 'draftKind', 'draftMail', 'confidence', 'evidence'],
  };
}
export const RESULT_SCHEMA = resultSchema(DEV_PROFILE);

const pad = value => String(value).padStart(2, '0');

export function localParts(date, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(date).map(part => [part.type, part.value]));
  return { year: +parts.year, month: +parts.month, day: +parts.day, hour: +parts.hour, minute: +parts.minute };
}

export function localDate(value, timeZone) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const p = localParts(date, timeZone);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

export function formatLocal(value, timeZone) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const p = localParts(date, timeZone);
  return `${pad(p.hour)}:${pad(p.minute)} ${pad(p.day)}/${pad(p.month)}/${p.year}`;
}

export function parseSlots(values) {
  const minutes = (Array.isArray(values) ? values : []).map(value => {
    const match = /^(\d{1,2}):(\d{2})$/.exec(String(value).trim());
    if (!match || +match[1] > 23 || +match[2] > 59) throw new Error(`Invalid slot time: ${value}`);
    return +match[1] * 60 + +match[2];
  });
  if (!minutes.length) throw new Error('At least one slot time is required.');
  return [...new Set(minutes)].sort((a, b) => a - b);
}

// The slot a scheduled run belongs to: the latest slot at or before `now`. A
// run that starts late (the machine was asleep) still reports its own slot.
export function currentSlot(now, slots, timeZone) {
  const minutes = parseSlots(slots);
  const p = localParts(now, timeZone);
  let day = Date.UTC(p.year, p.month - 1, p.day);
  let slot = [...minutes].reverse().find(value => value <= p.hour * 60 + p.minute);
  if (slot === undefined) { day -= 86_400_000; slot = minutes.at(-1); }
  const date = new Date(day);
  const ymd = [date.getUTCFullYear(), pad(date.getUTCMonth() + 1), pad(date.getUTCDate())];
  const time = `${pad(Math.floor(slot / 60))}:${pad(slot % 60)}`;
  return { key: `${ymd.join('-')}T${time}`, date: ymd.join('-'), label: `${time} ${ymd[2]}/${ymd[1]}/${ymd[0]}`, scheduled: true };
}

export function manualSlot(now, timeZone) {
  const p = localParts(now, timeZone);
  const date = `${p.year}-${pad(p.month)}-${pad(p.day)}`;
  const time = `${pad(p.hour)}:${pad(p.minute)}`;
  return { key: `${date}T${time}-manual`, date, label: `${time} ${pad(p.day)}/${pad(p.month)}/${p.year}`, scheduled: false };
}

function fingerprint(value) {
  let hash = 2_166_136_261;
  for (const character of String(value)) {
    hash ^= character.codePointAt(0) || 0;
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(36);
}

// Changes when a message is added/edited or a reaction changes: the thread has to be read again.
export function threadKey(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const body = list.map(message => [
    message.ts, message.text,
    (message.reactions || []).map(reaction => `${reaction.name}:${reaction.count}`).sort().join(','),
    (message.assets || []).map(asset => `${asset.name}:${asset.url}`).join(','),
  ].join('\u0001')).join('\u0002');
  return `${list.at(-1)?.ts || ''}|${list.length}|${fingerprint(body)}`;
}

// The time of the message the assessment rests on, or the latest message when
// the worker did not return one of the thread's own timestamps.
export function meaningfulAt(assessment, thread) {
  const wanted = Date.parse(assessment?.latestMeaningfulAt || '');
  const match = Number.isFinite(wanted) && thread.messages.find(message => Date.parse(message.at) === wanted);
  return match ? match.at : thread.latestAt;
}

// What a progress comment reports. Reminders and chatter after the last
// meaningful message do not make it new.
export const progressKey = (status, at) => `${status}|${at}`;

const text = value => String(value ?? '').trim();

export function validateAssessment(value, profile = DEV_PROFILE) {
  if (!value || typeof value !== 'object' || !Object.hasOwn(profile.aiStatuses, value.status)
    || !DRAFT_KINDS.includes(value.draftKind) || !CONFIDENCES.includes(value.confidence)
    || ['progress', 'latestUpdate', 'latestMeaningfulAt', 'waitingFor', 'draftMail', 'evidence'].some(key => typeof value[key] !== 'string')
    || !Array.isArray(value.customerRequests) || value.customerRequests.some(item => typeof item !== 'string')
    || !value.progress.trim()) throw new Error(`Worker returned an invalid ${profile.name} assessment.`);
  return value;
}

// A draft is only kept when it matches the status it belongs to and the
// conclusion is not a guess.
export function normalizeAssessment(value, profile = DEV_PROFILE) {
  const assessment = validateAssessment(value, profile);
  const result = {
    status: assessment.status,
    progress: text(assessment.progress), latestUpdate: text(assessment.latestUpdate), latestMeaningfulAt: text(assessment.latestMeaningfulAt), waitingFor: text(assessment.waitingFor),
    customerRequests: assessment.customerRequests.map(text).filter(Boolean),
    draftKind: assessment.draftKind, draftMail: text(assessment.draftMail),
    confidence: assessment.confidence, evidence: text(assessment.evidence),
    draftWithheld: '',
  };
  const expected = Object.entries(DRAFT_STATUS).find(([, status]) => status === result.status)?.[0] || 'none';
  if (expected === 'none') { result.draftKind = 'none'; result.draftMail = ''; return result; }
  if (result.confidence === 'low') result.draftWithheld = 'low_confidence';
  else if (result.draftKind !== expected || !result.draftMail) result.draftWithheld = 'missing_draft';
  result.draftKind = result.draftWithheld ? 'none' : expected;
  if (result.draftWithheld) result.draftMail = '';
  return result;
}

const FORBIDDEN = [
  [/\b(?:TS[\s_-]*)?Elite(?:[\s_-]*2)?\b/i, 'the analysis provider'],
  [/\bHachimi\b/i, 'Hachimi'],
  [/Hoàng\s+Thượng/i, 'the user title'],
];
export function assertCommentIsClean(content) {
  const prose = String(content).replace(/```[\s\S]*?```/g, '');
  for (const [pattern, label] of FORBIDDEN) if (pattern.test(prose)) throw new Error(`Ticket comment must not mention ${label}.`);
}

const byTime = (left, right) => String(left.createdAt || '').localeCompare(String(right.createdAt || ''));
const latestWithPrefix = (comments, prefix) => (Array.isArray(comments) ? comments : [])
  .filter(comment => String(comment.content || '').trimStart().startsWith(prefix)).sort(byTime).at(-1) || null;
export const latestDraft = (comments, kind, profile = DEV_PROFILE) => latestWithPrefix(comments, profile.draftPrefix[kind]);
export const lastProgressComment = (comments, profile = DEV_PROFILE) => latestWithPrefix(comments, profile.progressPrefix);

// post | exists | withheld | none. A draft is written only for a thread that
// changed since the last assessment (or whose previous attempt failed), and
// never when a draft of that kind was saved after the latest Slack message.
export function decideDraft({ assessment, comments, latestSlackAt, assessed, pendingKind = '', profile = DEV_PROFILE }) {
  if (assessment.draftWithheld) return { kind: Object.keys(DRAFT_STATUS).find(kind => DRAFT_STATUS[kind] === assessment.status), action: 'withheld', reason: assessment.draftWithheld };
  const kind = assessment.draftKind;
  if (kind === 'none') return { kind, action: 'none' };
  const existing = latestDraft(comments, kind, profile);
  const latest = Date.parse(latestSlackAt || '');
  if (existing && (!Number.isFinite(latest) || Date.parse(existing.createdAt) >= latest)) return { kind, action: 'exists' };
  if (!assessed && pendingKind !== kind) return { kind, action: 'none' };
  return { kind, action: 'post' };
}

export function formatDraftComment(kind, latestSlackAt, mail, profile = DEV_PROFILE, appName) {
  if (!profile.draftPrefix[kind]) throw new Error('Unknown draft kind.');
  const formattedMail = formatCustomerMail(mail, appName);
  const content = `${profile.draftPrefix[kind]} | ${profile.draftContextLabel || 'Slack update'}: ${latestSlackAt || 'chưa rõ'}]\n\n${formattedMail}`;
  if (!text(mail) || content.length > 15_000) throw new Error('Draft mail is empty or too long.');
  assertCommentIsClean(content);
  return content;
}

export function decideProgress({ policy, slot, comments, postedKey, postedSlot, key, draftPosted, timeZone, profile = DEV_PROFILE }) {
  const changed = postedKey !== key;
  if (postedSlot === slot.key && !changed && !draftPosted) return { post: false, changed, reason: 'already_posted_this_slot' };
  if (policy === 'every-slot' || changed || draftPosted) return { post: true, changed, reason: changed ? 'changed' : draftPosted ? 'draft' : 'every_slot' };
  const last = lastProgressComment(comments, profile);
  if (!last || localDate(last.createdAt, timeZone) !== slot.date) return { post: true, changed, reason: 'daily' };
  return { post: false, changed, reason: 'unchanged_today' };
}

const DRAFT_NOTES = {
  post: 'Đã lưu mail nháp báo khách ở comment ngay trước comment này.',
  exists: 'Mail nháp báo khách đã có sẵn trong ticket nên không lưu thêm.',
  failed: 'Chưa lưu được mail nháp báo khách, cần soạn tay hoặc chờ lượt quét sau.',
  low_confidence: 'Chưa soạn mail nháp vì kết luận chưa đủ chắc chắn, cần xem lại thread.',
  missing_draft: 'Chưa soạn được mail nháp cho trạng thái này, cần soạn tay.',
};

export function formatProgressComment({ slot, status, assessment, latestSlackAt, changed, draft, timeZone, profile = DEV_PROFILE }) {
  const label = statusLabels(profile)[status];
  if (!label) throw new Error(`Unknown ${profile.name} status.`);
  const lines = [`${profile.progressPrefix} ${slot.label}] ${label}`, ''];
  if (status === 'missing_thread') {
    lines.push(`Ticket đang ở ${profile.tsStatusLabel} nhưng chưa có link Slack thread nên chưa theo dõi được tiến độ.`);
  } else {
    if (!changed) lines.push('Thread Slack chưa có cập nhật mới kể từ lần kiểm tra trước.');
    lines.push(assessment.progress);
    const at = formatLocal(latestSlackAt, timeZone);
    if (assessment.latestUpdate) lines.push('', `${at ? `Slack cập nhật gần nhất lúc ${at}` : 'Slack cập nhật gần nhất'}: ${assessment.latestUpdate}`);
    if (assessment.waitingFor) lines.push(`Đang chờ: ${assessment.waitingFor}`);
    if (assessment.customerRequests.length) lines.push('', profile.customerRequestsTitle, ...assessment.customerRequests.map(item => `- ${item}`));
    if (assessment.confidence === 'low' && draft?.reason !== 'low_confidence') lines.push('', 'Kết luận này chưa chắc chắn, cần xem lại thread.');
    const note = DRAFT_NOTES[draft?.action === 'withheld' ? draft.reason : draft?.action];
    if (note) lines.push('', note);
  }
  const content = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  if (content.length > 6_000) throw new Error('Progress comment is too long.');
  assertCommentIsClean(content);
  return content;
}

export const ticketLink = reference => `https://helpdesk.avada.net/t/${encodeURIComponent(reference)}`;

// Telegram summary of one run: tickets with news first, the rest as a count.
export function summaryText(run, profile = DEV_PROFILE) {
  const labels = statusLabels(profile);
  const results = run.results || [];
  const drafts = results.filter(item => item.draft?.action === 'post');
  const changed = results.filter(item => item.progress?.changed && item.progress?.action === 'post');
  const failed = results.filter(item => item.error);
  const notable = results.filter(item => !item.error && (item.draft?.action === 'post' || item.draft?.action === 'failed' || (item.progress?.changed && item.progress?.action === 'post')));
  const lines = [
    `${profile.telegramTitle} (${run.slot.label})`,
    `Đã quét ${results.length} ticket: ${changed.length} có cập nhật mới, ${drafts.length} mail nháp đã lưu${failed.length ? `, ${failed.length} lỗi` : ''}.`,
  ];
  for (const item of notable) {
    const notes = [labels[item.status] || item.status,
      item.draft?.action === 'post' ? 'đã lưu mail nháp' : item.draft?.action === 'failed' ? 'chưa lưu được mail nháp' : ''].filter(Boolean).join(' · ');
    lines.push('', `• ${item.reference} — ${notes}`, String(item.subject || '').slice(0, 120), ticketLink(item.reference));
  }
  if (failed.length) lines.push('', 'Chưa xử lý được:', ...failed.map(item => `• ${item.reference}: ${String(item.error).slice(0, 200)}`));
  return lines.filter((line, index, list) => line !== '' || list[index - 1] !== '').join('\n');
}
