// Package wtf8 carries JavaScript's strings across Go's JSON boundary.
//
// JavaScript strings are UTF-16 code units and may hold an unpaired surrogate
// (`"\ud800"`); a Go string holds no surrogate code point, so encoding/json
// decodes such an escape as U+FFFD and would encode it back as U+FFFD. The
// JSON input and output paths here represent an unpaired surrogate as its
// WTF-8 bytes (the three-byte form UTF-8 gives the code unit), so procedures
// echo it unchanged, and write it back as the lower-case \udXXX escape
// JSON.stringify writes.
//
// The decoder works by rewriting string literals before encoding/json sees
// them: an unpaired surrogate unit becomes a private marker rune followed by
// a private-use rune carrying the unit, so the standard decoder (and every
// struct type, tag and error message it implements) keeps working. Restore
// turns the marker pairs back into the WTF-8 bytes. The encoder does the
// reverse: it copies the value with WTF-8 bytes replaced by the same markers,
// lets encoding/json write it, and turns the marker pairs back into escapes.
package wtf8

import (
	"bytes"
	"encoding/json"
	"fmt"
	"reflect"
	"strconv"
	"strings"
	"unicode/utf16"
	"unicode/utf8"
)

const (
	// marker prefixes an unpaired unit: marker + unitMarker carries the unit,
	// marker + markerEscape is a literal marker.
	marker       = '\uFC00'
	markerEscape = '\uFC01'
	// unitMarker carries unit 0xD800 + (unitMarker - 0xE000).
	unitMarkerLow  = 0xE000
	unitMarkerHigh = 0xE7FF
)

var (
	markerBytes = []byte("\uFC00")
	escapeBytes = []byte("\uFC01")
)

// Transform rewrites every string literal of raw so encoding/json decodes an
// unpaired surrogate as a marker pair instead of U+FFFD. Bytes outside string
// literals are untouched, so a body that fails to parse fails the same way.
func Transform(raw []byte) ([]byte, error) {
	out := make([]byte, 0, len(raw)+16)
	for index := 0; index < len(raw); {
		if raw[index] != '"' {
			out = append(out, raw[index])
			index++
			continue
		}
		end := stringEnd(raw, index)
		if end < 0 {
			return nil, fmt.Errorf("wtf8: unterminated string")
		}
		body, err := rewriteString(raw[index+1 : end-1])
		if err != nil {
			return nil, err
		}
		out = append(out, '"')
		out = append(out, body...)
		out = append(out, '"')
		index = end
	}
	return out, nil
}

// stringEnd returns the index just past the closing quote.
func stringEnd(raw []byte, start int) int {
	for index := start + 1; index < len(raw); index++ {
		switch raw[index] {
		case '\\':
			index++
		case '"':
			return index + 1
		}
	}
	return -1
}

// rewriteString decodes a string literal's content and re-emits it as a JSON
// string whose decoded value carries the marker pairs.
func rewriteString(body []byte) ([]byte, error) {
	out := make([]byte, 0, len(body))
	for index := 0; index < len(body); {
		if body[index] != '\\' {
			r, size := utf8.DecodeRune(body[index:])
			if r == utf8.RuneError && size == 1 {
				out = append(out, body[index])
				index++
				continue
			}
			out = appendEscaped(out, r)
			index += size
			continue
		}
		if index+1 >= len(body) {
			return nil, fmt.Errorf("wtf8: trailing backslash in string")
		}
		switch body[index+1] {
		case '"', '\\', '/':
			out = appendEscaped(out, rune(body[index+1]))
			index += 2
		case 'b':
			out = appendEscaped(out, '\b')
			index += 2
		case 'f':
			out = appendEscaped(out, '\f')
			index += 2
		case 'n':
			out = appendEscaped(out, '\n')
			index += 2
		case 'r':
			out = appendEscaped(out, '\r')
			index += 2
		case 't':
			out = appendEscaped(out, '\t')
			index += 2
		case 'u':
			unit, next, err := readUnit(body, index)
			if err != nil {
				return nil, err
			}
			index = next
			if utf16.IsSurrogate(rune(unit)) && index+6 <= len(body) &&
				body[index] == '\\' && body[index+1] == 'u' {
				second, after, err := readUnit(body, index)
				if err != nil {
					return nil, err
				}
				if unit >= 0xD800 && unit <= 0xDBFF && second >= 0xDC00 && second <= 0xDFFF {
					out = appendEscaped(out, utf16.DecodeRune(rune(unit), rune(second)))
					index = after
					continue
				}
			}
			if unit >= 0xD800 && unit <= 0xDFFF {
				out = append(out, markerBytes...)
				out = appendRune(out, unitMarker(unit))
				continue
			}
			out = appendEscaped(out, rune(unit))
		default:
			return nil, fmt.Errorf("wtf8: invalid escape \\%c", body[index+1])
		}
	}
	return out, nil
}

