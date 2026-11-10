#!/usr/bin/env node
// Manual read-only preview; reads the ticket anew, never accepts an arbitrary shop.
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { readEvidence } from '../skills/check-ticket/scripts/adapters.mjs';
import { detectApp } from '../skills/check-ticket-v2/scripts/prepare.mjs';
import { createConfigReader, formatConfigReport } from '../skills/check-ticket-v2/scripts/config-reader.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export async function main(argv) {
  const [ticketId, ...rest] = argv;
  if (!ticketId || !/^[A-Z]+-\d{6}-[A-Za-z0-9]+$/.test(ticketId)) throw new Error('Usage: node scripts/shop-settings.mjs TICKET [--path key] [--engine current|mcp-v2] [--json]');
  const options = { path: '', engine: 'current', json: false };
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--json') options.json = true;
    else if (['--path', '--engine'].includes(rest[i]) && rest[i + 1] !== undefined) options[rest[i].slice(2)] = rest[++i];
    else throw new Error('INVALID_ARGUMENT');
  }
  if (!['current', 'mcp-v2'].includes(options.engine)) throw new Error('INVALID_ENGINE');
  const ticket = await readEvidence(ticketId);
  const app = detectApp({ appName: ticket.appName, reference: ticketId, subject: ticket.subject }, root).slug;
  if (!app) throw new Error('APP_UNRESOLVED');
  let report;
  if (options.engine === 'mcp-v2') {
    const { createClient } = await import('../skills/mcp-v2/scripts/client.mjs');
    const client = await createClient(root, { ticketId, discoverBrowser: false });
    try { report = (await client.call('ts_shop_settings', { path: options.path }, app)).data; }
    finally { await client.close(); }
  } else {
    const shops = (ticket.storeDomains || []).filter(s => /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(s));
    if (new Set(shops).size !== 1) throw new Error('CANONICAL_SHOP_AMBIGUOUS');
    report = await createConfigReader({ root }).read({ app, shop: shops[0], path: options.path, ticketId, allowedShops: shops });
  }
  console.log(options.json ? JSON.stringify(report, null, 2) : formatConfigReport(report));
  return report.ok ? 0 : 1;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(error => {
    console.error(/^[A-Z_]+$/.test(error.code || error.message) ? (error.code || error.message) : 'CONFIG_PREVIEW_FAILED');
    process.exitCode = 1;
  });
}
