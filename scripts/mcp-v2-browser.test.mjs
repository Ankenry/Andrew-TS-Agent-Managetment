import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localBrowserClient, cssTrial, browserTool, browserReadiness, ADAPTER_SHA256 } from '../skills/mcp-v2/scripts/local-browser.mjs';
import { cssTrialsFromLog, cssTrialProblems } from '../skills/check-ticket-v2/scripts/customize.mjs';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'mcp-browser-locks-'));
  const calls = []; let binding = '1234abcd';
  const readiness = async () => ({ available: true, instanceId: binding });
  const runner = async args => {
    calls.push(args);
    if (args[0] === 'status') return { browsers: [{ instance_id: '1234abcd' }, { instance_id: 'personal-browser' }] };
    if (args[0] === 'session' && args[1] === 'start') return { session_id: 'owned-session' };
    if (args[0] === 'navigate') return { final_url: args.at(-1) };
    if (args[0] === 'evaluate') return { value: 'https://fixture.myshopify.com/' };
    return { ok: true };
  };
  const wire = { rpc: async (method, params) => {
    assert.equal(method, 'tools/call'); assert.equal(params.name, 'ts_get_ticket');
    return { content: [{ type: 'text', text: JSON.stringify({ ticket: { ticketId: 'AIR-261028-abcdef', storeDomains: ['fixture.myshopify.com'] } }) }] };
  } };
  const client = await localBrowserClient(root, { wire, definitions: [{ name: 'ts_get_ticket' }], ticketId: 'AIR-261028-abcdef', readiness, runner });
  return { client, calls, changeBinding() { binding = '8765abcd'; } };
}

test('only verified dedicated instance is passed to official adapter, never the personal/default browser', async () => {
  const { client, calls } = await fixture();
  try {
    const started = await client.call({ action: 'start' });
    assert.equal(started.data.session_id, 'owned-session');
    const command = calls.find(c => c[0] === 'session' && c[1] === 'start');
    assert.ok(command.includes('--browser=1234abcd'));
    const status = await client.call({ action: 'status' });
    assert.deepEqual(status.data.browser.browsers, [{ instance_id: '1234abcd' }]);
    await assert.rejects(client.call({ action: 'start', browser: 'personal-browser' }), /ARGUMENT_FORBIDDEN/);
  } finally { await client.close(); }
  assert.deepEqual(calls.at(-1), ['session', 'stop', 'owned-session']);
});

