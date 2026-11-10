import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConfigReader, redactConfig, formatConfigReport, validateConfigPath } from './config-reader.mjs';
import { ADMIN_ADAPTERS, CRM_BASE, createCrmReader, selectCrmShop, validateLoginUrl } from './config-reader-crm.mjs';
import { boundedGet } from './config-reader-http.mjs';
import { isolatedAdminToken, loginRequestAllowed } from './config-reader-login.mjs';
import { DEVZONE_APIS } from './shop-settings.mjs';
import { prepare } from './prepare.mjs';

const shop = 'test-config.myshopify.com', id = 'shop-fixture-123';
const pat = 'fixture-crm-credential', machine = 'fixture-machine-credential';
const token = 'fixture-session-credential';
const record = { id, appName: 'wishlist', shopifyDomain: shop };
const adapter = ADMIN_ADAPTERS.wishlist;
const loginUrl = adapter.origin + adapter.loginPath + '?apiKey=fixture-api&token=fixture-custom';
const json = (data, status = 200) => new Response(JSON.stringify(data), { status });
function env(contents = `CRM_TOKEN=${pat}\nDEVZONE_API_KEY=${machine}\n`) {
  const root = mkdtempSync(join(tmpdir(), 'config-reader-'));
  writeFileSync(join(root, '.env_my'), contents, { mode: 0o600 });
  return root;
}
const input = (app = 'wishlist', path = '') => ({ app, path, shop, allowedShops: [shop], ticketId: 'WISH-261029-fixture' });

test('CRM selects exact app AND domain, rejects ambiguous records and drops credentials', async () => {
  const rows = [{ ...record, appName: 'joy' }, { ...record, accessToken: 'never-retain', email: 'private@example.com' }];
  assert.deepEqual(selectCrmShop(rows, 'wishlist', shop), record);
  assert.throws(() => selectCrmShop([record, record], 'wishlist', shop), { code: 'CRM_SHOP_AMBIGUOUS' });
  assert.throws(() => selectCrmShop(rows, 'wishlist', 'other.myshopify.com'), { code: 'CRM_SHOP_NOT_FOUND' });
  const calls = [];
  const crm = createCrmReader({ token: pat, fetchImpl: async (url, options) => {
    calls.push(url); assert.equal(options.method, 'GET'); assert.equal(options.redirect, 'manual');
    assert.equal(options.headers.Authorization, `Bearer ${pat}`); assert.equal(options.headers['x-auth-token'], undefined);
    if (url === CRM_BASE + '/shops/search?searchString=' + shop) return json({ success: true, shops: rows });
    assert.equal(url, CRM_BASE + '/login/' + id + '?appType=wishlist');
    return new Response(null, { status: 302, headers: { location: loginUrl } });
  }});
  const bound = await crm.resolveShop('wishlist', shop);
  assert.equal(await crm.login('wishlist', bound), loginUrl); assert.equal(calls.length, 2);
  for (const bad of [loginUrl.replace(adapter.origin, 'https://evil.test'), loginUrl + '&token=other', loginUrl + '&returnTo=x', loginUrl.replace('/authSa/', '/auth/'), loginUrl + '#x']) {
    assert.throws(() => validateLoginUrl(bad, adapter));
  }
});

test('authentication policy allows only fixed login/static/auth endpoints and blocks app side effects', () => {
  assert.equal(loginRequestAllowed(loginUrl, 'GET', adapter, loginUrl), true);
  assert.equal(loginRequestAllowed(adapter.origin + '/js/main.js', 'GET', adapter, loginUrl), true);
  assert.equal(loginRequestAllowed('https://www.googleapis.com/identitytoolkit/v3/relyingparty/verifyCustomToken?key=fixture', 'POST', adapter, loginUrl), true);
  for (const [url, method] of [
    [adapter.origin + '/apiSa/shops', 'GET'], [adapter.origin + '/apiSa/design', 'GET'],
    [adapter.origin + '/apiSa/dev_zone', 'PUT'], [adapter.origin + '/auth/login', 'GET'],
    [adapter.origin + '/apiSa/notifications/test', 'POST'], ['https://evil.test/main.js', 'GET'],
    ['https://www.googleapis.com/identitytoolkit/v3/relyingparty/setAccountInfo', 'POST'],
    ['https://identitytoolkit.googleapis.com/v1/accounts:signUp', 'POST'],
  ]) assert.equal(loginRequestAllowed(url, method, adapter, loginUrl), false, url);
});

