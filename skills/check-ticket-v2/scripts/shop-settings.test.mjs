// Shop configuration reading (13/10/2026): helpers, postcheck warning, tools-server behaviour without a store/key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { flattenSettings, getPath, settingHint, hasSettingsFinding, readEnvFile, pickKey, hideValue, DEVZONE_APIS, STOREFRONT_GLOBALS } from './shop-settings.mjs';
import { checkWriterOutput } from './postcheck.mjs';
import { sourceClass, scoreQuote, SCORES } from './verify.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

test('flattenSettings prints key = value lines, hides credentials and filled personal fields, keeps boolean options', () => {
  const lines = flattenSettings({ settings: { reviewWidget: { enableStarRating: false, hideNoStarRating: false, requiredEmail: true, apiKey: 'abc', authorEmail: 'a@b.co', list: [1, 2, 3], nested: { deep: { x: 'y' } } } }, translations: { a: 'b' } });
  assert.ok(lines.includes('settings.reviewWidget.enableStarRating = false'));
  assert.ok(lines.includes('settings.reviewWidget.requiredEmail = true'), 'boolean option named *Email stays readable');
  assert.ok(lines.includes('settings.reviewWidget.apiKey = <ẩn>'));
  assert.ok(lines.includes('settings.reviewWidget.authorEmail = <ẩn>'));
  assert.ok(lines.includes('settings.reviewWidget.list = [1, 2, 3]'));
  assert.ok(lines.includes('settings.reviewWidget.nested.deep.x = "y"'));
  assert.ok(lines.some(line => line.startsWith('translations = (bỏ qua')), 'long content groups are skipped at the root');
  assert.equal(hideValue('shopToken', 'x'), true);
  assert.equal(hideValue('note', 'someone@example.com'), true, 'email-looking values are hidden whatever the key');
  assert.equal(hideValue('floatBtnIcon', 'https://cdnapps.avada.io/airReviews/icon/float-icon-2.png'), false);
  assert.deepEqual(getPath({ a: { b: [{ c: 1 }] } }, 'a.b[0].c'), 1);
  assert.equal(getPath({ a: 1 }, 'a.b.c'), undefined);
  assert.equal(flattenSettings({}, { maxLines: 5 }).length, 1);
});

test('settingHint, hasSettingsFinding, key file reading and app tables', () => {
  assert.equal(settingHint({ subject: 'Air Reviews - star rating không hiện trên product page', description: '' }), true);
  assert.equal(settingHint({ subject: '[Question] Invoice PDF', description: 'how to change the setting for currency' }), true);
  assert.equal(settingHint({ subject: 'Export reviews to CSV', description: 'please send me the file' }), false);
  assert.equal(hasSettingsFinding([{ source: { ref: 'settings:air-reviews/storefront' } }]), true);
  assert.equal(hasSettingsFinding([{ source: { ref: 'browser:https://x' } }]), false);
  const dir = mkdtempSync(join(tmpdir(), 'v2-env-'));
  writeFileSync(join(dir, '.env_my'), '# c\nOTHER=1\nDEV_ZONE="pw123"\nDEVZONE_API_KEY_AIR_REVIEWS=dk_live_x\n');
  const values = readEnvFile(join(dir, '.env_my'));
  assert.deepEqual(values, { DEV_ZONE: 'pw123', DEVZONE_API_KEY_AIR_REVIEWS: 'dk_live_x' });
  assert.equal(pickKey(values, 'air-reviews'), 'dk_live_x', 'app-specific key wins');
  assert.equal(pickKey(values, 'joy'), 'pw123');
  assert.equal(pickKey(readEnvFile(join(dir, 'missing')), 'joy'), null);
  assert.ok(DEVZONE_APIS['air-reviews'].base.startsWith('https://'));
  assert.deepEqual(STOREFRONT_GLOBALS['air-reviews'], ['AIR_REVIEWS']);
});

test('verify: a settings: ref scores like a browser observation (0.6) from shop_settings output', () => {
  assert.equal(sourceClass('settings:air-reviews/storefront'), 'browser');
  const log = [{ tool: 'shop_settings', args: { path: 'settings.reviewWidget' }, output: '[nguồn: settings:air-reviews/storefront · https://x/ · đọc lúc 2026-10-13T08:00:00Z]\nAIR_REVIEWS.settings.reviewWidget.hideNoStarRating = false' }];
  const scored = scoreQuote({ quote: 'AIR_REVIEWS.settings.reviewWidget.hideNoStarRating = false', source: { type: 'browser', ref: 'settings:air-reviews/storefront' } }, { toolLog: log, ticketText: '' });
  assert.equal(scored.score, SCORES.browser);
});

