import { resolve } from 'node:path';
import { DEVZONE_APIS, readEnvFile, pickKey, flattenSettings, SECRET_KEY, PII_KEY } from './shop-settings.mjs';
import { ADMIN_ADAPTERS, canonicalShop, createCrmReader } from './config-reader-crm.mjs';
import { isolatedAdminToken } from './config-reader-login.mjs';
import { boundedGet, ConfigReadError, safeFailure, cleanEndpoint } from './config-reader-http.mjs';

export const supportedConfigApp = app => Object.hasOwn(DEVZONE_APIS, app) || Object.hasOwn(ADMIN_ADAPTERS, app);
export function validateConfigPath(path = '') {
  if (typeof path !== 'string' || path.length > 200 || (path && !/^[A-Za-z][A-Za-z0-9_]*(?:\[\d+\]|\.[A-Za-z][A-Za-z0-9_]*)*$/.test(path)) ||
      /(?:^|\.)(?:__proto__|constructor|prototype)(?:\.|\[|$)/.test(path)) throw new ConfigReadError('CONFIG_PATH_INVALID');
  if (path.split(/[.\[\]]/).some(part => SECRET_KEY.test(part))) throw new ConfigReadError('SECRET_PATH_REJECTED');
  return path;
}
export function redactConfig(value, secrets = [], key = '') {
  if (SECRET_KEY.test(key)) return '<ẩn>';
  if (typeof value === 'string') {
    if (/^[A-Za-z0-9_-]{32,}$/.test(value)) return '<ẩn>';
    if (PII_KEY.test(key) || /username|clientEmail/i.test(key)) return value ? '<ẩn>' : value;
    let out = value;
    for (const secret of secrets) if (secret) out = out.split(secret).join('<ẩn>');
    out = out.replace(/\bBearer\s+\S+|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '<ẩn>');
    out = out.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '<ẩn>');
    try {
      const u = new URL(out);
      if (u.username || u.password) return '<ẩn>';
      for (const k of [...u.searchParams.keys()]) if (SECRET_KEY.test(k) || /^(code|key|auth|session|sig)$/i.test(k)) u.searchParams.set(k, 'hidden');
      out = u.href;
    } catch { /* ordinary setting string */ }
    return out;
  }
  if (Array.isArray(value)) return value.slice(0, 100).map(v => redactConfig(v, secrets, key));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([k]) => !['__proto__', 'constructor', 'prototype'].includes(k)).map(([k, v]) => [k, redactConfig(v, secrets, k)]));
  return value;
}
function ownPath(value, path) {
  for (const part of path.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean)) {
    if (!value || typeof value !== 'object' || !Object.hasOwn(value, part)) return undefined;
    value = value[part];
  }
  return value;
}
function desiredRoots(path) {
  const roots = Object.keys(ADMIN_ADAPTERS.wishlist.reads);
  if (!path) return roots;
  return roots.filter(root => root === path || path.startsWith(root + '.') || root.startsWith(path + '.'));
}
export function formatConfigReport(report) {
  const lines = [];
  lines.push(...(report.notes || []));
  for (const attempt of report.attempts || []) if (attempt.state !== 'read') lines.push(`${attempt.source}: ${attempt.code}${attempt.status ? ` (HTTP ${attempt.status})` : ''}${attempt.endpoint ? ` · ${attempt.endpoint}` : ''}`);
  for (const entry of report.observations || []) {
    lines.push(`[nguồn: settings:${report.app}/${entry.source} · GET ${entry.endpoint} · shop ${report.shop} · đọc lúc ${entry.at}]`);
    lines.push(...flattenSettings(entry.value, { path: entry.path, maxLines: 160 }));
    if (entry.semantics) lines.push(`Semantics: ${entry.semantics}`);
  }
  if (!report.ok) lines.push(`chưa đọc được cấu hình shop: ${report.state}; không coi field thiếu là false. Không suy ra loại credential từ HTTP 401/403.`);
  lines.push('Nhãn UI chỉ ghi khi đã đối chiếu mã nguồn; nếu chưa xác minh dùng key. Giá trị, nguồn và giờ đọc ở trên là bằng chứng; không phải thao tác sửa shop.');
  return lines.join('\n');
}

