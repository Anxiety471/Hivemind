package tz_test

import (
	"testing"
	"time"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/tz"
)

func offsetAt(t *testing.T, location *time.Location, text string) int64 {
	t.Helper()
	instant, err := time.Parse(time.RFC3339, text)
	if err != nil {
		t.Fatal(err)
	}
	return goOffset(t, location, instant.UnixMilli())
}

// TestLoadPinnedZoneRules checks the rule that separates the embedded release
// from the host's tzdata: tzdata 2026f moved Cuba's DST end to 2027-11-07,
// 2026e (production Node) ends it on 2026-11-01.
func TestLoadPinnedZoneRules(t *testing.T) {
	havana, err := tz.Load("America/Havana")
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range []struct {
		at   string
		want int64
	}{
		{"2026-10-31T04:59:59Z", -4 * 3600},
		{"2026-11-01T05:00:00Z", -5 * 3600},
		{"2026-11-10T07:46:43Z", -5 * 3600},
		{"2027-03-14T05:00:00Z", -4 * 3600},
	} {
		if got := offsetAt(t, havana, c.at); got != c.want {
			t.Errorf("America/Havana at %s: %+d, want %+d", c.at, got, c.want)
		}
	}

	// A few shapes the period math also depends on: a half-hour zone, a
	// southern-hemisphere change, an alias and the extreme offsets.
	for _, c := range []struct {
		zone string
		at   string
		want int64
	}{
		{"Asia/Kathmandu", "2026-06-15T00:00:00Z", 5*3600 + 45*60},
		{"America/St_Johns", "2026-01-15T00:00:00Z", -(3*3600 + 30*60)},
		{"Pacific/Kiritimati", "2026-06-15T00:00:00Z", 14 * 3600},
		{"Pacific/Chatham", "2026-06-15T00:00:00Z", 12*3600 + 45*60},
		{"Asia/Calcutta", "2026-06-15T00:00:00Z", 5*3600 + 30*60},
		{"US/Pacific", "2026-07-15T00:00:00Z", -7 * 3600},
		{"Etc/GMT+5", "2026-06-15T00:00:00Z", -5 * 3600},
		{"UTC", "2026-06-15T00:00:00Z", 0},
	} {
		location, err := tz.Load(c.zone)
		if err != nil {
			t.Errorf("load %q: %v", c.zone, err)
			continue
		}
		if got := offsetAt(t, location, c.at); got != c.want {
			t.Errorf("%s at %s: %+d, want %+d", c.zone, c.at, got, c.want)
		}
	}
}

func TestLoadIsCaseInsensitiveAndRefusesEscapes(t *testing.T) {
	want, err := tz.Load("America/Havana")
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"america/havana", "AMERICA/HAVANA", "America/havana"} {
		location, err := tz.Load(name)
		if err != nil {
			t.Errorf("load %q: %v", name, err)
			continue
		}
		if location.String() != want.String() {
			t.Errorf("load %q = %q, want %q", name, location.String(), want.String())
		}
	}
	for _, name := range []string{"", "Local", "/etc/passwd", "../etc/passwd", "America/../../etc/passwd", `America\Havana`, "No/Such_Zone", "UTC0"} {
		if _, err := tz.Load(name); err == nil {
			t.Errorf("load %q succeeded, want an error", name)
		}
		if tz.Has(name) {
			t.Errorf("Has(%q) = true, want false", name)
		}
	}
	if !tz.Has("america/havana") {
		t.Error("Has(america/havana) = false")
	}
}

func TestNamesCoverTheRelease(t *testing.T) {
	names := tz.Names()
	if len(names) != tz.ZoneCount {
		t.Fatalf("%d names, tzdata_gen.go pins %d", len(names), tz.ZoneCount)
	}
	for i := 1; i < len(names); i++ {
		if names[i-1] >= names[i] {
			t.Fatalf("names are not sorted: %q then %q", names[i-1], names[i])
		}
	}
	for _, name := range []string{"America/Havana", "Asia/Calcutta", "US/Pacific", "Etc/GMT+5", "GMT", "UTC"} {
		if !tz.Has(name) {
			t.Errorf("release lacks %q", name)
		}
	}
}
