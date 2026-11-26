package tz_test

import (
	"bytes"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/tz"
)

// localInstants are the instants the local-zone differential compares at: a
// summer and a winter date in the reachable range, a later year, and one past
// date (all after 1970, where ICU and IANA agree for every zone).
var localInstants = []int64{
	time.Date(2026, 7, 15, 12, 0, 0, 0, time.UTC).UnixMilli(),
	time.Date(2026, 12, 6, 12, 0, 0, 0, time.UTC).UnixMilli(),
	time.Date(2030, 1, 15, 12, 0, 0, 0, time.UTC).UnixMilli(),
	time.Date(1990, 7, 15, 12, 0, 0, 0, time.UTC).UnixMilli(),
}

const localChildOut = "TZ_PARITY_LOCAL_CHILD_OUT"

// TestLocalChildWritesSnapshot is the child half of the differential below: one
// process per TZ value, because tz.Local resolves once per process.
func TestLocalChildWritesSnapshot(t *testing.T) {
	out := os.Getenv(localChildOut)
	if out == "" {
		t.Skip("helper process for TestLocalMatchesV8TZForms")
	}
	location := tz.Local()
	snapshot := struct {
		Zone    string  `json:"zone"`
		Offsets []int64 `json:"offsets"`
	}{Zone: location.String()}
	for _, instant := range localInstants {
		_, offset := time.UnixMilli(instant).In(location).Zone()
		snapshot.Offsets = append(snapshot.Offsets, int64(offset))
	}
	encoded, err := json.Marshal(snapshot)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(out, encoded, 0o644); err != nil {
		t.Fatal(err)
	}
}

