// Feature section of the Tickets page (TS Management web + Chrome extension): Andrew's Helpdesk tickets whose
// tsStatus is `feature_request`, shown under Dev fix with the progress that the feature-follow skill
// (skills/feature-follow, Hanski, 12/10/2026) assessed from each ticket's Slack thread.
//
// This module only shapes data for the interface. It reads nothing from Helpdesk or Slack and writes nothing:
// the server passes it the skill's state file (runtime/feature-follow/state.json) and the last manual preview
// scan (`node skills/feature-follow/scripts/run.mjs --preview --json`), and gets back one summary per ticket.
import { resolve } from "node:path";
import { readFile } from "node:fs/promises";

export const FEATURE_TS_STATUS = "feature_request";
export const FEATURE_PROGRESS_PREFIX = "[FEATURE FOLLOW |";
export const FEATURE_DRAFT_PREFIX = "[DRAFT — feature";
// 48 hours without a Slack update: same threshold the Dev fix section uses for "Cần nhắc dev follow up".
export const FEATURE_REMINDER_AFTER_MS = 48 * 60 * 60 * 1000;
// Statuses where nobody is waiting on the dev side, so no reminder is due.
const SETTLED = new Set(["done", "declined", "awaiting_customer"]);

// Labels agreed with Hanski (skills/feature-follow core STATUS_LABELS); the skill's own label wins when it sends one.
export const FEATURE_STATUS_LABELS = Object.freeze({
  no_response: "Dev/PM chưa phản hồi",
  acknowledged: "Dev/PM đã nhận yêu cầu",
  in_progress: "Đang phát triển",
  awaiting_merge: "Chờ review/release",
  awaiting_verification: "Đã release, chờ kiểm tra",
  done: "Feature đã release",
  awaiting_customer: "Chờ khách cung cấp thông tin",
  declined: "Dev/PM từ chối hoặc chưa làm",
  blocked: "Đang bị chặn",
  unknown: "Chưa đủ dữ liệu để kết luận",
  missing_thread: "Thiếu Slack thread",
});

export const featureStatusLabel = (status, fallback = "") => fallback || FEATURE_STATUS_LABELS[status] || (status ? String(status) : "Chưa quét");

const text = (value, max = 0) => { const out = String(value ?? "").trim(); return max && out.length > max ? `${out.slice(0, max - 1).trimEnd()}…` : out; };
const time = value => { const ms = Date.parse(value || ""); return Number.isFinite(ms) ? ms : 0; };

// One ticket's entry from the skill's state file (keyed by Helpdesk ticket id).
function fromState(id, entry) {
  const assessment = entry?.assessment && typeof entry.assessment === "object" ? entry.assessment : {};
  return {
    id: String(id), reference: text(entry?.reference), source: "timer",
    status: text(assessment.status), statusLabel: featureStatusLabel(text(assessment.status)),
    progress: text(assessment.progress), latestUpdate: text(assessment.latestUpdate), waitingFor: text(assessment.waitingFor),
    confidence: text(assessment.confidence), draftKind: text(assessment.draftKind) || "none", draftMail: text(assessment.draftMail),
    assessedAt: text(entry?.assessedAt), postedAt: text(entry?.postedAt), latestSlackAt: text(assessment.latestMeaningfulAt || entry?.latestSlackAt),
    scanAt: "", scanDraft: "", scanComment: "", scanError: "",
  };
}

// One ticket's entry from the last manual preview scan (run.mjs --json result item).
function fromScan(item, scanAt) {
  const draft = item?.draft && typeof item.draft === "object" ? item.draft : {};
  const progress = item?.progress && typeof item.progress === "object" ? item.progress : {};
  return {
    id: text(item?.id), reference: text(item?.reference), source: "scan",
    status: text(item?.status), statusLabel: featureStatusLabel(text(item?.status), text(item?.statusLabel)),
    progress: "", latestUpdate: "", waitingFor: "", confidence: "", draftKind: text(draft.kind) || "none", draftMail: "",
    assessedAt: scanAt, postedAt: "", latestSlackAt: "",
    scanAt, scanDraft: text(draft.content), scanComment: text(progress.content), scanError: text(item?.error),
  };
}

