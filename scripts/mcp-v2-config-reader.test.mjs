import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient, shopConfigTool } from '../skills/mcp-v2/scripts/client.mjs';
import { createConfigReader } from '../skills/check-ticket-v2/scripts/config-reader.mjs';
import { scoreQuote } from '../skills/check-ticket-v2/scripts/verify.mjs';
import { checkGap, verifyFindings } from '../skills/check-ticket-v2/scripts/verify.mjs';
import { hasSettingsFinding } from '../skills/check-ticket-v2/scripts/shop-settings.mjs';
import { evidenceLog } from '../skills/mcp-v2/scripts/engine.mjs';

const ticketId = 'TRAK-261029-fixture', shop = 'bound-shop.myshopify.com', app = 'order-tracking';
const config = { readTools: { ts_list_apps: { scope: 'catalog', kind: 'document' }, ts_app_playbook: { scope: 'app', kind: 'document', appArgument: 'app' }, ts_get_ticket: { scope: 'ticket', kind: 'observation' } } };
const definitions = Object.keys(config.readTools).map(name => ({ name, inputSchema: { type: 'object', properties: name === 'ts_get_ticket' ? { ticket_id: { type: 'string' } } : name === 'ts_app_playbook' ? { app: { type: 'string' } } : {} } }));
function fixtureRoot() {
  const root = mkdtempSync(join(tmpdir(), 'mcp-config-'));
  writeFileSync(join(root, '.env_my'), 'DEVZONE_API_KEY=fixture-devzone-key\n', { mode: 0o600 });
  return root;
}
async function gateway(root, ticket = { app, ticket: { ticketId, storeDomains: [shop] }, comments_available: true }) {
  const calls = [];
  const client = await createClient(root, { ticketId, discoverBrowser: false,
    loadConnection: async () => ({ config, key: 'fixture-mcp-key' }), transport: {
      initialize: async () => {}, rpc: async (method, args) => {
        if (method === 'tools/list') return { tools: [...definitions, { name: 'ts_write_shop', inputSchema: {} }] };
        calls.push(args);
        assert.equal(args.name, 'ts_get_ticket');
        return { structuredContent: ticket };
      },
    },
  });
  return { client, calls };
}
test('current reader and MCP config operation return the same bound sanitized observation', async t => {
  const root = fixtureRoot(); let fetches = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    fetches++;
    assert.equal(url, 'https://order-tracking-2667e.firebaseapp.com/api/v1/settings');
    assert.equal(options.headers['X-Shop-Domain'], shop); assert.equal(options.method, 'GET');
    return new Response(JSON.stringify({ data: { enabled: false, password: 'do-not-log' } }));
  });
  const direct = await createConfigReader({ root }).read({ app, shop, allowedShops: [shop], ticketId, path: 'enabled' });
  const { client, calls } = await gateway(root);
  assert.equal(client.tools.some(tool => tool.name === 'ts_shop_settings'), true);
  assert.equal(client.tools.some(tool => tool.name === 'ts_write_shop'), false);
  const result = await client.call('ts_shop_settings', { path: 'enabled' }, app);
  assert.equal(result.data.ok, true); assert.equal(result.data.observations[0].value, direct.observations[0].value);
  assert.equal(result.kind, 'observation'); assert.match(result.ref, /^mcp-v2:order-tracking\//);
  assert.equal(result.output.includes('do-not-log'), false);
  assert.equal(calls.length, 1); assert.equal(calls[0].arguments.ticket_id, ticketId);
  assert.equal(fetches, 2);
  const score = scoreQuote({ quote: 'enabled = false', source: { type: 'tool', ref: result.ref } }, { toolLog: [evidenceLog(result)] });
  assert.ok(score.score >= 0.6);
  const verified = verifyFindings({ findings: [{ id: 'F1', kind: 'fact', claim: 'Feature disabled', quote: 'enabled = false', source: { type: 'tool', ref: result.ref } }] }, { toolLog: [evidenceLog(result)], ticketText: '' });
  assert.equal(hasSettingsFinding(verified.findings), true);
  const forged = verifyFindings({ findings: [{ id: 'F2', kind: 'fact', shop_config_observation: true, claim: 'Feature disabled', quote: 'enabled = false', source: { type: 'tool', ref: 'mcp-v2:other/missing' } }] }, { toolLog: [evidenceLog(result)], ticketText: '' });
  assert.equal(hasSettingsFinding(forged.findings), false);
  await client.close();
});
test('MCP config rejects app/tenant changes and arbitrary arguments before configuration network calls', async t => {
  let reads = 0; t.mock.method(globalThis, 'fetch', async () => { reads++; throw Error('must not fetch'); });
  const root = fixtureRoot();
  const { client } = await gateway(root);
  for (const args of [{ url: 'https://evil.test' }, { shop: 'other.myshopify.com' }, { path: 1 }, { source: 'storefront' }]) {
    await assert.rejects(client.call('ts_shop_settings', args, app), { code: 'MCP_ARGUMENTS_INVALID' });
  }
  await assert.rejects(client.call('ts_shop_settings', {}, 'wishlist'), { code: 'MCP_APP_MISMATCH' });
  for (const ticket of [
    { app, ticket: { ticketId: 'TRAK-261029-other', storeDomains: [shop] } },
    { app, ticket: { ticketId, storeDomains: [shop, 'ambiguous.myshopify.com'] } },
  ]) {
    const bound = await gateway(root, ticket);
    await assert.rejects(bound.client.call('ts_shop_settings', {}, app));
  }
  assert.equal(reads, 0);
  assert.equal(shopConfigTool.inputSchema.additionalProperties, false);
});

test('a failed reviewed config operation supports an access gap, not an observed setting', () => {
  const gap = { kind: 'gap', claim: 'chưa đọc được cấu hình shop', blocker: 'shop_access' };
  assert.equal(checkGap(gap, [{ tool: 'mcp_v2_read', args: { tool: 'ts_shop_settings' }, ok: false }]).ok, true);
  assert.equal(checkGap(gap, []).ok, false);
});
