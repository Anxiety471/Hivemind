package validate

import (
	"encoding/json"
	"math"
	"strconv"
	"strings"
)

// DecodeAny reads one JSON value the way JSON.parse does for this package's
// purposes: objects become *Object (JavaScript key order), arrays []any, numbers
// json.Number.
func DecodeAny(raw []byte) (any, error) { return decodeValue(raw) }

// Stringify is JSON.stringify of a value decoded by DecodeAny: object keys in
// JavaScript order, numbers as JavaScript prints them (a number is read as an
// IEEE double first, so 1.0 prints 1, 1e3 prints 1000, and one beyond a double
// prints null), strings without HTML escaping.
func Stringify(value any) string {
	var out strings.Builder
	stringify(&out, value)
	return out.String()
}

func stringify(out *strings.Builder, value any) {
	switch typed := value.(type) {
	case nil:
		out.WriteString("null")
	case bool:
		out.WriteString(strconv.FormatBool(typed))
	case string:
		writeString(out, typed)
	case json.Number:
		out.WriteString(jsNumber(typed.String()))
	case []any:
		out.WriteByte('[')
		for index, item := range typed {
			if index > 0 {
				out.WriteByte(',')
			}
			stringify(out, item)
		}
		out.WriteByte(']')
	case *Object:
		out.WriteByte('{')
		for index, key := range typed.Keys {
			if index > 0 {
				out.WriteByte(',')
			}
			writeString(out, key)
			out.WriteByte(':')
			stringify(out, typed.Values[key])
		}
		out.WriteByte('}')
	default:
		out.WriteString("null")
	}
}

// jsNumber is Number(text) printed by Number.prototype.toString.
func jsNumber(text string) string {
	number, err := strconv.ParseFloat(text, 64)
	if err != nil && !math.IsInf(number, 0) {
		return "null"
	}
	if math.IsInf(number, 0) || math.IsNaN(number) {
		return "null"
	}
	if number == 0 {
		return "0"
	}
	encoded, err := json.Marshal(number)
	if err != nil {
		return "null"
	}
	return string(encoded)
}

// writeString is JSON.stringify of a string: quotes, backslashes and control
// characters escaped, everything else (including U+2028/2029 and DEL) as is.
func writeString(out *strings.Builder, text string) {
	const hex = "0123456789abcdef"
	out.WriteByte('"')
	for _, character := range text {
		switch {
		case character == '"':
			out.WriteString(`\"`)
		case character == '\\':
			out.WriteString(`\\`)
		case character == '\b':
			out.WriteString(`\b`)
		case character == '\f':
			out.WriteString(`\f`)
		case character == '\n':
			out.WriteString(`\n`)
		case character == '\r':
			out.WriteString(`\r`)
		case character == '\t':
			out.WriteString(`\t`)
		case character < 0x20:
			out.WriteString(`\u00`)
			out.WriteByte(hex[character>>4])
			out.WriteByte(hex[character&0xf])
		default:
			out.WriteRune(character)
		}
	}
	out.WriteByte('"')
}
