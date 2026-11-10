#!/usr/bin/env node

// Sends a read-only ticket-review request through the already authenticated
// TS Management Chrome extension. Send the message verbatim and let TS Elite
// retrieve the ticket itself. The extension owns the TS Elite token.

const BRIDGE_URL = "http://127.0.0.1:39541/codex-ts-elite/review";
const timeoutMs = 190_000;
const [ticketReference, ...messageParts] = process.argv.slice(2);

if (!ticketReference) {
  console.error("Usage: node scripts/review-ticket-via-ts-elite.mjs <TICKET_URL_OR_ID> [review request]");
  process.exitCode = 1;
} else {
  try {
    const ticketUrl = /^https?:\/\//i.test(ticketReference)
      ? new URL(ticketReference)
      : new URL(`https://helpdesk.avada.net/t/${encodeURIComponent(ticketReference)}`);
    const match = ticketUrl.pathname.match(/^\/(?:t|tickets)\/([a-zA-Z0-9_-]+)\/?$/);
    if (ticketUrl.hostname !== "helpdesk.avada.net" || !match || ticketUrl.username || ticketUrl.password) {
      throw new Error("Expected a Helpdesk ticket URL or ticket ID.");
    }
    const ticketId = match[1];
    const message = messageParts.join(" ").trim() || `Check ticket ${ticketUrl.href}`;
    const response = await fetch(BRIDGE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Codex-TS-Elite-Bridge": "1",
      },
      // The existing summaryOnly transport flag disables context enrichment;
      // it does not add a summarization instruction to the message.
      body: JSON.stringify({ ticketId, message, summaryOnly: true }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body.answer) throw new Error(body.error || `Local bridge returned HTTP ${response.status}.`);
    console.log(body.answer.trim());
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