// readUnit reads a `\uXXXX` escape at index and returns the unit and the index
// after it.
func readUnit(body []byte, index int) (uint16, int, error) {
	if index+6 > len(body) || body[index] != '\\' || body[index+1] != 'u' {
		return 0, 0, fmt.Errorf("wtf8: malformed unicode escape")
	}
	value, err := strconv.ParseUint(string(body[index+2:index+6]), 16, 16)
	if err != nil {
		return 0, 0, fmt.Errorf("wtf8: malformed unicode escape")
	}
	return uint16(value), index + 6, nil
}

// appendEscaped writes one code point as JSON string content. The marker rune
// is escaped as marker+markerEscape so a literal one survives Restore.
func appendEscaped(out []byte, r rune) []byte {
	switch {
	case r == marker:
		out = append(out, markerBytes...)
		out = append(out, escapeBytes...)
	case r == '"' || r == '\\':
		out = append(out, '\\', byte(r))
	case r < 0x20:
		out = append(out, '\\', 'u', '0', '0', hex(uint16(r>>4)), hex(uint16(r&0xF)))
	default:
		out = appendRune(out, r)
	}
	return out
}

func appendRune(out []byte, r rune) []byte {
	var buffer [utf8.UTFMax]byte
	size := utf8.EncodeRune(buffer[:], r)
	return append(out, buffer[:size]...)
}

func hex(value uint16) byte {
	if value < 10 {
		return byte('0' + value)
	}
	return byte('a' + value - 10)
}

func unitMarker(unit uint16) rune { return rune(unitMarkerLow + int(unit-0xD800)) }

// RestoreString turns the marker pairs of a decoded string back into the
// JavaScript code units: an unpaired surrogate becomes its WTF-8 bytes, and an
// escaped literal marker becomes the marker itself.
func RestoreString(value string) string {
	if !strings.Contains(value, string(marker)) {
		return value
	}
	var out []byte
	for index := 0; index < len(value); {
		r, size := utf8.DecodeRuneInString(value[index:])
		if r != marker {
			out = append(out, value[index:index+size]...)
			index += size
			continue
		}
		after := index + size
		second, size2 := utf8.DecodeRuneInString(value[after:])
		switch {
		case second == markerEscape:
			out = append(out, value[index:index+size]...)
			index = after + size2
		case second >= unitMarkerLow && second <= unitMarkerHigh:
			unit := uint16(0xD800 + (second - unitMarkerLow))
			out = append(out, surrogateBytes(unit)...)
			index = after + size2
		default:
			out = append(out, value[index:index+size]...)
			index = after
		}
	}
	return string(out)
}

// surrogateBytes is the WTF-8 encoding of one surrogate code unit.
func surrogateBytes(unit uint16) []byte {
	return []byte{
		0xE0 | byte(unit>>12),
		0x80 | byte((unit>>6)&0x3F),
		0x80 | byte(unit&0x3F),
	}
}

// isSurrogate reports the length of the WTF-8 surrogate code unit at the start
// of value, or 0.
func isSurrogate(value string) int {
	if len(value) < 3 || value[0] != 0xED {
		return 0
	}
	if value[1] < 0xA0 || value[1] > 0xBF || value[2] < 0x80 || value[2] > 0xBF {
		return 0
	}
	return 3
}

// Unmarshal is json.Unmarshal with unpaired surrogates preserved as WTF-8 in
// string fields, map keys slices and interfaces.
func Unmarshal(raw []byte, target any) error {
	transformed, err := Transform(raw)
	if err != nil {
		// The standard decoder produces the canonical syntax error.
		return json.Unmarshal(raw, target)
	}
	if err := json.Unmarshal(transformed, target); err != nil {
		return err
	}
	restoreInto(reflect.ValueOf(target))
	return nil
}

// RestoreValue returns value with every marker pair restored; it is for
// generic (any) values decoded outside Unmarshal.
func RestoreValue(value any) any {
	restored := restoreValue(reflect.ValueOf(value))
	if !restored.IsValid() {
		return value
	}
	return restored.Interface()
}

