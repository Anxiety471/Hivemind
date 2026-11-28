// Records V8's Date.parse reading of offset-less wall times for the Go port's
// ParseDate differential (internal/procedures/shared/testdata/local-wall-corpus.json.gz).
//
// V8 reads a wall time without an offset with Temporal's "compatible"
// disambiguation: a wall time that occurs once has its single instant, one the
// clocks skip moves forward by the gap, and one they repeat takes the earlier
// instant. The corpus covers the zones with the densest and most unusual
// transitions — Manila (a skipped 1844 day and wartime DST), Havana (Cuba's
// rule changes), Dublin (negative DST), Lord Howe (half-hour shifts), Chatham
// (+12:45) and Apia (the 2011 date-line skip) — and records, for each zone:
//
//   - every wall time inside every gap and overlap from 1900 to 2100, minute by
//     minute (a whole skipped day for Apia);
//   - wall times at five-minute steps in the hour either side of every
//     transition, read with the offset in effect on each side;
//   - 5,000 random wall times across 1900-2100.
//
// A single node process per zone parses that zone's wall strings, with TZ set
// to the zone, exactly as a client's Date.parse would. Run from apps/api-go
// with the production node:
//
//	/home/hitori/.local/opt/node24/bin/node tools/tz-local-corpus.mjs
import { spawnSync } from "node:child_process";
import { gzipSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { offsetAt, transitionsBetween } from "./tz-node-offsets.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const apiGo = join(here, "..");
const zones = [
  "Asia/Manila",
  "America/Havana",
  "Europe/Dublin",
  "Australia/Lord_Howe",
  "Pacific/Chatham",
  "Pacific/Apia",
];
const FROM = Date.UTC(1900, 0, 1);
const TO = Date.UTC(2101, 0, 1);
const MINUTE = 60 * 1000;
const STEP = 5 * MINUTE;

const pad = (value, width) => String(value).padStart(width, "0");

/** The wall clock fields of an instant plus a zone offset, as a wall time string. */
function wallOf(milliseconds) {
  const at = new Date(milliseconds);
  return `${pad(at.getUTCFullYear(), 4)}-${pad(at.getUTCMonth() + 1, 2)}-${pad(at.getUTCDate(), 2)}` +
    `T${pad(at.getUTCHours(), 2)}:${pad(at.getUTCMinutes(), 2)}:${pad(at.getUTCSeconds(), 2)}`;
}

/** Every wall time the corpus probes for one zone. */
function wallsFor(zone) {
  const walls = new Set();
  for (const transition of transitionsBetween(zone, FROM, TO)) {
    const before = offsetAt(zone, transition - 1000);
    const after = offsetAt(zone, transition);
    // Every wall time in the gap (clocks forward) or overlap (clocks back).
    const low = Math.min(before, after) * 1000;
    const high = Math.max(before, after) * 1000;
    if (low !== high) {
      for (let wall = transition + low; wall < transition + high; wall += MINUTE) walls.add(wallOf(wall));
    }
    // The hour either side, read with each side's offset, so an off-by-one-hour
    // rule cannot hide at the edges.
    for (let delta = -60 * MINUTE; delta <= 60 * MINUTE; delta += STEP) {
      const instant = transition + delta;
      walls.add(wallOf(instant + before * 1000));
      walls.add(wallOf(instant + after * 1000));
    }
  }
  // Random wall times, not instants: they land in gaps and overlaps at random.
  let state = 0x9e3779b9;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
  for (let index = 0; index < 5000; index += 1) {
    walls.add(wallOf(FROM + Math.floor(random() * (TO - FROM - 1))));
  }
  return [...walls].sort();
}

const parseScript = `import { readFileSync } from "node:fs";
const walls = JSON.parse(readFileSync(0, "utf8"));
process.stdout.write(JSON.stringify(walls.map((wall) => {
  const milliseconds = Date.parse(wall);
  return Number.isNaN(milliseconds) ? null : milliseconds;
})));`;

const recorded = {};
for (const zone of zones) {
  const walls = wallsFor(zone);
  const run = spawnSync(process.execPath, ["--input-type=module", "-e", parseScript], {
    env: { ...process.env, TZ: zone },
    input: JSON.stringify(walls),
    encoding: "utf8",
    maxBuffer: 1 << 28,
  });
  if (run.status !== 0) throw new Error(`node with TZ=${zone} failed: ${run.stderr}`);
  const instants = JSON.parse(run.stdout);
  recorded[zone] = walls.map((wall, index) => ({ wall, ms: instants[index] }));
  const invalid = instants.filter((value) => value === null).length;
  if (invalid > 0) throw new Error(`${invalid} wall times under TZ=${zone} are Invalid Date`);
  console.log(`${zone}: ${walls.length} wall times`);
}

const payload = {
  tz: process.versions.tz,
  node: process.versions.node,
  icu: process.versions.icu,
  zones: recorded,
};
const target = join(apiGo, "internal/procedures/shared/testdata/local-wall-corpus.json.gz");
writeFileSync(target, gzipSync(Buffer.from(JSON.stringify(payload)), { level: 9 }));
const total = Object.values(recorded).reduce((sum, cases) => sum + cases.length, 0);
console.log(`tz ${payload.tz} node ${payload.node} icu ${payload.icu}: ${total} wall times across ${zones.length} zones`);
