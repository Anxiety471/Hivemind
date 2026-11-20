package events

import (
	"sort"
	"unicode/utf16"
	"unicode/utf8"
)

// SanitizeJSON is sanitizeJsonValue (packages/core/src/events.ts:772-803):
// every string leaf and key has NUL and unpaired UTF-16 surrogates replaced
// with U+FFFD, because Postgres rejects them as JSON, and a key that collides
// after replacement gets a deterministic "#n" suffix.
//
// Go strings reach json.Decode already repaired to U+FFFD, so the surrogate
// pass only catches invalid UTF-8 a caller constructed directly. Keys are
// walked in sorted order: a TypeScript object keeps insertion order, and the
// two orders can only differ which of two colliding keys keeps the bare name.
func SanitizeJSON(value any) any {
	switch typed := value.(type) {
	case string:
		return sanitizeUTF16ForJSON(typed)
	case []any:
		out := make([]any, len(typed))
		for index, item := range typed {
			out[index] = SanitizeJSON(item)
		}
		return out
	case map[string]any:
		out := make(map[string]any, len(typed))
		keys := make([]string, 0, len(typed))
		for key := range typed {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		used := make(map[string]int, len(keys))
		for _, key := range keys {
			safeKey := sanitizeUTF16ForJSON(key)
			seen := used[safeKey]
			used[safeKey] = seen + 1
			if seen > 0 {
				safeKey = safeKey + "#" + itoa(seen+1)
			}
			out[safeKey] = SanitizeJSON(typed[key])
		}
		return out
	}
	return value
}

// sanitizeUTF16ForJSON is sanitizeUtf16ForJson: replace NUL, a high surrogate
// without a low after it, and a low surrogate without a high before it, each
// with U+FFFD, per UTF-16 code unit.
func sanitizeUTF16ForJSON(value string) string {
	units := utf16.Encode([]rune(value))
	needsWork := !utf8.ValidString(value)
	for _, unit := range units {
		if unit == 0 || (unit >= 0xD800 && unit <= 0xDFFF) {
			needsWork = true
			break
		}
	}
	if !needsWork {
		return value
	}
	out := make([]uint16, 0, len(units))
	for index := 0; index < len(units); index++ {
		unit := units[index]
		switch {
		case unit == 0:
			out = append(out, 0xFFFD)
		case unit >= 0xD800 && unit <= 0xDBFF:
			if index+1 < len(units) && units[index+1] >= 0xDC00 && units[index+1] <= 0xDFFF {
				out = append(out, unit, units[index+1])
				index++
			} else {
				out = append(out, 0xFFFD)
			}
		case unit >= 0xDC00 && unit <= 0xDFFF:
			out = append(out, 0xFFFD)
		default:
			out = append(out, unit)
		}
	}
	return string(utf16.Decode(out))
}

// itoa avoids importing strconv for one non-negative int.
func itoa(value int) string {
	if value == 0 {
		return "0"
	}
	var digits [20]byte
	at := len(digits)
	for value > 0 {
		at--
		digits[at] = byte('0' + value%10)
		value /= 10
	}
	return string(digits[at:])
}