// restoreInto rewrites the strings of a decoded value in place.
func restoreInto(value reflect.Value) {
	if !value.IsValid() {
		return
	}
	if value.Kind() == reflect.Ptr {
		if value.IsNil() {
			return
		}
		restoreInto(value.Elem())
		return
	}
	if !value.CanSet() {
		return
	}
	restored := restoreValue(value)
	if restored.IsValid() && restored.Type() == value.Type() {
		value.Set(restored)
	}
}

// restoreValue returns value with every string restored. It builds new values
// instead of mutating maps, slices and interfaces that have no settable string.
func restoreValue(value reflect.Value) reflect.Value {
	switch value.Kind() {
	case reflect.String:
		if !strings.Contains(value.String(), string(marker)) {
			return value
		}
		out := reflect.New(value.Type()).Elem()
		out.SetString(RestoreString(value.String()))
		return out
	case reflect.Interface:
		if value.IsNil() {
			return value
		}
		inner := restoreValue(value.Elem())
		out := reflect.New(value.Type()).Elem()
		if inner.IsValid() && inner.Type().AssignableTo(out.Type()) {
			out.Set(inner)
			return out
		}
		if inner.IsValid() && inner.Type().Implements(out.Type()) {
			out.Set(inner)
			return out
		}
		return value
	case reflect.Ptr:
		if value.IsNil() {
			return value
		}
		out := reflect.New(value.Type().Elem())
		out.Elem().Set(restoreValue(value.Elem()))
		return out
	case reflect.Struct:
		out := reflect.New(value.Type()).Elem()
		out.Set(value)
		for index := 0; index < value.NumField(); index++ {
			if value.Type().Field(index).PkgPath != "" {
				continue
			}
			field := out.Field(index)
			if !field.CanSet() {
				continue
			}
			restored := restoreValue(field)
			if restored.IsValid() && restored.Type() == field.Type() {
				field.Set(restored)
			}
		}
		return out
	case reflect.Slice:
		if value.IsNil() || value.Type().Elem().Kind() == reflect.Uint8 {
			return value
		}
		out := reflect.MakeSlice(value.Type(), value.Len(), value.Len())
		for index := 0; index < value.Len(); index++ {
			out.Index(index).Set(restoreValue(value.Index(index)))
		}
		return out
	case reflect.Array:
		if value.Type().Elem().Kind() == reflect.Uint8 {
			return value
		}
		out := reflect.New(value.Type()).Elem()
		out.Set(value)
		for index := 0; index < value.Len(); index++ {
			out.Index(index).Set(restoreValue(value.Index(index)))
		}
		return out
	case reflect.Map:
		if value.IsNil() {
			return value
		}
		out := reflect.MakeMapWithSize(value.Type(), value.Len())
		iterator := value.MapRange()
		for iterator.Next() {
			key := iterator.Key()
			if key.Kind() == reflect.String {
				key = restoreValue(key)
			}
			out.SetMapIndex(key, restoreValue(iterator.Value()))
		}
		return out
	}
	return value
}

// Marshal writes JSON like JSON.stringify, with a WTF-8 surrogate in a string
// written as its lower-case \udXXX escape.
func Marshal(value any) ([]byte, error) {
	if value != nil {
		root := encodeValue(reflect.ValueOf(value))
		if root.IsValid() {
			value = root.Interface()
		}
	}
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		return nil, err
	}
	return restoreEscapes(bytes.TrimSuffix(buffer.Bytes(), []byte("\n"))), nil
}

