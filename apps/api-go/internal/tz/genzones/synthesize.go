package main

// Zones production Node's ICU accepts as ids of their own that IANA tzdata
// does not ship (SystemV/AST4 and friends). The release's own zic cannot
// produce them, and the historical tzdata systemv file disagrees with ICU's
// rules before 1970, so genzones samples ICU's offsets, finds every transition
// to the second, and writes a fat TZif whose future is described by a POSIX
// footer. The bytes are then verified by asking ICU again, independently of
// the sampled transition list: at t-1 s, t and t+1 s of every encoded
// transition, and at every transition and monthly probe after the last one.
// Any disagreement aborts before the zip is written.

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"time"
)

// synthScript samples every requested id daily from 1900 to 2103, refines each
// offset change to the second, derives the POSIX footer from the last two
// years' transitions, and re-queries ICU at t-1 s, t and t+1 s of every
// transition (transitionProbes) and at every later transition and monthly probe
// (probes) through 2200. The Go side encodes the zone and compares those
// independent ICU answers with the bytes it produced.
const synthScript = `
import { readFileSync } from "node:fs";
const payload = JSON.parse(readFileSync(process.argv[2], "utf8"));
const DAY = 86400000;
const build = (zone) => new Intl.DateTimeFormat("en-US", {
  timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit",
  day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
});
const offsetAt = (format, at) => {
  const parts = {};
  for (const { type, value } of format.formatToParts(at)) parts[type] = value;
  const local = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(parts.hour) % 24, Number(parts.minute), Number(parts.second));
  return (local - at) / 1000;
};
const transitionsBetween = (format, from, to, previous) => {
  const found = [];
  for (let at = from + DAY; at <= to; at += DAY) {
    const current = offsetAt(format, at);
    if (current === previous) continue;
    let low = at - DAY, high = at;
    while (high - low > 1000) {
      const mid = low + Math.ceil((high - low) / 2000) * 1000;
      if (offsetAt(format, mid) === previous) low = mid; else high = mid;
    }
    if (offsetAt(format, high - 1000) !== previous || offsetAt(format, high) !== current) {
      throw new Error("transition around " + new Date(high).toISOString() + " is not at a whole second");
    }
    found.push([high, current]);
    previous = current;
  }
  return { found, previous };
};
const posixOffset = (seconds) => {
  const sign = seconds > 0 ? "-" : "";
  const total = Math.abs(seconds);
  const hours = Math.floor(total / 3600), minutes = Math.floor((total % 3600) / 60), rest = total % 60;
  // POSIX/RFC 8536 limit the hours field to 24.
  if (hours > 24) throw new Error("POSIX offset " + seconds + " seconds exceeds 24 hours");
  return sign + hours + (minutes || rest ? ":" + String(minutes).padStart(2, "0") : "") +
    (rest ? ":" + String(rest).padStart(2, "0") : "");
};
const ruleFor = (at, previousOffset) => {
  const wall = new Date(at + previousOffset * 1000);
  const month = wall.getUTCMonth() + 1, day = wall.getUTCDate(), weekday = wall.getUTCDay();
  const hour = wall.getUTCHours(), minute = wall.getUTCMinutes(), second = wall.getUTCSeconds();
  const time = hour + (minute || second ? ":" + String(minute).padStart(2, "0") : "") +
    (second ? ":" + String(second).padStart(2, "0") : "");
  // POSIX week 5 means the last such weekday, so a wall date whose next
  // occurrence would fall in the next month is week 5 even when it sits in
  // days 22-28 (e.g. the last Sunday of April 2101 is the 24th).
  const daysInMonth = new Date(Date.UTC(wall.getUTCFullYear(), month, 0)).getUTCDate();
  const week = day + 7 > daysInMonth ? 5 : Math.ceil(day / 7);
  return "M" + month + "." + week + "." + weekday + "/" + time;
};
const zones = [];
for (const id of payload.ids) {
  const format = build(id);
  const start = payload.start;
  const initial = offsetAt(format, start);
  const early = transitionsBetween(format, start, payload.forwardEnd, initial);
  const late = transitionsBetween(format, payload.forwardEnd, payload.probeEnd, early.previous);
  const transitions = early.found.concat(late.found);
  const offsets = [...new Set(transitions.map(([, offset]) => offset))].sort((a, b) => a - b);
  let footer = "STD" + posixOffset(initial);
  if (offsets.length === 2) {
    const standard = offsets[0], daylight = offsets[1];
    // The footer is derived from the last two years before the explicit
    // horizon; the transitions after it exist only to verify the footer.
    const tail = early.found.slice(-4);
    if (tail.length !== 4) throw new Error(id + ": expected four transitions before the footer horizon");
    const starts = [tail[0], tail[2]].map(([at, offset]) => [at, ruleFor(at, offset === daylight ? standard : daylight)]);
    const ends = [tail[1], tail[3]].map(([at, offset]) => [at, ruleFor(at, offset === daylight ? standard : daylight)]);
    if (starts[0][1] !== starts[1][1] || ends[0][1] !== ends[1][1]) {
      throw new Error(id + ": the last two years do not share one POSIX rule");
    }
    const delta = daylight - standard;
    footer = "STD" + posixOffset(standard) + "DST" + (delta === 3600 ? "" : posixOffset(daylight)) +
      "," + starts[0][1] + "," + ends[0][1];
  }
  const transitionProbes = [];
  for (const [at] of early.found) {
    for (const probe of [at - 1000, at, at + 1000]) transitionProbes.push([probe, offsetAt(format, probe)]);
  }
  const probes = [];
  for (let at = payload.forwardEnd + 15 * DAY; at <= payload.probeEnd; at += 30 * DAY) probes.push(at);
  for (const [at] of late.found) probes.push(at - 1000, at, at + 1000);
  zones.push({
    name: id, initial, dst: offsets.length === 2, footer,
    transitions: early.found.map(([at, offset]) => [at, offset]),
    transitionProbes,
    probes: probes.map((at) => [at, offsetAt(format, at)]),
  });
}
process.stdout.write(JSON.stringify({ zones }));
`

