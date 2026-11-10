#!/usr/bin/env node

// Native Messaging bridge for the local TS Management Chrome extension.
// It deliberately accepts only fixed local-service actions; extension input is
// never interpolated into a shell command.

import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { parseEnv } from "node:util";
import { appendWidgetEvents } from './widget-chat-log.mjs';
import { publicTraceUrl } from './hachimi-trace-domain.mjs';
import { nativeSettingsAction } from './mcp-v2-settings.mjs';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const NOTIFIER_SCRIPT = resolve(PROJECT_ROOT, "scripts", "ticket-notification-to-telegram.mjs");
const CODEX_BRIDGE_SCRIPT = resolve(PROJECT_ROOT, "scripts", "codex-ticket-bridge.mjs");
const WEBHOOK_BRIDGE_SCRIPT = resolve(PROJECT_ROOT, "scripts", "helpdesk-webhook-bridge.mjs");
const LOG_FILE = resolve(PROJECT_ROOT, "runtime", "telegram-ticket-notifier.log");
const CODEX_BRIDGE_LOG_FILE = resolve(PROJECT_ROOT, "runtime", "codex-ticket-bridge.log");
const WEBHOOK_BRIDGE_LOG_FILE = resolve(PROJECT_ROOT, "runtime", "helpdesk-webhook-bridge.log");
const DATABASE_COMPOSE_FILE = resolve(PROJECT_ROOT, "db", "docker-compose.yml");
const DATABASE_CONTAINER = "hachimi-postgres";
const TRACE_WEB_SCRIPT = resolve(PROJECT_ROOT, "scripts", "hachimi-trace-web.mjs");
const TRACE_WEB_LOG_FILE = resolve(PROJECT_ROOT, "runtime", "hachimi-trace-web.log");
const TRACE_WEB_UNIT = "andrew-hachimi-trace-web.service";
const TRACE_WEB_UNIT_FILE = resolve(homedir(), ".config", "systemd", "user", TRACE_WEB_UNIT);
const TRACE_WEB_SCREEN_NAME = "andrew_hachimi_trace_web";
const SCREEN_NAME = "andrew_ticket_notifier";
const CODEX_BRIDGE_SCREEN_NAME = "andrew_codex_ticket_bridge";
const WEBHOOK_BRIDGE_SCREEN_NAME = "andrew_helpdesk_webhook_bridge";

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 10_000, ...options }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function notifierRunning() {
  try {
    const { stdout } = await run("screen", ["-ls"]);
    return stdout.includes(`.${SCREEN_NAME}`);
  } catch (error) {
    // `screen -ls` exits with 1 when no session exists.
    return String(error?.stdout || "").includes(`.${SCREEN_NAME}`);
  }
}

