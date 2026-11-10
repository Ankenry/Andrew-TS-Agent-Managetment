// node --test scripts/apps-doc-sync.test.mjs — schedule math and lock of the weekly apps_doc sync.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lastDueAt, isDue, zonedTimeToUtc, acquireLock, releaseLock, SCHEDULE } from "./apps-doc-sync-if-due.mjs";

const vn = (iso) => Date.parse(iso); // ISO strings below carry +07:00 explicitly

test("zonedTimeToUtc converts Asia/Ho_Chi_Minh wall-clock to UTC (+07:00, no DST)", () => {
  assert.equal(zonedTimeToUtc({ year: 2026, month: 10, day: 11, hour: 3, minute: 30 }, "Asia/Ho_Chi_Minh"), vn("2026-10-11T03:30:00+07:00"));
  assert.equal(zonedTimeToUtc({ year: 2026, month: 3, day: 29, hour: 3, minute: 30 }, "Europe/Berlin"), Date.parse("2026-03-29T03:30:00+02:00"), "DST day handled");
});

test("lastDueAt: most recent Sunday 03:30 VN at or before now", () => {
  // 2026-10-11 is a Sunday.
  assert.equal(lastDueAt(vn("2026-10-09T17:00:00+07:00")), vn("2026-10-04T03:30:00+07:00"), "Friday → previous Sunday");
  assert.equal(lastDueAt(vn("2026-10-11T03:29:59+07:00")), vn("2026-10-04T03:30:00+07:00"), "Sunday just before the slot → previous Sunday");
  assert.equal(lastDueAt(vn("2026-10-11T03:30:00+07:00")), vn("2026-10-11T03:30:00+07:00"), "exactly at the slot");
  assert.equal(lastDueAt(vn("2026-10-11T23:00:00+07:00")), vn("2026-10-11T03:30:00+07:00"), "Sunday evening");
  assert.equal(lastDueAt(vn("2026-10-12T00:10:00+07:00")), vn("2026-10-11T03:30:00+07:00"), "Monday 00:10 VN (still Sunday in UTC)");
  assert.equal(SCHEDULE.weekday, 0);
});

test("isDue: no record, or last sync older than the latest slot", () => {
  const now = vn("2026-10-13T09:00:00+07:00"); // Tuesday; latest slot Sunday 11/10 03:30
  assert.equal(isDue(null, now), true);
  assert.equal(isDue("not a date", now), true);
  assert.equal(isDue("2026-10-10T20:00:00+07:00", now), true, "synced Saturday → Sunday slot missed → due");
  assert.equal(isDue("2026-10-11T03:31:00+07:00", now), false, "timer ran Sunday → not due");
  assert.equal(isDue("2026-10-12T08:00:00+07:00", now), false, "catch-up ran Monday → not due again this week");
  assert.equal(isDue("2026-10-12T08:00:00+07:00", vn("2026-10-18T04:00:00+07:00")), true, "next Sunday after the slot → due again");
});

test("acquireLock: exclusive, honours a live holder, takes over stale or dead ones", async () => {
  const dir = mkdtempSync(join(tmpdir(), "apps-doc-lock-"));
  const file = join(dir, "sync.lock");
  const now = Date.now();
  assert.deepEqual(await acquireLock(file, { pid: 111, now, isAlive: () => true }), { ok: true });
  const busy = await acquireLock(file, { pid: 222, now: now + 1000, isAlive: () => true });
  assert.equal(busy.ok, false); assert.equal(busy.holder.pid, 111);
  const dead = await acquireLock(file, { pid: 333, now: now + 2000, isAlive: () => false });
  assert.equal(dead.ok, true, "dead holder → taken over");
  const stale = await acquireLock(file, { pid: 444, now: now + 3 * 60 * 60 * 1000, isAlive: () => true });
  assert.equal(stale.ok, true, "holder older than 2 h → taken over");
  writeFileSync(file, "garbage");
  assert.equal((await acquireLock(file, { pid: 555, now, isAlive: () => true })).ok, true, "unreadable lock → taken over");
  await releaseLock(file);
  assert.equal(existsSync(file), false);
});
