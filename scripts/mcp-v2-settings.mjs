import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createClient, McpError } from '../skills/mcp-v2/scripts/client.mjs';
import { browserReadiness } from '../skills/mcp-v2/scripts/local-browser.mjs';

export const MCP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export class SettingsError extends Error {
  constructor(status, code, current = undefined) { super(code); this.status = status; this.code = code; this.current = current; }
}
export async function mcpReadiness(root = MCP_ROOT) {
  try { await createClient(root, { signal: AbortSignal.timeout(6000), discoverBrowser: false }); return { available: true, reason: null }; }
  catch (error) { return { available: false, reason: error instanceof McpError ? error.code : 'MCP_UNAVAILABLE' }; }
}
const fileFor = root => resolve(root, 'runtime/mcp-v2/settings.json');
async function readStored(root) {
  try {
    const state = JSON.parse(await readFile(fileFor(root), 'utf8'));
    if (typeof state.enabled !== 'boolean' || !Number.isSafeInteger(state.revision) || state.revision < 0) throw new Error('invalid');
    return { enabled: state.enabled, revision: state.revision };
  } catch (error) {
    if (error.code === 'ENOENT') return { enabled: false, revision: 0 };
    throw new SettingsError(500, 'MCP_SETTINGS_UNREADABLE');
  }
}
function publicState(state, readiness, browser = null) {
  // effectiveEngine describes the selected route, even when blocked. It never
  // advertises current-engine fallback for an unavailable ON selection.
  const available = readiness.available === true;
  return { ...state, effectiveEngine: state.enabled ? 'mcp-v2' : 'current', available, reason: available ? null : readiness.reason || 'MCP_UNAVAILABLE', capabilities: {
    remoteMcp: { available },
    // Remote MCP readiness, an installed bsk binary, or the engine toggle does
    // not verify the official browser adapter/profile or authorize CSS trials.
    // Enable these only through a separately reviewed verification contract.
    browser: { available: false, reason: 'BSK_OFFICIAL_ADAPTER_NOT_INSTALLED', verifiedAt: null, isolatedProfileVerified: false },
    cssPreview: { available: false, reason: 'BROWSER_NOT_VERIFIED' },
    ...(browser ? {
      browser: { available: browser.available, reason: browser.reason, verifiedAt: browser.verifiedAt, isolatedProfileVerified: browser.isolatedProfileVerified },
      cssPreview: { available: browser.available, reason: browser.available ? null : 'BROWSER_NOT_VERIFIED' },
    } : {}),
  } };
}
export async function readMcpSettings({ root = MCP_ROOT, readiness = mcpReadiness } = {}) {
  const [state, remote, browser] = await Promise.all([readStored(root), readiness(root), browserReadiness(root)]);
  return publicState(state, remote, browser);
}
// flock coordinates the web process and short-lived Native Messaging processes.
// The persistent lock file contains no state; the OS releases it on process exit.
async function acquire(root) {
  await mkdir(dirname(fileFor(root)), { recursive: true, mode: 0o700 });
  const child = spawn('flock', ['-x', '-w', '5', fileFor(root) + '.lock', process.execPath, '-e', 'process.stdout.write("locked\\n");process.stdin.resume();'], { stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.on('error', () => {});
  let settled = false;
  const closed = new Promise(done => child.once('close', done));
  await new Promise((done, fail) => {
    child.once('error', () => { settled = true; fail(new SettingsError(500, 'MCP_SETTINGS_LOCK_FAILED')); });
    child.once('exit', () => { if (!settled) fail(new SettingsError(503, 'MCP_SETTINGS_BUSY')); });
    child.stdout.once('data', () => { settled = true; done(); });
  });
  return async () => { child.stdin.end(); await closed; };
}
export async function updateMcpSettings(input, { root = MCP_ROOT, readiness = mcpReadiness } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !['enabled', 'expectedRevision'].includes(k)) || typeof input.enabled !== 'boolean' || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) throw new SettingsError(400, 'MCP_SETTINGS_INVALID');
  const release = await acquire(root);
  try {
    const current = await readStored(root);
    const [health, browser] = await Promise.all([readiness(root), browserReadiness(root)]);
    if (input.expectedRevision !== current.revision) throw new SettingsError(409, 'MCP_SETTINGS_CONFLICT', publicState(current, health, browser));
    if (input.enabled && health.available !== true) throw new SettingsError(503, health.reason || 'MCP_UNAVAILABLE', publicState(current, health, browser));
    if (current.enabled === input.enabled) return publicState(current, health, browser);
    const next = { enabled: input.enabled, revision: current.revision + 1 };
    const tmp = fileFor(root) + `.${randomUUID()}.tmp`;
    try { await writeFile(tmp, JSON.stringify(next) + '\n', { mode: 0o600, flag: 'wx' }); await rename(tmp, fileFor(root)); }
    catch { throw new SettingsError(500, 'MCP_SETTINGS_WRITE_FAILED'); }
    return publicState(next, health, browser);
  } finally { await release(); }
}
// One immutable snapshot per fresh review. OFF performs no MCP network request.
export async function snapshotMcpEngine({ root = MCP_ROOT, readiness = mcpReadiness } = {}) {
  const state = await readStored(root);
  if (!state.enabled) return Object.freeze({ enabled: false, revision: state.revision, effectiveEngine: 'current' });
  const [remote, browser] = await Promise.all([readiness(root), browserReadiness(root)]);
  const result = publicState(state, remote, browser);
  if (!result.available) throw new SettingsError(503, result.reason, result);
  return Object.freeze(result);
}
export async function settingsAction(method, input, options = {}) {
  try { return { status: 200, body: method === 'GET' ? await readMcpSettings(options) : method === 'PUT' ? await updateMcpSettings(input, options) : (() => { throw new SettingsError(405, 'METHOD_NOT_ALLOWED'); })() }; }
  catch (error) { return { status: error instanceof SettingsError ? error.status : 500, body: { error: error instanceof SettingsError ? error.code : 'MCP_SETTINGS_FAILED', ...(error instanceof SettingsError && error.current ? { current: error.current } : {}) } }; }
}
export async function nativeSettingsAction(message, options = {}) {
  if (!['mcp-v2-settings-get', 'mcp-v2-settings-set'].includes(message?.action)) return null;
  const result = await settingsAction(message.action === 'mcp-v2-settings-get' ? 'GET' : 'PUT', message.action === 'mcp-v2-settings-set' ? { enabled: message.enabled, expectedRevision: message.expectedRevision } : undefined, options);
  return { ok: result.status === 200, status: result.status, ...result.body };
}
