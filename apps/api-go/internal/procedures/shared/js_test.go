package shared

import (
	"bytes"
	"compress/gzip"
	"encoding/json"
	"io"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/tz"
)

func TestBase64URLMatchesNode(t *testing.T) {
	for input, want := range map[string]string{
		"eyJhIjoxfQ":         `{"a":1}`,
		"eyJhIjoxfQ==":       `{"a":1}`,
		"ey Jh Ijox fQ":      `{"a":1}`,
		"eyJhIjox*fQ":        `{"a":1}`,
		"*eyJhIjoxfQ":        `{"a":1}`,
		"e":                  ``,
		"eyJhIjoxfQx":        "{\"a\":1}\f",
		"eyJhIjoxfQ*garbage": "{\"a\":1}\b\x1a\xad\xb6\xa0",
	} {
		if got := string(Base64URL(input)); got != want {
			t.Errorf("%q = %q, want %q", input, got, want)
		}
	}
}

// Expected values are what Buffer.prototype.toString("utf8") returns: one U+FFFD per maximal
// subpart of an ill-formed sequence.
func TestUTF8ReplacesMaximalSubparts(t *testing.T) {
	for name, tc := range map[string]struct {
		in   []byte
		want string
	}{
		"valid":                   {[]byte("a\u00e9\u20ac\U0001F600"), "a\u00e9\u20ac\U0001F600"},
		"stray continuation":      {[]byte{'a', 0x80, 'b'}, "a\uFFFDb"},
		"two continuations":       {[]byte{0x80, 0x80}, "\uFFFD\uFFFD"},
		"truncated three byte":    {[]byte{0xE2, 0x82}, "\uFFFD"},
		"truncated then ascii":    {[]byte{0xE2, 0x82, 'x'}, "\uFFFDx"},
		"truncated four byte":     {[]byte{0xF0, 0x9F, 0x98}, "\uFFFD"},
		"overlong lead":           {[]byte{0xC0, 0x80}, "\uFFFD\uFFFD"},
		"overlong three byte":     {[]byte{0xE0, 0x80, 0x80}, "\uFFFD\uFFFD\uFFFD"},
		"surrogate encoded":       {[]byte{0xED, 0xA0, 0x80}, "\uFFFD\uFFFD\uFFFD"},
		"above max":               {[]byte{0xF4, 0x90, 0x80, 0x80}, "\uFFFD\uFFFD\uFFFD\uFFFD"},
		"invalid lead":            {[]byte{0xFF, 'a'}, "\uFFFDa"},
		"truncated then restart":  {[]byte{0xE2, 0x82, 0xE2, 0x82, 0xAC}, "\uFFFD\u20ac"},
		"lead then second wrong":  {[]byte{0xE1, 0x7F}, "\uFFFD\x7f"},
		"four byte second bad":    {[]byte{0xF0, 0x8F, 0xBF, 0xBF}, "\uFFFD\uFFFD\uFFFD\uFFFD"},
		"four byte third bad":     {[]byte{0xF1, 0x80, 0x7F}, "\uFFFD\x7f"},
		"empty":                   {nil, ""},
		"truncated at end of two": {[]byte{'z', 0xC3}, "z\uFFFD"},
	} {
		if got := UTF8(tc.in); got != tc.want {
			t.Errorf("%s: %q, want %q", name, got, tc.want)
		}
	}
}

func TestParseDate(t *testing.T) {
	utc := func(y int, m time.Month, d, h, mi, s, ms int) int64 {
		return time.Date(y, m, d, h, mi, s, ms*1_000_000, time.UTC).UnixMilli()
	}
	for text, want := range map[string]int64{
		"2026-05-01":                   utc(2026, 5, 1, 0, 0, 0, 0),
		"2026-05":                      utc(2026, 5, 1, 0, 0, 0, 0),
		"2026":                         utc(2026, 1, 1, 0, 0, 0, 0),
		"2026-05-01T10:00:00.000Z":     utc(2026, 5, 1, 10, 0, 0, 0),
		"2026-05-01T10:00:00z":         utc(2026, 5, 1, 10, 0, 0, 0),
		"2026-05-01T10:00:00.1234567Z": utc(2026, 5, 1, 10, 0, 0, 123),
		"2026-05-01T10:00:00+05:30":    utc(2026, 5, 1, 4, 30, 0, 0),
		"2026-05-01T24:00:00Z":         utc(2026, 5, 2, 0, 0, 0, 0),
		"+020000-01-01T00:00:00Z":      utc(20000, 1, 1, 0, 0, 0, 0),
		// ECMAScript TimeClip boundaries: both are valid Dates.
		"+275760-09-13T00:00:00.000Z": utc(275760, 9, 13, 0, 0, 0, 0),
		"-271821-04-20T00:00:00.000Z": utc(-271821, 4, 20, 0, 0, 0, 0),
	} {
		got, ok := ParseDate(text)
		if !ok || got.UnixMilli() != want {
			t.Errorf("%q = %v ok=%v, want %d", text, got.UnixMilli(), ok, want)
		}
	}
	for _, text := range []string{
		"", "yesterday", "2026-13-01", "2026-05-32", "2026-05-01T10:60", "2026-05-01T24:00:01Z", "May 1 2026",
		// One millisecond outside the TimeClip range each way is Invalid Date.
		"+275760-09-13T00:00:00.001Z", "-271821-04-19T23:59:59.999Z",
	} {
		if _, ok := ParseDate(text); ok {
			t.Errorf("%q accepted", text)
		}
	}
}