// TestLocalMatchesV8TZForms runs the default-zone rules against production V8:
// for each TZ form, one node process and one Go process report the zone offset
// at the same instants, and they must agree. The forms include every quirk V8
// has — empty TZ, case sensitivity, ICU aliases, System V ids, TZif paths and
// POSIX strings with and without DST rules.
func TestLocalMatchesV8TZForms(t *testing.T) {
	node := provenanceNode(t)
	// Offsets come from the wall clock Intl reports, not getTimezoneOffset:
	// that truncates historical sub-minute offsets, and Go's offsets are whole
	// seconds.
	script := `const format = new Intl.DateTimeFormat("en-US", {` +
		` hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",` +
		` hour: "2-digit", minute: "2-digit", second: "2-digit" });` +
		`const offsetAt = (instant) => { const parts = {};` +
		` for (const { type, value } of format.formatToParts(instant)) parts[type] = value;` +
		` const local = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day),` +
		` Number(parts.hour) % 24, Number(parts.minute), Number(parts.second));` +
		` return (local - instant) / 1000; };` +
		`process.stdout.write(JSON.stringify({` +
		` zone: Intl.DateTimeFormat().resolvedOptions().timeZone ?? null,` +
		` offsets: ` + instantsJSON(t) + `.map(offsetAt) }))`
	// V8's TZ=<path> and TZ=localtime modes report the file's standard offset at
	// every instant: all DST is dropped, historical and modern alike (see
	// TestLocalPathFormDropsDST). Go parses the TZif faithfully, so only the
	// forms whose zone has no DST in the compared instants agree here; the
	// Manila path form and TZ=localtime (this host's Asia/Manila) are compared
	// from 2026 on, where Manila has no DST. Production does not set TZ.
	forms := []struct {
		label      string
		value      *string
		modernOnly bool
	}{
		{"unset", nil, false},
		{"empty", new(""), false},
		{"colon", new(":"), false},
		{"colon twice", new("::Asia/Tokyo"), false},
		{"localtime", new("localtime"), true},
		{"exact id", new("Asia/Tokyo"), false},
		{"colon-prefixed id", new(":Asia/Tokyo"), false},
		{"lowercase id", new("asia/tokyo"), false},
		{"lowercase utc", new("utc"), false},
		{"lowercase alias", new("america/havana"), false},
		{"ICU alias", new("US/Pacific-New"), false},
		{"ICU alias with history", new("Canada/East-Saskatchewan"), false},
		{"System V id", new("PST"), false},
		{"System V id east", new("ACT"), false},
		{"System V id half hour", new("IST"), false},
		{"POSIX fixed west", new("ABC3"), false},
		{"POSIX fixed east", new("XXX-3"), false},
		{"POSIX fixed plus sign", new("ABC-3"), false},
		{"POSIX fixed zero", new("UTC0"), false},
		{"POSIX with minutes", new("ABC3:30"), false},
		{"POSIX with DST name", new("ABC3DEF"), false},
		{"POSIX with DST rules", new("ABC3DEF,M3.2.0/2,M11.1.0/2"), false},
		{"POSIX angle brackets", new("<-03>3"), false},
		{"POSIX angle with offset", new("<+0330>-3:30"), false},
		{"short POSIX name", new("A3"), false},
		{"letters only", new("ABC"), false},
		{"GMT", new("GMT"), false},
		{"Etc/UTC", new("Etc/UTC"), false},
		{"zed alias", new("Asia/Calcutta"), false},
		{"zip POSIX name", new("EST5EDT"), false},
		{"zip POSIX name west", new("PST8PDT"), false},
		{"Factory", new("Factory"), false},
		{"unknown name", new("No/Such"), false},
		{"leading space", new(" GMT"), false},
		{"trailing space", new("Asia/Tokyo "), false},
		{"TZif path", new("/usr/share/zoneinfo/Asia/Tokyo"), true},
		{"colon TZif path", new(":/usr/share/zoneinfo/Asia/Tokyo"), true},
		{"missing TZif path", new("/no/such/file"), true},
		{"host localtime path", new("/etc/localtime"), true},
		{"dot", new("."), false},
		{"system zone by name", new("Asia/Manila"), false},
		{"POSIX with a plus hour", new("ABC+3"), false},
		{"POSIX hour 24", new("ABC24"), false},
		{"POSIX zero minutes", new("ABC3:00"), false},
		{"POSIX DST with offset", new("ABC3DEF4"), false},
		{"two-letter POSIX name", new("AB3"), false},
		{"letters with no offset", new("ABCDEF"), false},
		{"GMT with an offset", new("GMT+5"), false},
		{"UTC with an offset", new("UTC-5"), false},
		{"UTC plus", new("UTC+5"), false},
		{"bare offset id", new("+05"), false},
		{"posix directory", new("posix/UTC"), false},
		{"right directory", new("right/UTC"), false},
		{"Zulu", new("Zulu"), false},
		{"Greenwich", new("Greenwich"), false},
		{"Universal", new("Universal"), false},
		{"UCT", new("UCT"), false},
		{"US/Eastern", new("US/Eastern"), false},
		{"Calcutta", new("Asia/Calcutta"), false},
		{"Indianapolis", new("America/Indiana/Indianapolis"), false},
		{"Lord Howe", new("Australia/Lord_Howe"), false},
		{"Apia", new("Pacific/Apia"), false},
		{"Cuba", new("Cuba"), false},
		{"Iran", new("Iran"), false},
		{"PRC", new("PRC"), false},
		{"ROC", new("ROC"), false},
		{"ROK", new("ROK"), false},
		{"W-SU", new("W-SU"), false},
		{"SystemV/AST4", new("SystemV/AST4"), false},
		{"SystemV/AST4ADT", new("SystemV/AST4ADT"), false},
		{"SystemV/CST6", new("SystemV/CST6"), false},
		{"SystemV/CST6CDT", new("SystemV/CST6CDT"), false},
		{"SystemV/EST5", new("SystemV/EST5"), false},
		{"SystemV/EST5EDT", new("SystemV/EST5EDT"), false},
		{"SystemV/HST10", new("SystemV/HST10"), false},
		{"SystemV/MST7", new("SystemV/MST7"), false},
		{"SystemV/MST7MDT", new("SystemV/MST7MDT"), false},
		{"SystemV/PST8", new("SystemV/PST8"), false},
		{"SystemV/PST8PDT", new("SystemV/PST8PDT"), false},
		{"SystemV/YST9", new("SystemV/YST9"), false},
		{"SystemV/YST9YDT", new("SystemV/YST9YDT"), false},
		{"CUBA is not a zone", new("CUBA"), false},
		{"EIRE is not a zone", new("EIRE"), false},
		{"IRAN is not a zone", new("IRAN"), false},
		{"ZULU is not a zone", new("ZULU"), false},
	}
	for _, form := range forms {
		t.Run(form.label, func(t *testing.T) {
			environment := withoutTZ()
			if form.value != nil {
				environment = append(environment, "TZ="+*form.value)
			}
			var want struct {
				Zone    *string `json:"zone"`
				Offsets []int64 `json:"offsets"`
			}
			out, err := output(exec.Command(node, "-e", script), environment)
			if err != nil {
				t.Fatalf("node: %v: %s", err, out)
			}
			if err := json.Unmarshal(out, &want); err != nil {
				t.Fatalf("parse node output %q: %v", out, err)
			}

			outFile := filepath.Join(t.TempDir(), "local.json")
			child := exec.Command(os.Args[0], "-test.run=^TestLocalChildWritesSnapshot$")
			out, err = output(child, append(environment, localChildOut+"="+outFile))
			if err != nil {
				t.Fatalf("go child: %v: %s", err, out)
			}
			raw, err := os.ReadFile(outFile)
			if err != nil {
				t.Fatalf("go child wrote no snapshot: %v: %s", err, out)
			}
			var got struct {
				Zone    string  `json:"zone"`
				Offsets []int64 `json:"offsets"`
			}
			if err := json.Unmarshal(raw, &got); err != nil {
				t.Fatalf("parse go snapshot %q: %v", raw, err)
			}
			if got.Zone == "" {
				t.Errorf("tz.Local() has no zone name")
			}
			if len(got.Offsets) != len(want.Offsets) {
				t.Fatalf("go reported %d offsets, V8 %d", len(got.Offsets), len(want.Offsets))
			}
			compared := len(got.Offsets)
			if form.modernOnly {
				compared = 3
			}
			for index := 0; index < compared; index++ {
				offset := got.Offsets[index]
				if offset != want.Offsets[index] {
					t.Errorf("at %s: Go %+d, V8 %+d (Go zone %q, V8 zone %v)",
						time.UnixMilli(localInstants[index]).UTC().Format(time.RFC3339),
						offset, want.Offsets[index], got.Zone, valueOr(want.Zone, "unset"))
				}
			}
		})
	}
	t.Logf("%d TZ forms agree with production V8", len(forms))
}