test('readiness requires a live pinned profile, unchanged adapter, successful CSS and cleanup receipt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mcp-browser-readiness-'));
  const campaign = join(root, 'runtime/mcp-v2');
  const vendor = join(root, 'skills/mcp-v2/vendor/ts-elite-mcp.mjs');
  await mkdir(join(root, 'skills/mcp-v2/vendor'), { recursive: true });
  await copyFile(new URL('../skills/mcp-v2/vendor/ts-elite-mcp.mjs', import.meta.url), vendor);
  await mkdir(join(campaign, 'browser-profile/Default'), { recursive: true });
  const stat = await readFile(`/proc/${process.pid}/stat`, 'utf8');
  const binding = { version: 1, instanceId: '1234abcd', extensionVersion: '0.3.3', managerPid: process.pid,
    managerStartTicks: stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19],
    verification: 'chrome-version-and-same-context-extension-storage', profilePath: join(campaign, 'browser-profile/Default'), verifiedAt: new Date().toISOString() };
  const smoke = { instanceId: binding.instanceId, adapterSha256: ADAPTER_SHA256, profilePath: binding.profilePath, cssVerified: true, cleanupVerified: true };
  const bind = value => writeFile(join(campaign, 'browser-binding.json'), JSON.stringify(value));
  const receipt = value => writeFile(join(campaign, 'browser-smoke.json'), JSON.stringify(value));
  const runner = async () => ({ ws_port: 52800, browsers: [{ instance_id: binding.instanceId, extension_version: '0.3.3' }] });
  await bind(binding); await receipt(smoke);
  assert.equal((await browserReadiness(root, { runner })).available, true);
  await receipt({ ...smoke, cleanupVerified: false });
  assert.equal((await browserReadiness(root, { runner })).reason, 'BSK_SMOKE_NOT_VERIFIED');
  await receipt(smoke); await bind({ ...binding, managerStartTicks: '0' });
  assert.equal((await browserReadiness(root, { runner })).reason, 'BSK_PROFILE_PROCESS_CHANGED');
  await bind(binding);
  assert.equal((await browserReadiness(root, { runner: async () => ({ ws_port: 52800, browsers: [{ instance_id: 'personal-browser', extension_version: '0.3.3' }] }) })).available, false);
  await writeFile(vendor, 'unreviewed adapter');
  assert.equal((await browserReadiness(root, { runner })).reason, 'BSK_ADAPTER_CHANGED');
});
test('ticket mismatch, foreign session, foreign store, and write actions never reach browser execution', async () => {
  const { client, calls } = await fixture();
  try {
    await assert.rejects(client.call({ action: 'start', ticket_id: 'AIR-261028-ghijkl' }), /TICKET_MISMATCH/);
    await client.call({ action: 'start' });
    await assert.rejects(client.call({ action: 'navigate', session_id: 'owned-session', url: 'https://example.com/' }), /LOCAL_BROWSER_FAILED/);
    await assert.rejects(client.call({ action: 'navigate', session_id: 'foreign-session', url: 'https://fixture.myshopify.com/' }), /LOCAL_BROWSER_FAILED/);
    await assert.rejects(client.call({ action: 'click', session_id: 'owned-session' }), /ACTION_FORBIDDEN/);
    assert.equal(calls.some(c => ['navigate', 'click', 'fill', 'press', 'evaluate'].includes(c[0])), false);
    await client.call({ action: 'navigate', session_id: 'owned-session', url: 'https://fixture.myshopify.com/' });
    assert.equal(calls.filter(c => c[0] === 'navigate').length, 1);
  } finally { await client.close(); }
});
test('a changed profile binding stops calls while cleanup still closes only owned sessions', async () => {
  const f = await fixture(); await f.client.call({ action: 'start' }); f.changeBinding();
  await assert.rejects(f.client.call({ action: 'snapshot', session_id: 'owned-session' }), /BINDING_CHANGED/);
  await f.client.close(); assert.deepEqual(f.calls.at(-1), ['session', 'stop', 'owned-session']);
});
test('CSS evidence passes the existing final-block verifier only for measured matching properties', () => {
  const css = 'html body { opacity: 0.99; }';
  const trial = cssTrial(css, { temporary: true, after: [{ selector: 'html body', styles: { opacity: '0.99' } }] }, { url: 'https://fixture.myshopify.com/' });
  const log = [{ tool: 'mcp_v2_read', args: { tool: 'ts_local_browser', arguments: { action: 'try_css' } }, trial, ok: true, seq: 1 }];
  assert.equal(trial.unusable, false); assert.equal(trial.overridden.length, 0);
  assert.equal(cssTrialsFromLog(log).length, 1);
  assert.deepEqual(cssTrialProblems([{ code: css, code_lang: 'css' }], { cssTrials: cssTrialsFromLog(log), browserAllowed: true, budgetLeft: 3 }), []);
  assert.ok(cssTrialProblems([{ code: 'html body { opacity: 0.5; }', code_lang: 'css' }], { cssTrials: cssTrialsFromLog(log), browserAllowed: true, budgetLeft: 3 }).length);
  assert.ok(cssTrial(css, { temporary: true, after: [] }).overridden.length);
  assert.ok(cssTrial(css, { temporary: true, after: [{ selector: 'html body', styles: { opacity: '1' } }] }).overridden.length);
  assert.equal(browserTool.inputSchema.properties.browser, undefined);
  assert.equal(browserTool.inputSchema.properties.action.enum.includes('evaluate'), false);
});
