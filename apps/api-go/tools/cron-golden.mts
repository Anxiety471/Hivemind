/**
 * Records nextCronDate/nextCronDateAcross results from the TypeScript
 * implementation for the Go port's golden test (internal/cron/testdata).
 * Run from the repo root:
 *   node_modules/.bin/tsx apps/api-go/tools/cron-golden.mts > apps/api-go/internal/cron/testdata/cron_golden.json
 *
 * Every case carries the cron list, the starting instant, the timezone and the
 * ISO result (null when TypeScript throws or there is no next run). Cases with
 * one cron also pin nextCronDate directly; multi-cron cases pin the earliest
 * recurring match that nextCronDateAcross returns.
 */
import { nextCronDate, nextCronDateAcross } from "../../../packages/core/src/routines/schedule.js";

type GoldenCase = {
  name: string;
  crons: string[];
  from: string;
  timezone: string;
  want: string | null;
};

const cases: GoldenCase[] = [];
const seen = new Set<string>();

function add(name: string, crons: string[], from: string, timezone: string) {
  const key = JSON.stringify([crons, from, timezone]);
  if (seen.has(key)) return;
  seen.add(key);
  let want: string | null;
  try {
    want = nextCronDateAcross(crons, new Date(from), timezone)?.toISOString() ?? null;
  } catch {
    want = null;
  }
  if (crons.length === 1) {
    // A single cron must agree with nextCronDate itself: throwing is null here.
    let single: string | null;
    try {
      single = nextCronDate(crons[0] as string, new Date(from), timezone).toISOString();
    } catch {
      single = null;
    }
    if (single !== want) {
      throw new Error(`case ${name}: nextCronDate ${single} != across ${want}`);
    }
  }
  cases.push({ name, crons, from, timezone, want });
}

// Every syntax feature croner accepts through nextCronDate's five-field gate.
const SYNTAX = [
  // Plain fields, steps and lists.
  "* * * * *",
  "*/5 * * * *",
  "*/1 * * * *",
  "0 * * * *",
  "15 3 * * *",
  "0 0 * * *",
  "0 12 * * *",
  "30 23 * * *",
  "0,30 * * * *",
  "5,10-12/2 * * * *",
  "0 0,6,12,18 * * *",
  "0 0 */2 * *",
  "0 0 * */3 *",
  "0 0 1-31/7 * *",
  // Day of month edges, month ends and leap years.
  "0 0 1 * *",
  "0 0 31 * *",
  "0 0 30 * *",
  "0 0 29 2 *",
  "0 0 29 2 1",
  "0 0 31 4 *",
  "0 0 31 4,6 *",
  "0 0 L * *",
  "0 0 L 2 *",
  "0 0 LW * *",
  "0 0 1W * *",
  "0 0 15W * *",
  "0 0 31W * *",
  "0 0 1,15W * *",
  // Day-of-week forms, nth and last.
  "0 0 * * 0",
  "0 0 * * 7",
  "0 0 * * 1-5",
  "0 0 * * 6-0",
  "0 0 * * 0-7",
  "0 0 * * 5#2",
  "0 0 * * 5L",
  "0 0 * * 5#L",
  "0 0 * * 5#5",
  "0 0 * * 1-5/2",
  "0 0 * * */7",
  "0 0 * * */2",
  "0 0 * * 1/2",
  "0 0 * * L",
  // Names, ranges of names and case folding.
  "0 0 * * SUN",
  "0 0 * * SUN-SAT",
  "0 0 * * MON-FRI",
  "0 0 * * FRI-SUN",
  "0 0 * * mon-fri/2",
  "0 0 * * Tue,Thu",
  "0 0 1 JAN *",
  "0 0 1 JAN-MAR *",
  "0 0 1 jan,dec *",
  "0 0 1 January *",
  "0 0 1 mar 1",
  // "?" and the "+" day-of-month/day-of-week modifiers.
  "0 0 ? * 1",
  "0 0 1 * ?",
  "0 0 ? * ?",
  "0 0 * * ?",
  "0 0 1-5 * +1-5",
  "0 0 13 * +5",
  "0 0 ? * +1",
  // Day-of-month combined with day-of-week.
  "0 0 13 * 5",
  "0 0 1 * 1",
  "0 0 15 * 0",
  "0 0 2-30/2 * 1",
  // One-shot and malformed inputs: nextCronDateAcross skips them.
  "@once",
  "@daily",
  "@hourly",
  "@weekly",
  "@monthly",
  "@yearly",
  "@reboot",
  "",
  "   ",
  "not a cron",
  "0 0 * *",
  "0 0 * * * *",
  "0 0 * * * * *",
  "60 * * * *",
  "0 24 * * *",
  "0 0 0 * *",
  "0 0 32 * *",
  "0 0 * 0 *",
  "0 0 * 13 *",
  "0 0 * * 8",
  "*/0 * * * *",
  "*/61 * * * *",
  "1-0 * * * *",
  "0 0 1/2 * *",
  "0 0 1-5/0 * *",
  "0 0 1-5/61 * *",
  "0 0 1-5/6 * *",
  "0 0 0 * * L",
  "0 0 1 # 2",
  "0 0 * * 5#6",
  "0 0 * * 5#0",
  "0 0 * * 5#63",
  "0 0 * * 5,",
  "0 0 * * ,5",
  "0 0 1,,2 * *",
  "0 0 w * *",
  "0 0 1w * *",
  "0 0 1W/2 * *",
  "0 0 * * 5W",
  "0 0 * * W",
  "0 0 * * +",
  "0 0 * * +*",
  "0 0 l * *",
  "0 0 lw * *",
  " 0 0 * * * ",
  "0\t0 * * *",
  "0 0 * * *\n",
];

