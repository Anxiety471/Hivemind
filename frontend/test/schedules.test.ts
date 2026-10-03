// Run with: bun test test/schedules.test.ts   (or: node --experimental-strip-types --test test/schedules.test.ts)
import assert from "node:assert/strict";
import { test } from "node:test";
import { humanDuration, isPending, recurrence, relativeDue, sortSchedules } from "../src/scheduleFormat.ts";

test("durations read in the largest units", () => {
  assert.equal(humanDuration(45), "45s");
  assert.equal(humanDuration(90), "1m 30s");
  assert.equal(humanDuration(3600), "1h");
  assert.equal(humanDuration(3660), "1h 1m");
  assert.equal(humanDuration(3630), "1h");
  assert.equal(humanDuration(7 * 86400), "7d");
  assert.equal(humanDuration(86400 + 7200), "1d 2h");
});

test("due times count down coarsely and say when overdue", () => {
  assert.equal(relativeDue(1000, 1000), "due now");
  assert.equal(relativeDue(1000 + 250, 1000), "in 4m");
  assert.equal(relativeDue(1000 + 2 * 3600 + 600, 1000), "in 2h");
  assert.equal(relativeDue(1000 - 90, 1000), "1m overdue");
});

test("recurrence describes one-off, bounded and open repeats", () => {
  assert.equal(recurrence({ repeat_seconds: null, repeat_count: null, fires: 0 }), "Once");
  assert.equal(recurrence({ repeat_seconds: 900, repeat_count: 10, fires: 3 }), "Every 15m · 3 of 10");
  assert.equal(recurrence({ repeat_seconds: 3600, repeat_count: null, fires: 0 }), "Every 1h · until cancelled");
  assert.equal(recurrence({ repeat_seconds: 86400, repeat_count: null, fires: 4 }), "Every 1d · fired 4");
});

test("pending wakeups sort first by due time, finished ones newest first", () => {
  const s = (id: string, state: any, due_at: number) => ({ id, state, due_at, created_at: 0 });
  const sorted = sortSchedules([s("old", "completed", 10), s("late", "queued", 300), s("new", "cancelled", 50), s("soon", "dispatched", 100)]);
  assert.deepEqual(sorted.map((x) => x.id), ["soon", "late", "new", "old"]);
  assert.ok(isPending({ state: "queued" }));
  assert.ok(!isPending({ state: "failed" }));
});
