import { appendFile, mkdir, open } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const widgetLogPath = fileURLToPath(new URL('../runtime/check-ticket/widget-chat.jsonl', import.meta.url));
const kinds = new Set(['start', 'phase', 'waiting', 'text', 'done', 'error', 'cancelled']);
export async function appendWidgetEvents(events, path = widgetLogPath) {
  if (!Array.isArray(events) || !events.length || events.length > 20) throw new Error('Invalid widget log batch.');
  const records = events.map(event => {
    if (!event || !/^[a-zA-Z0-9_-]{1,100}$/.test(event.id) || !kinds.has(event.kind)
      || typeof event.text !== 'string' || event.text.length > 12000) throw new Error('Invalid widget log event.');
    // Store only the explicit progress payload, never tokens, request headers or context objects.
    const chatId = typeof event.chatId === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(event.chatId) ? event.chatId : undefined;
    return { at: new Date().toISOString(), id: event.id, kind: event.kind, text: event.text, ...(chatId ? { chatId } : {}) };
  });
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await appendFile(path, records.map(record => JSON.stringify(record) + '\n').join(''), { mode: 0o600 });
}

export class WidgetLogTail {
  constructor(path = widgetLogPath) { this.path = path; this.offset = null; this.inode = null; this.buffer = ''; }
  async poll(consume) {
    let file;
    try { file = await open(this.path, 'r'); }
    catch (error) { if (error.code === 'ENOENT') { this.offset = 0; return; } throw error; }
    try {
      const info = await file.stat();
      if (this.offset === null) this.offset = info.size; // Follow new activity, do not replay old chats.
      if ((this.inode !== null && this.inode !== info.ino) || info.size < this.offset) { this.offset = 0; this.buffer = ''; }
      this.inode = info.ino;
      if (info.size <= this.offset) return;
      // Read full batches without splitting UTF-8: retain undecoded bytes between polls.
      const bytes = Buffer.alloc(Math.min(info.size - this.offset, 1024 * 1024));
      const { bytesRead } = await file.read(bytes, 0, bytes.length, this.offset);
      this.offset += bytesRead;
      const pending = Buffer.concat([Buffer.isBuffer(this.buffer) ? this.buffer : Buffer.alloc(0), bytes.subarray(0, bytesRead)]);
      let from = 0;
      for (let end = pending.indexOf(10); end !== -1; end = pending.indexOf(10, from)) {
        try { const event = JSON.parse(pending.subarray(from, end).toString('utf8')); if (kinds.has(event.kind)) consume(event); } catch {}
        from = end + 1;
      }
      this.buffer = pending.subarray(from);
    } finally { await file.close(); }
  }
}