// encodeValue copies value with WTF-8 surrogate bytes replaced by marker pairs
// for encoding/json to write. A type that marshals itself is left alone: its
// own output never carries a Go string's invalid bytes.
func encodeValue(value reflect.Value) reflect.Value {
	if !value.IsValid() {
		return value
	}
	if value.Kind() == reflect.Interface {
		if value.IsNil() {
			return value
		}
		inner := encodeValue(value.Elem())
		out := reflect.New(value.Type()).Elem()
		if inner.IsValid() && inner.Type().AssignableTo(out.Type()) {
			out.Set(inner)
			return out
		}
		if inner.IsValid() && inner.Type().Implements(out.Type()) {
			out.Set(inner)
			return out
		}
		return value
	}
	if value.CanAddr() && value.Addr().Type().Implements(marshalerType) {
		return value
	}
	if value.Type().Implements(marshalerType) {
		return value
	}
	switch value.Kind() {
	case reflect.String:
		text := encodeText(value.String())
		if text == value.String() {
			return value
		}
		out := reflect.New(value.Type()).Elem()
		out.SetString(text)
		return out
	case reflect.Ptr:
		if value.IsNil() {
			return value
		}
		out := reflect.New(value.Type().Elem())
		out.Elem().Set(encodeValue(value.Elem()))
		return out
	case reflect.Struct:
		out := reflect.New(value.Type()).Elem()
		out.Set(value)
		for index := 0; index < value.NumField(); index++ {
			if value.Type().Field(index).PkgPath != "" {
				continue
			}
			field := out.Field(index)
			if !field.CanSet() {
				continue
			}
			encoded := encodeValue(field)
			if encoded.IsValid() && encoded.Type() == field.Type() {
				field.Set(encoded)
			}
		}
		return out
	case reflect.Slice:
		if value.IsNil() || value.Type().Elem().Kind() == reflect.Uint8 {
			return value
		}
		out := reflect.MakeSlice(value.Type(), value.Len(), value.Len())
		for index := 0; index < value.Len(); index++ {
			out.Index(index).Set(encodeValue(value.Index(index)))
		}
		return out
	case reflect.Array:
		if value.Type().Elem().Kind() == reflect.Uint8 {
			return value
		}
		out := reflect.New(value.Type()).Elem()
		out.Set(value)
		for index := 0; index < value.Len(); index++ {
			out.Index(index).Set(encodeValue(value.Index(index)))
		}
		return out
	case reflect.Map:
		if value.IsNil() {
			return value
		}
		out := reflect.MakeMapWithSize(value.Type(), value.Len())
		iterator := value.MapRange()
		for iterator.Next() {
			key := iterator.Key()
			if key.Kind() == reflect.String {
				key = encodeValue(key)
			}
			out.SetMapIndex(key, encodeValue(iterator.Value()))
		}
		return out
	}
	return value
}

var marshalerType = reflect.TypeOf((*json.Marshaler)(nil)).Elem()

// encodeText replaces WTF-8 surrogate code units with marker pairs for
// encoding/json, escaping a literal marker so the output pass can tell them
// apart.
func encodeText(value string) string {
	var out []byte
	for index := 0; index < len(value); {
		if size := isSurrogate(value[index:]); size > 0 {
			unit := uint16(value[index]&0x0F)<<12 | uint16(value[index+1]&0x3F)<<6 | uint16(value[index+2]&0x3F)
			out = append(out, markerBytes...)
			out = appendRune(out, unitMarker(unit))
			index += size
			continue
		}
		if bytes.HasPrefix([]byte(value[index:]), markerBytes) {
			out = append(out, markerBytes...)
			out = append(out, escapeBytes...)
			index += len(markerBytes)
			continue
		}
		out = append(out, value[index])
		index++
	}
	return string(out)
}

// restoreEscapes rewrites marker pairs in marshaled JSON to the escapes
// JSON.stringify writes for unpaired surrogates.
func restoreEscapes(body []byte) []byte {
	if !bytes.Contains(body, markerBytes) {
		return body
	}
	out := make([]byte, 0, len(body))
	for index := 0; index < len(body); {
		if !bytes.HasPrefix(body[index:], markerBytes) {
			out = append(out, body[index])
			index++
			continue
		}
		after := index + len(markerBytes)
		r, size := utf8.DecodeRune(body[after:])
		switch {
		case r == markerEscape:
			out = append(out, markerBytes...)
			index = after + size
		case r >= unitMarkerLow && r <= unitMarkerHigh:
			unit := uint16(0xD800 + (r - unitMarkerLow))
			out = append(out, '\\', 'u')
			out = append(out, hex4(unit)...)
			index = after + size
		default:
			out = append(out, markerBytes...)
			index = after
		}
	}
	return out
}

func hex4(value uint16) []byte {
	return []byte{hex(value >> 12 & 0xF), hex(value >> 8 & 0xF), hex(value >> 4 & 0xF), hex(value & 0xF)}
}

// DecodeRuneInString is utf8.DecodeRuneInString that returns a WTF-8 surrogate
// code unit as that unit (never U+FFFD), so a caller that walks a string one
// code point at a time can preserve it.
func DecodeRuneInString(value string) (rune, int) {
	if size := isSurrogate(value); size > 0 {
		unit := uint16(value[0]&0x0F)<<12 | uint16(value[1]&0x3F)<<6 | uint16(value[2]&0x3F)
		return rune(unit), size
	}
	return utf8.DecodeRuneInString(value)
}

