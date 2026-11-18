package pages

import (
	"encoding/base64"
	"encoding/json"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// cursor is the position after which a page of results continues.
type cursor struct {
	PinnedAt  *time.Time
	UpdatedAt time.Time
	ID        string
}

const isoMillis = "2006-01-02T15:04:05.000Z"

// encodeCursor is base64url(JSON.stringify({pinnedAt, updatedAt, id})) without padding.
func encodeCursor(pinnedAt *time.Time, updatedAt time.Time, id string) string {
	pinned := "null"
	if pinnedAt != nil {
		pinned = strconv.Quote(pinnedAt.UTC().Format(isoMillis))
	}
	idJSON, _ := json.Marshal(id)
	body := `{"pinnedAt":` + pinned + `,"updatedAt":"` + updatedAt.UTC().Format(isoMillis) + `","id":` + string(idJSON) + `}`
	return base64.RawURLEncoding.EncodeToString([]byte(body))
}

// decodeCursor is decodeCursor in pages.ts. ok is false where it throws
// PageListCursorError.
func decodeCursor(value string) (cursor, bool) {
	// A map, not a struct: JSON.parse matches keys exactly, encoding/json ignores case.
	var parsed map[string]json.RawMessage
	text := strings.ToValidUTF8(string(lenientBase64URL(value)), "\uFFFD")
	if err := json.Unmarshal([]byte(text), &parsed); err != nil {
		return cursor{}, false
	}
	var id string
	if len(parsed["id"]) == 0 || string(parsed["id"]) == "null" || json.Unmarshal(parsed["id"], &id) != nil {
		return cursor{}, false
	}
	var updatedText string
	if err := json.Unmarshal(parsed["updatedAt"], &updatedText); err != nil {
		return cursor{}, false
	}
	updated, ok := parseJSDate(updatedText)
	if !ok {
		return cursor{}, false
	}
	result := cursor{UpdatedAt: updated, ID: id}
	if string(parsed["pinnedAt"]) != "null" {
		var pinnedText string
		if err := json.Unmarshal(parsed["pinnedAt"], &pinnedText); err != nil {
			return cursor{}, false
		}
		pinned, ok := parseJSDate(pinnedText)
		if !ok {
			return cursor{}, false
		}
		result.PinnedAt = &pinned
	}
	return result, true
}

// lenientBase64URL is Buffer.from(value, "base64url"): characters outside both
// alphabets (and padding) are skipped, trailing bits are dropped.
func lenientBase64URL(value string) []byte {
	var out []byte
	var accumulator uint32
	var bits uint
	for index := 0; index < len(value); index++ {
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

var isoDate = regexp.MustCompile(`^([+-]\d{6}|\d{4})(?:-(\d{2})(?:-(\d{2}))?)?(?:[Tt ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|z|[+-]\d{2}:\d{2})?)?$`)

// parseJSDate is Date.parse for the ISO 8601 forms the server writes, with the
// ECMAScript rules: a date alone is UTC, a date-time without an offset is local
// time, 24:00:00 is the next midnight, fractions keep millisecond precision.
// Strings only the legacy parser reads (such as "May 1 2026") are not accepted.
func parseJSDate(text string) (time.Time, bool) {
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
	switch offset := match[8]; {
	case offset == "" && hasTime:
		location = time.Local
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
	return moment.UTC(), true
}
