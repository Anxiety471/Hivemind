// Answers the Go live parity test: offsetAt for every [zoneIndex, instant]
// query read as JSON from stdin (with the zone names it indexes), printed as a
// JSON array of offsets in seconds.
//
//	/home/hitori/.local/opt/node24/bin/node tools/tz-live-offsets.mjs <<< '{"zones":["America/Havana"],"queries":[[0,1793512800000]]}'
import { readFileSync } from "node:fs";
import { offsetAt } from "./tz-node-offsets.mjs";

const { zones, queries } = JSON.parse(readFileSync(0, "utf8"));
const offsets = new Array(queries.length);
for (let i = 0; i < queries.length; i += 1) offsets[i] = offsetAt(zones[queries[i][0]], queries[i][1]);
process.stdout.write(JSON.stringify(offsets));
