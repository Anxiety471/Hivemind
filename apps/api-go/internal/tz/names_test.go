package tz_test

import (
	"encoding/json"
	"os/exec"
	"testing"
	"time"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/tz"
)

// icuAliases is the reviewer's enumeration of the zone ids production Node's
// ICU accepts and IANA tzdata 2026e does not carry. genzones derives each one's
// canonical zone from the runtime and verifies the offsets, then installs a copy
// under the id; this table pins that result without needing node.
var icuAliases = map[string]string{
	"ACT": "Australia/Darwin", "AET": "Australia/Sydney", "AGT": "America/Buenos_Aires",
	"ART": "Africa/Cairo", "AST": "America/Anchorage", "BET": "America/Sao_Paulo",
	"BST": "Asia/Dhaka", "CAT": "Africa/Maputo", "CNT": "America/St_Johns",
	"CST": "America/Chicago", "CTT": "Asia/Shanghai", "EAT": "Africa/Nairobi",
	"ECT": "Europe/Paris", "IET": "America/Indianapolis", "IST": "Asia/Calcutta",
	"JST": "Asia/Tokyo", "MIT": "Pacific/Apia", "NET": "Asia/Yerevan",
	"NST": "Pacific/Auckland", "PLT": "Asia/Karachi", "PNT": "America/Phoenix",
	"PRT": "America/Puerto_Rico", "PST": "America/Los_Angeles", "SST": "Pacific/Guadalcanal",
	"VST": "Asia/Saigon", "US/Pacific-New": "America/Los_Angeles",
	"Canada/East-Saskatchewan": "America/Regina",
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
	for alias, canonical := range icuAliases {
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
	script := `const ours = JSON.parse(process.argv[1]);` +
		`const supported = Intl.supportedValuesOf("timeZone");` +
		`const rejected = ours.filter((name) => { try { new Intl.DateTimeFormat("en-US", { timeZone: name }); return false; } catch { return true; } });` +
		`process.stdout.write(JSON.stringify({ supported, rejected }));`
	out, err := exec.Command(node, "-e", script, string(encoded)).Output()
	if err != nil {
		t.Fatalf("run %s: %v", node, err)
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
	for alias := range icuAliases {
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
	t.Logf("%d zip names cover %d Intl names plus %d ICU-only ids; %d not an Intl zone",
		len(names), len(result.Supported), len(icuAliases), len(result.Rejected))
}