const anchors: Array<{ from: string; timezone: string }> = [
  { from: "2026-01-05T00:00:00.000Z", timezone: "UTC" },
  { from: "2026-01-05T00:00:00.000Z", timezone: "America/New_York" },
  { from: "2026-03-01T08:00:00.000Z", timezone: "Europe/London" },
  { from: "2026-07-15T23:59:30.000Z", timezone: "Asia/Kathmandu" },
];
for (const expr of SYNTAX) {
  for (const anchor of anchors) add(`syntax:${expr}`, [expr], anchor.from, anchor.timezone);
}

// Daylight-saving gaps and overlaps: a schedule inside the skipped hour runs
// once when the clocks have moved; one inside the repeated hour runs only the
// first time.
const transitionAnchors: Array<{ from: string; timezone: string }> = [];
const push = (zone: string, froms: string[]) => {
  for (const from of froms) transitionAnchors.push({ from, timezone: zone });
};
push("America/New_York", [
  "2026-03-07T12:00:00.000Z",
  "2026-03-08T05:00:00.000Z",
  "2026-03-08T06:30:00.000Z",
  "2026-03-08T07:00:00.000Z",
  "2026-03-08T07:30:00.000Z",
  "2026-03-08T09:00:00.000Z",
]);
push("America/New_York", [
  "2026-10-31T12:00:00.000Z",
  "2026-11-01T04:30:00.000Z",
  "2026-11-01T05:30:00.000Z",
  "2026-11-01T06:00:00.000Z",
  "2026-11-01T06:30:00.000Z",
  "2026-11-01T07:30:00.000Z",
]);
push("Europe/London", [
  "2026-03-28T12:00:00.000Z",
  "2026-03-29T00:30:00.000Z",
  "2026-03-29T01:00:00.000Z",
  "2026-03-29T01:30:00.000Z",
  "2026-03-29T02:30:00.000Z",
  "2026-03-29T05:00:00.000Z",
]);
push("Europe/London", [
  "2026-10-24T12:00:00.000Z",
  "2026-10-25T00:30:00.000Z",
  "2026-10-25T01:30:00.000Z",
  "2026-10-25T02:00:00.000Z",
  "2026-10-25T02:30:00.000Z",
  "2026-10-25T05:00:00.000Z",
]);
// Lord Howe moves its clocks by 30 minutes.
push("Australia/Lord_Howe", [
  "2026-04-04T13:00:00.000Z",
  "2026-04-04T14:30:00.000Z",
  "2026-04-04T15:00:00.000Z",
  "2026-04-04T15:30:00.000Z",
  "2026-04-04T16:00:00.000Z",
  "2026-04-05T02:00:00.000Z",
]);
push("Australia/Lord_Howe", [
  "2026-10-03T12:00:00.000Z",
  "2026-10-03T14:30:00.000Z",
  "2026-10-03T15:30:00.000Z",
  "2026-10-03T16:00:00.000Z",
  "2026-10-03T16:30:00.000Z",
  "2026-10-04T02:00:00.000Z",
]);
push("Asia/Kathmandu", [
  "2026-01-05T00:00:00.000Z",
  "2026-01-05T18:14:00.000Z",
  "2026-01-05T18:15:00.000Z",
  "2026-01-05T18:16:00.000Z",
  "2026-06-15T12:34:00.000Z",
  "2026-06-15T18:15:00.000Z",
]);
const transitionCrons = [
  "*/15 * * * *",
  "0 * * * *",
  "30 1 * * *",
  "0 2 * * *",
  "30 2 * * *",
  "0 3 * * *",
  "0 0 * * *",
];
for (const anchor of transitionAnchors) {
  for (const expr of transitionCrons)
    add(`transition:${expr}`, [expr], anchor.from, anchor.timezone);
}

