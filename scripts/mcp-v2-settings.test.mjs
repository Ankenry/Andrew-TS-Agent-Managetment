// UI and transport tests use only in-memory fixtures and disposable headless Chromium.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile, mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { playwrightModule } from '../skills/check-ticket-v2/scripts/storefront.mjs';
import { settingsAction } from './mcp-v2-settings.mjs';
import { reviewRequest } from './mcp-v2-review.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const sources = Object.fromEntries(await Promise.all(['web/app/app.js', 'chrome-extension/widget.js', 'chrome-extension/background.js'].map(async name => [name, await readFile(resolve(root, name), 'utf8')])));
const block = (source, name) => source.split(`// ${name}_BEGIN`)[1].split(`// ${name}_END`)[0];
const backgroundHandler = sources['chrome-extension/background.js'].split('async function handleMessage(message) {')[1].split('\nchrome.runtime.onMessage.addListener')[0];
const defaults = { ok: true, settings: {}, groups: { doing: [{ id: 'fixture-internal', ticketId: 'AIR-261027-fixture', subject: 'Fixture ticket' }] }, notifications: [], conversations: [], schedules: [], tickets: [], sessions: [], connected: false, provider: 'elite2', hachimi: { running: false, busy: false } };

test('both entrypoints share identical controller behavior', () => {
  assert.equal(block(sources['web/app/app.js'], 'MCP_V2_SETTINGS_CARD'), block(sources['chrome-extension/widget.js'], 'MCP_V2_SETTINGS_CARD'));
});

function transport(source, fetch) {
  const context = vm.createContext({ fetch, AbortSignal, TS_WEB_API_URL: 'https://fixture.test', accessKey: () => 'fixture-pin' });
  vm.runInContext(block(source, 'MCP_V2_TRANSPORT'), context);
  return context;
}

for (const name of ['web/app/app.js', 'chrome-extension/background.js']) {
  test(`${name}: GET/PUT contract, revision, errors and no automatic retries`, async () => {
    const calls = [];
    const snapshot = { enabled: false, effectiveEngine: 'current', available: true, reason: null, revision: 0 };
    let status = 200;
    const context = transport(sources[name], async (url, options) => {
      calls.push({ url, options });
      return { ok: status === 200, status, json: async () => status === 200 ? snapshot : { error: `fixture-${status}` } };
    });
    assert.deepEqual(await context.mcpV2SettingsRequest('read'), snapshot);
    await context.mcpV2SettingsRequest('save', { enabled: true, revision: 7 });
    assert.equal(new URL(calls[0].url, 'https://fixture.test').pathname, '/api/mcp-v2/settings');
    assert.equal(calls[0].options.method, 'GET');
    assert.equal(calls[0].options.cache, 'no-store');
    assert.equal(calls[1].options.method, 'PUT');
    assert.deepEqual(JSON.parse(calls[1].options.body), { enabled: true, expectedRevision: 7 });
    if (name.startsWith('web')) assert.equal(calls[1].options.headers['X-TS-Web-Key'], 'fixture-pin');
    for (status of [400, 409, 503, 500]) {
      const before = calls.length;
      await assert.rejects(context.mcpV2SettingsRequest('save', { enabled: true, revision: 7 }), new RegExp(`fixture-${status}`));
      assert.equal(calls.length, before + 1);
    }
  });
}

test('extension rejects malformed messages before any transport call', async () => {
  let called = 0;
  const context = vm.createContext({ mcpV2SettingsRequest: async () => { called++; return {}; } });
  vm.runInContext(`async function handleMessage(message) {${backgroundHandler}`, context);
  for (const message of [{ action: 'delete' }, { action: 'save', enabled: 'true', revision: 1 }, { action: 'save', enabled: true, revision: -1 }]) {
    await assert.rejects(context.handleMessage({ type: 'mcp-v2-settings', ...message }));
  }
  assert.equal(called, 0);
});

