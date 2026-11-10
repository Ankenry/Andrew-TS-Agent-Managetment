import { Agent, request as httpsRequest } from 'node:https';
import { currentHelpdeskFlow, recordHelpdeskUsage, usageCaller } from './helpdesk-usage.mjs';

// This host has no IPv6 route. Keep the workaround scoped to Helpdesk,
// retaining TLS verification and the caller's abort/deadline signal.
const agent = new Agent({ keepAlive: true, family: 4 });

const ERROR_CODES = new Set(['ECONNRESET','ETIMEDOUT','ECONNREFUSED','EPIPE','ENOTFOUND','EAI_AGAIN','ENETUNREACH','EHOSTUNREACH','ABORT_ERR','ERR_TLS_CERT_ALTNAME_INVALID','CERT_HAS_EXPIRED','DEPTH_ZERO_SELF_SIGNED_CERT','ERR_STREAM_PREMATURE_CLOSE','RESPONSE_INTERRUPTED','RESPONSE_TOO_LARGE','HTTP_ERROR','API_REJECTED','INVALID_JSON']);

// Allowlisted metadata only: never preserve raw errors, URLs, headers or bodies.
export function safeHelpdeskDiagnostics(value = {}) {
  value = value && typeof value === 'object' ? value : {};
  const path = String(value.endpoint || '').split('?')[0];
  const endpoint = /^\/api\/external\/tickets\/[^/]+\/comments$/.test(path) ? '/api/external/tickets/:id/comments'
    : /^\/api\/external\/tickets\/[^/]+\/actions$/.test(path) ? '/api/external/tickets/:id/actions'
    : /^\/api\/external\/tickets\/[^/]+$/.test(path) ? '/api/external/tickets/:id'
    : ['/api/external/tickets','/api/external/members','/api/external/notifications'].includes(path) ? path : '[redacted]';
  return { source:'helpdesk',
    method:['GET','POST','PUT','PATCH','DELETE','HEAD'].includes(value.method) ? value.method : 'UNKNOWN', endpoint,
    phase:['request','response','transport','api'].includes(value.phase) ? value.phase : 'unknown',
    errorCode:ERROR_CODES.has(value.errorCode) ? value.errorCode : 'UNKNOWN',
    httpStatus:Number.isInteger(value.httpStatus) && value.httpStatus >= 100 && value.httpStatus <= 599 ? value.httpStatus : null,
    elapsedMs:Number.isFinite(value.elapsedMs) && value.elapsedMs >= 0 ? Math.round(value.elapsedMs) : null,
    reusedSocket:typeof value.reusedSocket === 'boolean' ? value.reusedSocket : null };
}

export function helpdeskFetch(url, options = {}, request = httpsRequest) {
  const flow = currentHelpdeskFlow() || usageCaller(new Error().stack);
  return new Promise((resolve, reject) => {
    const started = Date.now(); let req; let httpStatus = null; let endpoint = '';
    try { endpoint = new URL(url).pathname; } catch { /* no raw URL in errors */ }
    const detail = (phase,errorCode) => safeHelpdeskDiagnostics({method:options.method || 'GET',endpoint,phase,errorCode,httpStatus,elapsedMs:Date.now()-started,reusedSocket:req?.reusedSocket});
    const fail = (error,phase='transport',code=error?.code || error?.cause?.code) => {
      const message = code === 'RESPONSE_INTERRUPTED' ? 'Helpdesk response interrupted.' : 'Helpdesk transport failed.';
      reject(Object.assign(new Error(message),{detail:detail(phase,code)}));
    };
    try { req = request(url, { ...options, agent }, response => {
      httpStatus = response.statusCode;
      const chunks = [];
      let bytes = 0;
      response.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > 32 * 1024 * 1024) {
          fail(null,'response','RESPONSE_TOO_LARGE');req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      response.on('error', error => fail(error,'response'));
      response.on('aborted', () => fail(null,'response','RESPONSE_INTERRUPTED'));
      response.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        resolve({ status: response.statusCode, ok: response.statusCode >= 200 && response.statusCode < 300,
          json: async () => JSON.parse(body), diagnostics:detail('response') });
      });
    });
    req.on('error', error => fail(error));
    // Never retry here: a POST transport failure may already have committed.
    req.end(options.body);
    } catch (error) { fail(error,'request'); }
  }).then(
    response => { if (request === httpsRequest) void recordHelpdeskUsage({ flow, method:options.method || 'GET', path:url, status:response.status }).catch(() => {}); return response; },
    error => { if (request === httpsRequest) void recordHelpdeskUsage({ flow, method:options.method || 'GET', path:url, status:error?.detail?.httpStatus || 0 }).catch(() => {}); throw error; },
  );
}