function fakeBrowser(claims, { silent = false } = {}) {
  let route, closed = 0; const sent = [], aborted = [];
  const jwt = 'eyJfixture.' + Buffer.from(JSON.stringify(claims)).toString('base64url') + '.fixture';
  return { sent, aborted, get closed() { return closed; }, launch: async () => ({
    newContext: async options => {
      assert.equal(options.serviceWorkers, 'block');
      return { route: async (_, fn) => { route = fn; }, close: async () => { closed++; },
        newPage: async () => ({ goto: async () => {
          if (silent) return;
          await route({ request: () => ({ url: () => adapter.origin + '/apiSa/shops', method: () => 'GET', allHeaders: async () => ({ 'x-auth-token': jwt }) }),
            abort: async () => aborted.push('/apiSa/shops'), continue: async () => sent.push('/apiSa/shops') });
        } }),
      };
    }, close: async () => { closed++; },
  }) };
}
test('isolated login captures tenant-bound auth without sending GET /shops and closes both resources', async () => {
  const fake = fakeBrowser({ sub: 'operator-uid', shopID: id, isCrmLogin: true, exp: Date.now() / 1000 + 60 });
  const result = await isolatedAdminToken({ app: 'wishlist', record, loginUrl, launch: fake.launch, timeoutMs: 100 });
  assert.ok(result.token); assert.deepEqual(result.blockedPaths, ['/apiSa/shops']);
  assert.deepEqual(fake.sent, []); assert.equal(fake.closed, 2);
});
test('wrong tenant, expired auth and stalled login fail closed with resource cleanup', async () => {
  for (const claims of [{ shopID: 'wrong', isCrmLogin: true, exp: Date.now() / 1000 + 60 }, { shopID: id, isCrmLogin: true, exp: 1 }]) {
    const fake = fakeBrowser(claims);
    await assert.rejects(isolatedAdminToken({ app: 'wishlist', record, loginUrl, launch: fake.launch, timeoutMs: 100 }), /LOGIN_/);
    assert.equal(fake.closed, 2); assert.deepEqual(fake.sent, []);
  }
  const fake = fakeBrowser({}, { silent: true });
  await assert.rejects(isolatedAdminToken({ app: 'wishlist', record, loginUrl, launch: fake.launch, timeoutMs: 5 }), { code: 'QUICK_LOGIN_TIMEOUT' });
  assert.equal(fake.closed, 2);
});

test('all existing machine adapters preserve headers, endpoints, false and Air custom CSS', async () => {
  for (const [app, cfg] of Object.entries(DEVZONE_APIS)) {
    const calls = [];
    const reader = createConfigReader({ root: env(), now: () => '2026-10-29T09:00:00Z', fetchImpl: async (url, options) => {
      calls.push(url); assert.equal(options.method, 'GET'); assert.equal(options.redirect, 'manual');
      assert.equal(options.headers['X-DevZone-Key'], machine); assert.equal(options.headers['X-Shop-Domain'], shop);
      return json({ success: true, data: url.endsWith('/custom-css') ? { customCss: '.stable { color: red; }' } : { enabled: false, password: pat } });
    }});
    const result = await reader.read(input(app, 'enabled'));
    assert.equal(result.ok, true); assert.equal(result.observations[0].value, false);
    assert.deepEqual(calls, [cfg.base + cfg.settings, ...cfg.extra.map(path => cfg.base + path)]);
    assert.equal(result.observations[0].at, '2026-10-29T09:00:00Z');
    assert.equal(JSON.stringify(result).includes(pat), false);
    if (cfg.extra.length) assert.match(formatConfigReport(result), /customCss/);
  }
});

test('false, missing, null, missing credentials and auth refusal remain distinct; raw errors never escape', async () => {
  const root = env();
  const missing = await createConfigReader({ root, fetchImpl: async () => json({ data: { enabled: false } }) }).read(input('air-edd', 'absent'));
  assert.equal(missing.state, 'missing'); assert.equal(missing.observations.length, 0);
  const nil = await createConfigReader({ root, fetchImpl: async () => json({ data: null }) }).read(input('air-edd'));
  assert.equal(nil.state, 'missing');
  const auth = await createConfigReader({ root, fetchImpl: async () => json({ error: pat }, 401) }).read(input('air-edd'));
  assert.equal(auth.state, 'auth_failed'); assert.equal(auth.attempts[0].status, 401);
  assert.equal(JSON.stringify(auth).includes(pat), false);
  const absentKey = await createConfigReader({ root: env(''), fetchImpl: () => { throw Error('should not fetch'); } }).read(input('air-edd'));
  assert.equal(absentKey.attempts[0].state, 'untried');
  await assert.rejects(boundedGet('https://fixture.test/read?token=hidden', { fetchImpl: async () => { throw Error(pat); } }), { code: 'TRANSPORT_FAILED', endpoint: 'https://fixture.test/read' });
  await assert.rejects(boundedGet('https://fixture.test/read', { fetchImpl: async () => new Response(null, { status: 302, headers: { location: 'https://evil.test' } }) }), { code: 'REDIRECT_REJECTED' });
  await assert.rejects(boundedGet('https://fixture.test/read', { maxBytes: 4, fetchImpl: async () => json({ too: 'large' }) }), { code: 'RESPONSE_TOO_LARGE' });
});