test('explicit review commands only; questions/mail never inherit intent from a selected ticket', () => {
  assert.equal(block(sources['web/app/app.js'], 'MCP_V2_INTENT'), block(sources['chrome-extension/widget.js'], 'MCP_V2_INTENT'));
  const context = vm.createContext({});
  vm.runInContext(block(sources['web/app/app.js'], 'MCP_V2_INTENT'), context);
  const ticket = { ticketId: 'AIR-261027-fixture', id: 'internal' };
  for (const text of ['Tại sao lỗi này xảy ra?', 'viết mail cho khách', 'Tóm tắt ticket', 'Check tiếp là gì?', 'Cảm ơn', 'Please explain the previous review']) {
    assert.equal(Object.keys(context.ticketReviewRequest(text, ticket)).length, 0, text);
  }
  for (const text of ['check tiếp', 'check tiep ticket AIR-261027-fixture', 'recheck AIR-261027-fixture', 'check lại https://helpdesk.avada.net/t/AIR-261027-fixture']) {
    const result = context.ticketReviewRequest(text, ticket);
    assert.equal(result.intent, 'ticket-review'); assert.equal(result.reviewFollowUp, true); assert.equal(result.ticket.ticketId, ticket.ticketId);
  }
  assert.equal(context.ticketReviewRequest('Check ticket AIR-261027-fixture', null).reviewFollowUp, false);
  assert.throws(() => context.ticketReviewRequest('check tiếp', null));
  assert.throws(() => context.ticketReviewRequest('Check ticket invalid', ticket));
});

test('extension routing: ON explicit review uses bridge; OFF and ordinary chat preserve provider', async () => {
  const called = [];
  let enabled = true, available = true;
  const context = vm.createContext({
    mcpV2SettingsRequest: async () => { called.push('settings'); return { enabled, available, reason: 'fixture unavailable', revision: 3 }; },
    requestMcpV2TicketReview: async message => { called.push('mcp-v2'); assert.equal(message.expectedEngineRevision, 3); return { answer: 'V2', engine: 'mcp-v2', revision: 3 }; },
    getAiProvider: async () => 'elite2',
    requestTsEliteAiChat: async () => { called.push('elite2'); return 'job-1'; },
    requestHachimiLocalChat: async () => { called.push('hachimi'); return { answer: 'local' }; },
    requestHachimiTsEliteChat: async () => { called.push('combined'); return { answer: 'combined' }; },
  });
  vm.runInContext('async function requestWidgetAiChat(message, { providerOverride = "" } = {}) {' + sources['chrome-extension/background.js'].split('async function requestWidgetAiChat(message, { providerOverride = "" } = {}) {')[1].split('\nasync function codexBridgeStatus')[0], context);
  const ticket = { ticketId: 'AIR-261027-fixture' };
  const result = await context.requestWidgetAiChat({ message: 'Check ticket AIR-261027-fixture', intent: 'ticket-review', ticket });
  assert.equal(result.engine, 'mcp-v2'); assert.deepEqual(called.splice(0), ['settings', 'mcp-v2']);
  for (const message of ['ordinary follow-up question', 'viết mail', 'hello']) {
    await context.requestWidgetAiChat({ message, ticket });
    assert.deepEqual(called.splice(0), ['elite2']);
  }
  enabled = false;
  await context.requestWidgetAiChat({ intent: 'ticket-review', ticket });
  assert.deepEqual(called.splice(0), ['settings', 'elite2']);
  enabled = true; available = false;
  await assert.rejects(context.requestWidgetAiChat({ intent: 'ticket-review', ticket }), /fixture unavailable/);
  assert.deepEqual(called.splice(0), ['settings']);
  await assert.rejects(context.requestWidgetAiChat({ intent: 'ticket-review', ticket: { id: 'internal' } }), /mã ticket/);
  assert.deepEqual(called, []);
});

