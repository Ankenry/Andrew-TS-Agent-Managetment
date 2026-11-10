// Internal transport: credentials and raw responses never enter diagnostics.
export class ConfigReadError extends Error {
  constructor(code, { status = null, endpoint = null } = {}) {
    super(code); this.code = code; this.status = status; this.endpoint = endpoint;
  }
}
export function cleanEndpoint(value) {
  try { const u = new URL(value); return u.origin + u.pathname; } catch { return null; }
}
export async function boundedGet(url, { headers = {}, fetchImpl = fetch, signal, timeoutMs = 10000, maxBytes = 2_000_000, redirectResponse = false } = {}) {
  const timer = AbortSignal.timeout(Math.max(1, timeoutMs));
  const abort = signal ? AbortSignal.any([signal, timer]) : timer;
  const endpoint = cleanEndpoint(url);
  try {
    const r = await fetchImpl(url, { method: 'GET', headers, redirect: 'manual', signal: abort });
    if (r.status >= 300 && r.status < 400) {
      await r.body?.cancel();
      if (redirectResponse) return { status: r.status, location: r.headers.get('location') };
      throw new ConfigReadError('REDIRECT_REJECTED', { status: r.status, endpoint });
    }
    if (!r.ok) { await r.body?.cancel(); throw new ConfigReadError(r.status === 401 || r.status === 403 ? 'AUTH_REJECTED' : 'HTTP_ERROR', { status: r.status, endpoint }); }
    const reader = r.body?.getReader();
    if (!reader) throw new ConfigReadError('EMPTY_RESPONSE', { endpoint });
    let size = 0, text = ''; const decoder = new TextDecoder();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) throw new ConfigReadError('RESPONSE_TOO_LARGE', { endpoint });
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
    } finally { await reader.cancel().catch(() => {}); }
    let body; try { body = JSON.parse(text); } catch { throw new ConfigReadError('INVALID_JSON', { endpoint }); }
    if (body?.success === false) throw new ConfigReadError('API_UNSUCCESSFUL', { status: r.status, endpoint });
    return { status: r.status, body };
  } catch (error) {
    if (error instanceof ConfigReadError) throw error;
    throw new ConfigReadError(abort.aborted ? 'TIMEOUT_OR_ABORTED' : 'TRANSPORT_FAILED', { endpoint });
  }
}

export function safeFailure(error, source) {
  if (error instanceof ConfigReadError && error.code === 'FIELD_MISSING') return { source, state: 'missing', code: error.code, status: error.status, endpoint: error.endpoint };
  return { source, state: 'failed', code: error instanceof ConfigReadError ? error.code : 'READ_FAILED',
    status: error instanceof ConfigReadError ? error.status : null,
    endpoint: error instanceof ConfigReadError ? error.endpoint : null };
}