func instantsJSON(t *testing.T) string {
	t.Helper()
	encoded, err := json.Marshal(localInstants)
	if err != nil {
		t.Fatal(err)
	}
	return string(encoded)
}

func valueOr(value *string, fallback string) string {
	if value == nil {
		return fallback
	}
	return *value
}

// withoutTZ is the current environment with TZ removed, so each form controls it.
func withoutTZ() []string {
	var environment []string
	for _, entry := range os.Environ() {
		if strings.HasPrefix(entry, "TZ=") {
			continue
		}
		environment = append(environment, entry)
	}
	return environment
}

func output(command *exec.Cmd, environment []string) ([]byte, error) {
	command.Env = environment
	var stderr bytes.Buffer
	command.Stderr = &stderr
	command.Stdout = nil
	out, err := command.Output()
	if err != nil {
		return append(out, stderr.Bytes()...), err
	}
	return out, nil
}

// TestLegacyDefaultUTCMatchesV8 re-measures, over every name in the zip, the
// set where V8's default zone reports the canonical zone but reads UTC: one
// node process per name, the default format built before any explicit one (the
// order V8's own startup has), and the canonical zone's offsets taken
// separately. The generated LegacyDefaultUTC must equal that set, so a new
// release or ICU cannot change the quirk silently.
func TestLegacyDefaultUTCMatchesV8(t *testing.T) {
	node := provenanceNode(t)
	names := tz.Names()
	instants := []int64{
		time.Date(2026, 1, 15, 12, 0, 0, 0, time.UTC).UnixMilli(),
		time.Date(2026, 7, 15, 12, 0, 0, 0, time.UTC).UnixMilli(),
		time.Date(2026, 11, 5, 12, 0, 0, 0, time.UTC).UnixMilli(),
		time.Date(1970, 7, 15, 12, 0, 0, 0, time.UTC).UnixMilli(),
	}
	encoded, err := json.Marshal(map[string]any{"names": names, "instants": instants})
	if err != nil {
		t.Fatal(err)
	}
	script := `import { readFileSync } from "node:fs";` +
		`import { spawn } from "node:child_process";` +
		`const payload = JSON.parse(readFileSync(0, "utf8"));` +
		`const source = ` + "`" + `
const instants = ${JSON.stringify(payload.instants)};
const build = (options) => new Intl.DateTimeFormat("en-US", { hourCycle: "h23", year: "numeric",` +
		` month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", ...options });
const offsetAt = (format, at) => { const parts = {};` +
		` for (const { type, value } of format.formatToParts(at)) parts[type] = value;` +
		` const local = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day),` +
		` Number(parts.hour) % 24, Number(parts.minute), Number(parts.second));` +
		` return (local - at) / 1000; };
const defaultFormat = build({});
const zone = defaultFormat.resolvedOptions().timeZone ?? null;
const offsets = instants.map((at) => offsetAt(defaultFormat, at));
let canonical = null, own = null;
try {
  canonical = build({ timeZone: process.env.TZ }).resolvedOptions().timeZone;
  const named = build({ timeZone: canonical });
  own = instants.map((at) => offsetAt(named, at));
} catch {}
process.stdout.write(JSON.stringify({ zone, offsets, canonical, own }));
` + "`" + `;` +
		`const runOne = (name) => new Promise((resolve) => {` +
		` const child = spawn(process.execPath, ["-e", source], {` +
		`  env: { ...process.env, TZ: name }, stdio: ["ignore", "pipe", "ignore"] });` +
		` let out = ""; child.stdout.on("data", (chunk) => { out += chunk; });` +
		` child.on("close", () => { try { resolve([name, JSON.parse(out)]); } catch { resolve([name, null]); } });` +
		`});` +
		`const results = []; let next = 0;` +
		`await Promise.all(Array.from({ length: 12 }, async () => {` +
		` while (next < payload.names.length) { const name = payload.names[next++]; results.push(await runOne(name)); }` +
		`}));` +
		`const legacy = [], failed = [];` +
		`for (const [name, data] of results) {` +
		` if (!data) { failed.push([name, "no output"]); continue; }` +
		` if (!data.canonical || !data.own) continue;` +
		` if (data.zone !== data.canonical) continue;` +
		` if (!data.offsets.every((offset) => offset === 0)) continue;` +
		` if (!data.own.some((offset) => offset !== 0)) continue;` +
		` legacy.push(name);` +
		`}` +
		`legacy.sort();` +
		`process.stdout.write(JSON.stringify({ legacy, measured: results.length, failed }));`
	command := exec.Command(node, "-e", script)
	command.Env = withoutTZ()
	command.Stdin = bytes.NewReader(encoded)
	out, err := command.Output()
	if err != nil {
		t.Fatalf("run %s: %v", node, err)
	}
	var result struct {
		Legacy   []string `json:"legacy"`
		Measured int      `json:"measured"`
		Failed   [][2]any `json:"failed"`
	}
	if err := json.Unmarshal(out, &result); err != nil {
		t.Fatalf("parse %s output: %v", node, err)
	}
	if len(result.Failed) > 0 {
		t.Fatalf("%s measured no default zone for %d name(s): %v", node, len(result.Failed), result.Failed)
	}
	if result.Measured != len(names) {
		t.Fatalf("%s measured %d names, the zip carries %d", node, result.Measured, len(names))
	}
	generated := append([]string(nil), tz.LegacyDefaultUTC...)
	sort.Strings(generated)
	if strings.Join(result.Legacy, " ") != strings.Join(generated, " ") {
		t.Errorf("V8 reads UTC for its default zone on %v; LegacyDefaultUTC is %v: regenerate with go generate ./internal/tz", result.Legacy, generated)
	}
	t.Logf("%d of %d zip names read UTC in V8's default zone and resolve in Intl", len(result.Legacy), len(names))
}

