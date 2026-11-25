package tz_test

import (
	"bytes"
	"compress/gzip"
	"encoding/json"
	"os"
	"os/exec"
	"testing"
	"time"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/tz"
)

// offsetCorpus is testdata/offset-corpus.json.gz, recorded from production
// Node's Intl by tools/tz-offset-corpus.mjs.
type offsetCorpus struct {
	TZ          string     `json:"tz"`
	Node        string     `json:"node"`
	ICU         string     `json:"icu"`
	Zones       []string   `json:"zones"`
	Unsupported []string   `json:"unsupported"`
	Queries     [][3]int64 `json:"queries"`
}

func readOffsetCorpus(t *testing.T) offsetCorpus {
	t.Helper()
	file, err := os.Open("testdata/offset-corpus.json.gz")
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	reader, err := gzip.NewReader(file)
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	var buffer bytes.Buffer
	if _, err := buffer.ReadFrom(reader); err != nil {
		t.Fatal(err)
	}
	var corpus offsetCorpus
	if err := json.Unmarshal(buffer.Bytes(), &corpus); err != nil {
		t.Fatal(err)
	}
	return corpus
}

// TestOffsetsMatchNodeIntlCorpus replays the recorded differential: all 597
// zones Intl supports, at the instants around every transition from 2020 to
// 2030, at yearly samples from 1970 to 2038 and at samples out to 2070.
func TestOffsetsMatchNodeIntlCorpus(t *testing.T) {
	corpus := readOffsetCorpus(t)
	if corpus.TZ != tz.Version || corpus.Node != tz.NodeVersion || corpus.ICU != tz.ICUVersion {
		t.Fatalf("corpus was recorded from node %s / ICU %s / tzdata %s, the embedded zones are pinned to node %s / ICU %s / tzdata %s: regenerate it with tools/tz-offset-corpus.mjs",
			corpus.Node, corpus.ICU, corpus.TZ, tz.NodeVersion, tz.ICUVersion, tz.Version)
	}

	// Every embedded name is either probed or documented as one Intl rejects;
	// a regenerated release that adds or drops zones must not pass silently.
	probed := make(map[string]bool, len(corpus.Zones)+len(corpus.Unsupported))
	for _, name := range corpus.Zones {
		probed[name] = true
	}
	for _, name := range corpus.Unsupported {
		if name != "Factory" {
			t.Fatalf("corpus leaves %q unprobed; only Factory is known to be unusable in Intl", name)
		}
		probed[name] = true
	}
	for _, name := range tz.Names() {
		if !probed[name] {
			t.Fatalf("embedded zone %q is missing from the corpus", name)
		}
	}
	if len(tz.Names()) != len(probed) {
		t.Fatalf("embedded zones %d, corpus names %d", len(tz.Names()), len(probed))
	}

	locations := make([]*time.Location, len(corpus.Zones))
	for index, name := range corpus.Zones {
		location, err := tz.Load(name)
		if err != nil {
			t.Fatalf("load %q: %v", name, err)
		}
		locations[index] = location
	}
	failures := 0
	for _, query := range corpus.Queries {
		index := query[0]
		if index < 0 || int(index) >= len(locations) {
			t.Fatalf("corpus query names zone %d of %d", index, len(locations))
		}
		if got := goOffset(t, locations[index], query[1]); got != query[2] {
			failures++
			if failures <= 10 {
				t.Errorf("%s at %s: Go %+d, Intl %+d", corpus.Zones[index],
					time.UnixMilli(query[1]).UTC().Format(time.RFC3339), got, query[2])
			}
		}
	}
	if failures > 0 {
		t.Fatalf("%d of %d recorded offsets differ", failures, len(corpus.Queries))
	}
	t.Logf("%d zones, %d offsets match", len(corpus.Zones), len(corpus.Queries))
}

