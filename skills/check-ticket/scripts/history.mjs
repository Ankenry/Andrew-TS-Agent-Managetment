import { jobCommandKeyword } from './bot-command.mjs';
import { canonicalReview } from './canonical-review.mjs';
// Read-only view of automatic ticket reviews as chat-bot conversations, so the extension and the
// TS Management web can list them in "Conversation history" next to manual chats.
// It only reads the controller state and saved artifacts: it never starts a review or posts a comment.
import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const STATE_PATH = resolve(ROOT, 'runtime/check-ticket/state.json');

export const AUTOMATIC_CHAT_PREFIX = 'auto-';
export const AUTOMATIC_HISTORY_LIMIT = 30;
// Same retention as the tracing web, so the Tracing button of a listed review always has data.
export const AUTOMATIC_HISTORY_DAYS = 10;
const MAX_TEXT = 20000;
const SAFE_ID = /^[A-Za-z0-9_-]{1,100}$/;
const STATUS = { queued:'running', running:'running', ready:'running', posting:'running', done:'done', uncertain:'uncertain', needs_attention:'failed' };

export const automaticChatId = jobId => AUTOMATIC_CHAT_PREFIX + jobId;
const clip = value => { const text = String(value || '').trim(); return text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) + '\n\n…' : text; };
const time = (value, fallback) => { const ms = typeof value === 'number' ? value : Date.parse(value || ''); return Number.isFinite(ms) ? ms : fallback; };

function outcome(job, status) {
  const reference = job.reference;
  const keyword = jobCommandKeyword(job);
  const report = clip(job.comment);
  if (job.trigger === 'bot_command' && job.mode === 'draft') {
    if (status === 'done') return `Đã lưu mail nháp trên ticket ${reference}; chưa gửi email cho khách.\n\n${report}`;
    if (status === 'uncertain') return `Chưa xác nhận comment mail nháp trên ticket ${reference}; không tự đăng lại. Chưa gửi email cho khách.`;
    if (status === 'failed') return `Chưa hoàn tất mail nháp trên ticket ${reference}; cần kiểm tra lại. Chưa gửi email cho khách.`;
    return `Đang chuẩn bị mail nháp cho ticket ${reference}; chưa gửi email cho khách.`;
  }
  // Natural reply to a "@bot" chat/question (14/10/2026): the assistant turn is the reply itself, no "check" verb.
  if (job.trigger === 'bot_command' && job.mode === 'reply') {
    if (status === 'done') return report;
    if (status === 'uncertain') return `Đã soạn trả lời cho ${keyword} trên ticket ${reference} nhưng chưa xác nhận được comment trên Helpdesk.${report ? `\n\n${report}` : ''}`;
    if (status === 'failed') return `Chưa trả lời được ${keyword} trên ticket ${reference}: ${clip(job.lastError) || 'cần kiểm tra lại'}`;
    if (report) return `Đang đăng trả lời lên ticket ${reference}:\n\n${report}`;
    return `Đang soạn trả lời cho ${keyword} trên ticket ${reference}…`;
  }
  // A "@bot" follow-up (trigger bot_command, 13/10/2026) reads "check tiếp" so the list tells it from the first review.
  const verb = job.trigger === 'bot_command' ? 'check tiếp' : 'check';
  if (status === 'done') return `Hachimi đã ${verb} xong ticket ${reference} và đã comment lên Helpdesk:\n\n${report}`;
  if (status === 'uncertain') return `Hachimi đã ${verb} xong ticket ${reference} nhưng chưa xác nhận được comment trên Helpdesk.${report ? `\n\n${report}` : ''}`;
  if (status === 'failed') return `Hachimi chưa ${verb} xong ticket ${reference}: ${clip(job.lastError) || 'cần kiểm tra lại'}${report ? `\n\nReport đã chuẩn bị:\n\n${report}` : ''}`;
  if (report) return `Hachimi đã ${verb} xong ticket ${reference}, đang gửi comment lên Helpdesk:\n\n${report}`;
  return job.trigger === 'bot_command' ? `Hachimi đang check tiếp ticket ${reference} theo lệnh ${keyword}…` : `Hachimi đang checking ticket ${reference}…`;
}

// The user turn of the conversation: the automatic "Check ticket <url>" or, for a "@bot" command, the comment itself.
function requestText(job) {
  const url = `https://helpdesk.avada.net/tickets/${job.reference}`;
  if (job.trigger === 'bot_command') return `${jobCommandKeyword(job)} ${String(job.command?.instruction || 'check tiếp').slice(0, 1500)} · ticket ${url}`;
  return `Check ticket ${url}`;
}