test('review bridge forwards explicit intent, ticket reference, follow-up and response metadata', async () => {
  const calls = [];
  const context = vm.createContext({ AbortSignal, CODEX_TICKET_BRIDGE_URL: 'http://fixture-bridge', fetch: async (url, options) => {
    calls.push({ url, options }); return { ok: true, json: async () => ({ answer: 'fixture', engine: 'mcp-v2', revision: 3 }) };
  } });
  vm.runInContext(block(sources['chrome-extension/background.js'], 'MCP_V2_REVIEW_TRANSPORT'), context);
  const result = await context.requestMcpV2TicketReview({ message: 'check tiếp', chatId: 'fixture-chat', ticket: { ticketId: 'AIR-261027-fixture', description: 'stale ignored' }, reviewFollowUp: true, expectedEngineRevision: 3 });
  assert.equal(calls[0].url, 'http://fixture-bridge/chat');
  assert.deepEqual(JSON.parse(calls[0].options.body), { message: 'check tiếp', chatId: 'fixture-chat', ticket: { ticketId: 'AIR-261027-fixture' }, intent: 'ticket-review', reviewFollowUp: true, expectedEngineRevision: 3 });
  assert.equal(result.engine, 'mcp-v2'); assert.equal(result.revision, 3);
});

for (const outcome of ['OFF', 'ON-new-revision', 'readback-offline']) test(`extension engine race: ${outcome} rejects once, reads settings and never retries or falls back`, async () => {
  const calls = [];
  let settingsReads = 0;
  const context = vm.createContext({
    AbortSignal, CODEX_TICKET_BRIDGE_URL: 'http://fixture-bridge',
    mcpV2SettingsRequest: async action => {
      calls.push(action); settingsReads++;
      if (settingsReads === 1) return { enabled: true, available: true, revision: 3 };
      if (outcome === 'readback-offline') throw new Error('fixture offline');
      return { enabled: outcome !== 'OFF', available: true, revision: 4 };
    },
    fetch: async (_url, options) => {
      calls.push('bridge');
      assert.equal(options.method, 'POST');
      assert.equal(JSON.parse(options.body).expectedEngineRevision, 3);
      return { ok: false, status: 409, json: async () => ({ error: 'MCP_ENGINE_CHANGED' }) };
    },
    getAiProvider: async () => { calls.push('provider'); return 'elite2'; },
    requestTsEliteAiChat: async () => { calls.push('legacy'); return 'wrong'; },
    requestHachimiLocalChat: async () => { calls.push('legacy'); return {}; },
    requestHachimiTsEliteChat: async () => { calls.push('legacy'); return {}; },
  });
  vm.runInContext(block(sources['chrome-extension/background.js'], 'MCP_V2_REVIEW_TRANSPORT'), context);
  vm.runInContext('async function requestWidgetAiChat(message, { providerOverride = "" } = {}) {' + sources['chrome-extension/background.js'].split('async function requestWidgetAiChat(message, { providerOverride = "" } = {}) {')[1].split('\nasync function codexBridgeStatus')[0], context);
  await assert.rejects(context.requestWidgetAiChat({ intent: 'ticket-review', message: 'check tiếp', reviewFollowUp: true, ticket: { ticketId: 'AIR-261027-fixture' }, expectedEngineRevision: 99 }), error => {
    assert.match(error.message, /MCP_ENGINE_CHANGED/);
    assert.match(error.message, /Không tự chạy lại điều tra/);
    assert.match(error.message, outcome === 'readback-offline' ? /Chưa đọc lại được/ : outcome === 'OFF' ? /Đã đọc lại: OFF/ : /Đã đọc lại: ON/);
    return true;
  });
  assert.deepEqual(calls, ['read', 'bridge', 'read']);
});

test('review transport refuses a missing or invalid engine revision before sending', async () => {
  const calls = [];
  const context = vm.createContext({ fetch: async () => calls.push('bridge') });
  vm.runInContext(block(sources['chrome-extension/background.js'], 'MCP_V2_REVIEW_TRANSPORT'), context);
  for (const expectedEngineRevision of [undefined, -1, '3', 1.5]) {
    await assert.rejects(context.requestMcpV2TicketReview({ ticket: { ticketId: 'AIR-261027-fixture' }, expectedEngineRevision }), /revision/);
  }
  assert.deepEqual(calls, []);
});