// TestOffsetsMatchNodeIntlLive asks the production Node for the same offsets
// now, and additionally probes both sides of every transition Go finds, so a
// transition ICU does not have cannot hide between corpus samples. Skipped
// only when no node is installed.
func TestOffsetsMatchNodeIntlLive(t *testing.T) {
	node := provenanceNode(t)
	corpus := readOffsetCorpus(t)
	zones := append([]string(nil), corpus.Zones...)
	index := make(map[string]int, len(corpus.Zones)+len(tz.Names()))
	for i, name := range corpus.Zones {
		index[name] = i
	}
	unsupported := make(map[string]bool, len(corpus.Unsupported))
	for _, name := range corpus.Unsupported {
		unsupported[name] = true
	}

	type query struct {
		zone    int
		instant int64
	}
	seen := make(map[query]bool, len(corpus.Queries))
	queries := make([]query, 0, len(corpus.Queries)+1024)
	recorded := len(corpus.Queries)
	add := func(zone int, instant int64) {
		key := query{zone, instant}
		if seen[key] {
			return
		}
		seen[key] = true
		queries = append(queries, key)
	}
	for _, recorded := range corpus.Queries {
		add(int(recorded[0]), recorded[1])
	}

	// Go's own transitions get the same treatment: both sides of the change.
	for _, name := range tz.Names() {
		if unsupported[name] {
			continue
		}
		location, err := tz.Load(name)
		if err != nil {
			t.Fatalf("load %q: %v", name, err)
		}
		zone, ok := index[name]
		if !ok {
			zone = len(zones)
			index[name] = zone
			zones = append(zones, name)
		}
		for _, transition := range transitions(t, location, time.Date(2020, 1, 1, 0, 0, 0, 0, time.UTC), time.Date(2030, 1, 1, 0, 0, 0, 0, time.UTC)) {
			for _, delta := range []int64{-86_400_000, -3_600_000, -1000, 0, 1000, 3_600_000, 86_400_000} {
				add(zone, transition+delta)
			}
		}
	}

	payload, err := json.Marshal(struct {
		Zones   []string   `json:"zones"`
		Queries [][2]int64 `json:"queries"`
	}{Zones: zones, Queries: func() [][2]int64 {
		out := make([][2]int64, len(queries))
		for i, q := range queries {
			out[i] = [2]int64{int64(q.zone), q.instant}
		}
		return out
	}()})
	if err != nil {
		t.Fatal(err)
	}
	command := exec.Command(node, "../../tools/tz-live-offsets.mjs")
	command.Stdin = bytes.NewReader(payload)
	var stderr bytes.Buffer
	command.Stderr = &stderr
	out, err := command.Output()
	if err != nil {
		t.Fatalf("run %s: %v: %s", node, err, stderr.String())
	}
	var offsets []int64
	if err := json.Unmarshal(out, &offsets); err != nil {
		t.Fatalf("parse %s output: %v", node, err)
	}
	if len(offsets) != len(queries) {
		t.Fatalf("%s returned %d offsets for %d queries", node, len(offsets), len(queries))
	}
	failures := 0
	for i, q := range queries {
		location, err := tz.Load(zones[q.zone])
		if err != nil {
			t.Fatalf("load %q: %v", zones[q.zone], err)
		}
		if got := goOffset(t, location, q.instant); got != offsets[i] {
			failures++
			if failures <= 10 {
				t.Errorf("%s at %s: Go %+d, Intl %+d", zones[q.zone],
					time.UnixMilli(q.instant).UTC().Format(time.RFC3339), got, offsets[i])
			}
		}
	}
	if failures > 0 {
		t.Fatalf("%d of %d live offsets differ from %s", failures, len(queries), node)
	}
	t.Logf("%d zones, %d live offsets match %s (%d recorded, %d from transitions Go found)", len(zones), len(queries), node, recorded, len(queries)-recorded)
}

// transitions lists the instants in [from, to] at which location's offset
// changes, to the second, by scanning daily and bisecting each change.
func transitions(t *testing.T, location *time.Location, from, to time.Time) []int64 {
	t.Helper()
	const day = int64(86_400_000)
	start, end := from.UnixMilli(), to.UnixMilli()
	offset := func(instant int64) int64 {
		_, seconds := time.UnixMilli(instant).In(location).Zone()
		return int64(seconds)
	}
	var found []int64
	previous := offset(start)
	for at := start + day; at <= end; at += day {
		current := offset(at)
		if current == previous {
			continue
		}
		// Bisect on whole seconds: every tz transition falls on one.
		low, high := (at-day)/1000, at/1000
		for high-low > 1 {
			middle := (low + high) / 2
			if offset(middle*1000) == previous {
				low = middle
			} else {
				high = middle
			}
		}
		found = append(found, high*1000)
		previous = current
	}
	return found
}
