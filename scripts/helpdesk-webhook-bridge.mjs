#!/usr/bin/env node

// Receives Helpdesk ticket webhooks on a loopback-only HTTP server. Publish it
// through an HTTPS reverse tunnel; never expose this process directly.

import { createHmac, createHash, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENV_FILE = resolve(PROJECT_ROOT, ".env_my");
const STATE_FILE = resolve(PROJECT_ROOT, "runtime", "helpdesk-webhook-bridge-state.json");
const HOST = "127.0.0.1";
const DEFAULT_PORT = 39_543;
const MAX_BODY_BYTES = 1_048_576;
const MAX_REMEMBERED_EVENTS = 2_000;
const AVADA_SIGNATURE_TOLERANCE_MS = 5 * 60_000;
const DEFAULT_EXTENSION_ORIGIN = "chrome-extension://mjhhfgjmfbclmdfekgibfojcinjnfknm";

function parseEnvFile(contents) {
  const values = {};
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    values[key] = value;
  }
  return values;
}

async function loadConfig() {
  const env = parseEnvFile(await readFile(ENV_FILE, "utf8"));
  const secret = (process.env.HELPDESK_WEBHOOK_SECRET || env.HELPDESK_WEBHOOK_SECRET || "").trim();
  const port = Number(process.env.HELPDESK_WEBHOOK_PORT || env.HELPDESK_WEBHOOK_PORT || DEFAULT_PORT);
  const extensionOrigin = (process.env.HELPDESK_WEBHOOK_EXTENSION_ORIGIN || env.HELPDESK_WEBHOOK_EXTENSION_ORIGIN || DEFAULT_EXTENSION_ORIGIN).trim();
  if (!secret) throw new Error("Set HELPDESK_WEBHOOK_SECRET in .env_my before starting the bridge.");
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("HELPDESK_WEBHOOK_PORT must be a valid TCP port.");
  if (!extensionOrigin.startsWith("chrome-extension://")) throw new Error("HELPDESK_WEBHOOK_EXTENSION_ORIGIN must be a chrome-extension origin.");
  return { secret, port, extensionOrigin };
}

async function loadState() {
  try {
    const parsed = JSON.parse(await readFile(STATE_FILE, "utf8"));
    return {
      events: Array.isArray(parsed.events) ? parsed.events.slice(-MAX_REMEMBERED_EVENTS) : [],
      lastEvent: parsed.lastEvent && typeof parsed.lastEvent === "object" ? parsed.lastEvent : null,
    };
  } catch (error) {
    if (error?.code === "ENOENT") return { events: [], lastEvent: null };
    throw error;
  }
}