test('actual backend contract in a temporary store: shared state, conflicts and unavailable ON', async () => {
  const temporaryRoot = await mkdtemp(resolve(tmpdir(), 'hanbui-mcp-settings-'));
  let available = true;
  const fetch = async (_url, options) => {
    const result = await settingsAction(options.method, options.body ? JSON.parse(options.body) : undefined, {
      root: temporaryRoot, readiness: async () => ({ available, reason: available ? null : 'MCP_FIXTURE_UNAVAILABLE' }),
    });
    return { ok: result.status === 200, status: result.status, json: async () => result.body };
  };
  const web = transport(sources['web/app/app.js'], fetch);
  const extension = transport(sources['chrome-extension/background.js'], fetch);
  assert.equal((await web.mcpV2SettingsRequest('read')).enabled, false);
  await web.mcpV2SettingsRequest('save', { enabled: true, revision: 0 });
  assert.equal((await extension.mcpV2SettingsRequest('read')).effectiveEngine, 'mcp-v2');
  await assert.rejects(extension.mcpV2SettingsRequest('save', { enabled: false, revision: 0 }), /MCP_SETTINGS_CONFLICT/);
  await extension.mcpV2SettingsRequest('save', { enabled: false, revision: 1 });
  assert.equal((await web.mcpV2SettingsRequest('read')).enabled, false);
  available = false;
  await assert.rejects(web.mcpV2SettingsRequest('save', { enabled: true, revision: 2 }), /MCP_FIXTURE_UNAVAILABLE/);
  assert.equal((await extension.mcpV2SettingsRequest('read')).revision, 2);
  const context = vm.createContext({});
  vm.runInContext(block(sources['web/app/app.js'], 'MCP_V2_INTENT'), context);
  const request = context.ticketReviewRequest('check tiếp', { ticketId: 'AIR-261027-fixture' });
  assert.equal(reviewRequest({ ...request, message: 'check tiếp' }).followUp.instruction, 'check tiếp');
  // Retain this isolated fixture; this task does not authorize file deletion.
});

function fixtureStore() {
  const store = { value: { enabled: false, effectiveEngine: 'current', available: true, reason: null, revision: 0 }, calls: [], offline: false, failWrite: false, loseWriteReply: false, failReadback: false, holdRead: false, held: [], holdWrite: false, releaseWrite: null };
  store.change = (enabled, extra = {}) => { store.value = { ...store.value, enabled, effectiveEngine: enabled ? 'mcp-v2' : 'current', revision: store.value.revision + 1, ...extra }; };
  store.request = async (method, body) => {
    store.calls.push({ method, body });
    if (store.offline) throw new Error('fixture offline');
    if (method === 'GET') {
      const data = structuredClone(store.value);
      if (store.holdRead) { store.holdRead = false; return new Promise(resolve => store.held.push(() => resolve({ status: 200, data }))); }
      return { status: 200, data };
    }
    if (store.holdWrite) { store.holdWrite = false; await new Promise(resolve => { store.releaseWrite = resolve; }); }
    if (body.expectedRevision !== store.value.revision) return { status: 409, data: { error: 'fixture stale revision', current: store.value } };
    if (store.failWrite) return { status: 500, data: { error: 'fixture persistence failed' } };
    if (body.enabled && !store.value.available) return { status: 503, data: { error: 'fixture V2 unavailable' } };
    store.change(body.enabled);
    if (store.failReadback) store.offline = true;
    if (store.loseWriteReply) throw new Error('fixture lost reply');
    return { status: 200, data: structuredClone(store.value) };
  };
  return store;
}

