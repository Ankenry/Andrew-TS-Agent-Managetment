import test from 'node:test';
import assert from 'node:assert/strict';
import { storefrontAccess, redactStorefrontSecrets, trustedStorefront, createStorefrontSession } from './storefront-access.mjs';
import { openStorefront, launchBrowser, unlockStorefront } from './storefront.mjs';
import { prepare } from './prepare.mjs';

const ticket = { subject: 'Chatty widget settings', appName: 'Chatty', storeDomains: ['store.example'], description: '- Cửa hàng: custom.example\nStorefront password: old-secret', comments: [
  { createdAt: '2026-10-14T00:00:00Z', content: 'Pass store: older-secret' },
  { createdAt: '2026-10-15T00:00:00Z', content: 'Pass store: test-secret\n@Andrew check tiếp' },
] };
test('latest explicit storefront credential wins; unrelated accounts/links are excluded', () => {
  const access = storefrontAccess(ticket);
  assert.equal(access.password, 'test-secret');
  assert.deepEqual(access.hosts.sort(), ['custom.example', 'store.example']);
  assert.equal(storefrontAccess({ description: 'Admin password: admin-secret\nhttps://other.example/' }).password, null);
  assert.equal(trustedStorefront('https://store.example.evil.test/password', access), false);
  assert.equal(trustedStorefront('http://store.example/password', access), false);
  assert.equal(trustedStorefront('https://store.example/password', access), true);
  const redacted = JSON.stringify(redactStorefrontSecrets(ticket, access));
  for (const secret of access.secrets) assert.ok(!redacted.includes(secret));
});

test('prepare uses credential privately and redacts all ticket/follow-up copies', async () => {
  let supplied;
  const result = await prepare({ reference: 'CHAT-test', url: 'https://helpdesk.example/CHAT-test' }, {
    evidence: async () => ticket, lessons: async () => [], statePath: '/not-present',
    followUp: { instruction: 'check widget settings', previousReport: 'old-secret' },
    fetchSettings: async (url, app, options) => { supplied = options.access; return { url, found: [], password: false }; },
  });
  assert.equal(supplied.password, 'test-secret');
  assert.equal(result.storefrontAccess.hasPassword, true);
  for (const secret of supplied.secrets) assert.ok(!JSON.stringify(result).includes(secret));
});

// Real headless browser, synthetic HTTPS Shopify gate: no network calls or merchant writes.
function fixture({ action = '/password', valid = true } = {}) {
  const posts = [];
  const launch = async () => {
    const browser = await launchBrowser();
    const original = browser.newContext.bind(browser);
    browser.newContext = async options => {
      const context = await original(options);
      await context.route('**/*', async route => {
        const request = route.request();
        const url = new URL(request.url());
        if (request.method() === 'POST') {
          posts.push({ host: url.host, body: request.postData() });
          if (valid) return route.fulfill({ contentType: 'text/html', headers: { 'set-cookie': 'storefront_digest=ok; Path=/; Secure; HttpOnly' }, body: '<script>history.replaceState(null,"","/");window.AVADA_FAQ={enabled:true};</script><h1>Unlocked storefront</h1>' });
        }
        return route.fulfill({ contentType: 'text/html', body: !request.headers().cookie?.includes('storefront_digest=ok')
          ? `<details><summary>Password</summary><form method="post" action="${action}"><input name="password" type="password"><button>Enter</button></form></details>`
          : '<h1>Unlocked storefront</h1><script>window.AVADA_FAQ={enabled:true};</script>' });
      });
      return context;
    };
    return browser;
  };
  return { launch, posts };
}

test('opens hidden gate with untyped submit button and retains cookies between browser/settings/mobile calls', async () => {
  const { launch, posts } = fixture();
  const access = storefrontAccess(ticket), session = createStorefrontSession();
  let site = await openStorefront(new URL('https://store.example/'), { access, session, launch, waitMs: 0 });
  try { assert.equal(site.unlock.status, 'unlocked'); assert.equal(site.info.password, false); assert.equal(await site.page.locator('h1').innerText(), 'Unlocked storefront'); }
  finally { await site.close(); }
  assert.equal(posts.length, 1);
  site = await openStorefront(new URL('https://store.example/products/test'), { access, session, launch, waitMs: 0, mobile: true });
  try {
    assert.equal(site.unlock.status, 'not_required');
    assert.equal(await site.page.evaluate(() => window.AVADA_FAQ.enabled), true);
    assert.equal(posts.length, 1);
  } finally { await site.close(); }
});

test('missing password and external form action never submit', async () => {
  for (const external of [false, true]) {
    const { launch, posts } = fixture({ action: external ? 'https://other.example/password' : '/password' });
    const site = await openStorefront(new URL('https://store.example/'), { access: external ? storefrontAccess(ticket) : null, launch, waitMs: 0 });
    try { assert.equal(site.unlock.status, external ? 'unsupported_form' : 'missing_password'); assert.equal(site.info.password, true); assert.equal(posts.length, 0); }
    finally { await site.close(); }
  }
});

test('wrong password is bounded to one attempt, cleared from DOM and not reported as unlocked', async () => {
  const { launch, posts } = fixture({ valid: false });
  const browser = await launch();
  try {
    const context = await browser.newContext(); const page = await context.newPage();
    await page.goto('https://store.example/');
    const session = createStorefrontSession(), access = storefrontAccess(ticket);
    assert.ok(['still_locked', 'failed_or_timed_out'].includes((await unlockStorefront(page, access, session, { timeoutMs: 1000 })).status));
    assert.equal(await page.locator('input').inputValue(), '');
    assert.equal((await unlockStorefront(page, access, session)).status, 'already_attempted');
    assert.equal(posts.length, 1);
  } finally { await browser.close(); }
});
