import { jobCommandKeyword } from './bot-command.mjs';
import { assertReportHasNoProviderName } from './core.mjs';

// Keep the exact report text, including CSS and handoff, across Telegram parts.
export function splitTelegramText(text, limit = 3800) {
  const parts = [];
  while (text.length > limit) {
    let end = limit;
    if (/[\uD800-\uDBFF]/.test(text[end - 1])) end--;
    parts.push(text.slice(0, end));
    text = text.slice(end);
  }
  if (text) parts.push(text);
  return parts;
}

export function reviewNoticeText(job, event) {
  const link = `https://helpdesk.avada.net/tickets/${encodeURIComponent(job.reference)}`;
  if (job.trigger === 'bot_command') return commandNoticeText(job, event, link);
  if (event === 'received') return [
    `📥 Đã nhận ticket ${job.reference}`,
    String(job.subject || '').slice(0, 1500), link,
  ].filter(Boolean).join('\n');
  if (event === 'checking') return `🔎 Hachimi đang checking ticket ${job.reference}\n${link}`;
  if (event === 'completed') {
    if (job.status !== 'done' || !job.commentId || !job.comment) throw new Error('Cannot announce an unconfirmed report.');
    assertReportHasNoProviderName(job.comment);
    return `✅ Hachimi đã check xong ticket ${job.reference}\nĐã đăng báo cáo lên ticket.\n${link}\n\nKết quả check ticket (báo cáo đã đăng):\n\n${job.comment}`;
  }
  if (event === 'failed') return `⚠️ Hachimi chưa hoàn tất check ticket ${job.reference}\nChưa xác nhận đăng báo cáo thành công; cần kiểm tra lại luồng xử lý.\n${link}`;
  throw new Error('Unknown review notification.');
}

// Notices of a "@bot" follow-up (13/10/2026): same four milestones as an automatic review, plus `refused` when the
// instruction needs a write, and `replied`/`reply_failed` (14/10/2026) for the natural-reply branch (chat/question).
// instruction asked for something outside the read-only workflow (Telegram only; nothing is posted on the ticket).
function commandNoticeText(job, event, link) {
  const keyword = jobCommandKeyword(job);
  const instruction = String(job.command?.instruction || '').slice(0, 1000);
  if (event === 'drafted') {
    if (job.status !== 'done' || !job.commentId || !job.comment?.startsWith('[DRAFT')) throw new Error('Cannot announce an unconfirmed draft.');
    return `📝 Đã lưu mail nháp theo ${keyword} trên ticket ${job.reference}; chưa gửi email cho khách.\n${link}`;
  }
  if (event === 'draft_failed') return `⚠️ Chưa lưu được mail nháp theo ${keyword} trên ticket ${job.reference}; giữ ACK đã có, cần kiểm tra artifact/trạng thái. Chưa gửi email cho khách.\n${link}`;
  if (['failed','reply_failed'].includes(event) && job.phase === 'ack') return `⚠️ Chưa xác nhận ACK cho lệnh ${keyword} trên ticket ${job.reference}. Không chạy yêu cầu; cần đối soát comment trước khi xử lý tiếp.\n${link}`;
  if (event === 'received') return [`📥 Đã nhận lệnh ${keyword} trên ticket ${job.reference}`, instruction ? `Chỉ thị: ${instruction}` : '', String(job.subject || '').slice(0, 300), link].filter(Boolean).join('\n');
  if (event === 'checking') return `🔎 Hachimi đang check tiếp ticket ${job.reference} theo lệnh ${keyword}\n${link}`;
  if (event === 'completed') {
    if (job.status !== 'done' || !job.commentId || !job.comment) throw new Error('Cannot announce an unconfirmed report.');
    assertReportHasNoProviderName(job.comment);
    return `✅ Hachimi đã check tiếp xong ticket ${job.reference}\nĐã đăng báo cáo lên ticket.\n${link}\n\nKết quả check tiếp (báo cáo đã đăng):\n\n${job.comment}`;
  }
  if (event === 'failed') return `⚠️ Hachimi chưa hoàn tất check tiếp ticket ${job.reference} theo lệnh ${keyword}\nChưa xác nhận đăng báo cáo thành công; cần kiểm tra lại luồng xử lý.\n${link}`;
  if (event === 'refused') {
    const reasons = (job.command?.reasons || []).join('; ') || 'ngoài phạm vi chỉ đọc';
    return `⛔ Lệnh ${keyword} trên ticket ${job.reference} bị từ chối: ${reasons}.\nLệnh bị từ chối sau bước xác nhận; không đổi status, không tick Done, không nhắn khách, không xóa, không sửa theme/setting.\n${instruction ? `Chỉ thị: ${instruction}\n` : ''}${link}`;
  }
  // Natural reply (14/10/2026): one 💬 line after the comment is confirmed, or one ⚠️ line when no reply could be posted.
  if (event === 'replied') {
    if (job.status !== 'done' || !job.commentId || !job.comment) throw new Error('Cannot announce an unconfirmed reply.');
    assertReportHasNoProviderName(job.comment);
    const body = String(job.comment).replace(/\s+/g, ' ').trim();
    return `💬 Đã trả lời ${keyword} trên ticket ${job.reference} ("${instruction.slice(0, 120)}"): ${body.length > 300 ? `${body.slice(0, 300)}…` : body}\n${link}`;
  }
  if (event === 'reply_failed') return `⚠️ Chưa trả lời được ${keyword} trên ticket ${job.reference} ("${instruction.slice(0, 120)}"): ${String(job.lastError || 'không rõ lý do').slice(0, 300)}. ${job.ack ? 'Không đăng câu trả lời; ACK đã gửi được giữ lại nếu có.' : 'Không đăng gì lên ticket.'}\n${link}`;
  throw new Error('Unknown review notification.');
}