// TestLocalPathFormDropsDST records the one V8 TZ form tz.Local deliberately
// does not reproduce: with TZ=<TZif path>, V8 reports the file's standard
// offset at every instant — all DST is dropped, at modern instants too — while
// tz.Local parses the file faithfully. The test fails if V8 starts honouring the
// transitions, so the divergence documented in design.md cannot go stale.
func TestLocalPathFormDropsDST(t *testing.T) {
	node := provenanceNode(t)
	// localInstants compared here: 0 = 2026-07-15 (northern summer), 1 =
	// 2026-12-06 (northern winter), 3 = 1990-07-15.
	const (
		summerIndex = 0
		winterIndex = 1
	)
	for _, c := range []struct {
		zone     string
		summer   int64
		winter   int64
		standard int64
	}{
		{"America/New_York", -4 * 3600, -5 * 3600, -5 * 3600},
		{"Europe/London", 3600, 0, 0},
		{"Australia/Lord_Howe", 10*3600 + 1800, 11 * 3600, 10*3600 + 1800},
	} {
		path := filepath.Join("/usr/share/zoneinfo", c.zone)
		if _, err := os.Stat(path); err != nil {
			continue
		}
		script := `const format = new Intl.DateTimeFormat("en-US", {` +
			` hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",` +
			` hour: "2-digit", minute: "2-digit", second: "2-digit" });` +
			`const offsetAt = (instant) => { const parts = {};` +
			` for (const { type, value } of format.formatToParts(instant)) parts[type] = value;` +
			` const local = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day),` +
			` Number(parts.hour) % 24, Number(parts.minute), Number(parts.second));` +
			` return (local - instant) / 1000; };` +
			`process.stdout.write(JSON.stringify(` + instantsJSON(t) + `.map(offsetAt)))`
		out, err := output(exec.Command(node, "-e", script), append(withoutTZ(), "TZ="+path))
		if err != nil {
			t.Fatalf("node with TZ=%s: %v: %s", path, err, out)
		}
		var v8 []int64
		if err := json.Unmarshal(out, &v8); err != nil {
			t.Fatalf("parse %s output %q: %v", node, out, err)
		}
		for index, offset := range v8 {
			if offset != c.standard {
				t.Errorf("V8 with TZ=%s reports %+d at %s, want the standard offset %+d; if V8 now honours the file, design.md's divergence note is stale", path, offset, time.UnixMilli(localInstants[index]).UTC().Format(time.RFC3339), c.standard)
			}
		}

		outFile := filepath.Join(t.TempDir(), "local.json")
		child := exec.Command(os.Args[0], "-test.run=^TestLocalChildWritesSnapshot$")
		out, err = output(child, append(withoutTZ(), "TZ="+path, localChildOut+"="+outFile))
		if err != nil {
			t.Fatalf("go child with TZ=%s: %v: %s", path, err, out)
		}
		raw, err := os.ReadFile(outFile)
		if err != nil {
			t.Fatalf("go child wrote no snapshot: %v", err)
		}
		var got struct {
			Zone    string  `json:"zone"`
			Offsets []int64 `json:"offsets"`
		}
		if err := json.Unmarshal(raw, &got); err != nil {
			t.Fatalf("parse go snapshot %q: %v", raw, err)
		}
		if got.Offsets[summerIndex] != c.summer || got.Offsets[winterIndex] != c.winter {
			t.Errorf("tz.Local with TZ=%s reports %+d/%+d in July/December, want %+d/%+d", path, got.Offsets[summerIndex], got.Offsets[winterIndex], c.summer, c.winter)
		}
	}
}
