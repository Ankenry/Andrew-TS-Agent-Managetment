// Headless storefront access shared by the tools server (browser_check, css_preview, shop_settings, view_image) and,
// since 14/10/2026, by the prepare phase (one pre-read of the shop's configuration object when the ticket looks like a
// settings question). Disposable headless Chrome per call; storefront gate cookies/storage can be carried in memory
// within one tools process. No admin/customer login, no saved shop edits or credential files, no internal hosts.

import { existsSync, readdirSync, mkdirSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { STOREFRONT_GLOBALS, GLOBAL_PATTERN } from './shop-settings.mjs';
import { createStorefrontSession, redactStorefrontSecrets, trustedStorefront } from './storefront-access.mjs';

export function playwrightModule() {
  const cache = resolve(homedir(), '.npm/_npx');
  for (const name of (() => { try { return readdirSync(cache); } catch { return []; } })()) {
    const path = join(cache, name, 'node_modules/playwright/index.mjs');
    if (existsSync(path)) return path;
  }
  throw new Error('Playwright chưa cài trên máy này.');
}

const INTERNAL_HOST = /^(localhost|127\.|10\.|192\.168\.|0\.0\.0\.0|\[::1\])/;
export function parsePublicUrl(value) {
  let url;
  try { url = new URL(String(value || '')); if (!['http:', 'https:'].includes(url.protocol)) throw new Error('bad'); } catch { return { error: 'url không hợp lệ (cần http/https).' }; }
  if (INTERNAL_HOST.test(url.hostname) || /\.(local|localhost|internal)$/.test(url.hostname)) return { error: 'Không mở địa chỉ nội bộ.' };
  return { url };
}

export async function launchBrowser() {
  const { chromium } = await import(pathToFileURL(playwrightModule()).href);
  return chromium.launch({ headless: true, executablePath: process.env.TICKET_CHROME_BIN || '/usr/bin/google-chrome', args: ['--disable-extensions', '--no-first-run'], timeout: 20000 });
}

// One page on a public storefront URL: title, HTTP status, password-page flag, console errors, failed requests, text.
// screenshotDir/rootForRelative: where `screenshot(name)` saves and how the returned path is made relative.
export async function unlockStorefront(page, access, session, { timeoutMs = 12000 } = {}) {
  const locked = () => page.evaluate(() => location.pathname.replace(/\/$/, '') === '/password' || Boolean(document.querySelector('form[action*="/password"] input[name="password"]')));
  if (!await locked()) return { status: 'not_required' };
  if (!access?.password) return { status: 'missing_password' };
  if (!trustedStorefront(page.url(), access)) return { status: 'untrusted_host' };
  const origin = new URL(page.url()).origin;
  if (session.attempted.has(origin)) return { status: 'already_attempted' };
  const form = page.locator('form').filter({ has: page.locator('input[name="password"]') }).first();
  if (!await form.count()) return { status: 'unsupported_form' };
  const safe = await form.evaluate(f => {
    const action = new URL(f.action, location.href);
    return f.method.toLowerCase() === 'post' && action.origin === location.origin && action.pathname === '/password' && !action.search;
  }).catch(() => false);
  if (!safe) return { status: 'unsupported_form' };
  session.attempted.add(origin);
  const input = form.locator('input[name="password"]').first();
  // Only a navigation to the same-origin Shopify gate may submit the credential.
  await page.route('**/*', async route => {
    const request = route.request();
    const body = request.postData() || '';
    const containsSecret = [request.url(), body].some(value => value.includes(access.password) || value.includes(encodeURIComponent(access.password))) || [...new URLSearchParams(body).values()].includes(access.password);
    const dest = new URL(request.url());
    if (containsSecret && !(request.method() === 'POST' && dest.origin === origin && dest.pathname === '/password' && !dest.search && request.isNavigationRequest())) return route.abort();
    return route.fallback();
  });
  try {
    // Dawn's password form may be inside closed <details>; changing this only opens the local dialog.
    await input.evaluate(element => { for (let parent = element.parentElement; parent; parent = parent.parentElement) if (parent.tagName === 'DETAILS') parent.open = true; });
    await input.fill(access.password, { timeout: 3000 });
    // requestSubmit also works for a default submit button with no explicit type attribute (D7G).
    const [response] = await Promise.all([
      page.waitForNavigation({ timeout: timeoutMs, waitUntil: 'domcontentloaded' }),
      form.evaluate(f => f.requestSubmit()),
    ]);
    if (!trustedStorefront(page.url(), access)) return { status: 'untrusted_redirect' };
    if (response && response.status() >= 400) return { status: 'http_error' };
    if (/^\/(?:challenge|account|admin)(?:\/|$)/.test(new URL(page.url()).pathname)) return { status: 'challenge_or_login' };
    return { status: await locked() ? 'still_locked' : 'unlocked' };
  } catch { return { status: 'failed_or_timed_out' }; }
  finally { await input.fill('', { timeout: 500 }).catch(() => {}); }
}

export async function openStorefront(url, { mobile = false, waitMs = 3000, screenshotDir = null, rootForRelative = process.cwd(), access = null, session = createStorefrontSession(), signal, launch = launchBrowser } = {}) {
  const browser = await launch();
  const abort = () => { browser.close().catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) { abort(); throw new Error('Storefront read cancelled'); }
  try {
  const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1365, height: 900 }, ...(mobile ? { isMobile: true, hasTouch: true } : {}), ...(trustedStorefront(url.href, access) && session.storageState ? { storageState: session.storageState } : {}), ignoreHTTPSErrors: true });
  const page = await context.newPage();
  const consoleErrors = []; const failed = []; const notes = [];
  page.on('console', message => { if (message.type() === 'error' && consoleErrors.length < 10) consoleErrors.push(message.text().slice(0, 200)); });
  let status = null;
  page.on('response', response => {
    if (response.request().isNavigationRequest() && response.frame() === page.mainFrame()) status = response.status();
    if (response.status() >= 400 && failed.length < 10) failed.push(`${response.status()} ${response.url().slice(0, 160)}`);
  });
  try { const response = await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 30000 }); status = response?.status() ?? null; }
  catch (error) { notes.push(`goto lỗi: ${error.message.split('\n')[0].slice(0, 200)}`); }
  const unlock = await unlockStorefront(page, access, session);
  await page.waitForTimeout(waitMs);
  const info = redactStorefrontSecrets(await page.evaluate(() => ({ title: document.title, url: location.href, password: Boolean(document.querySelector('form[action*="/password"]')) || location.pathname.replace(/\/$/, '') === '/password', bodyText: (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 1500) })), access);
  const header = redactStorefrontSecrets([`url: ${info.url}`, `http: ${status ?? '?'} · title: ${info.title}${info.password ? ' · TRANG MẬT KHẨU (storefront khóa, không xem được nội dung)' : ''}`, `storefront unlock: ${unlock.status}`, ...notes], access);
  const screenshot = async name => {
    if (!screenshotDir) return null;
    try {
      mkdirSync(screenshotDir, { recursive: true, mode: 0o700 });
      const file = join(screenshotDir, `${name}.png`);
      await page.screenshot({ path: file, fullPage: false });
      return relative(rootForRelative, file);
    } catch { return null; }
  };
  return { browser, page, info, status, unlock, consoleErrors, failed, header, screenshot, close: async () => {
    try { if (!info.password && trustedStorefront(page.url(), access)) session.storageState = await context.storageState(); }
    finally { signal?.removeEventListener('abort', abort); await browser.close().catch(() => {}); }
  } };
  } catch (error) { signal?.removeEventListener('abort', abort); await browser.close().catch(() => {}); throw new Error(redactStorefrontSecrets(error.message, access)); }
}

