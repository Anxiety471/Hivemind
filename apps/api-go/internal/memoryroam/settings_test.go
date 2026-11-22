package memoryroam

import (
	"testing"
	"time"
)

func TestDueFollowsTheOwnersSwitchAndInterval(t *testing.T) {
	now := time.Now()
	hourAgo := now.Add(-time.Hour)
	sevenHoursAgo := now.Add(-7 * time.Hour)
	cases := []struct {
		name     string
		settings Settings
		want     bool
	}{
		{"disabled", Settings{Enabled: false}, false},
		{"never run", Settings{Enabled: true, IntervalMinutes: 360}, true},
		{"inside the interval", Settings{Enabled: true, IntervalMinutes: 360, LastRunAt: &hourAgo}, false},
		{"past the interval", Settings{Enabled: true, IntervalMinutes: 360, LastRunAt: &sevenHoursAgo}, true},
		{"zero means six hours", Settings{Enabled: true, IntervalMinutes: 0, LastRunAt: &sevenHoursAgo}, true},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			if got := due(testCase.settings, now); got != testCase.want {
				t.Fatalf("due = %v, want %v", got, testCase.want)
			}
		})
	}
}

func TestSkipReasonNamesTheGate(t *testing.T) {
	now := time.Now()
	twoHoursAgo := now.Add(-2 * time.Hour)
	if got := skipReason(false, Settings{}, now); got != "disabled" {
		t.Fatalf("missing row = %q", got)
	}
	if got := skipReason(true, Settings{Enabled: false}, now); got != "disabled" {
		t.Fatalf("disabled = %q", got)
	}
	if got := skipReason(true, Settings{Enabled: true, IntervalMinutes: 360, LastRunAt: &twoHoursAgo}, now); got != "not-due" {
		t.Fatalf("not due = %q", got)
	}
}
