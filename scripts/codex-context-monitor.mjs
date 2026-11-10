#!/usr/bin/env node
// Read-only, one-session terminal preview. Never connects to app-server or compacts.
import { createReadStream } from 'node:fs';
import { readdir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { nativeConfigPreview, readCodexMetrics, renderContextMeter } from './context-meter.mjs';
import { renderTerminalContext } from './context-meter.mjs';

const WORKSPACE = resolve(fileURLToPath(new URL('..', import.meta.url)));
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
export function parseOptions(args, env = process.env) {
  const options = { sessionId: env.CODEX_THREAD_ID, preview: false, watch: false, json: false, config: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--preview') options.preview = true;
    else if (arg === '--watch') options.watch = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--print-config') options.config = true;
    else if (arg === '--help') options.help = true;
    else if (arg === '--session' || arg === '--rollout') {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
      options[arg === '--session' ? 'sessionId' : 'rollout'] = value;
    } else throw new Error(`Unknown option: ${arg}`);
  }
  if (options.help) return options;
  if (!options.preview) throw new Error('--preview is required; no activation mode exists');
  if (!UUID.test(options.sessionId || '')) throw new Error('Set CODEX_THREAD_ID or --session to this terminal session UUID');
  if (env.CODEX_THREAD_ID && options.sessionId !== env.CODEX_THREAD_ID) throw new Error('Cannot inspect another bound session');
  if (options.watch && options.config) throw new Error('--print-config cannot be combined with --watch');
  return options;
}

async function findOwnRollout(directory, sessionId) {
  // Directory names and filenames only; never open other sessions to discover IDs.
  const matches = [];
  async function visit(path, depth) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (entry.isDirectory() && depth < 3 && /^\d{2,4}$/.test(entry.name)) await visit(join(path, entry.name), depth + 1);
      if (entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith(`-${sessionId}.jsonl`)) matches.push(join(path, entry.name));
    }
  }
  await visit(directory, 0);
  if (matches.length !== 1) throw new Error(`Expected one rollout for this session; found ${matches.length}. Supply --rollout explicitly.`);
  return matches[0];
}

export async function main(args = process.argv.slice(2)) {
  const options = parseOptions(args);
  if (options.help) {
    console.log('Preview only: node scripts/codex-context-monitor.mjs --preview [--session UUID] [--rollout PATH] [--watch | --print-config] [--json]\nReads only the bound session metadata/token counts. No RPC, compaction, config write or shared state. --watch samples every 5 seconds; Ctrl-C stops.');
    return;
  }
  if (await realpath(process.cwd()) !== await realpath(WORKSPACE)) throw new Error('Run from the assigned Andrew TS Tools workspace');
  const sessions = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'sessions');
  const path = await realpath(options.rollout || await findOwnRollout(sessions, options.sessionId));
  if (!basename(path).startsWith('rollout-') || !basename(path).endsWith(`-${options.sessionId}.jsonl`)) throw new Error('Rollout filename does not match the bound session');
  const binding = { sessionId: options.sessionId, workspace: WORKSPACE };
  const terminalBar = options.watch && process.stdout.isTTY && !options.json;
  if (terminalBar) process.once('SIGINT', () => { process.stdout.write('\n'); process.exit(130); });
  do {
    const stream = createReadStream(path, { encoding: 'utf8' });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    let meter;
    try { meter = await readCodexMetrics(lines, binding); }
    finally { lines.close(); stream.destroy(); }
    if (terminalBar) {
      process.stdout.write(`\r\x1b[2K${renderTerminalContext(meter, process.stdout.columns || 80)}`);
      await delay(5000);
      continue;
    }
    console.log(options.config ? nativeConfigPreview(meter) : options.json ? JSON.stringify(meter) : renderContextMeter(meter));
    if (options.watch) await delay(5000);
  } while (options.watch);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(`Context preview unavailable: ${error.message}`); process.exitCode = 1; });
}
