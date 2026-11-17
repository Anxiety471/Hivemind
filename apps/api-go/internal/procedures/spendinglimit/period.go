package spendinglimit

import (
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
	_ "time/tzdata" // zone data even where the host has none
)

const dayMs = int64(86_400_000)

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
	loc := zoneOrUTC(zone)
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
	return time.UnixMilli(instantOfWallTime(first.UnixMilli(), loc)).UTC()
}

// zoneOffset is the zone's offset from UTC at instant, in ms (cron.ts zoneOffset).
func zoneOffset(instant int64, loc *time.Location) int64 {
	local := time.UnixMilli(instant).In(loc)
	_, offset := local.Zone()
	return int64(offset) * 1000
}

// wallTime is the zone's wall-clock reading of instant as a UTC-shaped timestamp.
func wallTime(instant int64, loc *time.Location) int64 {
	return instant + zoneOffset(instant, loc)
}

// instantOfWallTime ports cron.ts instantOfWallTime: a repeated reading is its
// first occurrence; a skipped one is the end of the gap.
func instantOfWallTime(wall int64, loc *time.Location) int64 {
	before := wall - zoneOffset(wall-dayMs, loc)
	after := wall - zoneOffset(wall+dayMs, loc)
	earlier, later := before, after
	if earlier > later {
		earlier, later = later, earlier
	}
	if wallTime(earlier, loc) == wall {
		return earlier
	}
	if wallTime(later, loc) == wall {
		return later
	}
	offsetBeforeGap := zoneOffset(earlier, loc)
	for later-earlier > 1 {
		middle := floorDiv(earlier+later, 2)
		if zoneOffset(middle, loc) == offsetBeforeGap {
			earlier = middle
		} else {
			later = middle
		}
	}
	return later
}

func floorDiv(a, b int64) int64 {
	q := a / b
	if (a%b != 0) && ((a < 0) != (b < 0)) {
		q--
	}
	return q
}

var (
	zoneMu    sync.Mutex
	zoneCache = map[string]*time.Location{}
)

// zoneOrUTC is validTimezoneOrUtc: an unknown name reads as UTC. Intl matches
// names case-insensitively, so a name Go does not know as written is looked up
// in the host's zoneinfo ignoring case before giving up.
func zoneOrUTC(name string) *time.Location {
	zoneMu.Lock()
	defer zoneMu.Unlock()
	if loc, ok := zoneCache[name]; ok {
		return loc
	}
	loc := loadZone(name)
	zoneCache[name] = loc
	return loc
}

func loadZone(name string) *time.Location {
	if name == "" || name == "Local" || strings.HasPrefix(name, "/") || strings.Contains(name, "..") {
		return time.UTC
	}
	if loc, err := time.LoadLocation(name); err == nil {
		return loc
	}
	root := "/usr/share/zoneinfo"
	var found string
	_ = filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
		if err != nil || found != "" {
			return nil
		}
		relative, rerr := filepath.Rel(root, path)
		if rerr != nil || entry.IsDir() {
			if entry != nil && entry.IsDir() && (entry.Name() == "posix" || entry.Name() == "right") {
				return filepath.SkipDir
			}
			return nil
		}
		if strings.EqualFold(relative, name) {
			found = relative
		}
		return nil
	})
	if found != "" {
		if _, err := os.Stat(filepath.Join(root, found)); err == nil {
			if loc, err := time.LoadLocation(found); err == nil {
				return loc
			}
		}
	}
	return time.UTC
}