// `analysis` is the initial answer saved by the run (analysis.txt for the Hancal flow, elite.txt for the former one); `analysisAt` its save time.
export function conversationFromJob(job, { analysis = '', analysisAt = 0, jobs = [] } = {}) {
  if (!STATUS[job?.status] || !SAFE_ID.test(String(job.id || '')) || !SAFE_ID.test(String(job.reference || ''))) return null;
  const review = !job?.mode || job.mode === 'review';
  const canonical = review ? canonicalReview(job, { jobs }) : null;
  const status = review && job.status === 'done' && !canonical.delivery.confirmed ? 'uncertain' : STATUS[job?.status];
  const createdAt = time(job.createdAt, Date.now());
  const finishedAt = time(job.finishedAt, 0);
  // File times are only trusted between the job's own start and finish.
  const analysedAt = Math.min(Math.max(analysisAt || 0, createdAt), finishedAt || Infinity);
  const updatedAt = Math.max(createdAt, finishedAt, !review && clip(analysis) ? analysedAt : 0);
  const messages = [{ role:'user', text:requestText(job), timestamp:createdAt, auto:true }];
  if (review) {
    messages.push({ role:'assistant', text:[canonical.statusLabel, canonical.canonical.notice].filter(Boolean).join('\n'), timestamp:updatedAt, auto:true, delivery:true });
    if (canonical.comment !== null) messages.push({ role:'assistant', text:canonical.comment, timestamp:updatedAt, auto:true, canonical:true });
  } else {
    if (clip(analysis)) messages.push({ role:'assistant', text:clip(analysis), timestamp:analysedAt, auto:true });
    messages.push({ role:'assistant', text:outcome(job, status), timestamp:updatedAt, auto:true });
  }
  const revision = createHash('sha1').update(JSON.stringify([status, job.category || '', canonical?.canonical, messages.map(message => message.text)])).digest('hex').slice(0, 16);
  return {
    chatId:automaticChatId(job.id), origin:'automatic',
    selectedTicket:{ id:job.ticketId || job.id, ticketId:job.reference, subject:String(job.subject || '') },
    automatic:{ jobId:job.id, status, category:job.category || '', trigger:job.trigger || '', revision,
      ...(canonical ? { runId:job.runId || '', canonical:canonical.canonical, delivery:canonical.delivery, statusLabel:canonical.statusLabel } : {}),
      ...(job.trigger === 'bot_command' ? { instruction:String(job.command?.instruction || '').slice(0, 500), mode:job.mode || 'review', kind:job.command?.kind || '' } : {}) },
    messages, createdAt, updatedAt,
  };
}

async function savedAnalysis(root, job) {
  if (!SAFE_ID.test(String(job.id || '')) || !SAFE_ID.test(String(job.runId || ''))) return {};
  const jobs = resolve(root, 'runtime/check-ticket/jobs');
  for (const name of ['analysis.txt', 'elite.txt']) {
    const file = resolve(jobs, job.id, job.runId, name);
    if (!file.startsWith(jobs + sep)) return {};
    try { return { analysis:await readFile(file, 'utf8'), analysisAt:Math.round((await stat(file)).mtimeMs) }; }
    catch { /* try the next name */ }
  }
  return {};
}

export async function automaticConversations({ root = ROOT, statePath = root === ROOT ? STATE_PATH : resolve(root, 'runtime/check-ticket/state.json'),
  now = Date.now(), days = AUTOMATIC_HISTORY_DAYS, limit = AUTOMATIC_HISTORY_LIMIT } = {}) {
  let state;
  try { state = JSON.parse(await readFile(statePath, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const cutoff = now - days * 86400000;
  const recent = Object.values(state?.jobs || {})
    .filter(job => STATUS[job?.status] && time(job.createdAt, 0) >= cutoff)
    .sort((left, right) => Math.max(time(right.finishedAt, 0), time(right.createdAt, 0)) - Math.max(time(left.finishedAt, 0), time(left.createdAt, 0)))
    .slice(0, limit);
  const conversations = [];
  for (const job of recent) {
    const review = !job.mode || job.mode === 'review';
    const conversation = conversationFromJob(job, { ...(!review ? await savedAnalysis(root, job) : {}), jobs:Object.values(state.jobs || {}) });
    if (conversation) conversations.push(conversation);
  }
  return conversations.sort((left, right) => right.updatedAt - left.updatedAt);
}

// `digest` changes whenever any listed review changes.
export async function automaticHistory(options = {}) {
  const conversations = await automaticConversations(options);
  const digest = createHash('sha1').update(conversations.map(item => `${item.chatId}:${item.automatic.revision}`).join('|')).digest('hex').slice(0, 16);
  return { digest, conversations };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { digest, conversations } = await automaticHistory();
  console.log(JSON.stringify({ digest, total:conversations.length,
    conversations:conversations.map(item => ({ chatId:item.chatId, ticket:item.selectedTicket.ticketId, status:item.automatic.status, category:item.automatic.category, messages:item.messages.length, updatedAt:new Date(item.updatedAt).toISOString() })) }, null, 2));
}