// Leap days, month ends and the year-2999 limit of croner's matcher.
const calendarAnchors = [
  "2024-02-28T12:00:00.000Z",
  "2024-02-29T12:00:00.000Z",
  "2024-03-01T00:00:00.000Z",
  "2025-02-28T23:00:00.000Z",
  "2026-01-31T12:00:00.000Z",
  "2026-04-30T12:00:00.000Z",
  "2026-12-31T23:00:00.000Z",
  "2028-02-29T00:00:00.000Z",
  "2999-06-01T00:00:00.000Z",
  "2999-12-31T23:59:00.000Z",
  "3000-01-01T00:00:00.000Z",
];
const calendarCrons = ["0 0 29 2 *", "0 0 L 2 *", "0 0 31 * *", "0 0 1 * *", "0 0 1 1 *"];
for (const from of calendarAnchors) {
  for (const expr of calendarCrons) add(`calendar:${expr}`, [expr], from, "UTC");
}

// Timezone parsing: case-insensitive names, fixed offsets, unknown names.
const zones = [
  "UTC",
  "utc",
  "America/New_York",
  "america/new_york",
  "America/New_york",
  "US/Eastern",
  "Asia/Calcutta",
  "Etc/GMT+5",
  "+05:30",
  "+0530",
  "-14:00",
  "+05",
  "No/Such_Zone",
  "",
  "Factory",
  "+24:00",
  "+23:59",
  "+05:60",
  "-24:00",
  "+0000",
  "+00:0",
];
for (const zone of zones) {
  add(`zone:${zone}`, ["0 9 * * *"], "2026-03-07T20:00:00.000Z", zone);
  add(`zone:${zone}:dow`, ["*/20 3 * * 1"], "2026-10-24T12:00:00.000Z", zone);
}

// Multi-cron earliest selection, including one-shot and malformed members.
const multi: Array<[string, string[]]> = [
  ["recurring-two", ["0 0 * * *", "0 12 * * *"]],
  ["two-months", ["0 0 1 * *", "0 0 15 * *"]],
  ["two-weekdays", ["0 0 * * 1", "0 0 * * 5"]],
  ["same-instant", ["0 0 * * *", "0 0 * * *"]],
  ["skip-once", ["0 0 * * *", "@once"]],
  ["once-first", ["@once", "30 6 * * 2"]],
  ["skip-malformed", ["bad cron", "0 6 * * *"]],
  ["malformed-first", ["60 0 * * *", "0 6 * * *"]],
  ["only-invalid", ["bad cron", "@daily"]],
  ["only-once", ["@once"]],
  ["empty", []],
  ["impossible-then-day", ["0 0 30 2 *", "0 0 1 1 *"]],
  ["three-cron", ["0 0 1 * *", "0 0 10 * *", "0 0 20 * *"]],
  ["dst-hour-tie", ["30 1 * * *", "0 2 * * *"]],
];
for (const [name, crons] of multi) {
  add(`multi:${name}`, crons, "2026-01-05T00:00:00.000Z", "UTC");
  add(`multi:${name}:ny`, crons, "2026-11-01T05:00:00.000Z", "America/New_York");
}

// Sub-second starts and starts exactly on a match.
for (const from of [
  "2026-01-05T00:00:00.000Z",
  "2026-01-05T00:00:00.001Z",
  "2026-01-05T00:00:00.700Z",
  "2026-01-05T00:00:59.999Z",
  "2026-01-05T00:01:00.000Z",
  "2026-01-05T23:59:59.999Z",
]) {
  for (const expr of ["* * * * *", "0 * * * *", "0 0 * * *"]) {
    add(`instant:${expr}`, [expr], from, "UTC");
  }
}

