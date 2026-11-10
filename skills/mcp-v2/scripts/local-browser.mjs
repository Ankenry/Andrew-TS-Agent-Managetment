import { readFile, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createLocalBrowser, TS_LOCAL_BROWSER_TOOL } from '../vendor/ts-elite-mcp.mjs';
import { cssRules } from '../../check-ticket-v2/scripts/customize.mjs';
const exec = promisify(execFile);
export const ADAPTER_SHA256 = '0e69b859db4090de5d3a175cf9e19e88494665ba8d67dd89f32001f7ddc527c2';
export const browserTool = { ...TS_LOCAL_BROWSER_TOOL, inputSchema: { ...TS_LOCAL_BROWSER_TOOL.inputSchema,
  properties: Object.fromEntries(Object.entries(TS_LOCAL_BROWSER_TOOL.inputSchema.properties).filter(([key]) => !['browser', 'org_id'].includes(key))),
} };
export function bskRunner(root) {
  return async args => {
    const env = Object.fromEntries(['PATH', 'HOME', 'USER', 'LANG', 'XDG_RUNTIME_DIR'].filter(k => process.env[k]).map(k => [k, process.env[k]]));
    Object.assign(env, { BSK_HOME: resolve(root, 'runtime/mcp-v2/toolchain/bsk-home'), BSK_AUTO_START: '0', BSK_AUTO_UPDATE: 'off' });
    try {
      const result = await exec(resolve(root, 'runtime/mcp-v2/toolchain/bsk-v0.3.3/bsk'), [...args, '--json'], { env, timeout: args[0] === 'status' ? 5000 : 45000, maxBuffer: 4 * 1024 * 1024 });
      return JSON.parse(result.stdout);
    } catch { throw Error('Local bsk failed; check bsk doctor and browser extension. No retry performed.'); }
  };
}
export async function browserReadiness(root, { requireSmoke = true, runner = bskRunner(root) } = {}) {
  const unavailable = reason => ({ available: false, reason, verifiedAt: null, isolatedProfileVerified: false });
  let binding;
  try { await readFile(resolve(root, 'skills/mcp-v2/vendor/ts-elite-mcp.mjs')); }
  catch { return unavailable('BSK_OFFICIAL_ADAPTER_NOT_INSTALLED'); }
  try { binding = JSON.parse(await readFile(resolve(root, 'runtime/mcp-v2/browser-binding.json'), 'utf8')); }
  catch { return unavailable('BSK_DEDICATED_PROFILE_NOT_VERIFIED'); }
  try {
    if (binding.version !== 1 || !/^[a-f0-9]{8}$/.test(binding.instanceId) || binding.verification !== 'chrome-version-and-same-context-extension-storage' ||
      await realpath(binding.profilePath) !== await realpath(resolve(root, 'runtime/mcp-v2/browser-profile/Default'))) return unavailable('BSK_PROFILE_BINDING_INVALID');
    const stat = await readFile(`/proc/${binding.managerPid}/stat`, 'utf8');
    if (stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] !== binding.managerStartTicks) return unavailable('BSK_PROFILE_PROCESS_CHANGED');
    const adapter = await readFile(resolve(root, 'skills/mcp-v2/vendor/ts-elite-mcp.mjs'));
    if (createHash('sha256').update(adapter).digest('hex') !== ADAPTER_SHA256) return unavailable('BSK_ADAPTER_CHANGED');
    const status = await runner(['status']);
    const browser = status.browsers?.find(item => item.instance_id === binding.instanceId);
    if (!browser || browser.unresponsive || browser.version_skew || status.ws_port !== 52800 || browser.extension_version !== binding.extensionVersion) return unavailable('BSK_DEDICATED_BROWSER_OFFLINE');
    if (requireSmoke) {
      const smoke = JSON.parse(await readFile(resolve(root, 'runtime/mcp-v2/browser-smoke.json'), 'utf8'));
      if (smoke.instanceId !== binding.instanceId || smoke.adapterSha256 !== ADAPTER_SHA256 || smoke.profilePath !== binding.profilePath || smoke.cssVerified !== true || smoke.cleanupVerified !== true) return unavailable('BSK_SMOKE_NOT_VERIFIED');
    }
    return { available: true, reason: null, verifiedAt: binding.verifiedAt, isolatedProfileVerified: true, instanceId: binding.instanceId, profilePath: binding.profilePath };
  } catch { return unavailable(requireSmoke ? 'BSK_BROWSER_OR_SMOKE_UNAVAILABLE' : 'BSK_DEDICATED_BROWSER_UNAVAILABLE'); }
}