async function openSurface(browser, surface, store, viewport = { width: 1280, height: 900 }) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  const errors = [], messages = [], traffic = [];
  page.on('pageerror', error => errors.push(error.message));
  const bridge = transport(sources['chrome-extension/background.js'], async (_url, options) => {
    const result = await store.request(options.method, options.body ? JSON.parse(options.body) : undefined);
    return { ok: result.status === 200, status: result.status, json: async () => result.data };
  });
  vm.runInContext(`async function handleMessage(message) {${backgroundHandler}`, bridge);
  await page.exposeBinding('fixtureMessage', async (_source, message) => {
    messages.push(message);
    if (message.type !== 'mcp-v2-settings') return message.type === 'ai-chat' ? { ...defaults, answer: 'Fixture answer' } : defaults;
    try { return await bridge.handleMessage(message); }
    catch (error) { return { ok: false, error: error.message }; }
  });
  await page.addInitScript(() => {
    window.EventSource = class { addEventListener() {} close() {} };
    const values = {};
    window.chrome = {
      runtime: { getURL: path => `https://fixture.test/${path}`, onMessage: { addListener() {} }, sendMessage: (message, callback) => { window.fixtureMessage(message).then(callback); } },
      storage: { onChanged: { addListener() {} }, local: { get: async keys => ({ ...keys, ...values }), set: async data => Object.assign(values, data) } },
    };
  });
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    traffic.push({ method: request.method(), path: url.pathname, body: request.postData() ? request.postDataJSON() : null });
    if (url.pathname === '/api/mcp-v2/settings') {
      try {
        const result = await store.request(request.method(), request.postData() ? request.postDataJSON() : undefined);
        return await route.fulfill({ status: result.status, contentType: 'application/json', body: JSON.stringify(result.data) });
      } catch { return route.abort(); }
    }
    if (url.pathname.startsWith('/api/')) return route.fulfill({ contentType: 'application/json', body: JSON.stringify(url.pathname === '/api/ai/chat' ? { ...defaults, answer: 'Fixture answer' } : defaults) });
    if (surface === 'web') {
      const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      if (/^icons\/[\w-]+\.png$/.test(name)) return route.fulfill({ contentType: 'image/png', body: await readFile(resolve(root, 'chrome-extension', name)) });
      const base = ['han-auto-view.js', 'analytics-view.js', 'speech-player.js', 'news-view.js'].includes(name) ? 'chrome-extension' : 'web/app';
      if (!name.includes('..')) try {
        return await route.fulfill({ contentType: name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html', body: await readFile(resolve(root, base, name), 'utf8') });
      } catch {}
    }
    return route.fulfill({ contentType: 'text/html', body: '<!doctype html><body></body>' });
  });
  const boot = async () => {
    await page.goto('https://fixture.test/');
    if (surface === 'extension') {
      const manifest = JSON.parse(await readFile(resolve(root, 'chrome-extension/manifest.json'), 'utf8'));
      for (const name of manifest.content_scripts[0].js) await page.addScriptTag({ content: await readFile(resolve(root, 'chrome-extension', name), 'utf8') });
    }
    await page.locator('[data-screen="settings"]').click();
    await page.locator('.mcp-v2-settings[aria-busy="false"]').waitFor();
  };
  await boot();
  const card = page.locator('.mcp-v2-settings');
  const toggle = page.getByRole('switch', { name: 'Bật chiến dịch MCP V2' });
  const refresh = async () => { await card.getByRole('button', { name: 'Đọc lại cấu hình' }).click(); await card.locator('[role="status"]').filter({ hasText: /Đã đọc cấu hình chung|Chưa đọc được/ }).waitFor(); };
  const settled = async () => { await page.locator('.mcp-v2-settings[aria-busy="false"]').waitFor(); };
  return { page, context, errors, messages, traffic, boot, card, toggle, refresh, settled };
}