async function saveState(state) {
  await mkdir(dirname(STATE_FILE), { recursive: true });
  const tempFile = `${STATE_FILE}.${process.pid}.tmp`;
  await writeFile(tempFile, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await rename(tempFile, STATE_FILE);
}

function equalText(left, right) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function normaliseSignature(value) {
  return String(value || "").trim().replace(/^(?:sha256|v1)=/i, "");
}

function verifyRequest(req, rawBody, secret) {
  const timestamp = String(req.headers["x-avada-timestamp"] || "").trim();
  const signature = normaliseSignature(req.headers["x-avada-signature"]);
  if (!timestamp) return { ok: false, reason: "missing x-avada-timestamp" };
  if (!signature) return { ok: false, reason: "missing x-avada-signature" };
  const timestampNumber = Number(timestamp);
  if (!Number.isFinite(timestampNumber)) return { ok: false, reason: "invalid x-avada-timestamp" };
  const timestampMs = Math.abs(timestampNumber) < 1e11 ? timestampNumber * 1_000 : timestampNumber;
  if (Math.abs(Date.now() - timestampMs) > AVADA_SIGNATURE_TOLERANCE_MS) return { ok: false, reason: "stale x-avada-timestamp" };
  // Helpdesk signs the original JSON bytes. Do not parse/re-serialize before
  // this calculation or JSON whitespace/key order will invalidate the HMAC.
  const expected = createHmac("sha256", secret).update(`${timestamp}.${rawBody.toString("utf8")}`).digest("hex");
  if (signature && equalText(signature, expected)) return { ok: true, method: "avada-hmac-sha256", header: "x-avada-signature" };
  return { ok: false, reason: "x-avada-signature mismatch" };
}

function readBody(req) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    let length = 0;
    req.on("data", (chunk) => {
      length += chunk.length;
      if (length > MAX_BODY_BYTES) {
        reject(new Error("Payload exceeds 1 MiB."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolveBody(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function eventSummary(payload, req, rawBody) {
  const eventType = String(payload.event || payload.type || payload.eventType || req.headers["x-avada-event"] || req.headers["x-webhook-event"] || "unknown");
  const ticket = payload.ticket || payload.data?.ticket || payload.data || {};
  const ticketId = String(ticket.id || ticket.ticketId || payload.ticketId || "");
  const explicitId = payload.eventId || payload.deliveryId || payload.id || req.headers["x-avada-delivery"] || req.headers["x-webhook-id"] || req.headers["x-event-id"];
  const bodyHash = createHash("sha256").update(rawBody).digest("hex");
  return {
    id: String(explicitId || bodyHash),
    eventType,
    ticketId: ticketId || null,
    receivedAt: new Date().toISOString(),
    bodyHash,
  };
}

function respond(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(`${JSON.stringify(body)}\n`);
}

function allowExtensionOrigin(req, response, extensionOrigin) {
  const origin = String(req.headers.origin || "");
  if (origin && origin !== extensionOrigin) return false;
  if (origin) response.setHeader("Access-Control-Allow-Origin", extensionOrigin);
  response.setHeader("Vary", "Origin");
  return true;
}

function audit(kind, data = {}) {
  console.log(JSON.stringify({ at: new Date().toISOString(), service: "helpdesk-webhook-bridge", kind, ...data }));
}

async function createBridge(config) {
  let state = await loadState();
  let writingState = Promise.resolve();
  const eventClients = new Set();
  const persist = (nextState) => {
    state = nextState;
    writingState = writingState.then(() => saveState(state));
    return writingState;
  };
  const publishEvent = (summary) => {
    const data = JSON.stringify({ id: summary.id, eventType: summary.eventType, ticketId: summary.ticketId, receivedAt: summary.receivedAt });
    for (const client of eventClients) {
      try {
        client.write(`id: ${summary.id}\nevent: ticket-change\ndata: ${data}\n\n`);
      } catch {
        eventClients.delete(client);
      }
    }
  };

  const server = createServer(async (req, response) => {
    const requestUrl = new URL(req.url || "/", `http://${req.headers.host || HOST}`);
    if (req.method === "OPTIONS" && requestUrl.pathname === "/events") {
      if (!allowExtensionOrigin(req, response, config.extensionOrigin)) {
        respond(response, 403, { ok: false, error: "Extension origin is not allowed." });
        return;
      }
      response.writeHead(204, { "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Max-Age": "600" });
      response.end();
      return;
    }
    if (req.method === "GET" && requestUrl.pathname === "/health") {
      respond(response, 200, { ok: true, service: "helpdesk-webhook-bridge", lastEvent: state.lastEvent });
      return;
    }
    if (req.method === "GET" && requestUrl.pathname === "/events") {
      if (!allowExtensionOrigin(req, response, config.extensionOrigin)) {
        respond(response, 403, { ok: false, error: "Extension origin is not allowed." });
        return;
      }
      response.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      response.write(": connected\n\n");
      eventClients.add(response);
      const heartbeat = setInterval(() => response.write(": keep-alive\n\n"), 25_000);
      req.once("close", () => {
        clearInterval(heartbeat);
        eventClients.delete(response);
      });
      return;
    }
    if (req.method !== "POST" || requestUrl.pathname !== "/webhooks/helpdesk") {
      respond(response, 404, { ok: false, error: "Not found." });
      return;
    }

    try {
      const rawBody = await readBody(req);
      const verification = verifyRequest(req, rawBody, config.secret);
      if (!verification.ok) {
        audit("rejected", { reason: verification.reason, headerNames: Object.keys(req.headers).sort() });
        respond(response, 401, { ok: false, error: "Webhook signature was not accepted." });
        return;
      }
      let payload;
      try {
        payload = JSON.parse(rawBody.toString("utf8"));
      } catch {
        audit("rejected", { reason: "invalid-json", auth: verification.method });
        respond(response, 400, { ok: false, error: "Webhook body must be JSON." });
        return;
      }
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        respond(response, 400, { ok: false, error: "Webhook body must be a JSON object." });
        return;
      }

      const summary = eventSummary(payload, req, rawBody);
      const duplicate = state.events.some((event) => event.id === summary.id || event.bodyHash === summary.bodyHash);
      if (!duplicate) {
        await persist({ events: [...state.events, summary].slice(-MAX_REMEMBERED_EVENTS), lastEvent: summary });
        publishEvent(summary);
      }
      audit(duplicate ? "duplicate" : "accepted", { eventType: summary.eventType, ticketId: summary.ticketId, auth: verification.method });
      respond(response, 202, { ok: true, duplicate, event: { id: summary.id, type: summary.eventType, ticketId: summary.ticketId } });
    } catch (error) {
      const status = error?.message === "Payload exceeds 1 MiB." ? 413 : 500;
      audit("error", { message: error instanceof Error ? error.message : String(error) });
      if (!response.headersSent) respond(response, status, { ok: false, error: "Webhook could not be processed." });
    }
  });
  return { server, getState: () => state };
}

function listen(server, port) {
  return new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(port, HOST, () => {
      server.off("error", reject);
      resolveListen();
    });
  });
}

async function selfTest(config, bridge) {
  const deliveryId = `local-self-test-${Date.now()}`;
  const body = Buffer.from(JSON.stringify({ event: "ticket.updated", eventId: deliveryId, data: { ticket: { id: "self-test-ticket" } } }));
  const timestamp = String(Math.floor(Date.now() / 1_000));
  const signature = createHmac("sha256", config.secret).update(`${timestamp}.${body.toString("utf8")}`).digest("hex");
  const response = await fetch(`http://${HOST}:${config.port}/webhooks/helpdesk`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Avada-Signature": `sha256=${signature}`, "X-Avada-Timestamp": timestamp, "X-Avada-Delivery": deliveryId, "X-Avada-Event": "ticket.updated" },
    body,
  });
  const result = await response.json();
  if (response.status !== 202 || !result.ok || bridge.getState().lastEvent?.id !== deliveryId) throw new Error("Bridge self-test failed.");
  audit("self-test-passed", { port: config.port });
}

async function main() {
  const config = await loadConfig();
  const bridge = await createBridge(config);
  await listen(bridge.server, config.port);
  audit("listening", { host: HOST, port: config.port, endpoint: "/webhooks/helpdesk" });
  if (process.argv.includes("--self-test")) {
    await selfTest(config, bridge);
    const closed = new Promise((resolveClose) => bridge.server.close(resolveClose));
    bridge.server.closeAllConnections();
    await closed;
    return;
  }
  const close = () => bridge.server.close(() => process.exit(0));
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}

main().catch((error) => {
  console.error(`[helpdesk-webhook-bridge] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
