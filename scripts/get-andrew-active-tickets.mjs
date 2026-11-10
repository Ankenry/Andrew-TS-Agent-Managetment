#!/usr/bin/env node

/**
 * Read-only CLI for Andrew's currently active Avada Helpdesk tickets.
 *
 * Prerequisite: `.env_my` contains API_AVADA_TICKET=avd_...
 * Run: node scripts/get-andrew-active-tickets.mjs
 *      node scripts/get-andrew-active-tickets.mjs --json
 *
 * This script only sends GET requests. It never creates or updates tickets.
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { recordHelpdeskUsage, usageCaller } from "./helpdesk-usage.mjs";

const BASE_URL = (
  process.env.AVADA_TICKET_BASE_URL ||
  "https://helpdesk.avada.net/api/external"
).replace(/\/$/, "");

const ACTIVE_STATUSES = [
  "pending",
  "doing",
  "waiting_customer",
  "waiting_permission",
];

const ANDREW_EMAIL = "annvh@avadagroup.com";
// Firebase UID in Avada Helpdesk. This is an identifier, not a secret. Set
// ANDREW_TICKET_MEMBER_ID to override it if Andrew's Helpdesk account changes.
const ANDREW_MEMBER_ID = process.env.ANDREW_TICKET_MEMBER_ID || "HEYWuzF9rTdG59pE8TNtBKL6W1x1";
const MAX_PAGES_PER_STATUS = 20;

function parseEnvFile(contents) {
  const values = {};

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const separator = line.indexOf("=");
    if (separator < 1) continue;

    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }

  return values;
}

async function getApiKey() {
  if (process.env.API_AVADA_TICKET) return process.env.API_AVADA_TICKET;

  const envPath = resolve(process.cwd(), ".env_my");
  let contents;
  try {
    contents = await readFile(envPath, "utf8");
  } catch {
    throw new Error(
      "Không đọc được .env_my. Hãy tạo file này với API_AVADA_TICKET=avd_<your_api_key>.",
    );
  }

  const apiKey = parseEnvFile(contents).API_AVADA_TICKET;
  if (!apiKey) {
    throw new Error("Thiếu API_AVADA_TICKET trong .env_my.");
  }
  return apiKey;
}

async function apiGet(path, apiKey) {
  const flow = usageCaller(new Error().stack);
  let response;
  try { response = await fetch(`${BASE_URL}${path}`, {
    headers: { "X-API-Key": apiKey },
    signal: AbortSignal.timeout(30_000),
  }); }
  finally { await recordHelpdeskUsage({ flow, path, status:response?.status || 0 }).catch(() => {}); }

  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.success) {
    const message = body?.error?.message || `HTTP ${response.status}`;
    throw new Error(`Helpdesk API request failed (${path}): ${message}`);
  }

  return body.data;
}

async function findAndrew(apiKey) {
  const data = await apiGet("/members?limit=100", apiKey);
  const members = data?.members || [];

  const member = members.find((candidate) => {
    const email = String(candidate.email || "").toLowerCase();
    const displayName = String(candidate.displayName || "").toLowerCase();
    return (
      email === ANDREW_EMAIL ||
      displayName === "andrew" ||
      displayName === "andrew_avada"
    );
  });

  // Some admin API keys return a partial member roster. The ticket member ID
  // is stable, so retain the known ID as a safe read-only fallback.
  return member || {
    id: ANDREW_MEMBER_ID,
    displayName: "Andrew",
    email: ANDREW_EMAIL,
  };
}

async function listTicketsForStatus(tsStatus, apiKey) {
  const tickets = [];
  let cursor = null;

  for (let page = 0; page < MAX_PAGES_PER_STATUS; page += 1) {
    const params = new URLSearchParams({ tsStatus, limit: "100" });
    if (cursor) params.set("cursor", cursor);

    const data = await apiGet(`/tickets/admin?${params}`, apiKey);
    tickets.push(...(data?.tickets || []));

    // The live API can omit `hasMore` while still returning a nextCursor.
    // Treat the cursor as the pagination signal, but respect an explicit
    // `hasMore: false` from API versions that provide it.
    if (data?.hasMore === false || !data?.nextCursor) break;
    cursor = data.nextCursor;

    if (page === MAX_PAGES_PER_STATUS - 1) {
      throw new Error(`Dừng ở giới hạn ${MAX_PAGES_PER_STATUS} trang cho status ${tsStatus}.`);
    }
  }

  return tickets;
}

function isAssignedTo(ticket, memberId) {
  return Array.isArray(ticket.members) && ticket.members.some(
    (member) => member?.memberId === memberId || member?.id === memberId,
  );
}

async function main() {
  const jsonOutput = process.argv.includes("--json");
  const apiKey = await getApiKey();
  const andrew = await findAndrew(apiKey);

  const statusResults = await Promise.all(
    ACTIVE_STATUSES.map((status) => listTicketsForStatus(status, apiKey)),
  );

  const seenTicketIds = new Set();
  const tickets = statusResults
    .flat()
    .filter((ticket) => isAssignedTo(ticket, andrew.id))
    .filter((ticket) => {
      const id = String(ticket.id || ticket.ticketId || "");
      if (!id || seenTicketIds.has(id)) return false;
      seenTicketIds.add(id);
      return true;
    })
    .sort((left, right) => String(right.createdAt || "").localeCompare(String(left.createdAt || "")));

  if (jsonOutput) {
    console.log(JSON.stringify({ member: andrew, activeStatuses: ACTIVE_STATUSES, tickets }, null, 2));
    return;
  }

  console.log(`Andrew: ${andrew.displayName || "Andrew"} (${andrew.id})`);
  console.log(`Active tickets: ${tickets.length}`);
  console.table(tickets.map((ticket) => ({
    id: ticket.ticketId || ticket.id,
    status: ticket.tsStatus,
    priority: ticket.priority || "",
    app: ticket.appName || "",
    createdAt: ticket.createdAt || "",
    subject: ticket.subject || "",
  })));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
