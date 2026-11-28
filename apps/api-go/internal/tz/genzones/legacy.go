package main

// The set of zone names where V8's *default* zone (what new Date("…") without
// an offset uses) reads UTC although Intl resolves the name to a real zone:
// the System V short ids and six backward links (Cuba, Iran, PRC, ROC, ROK,
// W-SU). The list is measured over every name in the zip, never hand-picked:
// with TZ=<name>, resolvedOptions().timeZone reports the canonical zone while
// the Date offsets are 0 at every probe, whereas Intl's own offsets for that
// zone are not. tz.Local must read UTC for those names, as V8 does.

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"time"
)

const legacyScript = `
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
const payload = JSON.parse(readFileSync(process.argv[2], "utf8"));
const childSource = ` + "`" + `
const instants = INSTANTS;
const build = (options) => new Intl.DateTimeFormat("en-US", {
  hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", ...options,
});
const offsetAt = (format, at) => {
  const parts = {};
  for (const { type, value } of format.formatToParts(at)) parts[type] = value;
  const local = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(parts.hour) % 24, Number(parts.minute), Number(parts.second));
  return (local - at) / 1000;
};
const defaultFormat = build({});
const zone = defaultFormat.resolvedOptions().timeZone ?? null;
const offsets = instants.map((at) => offsetAt(defaultFormat, at));
// Formatting with timeZone=<id> reads the same broken data as the default
// lookup for these ids, so the comparison uses the canonical zone instead.
let canonical = null, intl = null;
try {
  canonical = build({ timeZone: process.env.TZ }).resolvedOptions().timeZone;
  const named = build({ timeZone: canonical });
  intl = instants.map((at) => offsetAt(named, at));
} catch {}
process.stdout.write(JSON.stringify({ zone, offsets, canonical, intl }));
` + "`" + `;
const source = childSource.replace("INSTANTS", JSON.stringify(payload.instants));
const runOne = (name) => new Promise((resolve) => {
  const child = spawn(process.execPath, ["-e", source], {
    env: { ...process.env, TZ: name }, stdio: ["ignore", "pipe", "ignore"],
  });
  let out = "";
  child.stdout.on("data", (chunk) => { out += chunk; });
  child.on("close", () => {
    try { resolve([name, JSON.parse(out)]); } catch { resolve([name, null]); }
  });
});
const results = [];
let next = 0;
await Promise.all(Array.from({ length: 12 }, async () => {
  while (next < payload.names.length) {
    const name = payload.names[next++];
    results.push(await runOne(name));
  }
}));
const legacy = [], failed = [];
for (const [name, data] of results) {
  if (!data) { failed.push([name, "no output"]); continue; }
  if (!data.canonical || !data.intl) continue;
  if (data.zone !== data.canonical) continue;
  if (!data.offsets.every((offset) => offset === 0)) continue;
  if (!data.intl.some((offset) => offset !== 0)) continue;
  legacy.push(name);
}
legacy.sort();
process.stdout.write(JSON.stringify({ legacy, measured: results.length, failed }));
`

// measureLegacy returns the names over which V8's default zone reads UTC while
// Intl's zone data does not, measured one node process per name.
func measureLegacy(temp, node string, names []string) []string {
	instants := []int64{
		time.Date(2026, 1, 15, 12, 0, 0, 0, time.UTC).UnixMilli(),
		time.Date(2026, 7, 15, 12, 0, 0, 0, time.UTC).UnixMilli(),
		time.Date(2026, 11, 5, 12, 0, 0, 0, time.UTC).UnixMilli(),
		time.Date(1970, 7, 15, 12, 0, 0, 0, time.UTC).UnixMilli(),
	}
	payload, err := json.Marshal(struct {
		Names    []string `json:"names"`
		Instants []int64  `json:"instants"`
	}{Names: names, Instants: instants})
	if err != nil {
		fatal(err)
	}
	scriptPath := filepath.Join(temp, "legacy.mjs")
	payloadPath := filepath.Join(temp, "legacy.json")
	if err := os.WriteFile(scriptPath, []byte(legacyScript), 0o644); err != nil {
		fatal(err)
	}
	if err := os.WriteFile(payloadPath, payload, 0o644); err != nil {
		fatal(err)
	}
	out := run(node, scriptPath, payloadPath)
	var result struct {
		Legacy   []string `json:"legacy"`
		Measured int      `json:"measured"`
		Failed   [][2]any `json:"failed"`
	}
	if err := json.Unmarshal(out, &result); err != nil {
		fatalf("parse the legacy default-zone measurement from %s: %v", node, err)
	}
	if len(result.Failed) > 0 {
		fatalf("%s produced no default-zone measurement for %d name(s): %v", node, len(result.Failed), result.Failed)
	}
	if result.Measured != len(names) {
		fatalf("%s measured %d names, the zip carries %d", node, result.Measured, len(names))
	}
	sort.Strings(result.Legacy)
	fmt.Printf("legacy default zone: %d of %d names read UTC in V8: %v\n", len(result.Legacy), len(names), result.Legacy)
	return result.Legacy
}
