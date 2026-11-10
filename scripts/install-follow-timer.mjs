// Shared installer of the follow skills (dev-fix-follow, feature-follow) as a
// user systemd timer that runs at the slots of the skill's workflow.json. A
// slot missed while the machine was off or asleep runs once afterwards
// (Persistent=true). Called by install-dev-fix-follow.mjs and
// install-feature-follow.mjs with the skill's profile.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ROOT } from "./hachimi-db.mjs";
import { settings } from "../skills/dev-fix-follow/scripts/adapters.mjs";
import { parseSlots } from "../skills/dev-fix-follow/scripts/core.mjs";

const exec = promisify(execFile);
const dir = join(homedir(), ".config/systemd/user");
const quote = (value) => '"' + value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%") + '"';
const pad = (value) => String(value).padStart(2, "0");

async function writeUnit(name, unit) {
  const path = join(dir, name);
  let prior;
  try { prior = await readFile(path, "utf8"); } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (prior && prior !== unit) await writeFile(path + ".backup-" + Date.now(), prior, { mode: 0o600 });
  await writeFile(path, unit, { mode: 0o600 });
  return path;
}

export async function installFollowTimer(profile, { uninstall = false } = {}) {
  const service = `${profile.unit}.service`;
  const timer = `${profile.unit}.timer`;
  if (uninstall) {
    await exec("systemctl", ["--user", "disable", "--now", timer]).catch(() => {});
    console.log(JSON.stringify({ uninstalled: true, timer }));
    return;
  }
  const config = await settings(profile);
  const codex = process.env.CODEX_BIN || (await exec("sh", ["-c", "command -v codex"]).then((result) => result.stdout.trim()).catch(() => ""));
  if (!codex) throw new Error("Không tìm thấy codex trong PATH; đặt CODEX_BIN rồi cài lại.");
  const path = [dirname(process.execPath), dirname(codex), "/usr/local/bin", "/usr/bin", "/bin"].filter((value, index, list) => list.indexOf(value) === index).join(":");
  const log = join(ROOT, profile.logFile);
  await mkdir(dir, { recursive: true });
  await mkdir(join(ROOT, profile.runtimeDir), { recursive: true, mode: 0o700 });
  const serviceUnit = `[Unit]
Description=${profile.unitDescription}
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
WorkingDirectory=${ROOT.replace(/%/g, "%%")}
Environment=PATH=${path.replace(/%/g, "%%")}
Environment=CODEX_BIN=${codex.replace(/%/g, "%%")}
ExecStart=${process.execPath} ${quote(join(ROOT, profile.skillDir, "scripts/run.mjs"))} --scheduled
TimeoutStartSec=${Math.ceil(config.runTimeoutMs / 1000) + 600}
UMask=0077
StandardOutput=append:${quote(log).slice(1, -1)}
StandardError=inherit
`;
  const calendar = parseSlots(config.slots).map((minutes) => `OnCalendar=*-*-* ${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}:00 ${config.timeZone}`).join("\n");
  const timerUnit = `[Unit]
Description=Hachimi ${profile.name} (${config.slots.join(", ")} ${config.timeZone})

[Timer]
${calendar}
Persistent=true
AccuracySec=30s
Unit=${service}

[Install]
WantedBy=timers.target
`;
  const units = [await writeUnit(service, serviceUnit), await writeUnit(timer, timerUnit)];
  await exec("systemctl", ["--user", "daemon-reload"]);
  await exec("systemctl", ["--user", "enable", "--now", timer]);
  const next = await exec("systemctl", ["--user", "list-timers", timer, "--no-pager"]).then((result) => result.stdout.trim()).catch(() => "");
  console.log(JSON.stringify({ installed: true, units, slots: config.slots, timeZone: config.timeZone, log }, null, 2));
  if (next) console.log(next);
}
