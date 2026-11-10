// Authorized deployment smoke only. Does not change engine settings or shop data.
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createClient } from '../skills/mcp-v2/scripts/client.mjs';
import { ADAPTER_SHA256, bskRunner } from '../skills/mcp-v2/scripts/local-browser.mjs';
const root = resolve(import.meta.dirname, '..');
const ticketId = process.argv[2];
if (!/^[A-Z]{2,10}-\d{6}-[A-Za-z0-9]{6}$/.test(ticketId || '')) throw Error('A canonical ticket is required');
const binding = JSON.parse(await readFile(resolve(root, 'runtime/mcp-v2/browser-binding.json'), 'utf8'));
const client = await createClient(root, { ticketId, browserOptions: { requireSmoke: false } });
const receipt = { at: new Date().toISOString(), ticketId, instanceId: binding.instanceId, profilePath: binding.profilePath, adapterSha256: ADAPTER_SHA256, steps: [] };
let sessionId, app;
const call = async (action, args = {}) => {
  const result = await client.call('ts_local_browser', { action, ...(sessionId ? { session_id: sessionId } : {}), ...args }, app);
  receipt.steps.push({ action, data: result.data, ...(result.trial ? { trial: result.trial } : {}) });
  return result;
};
try {
  const ticket = await client.call('ts_get_ticket'); app = ticket.data.app;
  const domain = ticket.data.ticket.storeDomains.find(value => value.endsWith('.myshopify.com'));
  const opened = await call('start'); sessionId = opened.data.session_id;
  try { await call('navigate', { url: 'https://example.com/' }); throw Error('Cross-store URL unexpectedly accepted'); }
  catch (error) { if (error.code !== 'MCP_LOCAL_BROWSER_FAILED') throw error; receipt.crossStoreRejected = true; }
  await call('navigate', { url: `https://${domain}/` });
  await call('snapshot');
  const css = 'html body { opacity: 0.99; }';
  const trial = await call('try_css', { css });
  receipt.cssVerified = trial.trial?.unusable === false && trial.trial.rows.length > 0 && trial.trial.overridden.length === 0;
  const shot = await call('screenshot');
  if (shot.images?.[0]) {
    const filename = `runtime/screenshots/mcp-v2-smoke-${ticketId}-${Date.now()}.png`;
    await writeFile(resolve(root, filename), Buffer.from(shot.images[0].data, 'base64'), { mode: 0o600, flag: 'wx' });
    receipt.screenshot = filename;
  }
  await call('clear_css');
  await call('stop'); sessionId = null;
} catch (error) { receipt.error = error.code || 'SMOKE_FAILED'; receipt.reason = error.reason; }
finally { await client.close(); }
const status = await bskRunner(root)(['status']);
receipt.cleanupVerified = status.browsers?.find(item => item.instance_id === binding.instanceId)?.session_count === 0;
const path = resolve(root, `runtime/mcp-v2/deployment/smoke-${ticketId}-${Date.now()}.json`);
await writeFile(path, JSON.stringify(receipt, null, 2), { mode: 0o600, flag: 'wx' });
if (receipt.cssVerified && receipt.cleanupVerified && !receipt.error) await writeFile(resolve(root, 'runtime/mcp-v2/browser-smoke.json'), JSON.stringify(receipt, null, 2), { mode: 0o600 });
console.log(JSON.stringify({ at: receipt.at, ticketId, path, cssVerified: receipt.cssVerified, cleanupVerified: receipt.cleanupVerified, error: receipt.error, reason: receipt.reason, screenshot: receipt.screenshot }));
if (receipt.error || !receipt.cssVerified || !receipt.cleanupVerified) process.exitCode = 1;