// Reminder: the thread has been silent for 48 h and the dev side still owes an answer (never for a settled status).
export function featureReminderDue(summary, now = Date.now()) {
  const since = time(summary?.latestSlackAt);
  if (!since || SETTLED.has(summary?.status)) return { due: false, silentHours: 0 };
  const silentMs = now - since;
  return { due: silentMs >= FEATURE_REMINDER_AFTER_MS, silentHours: Math.floor(silentMs / 3_600_000) };
}

// Merge the timer state and the last manual scan into one summary per ticket. The newer assessment decides status;
// the scan keeps its draft/comment preview, the timer keeps its progress text and Slack timestamp.
export function featureFollowSummary({ stateJson = null, scan = null, now = Date.now() } = {}) {
  const byId = new Map();
  const entries = stateJson?.tickets && typeof stateJson.tickets === "object" ? Object.entries(stateJson.tickets) : [];
  for (const [id, entry] of entries) if (id) byId.set(String(id), fromState(id, entry));
  const scanAt = text(scan?.at);
  const results = Array.isArray(scan?.results) ? scan.results : [];
  for (const item of results) {
    const fresh = fromScan(item, scanAt);
    const key = fresh.id || [...byId.values()].find(known => known.reference && known.reference === fresh.reference)?.id || fresh.reference;
    if (!key) continue;
    const known = byId.get(key);
    if (!known) { byId.set(key, fresh); continue; }
    const scanIsNewer = time(scanAt) >= time(known.assessedAt);
    byId.set(key, {
      ...known,
      status: scanIsNewer && fresh.status ? fresh.status : known.status,
      statusLabel: scanIsNewer && fresh.status ? fresh.statusLabel : known.statusLabel,
      draftKind: scanIsNewer && fresh.draftKind !== "none" ? fresh.draftKind : known.draftKind,
      scanAt, scanDraft: fresh.scanDraft, scanComment: fresh.scanComment, scanError: fresh.scanError,
      source: scanIsNewer ? "scan" : known.source,
    });
  }
  const tickets = {};
  const byReference = {};
  for (const [id, summary] of byId) {
    const reminder = featureReminderDue(summary, now);
    const full = { ...summary, reminderDue: reminder.due, silentHours: reminder.silentHours, progressShort: text(summary.progress, 220) };
    tickets[id] = full;
    if (full.reference) byReference[full.reference] = full;
  }
  return {
    tickets, byReference,
    stateAt: text(stateJson?.lastRun?.finishedAt), lastSlot: text(stateJson?.lastRun?.slot),
    scanAt, scanTicket: text(scan?.ticket), scanError: text(scan?.error),
  };
}

// Pick the summary for a Helpdesk ticket object (internal id first, reference second).
export function featureSummaryFor(payload, ticket) {
  if (!payload || !ticket) return null;
  return payload.tickets?.[String(ticket.id || "")] || payload.byReference?.[String(ticket.ticketId || "")] || null;
}

// Parse the JSON that `run.mjs --json` prints: the whole stdout, or its last JSON line when something else was logged.
export function parseScanOutput(stdout) {
  const raw = String(stdout || "").trim();
  if (!raw) throw new Error("feature-follow không in kết quả.");
  try { return JSON.parse(raw); } catch { /* fall through to the last JSON-looking line */ }
  const lines = raw.split("\n").map(line => line.trim()).filter(line => line.startsWith("{"));
  for (let index = lines.length - 1; index >= 0; index -= 1) { try { return JSON.parse(lines[index]); } catch { /* keep looking */ } }
  throw new Error("feature-follow in ra kết quả không phải JSON.");
}

export async function readFeatureFollowState(file = resolve(process.cwd(), "runtime/feature-follow/state.json")) {
  try { return JSON.parse(await readFile(file, "utf8")); } catch { return null; }
}
