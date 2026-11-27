// Package wallclock converts between instants and a zone's wall-clock reading,
// as packages/core/src/primitives/time.ts does through Intl and CronDate. The
// zone rules come from internal/tz, the tzdata release production Node carries,
// so a host tzdata upgrade cannot move a billing boundary.
package wallclock

import (
	"sync"
	"time"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/tz"
)

// DayMS is DAY_MS (packages/core/src/primitives/time.ts).
const DayMS = int64(86_400_000)

// ZoneOffset is zoneOffset: the zone's offset from UTC at instant, in ms.
func ZoneOffset(instant int64, loc *time.Location) int64 {
	local := time.UnixMilli(instant).In(loc)
	_, offset := local.Zone()
	return int64(offset) * 1000
}

// WallTime is wallTime: the zone's wall-clock reading of instant, as the UTC
// timestamp that shows the same fields.
func WallTime(instant int64, loc *time.Location) int64 {
	return instant + ZoneOffset(instant, loc)
}

// InstantOfWallTime is instantOfWallTime: the instant the zone shows a
// wall-clock reading. A reading that clocks going back repeat is its first
// occurrence; one that clocks going forward skip is the end of the gap.
func InstantOfWallTime(wall int64, loc *time.Location) int64 {
	// A day either side is beyond any clock change that could affect this reading.
	before := wall - ZoneOffset(wall-DayMS, loc)
	after := wall - ZoneOffset(wall+DayMS, loc)
	earlier, later := before, after
	if earlier > later {
		earlier, later = later, earlier
	}
	if WallTime(earlier, loc) == wall {
		return earlier
	}
	if WallTime(later, loc) == wall {
		return later
	}
	offsetBeforeGap := ZoneOffset(earlier, loc)
	for later-earlier > 1 {
		middle := earlier + (later-earlier)/2
		if ZoneOffset(middle, loc) == offsetBeforeGap {
			earlier = middle
		} else {
			later = middle
		}
	}
	return later
}

var (
	zoneMu    sync.Mutex
	zoneCache = map[string]*time.Location{}
)

// ZoneOrUTC is validTimezoneOrUtc: an unknown name reads as UTC. Intl accepts
// names case-insensitively and fixed offsets such as "+05:30", so both are
// resolved here before giving up.
func ZoneOrUTC(name string) *time.Location {
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
	if offset, ok := fixedOffset(name); ok {
		return time.FixedZone(name, offset)
	}
	// Intl throws on a name it does not know, and validTimezoneOrUtc reads that
	// as UTC; "" and "Local" are not zones here either.
	if location, err := tz.Load(name); err == nil {
		return location
	}
	return time.UTC
}

// fixedOffset reads the offset zones Intl also accepts: "+05", "+0500" and
// "+05:30".
func fixedOffset(name string) (int, bool) {
	if len(name) < 3 || (name[0] != '+' && name[0] != '-') {
		return 0, false
	}
	digits := name[1:]
	var clock, minute string
	switch {
	case len(digits) == 2:
		clock = digits
	case len(digits) == 4:
		clock, minute = digits[:2], digits[2:]
	case len(digits) == 5 && digits[2] == ':':
		clock, minute = digits[:2], digits[3:]
	default:
		return 0, false
	}
	if !allDigits(clock) || (minute != "" && !allDigits(minute)) {
		return 0, false
	}
	hours := int(clock[0]-'0')*10 + int(clock[1]-'0')
	minutes := 0
	if minute != "" {
		minutes = int(minute[0]-'0')*10 + int(minute[1]-'0')
	}
	if hours > 23 || minutes > 59 {
		return 0, false
	}
	offset := hours*3600 + minutes*60
	if name[0] == '-' {
		offset = -offset
	}
	return offset, true
}

func allDigits(text string) bool {
	for _, r := range text {
		if r < '0' || r > '9' {
			return false
		}
	}
	return len(text) > 0
}