// Seeded random schedules: fields drawn from every accepted form, crossed with
// random instants and zones, so the parser and matcher are compared broadly.
let seed = 20261120;
const random = () => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
};
const pick = <T,>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
const minuteFields = ["*", "*/5", "*/15", "0", "30", "0,30", "5-25/10", "15,45"];
const hourFields = ["*", "0", "6", "12", "18", "*/3", "1-5", "2", "3", "9-17/4"];
const domFields = ["*", "?", "1", "15", "L", "LW", "31", "1,15", "15W", "1W", "29", "10-20"];
const monthFields = ["*", "1", "2", "JAN", "jan-mar", "3,9", "*/2", "12", "FEB"];
const dowFields = ["*", "?", "1", "0", "1-5", "MON", "FRI-SUN", "5#2", "5L", "*/2", "6", "0,6"];
const randomZones = [
  "UTC",
  "America/New_York",
  "Europe/London",
  "Australia/Lord_Howe",
  "Asia/Kathmandu",
  "America/Santiago",
  "Pacific/Auckland",
  "Europe/Berlin",
  "america/new_york",
  "+05:45",
];
const windowStart = Date.UTC(2024, 0, 1);
const windowEnd = Date.UTC(2028, 0, 1);
for (let index = 0; index < 300; index += 1) {
  const expr = `${pick(minuteFields)} ${pick(hourFields)} ${pick(domFields)} ${pick(monthFields)} ${pick(dowFields)}`;
  const from = new Date(
    Math.floor(windowStart + random() * (windowEnd - windowStart)) * 1,
  ).toISOString();
  add(`random:${index}:${expr}`, [expr], from, pick(randomZones));
}

// Adjacent grammar corners and repeated-hour instants.
const corners = [
  "0 0 * * 1-5#2",
  "0 0 * * 1L,5#3",
  "0 0 1W,15 * *",
  "0 0 L * 1",
  "0 0 1-5/2 * 5#L",
  "0 0 -5 * *",
  "0 0 5- * *",
  "0 0 1 JAN-DEC/3 *",
  "0 0 * * sun",
  "0 0 * * Sun-Sat/2",
  "0 0 * * mo",
  "0 0 * MARCH *",
  "0 0 1 1-12/5 *",
  "0 0 1 1-12/13 *",
  "0 0 * * 1-5/8",
  "0 0 * * 0-7/2",
  "0 0 1-31/31 * *",
  "0 0 */31 * *",
  "0 0 */32 * *",
  "0 0 29 2 0-6",
  "0 0 29 2 +0-6",
  "0 0 1-7 * +0",
  "0 0 * * 0#5,6#1",
  "0 0 * * 3#1-2",
  "0 0 3L * *",
  "0 0 * * 3ll",
  "0 0 1W * MON",
  "0 0 LW * 1",
];
for (const expr of corners) {
  add(`corner:${expr}`, [expr], "2026-01-05T00:00:00.000Z", "UTC");
  add(`corner:ny:${expr}`, [expr], "2026-11-01T06:29:59.999Z", "America/New_York");
}
for (const from of [
  "2026-11-01T05:30:00.000Z",
  "2026-11-01T05:30:00.001Z",
  "2026-11-01T06:29:59.999Z",
  "2026-11-01T06:30:00.000Z",
  "2026-03-08T06:59:59.999Z",
  "2026-03-08T07:00:00.000Z",
]) {
  for (const expr of ["30 1 * * *", "30 2 * * *", "0 3 * * *", "*/20 1 * * *"]) {
    add(`repeat:${expr}`, [expr], from, "America/New_York");
  }
}

// Historic zone changes: Samoa skipped a day, Sao Paulo ended DST, Beirut and
// Santiago moved at midnight.
const historic: Array<[string, string[]]> = [
  [
    "Pacific/Apia",
    [
      "2011-12-29T00:00:00.000Z",
      "2011-12-30T00:00:00.000Z",
      "2011-12-30T09:59:00.000Z",
      "2011-12-30T10:00:00.000Z",
    ],
  ],
  [
    "America/Sao_Paulo",
    [
      "2018-11-03T02:00:00.000Z",
      "2018-11-04T02:30:00.000Z",
      "2018-02-17T01:30:00.000Z",
      "2018-02-18T02:30:00.000Z",
    ],
  ],
  [
    "Asia/Beirut",
    [
      "2023-03-25T21:30:00.000Z",
      "2023-03-25T22:30:00.000Z",
      "2023-10-28T21:30:00.000Z",
      "2023-10-28T22:30:00.000Z",
    ],
  ],
  [
    "America/Santiago",
    [
      "2024-09-07T23:30:00.000Z",
      "2024-09-08T00:30:00.000Z",
      "2024-04-06T02:30:00.000Z",
      "2024-04-06T03:30:00.000Z",
    ],
  ],
];
for (const [zone, froms] of historic) {
  for (const from of froms) {
    for (const expr of ["0 0 * * *", "30 0 * * *", "0 1 * * *", "*/30 * * * *"]) {
      add(`historic:${zone}:${expr}`, [expr], from, zone);
    }
  }
}

process.stdout.write(`${JSON.stringify(cases, null, 2)}\n`);