// Maintenance deployment selects the engine binary through one workspace file.
// Missing file preserves the existing launcher; bad config fails closed.
function engineNode() {
  const file = resolve(PROJECT_ROOT, 'runtime/mcp-v2/engine-launch.json');
  let selected;
  try { selected = JSON.parse(readFileSync(file, 'utf8')).node; }
  catch (error) { if (error.code === 'ENOENT') return process.execPath; throw new Error('Invalid engine launcher configuration.'); }
  const privateNode = resolve(PROJECT_ROOT, 'runtime/mcp-v2/toolchain/node-v22.23.4-linux-x64/bin/node');
  if (![privateNode, '/usr/bin/node'].includes(selected)) throw new Error('Unapproved engine executable.');
  return selected;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

async function startNotifier() {
  if (await notifierRunning()) return { running: true, started: false };
  const command = [
    `cd ${shellQuote(PROJECT_ROOT)}`,
    `exec ${shellQuote(engineNode())} ${shellQuote(NOTIFIER_SCRIPT)} --watch --resume-session >> ${shellQuote(LOG_FILE)} 2>&1`,
  ].join(" && ");
  await run("screen", ["-dmS", SCREEN_NAME, "bash", "-lc", command]);
  return { running: true, started: true };
}

async function reconnectNotifier() {
  const wasRunning = await notifierRunning();
  if (wasRunning) await run("screen", ["-S", SCREEN_NAME, "-X", "quit"]);
  const result = await startNotifier();
  return { ...result, restarted: wasRunning };
}

async function codexBridgeRunning() {
  try {
    const { stdout } = await run("screen", ["-ls"]);
    return stdout.includes(`.${CODEX_BRIDGE_SCREEN_NAME}`);
  } catch (error) {
    return String(error?.stdout || "").includes(`.${CODEX_BRIDGE_SCREEN_NAME}`);
  }
}

async function startCodexBridge() {
  if (await codexBridgeRunning()) return { running: true, started: false };
  const command = [
    `cd ${shellQuote(PROJECT_ROOT)}`,
    `exec ${shellQuote(engineNode())} ${shellQuote(CODEX_BRIDGE_SCRIPT)} >> ${shellQuote(CODEX_BRIDGE_LOG_FILE)} 2>&1`,
  ].join(" && ");
  await run("screen", ["-dmS", CODEX_BRIDGE_SCREEN_NAME, "bash", "-lc", command]);
  return { running: true, started: true };
}

async function restartCodexBridge() {
  if (await codexBridgeRunning()) await run("screen", ["-S", CODEX_BRIDGE_SCREEN_NAME, "-X", "quit"]);
  return startCodexBridge();
}

async function webhookBridgeRunning() {
  try {
    const { stdout } = await run("screen", ["-ls"]);
    return stdout.includes(`.${WEBHOOK_BRIDGE_SCREEN_NAME}`);
  } catch (error) {
    return String(error?.stdout || "").includes(`.${WEBHOOK_BRIDGE_SCREEN_NAME}`);
  }
}

async function startWebhookBridge() {
  if (await webhookBridgeRunning()) return { running: true, started: false };
  const command = [
    `cd ${shellQuote(PROJECT_ROOT)}`,
    `exec node ${shellQuote(WEBHOOK_BRIDGE_SCRIPT)} >> ${shellQuote(WEBHOOK_BRIDGE_LOG_FILE)} 2>&1`,
  ].join(" && ");
  await run("screen", ["-dmS", WEBHOOK_BRIDGE_SCREEN_NAME, "bash", "-lc", command]);
  return { running: true, started: true };
}

async function databaseStatus() {
  try {
    const { stdout } = await run("docker", ["inspect", "--format", "{{.State.Status}} {{.State.Health.Status}}", DATABASE_CONTAINER]);
    const [state, health] = stdout.trim().split(" ");
    return { running: state === "running", healthy: health === "healthy" };
  } catch {
    return { running: false, healthy: false };
  }
}

// `docker compose up -d` is idempotent: an already healthy stack is left untouched.
async function startDatabase() {
  const before = await databaseStatus();
  if (before.healthy) return { ...before, started: false };
  await run("docker", ["compose", "-f", DATABASE_COMPOSE_FILE, "up", "-d", "--wait"], { cwd: PROJECT_ROOT, timeout: 120_000 });
  return { ...(await databaseStatus()), started: true };
}

function traceWebPort() {
  let env = {};
  try { env = parseEnv(readFileSync(resolve(PROJECT_ROOT, ".env_my"), "utf8")); } catch {}
  const port = Number(process.env.HACHIMI_TRACE_WEB_PORT || env.HACHIMI_TRACE_WEB_PORT);
  return Number.isInteger(port) && port > 0 ? port : 5077;
}

async function traceWebStatus() {
  const localUrl = `http://127.0.0.1:${traceWebPort()}`;
  try {
    const response = await fetch(`${localUrl}/api/health`, { signal: AbortSignal.timeout(2_000) });
    const body = await response.json();
    // `url` is what people open: http://andrewtstracing.localhost:<port> (or the optional custom domain when installed).
    return { running: Boolean(body?.ok), url: body?.ok ? await publicTraceUrl() : localUrl, localUrl };
  } catch {
    return { running: false, url: localUrl, localUrl };
  }
}

async function traceWebRunningInScreen() {
  try {
    const { stdout } = await run("screen", ["-ls"]);
    return stdout.includes(`.${TRACE_WEB_SCREEN_NAME}`);
  } catch (error) {
    return String(error?.stdout || "").includes(`.${TRACE_WEB_SCREEN_NAME}`);
  }
}

// Prefer the user systemd unit installed by scripts/install-hachimi-trace-web.mjs;
// fall back to a detached screen session when the unit is not installed.
async function startTraceWeb() {
  const before = await traceWebStatus();
  if (before.running) return { ...before, started: false, via: "health" };
  let via = "screen";
  let unitInstalled = false;
  try { await access(TRACE_WEB_UNIT_FILE); unitInstalled = true; } catch {}
  if (unitInstalled) {
    try {
      await run("systemctl", ["--user", "start", TRACE_WEB_UNIT], { timeout: 20_000 });
      via = "systemd";
    } catch (error) {
      via = `screen (systemd failed: ${String(error?.stderr || error?.message || "").trim().slice(0, 120)})`;
    }
  }
  if (!via.startsWith("systemd") && !(await traceWebRunningInScreen())) {
    const command = [
      `cd ${shellQuote(PROJECT_ROOT)}`,
      `exec node ${shellQuote(TRACE_WEB_SCRIPT)} >> ${shellQuote(TRACE_WEB_LOG_FILE)} 2>&1`,
    ].join(" && ");
    await run("screen", ["-dmS", TRACE_WEB_SCREEN_NAME, "bash", "-lc", command]);
  }
  for (let attempt = 0; attempt < 20; attempt++) {
    const status = await traceWebStatus();
    if (status.running) return { ...status, started: true, via };
    await new Promise((done) => setTimeout(done, 500));
  }
  return { ...(await traceWebStatus()), started: true, via, warning: "Trace web did not report healthy within 10 seconds." };
}

async function handle(message) {
  switch (message?.action) {
    case 'mcp-v2-settings-get':
    case 'mcp-v2-settings-set': {
      return nativeSettingsAction(message);
    }
    case "trace-web-status":
      return { ok: true, ...(await traceWebStatus()) };
    case "trace-web-start":
      return { ok: true, ...(await startTraceWeb()) };
    case "db-status":
      return { ok: true, ...(await databaseStatus()) };
    case "db-start":
      return { ok: true, ...(await startDatabase()) };
    case "widget-chat-log":
      await appendWidgetEvents(message.events);
      // Near-realtime tracing: ask the tracing web to sync the log now (best effort, never awaited by the widget).
      void fetch(`http://127.0.0.1:${traceWebPort()}/api/sync`, { method: "POST", signal: AbortSignal.timeout(5_000) }).catch(() => {});
      return { ok: true };
    case "status":
      return { ok: true, running: await notifierRunning() };
    case "start":
      return { ok: true, ...(await startNotifier()) };
    case "reconnect":
      return { ok: true, ...(await reconnectNotifier()) };
    case "codex-status":
      return { ok: true, running: await codexBridgeRunning() };
    case "codex-start":
      return { ok: true, ...(await startCodexBridge()) };
    case "codex-restart":
      return { ok: true, ...(await restartCodexBridge()) };
    case "webhook-bridge-status":
      return { ok: true, running: await webhookBridgeRunning() };
    case "webhook-bridge-start":
      return { ok: true, ...(await startWebhookBridge()) };
    default:
      throw new Error("Unsupported local service action.");
  }
}

function write(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  process.stdout.write(Buffer.concat([header, body]));
}

let input = Buffer.alloc(0);
let work = Promise.resolve();
for await (const chunk of process.stdin) {
  input = Buffer.concat([input, chunk]);
  while (input.length >= 4) {
    const bodyLength = input.readUInt32LE(0);
    if (bodyLength > 1_000_000) {
      write({ ok: false, error: "Native message is too large." });
      process.exitCode = 1;
      break;
    }
    if (input.length < bodyLength + 4) break;
    const raw = input.subarray(4, bodyLength + 4);
    input = input.subarray(bodyLength + 4);
    work = work.then(async () => {
      try {
        const message = JSON.parse(raw.toString("utf8"));
        write(await handle(message));
      } catch (error) {
        write({ ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    });
  }
}
await work;
