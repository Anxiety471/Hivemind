package wallclock

import (
	"testing"
	"time"
)

// TestZoneOrUTC pins the resolver wallclock now uses: exact and
// case-insensitive zone ids, the ICU aliases, fixed offsets, and UTC for
// everything Intl rejects. Offsets are for 2026-07-15 and 2026-12-06.
func TestZoneOrUTC(t *testing.T) {
	const (
		summer = "2026-07-15T12:00:00Z"
		winter = "2026-12-06T12:00:00Z"
	)
	for _, c := range []struct {
		name   string
		summer int
		winter int
	}{
		{"America/Havana", -4 * 3600, -5 * 3600},
		{"america/havana", -4 * 3600, -5 * 3600},
		{"AMERICA/HAVANA", -4 * 3600, -5 * 3600},
		{"Asia/Kathmandu", 5*3600 + 45*60, 5*3600 + 45*60},
		{"Asia/Calcutta", 5*3600 + 30*60, 5*3600 + 30*60},
		{"US/Pacific", -7 * 3600, -8 * 3600},
		{"Etc/GMT+5", -5 * 3600, -5 * 3600},
		{"UTC", 0, 0},
		{"GMT", 0, 0},
		{"Factory", 0, 0},
		// The ICU ids P2-1 added, resolved exactly as Intl resolves them.
		{"PST", -7 * 3600, -8 * 3600},
		{"ACT", 9*3600 + 30*60, 9*3600 + 30*60},
		{"US/Pacific-New", -7 * 3600, -8 * 3600},
		{"Canada/East-Saskatchewan", -6 * 3600, -6 * 3600},
		// The SystemV ids ICU implements itself: synthesized from ICU's
		// offsets, so the gateway computes the same boundaries as Intl.
		{"SystemV/AST4", -4 * 3600, -4 * 3600},
		{"SystemV/AST4ADT", -3 * 3600, -4 * 3600},
		{"systemv/ast4adt", -3 * 3600, -4 * 3600},
		{"SystemV/CST6", -6 * 3600, -6 * 3600},
		{"SystemV/CST6CDT", -5 * 3600, -6 * 3600},
		{"SystemV/EST5", -5 * 3600, -5 * 3600},
		{"SystemV/EST5EDT", -4 * 3600, -5 * 3600},
		{"SystemV/HST10", -10 * 3600, -10 * 3600},
		{"SystemV/MST7", -7 * 3600, -7 * 3600},
		{"SystemV/MST7MDT", -6 * 3600, -7 * 3600},
		{"SystemV/PST8", -8 * 3600, -8 * 3600},
		{"SystemV/PST8PDT", -7 * 3600, -8 * 3600},
		{"SystemV/YST9", -9 * 3600, -9 * 3600},
		{"SystemV/YST9YDT", -8 * 3600, -9 * 3600},
		// The legacy links Intl resolves normally (only V8's default zone
		// reads them as UTC).
		{"Cuba", -4 * 3600, -5 * 3600},
		{"Iran", 3*3600 + 30*60, 3*3600 + 30*60},
		{"PRC", 8 * 3600, 8 * 3600},
		// Intl rejects these, so validTimezoneOrUtc reads them as UTC.
		{"", 0, 0},
		{"Local", 0, 0},
		{"No/Such_Zone", 0, 0},
		{"+24", 0, 0},
		// Intl accepts a fixed offset as a zone.
		{"+05:30", 5*3600 + 30*60, 5*3600 + 30*60},
		{"+0545", 5*3600 + 45*60, 5*3600 + 45*60},
		{"-03", -3 * 3600, -3 * 3600},
	} {
		location := ZoneOrUTC(c.name)
		for at, want := range map[string]int{summer: c.summer, winter: c.winter} {
			instant, err := time.Parse(time.RFC3339, at)
			if err != nil {
				t.Fatal(err)
			}
			if _, offset := instant.In(location).Zone(); offset != want {
				t.Errorf("%q at %s: offset %+d, want %+d", c.name, at, offset, want)
			}
		}
	}
}
