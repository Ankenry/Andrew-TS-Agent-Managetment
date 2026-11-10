// Isolated MV3 harness using the exact production Settings card and transport.
// Reads the live backend only; never loads the full extension's schedulers.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { playwrightModule } from '../skills/check-ticket-v2/scripts/storefront.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const stamp = Date.now();
const dir = resolve(root, `runtime/mcp-v2/deployment/extension-readback-${stamp}`);
const extension = resolve(dir, 'extension');
await mkdir(extension, { recursive: true, mode: 0o700 });
const background = await readFile(resolve(root, 'chrome-extension/background.js'), 'utf8');
const widget = await readFile(resolve(root, 'chrome-extension/widget.js'), 'utf8');
const block = (source, name) => {
  const value = source.split(`// ${name}_BEGIN`)[1]?.split(`// ${name}_END`)[0];
  assert.ok(value, `Missing production block ${name}`); return value;
};
const transport = block(background, 'MCP_V2_TRANSPORT');
const card = block(widget, 'MCP_V2_SETTINGS_CARD');
const handler = background.split('async function handleMessage(message) {')[1]?.split('  switch (message?.type) {')[0];
assert.ok(handler?.includes('mcp-v2-settings'));
const endpoint = 'http://127.0.0.1:5088/api/mcp-v2/settings';
await writeFile(resolve(extension, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'MCP V2 readback harness', version: '1.0.0', host_permissions: ['http://127.0.0.1:5088/*'], background: { service_worker: 'background.js' } }));
await writeFile(resolve(extension, 'background.js'), `const TS_WEB_API_URL='http://127.0.0.1:5088';
const originalFetch=globalThis.fetch.bind(globalThis); const requests=[];
globalThis.fetch=(url,options={})=>{if(url!==${JSON.stringify(endpoint)} || options.method!=='GET') throw Error('Harness is read-only'); requests.push({url,method:options.method}); return originalFetch(url,options)};
${transport}
async function handleMessage(message) {${handler} throw Error('Unsupported harness message'); }
chrome.runtime.onMessage.addListener((message,sender,reply)=>{if(message.type!=='mcp-v2-settings'||message.action!=='read'){reply({ok:false,error:'Read only'});return false;}handleMessage(message).then(reply,error=>reply({ok:false,error:error.message}));return true;});`);
await writeFile(resolve(extension, 'readback.html'), '<!doctype html><html lang="vi"><meta charset="utf-8"><title>MCP V2 readback</title><body><script src="readback.js"></script></body></html>');
await writeFile(resolve(extension, 'readback.js'), `${card}
const view=createMcpV2SettingsCard({read:async()=>{const result=await chrome.runtime.sendMessage({type:'mcp-v2-settings',action:'read'});if(!result.ok)throw Error(result.error);window.readback=result.settings;return result.settings;},write:async()=>{throw Error('Read only');}});document.body.append(view.element);void view.refresh();`);
const { chromium } = await import(pathToFileURL(playwrightModule()).href);
const context = await chromium.launchPersistentContext(resolve(dir, 'profile'), {
  executablePath: resolve(root, 'runtime/mcp-v2/browser-tools/chromium-1243/chrome-linux64/chrome'), headless: true,
  args: ['--no-sandbox', `--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
});
try {
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 20000 });
  const id = new URL(worker.url()).hostname;
  const page = await context.newPage(); await page.goto(`chrome-extension://${id}/readback.html`);
  await page.waitForFunction(() => window.readback, { timeout: 20000 });
  const settings = await page.evaluate(() => window.readback);
  assert.equal(settings.enabled, false); assert.equal(settings.revision, 0);
  assert.equal(await page.locator('#mcp-v2-enabled').isChecked(), false);
  if (process.argv.includes('--require-browser')) {
    assert.equal(settings.capabilities.browser.available, true);
    assert.equal(settings.capabilities.cssPreview.available, true);
  }
  const requests = await worker.evaluate(() => requests);
  assert.ok(requests.length > 0 && requests.every(r => r.url === 'http://127.0.0.1:5088/api/mcp-v2/settings' && r.method === 'GET'));
  const screenshot = resolve(root, `runtime/screenshots/mcp-v2-extension-readback-${stamp}.png`);
  await page.screenshot({ path: screenshot, fullPage: true });
  const result = { at: new Date().toISOString(), scope: 'isolated MV3 harness with exact production blocks, not the personal installed extension',
    hashes: Object.fromEntries(Object.entries({ transport, card, handler }).map(([k,v]) => [k, createHash('sha256').update(v).digest('hex')])),
    settings, text: await page.locator('.mcp-v2-settings').innerText(), requests, screenshot, productionExtensionReloaded: false };
  await writeFile(resolve(dir, 'result.json'), JSON.stringify(result, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ artifact: resolve(dir, 'result.json'), ...result }));
} finally { await context.close(); }
