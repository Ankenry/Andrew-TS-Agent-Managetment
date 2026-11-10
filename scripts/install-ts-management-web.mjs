#!/usr/bin/env node
// Install the TS Management web as a user systemd service so it starts at login
// and restarts on failure. Usage: node scripts/install-ts-management-web.mjs [--uninstall]
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ROOT } from "./hachimi-db.mjs";
import { defaultHost, defaultPort, lanAddresses } from "./ts-management-web.mjs";

const name = "andrew-ts-management-web.service";
const dir = join(homedir(), ".config/systemd/user");
await mkdir(dir, { recursive: true });
const quote = (value) => '"' + value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%") + '"';
const unit = `[Unit]
Description=TS Management web (http://${defaultHost()}:${defaultPort()})
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${ROOT.replace(/%/g, "%%")}
ExecStart=${process.execPath} ${quote(join(ROOT, "scripts/ts-management-web.mjs"))}
Restart=always
RestartSec=5
UMask=0077
# PATH of a user service started at boot lacks ~/.local/bin, where the codex CLI lives (exit 127 on 2026-10-11).
Environment=PATH=%h/.local/bin:%h/.npm-global/bin:/usr/local/bin:/usr/bin:/bin
StandardOutput=append:${quote(join(ROOT, "runtime/ts-management-web.log")).slice(1, -1)}
StandardError=inherit

[Install]
WantedBy=default.target
`;
const path = join(dir, name);
let prior;
try { prior = await readFile(path, "utf8"); } catch (error) { if (error.code !== "ENOENT") throw error; }
if (prior && prior !== unit) await writeFile(path + ".backup-" + Date.now(), prior, { mode: 0o600 });
await writeFile(path, unit, { mode: 0o600 });
const exec = promisify(execFile);
if (process.argv.includes("--uninstall")) {
  await exec("systemctl", ["--user", "disable", "--now", name]).catch(() => {});
  console.log(JSON.stringify({ uninstalled: true, unit: path }));
} else {
  await exec("systemctl", ["--user", "daemon-reload"]);
  await exec("systemctl", ["--user", "enable", "--now", name]);
  console.log(JSON.stringify({ installed: true, unit: path, urls: [`http://127.0.0.1:${defaultPort()}`, ...lanAddresses().map((item) => `http://${item.address}:${defaultPort()}`)] }, null, 2));
}
