package tz_test

import (
	"bytes"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/tz"
)

// knownICUOnlyAliases are a few ids the reviews measured, kept as a regression
// guard: the full set is tz.ICUOnlyAliasZones, which genzones discovers by
// probing the release's names, tzdata 2018g's names, and every two- to
// four-letter id through production node.
var knownICUOnlyAliases = []string{
	"PST", "ACT", "US/Pacific-New", "Canada/East-Saskatchewan",
}

// TestICUOnlyAliasesMatchTheirCanonicalZone is the permanent form of P2-1: every
// id Intl accepts is in the zip and returns the offsets of the zone ICU maps it
// to. It fails if a regeneration drops an alias or its copy drifts.
func TestICUOnlyAliasesMatchTheirCanonicalZone(t *testing.T) {
	instants := []time.Time{
		time.Date(1990, 7, 15, 12, 0, 0, 0, time.UTC),
		time.Date(2000, 1, 15, 12, 0, 0, 0, time.UTC),
		time.Date(2026, 7, 15, 12, 0, 0, 0, time.UTC),
		time.Date(2026, 12, 6, 12, 0, 0, 0, time.UTC),
		time.Date(2030, 1, 15, 12, 0, 0, 0, time.UTC),
	}
	if len(tz.ICUOnlyAliasZones) == 0 {
		t.Fatal("ICUOnlyAliasZones is empty: regenerate the embedded release with go generate ./internal/tz")
	}
	for _, alias := range knownICUOnlyAliases {
		if _, ok := tz.ICUOnlyAliasZones[alias]; !ok {
			t.Errorf("the discovered ICU-only ids lack %q", alias)
		}
	}
	for alias, canonical := range tz.ICUOnlyAliasZones {
		if !tz.Has(alias) {
			t.Errorf("tzdata release lacks ICU alias %q", alias)
			continue
		}
		aliasZone, err := tz.Load(alias)
		if err != nil {
			t.Errorf("load %q: %v", alias, err)
			continue
		}
		canonicalZone, err := tz.Load(canonical)
		if err != nil {
			t.Errorf("load %q (canonical for %q): %v", canonical, alias, err)
			continue
		}
		for _, instant := range instants {
			_, want := instant.In(canonicalZone).Zone()
			_, got := instant.In(aliasZone).Zone()
			if got != want {
				t.Errorf("%s at %s: %+d, canonical %s %+d", alias, instant.Format(time.RFC3339), got, canonical, want)
			}
		}
	}
}

// TestZoneNameUniverseMatchesIntl is the completeness check P2-2 asked for, in
// the only direction a zip-derived corpus cannot see: every name Intl accepts
// must be in the zip. The universe is Intl.supportedValuesOf plus the pinned
// ICU-only ids; the reverse direction (a zip name Intl rejects) must be exactly
// Factory.
func TestZoneNameUniverseMatchesIntl(t *testing.T) {
	node := provenanceNode(t)
	names := tz.Names()
	encoded, err := json.Marshal(names)
	if err != nil {
		t.Fatal(err)
	}
	script := `import { readFileSync } from "node:fs";` +
		`const ours = JSON.parse(readFileSync(process.argv[1], "utf8"));` +
		`const supported = Intl.supportedValuesOf("timeZone");` +
		`const rejected = ours.filter((name) => { try { new Intl.DateTimeFormat("en-US", { timeZone: name }); return false; } catch { return true; } });` +
		`process.stdout.write(JSON.stringify({ supported, rejected }));`
	namesPath := filepath.Join(t.TempDir(), "names.json")
	if err := os.WriteFile(namesPath, encoded, 0o644); err != nil {
		t.Fatal(err)
	}
	out, err := output(exec.Command(node, "-e", script, namesPath), withoutTZ())
	if err != nil {
		t.Fatalf("run %s: %v: %s", node, err, out)
	}
	var result struct {
		Supported []string `json:"supported"`
		Rejected  []string `json:"rejected"`
	}
	if err := json.Unmarshal(out, &result); err != nil {
		t.Fatalf("parse %s output: %v", node, err)
	}
	have := make(map[string]bool, len(names))
	for _, name := range names {
		have[name] = true
	}
	missing := 0
	for _, name := range result.Supported {
		if !have[name] {
			missing++
			if missing <= 10 {
				t.Errorf("Intl supports %q but the zip lacks it", name)
			}
		}
	}
	for alias := range tz.ICUOnlyAliasZones {
		if !have[alias] {
			t.Errorf("Intl accepts the ICU id %q but the zip lacks it", alias)
		}
	}
	if missing > 0 {
		t.Fatalf("%d of %d Intl names are missing from the zip", missing, len(result.Supported))
	}
	for _, name := range result.Rejected {
		if name != "Factory" {
			t.Errorf("zip name %q is not an Intl zone; only Factory is expected", name)
		}
	}
	t.Logf("%d zip names cover %d Intl names plus %d discovered ICU-only ids; %d not an Intl zone",
		len(names), len(result.Supported), len(tz.ICUOnlyAliasZones), len(result.Rejected))
}