// Units is the JavaScript string's UTF-16 code units: a rune outside the BMP
// becomes its surrogate pair and a WTF-8 surrogate stays one unit.
func Units(value string) []uint16 {
	units := make([]uint16, 0, len(value))
	for index := 0; index < len(value); {
		r, size := DecodeRuneInString(value[index:])
		if r >= 0xD800 && r <= 0xDFFF {
			units = append(units, uint16(r))
			index += size
			continue
		}
		units = utf16.AppendRune(units, r)
		index += size
	}
	return units
}

// FromUnits is the inverse: a pair becomes its rune, an unpaired unit its WTF-8
// bytes, and NUL and other units their UTF-8 characters.
func FromUnits(units []uint16) string {
	var out strings.Builder
	out.Grow(len(units))
	for index := 0; index < len(units); index++ {
		unit := units[index]
		switch {
		case unit >= 0xD800 && unit <= 0xDBFF && index+1 < len(units) && units[index+1] >= 0xDC00 && units[index+1] <= 0xDFFF:
			out.WriteRune(utf16.DecodeRune(rune(unit), rune(units[index+1])))
			index++
		case unit >= 0xD800 && unit <= 0xDFFF:
			out.Write(surrogateBytes(unit))
		default:
			out.WriteRune(rune(unit))
		}
	}
	return out.String()
}

// Length is JavaScript's String.prototype.length.
func Length(value string) int { return len(Units(value)) }

// CodePoints counts Unicode code points the way zod's codePointLength does when
// a UTF-16-length check is inconclusive: a valid pair is one, an unpaired unit
// is one.
func CodePoints(value string) int {
	count := 0
	for index := 0; index < len(value); {
		_, size := DecodeRuneInString(value[index:])
		count++
		index += size
	}
	return count
}

// ZodMinPass and ZodMaxPass are zod 4's string length checks
// (zod/v4/core/checks.js $ZodCheckMinLength/$ZodCheckMaxLength): a string that
// fits in UTF-16 units always passes, and a longer one is counted in code points
// before it is rejected.
func ZodMinPass(value string, minimum int) bool {
	units := Length(value)
	if units >= minimum && units < minimum*2 {
		return CodePoints(value) >= minimum
	}
	return units >= minimum
}

func ZodMaxPass(value string, maximum int) bool {
	if Length(value) > maximum {
		return CodePoints(value) <= maximum
	}
	return true
}

// Fits is both zod checks on a string.
func Fits(value string, minimum, maximum int) bool {
	return ZodMinPass(value, minimum) && ZodMaxPass(value, maximum)
}

// ReplaceSurrogates is the read-side rule: what Node's UTF-8 encoder sends for
// an unpaired surrogate (U+FFFD), applied without touching NUL.
func ReplaceSurrogates(value string) string {
	var out strings.Builder
	out.Grow(len(value))
	for index := 0; index < len(value); {
		if size := isSurrogate(value[index:]); size > 0 {
			out.WriteRune(utf8.RuneError)
			index += size
			continue
		}
		r, size := utf8.DecodeRuneInString(value[index:])
		if r == utf8.RuneError && size == 1 {
			out.WriteRune(utf8.RuneError)
			index++
			continue
		}
		out.WriteString(value[index : index+size])
		index += size
	}
	return out.String()
}

// SanitizeText is sanitizeUtf16ForJson (packages/core/src/messages/events.ts:
// 640-645), the write-side rule Prisma's client applies: NUL and an unpaired
// UTF-16 surrogate become U+FFFD. WTF-8 is how such a surrogate reaches this
// package, so each of its bytes becomes one replacement character.
func SanitizeText(value string) string {
	found := false
	for index := 0; index < len(value); {
		if value[index] == 0 || isSurrogate(value[index:]) > 0 {
			found = true
			break
		}
		if value[index] < 0x80 {
			index++
			continue
		}
		r, size := utf8.DecodeRuneInString(value[index:])
		if r == utf8.RuneError && size == 1 {
			found = true
			break
		}
		index += size
	}
	if !found {
		return value
	}
	var out strings.Builder
	out.Grow(len(value))
	for index := 0; index < len(value); {
		if value[index] == 0 {
			out.WriteRune(utf8.RuneError)
			index++
			continue
		}
		if isSurrogate(value[index:]) > 0 {
			out.WriteRune(utf8.RuneError)
			index += 3
			continue
		}
		r, size := utf8.DecodeRuneInString(value[index:])
		if r == utf8.RuneError && size == 1 {
			out.WriteRune(utf8.RuneError)
			index++
			continue
		}
		out.WriteString(value[index : index+size])
		index += size
	}
	return out.String()
}
