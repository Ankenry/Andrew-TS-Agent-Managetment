// Runs one Codex exec turn for check-ticket-v2. Same discipline as skills/check-ticket/scripts/worker.mjs:
// filtered environment, GNU timeout around the process, --ephemeral, read-only sandbox, prompt on stdin,
// --output-schema + --output-last-message for the final answer. The investigate phase adds the MCP tools
// server (tools-server.mjs) with per-call approval disabled; the writer runs with no MCP server at all.

import { writeFile, readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { DeadlineError } from '../../check-ticket/scripts/core.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const TOOLS_SERVER = resolve(HERE, 'tools-server.mjs');
const SECRET_ENV = /API_KEY|API_AVADA|SLACK_TOKEN|TELEGRAM|TS_ELITE|Andrew_TS2_Keys|UPLOAD_TOKEN|BEARER|SECRET|PASSWORD|_PIN\b|DATABASE_URL|PG(USER|PASS)/i;

export function filteredEnv(extra = {}) {
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (SECRET_ENV.test(name)) delete env[name];
  return { ...env, ...extra };
}

const toml = value => JSON.stringify(String(value));

export function mcpOverrides(serverEnv) {
  const table = Object.entries(serverEnv).map(([key, value]) => `${key}=${toml(value)}`).join(', ');
  return [
    '-c', 'mcp_servers.v2.enabled=true',
    '-c', `mcp_servers.v2.command=${toml(process.execPath)}`,
    '-c', `mcp_servers.v2.args=[${toml(TOOLS_SERVER)}]`,
    '-c', `mcp_servers.v2.env={${table}}`,
    '-c', 'mcp_servers.v2.default_tools_approval_mode="approve"',
    '-c', 'mcp_servers.v2.tool_timeout_sec=120',
    '-c', 'mcp_servers.v2.startup_timeout_sec=30',
  ];
}

// Like runCommand in the old worker (process group kill on abort, byte cap) but keeps stderr: Codex reports
// configuration errors there and they would otherwise vanish.
export function runCommand(command, args, { cwd, env = process.env, signal, input = '', maxBytes = 8_000_000 } = {}) {
  return new Promise((resolveRun, reject) => {
    if (signal?.aborted) return reject(signal.reason || new DeadlineError('command'));
    const child = spawn(command, args, { cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = ''; let stderr = ''; let bytes = 0; let killed = false; let escalation;
    const kill = () => { if (killed) return; killed = true; try { process.kill(-child.pid, 'SIGTERM'); } catch {} escalation = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 500); };
    signal?.addEventListener('abort', kill, { once: true });
    child.stdout.on('data', chunk => { bytes += chunk.length; if (bytes <= maxBytes) output += chunk; else kill(); });
    child.stderr.on('data', chunk => { bytes += chunk.length; if (stderr.length < 200_000) stderr += chunk; if (bytes > maxBytes) kill(); });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
    child.on('error', error => { signal?.removeEventListener('abort', kill); reject(Object.assign(new Error(`Cannot launch codex (${error.code || 'spawn'}).`), { output, stderr })); });
    child.on('close', code => {
      signal?.removeEventListener('abort', kill);
      if (!killed) clearTimeout(escalation);
      if (signal?.aborted) { const reason = signal.reason || new DeadlineError('command'); if (reason && typeof reason === 'object') Object.assign(reason, { output, stderr }); return reject(reason); }
      if (killed || code !== 0) return reject(Object.assign(new Error(`Codex exited unsuccessfully (${code})${stderr.trim() ? `: ${stderr.trim().split('\n').slice(-3).join(' | ').slice(0, 400)}` : ''}.`), { output, stderr }));
      resolveRun({ output, stderr });
    });
  });
}

// Parse `codex exec --json` output into the items the pipeline cares about.
export function parseEvents(output) {
  const items = [];
  let threadId = null; let usage = null;
  for (const line of String(output || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event; try { event = JSON.parse(line); } catch { continue; }
    if (event.type === 'thread.started') threadId = event.thread_id || null;
    if (event.type === 'turn.completed') usage = event.usage || null;
    if (event.type === 'item.completed' && event.item) items.push(event.item);
  }
  return { items, threadId, usage };
}

export class StoppedEarly extends Error { constructor(reason) { super(reason || 'stopped early'); this.name = 'StoppedEarly'; } }

// label: short phase name used for the schema/result/event file names inside jobDir.
// schema: null → no --output-schema (the final answer is free text; used when the result arrives through a tool).
// stopWhen: async () => boolean, polled every `stopPollMs`; true → the Codex process group is terminated and the run
// returns { stopped: true } with everything produced so far (14/10/2026: stop as soon as submit_findings has written).
// reasoning: value for `model_reasoning_effort` (e.g. "medium"); empty keeps the user's Codex config.
export async function runCodex({ root, jobDir, label, prompt, schema = null, deadline, signal, serverEnv = null, model = process.env.V2_CODEX_MODEL || '', reasoning = '', stopWhen = null, stopPollMs = 1000 }) {
  const schemaFile = resolve(jobDir, `${label}-schema.json`);
  const resultFile = resolve(jobDir, `${label}-last.json`);
  const eventsFile = resolve(jobDir, `${label}-events.jsonl`);
  if (schema) await writeFile(schemaFile, JSON.stringify(schema), { mode: 0o600 });
  const seconds = Math.max(1, Math.floor((deadline - Date.now()) / 1000));
  const args = ['--signal=TERM', '--kill-after=2s', `${seconds}s`, process.env.CODEX_BIN || 'codex',
    'exec', '--json', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only',
    '-c', 'approval_policy="never"', '-c', 'project_doc_max_bytes=0', '-c', 'tools.web_search=false',
    '-c', 'mcp_servers.playwright.enabled=false',
    ...(serverEnv ? mcpOverrides(serverEnv) : []),
    ...(model ? ['-m', model] : []),
    ...(reasoning && /^[a-z]+$/.test(reasoning) ? ['-c', `model_reasoning_effort=${toml(reasoning)}`] : []),
    '-C', jobDir, ...(schema ? ['--output-schema', schemaFile] : []), '--output-last-message', resultFile, '-'];
  let output = ''; let stderr = '';
  let failure = null; let stopped = false;
  // The stop watcher aborts through its own controller so the caller's signal keeps its meaning (deadline/abort).
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal?.reason);
  if (signal?.aborted) onAbort(); else signal?.addEventListener('abort', onAbort, { once: true });
  let poll = null;
  if (typeof stopWhen === 'function') {
    const tick = async () => { try { if (await stopWhen()) { stopped = true; controller.abort(new StoppedEarly(`${label}: kết quả đã nộp, dừng Codex`)); return; } } catch { /* keep polling */ } if (!controller.signal.aborted) poll = setTimeout(tick, stopPollMs); };
    poll = setTimeout(tick, stopPollMs);
  }
  try { ({ output, stderr } = await runCommand('timeout', args, { cwd: root, env: filteredEnv(), signal: controller.signal, input: prompt })); }
  catch (error) { if (!(stopped && error instanceof StoppedEarly)) failure = error; output = typeof error?.output === 'string' ? error.output : ''; stderr = typeof error?.stderr === 'string' ? error.stderr : ''; }
  finally { clearTimeout(poll); signal?.removeEventListener('abort', onAbort); }
  await writeFile(eventsFile, output, { mode: 0o600 }).catch(() => {});
  if (stderr.trim()) await writeFile(resolve(jobDir, `${label}-stderr.txt`), stderr, { mode: 0o600 }).catch(() => {});
  const parsed = parseEvents(output);
  let last = null;
  try { last = JSON.parse(await readFile(resultFile, 'utf8')); } catch { last = null; }
  return { ...parsed, last, failure, output, stopped };
}
