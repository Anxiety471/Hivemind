package tz_test

import (
	"encoding/json"
	"os/exec"
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

// TestICUZonesWithoutIANAFile records the non-alias residue of discovery: ids
// production Node's ICU accepts as zones of its own (resolvedOptions returns
// the id itself), with no IANA file to embed. tz.Load reads them as UTC; the
// list is generated, so a regeneration that changes it shows up in the diff.
func TestICUZonesWithoutIANAFile(t *testing.T) {
	if len(tz.ICUZonesWithoutIANAFile) == 0 {
		t.Skip("the discovered ICU ids are all aliases of IANA zones")
	}
	node := provenanceNode(t)
	encoded, err := json.Marshal(tz.ICUZonesWithoutIANAFile)
	if err != nil {
		t.Fatal(err)
	}
	script := `const ids = JSON.parse(process.argv[1]);` +
		`process.stdout.write(JSON.stringify(ids.map((id) => {` +
		` try { const canonical = new Intl.DateTimeFormat("en-US", { timeZone: id }).resolvedOptions().timeZone; return [id, canonical, canonical === id]; }` +
		` catch { return [id, null, false]; } })));`
	out, err := exec.Command(node, "-e", script, string(encoded)).Output()
	if err != nil {
		t.Fatalf("run %s: %v", node, err)
	}
	var result [][3]any
	if err := json.Unmarshal(out, &result); err != nil {
		t.Fatalf("parse %s output: %v", node, err)
	}
	for _, row := range result {
		id, _ := row[0].(string)
		canonical, _ := row[1].(string)
		selfNamed, _ := row[2].(bool)
		if canonical == "" {
			t.Errorf("ICU no longer accepts %q: regenerate the embedded release with go generate ./internal/tz", id)
			continue
		}
		if !selfNamed {
			t.Errorf("ICU now resolves %q to %q, so it can be installed as an alias: regenerate with go generate ./internal/tz", id, canonical)
		}
		if tz.Has(id) {
			t.Errorf("%q is in the zip but listed as having no IANA file", id)
		}
		if _, err := tz.Load(id); err == nil {
			t.Errorf("tz.Load(%q) succeeded, but the discovery recorded it as having no IANA file", id)
		}
	}
	t.Logf("%d ICU ids have no IANA file and read as UTC: %v", len(result), tz.ICUZonesWithoutIANAFile)
}
