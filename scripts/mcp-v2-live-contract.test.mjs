import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createClient, decodeMcpData, matchApp } from '../skills/mcp-v2/scripts/client.mjs';
import { scoreQuote, verifyLink, checkGap } from '../skills/check-ticket-v2/scripts/verify.mjs';

const config = JSON.parse(await readFile(new URL('../skills/mcp-v2/connection.json', import.meta.url)));
const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const str = { type: 'string' };
const schemas = {
  ts_get_ticket: obj({ ticket_id: { ...str, pattern: '^[A-Za-z0-9_-]{1,100}$' } }, ['ticket_id']),
  ts_list_apps: obj({}),
  ts_app_playbook: obj({ app: str }, ['app']),
  ts_read_tools: obj({ app: str }, ['app']),
  ts_app_read: obj({ app: str, tool: str, arguments: { type: 'object' } }, ['app', 'tool', 'arguments']),
  ts_kb_search: obj({ app: str, query: str }, ['query']),
  ts_knowledge_list: obj({ app: str }, ['app']),
  ts_knowledge_read: obj({ path: str }, ['path']),
};
const readTools = [
  { name: 'GitLabResearch', parameters: obj({ app: str, action: str, file: str }, ['app', 'action']) },
  { name: 'AirReviewsAction', parameters: obj({ action: { ...str, enum: ['get-settings', 'update-settings'] }, domain: str }, ['action', 'domain']) },
  { name: 'CrmGet', parameters: obj({ path: str }, ['path']) },
];
async function fixture() {
  const calls = [];
  const root = await mkdtemp(resolve(tmpdir(), 'mcp-remote-contract-'));
  const client = await createClient(root, { ticketId: 'AIR-261013-cSz4B8', loadConnection: async () => ({ config, key: 'private-test-key' }), transport: {
    initialize: async () => {}, rpc: async (method, args) => {
      if (method === 'tools/list') return { tools: [...Object.entries(schemas).map(([name, inputSchema]) => ({ name, inputSchema })), { name: 'ts_claim_turn' }, { name: 'ts_local_browser' }] };
      calls.push(args);
      const value = args.name === 'ts_read_tools' ? JSON.stringify(readTools) : args.name === 'ts_knowledge_list' ? { app_guides: [{ path: `app-guides/${args.arguments.app}.md` }] } : { ok: true };
      return { content: [{ type: 'text', text: JSON.stringify(value) }] };
    },
  } });
  return { client, calls };
}
test('live nested text envelopes decode as data and extra server tools stay unexposed', async () => {
  assert.deepEqual(decodeMcpData({ content: [{ type: 'text', text: JSON.stringify(JSON.stringify(readTools)) }] }), readTools);
  const { client } = await fixture();
  assert.deepEqual(client.tools.map(t => t.name).sort(), [...Object.keys(config.readTools), 'ts_shop_settings'].sort());
  await assert.rejects(client.call('ts_claim_turn', {}), { code: 'MCP_TOOL_FORBIDDEN' });
  await assert.rejects(client.call('ts_local_browser', {}), { code: 'MCP_TOOL_FORBIDDEN' });
});
test('ticket and KB calls remain bound to the admitted ticket and app', async () => {
  const { client, calls } = await fixture();
  await client.call('ts_get_ticket');
  assert.equal(calls.at(-1).arguments.ticket_id, 'AIR-261013-cSz4B8');
  const before = calls.length;
  await assert.rejects(client.call('ts_get_ticket', { ticket_id: 'JOY-261013-Other' }), { code: 'MCP_TICKET_MISMATCH' });
  await assert.rejects(client.call('ts_kb_search', { app: 'joy', query: 'test' }, 'air-reviews'), { code: 'MCP_APP_MISMATCH' });
  assert.equal(calls.length, before);
});
test('knowledge reads accept only paths returned for the locked app', async () => {
  const { client, calls } = await fixture();
  await client.call('ts_knowledge_read', { path: 'app-guides/air-reviews.md' }, 'air-reviews');
  assert.equal(calls[0].name, 'ts_knowledge_list');
  const before = calls.length;
  for (const path of ['app-guides/joy.md', '../../.env_my']) await assert.rejects(client.call('ts_knowledge_read', { path }, 'air-reviews'), { code: 'MCP_DOCUMENT_FORBIDDEN' });
  assert.equal(calls.length, before);
});
test('nested read schema locks app, enforces actions and rejects undeclared arguments', async () => {
  const { client, calls } = await fixture();
  const r = await client.call('ts_app_read', { tool: 'GitLabResearch', arguments: { action: 'read', file: 'index.js' } }, 'air-reviews');
  assert.equal(calls.at(-1).arguments.arguments.app, 'air-reviews');
  assert.equal(r.kind, 'document');
  await client.call('ts_app_read', { tool: 'AirReviewsAction', arguments: { action: 'get-settings', domain: 'example.myshopify.com' } }, 'air-reviews');
  const before = calls.length;
  for (const args of [
    { tool: 'GitLabResearch', arguments: { action: 'read', app: 'joy' } },
    { tool: 'GitLabResearch', arguments: { action: 'push' } },
    { tool: 'AirReviewsAction', arguments: { action: 'update-settings', domain: 'example.myshopify.com' } },
    { tool: 'AirReviewsAction', arguments: { action: 'get-settings', domain: 'example.myshopify.com', css: 'x' } },
    { tool: 'CrmGet', arguments: { path: '/unknown' } },
  ]) await assert.rejects(client.call('ts_app_read', args, 'air-reviews'));
  assert.equal(calls.length, before);
});
test('disabled and internal catalog entries cannot become a ticket app', () => {
  for (const row of [{ slug: 'x', disabled: true }, { slug: 'x', internal: true }]) assert.throws(() => matchApp([row], ['x']), { code: 'MCP_APP_UNAVAILABLE' });
});
test('ticket storefront passwords are hidden before evidence or model output', async () => {
  const client = await createClient('', { ticketId: 'AIR-261013-cSz4B8', loadConnection: async () => ({ config, key: 'private-test-key' }), transport: {
    initialize: async () => {}, rpc: async (method) => method === 'tools/list'
      ? { tools: Object.entries(schemas).map(([name, inputSchema]) => ({ name, inputSchema })) }
      : { content: [{ type: 'text', text: JSON.stringify({ ticket: { description: 'Storefront password: secret-store-pass' }, comments: [{ metadata: { content: 'Password: another-store-pass' } }] }) }] },
  } });
  const result = await client.call('ts_get_ticket');
  assert.ok(!JSON.stringify(result).includes('secret-store-pass'));
  assert.ok(!JSON.stringify(result).includes('another-store-pass'));
  assert.match(result.output, /storefront password hidden/);
});
test('GitLab multiline source quotes ignore numeric line labels without widening observation evidence', () => {
  const entry = { tool: 'mcp_v2_read', ok: true, args: { tool: 'ts_app_read', arguments: { tool: 'GitLabResearch', arguments: { action: 'read' } } }, evidence: { ref: 'mcp-v2:air-reviews/file', kind: 'document' }, output: '12: const x = settings.hide;\n13: if (x) return null;\n14: return widget;' };
  const finding = { quote: 'const x = settings.hide;\nif (x) return null;', source: { ref: entry.evidence.ref }, link: { cause_quote: 'const x = settings.hide;\nif (x) return null;', effect_quote: 'return widget;' } };
  assert.equal(scoreQuote(finding, { toolLog: [entry] }).score, 0.9);
  assert.equal(verifyLink(finding, { toolLog: [entry] }).verified, true);
  assert.equal(scoreQuote({ ...finding, source: { ref: 'mcp-v2:air-reviews/other' } }, { toolLog: [entry] }).score, 0);
  assert.equal(scoreQuote(finding, { toolLog: [{ ...entry, args: { tool: 'ts_app_read', arguments: { tool: 'AirReviewsAction' } }, evidence: { ...entry.evidence, kind: 'observation' } }] }).score, 0);
});
test('a failed MCP settings read supports an access gap without pretending the setting was read', () => {
  const gap = { kind: 'gap', claim: 'chưa đọc được cấu hình shop', blocker: 'shop_access' };
  const call = { tool: 'mcp_v2_read', ok: false, args: { tool: 'ts_app_read', arguments: { tool: 'StorefrontSource', arguments: { grep: 'AVADA_WISHLIST' } } } };
  assert.equal(checkGap(gap, [call]).ok, true);
  assert.equal(checkGap(gap, []).ok, false);
  assert.equal(checkGap(gap, [{ ...call, args: { tool: 'ts_app_read', arguments: { tool: 'StorefrontSource', arguments: { grep: 'button' } } } }]).ok, false);
});
test('MCP JSON multiline quotes match one decoded value, never invented joins between fields', () => {
  const ref = 'mcp-v2:air-reviews/ticket';
  const entry = { tool: 'mcp_v2_read', ok: true, evidence: { ref, kind: 'observation' }, output: `[nguồn: ${ref}]\n[đọc lúc: 2026-10-27T09:00:00.000Z]\n${JSON.stringify({ first: 'one line\nsecond line', second: 'different field' })}` };
  const finding = { source: { ref }, quote: 'one line\nsecond line' };
  assert.equal(scoreQuote(finding, { toolLog: [entry] }).score, 0.6);
  assert.equal(scoreQuote({ ...finding, quote: 'second line\ndifferent field' }, { toolLog: [entry] }).score, 0);
  assert.equal(verifyLink({ ...finding, link: { cause_quote: 'one line\nsecond line', effect_quote: 'different field' } }, { toolLog: [entry] }).verified, false);
});
test('actual tool server hides and refuses standalone browser and direct read fallbacks in MCP mode', async () => {
  const dir = await mkdtemp(resolve(tmpdir(), 'mcp-contract-'));
  await writeFile(resolve(dir, 'prepare.json'), JSON.stringify({ mcpV2: { app: 'air-reviews', ticketId: 'AIR-261013-cSz4B8', tools: [] }, ticket: {}, app: {}, scope: {} }));
  const child = spawn(process.execPath, ['skills/check-ticket-v2/scripts/tools-server.mjs'], { env: { ...process.env, V2_ROOT: process.cwd(), V2_JOB_DIR: dir, V2_MCP_ENGINE: '1', V2_BROWSER_ALLOWED: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = ''; let errors = '';
  child.stdout.on('data', b => { output += b; }); child.stderr.on('data', b => { errors += b; });
  const done = new Promise((ok, bad) => { child.on('error', bad); child.on('close', code => code === 0 ? ok() : bad(Error(errors))); });
  child.stdin.end([JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }), ...['browser_check', 'css_preview', 'shop_settings', 'source_read', 'crisp_read'].map((name, i) => JSON.stringify({ jsonrpc: '2.0', id: i + 2, method: 'tools/call', params: { name, arguments: {} } }))].join('\n') + '\n');
  await done;
  const replies = output.trim().split('\n').map(s => JSON.parse(s));
  assert.deepEqual(replies.find(r => r.id === 1).result.tools.map(t => t.name), ['mcp_v2_read', 'submit_findings']);
  for (const r of replies.filter(r => r.id !== 1)) assert.equal(r.result.isError, true);
  assert.equal(replies.length, 6);
});
