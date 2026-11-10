import { launchBrowser } from './storefront.mjs';
import { ADMIN_ADAPTERS, validateLoginUrl } from './config-reader-crm.mjs';
import { ConfigReadError } from './config-reader-http.mjs';

// This is an authentication bridge, not a model-controlled browser. In particular,
// GET /apiSa/shops and /design have server-side writes in Wishlist and MUST NOT run.
export function loginRequestAllowed(url, method, adapter, loginUrl) {
  let u; try { u = new URL(url); } catch { return false; }
  if (u.username || u.password || u.protocol !== 'https:') return false;
  if (u.origin === adapter.origin) {
    if (method !== 'GET') return false;
    if (u.href === loginUrl) return true;
    if (u.pathname === '/' && !u.searchParams.has('token')) return true;
    return /^\/(?:js|css|assets|static)\//.test(u.pathname) && /\.(?:js|css|woff2?)$/.test(u.pathname);
  }
  // Firebase authentication changes only the transient auth session, never shop data.
  // Firebase 7.2 used by the verified standalone login page uses this legacy API.
  if (u.origin === 'https://www.googleapis.com' && method === 'POST') {
    return ['/identitytoolkit/v3/relyingparty/verifyCustomToken', '/identitytoolkit/v3/relyingparty/getAccountInfo'].includes(u.pathname);
  }
  if (u.origin === 'https://identitytoolkit.googleapis.com' && method === 'POST') {
    return ['/v1/accounts:signInWithCustomToken', '/v1/accounts:lookup'].includes(u.pathname);
  }
  return method === 'GET' && u.origin === 'https://www.gstatic.com' && /^\/firebasejs\/[^/]+\/firebase(?:-[a-z-]+)?\.js$/.test(u.pathname);
}

export async function isolatedAdminToken({ app, record, loginUrl, signal, timeoutMs = 30000, launch = launchBrowser }) {
  const adapter = ADMIN_ADAPTERS[app];
  if (!adapter) throw new ConfigReadError('ADMIN_ADAPTER_UNAVAILABLE');
  validateLoginUrl(loginUrl, adapter);
  let browser, context, timer, abort;
  const blocked = new Set();
  try {
    browser = await launch();
    context = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: false });
    let finish, fail;
    const credential = new Promise((resolve, reject) => { finish = resolve; fail = reject; });
    // Attach a rejection handler immediately, including while page.goto is running.
    credential.catch(() => {});
    timer = setTimeout(() => fail(new ConfigReadError('QUICK_LOGIN_TIMEOUT')), Math.max(1, timeoutMs));
    abort = () => fail(new ConfigReadError('TIMEOUT_OR_ABORTED'));
    if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
    await context.route('**/*', async route => {
      const request = route.request();
      let u; try { u = new URL(request.url()); } catch { return route.abort(); }
      if (u.origin === adapter.origin && u.pathname.startsWith('/apiSa/')) {
        const headers = await request.allHeaders();
        const token = headers['x-auth-token'];
        if (token) {
          let claims;
          try { claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()); } catch {}
          if (!claims || !Number.isFinite(claims.exp) || claims.exp * 1000 <= Date.now()) {
            fail(new ConfigReadError('LOGIN_TOKEN_INVALID'));
            return route.abort();
          }
          // CRM logs in the support identity: sub is the operator UID, while the
          // signed shopID claim selects the tenant. Reject mismatches before any API GET.
          if (Object.hasOwn(claims || {}, 'shopID')) {
            if (claims.shopID !== record.id || claims.isCrmLogin !== true || claims.exp * 1000 <= Date.now()) fail(new ConfigReadError('LOGIN_SHOP_ID_MISMATCH'));
            else finish(token);
            blocked.add(u.pathname);
            return route.abort();
          }
          if (claims?.sub !== record.id) fail(new ConfigReadError('LOGIN_SHOP_ID_MISMATCH'));
          else finish(token);
        }
        blocked.add(u.pathname);
        return route.abort(); // even GET /shops writes; capture without sending it
      }
      if (loginRequestAllowed(request.url(), request.method(), adapter, loginUrl)) return route.continue();
      if (['https://www.googleapis.com', 'https://identitytoolkit.googleapis.com', adapter.origin].includes(u.origin)
          && /^\/[a-zA-Z0-9_./:-]{0,150}$/.test(u.pathname)) blocked.add(u.origin + u.pathname);
      if (u.origin === adapter.origin) blocked.add(u.pathname);
      return route.abort();
    });
    const page = await context.newPage();
    // Never expose browser errors: they may contain the tokenized login URL.
    page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: Math.min(20000, timeoutMs) }).catch(() => {});
    const token = await credential;
    return { token, blockedPaths: [...blocked].filter(p => /^\/apiSa\/[a-z/-]+$/i.test(p)).slice(0, 20) };
  } catch (error) {
    if (error instanceof ConfigReadError) error.blockedPaths = [...blocked].slice(0, 20);
    throw error instanceof ConfigReadError ? error : new ConfigReadError('QUICK_LOGIN_UNAVAILABLE');
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort', abort);
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
  }
}
