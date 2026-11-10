// node --test scripts/feature-section.test.mjs — Feature section data shaping (no Helpdesk, no files).
import test from "node:test";
import assert from "node:assert/strict";
import { featureFollowSummary, featureReminderDue, featureStatusLabel, featureSummaryFor, parseScanOutput, FEATURE_TS_STATUS, FEATURE_REMINDER_AFTER_MS } from "./feature-section.mjs";

const NOW = Date.parse("2026-10-12T05:00:00Z");
const stateJson = {
  version: 1,
  lastRun: { slot: "2026-10-12T10:00", mode: "scheduled", finishedAt: "2026-10-12T03:00:40Z", tickets: 2, failed: 0 },
  tickets: {
    T1: { reference: "CHAT-261011-MyeDrL", assessedAt: "2026-10-12T03:00:30Z", postedAt: "2026-10-12T03:00:35Z", latestSlackAt: "2026-10-09T02:00:00Z",
      assessment: { status: "acknowledged", progress: "PM đã nhận yêu cầu Store availability đọc toàn bộ, chưa có ETA.", latestUpdate: "PM nói sẽ xem.", latestMeaningfulAt: "2026-10-09T02:00:00Z", waitingFor: "dev", draftKind: "none", draftMail: "", confidence: "high" } },
    T2: { reference: "CHAT-261009-K25e69", assessedAt: "2026-10-12T03:00:31Z", latestSlackAt: "2026-10-11T20:00:00Z",
      assessment: { status: "done", progress: "Đã release.", latestMeaningfulAt: "2026-10-11T20:00:00Z", waitingFor: "none", draftKind: "released", draftMail: "Chào bạn, feature đã lên." } },
    T3: { reference: "AIR-261001-24v44K", assessedAt: "2026-10-12T03:00:32Z", latestSlackAt: "2026-10-11T23:30:00Z", assessment: { status: "in_progress", progress: "Dev đang làm.", latestMeaningfulAt: "2026-10-11T23:30:00Z", waitingFor: "dev" } },
  },
};

test("status labels follow the agreed table and fall back to the raw status or 'Chưa quét'", () => {
  assert.equal(FEATURE_TS_STATUS, "feature_request");
  assert.equal(featureStatusLabel("in_progress"), "Đang phát triển");
  assert.equal(featureStatusLabel("in_progress", "Nhãn từ skill"), "Nhãn từ skill");
  assert.equal(featureStatusLabel("weird"), "weird");
  assert.equal(featureStatusLabel(""), "Chưa quét");
});

test("the reminder is due after 48 silent hours unless the status is settled", () => {
  assert.deepEqual(featureReminderDue({ latestSlackAt: "2026-10-09T02:00:00Z", status: "acknowledged" }, NOW), { due: true, silentHours: 75 });
  assert.deepEqual(featureReminderDue({ latestSlackAt: "2026-10-11T23:30:00Z", status: "in_progress" }, NOW), { due: false, silentHours: 5 });
  assert.equal(featureReminderDue({ latestSlackAt: "2026-10-01T00:00:00Z", status: "done" }, NOW).due, false);
  assert.equal(featureReminderDue({ latestSlackAt: "2026-10-01T00:00:00Z", status: "awaiting_customer" }, NOW).due, false);
  assert.equal(featureReminderDue({ latestSlackAt: "", status: "no_response" }, NOW).due, false);
  assert.equal(FEATURE_REMINDER_AFTER_MS, 48 * 3_600_000);
});