func TestISOStringMatchesToISOString(t *testing.T) {
	for want, at := range map[string]time.Time{
		"2026-05-01T12:00:00.000Z":    time.Date(2026, 5, 1, 12, 0, 0, 0, time.UTC),
		"2026-05-01T12:00:00.123Z":    time.Date(2026, 5, 1, 12, 0, 0, 123_000_000, time.UTC),
		"0000-01-01T00:00:00.000Z":    time.Date(0, 1, 1, 0, 0, 0, 0, time.UTC),
		"9999-12-31T23:59:59.999Z":    time.Date(9999, 12, 31, 23, 59, 59, 999_000_000, time.UTC),
		"+010000-01-01T00:00:00.000Z": time.Date(10000, 1, 1, 0, 0, 0, 0, time.UTC),
		"+020000-06-07T08:09:10.011Z": time.Date(20000, 6, 7, 8, 9, 10, 11_000_000, time.UTC),
		"-000001-01-01T00:00:00.000Z": time.Date(-1, 1, 1, 0, 0, 0, 0, time.UTC),
	} {
		if got := ISOString(at); got != want {
			t.Errorf("%v = %s, want %s", at, got, want)
		}
	}
}

// parseDateLocalCases pin V8's reading of a datetime without an offset in the
// process zone, measured with production node (new Date(text).getTime()) under
// TZ=UTC and TZ=America/Havana. They exercise the tz.Local line through the
// same inputs a client cursor carries into pages/cursor.go, which base64-decodes
// a client string and hands updatedAt/pinnedAt to ParseDate exactly as TS hands
// them to Date.parse. The wide differential is TestParseDateLocalZone; this
// table keeps a handful of readable vectors, the last two a DST gap and overlap.
var parseDateLocalCases = []struct {
	text   string
	utc    int64
	havana int64
}{
	{"2026-11-10", 1794268800000, 1794268800000},
	{"2026-11-10T07:46:43", 1794296803000, 1794314803000},
	{"2026-01-15T00:00:00", 1768435200000, 1768453200000},
	{"2030-06-01T12:34:56", 1906547696000, 1906562096000},
	{"2026-03-08T00:30:00", 1772929800000, 1772947800000}, // the clocks skip this time
	{"2026-11-01T00:30:00", 1793493000000, 1793507400000}, // the clocks repeat this time
}

const (
	parseDateWallsEnv   = "PARSE_DATE_WALLS"
	parseDateResultsEnv = "PARSE_DATE_RESULTS"
)

// TestParseDateWallsChild is the child half of the ParseDate differential: it
// parses the wall times named by PARSE_DATE_WALLS in the zone TZ names and
// writes the instants to PARSE_DATE_RESULTS. One child per zone, because
// tz.Local resolves once per process.
func TestParseDateWallsChild(t *testing.T) {
	wallsFile := os.Getenv(parseDateWallsEnv)
	resultsFile := os.Getenv(parseDateResultsEnv)
	if wallsFile == "" || resultsFile == "" {
		t.Skip("helper process for the ParseDate local-zone tests")
	}
	encoded, err := os.ReadFile(wallsFile)
	if err != nil {
		t.Fatal(err)
	}
	var walls []string
	if err := json.Unmarshal(encoded, &walls); err != nil {
		t.Fatal(err)
	}
	results := make([]int64, len(walls))
	for index, wall := range walls {
		moment, ok := ParseDate(wall)
		if !ok {
			results[index] = math.MaxInt64
			continue
		}
		results[index] = moment.UnixMilli()
	}
	out, err := json.Marshal(results)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(resultsFile, out, 0o644); err != nil {
		t.Fatal(err)
	}
}

// parseDateWalls parses walls with ParseDate in a process whose TZ is zone.
func parseDateWalls(t *testing.T, zone string, walls []string) []int64 {
	t.Helper()
	directory := t.TempDir()
	wallsFile := filepath.Join(directory, "walls.json")
	resultsFile := filepath.Join(directory, "results.json")
	encoded, err := json.Marshal(walls)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(wallsFile, encoded, 0o644); err != nil {
		t.Fatal(err)
	}
	command := exec.Command(os.Args[0], "-test.run=^TestParseDateWallsChild$")
	command.Env = append(environmentWithoutTZ(), "TZ="+zone,
		parseDateWallsEnv+"="+wallsFile, parseDateResultsEnv+"="+resultsFile)
	var stderr bytes.Buffer
	command.Stderr = &stderr
	if out, err := command.Output(); err != nil {
		t.Fatalf("child under TZ=%s: %v: %s%s", zone, err, out, stderr.String())
	}
	raw, err := os.ReadFile(resultsFile)
	if err != nil {
		t.Fatalf("child under TZ=%s wrote no result: %v", zone, err)
	}
	var results []int64
	if err := json.Unmarshal(raw, &results); err != nil {
		t.Fatalf("parse child output %q: %v", raw, err)
	}
	if len(results) != len(walls) {
		t.Fatalf("child under TZ=%s returned %d results for %d walls", zone, len(results), len(walls))
	}
	return results
}

