#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { WidgetLogTail } from './widget-chat-log.mjs';

const statePath = fileURLToPath(new URL('../runtime/check-ticket/state.json', import.meta.url));
// Ticket text is untrusted: never let it send escape sequences to the terminal.
export const safeText = value => String(value ?? '').replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
  .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
const time = value => value ? new Date(value).toLocaleString('vi-VN', { timeZone: 'Asia/Bangkok' }) : 'chưa có';
const statuses = { queued: 'Đã nhận, chờ check', running: 'Đang checking ticket', ready: 'Đã có bản nháp, chờ đăng',
  posting: 'Đang đăng comment', uncertain: 'Chưa xác nhận được comment', needs_attention: 'Cần xử lý lỗi',
  cancelled: 'Đã hủy', done: 'Đã check xong, comment đã được xác nhận' };

export class TerminalMonitor {
  constructor(write = line => console.log(safeText(line))) {
    this.write = write; this.previous = null; this.healthSignature = ''; this.readError = '';
  }
  health(health) {
    const workflow = health?.ticketReviewWorkflow;
    const summary = !health?.ok ? 'Không kết nối được dịch vụ check-ticket.'
      : !workflow?.enabled || !workflow?.started ? 'Dịch vụ đang phản hồi nhưng tự động check-ticket chưa chạy.'
      : `Luồng check-ticket đang bật | comment: ${health.automaticTicketComments ? 'bật' : 'tắt'} | chờ: ${workflow.queued} | đang check: ${workflow.running} | cần xử lý: ${workflow.needsAttention}`;
    const detail = workflow ? ` | Telegram chờ/lỗi: ${workflow.telegramPending}/${workflow.telegramNeedsAttention}` : '';
    const error = workflow?.lastError ? `\nLỗi dịch vụ: ${workflow.lastError}` : '';
    const signature = summary + detail + error;
    if (signature !== this.healthSignature) {
      this.write(`[${time(Date.now())}] ${signature}`); this.healthSignature = signature;
    }
  }
  state(state) {
    if (!state || state.version !== 1 || !state.jobs || typeof state.jobs !== 'object') throw new Error('Định dạng state không hợp lệ');
    const first = !this.previous;
    if (first || state.lastScanAt !== this.previous.lastScanAt) {
      this.write(`[Quét] ${time(state.lastScanAt)} | sự kiện đang chờ: ${Object.keys(state.pendingEvents || {}).length}`);
    }
    if (first && Date.now() - Date.parse(state.lastScanAt) > 10 * 60 * 1000) this.write('Lượt quét đã quá 10 phút chưa cập nhật.');
    const jobs = Object.values(state.jobs);
    const latest = jobs.filter(j => j.status === 'done').sort((a, b) => (b.finishedAt || '').localeCompare(a.finishedAt || ''))[0];
    for (const job of jobs) {
      const old = this.previous?.jobs?.[job.id];
      if (first && ['done', 'cancelled'].includes(job.status) && job !== latest) continue;
      if (JSON.stringify([old?.status, old?.phase, old?.lastError]) !== JSON.stringify([job.status, job.phase, job.lastError])) {
        this.write(`\n[${job.reference || job.id}] ${statuses[job.status] || job.status}${job.phase ? ` | ${job.phase}` : ''}${first ? ' (trạng thái đã lưu)' : ''}`);
        if (job.subject) this.write(job.subject);
        if (job.lastError) this.write(`Lỗi: ${job.lastError}`);
      }
      if (job.status === 'done' && old?.status !== 'done') {
        this.write(`Hoàn tất: ${time(job.finishedAt)} | comment: ${job.commentId || 'không có ID trong state'}`);
        this.write(job.comment || 'Không có nội dung kết quả trong state.');
        this.write('── Hết kết quả ──');
      }
      const notices = Object.entries(job.telegram || {}).map(([name, n]) => `${name}: ${n.status}${n.lastError ? ` (${n.lastError})` : ''}`).join(' | ');
      if (notices && JSON.stringify(old?.telegram) !== JSON.stringify(job.telegram)) this.write(`[Telegram ${job.reference || job.id}] ${notices}`);
    }
    const pending = JSON.stringify(state.pendingEvents || {});
    if (pending !== JSON.stringify(this.previous?.pendingEvents || {})) {
      for (const item of Object.values(state.pendingEvents || {})) this.write(`[Sự kiện chờ] ${item.event?.metadata?.ticketId || item.event?.id || ''}: ${item.lastError || ''}`);
    }
    this.previous = state;
  }
}

async function main() {
  const once = process.argv.includes('--once');
  const monitor = new TerminalMonitor();
  const widgetTail = new WidgetLogTail();
  const widgetEvent = event => monitor.write(`[Widget ${event.id} • ${event.kind} • ${time(event.at)}]\n${event.text}`);
  await widgetTail.poll(widgetEvent).catch(() => {});
  monitor.write('CHECK-TICKET • log trực tiếp và toàn bộ kết quả comment đã xác nhận');
  monitor.write('Ctrl+C: về dòng lệnh. Dịch vụ check-ticket tiếp tục chạy độc lập.');
  monitor.write('Đang theo dõi thêm tiến độ và câu trả lời mới từ chatbot widget.');
  let stopping = false; let wake;
  const stop = () => { stopping = true; wake?.(); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop); process.on('SIGHUP', stop);
  let nextHealth = 0;
  while (!stopping) {
    await widgetTail.poll(widgetEvent).catch(() => monitor.write('Chưa đọc được log widget.'));
    if (Date.now() >= nextHealth) {
      try {
        const response = await fetch('http://127.0.0.1:39541/health', { headers: { 'X-TS-Management-Widget-Bridge': '1' }, signal: AbortSignal.timeout(2000) });
        monitor.health(response.ok ? await response.json() : null);
      } catch { monitor.health(null); }
      nextHealth = Date.now() + 15000;
    }
    try {
      monitor.state(JSON.parse(await readFile(statePath, 'utf8')));
      if (monitor.readError) monitor.write('Đã đọc lại được dữ liệu check-ticket.');
      monitor.readError = '';
    } catch (error) {
      const message = error.code === 'ENOENT' ? 'Chưa có file trạng thái check-ticket.' : 'Chưa đọc được trạng thái check-ticket; sẽ thử lại.';
      if (monitor.readError !== message) monitor.write(message);
      monitor.readError = message;
    }
    if (once || stopping) break;
    await new Promise(done => { const timer = setTimeout(done, 2000); wake = () => { clearTimeout(timer); done(); }; });
    wake = null;
  }
  process.off('SIGINT', stop); process.off('SIGTERM', stop); process.off('SIGHUP', stop);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
