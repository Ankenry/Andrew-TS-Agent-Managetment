import { boundedGet, ConfigReadError } from './config-reader-http.mjs';

// Verified from current Source API chatty/config/avadaCrm.js and avadaAppsService.js,
// then live GET allApps/search/login on 2026-10-29. UI /api uses Firebase x-auth-token;
// Public Admin uses the PAT Bearer header. Never try one credential on the other API.
export const CRM_BASE = 'https://us-central1-avada-crm.cloudfunctions.net/publicAdminApi/api';
export const ADMIN_ADAPTERS = Object.freeze({
  wishlist: Object.freeze({ appName: 'wishlist', origin: 'https://wishlist.joy.so',
    loginPath: '/authSa/a/login',
    reads: Object.freeze({ settings: '/apiSa/settings',
      'notifications.emailHeader': '/apiSa/notifications/email-header',
      'notifications.sender': '/apiSa/notifications/sender' }),
    // /apiSa/shops writes wishlist-page/quickstart/Crisp data; /design can backfill
    // translations. Both are explicitly excluded even though they are GET routes.
    semantics: 'effective app configuration; getters may merge defaults without persisting them',
  }),
});

export function canonicalShop(value) {
  const s = String(value || '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(s)) throw new ConfigReadError('CANONICAL_SHOP_REQUIRED');
  return s;
}
export function selectCrmShop(rows, app, shop) {
  const adapter = ADMIN_ADAPTERS[app];
  if (!adapter) throw new ConfigReadError('ADMIN_ADAPTER_UNAVAILABLE');
  const found = (Array.isArray(rows) ? rows : []).filter(r => r.appName === adapter.appName && String(r.shopifyDomain || '').toLowerCase() === shop);
  if (found.length !== 1) throw new ConfigReadError(found.length ? 'CRM_SHOP_AMBIGUOUS' : 'CRM_SHOP_NOT_FOUND');
  const r = found[0];
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(r.id || '')) throw new ConfigReadError('CRM_SHOP_ID_INVALID');
  // Drop accessToken, emails, and every other field at the first boundary.
  return { id: r.id, appName: r.appName, shopifyDomain: shop };
}
export function validateLoginUrl(value, adapter) {
  let u; try { u = new URL(value); } catch { throw new ConfigReadError('CRM_LOGIN_URL_INVALID'); }
  if (u.searchParams.getAll('token').length !== 1 || u.searchParams.getAll('apiKey').length !== 1) throw new ConfigReadError('CRM_LOGIN_QUERY_AMBIGUOUS');
  if (u.origin !== adapter.origin || u.pathname !== adapter.loginPath || u.username || u.password || u.hash ||
      !u.searchParams.get('token') || !u.searchParams.get('apiKey') ||
      [...u.searchParams.keys()].some(k => !['token', 'apiKey'].includes(k))) throw new ConfigReadError('CRM_LOGIN_DESTINATION_REJECTED');
  return u.href;
}
export function createCrmReader({ token, fetchImpl = fetch, signal, timeoutMs = 10000 } = {}) {
  const get = path => {
    if (!token) throw new ConfigReadError('CRM_TOKEN_MISSING');
    return boundedGet(CRM_BASE + path, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      fetchImpl, signal, timeoutMs, redirectResponse: path.startsWith('/login/') });
  };
  return {
    async resolveShop(app, shop) {
      canonicalShop(shop);
      const { body } = await get('/shops/search?searchString=' + encodeURIComponent(shop));
      return selectCrmShop(body?.shops, app, shop);
    },
    async login(app, record) {
      const adapter = ADMIN_ADAPTERS[app];
      if (!adapter || record.appName !== adapter.appName) throw new ConfigReadError('CRM_APP_MISMATCH');
      const result = await get(`/login/${encodeURIComponent(record.id)}?appType=${encodeURIComponent(adapter.appName)}`);
      return validateLoginUrl(result.location, adapter); // memory only, never evidence
    },
  };
}
