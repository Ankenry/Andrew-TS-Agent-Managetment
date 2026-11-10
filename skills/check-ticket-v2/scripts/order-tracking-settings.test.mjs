import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DEVZONE_APIS } from './shop-settings.mjs';

const server = fileURLToPath(new URL('./tools-server.mjs', import.meta.url));

test('SUN settings uses the read-only settings endpoint, not the default-creating email endpoint', () => {
  assert.deepEqual(DEVZONE_APIS['order-tracking'], {
    base: 'https://order-tracking-2667e.firebaseapp.com/api/v1', settings: '/settings', extra: [],
  });
});

test('SUN shop_settings reaches the authenticated GET API, narrows email languages and keeps credentials out of artifacts', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sun-settings-'));
  const job = join(root, 'job'); mkdirSync(job);
  const fakeKey = 'dk_live_test_only_do_not_log_123456';
  writeFileSync(join(root, '.env_my'), `DEVZONE_API_KEY_ORDER_TRACKING=${fakeKey}\n`);
  writeFileSync(join(job, 'prepare.json'), JSON.stringify({ ticket: { storeDomains: ['test-sun.myshopify.com'] } }));
  const fetchMock = join(root, 'fetch-mock.mjs');
  writeFileSync(fetchMock, `
    import assert from 'node:assert/strict';
    globalThis.fetch = async (url, options) => {
      assert.equal(url, 'https://order-tracking-2667e.firebaseapp.com/api/v1/settings');
      assert.equal(options.method || 'GET', 'GET');
      assert.equal(options.body, undefined);
      assert.equal(options.headers['X-Shop-Domain'], 'test-sun.myshopify.com');
      assert.equal(options.headers['X-DevZone-Key'], ${JSON.stringify(fakeKey)});
      return new Response(JSON.stringify({success: true, data: {
        email: {languages: {autoTranslateEnabled: true, defaultLanguage: 'es',
          translations: {es: {fixedLabels: {trackingInfo: 'Información de seguimiento'}}}},
          senderEmail: 'private@example.com', smtpPassword: 'never-output-this'},
        trackingPage: {}, alerts: null
      }}), {status: 200});
    };
  `);
  const child = spawn(process.execPath, ['--import', pathToFileURL(fetchMock).href, server], {
    env: { ...process.env, V2_ROOT: root, V2_JOB_DIR: job, V2_APP: 'order-tracking',
      V2_SHOP_SETTINGS_KEY_FILE: join(root, '.env_my'), V2_MAX_SHOP_SETTINGS: '3',
      SOURCE_API_ENABLED: '0', V2_BROWSER_ALLOWED: '0' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let output = ''; let stderr = '';
  const received = new Promise(resolve => child.stdout.on('data', chunk => { output += chunk; if (output.includes('\n')) resolve(); }));
  child.stderr.on('data', chunk => { stderr += chunk; });
  const closed = new Promise(resolve => child.on('close', resolve));
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
    name: 'shop_settings', arguments: { source: 'api', path: 'email.languages' },
  } }) + '\n');
  const timer = setTimeout(() => child.kill('SIGTERM'), 15000);
  try {
    await Promise.race([received, closed]);
    child.stdin.end();
    assert.equal(await closed, 0, stderr);
    const result = JSON.parse(output.trim()).result;
    assert.notEqual(result.isError, true);
    const text = result.content[0].text;
    assert.match(text, /settings:order-tracking\/api/);
    assert.match(text, /email.languages.autoTranslateEnabled = true/);
    assert.match(text, /email.languages.defaultLanguage = "es"/);
    assert.match(text, /email.languages.translations.es.fixedLabels.trackingInfo = "Información de seguimiento"/);
    const artifacts = output + stderr + readFileSync(join(job, 'tool-log.jsonl'), 'utf8');
    for (const secret of [fakeKey, 'private@example.com', 'never-output-this']) {
      assert.equal(artifacts.includes(secret), false, 'sensitive values must not leave the API reader');
    }
  } finally { clearTimeout(timer); }
});
