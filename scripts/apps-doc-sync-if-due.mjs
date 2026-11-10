#!/usr/bin/env node
// Weekly sync of apps_doc/ (the local fallback copy of the app sources) with catch-up: the systemd timer fires
// Sunday 03:30 Asia/Ho_Chi_Minh, but when the machine was off at that time the first agent start of the week
// (Claude Code SessionStart hook, notifier start) runs the sync instead. One lock file keeps concurrent sessions
// from starting two syncs; the sync itself is scripts/fetch-app-sources.mjs, started detached so nothing blocks.
//
//   node scripts/apps-doc-sync-if-due.mjs            # check: due and not locked → start a detached sync, print one line
//   node scripts/apps-doc-sync-if-due.mjs --check    # only print whether a sync is due (no side effects)
//   node scripts/apps-doc-sync-if-due.mjs --run [--force] [--source timer|manual|catch-up]
//                                                    # run the sync now (in this process), write the last-sync mark
// State: runtime/apps-doc-sync/last-sync.json, sync.lock, sync-<timestamp>.log. No token is written anywhere.

import { readFile, writeFile, mkdir, rm, open } from "node:fs/promises";
import { spawn } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const STATE_DIR = join(ROOT, "runtime/apps-doc-sync");
export const LAST_SYNC_FILE = join(STATE_DIR, "last-sync.json");
export const LOCK_FILE = join(STATE_DIR, "sync.lock");
export const SCHEDULE = { weekday: 0, hour: 3, minute: 30, timeZone: "Asia/Ho_Chi_Minh" }; // Sunday 03:30
export const LOCK_STALE_MS = 2 * 60 * 60 * 1000;
// Same list as the timer/npm script: every app the check-ticket-v2 pipeline can fall back to.
export const APPS = ["joy-subs", "air-reviews", "aem", "shopvid", "booking", "order-limits", "cookie-bar", "pdf-invoice", "survey", "accessibility", "age-verification", "air-edd", "order-tracking", "affily", "fraud-filter", "online-course", "shipping-labels", "backups-restore", "joy", "wishlist", "chatty"];

// --- schedule math (pure) ---------------------------------------------------------------------------------
const partsOf = (date, timeZone) => {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", weekday: "short" }).formatToParts(date);
  const get = type => parts.find(part => part.type === type)?.value;
  return { year: Number(get("year")), month: Number(get("month")), day: Number(get("day")), hour: Number(get("hour")), minute: Number(get("minute")), second: Number(get("second")), weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday")) };
};
// Wall-clock time in a zone → UTC epoch ms (two-pass offset correction, enough for zones with or without DST).
export function zonedTimeToUtc({ year, month, day, hour = 0, minute = 0 }, timeZone) {
  let guess = Date.UTC(year, month - 1, day, hour, minute, 0);
  for (let i = 0; i < 2; i++) {
    const p = partsOf(new Date(guess), timeZone);
    const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    guess += Date.UTC(year, month - 1, day, hour, minute, 0) - asUtc;
  }
  return guess;
}
// Most recent schedule slot at or before `now` (epoch ms).
export function lastDueAt(now = Date.now(), schedule = SCHEDULE) {
  const p = partsOf(new Date(now), schedule.timeZone);
  let back = (p.weekday - schedule.weekday + 7) % 7;
  const todayAtSlot = zonedTimeToUtc({ year: p.year, month: p.month, day: p.day, hour: schedule.hour, minute: schedule.minute }, schedule.timeZone);
  if (back === 0 && todayAtSlot > now) back = 7;
  return todayAtSlot - back * 24 * 60 * 60 * 1000 + (back ? 0 : 0);
}
// Due when there is no record, or the last sync (any source) is older than the most recent slot.
export function isDue(lastSyncAt, now = Date.now(), schedule = SCHEDULE) {
  const last = lastSyncAt ? Date.parse(lastSyncAt) : NaN;
  if (!Number.isFinite(last)) return true;
  return last < lastDueAt(now, schedule);
}

// --- state and lock ----------------------------------------------------------------------------------------
export async function readLastSync(file = LAST_SYNC_FILE) {
  try { return JSON.parse(await readFile(file, "utf8")); } catch { return null; }
}
export async function writeLastSync(record, file = LAST_SYNC_FILE) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, JSON.stringify(record, null, 2) + "\n", { mode: 0o600 });
}
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; } };
// Creates the lock atomically (O_EXCL). A lock whose process is dead or older than LOCK_STALE_MS is taken over.
export async function acquireLock(file = LOCK_FILE, { pid = process.pid, now = Date.now(), staleMs = LOCK_STALE_MS, isAlive = alive } = {}) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const payload = JSON.stringify({ pid, at: new Date(now).toISOString() });
  for (let attempt = 0; attempt < 2; attempt++) {
    try { const handle = await open(file, "wx", 0o600); await handle.writeFile(payload); await handle.close(); return { ok: true }; }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      let holder = null;
      try { holder = JSON.parse(await readFile(file, "utf8")); } catch { holder = null; }
      const age = holder?.at ? now - Date.parse(holder.at) : Infinity;
      const stale = !holder || !Number.isFinite(age) || age > staleMs || !isAlive(Number(holder.pid));
      if (!stale) return { ok: false, holder };
      await rm(file, { force: true });
    }
  }
  return { ok: false, holder: null };
}
export const releaseLock = (file = LOCK_FILE) => rm(file, { force: true });

