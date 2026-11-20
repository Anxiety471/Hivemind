/**
 * Records spendingPeriodStart results from the TypeScript implementation for
 * the Go port's golden test (internal/procedures/spendinglimit/testdata).
 * Run from a checkout that has node_modules, e.g. the deployed one:
 *   node_modules/.bin/tsx apps/api-go/tools/period-golden.mts > period_golden.json
 */
import { spendingPeriodStart } from "../../../packages/core/src/billing/spending.js";

const zones = [
  "UTC",
  "America/New_York",
  "Europe/London",
  "Asia/Kolkata",
  "Asia/Kathmandu",
  "Pacific/Auckland",
  "Australia/Lord_Howe",
  "America/St_Johns",
  "America/Sao_Paulo",
  "Asia/Beirut",
  "America/Havana",
  "America/Santiago",
  "Africa/Cairo",
  "Pacific/Apia",
  "Atlantic/Azores",
  "America/Asuncion",
  "Asia/Tokyo",
  "Pacific/Kiritimati",
  "america/new_york",
  "No/Such_Zone",
];
const periods = ["day", "week", "month"] as const;
const startsAt = new Date("2026-01-01T00:00:00.000Z");
const cases: Array<[string, string, number, number]> = [];
function add(zone: string, instant: number) {
  for (const period of periods) {
    const start = spendingPeriodStart(period, startsAt, zone, new Date(instant));
    cases.push([zone, period, instant, start.getTime()]);
  }
}
let seed = 12345;
const random = () => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
};
const from = Date.UTC(2018, 0, 1);
const to = Date.UTC(2027, 0, 1);
for (const zone of zones)
  for (let i = 0; i < 120; i += 1) add(zone, Math.floor(from + random() * (to - from)));
// Midnight gaps and overlaps: every hour for two days around the change.
const windows: Array<[string, string]> = [
  ["America/Sao_Paulo", "2018-11-04T00:00:00Z"],
  ["America/Sao_Paulo", "2018-02-17T12:00:00Z"],
  ["Asia/Beirut", "2023-03-26T00:00:00Z"],
  ["Asia/Beirut", "2023-10-29T00:00:00Z"],
  ["America/Havana", "2024-03-10T00:00:00Z"],
  ["America/Havana", "2024-11-03T00:00:00Z"],
  ["America/Santiago", "2024-09-07T12:00:00Z"],
  ["America/Santiago", "2024-04-06T12:00:00Z"],
  ["Africa/Cairo", "2023-04-28T00:00:00Z"],
  ["Africa/Cairo", "2023-10-27T00:00:00Z"],
  ["Pacific/Apia", "2011-12-29T00:00:00Z"],
  ["Atlantic/Azores", "2024-03-31T00:00:00Z"],
  ["America/Asuncion", "2024-10-06T00:00:00Z"],
  ["America/New_York", "2024-03-10T00:00:00Z"],
  ["America/New_York", "2024-11-03T00:00:00Z"],
  ["Australia/Lord_Howe", "2024-10-06T00:00:00Z"],
  ["Pacific/Auckland", "2024-09-29T00:00:00Z"],
];
for (const [zone, at] of windows) {
  const base = Date.parse(at) - 24 * 3_600_000;
  for (let hour = 0; hour < 72; hour += 1) add(zone, base + hour * 3_600_000);
}
process.stdout.write(JSON.stringify(cases));