export function createConfigReader({ root, keyFile = resolve(root, '.env_my'), fetchImpl = fetch,
  login = isolatedAdminToken, now = () => new Date().toISOString(), timeoutMs = 10000, totalMs = 60000 } = {}) {
  // This cache is private to one CLI/job/client instance and contains sanitized data only.
  const cache = new Map();
  let readCount = 0;
  return {
    async read({ app, shop, path = '', source = 'auto', ticketId, allowedShops, signal }) {
      const result = { ok: false, state: 'unavailable', app, shop, observations: [], attempts: [] };
      try {
        canonicalShop(shop); validateConfigPath(path);
        if (!ticketId || !Array.isArray(allowedShops) || !allowedShops.map(v => String(v).toLowerCase()).includes(shop)) throw new ConfigReadError('TICKET_SHOP_MISMATCH');
        if (!supportedConfigApp(app)) throw new ConfigReadError('APP_ADAPTER_UNAVAILABLE');
        if (!['auto', 'api'].includes(source)) throw new ConfigReadError('SOURCE_UNAVAILABLE');
        const identity = `${ticketId}|${app}|${shop}|${path}|${source}`;
        if (cache.has(identity)) return structuredClone(cache.get(identity));
        if (++readCount > 3) throw new ConfigReadError('CONFIG_BUDGET_EXHAUSTED');
        const deadline = AbortSignal.timeout(Math.max(1, Math.min(90000, totalMs)));
        const stop = signal ? AbortSignal.any([signal, deadline]) : deadline;
        const values = readEnvFile(keyFile, ['CRM_TOKEN', 'DEVZONE_API_KEY', 'DEV_ZONE_API_KEY', 'DEV_ZONE']) || {};
        const secrets = Object.values(values);
        const options = { fetchImpl, signal: stop, timeoutMs };
        const api = DEVZONE_APIS[app];
        if (api) {
          const key = pickKey(values, app);
          if (!key) result.attempts.push({ source: 'api', state: 'untried', code: 'DEVZONE_KEY_MISSING' });
          else try {
            const endpoint = api.base + api.settings;
            const response = await boundedGet(endpoint, { ...options, headers: { 'X-DevZone-Key': key, 'X-Shop-Domain': shop, Accept: 'application/json' } });
            if (response.body == null || Object.hasOwn(response.body, 'data') && response.body.data === null) throw new ConfigReadError('FIELD_MISSING', { endpoint });
            const safe = redactConfig(response.body.data ?? response.body, secrets);
            const picked = ownPath(safe, path);
            if (picked === undefined) result.attempts.push({ source: 'api', state: 'missing', code: 'FIELD_MISSING', endpoint });
            else {
              result.observations.push({ path, value: picked, source: 'api', endpoint, at: now() });
              result.attempts.push({ source: 'api', state: 'read', code: 'OK', endpoint });
            }
          } catch (error) { result.attempts.push(safeFailure(error, 'api')); }
          // Preserve the existing Air Reviews supplemental custom-CSS read.
          if (key && result.attempts.some(a => a.state === 'read' || a.state === 'missing')) {
            for (const extra of api.extra || []) {
              const endpoint = api.base + extra;
              try {
                const { body } = await boundedGet(endpoint, { ...options, headers: { 'X-DevZone-Key': key, 'X-Shop-Domain': shop, Accept: 'application/json' } });
                if (body == null || Object.hasOwn(body, 'data') && body.data === null) throw new ConfigReadError('FIELD_MISSING', { endpoint });
                result.observations.push({ path: '', value: redactConfig(body.data ?? body, secrets), source: 'api', endpoint, at: now(), supplemental: true });
              } catch (error) { result.attempts.push(safeFailure(error, 'api')); }
            }
          }
        }
        if (!result.observations.length && ADMIN_ADAPTERS[app]) {
          const adapter = ADMIN_ADAPTERS[app];
          const roots = desiredRoots(path);
          if (!roots.length) result.attempts.push({ source: 'admin', state: 'untried', code: 'FIELD_NOT_IN_REVIEWED_ADAPTER' });
          else try {
            const crm = createCrmReader({ token: values.CRM_TOKEN, ...options });
            const record = await crm.resolveShop(app, shop);
            const loginUrl = await crm.login(app, record);
            const auth = await login({ app, record, loginUrl, signal: stop, timeoutMs: Math.min(30000, totalMs) });
            result.authentication = { provider: 'crm-public-admin/isolated-quick-login', shopBound: true, blockedAppPaths: (auth.blockedPaths || []).filter(p => /^\/apiSa\/[a-z/-]+$/i.test(p)) };
            secrets.push(auth.token);
            for (const field of roots) {
              const endpoint = adapter.origin + adapter.reads[field];
              try {
                const { body } = await boundedGet(endpoint, { ...options, headers: { 'x-auth-token': auth.token, Accept: 'application/json' } });
                if (body == null || Object.hasOwn(body, 'data') && body.data === null) throw new ConfigReadError('FIELD_MISSING', { endpoint });
                const safe = redactConfig(body.data ?? body, secrets);
                const relativePath = path.startsWith(field + '.') ? path.slice(field.length + 1) : '';
                if (field === 'settings') result.notes = ['Wishlist /settings includes legacy/default notification fields. For logo and sender, use notifications.emailHeader and notifications.sender from their dedicated endpoints; do not treat settings.notifications as authoritative for those features.'];
                const picked = ownPath(safe, relativePath);
                if (picked === undefined || picked === null && field === 'settings') result.attempts.push({ source: 'admin', state: 'missing', code: 'FIELD_MISSING', endpoint });
                else result.observations.push({ path: relativePath ? path : field, value: picked, source: 'admin', endpoint, at: now(), semantics: adapter.semantics });
              } catch (error) { result.attempts.push(safeFailure(error, 'admin')); }
            }
            auth.token = null;
          } catch (error) { result.attempts.push(safeFailure(error, 'admin')); }
        }
        result.ok = result.observations.length > 0;
        result.state = result.ok ? (result.attempts.some(a => a.state === 'failed' || a.state === 'missing') ? 'partial' : 'read')
          : result.attempts.some(a => a.code === 'AUTH_REJECTED') ? 'auth_failed'
          : result.attempts.some(a => a.state === 'missing') ? 'missing' : 'unavailable';
        if (result.ok) cache.set(identity, structuredClone(result));
      } catch (error) { result.attempts.push(safeFailure(error, 'reader')); }
      return result;
    },
  };
}
