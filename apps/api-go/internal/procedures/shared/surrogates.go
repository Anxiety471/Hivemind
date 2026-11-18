package shared

import (
	"encoding/json"
	"strconv"
	"strings"
	"unicode/utf16"
	"unicode/utf8"
)

// Go decodes a JSON string's unpaired surrogate escape (`"\ud800"`) as U+FFFD, since a Go string
// holds no lone surrogate, while JavaScript keeps the code unit and writes it back as `\ud800`. A
// procedure that echoes what it was sent (and stores the text with the U+FFFD the API's Prisma
// client gives it) answers with that code unit. EchoText rebuilds the echo from the request body.

// EchoText returns the JSON text JavaScript writes for the string field `key` of the request once
// the handler has trimmed it, and true, when the field holds an unpaired surrogate. Otherwise it
// returns false and the decoded string is already exact.
func EchoText(request json.RawMessage, key string) (json.RawMessage, bool) {
	var fields map[string]json.RawMessage
	if json.Unmarshal(request, &fields) != nil {
		return nil, false
	}
	literal, present := fields[key]
	if !present {
		return nil, false
	}
	units, ok := jsonStringUnits(literal)
	if !ok || !hasLoneSurrogate(units) {
		return nil, false
	}
	return json.RawMessage(encodeUnits(trimUnits(units))), true
}

// jsonStringUnits decodes a JSON string literal to UTF-16 code units, keeping unpaired surrogates.
func jsonStringUnits(literal []byte) ([]uint16, bool) {
	if len(literal) < 2 || literal[0] != '"' || literal[len(literal)-1] != '"' {
		return nil, false
	}
	body := literal[1 : len(literal)-1]
	units := make([]uint16, 0, len(body))
	for index := 0; index < len(body); {
		if body[index] != '\\' {
			character, size := utf8.DecodeRune(body[index:])
			units = utf16.AppendRune(units, character)
			index += size
			continue
		}
		if index+1 >= len(body) {
			return nil, false
		}
		switch body[index+1] {
		case '"', '\\', '/':
			units = append(units, uint16(body[index+1]))
		case 'b':
			units = append(units, '\b')
		case 'f':
			units = append(units, '\f')
		case 'n':
			units = append(units, '\n')
		case 'r':
			units = append(units, '\r')
		case 't':
			units = append(units, '\t')
		case 'u':
			if index+6 > len(body) {
				return nil, false
			}
			value, err := strconv.ParseUint(string(body[index+2:index+6]), 16, 16)
			if err != nil {
				return nil, false
			}
			units = append(units, uint16(value))
			index += 6
			continue
		default:
			return nil, false
		}
		index += 2
	}
	return units, true
}

func hasLoneSurrogate(units []uint16) bool {
	for index := 0; index < len(units); index++ {
		switch {
		case utf16.IsSurrogate(rune(units[index])) && units[index] >= 0xDC00:
			return true
		case utf16.IsSurrogate(rune(units[index])):
			if index+1 >= len(units) || units[index+1] < 0xDC00 || units[index+1] > 0xDFFF {
				return true
			}
			index++
		}
	}
	return false
}

// trimUnits is String.prototype.trim on code units.
func trimUnits(units []uint16) []uint16 {
	space := func(unit uint16) bool {
		switch unit {
		case '\t', '\n', '\v', '\f', '\r', ' ', 0xA0, 0x1680, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF:
			return true
		}
		return unit >= 0x2000 && unit <= 0x200A
	}
	start, end := 0, len(units)
	for start < end && space(units[start]) {
		start++
	}
	for end > start && space(units[end-1]) {
		end--
	}
	return units[start:end]
}

// encodeUnits is JSON.stringify of a string: well-formed output, so an unpaired surrogate is
// written as a lower-case `\udXXX` escape and everything else as the character itself.
func encodeUnits(units []uint16) string {
	var out strings.Builder
	out.WriteByte('"')
	for index := 0; index < len(units); index++ {
		unit := units[index]
		switch {
		case unit == '"':
			out.WriteString(`\"`)
		case unit == '\\':
			out.WriteString(`\\`)
		case unit == '\b':
			out.WriteString(`\b`)
		case unit == '\f':
			out.WriteString(`\f`)
		case unit == '\n':
			out.WriteString(`\n`)
		case unit == '\r':
			out.WriteString(`\r`)
		case unit == '\t':
			out.WriteString(`\t`)
		case unit < 0x20:
			out.WriteString(`\u00` + string("0123456789abcdef"[unit>>4]) + string("0123456789abcdef"[unit&0xf]))
		case unit >= 0xD800 && unit <= 0xDBFF && index+1 < len(units) && units[index+1] >= 0xDC00 && units[index+1] <= 0xDFFF:
			out.WriteRune(utf16.DecodeRune(rune(unit), rune(units[index+1])))
			index++
		case unit >= 0xD800 && unit <= 0xDFFF:
			out.WriteString(`\u` + strconv.FormatUint(uint64(unit), 16))
		default:
			out.WriteRune(rune(unit))
		}
	}
	out.WriteByte('"')
	return out.String()
}
