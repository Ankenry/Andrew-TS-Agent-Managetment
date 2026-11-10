// Bounded read-only comment pagination. A truncated snapshot is never evidence
// that a ticket has no Slack thread. Legacy callers keep their one-page shape.
export async function readCommentEvidence(ticketId, get, { allComments = false, signal, timeoutMs = 60000, maxPages = 50 } = {}) {
  const budget = new AbortController();
  const timer = setTimeout(() => budget.abort(), Math.max(1, Math.min(120000, timeoutMs)));
  const combined = signal ? AbortSignal.any([signal, budget.signal]) : budget.signal;
  const byId = new Map(), cursors = new Set();
  const meta = { complete: false, pages: 0, count: 0, total: null, hasMore: null, nextCursor: null, error: null };
  let cursor = '';
  const request = path => new Promise((resolve, reject) => {
    const abort = () => reject(Object.assign(new Error('Comment read deadline'), { code: signal?.aborted ? 'aborted' : 'deadline' }));
    if (combined.aborted) { abort(); return; }
    combined.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => get(path, { signal: combined })).then(resolve, reject).finally(() => combined.removeEventListener('abort', abort));
  });
  try {
    for (;;) {
      if (meta.pages >= (allComments ? maxPages : 1)) { meta.error = allComments ? 'page_limit' : 'snapshot_incomplete'; break; }
      const params = new URLSearchParams({ type: 'commentTicket', limit: '100', ...(cursor ? { cursor } : {}) });
      const data = await request(`/tickets/${encodeURIComponent(ticketId)}/actions?${params}`);
      meta.pages++;
      if (!Array.isArray(data?.actions)) { meta.error = 'missing_actions'; break; }
      const previousCount = byId.size;
      for (const action of data.actions) {
        if (!action?.id) { meta.error = 'missing_comment_id'; break; }
        if (byId.has(action.id) && JSON.stringify(byId.get(action.id)) !== JSON.stringify(action)) { meta.error = 'changed_during_read'; break; }
        byId.set(action.id, action);
      }
      if (meta.error) break;
      const total = Number(data.total);
      if (data.total != null && Number.isInteger(total) && total >= 0) meta.total = total;
      meta.hasMore = typeof data.hasMore === 'boolean' ? data.hasMore : null;
      meta.nextCursor = String(data.nextCursor || '').trim() || null;
      if (!meta.nextCursor) {
        if (data.hasMore === true || (meta.total !== null && byId.size !== meta.total)) meta.error = 'missing_cursor_or_count';
        else if (meta.total === null && data.hasMore !== false && data.actions.length >= 100) meta.error = 'unproven_end';
        else meta.complete = true;
        break;
      }
      if (cursors.has(meta.nextCursor)) { meta.error = 'repeated_cursor'; break; }
      if (meta.pages > 1 && byId.size === previousCount) { meta.error = 'no_progress'; break; }
      cursors.add(meta.nextCursor); cursor = meta.nextCursor;
    }
  } catch (error) {
    const http = /HTTP (\d{3})/.exec(String(error?.message || ''));
    meta.error = ['deadline', 'aborted'].includes(error?.code) ? error.code : http ? `http_${http[1]}` : 'page_read_failed';
  }
  meta.count = byId.size;
  clearTimeout(timer);
  return { actions: [...byId.values()], meta };
}