test('postcheck: a settings-looking ticket without a configuration finding gets a warning, never a violation', () => {
  const settings = { commentMaxChars: 4000, commentMinChars: 20, letterMinScore: 0.9 };
  const body = 'Star rating chưa hiện vì option đang tắt theo mã nguồn; cần TS kiểm tra lại trong app.';
  const claims = [{ text: body, finding_ids: ['F1'], inference: true }];
  const without = checkWriterOutput({ body, claims, customer_letter: null, letter_finding_ids: [] }, { category: 'Bug', settingHint: true, findings: [{ id: 'F1', kind: 'fact', verified: true, inference: false, score: 1 }] }, settings);
  assert.equal(without.ok, true);
  assert.ok(without.warnings.some(item => item.includes('không có finding cấu hình shop')));
  const withSettings = checkWriterOutput({ body, claims, customer_letter: null, letter_finding_ids: [] }, { category: 'Bug', settingHint: true, findings: [{ id: 'F1', kind: 'fact', verified: true, inference: false, score: 0.6, source: { ref: 'settings:air-reviews/storefront' } }] }, settings);
  assert.deepEqual(withSettings.warnings, []);
  const noHint = checkWriterOutput({ body, claims, customer_letter: null, letter_finding_ids: [] }, { category: 'Bug', settingHint: false, findings: [{ id: 'F1', kind: 'fact', verified: true, inference: false, score: 1 }] }, settings);
  assert.deepEqual(noHint.warnings, []);
});

function rpcClient(env) {
  const child = spawn(process.execPath, [resolve(HERE, 'tools-server.mjs')], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  let buffer = ''; const waiters = new Map(); let nextId = 1; let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdout.on('data', chunk => {
    buffer += chunk; let index;
    while ((index = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, index); buffer = buffer.slice(index + 1); if (!line.trim()) continue; const message = JSON.parse(line); const waiter = waiters.get(message.id); if (waiter) { waiters.delete(message.id); waiter(message); } }
  });
  const request = (method, params) => new Promise((resolveRequest, reject) => { const id = nextId++; const timer = setTimeout(() => reject(new Error(`timeout ${method}; stderr: ${stderr}`)), 20000); waiters.set(id, message => { clearTimeout(timer); resolveRequest(message); }); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
  const call = async (name, args) => (await request('tools/call', { name, arguments: args })).result;
  const close = () => new Promise(resolveClose => { child.on('close', resolveClose); child.stdin.end(); });
  return { request, call, close };
}

test('tools-server lists shop_settings and css_preview; shop_settings needs a store; budget 0 disables it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'v2-root-ss-'));
  mkdirSync(join(root, 'apps_doc/joy'), { recursive: true }); mkdirSync(join(root, 'knowledge-base'), { recursive: true });
  const jobDir = join(root, 'job'); mkdirSync(jobDir);
  writeFileSync(join(jobDir, 'prepare.json'), JSON.stringify({ reference: 'JOY-1', ticket: { ticketId: 'JOY-1', subject: 's', storeDomains: [] }, storeUrls: [] }));
  const client = rpcClient({ V2_ROOT: root, V2_JOB_DIR: jobDir, V2_APP: 'joy', V2_KB_SLUG: 'joy', V2_BROWSER_ALLOWED: '1', V2_MAX_SHOP_SETTINGS: '3' });
  try {
    const list = await client.request('tools/list', {});
    const names = list.result.tools.map(tool => tool.name);
    for (const name of ['shop_settings', 'css_preview', 'browser_check', 'submit_findings']) assert.ok(names.includes(name), name);
    const noStore = await client.call('shop_settings', {});
    assert.equal(noStore.isError, true); assert.match(noStore.content[0].text, /không có store/);
    const badUrl = await client.call('css_preview', { url: 'http://127.0.0.1/', css: '.a{}' });
    assert.equal(badUrl.isError, true);
    const noCss = await client.call('css_preview', { url: 'https://example.com/' });
    assert.match(noCss.content[0].text, /Thiếu css/);
    const script = await client.call('css_preview', { url: 'https://example.com/', css: '.a { background: url(https://evil.test/x.png) }' });
    assert.match(script.content[0].text, /style thuần/);
  } finally { await client.close(); }
  const off = rpcClient({ V2_ROOT: root, V2_JOB_DIR: jobDir, V2_APP: 'joy', V2_KB_SLUG: 'joy', V2_MAX_SHOP_SETTINGS: '0' });
  try { const result = await off.call('shop_settings', { shop: 'a.myshopify.com' }); assert.match(result.content[0].text, /hết 0 lượt/); } finally { await off.close(); }
});
