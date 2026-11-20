// Package cron evaluates routine schedules the way packages/core does.
//
// nextCronDate (packages/core/src/routines/schedule.ts:388) checks the field
// count itself, then asks croner 10.0.1 for the next match on a clock that
// never changes: croner's own zone conversion returns past times while clocks
// go back, so each match is placed in the routine's zone by instantOfWallTime
// and the search moves on when it lands at or before the starting instant.
// NextCronDate reproduces that, with NextCronDateAcross skipping one-shot and
// malformed schedules as nextCronDateAcross (:487) does.
package cron

import (
	"strings"
	"time"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/wallclock"
)

// onceRoutineCron is ONCE_ROUTINE_CRON.
const onceRoutineCron = "@once"

// IsOneShotRoutineCron is isOneShotRoutineCron.
func IsOneShotRoutineCron(expr string) bool { return strings.TrimSpace(expr) == onceRoutineCron }

// IsOneShotRoutineCrons is isOneShotRoutineCrons.
func IsOneShotRoutineCrons(crons []string) bool {
	return len(crons) == 1 && IsOneShotRoutineCron(crons[0])
}

// NextCronDate is nextCronDate: the next run strictly after from, or ok=false
// where the TypeScript throws (a malformed expression, a one-shot, or no run
// before croner's year 2999 limit). Only five fields are accepted, as
// TypeScript rejects anything else before croner sees it; nicknames such as
// "@daily" are therefore invalid too.
func NextCronDate(expr string, from time.Time, timezone string) (time.Time, bool) {
	if IsOneShotRoutineCron(expr) {
		return time.Time{}, false
	}
	if len(strings.Fields(strings.TrimSpace(expr))) != 5 {
		return time.Time{}, false
	}
	schedule, err := parsePattern(expr)
	if err != nil {
		return time.Time{}, false
	}
	zone := wallclock.ZoneOrUTC(timezone)
	fromMs := from.UnixMilli()
	wall := wallclock.WallTime(fromMs, zone)
	for {
		match, ok := schedule.next(time.UnixMilli(wall).UTC())
		if !ok {
			return time.Time{}, false
		}
		wall = match.UnixMilli()
		next := wallclock.InstantOfWallTime(wall, zone)
		// In the second pass of a repeated hour, the times left in it already ran in the first.
		if next > fromMs {
			return time.UnixMilli(next).UTC(), true
		}
	}
}

// NextCronDateAcross is nextCronDateAcross: the earliest next run among the
// recurring schedules, skipping one-shot and malformed ones. ok=false is the
// TypeScript null (no recurring schedule has a next run).
func NextCronDateAcross(crons []string, from time.Time, timezone string) (time.Time, bool) {
	var earliest time.Time
	found := false
	for _, expr := range crons {
		if IsOneShotRoutineCron(expr) {
			continue
		}
		next, ok := NextCronDate(expr, from, timezone)
		if !ok {
			continue
		}
		if !found || next.Before(earliest) {
			earliest = next
			found = true
		}
	}
	return earliest, found
}