// Wrap the unmodified official adapter. The gateway cannot select another profile,
// ticket, organization, or expose Joy's write surface. Remote data is never code.
export async function localBrowserClient(root, { wire, definitions, ticketId, readiness = browserReadiness, runner = bskRunner(root), requireSmoke = true }) {
  const initial = await readiness(root, { requireSmoke, runner });
  if (!initial.available) throw Error(initial.reason);
  const remote = async message => ({ jsonrpc: '2.0', id: message.id, result: message.method === 'tools/list'
    ? { tools: definitions.filter(tool => tool.name !== 'joy_get_ticket') }
    : await wire.rpc(message.method, message.params || {}) });
  const local = createLocalBrowser(remote, { runner, logDirectory: resolve(root, 'runtime/mcp-v2/browser-events') });
  await local.handle({ jsonrpc: '2.0', id: randomUUID(), method: 'tools/list', params: {} });
  let cssCalls = 0; const sessions = new Map();
  return {
    async call(input) {
      const ready = await readiness(root, { requireSmoke, runner });
      if (!ready.available || ready.instanceId !== initial.instanceId) throw Error('BSK_PROFILE_BINDING_CHANGED');
      if (!ticketId || input.ticket_id && input.ticket_id !== ticketId) throw Error('MCP_TICKET_MISMATCH');
      if (Object.keys(input).some(k => !Object.hasOwn(browserTool.inputSchema.properties, k))) throw Error('MCP_BROWSER_ARGUMENT_FORBIDDEN');
      if (!browserTool.inputSchema.properties.action.enum.includes(input.action)) throw Error('MCP_BROWSER_ACTION_FORBIDDEN');
      if (input.action === 'try_css' && ++cssCalls > 4) throw Error('MCP_CSS_TRIAL_LIMIT');
      const args = { ...input, ticket_id: ticketId, ...(input.action === 'start' ? { browser: initial.instanceId } : {}) };
      const response = await local.handle({ jsonrpc: '2.0', id: randomUUID(), method: 'tools/call', params: { name: 'ts_local_browser', arguments: args } });
      const result = response.result;
      if (!result || result.isError) {
        const message = result?.content?.find(item => item.type === 'text')?.text || '';
        const error = Error('MCP_LOCAL_BROWSER_FAILED');
        error.reason = message.startsWith("URL is outside this ticket's store") ? 'STORE_BOUNDARY'
          : message.startsWith('Local bsk failed;') ? 'BSK_COMMAND_FAILED' : 'ADAPTER_REJECTED';
        throw error;
      }
      const data = JSON.parse(result.content.find(c => c.type === 'text').text);
      if (input.action === 'status' && data.browser?.browsers) data.browser.browsers = data.browser.browsers.filter(item => item.instance_id === initial.instanceId);
      if (input.action === 'start') sessions.set(data.session_id, {});
      const state = sessions.get(input.session_id);
      if (input.action === 'navigate' && state) state.url = input.url;
      if (input.action === 'emulate' && state) state.mobile = input.device !== 'off';
      if (input.action === 'stop') sessions.delete(input.session_id);
      return { data, content: result.content, ...(input.action === 'try_css' ? { trial: cssTrial(input.css, data, state) } : {}) };
    },
    async close() { await local.close(); },
  };
}
export function cssTrial(css, data, state = {}) {
  const norm = value => String(value).trim().toLowerCase().replace(/\s+/g, ' ').replace(/\s*,\s*/g, ',');
  const overridden = [], zeroSelectors = [], rows = [];
  for (const rule of cssRules(css)) {
    const selector = rule.head;
    const matches = (data.after || []).filter(item => norm(item.selector) === norm(selector));
    if (!matches.length) { zeroSelectors.push(selector); overridden.push({ selector, property: '*', reason: 'No matched element; CSS not verified' }); }
    for (const item of matches) for (const declaration of rule.declarations) {
      const property = declaration.property, expected = declaration.value.replace(/\s*!important\s*$/i, '');
      const actual = item.styles?.[property];
      const status = norm(actual) === norm(expected) ? 'ok' : 'overridden';
      rows.push({ selector, property, expected, computed: actual, status });
      if (status !== 'ok') overridden.push({ selector, property, expected, computed: actual });
    }
  }
  return { css, url: state.url, mobile: Boolean(state.mobile), before: data.before, after: data.after, rows, overridden, zeroSelectors,
    unusable: data.temporary !== true || !rows.length || zeroSelectors.length > 0, provider: 'ts_local_browser', verification: 'client_reported' };
}