// synthesizedZone is one ICU-only zone measured by synthScript.
type synthesizedZone struct {
	Name             string     `json:"name"`
	Initial          int32      `json:"initial"`
	DST              bool       `json:"dst"`
	Footer           string     `json:"footer"`
	Transitions      [][2]int64 `json:"transitions"`      // ms, offset seconds
	TransitionProbes [][2]int64 `json:"transitionProbes"` // ms, offset seconds, re-queried from ICU
	Probes           [][2]int64 `json:"probes"`           // ms, offset seconds, after the last transition
}

// synthesizeZones writes a TZif for every id ICU implements itself, then
// verifies the bytes against the offsets ICU reported.
func synthesizeZones(temp, zones, node string, ids []string) []synthesizedZone {
	sort.Strings(ids)
	payload := struct {
		IDs        []string `json:"ids"`
		Start      int64    `json:"start"`
		ForwardEnd int64    `json:"forwardEnd"`
		ProbeEnd   int64    `json:"probeEnd"`
	}{
		IDs: ids,
		// 1900 through 2102 explicitly; the footer covers 2103 onward and is
		// checked against ICU through 2200.
		Start:      time.Date(1900, 1, 1, 0, 0, 0, 0, time.UTC).UnixMilli(),
		ForwardEnd: time.Date(2103, 1, 1, 0, 0, 0, 0, time.UTC).UnixMilli(),
		ProbeEnd:   time.Date(2201, 1, 1, 0, 0, 0, 0, time.UTC).UnixMilli(),
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		fatal(err)
	}
	scriptPath := filepath.Join(temp, "synthesize.mjs")
	payloadPath := filepath.Join(temp, "synthesize.json")
	if err := os.WriteFile(scriptPath, []byte(synthScript), 0o644); err != nil {
		fatal(err)
	}
	if err := os.WriteFile(payloadPath, encoded, 0o644); err != nil {
		fatal(err)
	}
	out := run(node, scriptPath, payloadPath)
	var result struct {
		Zones []synthesizedZone `json:"zones"`
	}
	if err := json.Unmarshal(out, &result); err != nil {
		fatalf("parse synthesized zones from %s: %v", node, err)
	}
	if len(result.Zones) != len(ids) {
		fatalf("%s reported %d synthesized zones for %d ids", node, len(result.Zones), len(ids))
	}
	for index := range result.Zones {
		zone := &result.Zones[index]
		body := encodeTZif(*zone)
		location, err := time.LoadLocationFromTZData(zone.Name, body)
		if err != nil {
			fatalf("parse the synthesized zone for %s: %v", zone.Name, err)
		}
		for _, transition := range zone.Transitions {
			if transition[0]%1000 != 0 {
				fatalf("%s transition %d is not at a whole second", zone.Name, transition[0])
			}
		}
		// The growers' answers, not the encoded values: every encoded transition
		// is probed again through ICU at t-1 s, t and t+1 s, so a corrupted
		// sampled offset cannot survive the check.
		if len(zone.TransitionProbes) != 3*len(zone.Transitions) {
			fatalf("%s: %d transition probes for %d transitions", zone.Name, len(zone.TransitionProbes), len(zone.Transitions))
		}
		for _, probe := range zone.TransitionProbes {
			if got := offsetOf(location, probe[0]); got != probe[1] {
				fatalf("%s: at %s the grown zone reports %d, ICU %d (transition probe)",
					zone.Name, time.UnixMilli(probe[0]).UTC().Format(time.RFC3339), got, probe[1])
			}
		}
		for _, probe := range zone.Probes {
			if got := offsetOf(location, probe[0]); got != probe[1] {
				fatalf("%s: at %s the grown zone reports %d, ICU %d (footer %q)",
					zone.Name, time.UnixMilli(probe[0]).UTC().Format(time.RFC3339), got, probe[1], zone.Footer)
			}
		}
		target := filepath.Join(zones, filepath.FromSlash(zone.Name))
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			fatal(err)
		}
		if err := os.WriteFile(target, body, 0o644); err != nil {
			fatal(err)
		}
	}
	fmt.Printf("synthesized %d ICU zones from sampled offsets: %s\n", len(result.Zones), zoneNames(result.Zones))
	return result.Zones
}