test('scope/path checks reject before network, caches are isolated and bounded', async () => {
  let calls = 0;
  const reader = createConfigReader({ root: env(), fetchImpl: async () => { calls++; return json({ data: { enabled: false, other: 1, third: 2 } }); } });
  for (const args of [{ ...input('air-edd'), shop: 'other.myshopify.com' }, input('air-edd', 'constructor.name'), input('air-edd', 'smtp.password'), input('unknown')]) {
    assert.equal((await reader.read(args)).ok, false);
  }
  assert.equal(calls, 0);
  const first = await reader.read(input('air-edd', 'enabled')); first.observations[0].value = 'mutated';
  assert.equal((await reader.read(input('air-edd', 'enabled'))).observations[0].value, false); assert.equal(calls, 1);
  await reader.read(input('air-edd', 'other')); await reader.read(input('air-edd', 'third'));
  const capped = await reader.read({ ...input('air-edd', 'enabled'), ticketId: 'WISH-261029-another' });
  assert.equal(capped.attempts[0].code, 'CONFIG_BUDGET_EXHAUSTED'); assert.equal(calls, 3);
});

test('redaction happens before scalar narrowing, cache or JSON serialization', () => {
  const safe = redactConfig({ password: 'secret', replyTo: 'merchant@example.com', members: ['someone@example.com'],
    authUrl: 'https://example.test/logo?token=secret-download&apiKey=secret-api', info: `Bearer ${pat}`, opaque: 'a'.repeat(40), known: pat, enabled: false }, [pat]);
  const output = JSON.stringify(safe);
  for (const secret of ['secret-download', 'secret-api', pat, 'merchant@example.com', 'someone@example.com', 'a'.repeat(40)]) assert.equal(output.includes(secret), false);
  assert.equal(safe.enabled, false);
  assert.throws(() => validateConfigPath('sender.smtp.password'), { code: 'SECRET_PATH_REJECTED' });
});

test('prepare sanitizes storefront objects before they enter persisted preparation evidence', async t => {
  const root = env();
  t.mock.method(globalThis, 'fetch', () => { throw Error('network forbidden in fixture'); });
  const prepared = await prepare({ reference: 'WISH-261029-fixture' }, { root, statePath: join(root, 'absent-state.json'), lessons: async () => [], slackReader: async () => null,
    evidence: async () => ({ appName: 'Wishlist', subject: 'settings', description: 'check settings', storeDomains: [shop], comments: [] }),
    fetchSettings: async () => ({ url: 'https://' + shop + '/', status: 200, found: [{ name: 'AVADA_WISHLIST', value: { enabled: false, replyTo: 'private@example.com', logoUrl: 'https://cdn.test/logo?token=private-download' } }], at: '2026-10-29T09:00:00Z' }),
  });
  assert.ok(prepared.settingsPre?.found.length);
  for (const secret of ['private@example.com', 'private-download']) assert.equal(JSON.stringify(prepared.settingsPre).includes(secret), false);
  assert.equal(prepared.settingsPre.found[0].value.enabled, false);
});

test('Wishlist fallback binds CRM/app/shop, sends only reviewed GETs and prefers dedicated notification data', async () => {
  const calls = [];
  const reader = createConfigReader({ root: env(), login: async args => {
    assert.deepEqual(args.record, record); assert.equal(args.loginUrl, loginUrl);
    return { token, blockedPaths: ['/apiSa/shops'] };
  }, fetchImpl: async (url, options) => {
    calls.push(url); assert.equal(options.method, 'GET');
    if (url.startsWith(CRM_BASE)) {
      assert.equal(options.headers.Authorization, `Bearer ${pat}`);
      return url.includes('/shops/search') ? json({ shops: [record] }) : new Response(null, { status: 302, headers: { location: loginUrl } });
    }
    assert.equal(options.headers['x-auth-token'], token); assert.equal(options.headers.Authorization, undefined);
    if (url.endsWith('/settings')) return json({ data: { notifications: { sender: { mode: 'default' } } } });
    if (url.endsWith('/email-header')) return json({ data: { logoUrl: 'https://cdn.test/logo.png?token=private-download' } });
    assert.ok(url.endsWith('/sender'));
    return json({ data: { mode: 'custom', customSender: { isVerified: true, isActivated: true, email: 'private@example.com' } } });
  }});
  const report = await reader.read(input());
  assert.equal(report.state, 'read'); assert.equal(report.observations.length, 3);
  assert.equal(report.observations[2].value.mode, 'custom'); assert.match(report.notes[0], /dedicated endpoints/);
  assert.deepEqual(report.authentication.blockedAppPaths, ['/apiSa/shops']);
  assert.deepEqual(calls.filter(u => u.startsWith(adapter.origin)), Object.values(adapter.reads).map(p => adapter.origin + p));
  for (const secret of [pat, token, 'private-download', 'private@example.com']) assert.equal(JSON.stringify(report).includes(secret), false);
  const narrowed = await reader.read(input('wishlist', 'notifications.sender.customSender.isActivated'));
  assert.equal(narrowed.observations[0].value, true);
});
