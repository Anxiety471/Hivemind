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

func TestModeRetriesOnlyWhileTheFullPassIsNotDue(t *testing.T) {
	now := time.Now()
	lastRun := now.Add(-time.Hour)
	retryAt := now.Add(-time.Minute)
	setting := Settings{
		Enabled: true, IntervalMinutes: 360, LastRunAt: &lastRun,
		RetryAt: &retryAt, RetryAttempt: 1,
	}
	if got := mode(setting, now, false); got != modeRetry {
		t.Fatalf("mode = %v, want retry", got)
	}
	setting.LastRunAt = timePtr(now.Add(-7 * time.Hour))
	if got := mode(setting, now, false); got != modeFull {
		t.Fatalf("mode = %v, want full", got)
	}
	if got := mode(setting, now, true); got != modeFull {
		t.Fatalf("forced mode = %v, want full", got)
	}
	setting.Enabled = false
	if got := mode(setting, now, false); got != modeSkip {
		t.Fatalf("disabled mode = %v, want skip", got)
	}
}

func TestRetryTargetsKeepBotsAndSpacesApart(t *testing.T) {
	bots, spaces := retryTargets([]Failure{
		{Kind: "bot", ID: "b1"},
		{Kind: "shared", ID: "s1"},
		{Kind: "bot", ID: "b2"},
	})
	if !bots["b1"] || !bots["b2"] || len(bots) != 2 {
		t.Fatalf("bots = %v", bots)
	}
	if !spaces["s1"] || len(spaces) != 1 {
		t.Fatalf("spaces = %v", spaces)
	}
}

func TestRetryDelayIsBounded(t *testing.T) {
	if got := retryDelay(1); got != 15*time.Minute {
		t.Fatalf("first delay = %v", got)
	}
	if got := retryDelay(99); got != 4*time.Hour {
		t.Fatalf("last delay = %v", got)
	}
}

func TestFailureSummaryNamesBotsAndSharedMemory(t *testing.T) {
	if got := failureSummary([]Failure{{Kind: "bot"}, {Kind: "bot"}, {Kind: "shared"}}); got != "2 bots and shared memory failed" {
		t.Fatalf("summary = %q", got)
	}
	if got := failureSummary([]Failure{{Kind: "bot"}}); got != "1 bot failed" {
		t.Fatalf("summary = %q", got)
	}
	if got := failureSummary([]Failure{{Kind: "shared"}}); got != "Shared memory failed" {
		t.Fatalf("summary = %q", got)
	}
}

func TestSelectFailedBotsKeepsTheOriginalOrder(t *testing.T) {
	bots := []Bot{{ID: "b1"}, {ID: "b2"}, {ID: "b3"}}
	selected := selectFailedBots(bots, map[string]bool{"b3": true, "b1": true})
	if len(selected) != 2 || selected[0].ID != "b1" || selected[1].ID != "b3" {
		t.Fatalf("selected = %+v", selected)
	}
}

func timePtr(value time.Time) *time.Time { return &value }
