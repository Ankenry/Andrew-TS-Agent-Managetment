#!/usr/bin/env node
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ROOT, CONFIG, STATE, saveJson } from './check-ticket-chat-relay.mjs';

const threadId = process.argv[process.argv.indexOf('--thread') + 1];
if (!process.argv.includes('--thread') || !/^[a-f0-9-]{36}$/i.test(threadId || '')) throw new Error('Provide --thread <current conversation UUID>');
let config;
try { config = JSON.parse(await readFile(CONFIG, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
if (config && config.threadId !== threadId) throw new Error('Already bound to a different conversation. Refusing silent rebind.');
config ||= { version: 1, enabled: true, threadId, activatedAt: new Date().toISOString(), codexBin: join(homedir(), '.local/bin/codex') };
await saveJson(CONFIG, config);
const name = 'andrew-check-ticket-chat-trace.service';
const dir = join(homedir(), '.config/systemd/user');
await mkdir(dir, { recursive: true });
const quote = value => '"' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%') + '"';
const unit = `[Unit]
Description=Andrew check-ticket trace relay to the bound Codex conversation

[Service]
Type=simple
WorkingDirectory=${ROOT.replace(/%/g, '%%')}
ExecStart=/usr/bin/flock --nonblock ${quote(join(ROOT, 'runtime/check-ticket/chat-relay.lock'))} /usr/bin/node ${quote(join(ROOT, 'scripts/check-ticket-chat-relay.mjs'))} --watch
Restart=on-failure
RestartSec=5
UMask=0077
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target
`;
const path = join(dir, name);
let prior;
try { prior = await readFile(path, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
if (prior && prior !== unit) await writeFile(path + '.backup-' + Date.now(), prior, { mode: 0o600 });
await writeFile(path, unit, { mode: 0o600 });
const exec = promisify(execFile);
await exec('systemctl', ['--user', 'daemon-reload']);
await exec('systemctl', ['--user', 'enable', '--now', name]);
console.log(JSON.stringify({ configured: true, threadId, unit: path, state: STATE }));
