// Progress only: this logger cannot start AI requests or write ticket comments.
globalThis.WidgetTerminalTrace = class WidgetTerminalTrace {
  constructor(reference = '', chatId = '') {
    this.id = crypto.randomUUID(); this.queue = []; this.closed = false;
    // Conversation id only (no message content): lets the tracing web group every turn of one chat.
    this.chatId = /^[a-zA-Z0-9_-]{1,100}$/.test(String(chatId || '')) ? String(chatId) : '';
    this.answer = ''; this.phaseName = 'Đang gửi yêu cầu'; this.sending = null;
    this.emit('start', `Widget chat${reference ? ` • ${reference}` : ''}`);
    this.flushTimer = setInterval(() => { void this.flush(); }, 750);
    this.heartbeat = setInterval(() => this.emit('waiting', `${this.phaseName} — vẫn đang chờ phản hồi`), 15000);
  }
  emit(kind, text = '') {
    if (this.closed) return;
    text = String(text);
    const push = part => {
      const last = this.queue.at(-1);
      if (kind === 'text' && last?.kind === 'text' && last.text.length + part.length <= 12000) last.text += part;
      else this.queue.push({ id: this.id, kind, text: part, ...(this.chatId ? { chatId: this.chatId } : {}) });
    };
    // Unicode code points avoid splitting a surrogate pair across native messages.
    let part = '';
    for (const char of text) {
      if (part.length + char.length > 12000) { push(part); part = ''; }
      part += char;
    }
    push(part);
  }
  phase(text) { this.phaseName = text; this.emit('phase', text); }
  text(text) { if (text) { this.answer += text; this.emit('text', text); } }
  event(event) {
    if (event.type === 'text') this.text(event.content || '');
    else if (event.type === 'done') { if (!this.answer && event.result) this.text(event.result); this.finish('done', 'Widget đã nhận kết quả (không xác nhận đăng comment).'); }
    else if (event.type === 'error') this.finish('error', event.message || 'AI không hoàn tất yêu cầu.');
    // No reasoning, tool arguments, auth headers or arbitrary SSE payloads are logged.
  }
  finish(kind, message, answer = '') {
    if (this.closed) return;
    if (answer && !this.answer) this.text(answer);
    this.emit(kind, message); this.closed = true;
    clearInterval(this.flushTimer); clearInterval(this.heartbeat);
    void this.flush();
  }
  flush() {
    if (this.sending) return this.sending;
    this.sending = (async () => {
      while (this.queue.length) {
        const events = this.queue.splice(0, 8);
        const ok = await new Promise(resolve => {
          const timer = setTimeout(() => resolve(false), 3000);
          try {
            chrome.runtime.sendNativeMessage('com.avada.andrew_telegram', { action: 'widget-chat-log', events }, response => {
              clearTimeout(timer); resolve(!chrome.runtime.lastError && response?.ok === true);
            });
          } catch { clearTimeout(timer); resolve(false); }
        });
        if (!ok) {
          console.warn('Widget terminal log could not be delivered; chat continues.');
          // Unknown delivery is never blindly retried (would duplicate streamed text).
        }
      }
    })().finally(() => { this.sending = null; });
    return this.sending;
  }
};
