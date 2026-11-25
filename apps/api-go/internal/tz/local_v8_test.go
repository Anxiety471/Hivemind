package tz_test

import (
	"bytes"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
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
	script := `process.stdout.write(JSON.stringify(` +
		`{zone: Intl.DateTimeFormat().resolvedOptions().timeZone ?? null, ` +
		`offsets: ` + instantsJSON(t) + `.map(t => -new Date(t).getTimezoneOffset()*60)}))`
	// V8's TZ=<path> and TZ=localtime lose a zone's historical DST: with the
	// Manila TZif it reads +08:00 at 1990-07-15 where ICU's own Asia/Manila
	// reads +09:00. Go parses the file faithfully, so those forms are compared
	// only from 2026 on; production does not set TZ at all.
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