// The configuration objects the app embed prints on the page: window.<GLOBAL> for the app, plus any Avada-looking global.
// Returns [{ name, value }] (value null when it cannot be serialised) — raw data, scrubbing is the caller's job.
export async function readStorefrontGlobals(page, app) {
  const globals = STOREFRONT_GLOBALS[app] || [];
  return page.evaluate(([names, patternSource]) => {
    const pattern = new RegExp(patternSource);
    const out = [];
    const seen = new Set();
    const take = name => {
      if (seen.has(name)) return; seen.add(name);
      const value = window[name];
      if (!value || typeof value !== 'object') return;
      try { out.push({ name, value: JSON.parse(JSON.stringify(value)) }); } catch { out.push({ name, value: null, error: 'không tuần tự hóa được' }); }
    };
    for (const name of names) take(name);
    for (const name of Object.keys(window)) if (pattern.test(name)) take(name);
    return out;
  }, [globals, GLOBAL_PATTERN.source]);
}

// Whole read used by prepare (pre-read) and the tools server (cache miss): open the page once, take the globals.
// Never throws: a failure comes back as { error } so a pre-read can be skipped silently.
export async function fetchStorefrontSettings(urlValue, app, { waitMs = 3000, timeoutMs = 25000, access = null, session = createStorefrontSession() } = {}) {
  const parsed = parsePublicUrl(urlValue);
  if (parsed.error) return { error: parsed.error };
  let site = null; let timer = null;
  const controller = new AbortController();
  const work = (async () => {
    site = await openStorefront(parsed.url, { waitMs, access, session, signal: controller.signal });
    const found = await readStorefrontGlobals(site.page, app);
    return redactStorefrontSecrets({ url: site.info.url, status: site.status, password: Boolean(site.info.password), unlock: site.unlock, found, at: new Date().toISOString() }, access);
  })();
  work.catch(() => {}); // a late failure after the timeout must not surface as an unhandled rejection
  const timeout = new Promise(resolveTimer => { timer = setTimeout(() => resolveTimer({ error: `quá ${Math.round(timeoutMs / 1000)} giây` }), timeoutMs); });
  try { return await Promise.race([work, timeout]); }
  catch (error) { return { error: String(error?.message || error).split('\n')[0].slice(0, 200) }; }
  finally {
    clearTimeout(timer);
    if (site) await site.close(); else { controller.abort(); work.finally(() => site?.close()).catch(() => {}); }
  }
}
