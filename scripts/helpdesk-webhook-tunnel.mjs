#!/usr/bin/env node

// Run under a supervisor (Restart=always). Reclaim only the configured URL;
// never silently switch the Helpdesk receiver to a random hostname.
import { createRequire } from "node:module";

const [modulePath, subdomain, portText = "39543"] = process.argv.slice(2);
const port = Number(portText);
if (!modulePath || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(subdomain || "") || !Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("Usage: helpdesk-webhook-tunnel.mjs <localtunnel module path> <subdomain> [port]");
}
const localtunnel = createRequire(import.meta.url)(modulePath);
const expectedUrl = `https://${subdomain}.loca.lt`;
let tunnel;
let stopping = false;
let checking = false;
let failures = 0;
let healthTimer;

function stop(code, reason) {
  if (stopping) return;
  stopping = true;
  clearInterval(healthTimer);
  console.log(JSON.stringify({ at: new Date().toISOString(), kind: "stopping", reason }));
  tunnel?.close();
  process.exit(code);
}

process.on("SIGTERM", () => stop(0, "SIGTERM"));
process.on("SIGINT", () => stop(0, "SIGINT"));
const startupTimer = setTimeout(() => stop(1, "Tunnel startup timed out"), 60_000);
tunnel = localtunnel({ port, local_host: "127.0.0.1", subdomain }, (error, client) => {
  if (error) return stop(1, error.message);
  if (client.url !== expectedUrl) {
    console.error(JSON.stringify({ at: new Date().toISOString(), kind: "hostname-unavailable", requested: expectedUrl, assigned: client.url }));
    return stop(1, "Requested hostname unavailable; refusing replacement URL");
  }
  clearTimeout(startupTimer);
  console.log(JSON.stringify({ at: new Date().toISOString(), kind: "allocated", url: client.url }));
  healthTimer = setInterval(checkHealth, 30_000);
  void checkHealth();
});
tunnel.on("error", (error) => stop(1, error.message));
tunnel.on("close", () => stop(1, "Tunnel closed"));

async function checkHealth() {
  if (checking || stopping) return;
  checking = true;
  try {
    const response = await fetch(`${expectedUrl}/health`, {
      headers: { "bypass-tunnel-reminder": "1" },
      signal: AbortSignal.timeout(10_000),
    });
    const body = await response.json();
    if (!response.ok || body.ok !== true || body.service !== "helpdesk-webhook-bridge") throw new Error("Receiver health check failed");
    failures = 0;
    console.log(JSON.stringify({ at: new Date().toISOString(), kind: "healthy", status: response.status }));
  } catch {
    failures += 1;
    console.error(JSON.stringify({ at: new Date().toISOString(), kind: "unhealthy", failures }));
    if (failures >= 3) stop(1, "Public receiver failed three health checks");
  } finally {
    checking = false;
  }
}
