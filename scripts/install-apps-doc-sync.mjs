#!/usr/bin/env node
// Weekly refresh of apps_doc/ (the local fallback copy of the app sources) as a user systemd timer. The service runs
// scripts/apps-doc-sync-if-due.mjs --run --source timer (which calls fetch-app-sources.mjs under a lock and writes the
// last-sync mark). Persistent=true: a slot missed while the machine was off runs when the user session comes back;
// the same script also catches up at the first agent start of the week (SessionStart hook, notifier start).
// The units are only WRITTEN by default; the timer starts when --enable is passed
// (or later with `systemctl --user enable --now andrew-apps-doc-sync.timer`).
// Usage: node scripts/install-apps-doc-sync.mjs [--enable] [--uninstall] [--calendar "Sun *-*-* 03:30:00 Asia/Ho_Chi_Minh"]
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const service = "andrew-apps-doc-sync.service";
const timer = "andrew-apps-doc-sync.timer";
const dir = join(homedir(), ".config/systemd/user");
const args = process.argv.slice(2);
const option = (name, fallback) => { const index = args.indexOf(name); return index >= 0 && args[index + 1] ? args[index + 1] : fallback; };
const calendar = option("--calendar", "Sun *-*-* 03:30:00 Asia/Ho_Chi_Minh");
import { APPS } from "./apps-doc-sync-if-due.mjs";
const quote = (value) => '"' + value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%") + '"';

async function writeUnit(name, unit) {
  const path = join(dir, name);
  let prior;
  try { prior = await readFile(path, "utf8"); } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (prior && prior !== unit) await writeFile(path + ".backup-" + Date.now(), prior, { mode: 0o600 });
  await writeFile(path, unit, { mode: 0o600 });
  return path;
}

if (args.includes("--uninstall")) {
  await exec("systemctl", ["--user", "disable", "--now", timer]).catch(() => {});
  console.log(JSON.stringify({ uninstalled: true, timer }));
} else {
  const log = join(ROOT, "runtime/apps-doc-sync.log");
  await mkdir(dir, { recursive: true });
  await mkdir(join(ROOT, "runtime"), { recursive: true, mode: 0o700 });
  const serviceUnit = `[Unit]
Description=Hachimi apps_doc sync: tai lai ban sao ma nguon app (du phong cho Source API)
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
WorkingDirectory=${ROOT.replace(/%/g, "%%")}
ExecStart=${process.execPath} ${quote(join(ROOT, "scripts/apps-doc-sync-if-due.mjs"))} --run --force --source timer
TimeoutStartSec=3600
UMask=0077
StandardOutput=append:${quote(log).slice(1, -1)}
StandardError=inherit
`;
  const timerUnit = `[Unit]
Description=Hachimi apps_doc sync (${calendar})

[Timer]
OnCalendar=${calendar}
Persistent=true
AccuracySec=5min
Unit=${service}

[Install]
WantedBy=timers.target
`;
  const units = [await writeUnit(service, serviceUnit), await writeUnit(timer, timerUnit)];
  await exec("systemctl", ["--user", "daemon-reload"]);
  const enabled = args.includes("--enable");
  if (enabled) await exec("systemctl", ["--user", "enable", "--now", timer]);
  const next = enabled ? await exec("systemctl", ["--user", "list-timers", timer, "--no-pager"]).then((result) => result.stdout.trim()).catch(() => "") : "";
  console.log(JSON.stringify({ installed: true, enabled, units, calendar, apps: APPS, log, enableCommand: `systemctl --user enable --now ${timer}` }, null, 2));
  if (next) console.log(next);
}
