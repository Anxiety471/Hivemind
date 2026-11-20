package spendinglimit

import (
	"time"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/wallclock"
)

// periodStart ports spendingPeriodStart (packages/core/src/spending.ts:74-91):
// midnight today, Monday's midnight or the first of the month in the user's
// timezone, or startsAt for a limit that never resets.
func periodStart(period string, startsAt time.Time, timezone *string, now time.Time) time.Time {
	if period == "none" {
		return startsAt
	}
	zone := "UTC"
	if timezone != nil && *timezone != "" {
		zone = *timezone
	}
	loc := wallclock.ZoneOrUTC(zone)
	local := now.In(loc)
	year, month, day := local.Date()
	back := 0
	if period == "week" {
		back = (int(time.Date(year, month, day, 0, 0, 0, 0, time.UTC).Weekday()) + 6) % 7
	}
	var first time.Time
	if period == "month" {
		first = time.Date(year, month, 1, 0, 0, 0, 0, time.UTC)
	} else {
		first = time.Date(year, month, day-back, 0, 0, 0, 0, time.UTC)
	}
	return time.UnixMilli(wallclock.InstantOfWallTime(first.UnixMilli(), loc)).UTC()
}
