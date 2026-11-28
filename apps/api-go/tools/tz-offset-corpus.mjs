// Records Intl's offsets for the Go port's tz differential test
// (internal/tz/testdata/offset-corpus.json.gz).
//
// Every zone the embedded tzdata release carries is probed at the instants
// around its transitions from 2020 to 2030, at yearly samples back to 1970 and
// forward to 2070, and at the decade boundaries. Go must return the same offset
// at every one of them; the release pinned in internal/tz is the one this
// script's node carries, so regenerate after upgrading node.
//
// Run from apps/api-go with the production node:
//
//	/home/hitori/.local/opt/node24/bin/node tools/tz-offset-corpus.mjs
import { gzipSync } from "node:zlib";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { offsetAt, supports, transitionsBetween } from "./tz-node-offsets.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const apiGo = join(here, "..");
const list = JSON.parse(readFileSync(join(apiGo, "internal/tz/testdata/zone-names.json"), "utf8"));

const FROM = Date.UTC(2020, 0, 1);
const TO = Date.UTC(2030, 0, 1);
const DAY = 24 * 3600 * 1000;
const HOUR = 3600 * 1000;

const zones = [];
const unsupported = [];
/** @type {Array<[number, number, number]>} zone index, instant, offset seconds */
const queries = [];

for (const name of list.names) {
  if (!supports(name)) {
    unsupported.push(name);
    continue;
  }
  const index = zones.length;
  zones.push(name);
  const instants = new Set();
  for (const transition of transitionsBetween(name, FROM, TO)) {
    // Both sides of the change, and a day and an hour out, so a rule read a
    // day, an hour or a second off cannot hide between samples.
    for (const delta of [-DAY, -HOUR, -1000, 0, 1000, HOUR, DAY]) instants.add(transition + delta);
  }
  for (const start of [FROM, TO]) instants.add(start);
  for (let year = 1970; year <= 2038; year += 1) instants.add(Date.UTC(year, 0, 1));
  for (let year = 2020; year <= 2030; year += 1) instants.add(Date.UTC(year, 6, 1));
  for (let year = 2041; year <= 2070; year += 3) instants.add(Date.UTC(year, 0, 1));
  for (const instant of [...instants].sort((a, b) => a - b)) {
    queries.push([index, instant, offsetAt(name, instant)]);
  }
}

const payload = {
  tz: process.versions.tz,
  node: process.versions.node,
  icu: process.versions.icu,
  zones,
  unsupported,
  queries,
};
const target = join(apiGo, "internal/tz/testdata/offset-corpus.json.gz");
writeFileSync(target, gzipSync(Buffer.from(JSON.stringify(payload)), { level: 9 }));
console.log(
  `tz ${payload.tz} node ${payload.node} icu ${payload.icu}: ${zones.length} zones, ${queries.length} offsets, ${unsupported.length} unsupported`,
);