// TestSynthesizedZonesMatchIntl is the permanent form of the System V fix:
// each id production Node's ICU implements itself has a zone in the zip whose
// offsets match Intl's at every encoded transition through 2102 and at probes
// through 2200 (the POSIX footer). It fails if the synthesizer drifts from ICU or a
// regeneration drops an id.
func TestSynthesizedZonesMatchIntl(t *testing.T) {
	node := provenanceNode(t)
	if len(tz.SynthesizedZones) == 0 {
		t.Fatal("SynthesizedZones is empty: regenerate with go generate ./internal/tz")
	}
	start := time.Date(1900, 1, 1, 0, 0, 0, 0, time.UTC)
	forwardEnd := time.Date(2103, 1, 1, 0, 0, 0, 0, time.UTC)
	probeEnd := time.Date(2201, 1, 1, 0, 0, 0, 0, time.UTC)

	instants := map[string][]int64{}
	transitions := map[string]int{}
	for _, entry := range tz.SynthesizedZones {
		location, err := tz.Load(entry.Name)
		if err != nil {
			t.Fatalf("load %q: %v", entry.Name, err)
		}
		var list []int64
		for year := 1900; year < 2201; year++ {
			for month := 1; month <= 12; month++ {
				list = append(list, time.Date(year, time.Month(month), 15, 12, 0, 0, 0, time.UTC).UnixMilli())
			}
		}
		previous := zoneOffset(location, start.UnixMilli())
		for at := start.UnixMilli() + 24*3600*1000; at <= forwardEnd.UnixMilli(); at += 24 * 3600 * 1000 {
			current := zoneOffset(location, at)
			if current == previous {
				continue
			}
			low, high := at-24*3600*1000, at
			for high-low > 1000 {
				middle := low + (high-low)/2000*1000
				if zoneOffset(location, middle) == previous {
					low = middle
				} else {
					high = middle
				}
			}
			list = append(list, high-1000, high, high+1000)
			transitions[entry.Name]++
			previous = current
		}
		if entry.DST != (transitions[entry.Name] > 0) {
			t.Errorf("%q is marked DST=%t but the zone has %d transitions", entry.Name, entry.DST, transitions[entry.Name])
		}
		// Reachability: the synthesized entries are the ones Intl resolves to
		// themselves.
		list = append(list, start.UnixMilli(), probeEnd.UnixMilli()-1000)
		instants[entry.Name] = list
	}

	encoded, err := json.Marshal(instants)
	if err != nil {
		t.Fatal(err)
	}
	script := `import { readFileSync } from "node:fs";` +
		`const query = JSON.parse(readFileSync(0, "utf8"));` +
		`const build = (zone) => new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23",` +
		` year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });` +
		`const offsetAt = (format, at) => { const parts = {};` +
		` for (const { type, value } of format.formatToParts(at)) parts[type] = value;` +
		` const local = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day),` +
		` Number(parts.hour) % 24, Number(parts.minute), Number(parts.second));` +
		` return (local - at) / 1000; };` +
		`const answer = {};` +
		`for (const [name, list] of Object.entries(query)) {` +
		` const format = build(name);` +
		` if (format.resolvedOptions().timeZone !== name) throw new Error(name + " resolves to " + format.resolvedOptions().timeZone);` +
		` answer[name] = list.map((at) => offsetAt(format, at));` +
		`}` +
		`process.stdout.write(JSON.stringify(answer));`
	command := exec.Command(node, "-e", script)
	command.Stdin = bytes.NewReader(encoded)
	out, err := output(command, withoutTZ())
	if err != nil {
		t.Fatalf("run %s: %v", node, err)
	}
	var measured map[string][]int64
	if err := json.Unmarshal(out, &measured); err != nil {
		t.Fatalf("parse %s output: %v", node, err)
	}
	checked := 0
	for name, list := range instants {
		location, err := tz.Load(name)
		if err != nil {
			t.Fatalf("load %q: %v", name, err)
		}
		offsets := measured[name]
		if len(offsets) != len(list) {
			t.Fatalf("%s: ICU answered %d of %d instants", name, len(offsets), len(list))
		}
		for index, at := range list {
			if got := zoneOffset(location, at); got != offsets[index] {
				t.Errorf("%s at %s: zone %+d, Intl %+d", name, time.UnixMilli(at).UTC().Format(time.RFC3339), got, offsets[index])
			}
			checked++
		}
	}
	t.Logf("%d synthesized zones, %d transitions, %d offsets match Intl", len(tz.SynthesizedZones), transitionTotal(transitions), checked)
}

func zoneOffset(location *time.Location, at int64) int64 {
	_, seconds := time.UnixMilli(at).In(location).Zone()
	return int64(seconds)
}

func transitionTotal(counts map[string]int) int {
	total := 0
	for _, count := range counts {
		total += count
	}
	return total
}