func TestParseDateLocalPinned(t *testing.T) {
	walls := make([]string, len(parseDateLocalCases))
	for index, c := range parseDateLocalCases {
		walls[index] = c.text
	}
	for _, zone := range []struct {
		name     string
		value    string
		expected func(int) int64
	}{
		{"UTC", "UTC", func(index int) int64 { return parseDateLocalCases[index].utc }},
		{"Havana", "America/Havana", func(index int) int64 { return parseDateLocalCases[index].havana }},
	} {
		t.Run(zone.name, func(t *testing.T) {
			got := parseDateWalls(t, zone.value, walls)
			for index, c := range parseDateLocalCases {
				if want := zone.expected(index); got[index] != want {
					t.Errorf("%q = %d, want %d", c.text, got[index], want)
				}
			}
		})
	}
}

// TestParseDateReviewVectors pins the historical wall times the r2 review
// measured: ordinary times around a DST change, which a rule that reads one
// offset at the wall-as-UTC instant read an hour out.
func TestParseDateReviewVectors(t *testing.T) {
	for _, c := range []struct {
		zone string
		wall string
		want int64
	}{
		{"Asia/Manila", "1990-07-28T22:00:00", 649170000000},
		{"Asia/Manila", "1945-11-30T22:15:00", -760099500000},
		{"America/Havana", "1995-04-02T02:40:00", 796804800000},
	} {
		got := parseDateWalls(t, c.zone, []string{c.wall})
		if got[0] != c.want {
			t.Errorf("%s: ParseDate(%q) = %d, want %d", c.zone, c.wall, got[0], c.want)
		}
	}
}

type localWallCase struct {
	Wall string `json:"wall"`
	MS   int64  `json:"ms"`
}

type localWallCorpus struct {
	TZ    string                     `json:"tz"`
	Node  string                     `json:"node"`
	ICU   string                     `json:"icu"`
	Zones map[string][]localWallCase `json:"zones"`
}

func readLocalWallCorpus(t *testing.T) localWallCorpus {
	t.Helper()
	file, err := os.Open("testdata/local-wall-corpus.json.gz")
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	reader, err := gzip.NewReader(file)
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	buffer, err := io.ReadAll(reader)
	if err != nil {
		t.Fatal(err)
	}
	var corpus localWallCorpus
	if err := json.Unmarshal(buffer, &corpus); err != nil {
		t.Fatal(err)
	}
	return corpus
}

// TestParseDateLocalZone replays the recorded differential: every zone's
// transitions from 1900 to 2100, with every wall time inside each gap and
// overlap (minute by minute), five-minute samples an hour either side of every
// transition read with both offsets, and random walls across the range. V8
// chooses the instant with Temporal's "compatible" disambiguation, and Go must
// return the same instant for every one.
func TestParseDateLocalZone(t *testing.T) {
	corpus := readLocalWallCorpus(t)
	if corpus.TZ != tz.Version || corpus.Node != tz.NodeVersion || corpus.ICU != tz.ICUVersion {
		t.Fatalf("corpus was recorded from node %s / ICU %s / tzdata %s, the embedded zones are pinned to node %s / ICU %s / tzdata %s: regenerate it with tools/tz-local-corpus.mjs",
			corpus.Node, corpus.ICU, corpus.TZ, tz.NodeVersion, tz.ICUVersion, tz.Version)
	}
	zones := make([]string, 0, len(corpus.Zones))
	for zone := range corpus.Zones {
		zones = append(zones, zone)
	}
	sort.Strings(zones)
	for _, zone := range zones {
		cases := corpus.Zones[zone]
		if len(cases) == 0 {
			t.Errorf("%s has no wall times", zone)
			continue
		}
		walls := make([]string, len(cases))
		for index, c := range cases {
			walls[index] = c.Wall
		}
		got := parseDateWalls(t, zone, walls)
		mismatches := 0
		for index, c := range cases {
			if got[index] != c.MS {
				mismatches++
				if mismatches <= 10 {
					t.Errorf("%s: %s = %d, want %d (V8)", zone, c.Wall, got[index], c.MS)
				}
			}
		}
		if mismatches > 0 {
			t.Fatalf("%s: %d of %d wall times differ from V8", zone, mismatches, len(cases))
		}
		t.Logf("%s: %d wall times match", zone, len(cases))
	}
}

func environmentWithoutTZ() []string {
	var environment []string
	for _, entry := range os.Environ() {
		if strings.HasPrefix(entry, "TZ=") {
			continue
		}
		environment = append(environment, entry)
	}
	return environment
}