test("the timer state alone gives one summary per ticket with label, progress and reminder", () => {
  const payload = featureFollowSummary({ stateJson, now: NOW });
  assert.equal(Object.keys(payload.tickets).length, 3);
  const first = payload.tickets.T1;
  assert.equal(first.statusLabel, "Dev/PM đã nhận yêu cầu");
  assert.equal(first.source, "timer");
  assert.equal(first.reminderDue, true);
  assert.equal(first.silentHours, 75);
  assert.equal(first.progressShort, "PM đã nhận yêu cầu Store availability đọc toàn bộ, chưa có ETA.");
  assert.equal(payload.tickets.T2.reminderDue, false);
  assert.equal(payload.tickets.T2.draftMail, "Chào bạn, feature đã lên.");
  assert.equal(payload.byReference["AIR-261001-24v44K"].id, "T3");
  assert.equal(payload.stateAt, "2026-10-12T03:00:40Z");
  assert.equal(payload.lastSlot, "2026-10-12T10:00");
  assert.equal(payload.scanAt, "");
});

test("a newer manual scan overrides the status and carries its draft/comment preview; an older one does not", () => {
  const scan = { at: "2026-10-12T04:30:00Z", ticket: "", results: [
    { id: "T1", reference: "CHAT-261011-MyeDrL", status: "in_progress", statusLabel: "Đang phát triển", draft: { kind: "none", action: "none" }, progress: { action: "post", changed: true, content: "[FEATURE FOLLOW | 11:30 12/10/2026] Đang phát triển\nDev đã bắt đầu." } },
    { id: "T9", reference: "NEW-261012-abcd", subject: "Mới", status: "no_response", draft: { kind: "none" }, progress: { action: "skip" } },
    { reference: "AIR-261001-24v44K", status: "done", draft: { kind: "released", action: "save", content: "Chào bạn…" }, progress: { action: "post", content: "x" } },
  ] };
  const payload = featureFollowSummary({ stateJson, scan, now: NOW });
  assert.equal(payload.tickets.T1.status, "in_progress");
  assert.equal(payload.tickets.T1.source, "scan");
  assert.equal(payload.tickets.T1.progress, "PM đã nhận yêu cầu Store availability đọc toàn bộ, chưa có ETA.");
  assert.match(payload.tickets.T1.scanComment, /^\[FEATURE FOLLOW \|/);
  assert.equal(payload.tickets.T1.reminderDue, true, "the Slack timestamp still comes from the timer state");
  assert.equal(payload.tickets.T9.statusLabel, "Dev/PM chưa phản hồi");
  assert.equal(payload.tickets.T9.source, "scan");
  assert.equal(payload.tickets.T3.status, "done", "matched by reference when the scan item has no id");
  assert.equal(payload.tickets.T3.scanDraft, "Chào bạn…");
  assert.equal(payload.tickets.T3.draftKind, "released");
  assert.equal(payload.scanAt, "2026-10-12T04:30:00Z");

  const older = featureFollowSummary({ stateJson, scan: { ...scan, at: "2026-10-11T00:00:00Z" }, now: NOW });
  assert.equal(older.tickets.T1.status, "acknowledged");
  assert.equal(older.tickets.T1.source, "timer");
  assert.match(older.tickets.T1.scanComment, /FEATURE FOLLOW/, "the preview text is still shown");
});

test("featureSummaryFor matches a Helpdesk ticket by internal id, then by reference", () => {
  const payload = featureFollowSummary({ stateJson, now: NOW });
  assert.equal(featureSummaryFor(payload, { id: "T2", ticketId: "CHAT-261009-K25e69" }).status, "done");
  assert.equal(featureSummaryFor(payload, { id: "other", ticketId: "AIR-261001-24v44K" }).status, "in_progress");
  assert.equal(featureSummaryFor(payload, { id: "none", ticketId: "X" }), null);
  assert.equal(featureSummaryFor(null, { id: "T2" }), null);
});

test("parseScanOutput reads a whole-JSON stdout or the last JSON line, and rejects noise", () => {
  assert.deepEqual(parseScanOutput('{"mode":"preview","results":[]}'), { mode: "preview", results: [] });
  assert.deepEqual(parseScanOutput('warn: something\n{"bad":\n{"mode":"preview","results":[{"id":"T1"}]}\n'), { mode: "preview", results: [{ id: "T1" }] });
  assert.throws(() => parseScanOutput(""), /không in kết quả/);
  assert.throws(() => parseScanOutput("just text"), /không phải JSON/);
});