// --- actions ------------------------------------------------------------------------------------------------
function notify(title, body) {
  try { const child = spawn("notify-send", ["-a", "Hachimi", title, body], { detached: true, stdio: "ignore" }); child.on("error", () => {}); child.unref(); } catch { /* optional */ }
}

// Runs scripts/fetch-app-sources.mjs for APPS in this process, under the lock, and records the result.
export async function runSync({ source = "manual", force = false, now = Date.now() } = {}) {
  const last = await readLastSync();
  if (!force && !isDue(last?.at, now)) return { ran: false, reason: "not due", last };
  const lock = await acquireLock(LOCK_FILE, { now });
  if (!lock.ok) return { ran: false, reason: "locked", holder: lock.holder, last };
  await mkdir(STATE_DIR, { recursive: true, mode: 0o700 });
  const startedAt = new Date(now).toISOString();
  const logFile = join(STATE_DIR, `sync-${startedAt.replace(/[:.]/g, "-")}.log`);
  const logHandle = await open(logFile, "a", 0o600);
  let code = null; let error = null;
  try {
    code = await new Promise((resolveRun, rejectRun) => {
      const child = spawn(process.execPath, [join(ROOT, "scripts/fetch-app-sources.mjs"), ...APPS], { cwd: ROOT, stdio: ["ignore", logHandle.fd, logHandle.fd] });
      child.on("error", rejectRun); child.on("close", resolveRun);
    });
  } catch (err) { error = err.message; }
  finally { await logHandle.close(); await releaseLock(); }
  const ok = code === 0 && !error;
  let apps = null;
  try { const manifest = JSON.parse(await readFile(join(ROOT, "apps_doc/manifest.json"), "utf8")); apps = Object.values(manifest.apps || {}).filter(app => app.ok).length; } catch { apps = null; }
  const record = { at: new Date().toISOString(), startedAt, source, ok, exitCode: code, error, apps, log: logFile };
  await writeLastSync(record);
  notify(ok ? "apps_doc đã đồng bộ" : "apps_doc đồng bộ lỗi", ok ? `${apps ?? "?"} app, nguồn ${source}.` : `exit ${code ?? "?"}${error ? `: ${error}` : ""} (xem ${logFile}).`);
  return { ran: true, ok, record };
}

// Check-and-start: when due and unlocked, start `--run --source catch-up` detached and return at once.
export async function startIfDue({ now = Date.now() } = {}) {
  const last = await readLastSync();
  if (!isDue(last?.at, now)) return { started: false, reason: "not due", last };
  // Peek at the lock without taking it: the child takes it. A live lock means a sync is already running.
  let holder = null;
  try { holder = JSON.parse(await readFile(LOCK_FILE, "utf8")); } catch { holder = null; }
  if (holder && Number.isFinite(Date.parse(holder.at)) && now - Date.parse(holder.at) < LOCK_STALE_MS && alive(Number(holder.pid))) return { started: false, reason: "running", holder };
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "--run", "--source", "catch-up"], { cwd: ROOT, detached: true, stdio: "ignore" });
  child.on("error", () => {});
  child.unref();
  return { started: true, pid: child.pid, last };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const option = (name, fallback) => { const index = args.indexOf(name); return index >= 0 && args[index + 1] ? args[index + 1] : fallback; };
  const run = async () => {
    if (args.includes("--check")) {
      const last = await readLastSync();
      console.log(JSON.stringify({ due: isDue(last?.at), lastSyncAt: last?.at || null, lastDueAt: new Date(lastDueAt()).toISOString(), lastSource: last?.source || null }));
      return;
    }
    if (args.includes("--run")) {
      const result = await runSync({ source: option("--source", "manual"), force: args.includes("--force") });
      console.log(JSON.stringify(result));
      if (result.ran && !result.ok) process.exitCode = 1;
      return;
    }
    const result = await startIfDue();
    // Quiet unless something happened: the SessionStart hook prints this into the session.
    if (result.started) console.log(`[apps-doc-sync] Bản sao apps_doc đến hạn đồng bộ tuần (lần cuối ${result.last?.at || "chưa có"}) → đang đồng bộ ở nền (pid ${result.pid}), không chặn phiên.`);
  };
  run().catch(error => { console.error(`[apps-doc-sync] ${error.message}`); process.exitCode = 0; });
}