test('real Settings UI, fixture server only: synchronization, keyboard, races and failures', { timeout: 120_000 }, async t => {
  const { chromium } = await import(pathToFileURL(playwrightModule()).href);
  const browser = await chromium.launch({ headless: true, executablePath: '/usr/bin/google-chrome', args: ['--disable-extensions', '--no-first-run'] });
  try {
    for (const surface of ['web', 'extension']) await t.test(surface, async () => {
      const store = fixtureStore();
      const ui = await openSurface(browser, surface, store);
      try {
        assert.equal(await ui.toggle.isChecked(), false);
        assert.equal(store.calls.filter(call => call.method === 'PUT').length, 0, 'mount must not persist a default');
        assert.match(await ui.card.innerText(), /luồng hiện tại/);
        await ui.toggle.focus();
        await ui.page.keyboard.press('Space');
        await ui.settled();
        assert.equal(await ui.toggle.isChecked(), true);
        assert.match(await ui.card.innerText(), /Đã lưu và đọc lại/);
        assert.deepEqual(store.calls.find(call => call.method === 'PUT').body, { enabled: true, expectedRevision: 0 });
        assert.equal(await ui.toggle.evaluate(input => input === input.getRootNode().activeElement), true);
        await ui.boot();
        assert.equal(await ui.toggle.isChecked(), true, 'reload reads persisted state');

        // Capture actual desktop/mobile UI against fixtures, never the live shop or service.
        await mkdir(resolve(root, 'runtime/screenshots'), { recursive: true });
        for (const [name, viewport] of [['desktop', { width: 1280, height: 900 }], ['mobile', { width: 390, height: 844 }]]) {
          await ui.page.setViewportSize(viewport);
          await ui.card.scrollIntoViewIfNeeded();
          const bounds = await ui.card.boundingBox();
          assert(bounds.x >= -1 && bounds.x + bounds.width <= viewport.width + 1, 'card fits viewport');
          assert.equal(await ui.card.evaluate(card => card.scrollWidth <= card.clientWidth + 1), true, 'content does not overflow');
          await ui.page.screenshot({ path: resolve(root, `runtime/screenshots/hanbui-mcp-v2-${surface}-${name}.png`) });
        }

        store.change(false);
        await ui.page.evaluate(() => window.dispatchEvent(new Event('focus')));
        await ui.settled();
        assert.equal(await ui.toggle.isChecked(), false, 'focus reads changes from another client');
        store.failWrite = true;
        await ui.card.locator("label").click(); await ui.settled();
        assert.equal(await ui.toggle.isChecked(), false);
        assert.match(await ui.card.innerText(), /Chưa xác nhận lần lưu/);
        store.failWrite = false;

        store.loseWriteReply = true;
        const writesBefore = store.calls.filter(call => call.method === 'PUT').length;
        await ui.card.locator("label").click(); await ui.settled();
        assert.equal(await ui.toggle.isChecked(), true, 'lost reply reconciles committed state');
        assert.equal(store.calls.filter(call => call.method === 'PUT').length, writesBefore + 1, 'no PUT retry');
        store.loseWriteReply = false;

        store.change(true, { available: false, reason: 'fixture missing MCP' }); await ui.refresh();
        assert.match(await ui.card.innerText(), /MCP V2 đang bị chặn: fixture missing MCP/);
        assert.doesNotMatch(await ui.card.innerText(), /Luồng có hiệu lực cho lượt check mới: MCP V2/);
        await ui.card.locator("label").click(); await ui.settled();
        assert.equal(await ui.toggle.isChecked(), false, 'unavailable V2 can be disabled');
        assert.match(await ui.card.innerText(), /MCP V2 chưa sẵn sàng: fixture missing MCP/);
        await ui.card.locator("label").click(); await ui.settled();
        assert.equal(await ui.toggle.isChecked(), false, '503 ON does not write');

        store.change(false, { available: true, reason: null }); await ui.refresh();
        store.holdWrite = true;
        await ui.card.locator("label").click();
        assert.equal(await ui.toggle.isDisabled(), true);
        const readsBefore = store.calls.filter(call => call.method === 'GET').length;
        await ui.page.evaluate(() => window.dispatchEvent(new Event('focus')));
        assert.equal(store.calls.filter(call => call.method === 'GET').length, readsBefore, 'focus must not race with save');
        store.change(false); // Concurrent writer invalidates the submitted revision.
        assert.equal(typeof store.releaseWrite, 'function'); store.releaseWrite();
        await ui.settled();
        assert.equal(await ui.toggle.isChecked(), false);
        assert.match(await ui.card.innerText(), /fixture stale revision/);

        store.holdRead = true;
        await ui.page.evaluate(() => window.dispatchEvent(new Event('focus')));
        await ui.page.waitForTimeout(50);
        assert.equal(store.held.length, 1);
        store.change(true);
        await ui.page.evaluate(() => window.dispatchEvent(new Event('focus')));
        await ui.settled();
        assert.equal(await ui.toggle.isChecked(), true);
        store.held.shift()();
        await ui.page.waitForTimeout(50);
        assert.equal(await ui.toggle.isChecked(), true, 'late old GET must not overwrite fresh snapshot');

        store.failReadback = true;
        await ui.card.locator("label").click(); await ui.settled();
        assert.equal(await ui.toggle.isDisabled(), true);
        assert.match(await ui.card.innerText(), /Luồng có hiệu lực: chưa xác minh/);
        assert.match(await ui.card.innerText(), /Chưa xác minh kết quả lưu/);
        store.offline = false; store.failReadback = false; await ui.refresh();
        assert.equal(await ui.toggle.isChecked(), false);
        store.offline = true; await ui.refresh();
        assert.equal(await ui.toggle.isDisabled(), true);
        assert.match(await ui.card.innerText(), /lần đọc gần nhất/);
        store.offline = false; await ui.refresh();

        store.value.revision = 'bad'; await ui.refresh();
        assert.equal(await ui.toggle.isDisabled(), true, 'malformed response is not treated as OFF');
        assert.match(await ui.card.innerText(), /không hợp lệ/);
        await ui.page.locator('[data-screen="home"]').click();
        const readsAfterLeaving = store.calls.filter(call => call.method === 'GET').length;
        await ui.page.evaluate(() => window.dispatchEvent(new Event('focus')));
        assert.equal(store.calls.filter(call => call.method === 'GET').length, readsAfterLeaving, 'disposed Settings card does not refresh');
        assert.deepEqual(ui.errors, []);
        // Existing web boot performs /dev/follow-scan; it too is intercepted by fixtures.
        assert(ui.traffic.every(call => call.method === 'GET' || ['/api/mcp-v2/settings', '/api/dev/follow-scan'].includes(call.path)), 'no new unrelated HTTP mutations');
        assert(ui.messages.filter(message => /set-|start|reconnect/.test(message.type)).length === 0, 'no service start/settings side effect');
      } finally { store.held.splice(0).forEach(release => release()); store.releaseWrite?.(); await ui.context.close(); }
    });
    for (const surface of ['web', 'extension']) await t.test(`${surface}: remote MCP readiness is independent from browser/CSS capabilities`, async () => {
      const store = fixtureStore();
      store.value.capabilities = {
        remoteMcp: { available: true },
        browser: { available: false, reason: 'BSK_OFFICIAL_ADAPTER_NOT_INSTALLED', verifiedAt: null, isolatedProfileVerified: false },
        cssPreview: { available: false, reason: 'BROWSER_NOT_VERIFIED' },
      };
      const ui = await openSurface(browser, surface, store);
      const remote = ui.card.locator('#mcp-v2-remote-capability');
      const browserCss = ui.card.locator('#mcp-v2-browser-capability');
      try {
        assert.equal(await remote.innerText(), 'MCP đọc dữ liệu: sẵn sàng');
        assert.equal(await browserCss.innerText(), 'Trình duyệt/CSS: chưa sẵn sàng');
        assert.equal(await ui.toggle.isChecked(), false);
        assert.equal(store.value.revision, 0);
        await ui.page.setViewportSize({ width: 390, height: 844 });
        await ui.card.scrollIntoViewIfNeeded();
        assert.equal(await ui.card.evaluate(card => card.scrollWidth <= card.clientWidth + 1), true);
        await ui.page.screenshot({ path: resolve(root, `runtime/screenshots/hanbui-mcp-v2-${surface}-capabilities-mobile.png`) });
        store.value.capabilities = undefined;
        store.value.available = true;
        store.value.bskInstalled = true; // Installed binary is not a verified browser capability.
        await ui.refresh();
        assert.equal(await remote.innerText(), 'MCP đọc dữ liệu: chưa xác minh');
        assert.equal(await browserCss.innerText(), 'Trình duyệt/CSS: chưa xác minh');
        for (const capabilities of [
          { remoteMcp: { available: true }, browser: { available: true } },
          { remoteMcp: { available: true }, cssPreview: { available: true } },
          { remoteMcp: { available: 'true' }, browser: { available: 'true' }, cssPreview: { available: true } },
        ]) {
          store.value.capabilities = capabilities; await ui.refresh();
          assert.equal(await browserCss.innerText(), 'Trình duyệt/CSS: chưa xác minh');
        }
        assert.equal(await remote.innerText(), 'MCP đọc dữ liệu: chưa xác minh');
        store.value.capabilities = { remoteMcp: { available: false }, browser: { available: true }, cssPreview: { available: false } };
        await ui.refresh();
        assert.equal(await remote.innerText(), 'MCP đọc dữ liệu: chưa sẵn sàng');
        assert.equal(await browserCss.innerText(), 'Trình duyệt/CSS: chưa sẵn sàng');
        store.value.capabilities = { remoteMcp: { available: true }, browser: { available: true }, cssPreview: { available: true } };
        await ui.refresh();
        assert.equal(await browserCss.innerText(), 'Trình duyệt/CSS: sẵn sàng');
        store.offline = true; await ui.refresh();
        assert.equal(await remote.innerText(), 'MCP đọc dữ liệu: chưa xác minh');
        assert.equal(await browserCss.innerText(), 'Trình duyệt/CSS: chưa xác minh');
        assert.equal(await ui.toggle.isDisabled(), true);
        assert.equal(store.calls.filter(call => call.method !== 'GET').length, 0, 'capability display never writes toggle or revision');
        assert.deepEqual(ui.errors, []);
      } finally { await ui.context.close(); }
    });
    for (const surface of ['web', 'extension']) await t.test(`${surface}: Check button and explicit recheck carry intent; ordinary chat/mail do not`, async () => {
      const ui = await openSurface(browser, surface, fixtureStore());
      const chatRequests = () => surface === 'web' ? ui.traffic.filter(call => call.path === '/api/ai/chat').map(call => call.body) : ui.messages.filter(message => message.type === 'ai-chat');
      try {
        await ui.page.locator('[data-screen="home"]').click();
        if (surface === 'extension') await ui.page.locator('.category-header .toggle').filter({ hasText: 'Doing' }).click();
        await ui.page.getByRole('button', { name: 'Check', exact: true }).click();
        await ui.page.locator('.send:not([disabled])').waitFor();
        assert.equal(chatRequests()[0].intent, 'ticket-review');
        assert.equal(chatRequests()[0].reviewFollowUp, false);
        assert.equal(chatRequests()[0].ticket.ticketId, 'AIR-261027-fixture');
        for (const text of ['Tại sao lỗi này xảy ra?', 'viết mail cho khách', 'check tiếp']) {
          await ui.page.locator('.chat-input').fill(text);
          await ui.page.locator('.chat-input').press('Enter');
          await ui.page.locator('.send:not([disabled])').waitFor();
          const request = chatRequests().at(-1);
          assert.equal(request.message, text);
          assert.equal(request.intent, text === 'check tiếp' ? 'ticket-review' : undefined);
          assert.equal(request.reviewFollowUp, text === 'check tiếp' ? true : undefined);
        }
        assert.deepEqual(ui.errors, []);
      } finally { await ui.context.close(); }
    });
    await t.test('web and extension share one persisted choice in both directions', async () => {
      const store = fixtureStore();
      const web = await openSurface(browser, 'web', store);
      const extension = await openSurface(browser, 'extension', store);
      try {
        await web.card.locator("label").click(); await web.settled();
        await extension.boot(); assert.equal(await extension.toggle.isChecked(), true);
        await extension.card.locator("label").click(); await extension.settled();
        await web.boot(); assert.equal(await web.toggle.isChecked(), false);
        assert.equal(store.calls.filter(call => call.method === 'PUT').length, 2);
      } finally { await web.context.close(); await extension.context.close(); }
    });
  } finally { await browser.close(); }
});
