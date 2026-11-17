package spendinglimit

import (
	"encoding/json"
	"os"
	"testing"
	"time"
)

// The golden file is recorded from the TypeScript spendingPeriodStart by
// tools/period-golden.mts: random instants in 20 zones plus hourly sweeps over
// midnight gaps and overlaps.
func TestPeriodStartMatchesTypeScript(t *testing.T) {
	raw, err := os.ReadFile("testdata/period_golden.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases [][4]any
	if err := json.Unmarshal(raw, &cases); err != nil {
		t.Fatal(err)
	}
	startsAt := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	failures := 0
	for _, c := range cases {
		zone, period := c[0].(string), c[1].(string)
		now, want := int64(c[2].(float64)), int64(c[3].(float64))
		got := periodStart(period, startsAt, &zone, time.UnixMilli(now)).UnixMilli()
		if got != want {
			failures++
			if failures <= 10 {
				t.Errorf("%s %s now=%s: got %s want %s", zone, period,
					time.UnixMilli(now).UTC().Format(time.RFC3339),
					time.UnixMilli(got).UTC().Format(time.RFC3339), time.UnixMilli(want).UTC().Format(time.RFC3339))
			}
		}
	}
	if failures > 0 {
		t.Fatalf("%d of %d cases differ", failures, len(cases))
	}
	t.Logf("%d cases match", len(cases))
}

func TestPeriodStartNoneAndDefaultZone(t *testing.T) {
	startsAt := time.Date(2026, 3, 4, 5, 6, 7, 0, time.UTC)
	now := time.Date(2026, 6, 15, 10, 0, 0, 0, time.UTC)
	if got := periodStart("none", startsAt, nil, now); !got.Equal(startsAt) {
		t.Errorf("none = %v", got)
	}
	empty := ""
	if got := periodStart("day", startsAt, &empty, now); !got.Equal(time.Date(2026, 6, 15, 0, 0, 0, 0, time.UTC)) {
		t.Errorf("empty zone = %v", got)
	}
}