func zoneNames(zones []synthesizedZone) string {
	names := make([]string, 0, len(zones))
	for _, zone := range zones {
		names = append(names, zone.Name)
	}
	return fmt.Sprint(names)
}

func offsetOf(location *time.Location, at int64) int64 {
	_, seconds := time.UnixMilli(at).In(location).Zone()
	return int64(seconds)
}

// encodeTZif writes a version-2 TZif whose 64-bit block carries every
// transition and whose footer describes the rule after the last one. The
// 32-bit block is deliberately empty: only time.LoadLocationFromTZData reads
// these bytes.
func encodeTZif(zone synthesizedZone) []byte {
	type zoneType struct {
		offset int32
		dst    bool
	}
	types := []zoneType{{zone.Initial, false}}
	indices := make(map[zoneType]byte, 2)
	indices[types[0]] = 0
	transitionTypes := make([]byte, 0, len(zone.Transitions))
	for _, transition := range zone.Transitions {
		entry := zoneType{int32(transition[1]), zone.DST && transition[1] > int64(zone.Initial)}
		index, ok := indices[entry]
		if !ok {
			index = byte(len(types))
			indices[entry] = index
			types = append(types, entry)
		}
		transitionTypes = append(transitionTypes, index)
	}
	abbreviations := []byte("STD\x00DST\x00")

	var buffer bytes.Buffer
	writeHeader := func(timeCount, typeCount, charCount uint32) {
		buffer.WriteString("TZif")
		buffer.WriteByte('2')
		buffer.Write(make([]byte, 15))
		for _, count := range []uint32{0, 0, 0, timeCount, typeCount, charCount} {
			_ = binary.Write(&buffer, binary.BigEndian, count)
		}
	}
	// The 32-bit block is empty and carries one unnamed type, so even a reader
	// that stops after it sees a valid (if offset-less) zone.
	writeHeader(0, 1, 1)
	binary.Write(&buffer, binary.BigEndian, int32(0))
	buffer.WriteByte(0)
	buffer.WriteByte(0)
	buffer.WriteByte(0)
	writeHeader(uint32(len(zone.Transitions)), uint32(len(types)), uint32(len(abbreviations)))
	for _, transition := range zone.Transitions {
		binary.Write(&buffer, binary.BigEndian, transition[0]/1000)
	}
	buffer.Write(transitionTypes)
	for _, entry := range types {
		binary.Write(&buffer, binary.BigEndian, entry.offset)
		if entry.dst {
			buffer.WriteByte(1)
			buffer.WriteByte(4)
			continue
		}
		buffer.WriteByte(0)
		buffer.WriteByte(0)
	}
	buffer.Write(abbreviations)
	buffer.WriteString("\n")
	buffer.WriteString(zone.Footer)
	buffer.WriteString("\n")
	return buffer.Bytes()
}
