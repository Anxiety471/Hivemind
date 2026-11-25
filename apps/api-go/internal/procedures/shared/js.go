package shared

import (
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/tz"
)

// Base64URL is Buffer.from(value, "base64url"): characters outside both
// alphabets (and padding) are skipped, trailing bits are dropped.
func Base64URL(value string) []byte {
	var out []byte
	var accumulator uint32
	var bits uint
	for index := range len(value) {
		var sextet uint32
		switch character := value[index]; {
		case character >= 'A' && character <= 'Z':
			sextet = uint32(character - 'A')
		case character >= 'a' && character <= 'z':
			sextet = uint32(character-'a') + 26
		case character >= '0' && character <= '9':
			sextet = uint32(character-'0') + 52
		case character == '+' || character == '-':
			sextet = 62
		case character == '/' || character == '_':
			sextet = 63
		default:
			continue
		}
		accumulator = accumulator<<6 | sextet
		bits += 6
		if bits >= 8 {
			bits -= 8
			out = append(out, byte(accumulator>>bits))
			accumulator &= (1 << bits) - 1
		}
	}
	return out
}

// UTF8 is buffer.toString("utf8"): the WHATWG decoder, which writes one U+FFFD for each
// maximal subpart of an ill-formed sequence (strings.ToValidUTF8 writes one per run).
func UTF8(data []byte) string {
	if utf8.Valid(data) {
		return string(data)
	}
	var out strings.Builder
	for index := 0; index < len(data); {
		if r, size := utf8.DecodeRune(data[index:]); r != utf8.RuneError || size > 1 {
			out.Write(data[index : index+size])
			index += size
			continue
		}
		index += maximalSubpart(data[index:])
		out.WriteString("\uFFFD")
	}
	return out.String()
}

// maximalSubpart is the length of the longest prefix of data that could begin a well-formed
// sequence (at least one byte), as the WHATWG decoder consumes it before one replacement.
func maximalSubpart(data []byte) int {
	first := data[0]
	var need int
	lower, upper := byte(0x80), byte(0xBF)
	switch {
	case first >= 0xC2 && first <= 0xDF:
		need = 1
	case first >= 0xE0 && first <= 0xEF:
		need = 2
		if first == 0xE0 {
			lower = 0xA0
		}
		if first == 0xED {
			upper = 0x9F
		}
	case first >= 0xF0 && first <= 0xF4:
		need = 3
		if first == 0xF0 {
			lower = 0x90
		}
		if first == 0xF4 {
			upper = 0x8F
		}
	default:
		return 1
	}
	size := 1
	for ; size <= need && size < len(data); size++ {
		next := data[size]
		if next < lower || next > upper {
			break
		}
		lower, upper = 0x80, 0xBF
	}
	return size
}

var isoDate = regexp.MustCompile(`^([+-]\d{6}|\d{4})(?:-(\d{2})(?:-(\d{2}))?)?(?:[Tt ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|z|[+-]\d{2}:\d{2})?)?$`)

// ParseDate is Date.parse for the ISO 8601 forms the server writes, with the
// ECMAScript rules: a date alone is UTC, a date-time without an offset is local
// time, 24:00:00 is the next midnight, fractions keep millisecond precision.
// Strings only the legacy parser reads (such as "May 1 2026") are not accepted.
func ParseDate(text string) (time.Time, bool) {
	match := isoDate.FindStringSubmatch(text)
	if match == nil {
		return time.Time{}, false
	}
	number := func(index int, fallback int) int {
		if match[index] == "" {
			return fallback
		}
		value, _ := strconv.Atoi(match[index])
		return value
	}
	year, _ := strconv.Atoi(strings.TrimPrefix(match[1], "+"))
	if match[1] == "-000000" {
		return time.Time{}, false
	}
	month, day := number(2, 1), number(3, 1)
	hour, minute, second := number(4, 0), number(5, 0), number(6, 0)
	if month < 1 || month > 12 || day < 1 || day > 31 || minute > 59 || second > 59 || hour > 24 {
		return time.Time{}, false
	}
	if hour == 24 && (minute != 0 || second != 0 || (match[7] != "" && strings.Trim(match[7], "0") != "")) {
		return time.Time{}, false
	}
	// V8 checks the day only against 1..31; a day past the month's end rolls into the next month.
	nanos := 0
	if fraction := match[7]; fraction != "" {
		if len(fraction) > 3 {
			fraction = fraction[:3]
		}
		milliseconds, _ := strconv.Atoi((fraction + "00")[:3])
		nanos = milliseconds * int(time.Millisecond)
	}
	location := time.UTC
	hasTime := match[4] != ""
	localTime := false
	switch offset := match[8]; {
	case offset == "" && hasTime:
		// V8 reads a datetime without an offset in the process zone; its rules
		// come from the embedded tzdata release, never the host's.
		localTime = true
	case offset == "" || offset == "Z" || offset == "z":
	default:
		sign := 1
		if offset[0] == '-' {
			sign = -1
		}
		hours, _ := strconv.Atoi(offset[1:3])
		minutes, _ := strconv.Atoi(offset[4:6])
		if hours > 23 || minutes > 59 {
			return time.Time{}, false
		}
		location = time.FixedZone("", sign*(hours*3600+minutes*60))
	}
	moment := time.Date(year, time.Month(month), day, hour, minute, second, nanos, location)
	if localTime {
		// ECMAScript reads a wall time with the zone offset in effect at the
		// instant whose UTC clock shows the same fields: a time the clocks skip
		// moves forward by the gap, and one they repeat is its first occurrence.
		// time.Date's own gap choice is the other one, so parse the fields as
		// UTC and subtract that offset.
		wall := time.Date(year, time.Month(month), day, hour, minute, second, nanos, time.UTC)
		_, seconds := wall.In(tz.Local()).Zone()
		moment = time.UnixMilli(wall.UnixMilli() - int64(seconds)*1000)
	}
	// ECMAScript TimeClip: a Date more than 8.64e15 ms from the epoch is Invalid Date,
	// so Date.parse rejects it (e.g. +275760-09-13T00:00:00.001Z).
	if milliseconds := moment.UnixMilli(); milliseconds > maxTimeClip || milliseconds < -maxTimeClip {
		return time.Time{}, false
	}
	return moment.UTC(), true
}

// maxTimeClip is the ECMAScript maximum absolute time value, in milliseconds.
const maxTimeClip = 8_640_000_000_000_000

// ISOString is Date.prototype.toISOString for a UTC instant, including the signed six-digit
// year it writes outside 0000..9999.
func ISOString(at time.Time) string {
	at = at.UTC()
	year := at.Year()
	if year >= 0 && year <= 9999 {
		return at.Format(ISOMillis)
	}
	sign := "+"
	if year < 0 {
		sign, year = "-", -year
	}
	return sign + leftPad(strconv.Itoa(year), 6) + at.Format("-01-02T15:04:05.000Z")
}

func leftPad(text string, width int) string {
	if len(text) >= width {
		return text
	}
	return strings.Repeat("0", width-len(text)) + text
}
