#!/usr/bin/env node
// Install the Hachimi tracing web as a user systemd service (starts at login, restarts on failure).
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ROOT } from './hachimi-db.mjs';
import { defaultPort } from './hachimi-trace-web.mjs';

const name = 'andrew-hachimi-trace-web.service';
const dir = join(homedir(), '.config/systemd/user');
await mkdir(dir, { recursive: true });
const quote = value => '"' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%') + '"';
const unit = `[Unit]
Description=Hachimi check-ticket tracing web (http://127.0.0.1:${defaultPort()})
After=network.target

[Service]
Type=simple
WorkingDirectory=${ROOT.replace(/%/g, '%%')}
ExecStart=/usr/bin/node ${quote(join(ROOT, 'scripts/hachimi-trace-web.mjs'))}
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
if (process.argv.includes('--uninstall')) {
  await exec('systemctl', ['--user', 'disable', '--now', name]).catch(() => {});
  console.log(JSON.stringify({ uninstalled: true, unit: path }));
} else {
  await exec('systemctl', ['--user', 'daemon-reload']);
  await exec('systemctl', ['--user', 'enable', '--now', name]);
  console.log(JSON.stringify({ installed: true, unit: path, url: `http://127.0.0.1:${defaultPort()}` }));
}
