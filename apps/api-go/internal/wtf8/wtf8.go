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
	"crypto/rand"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"reflect"
	"strconv"
	"strings"
	"unicode/utf16"
	"unicode/utf8"
)

// The decoder marks an unpaired unit as marker + unitMarker. Both marker runes
// are chosen at process start from the BMP private-use area, so a request cannot
// contain them: a value that did could only use the marker pair by guessing a
// random 14-bit pair (2^-28 with two draws), and neither rune is ever written in
// a response. That is what lets the encoder restore marker pairs in the whole
// marshaled body without corrupting a literal marker sequence from a custom
// json.Marshaler or a json.RawMessage.
var (
	marker       rune
	markerEscape rune
	markerBytes  []byte
	escapeBytes  []byte
	markerText   string
	escapeText   string
	// unitMarker carries unit 0xD800 + (unitMarker - unitMarkerLow).
	unitMarkerLow  rune = 0xE000
	unitMarkerHigh rune = 0xE7FF
)

func init() {
	const first, span = 0xE800, 0x10FF // BMP private use, outside the unit markers
	seed := make([]byte, 8)
	if _, err := rand.Read(seed); err != nil {
		marker, markerEscape = 0xFC00, 0xFC01
	} else {
		pick := binary.BigEndian.Uint32(seed[:4])
		marker = first + rune(pick%span)
		second := binary.BigEndian.Uint32(seed[4:])
		markerEscape = first + rune(second%span)
		if markerEscape == marker {
			markerEscape = first + (markerEscape-first+1)%span
		}
	}
	markerText = string(marker)
	escapeText = string(markerEscape)
	markerBytes = []byte(markerText)
	escapeBytes = []byte(escapeText)
}

// NeedsTransform reports whether raw contains an unpaired surrogate escape.
// Documents without one take the standard decoder path unchanged, which is the
// common case and keeps the boundary at encoding/json's cost.
func NeedsTransform(raw []byte) bool {
	for index := 0; index+1 < len(raw); index++ {
		if raw[index] != '\\' {
			continue
		}
		if raw[index+1] != 'u' {
			index++
			continue
		}
		if index+6 > len(raw) {
			return true
		}
		unit, ok := hexUnit(raw[index+2 : index+6])
		if !ok {
			return true
		}
		index += 5
		switch {
		case unit >= 0xDC00 && unit <= 0xDFFF:
			return true
		case unit >= 0xD800 && unit <= 0xDBFF:
			if index+7 <= len(raw) && raw[index+1] == '\\' && raw[index+2] == 'u' {
				second, ok := hexUnit(raw[index+3 : index+7])
				if ok && second >= 0xDC00 && second <= 0xDFFF {
					index += 6
					continue
				}
			}
			return true
		}
	}
	return false
}

func hexUnit(raw []byte) (uint16, bool) {
	if len(raw) < 4 {
		return 0, false
	}
	var unit uint16
	for _, c := range raw[:4] {
		digit, ok := hexDigit(c)
		if !ok {
			return 0, false
		}
		unit = unit<<4 | digit
	}
	return unit, true
}

func hexDigit(c byte) (uint16, bool) {
	switch {
	case c >= '0' && c <= '9':
		return uint16(c - '0'), true
	case c >= 'a' && c <= 'f':
		return uint16(c-'a') + 10, true
	case c >= 'A' && c <= 'F':
		return uint16(c-'A') + 10, true
	}
	return 0, false
}

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
			if r < 0x20 {
				// An unescaped control character is not JSON; let the standard
				// decoder report the syntax error.
				return nil, fmt.Errorf("wtf8: unescaped control character in string")
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

func unitMarker(unit uint16) rune { return unitMarkerLow + rune(unit-0xD800) }

// RestoreString turns the marker pairs of a decoded string back into the
// JavaScript code units: an unpaired surrogate becomes its WTF-8 bytes, and an
// escaped literal marker becomes the marker itself.
func RestoreString(value string) string {
	if !strings.Contains(value, markerText) {
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
			unit := uint16(0xD800 + int(second-unitMarkerLow))
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
	if !NeedsTransform(raw) {
		return json.Unmarshal(raw, target)
	}
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
		if !strings.Contains(value.String(), markerText) {
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
// written as its lower-case \udXXX escape. A value without a surrogate or a
// marker is marshaled by encoding/json directly, at its own cost.
func Marshal(value any) ([]byte, error) {
	body, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	body = unescapeHTML(body)
	// encoding/json writes U+FFFD for every invalid UTF-8 byte, and WTF-8
	// surrogate bytes are the only invalid bytes a decoded JS string can carry.
	// Without U+FFFD in the output the document has no surrogates (a legitimate
	// U+FFFD only makes this walk run), so standard JSON is already exact and the
	// reflection walk is skipped entirely.
	if !bytes.Contains(body, []byte(string(utf8.RuneError))) || !needsEncodingAny(value) {
		return body, nil
	}
	root, changed := encodeValue(reflect.ValueOf(value))
	if !changed {
		return body, nil
	}
	body, err = json.Marshal(root.Interface())
	if err != nil {
		return nil, err
	}
	return restoreEscapes(unescapeHTML(body)), nil
}

// unescapeHTML turns the escapes json.Marshal writes for <, > and & back into
// the characters, which is what JSON.stringify writes. Only an escape that
// starts a token is replaced: one after an odd run of backslashes is text.
func unescapeHTML(body []byte) []byte {
	if !bytes.Contains(body, []byte(`\u00`)) {
		return body
	}
	var out bytes.Buffer
	out.Grow(len(body))
	for index := 0; index < len(body); index++ {
		if body[index] == '\\' {
			if index+1 < len(body) && body[index+1] == '\\' {
				out.WriteString(`\\`)
				index++
				continue
			}
			if index+5 < len(body) && body[index+1] == 'u' && body[index+2] == '0' && body[index+3] == '0' {
				switch body[index+4] {
				case '3':
					switch body[index+5] {
					case 'c':
						out.WriteByte('<')
						index += 5
						continue
					case 'e':
						out.WriteByte('>')
						index += 5
						continue
					}
				case '2':
					if body[index+5] == '6' {
						out.WriteByte('&')
						index += 5
						continue
					}
				}
			}
		}
		out.WriteByte(body[index])
	}
	return out.Bytes()
}

// needsEncodingAny is needsEncodingValue with type switches for the shapes HTTP
// bodies use, so a surrogate-free response pays no reflection allocation.
func needsEncodingAny(value any) bool {
	switch typed := value.(type) {
	case nil:
		return false
	case string:
		return hasWTF8(typed)
	case []byte:
		return false
	case json.RawMessage:
		return false
	case []any:
		for _, item := range typed {
			if needsEncodingAny(item) {
				return true
			}
		}
		return false
	case map[string]any:
		for key, item := range typed {
			if hasWTF8(key) || needsEncodingAny(item) {
				return true
			}
		}
		return false
	case map[string]string:
		for key, item := range typed {
			if hasWTF8(key) || hasWTF8(item) {
				return true
			}
		}
		return false
	}
	return needsEncodingValue(reflect.ValueOf(value))
}

// needsEncodingValue reports whether any string in the value needs the marker
// form, without allocating or copying: the common surrogate-free body goes
// straight to encoding/json.
func needsEncodingValue(value reflect.Value) bool {
	if !value.IsValid() {
		return false
	}
	if value.Kind() == reflect.Interface {
		return !value.IsNil() && needsEncodingValue(value.Elem())
	}
	if value.CanAddr() && value.Addr().Type().Implements(marshalerType) {
		return false
	}
	if value.Type().Implements(marshalerType) {
		return false
	}
	switch value.Kind() {
	case reflect.String:
		return hasWTF8(value.String())
	case reflect.Ptr:
		return !value.IsNil() && needsEncodingValue(value.Elem())
	case reflect.Struct:
		for index := 0; index < value.NumField(); index++ {
			if value.Type().Field(index).PkgPath != "" {
				continue
			}
			if needsEncodingValue(value.Field(index)) {
				return true
			}
		}
	case reflect.Slice, reflect.Array:
		if value.Type().Elem().Kind() == reflect.Uint8 {
			return false
		}
		for index := 0; index < value.Len(); index++ {
			if needsEncodingValue(value.Index(index)) {
				return true
			}
		}
	case reflect.Map:
		if value.IsNil() {
			return false
		}
		iterator := value.MapRange()
		for iterator.Next() {
			key := iterator.Key()
			if key.Kind() == reflect.String && hasWTF8(key.String()) {
				return true
			}
			if needsEncodingValue(iterator.Value()) {
				return true
			}
		}
	}
	return false
}

// encodeValue copies a value only where a string needs the marker form: the
// returned bool says whether anything changed.
func encodeValue(value reflect.Value) (reflect.Value, bool) {
	if !value.IsValid() {
		return value, false
	}
	if value.Kind() == reflect.Interface {
		if value.IsNil() {
			return value, false
		}
		inner, changed := encodeValue(value.Elem())
		if !changed {
			return value, false
		}
		out := reflect.New(value.Type()).Elem()
		if inner.IsValid() && inner.Type().AssignableTo(out.Type()) {
			out.Set(inner)
			return out, true
		}
		if inner.IsValid() && inner.Type().Implements(out.Type()) {
			out.Set(inner)
			return out, true
		}
		return value, false
	}
	if value.CanAddr() && value.Addr().Type().Implements(marshalerType) {
		return value, false
	}
	if value.Type().Implements(marshalerType) {
		return value, false
	}
	switch value.Kind() {
	case reflect.String:
		text := encodeText(value.String())
		if text == value.String() {
			return value, false
		}
		out := reflect.New(value.Type()).Elem()
		out.SetString(text)
		return out, true
	case reflect.Ptr:
		if value.IsNil() {
			return value, false
		}
		inner, changed := encodeValue(value.Elem())
		if !changed {
			return value, false
		}
		out := reflect.New(value.Type().Elem())
		out.Elem().Set(inner)
		return out, true
	case reflect.Struct:
		var out reflect.Value
		for index := 0; index < value.NumField(); index++ {
			if value.Type().Field(index).PkgPath != "" {
				continue
			}
			field := value.Field(index)
			if !field.CanSet() && !value.CanInterface() {
				continue
			}
			encoded, changed := encodeValue(field)
			if !changed {
				continue
			}
			if !out.IsValid() {
				out = reflect.New(value.Type()).Elem()
				out.Set(value)
			}
			target := out.Field(index)
			if target.CanSet() {
				target.Set(encoded)
			}
		}
		if out.IsValid() {
			return out, true
		}
		return value, false
	case reflect.Slice:
		if value.IsNil() || value.Type().Elem().Kind() == reflect.Uint8 {
			return value, false
		}
		var out reflect.Value
		for index := 0; index < value.Len(); index++ {
			item, changed := encodeValue(value.Index(index))
			if !changed {
				continue
			}
			if !out.IsValid() {
				out = reflect.MakeSlice(value.Type(), value.Len(), value.Len())
				reflect.Copy(out, value)
			}
			out.Index(index).Set(item)
		}
		if out.IsValid() {
			return out, true
		}
		return value, false
	case reflect.Array:
		if value.Type().Elem().Kind() == reflect.Uint8 {
			return value, false
		}
		var out reflect.Value
		for index := 0; index < value.Len(); index++ {
			item, changed := encodeValue(value.Index(index))
			if !changed {
				continue
			}
			if !out.IsValid() {
				out = reflect.New(value.Type()).Elem()
				out.Set(value)
			}
			out.Index(index).Set(item)
		}
		if out.IsValid() {
			return out, true
		}
		return value, false
	case reflect.Map:
		if value.IsNil() {
			return value, false
		}
		type entry struct {
			key, encodedKey     reflect.Value
			value, encodedValue reflect.Value
			changed             bool
		}
		entries := make([]entry, 0, value.Len())
		anyChanged := false
		iterator := value.MapRange()
		for iterator.Next() {
			item := entry{key: iterator.Key(), value: iterator.Value()}
			if item.key.Kind() == reflect.String {
				item.encodedKey, item.changed = encodeValue(item.key)
			} else {
				item.encodedKey = item.key
			}
			encoded, valueChanged := encodeValue(item.value)
			item.encodedValue = encoded
			item.changed = item.changed || valueChanged
			anyChanged = anyChanged || item.changed
			entries = append(entries, item)
		}
		if !anyChanged {
			return value, false
		}
		out := reflect.MakeMapWithSize(value.Type(), value.Len())
		for _, item := range entries {
			out.SetMapIndex(item.encodedKey, item.encodedValue)
		}
		return out, true
	}
	return value, false
}

var marshalerType = reflect.TypeOf((*json.Marshaler)(nil)).Elem()

// encodeText replaces WTF-8 surrogate code units with marker pairs for
// encoding/json, escaping a literal marker so the output pass can tell them
// apart.
func encodeText(value string) string {
	if !needsEncoding(value) {
		return value
	}
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

// needsEncoding reports whether value carries a WTF-8 surrogate or a marker that
// restoreEscapes could misread.
func needsEncoding(value string) bool {
	return strings.Contains(value, markerText) || hasWTF8(value)
}

// hasWTF8 reports whether value contains an encoded unpaired UTF-16 surrogate
// (0xED A0..BF 80..BF). Detection only needs this: without a surrogate the
// output is standard JSON and restoreEscapes never runs, so a literal marker
// needs no escaping.
func hasWTF8(value string) bool {
	for index := 0; index < len(value); {
		at := strings.IndexByte(value[index:], 0xED)
		if at < 0 {
			return false
		}
		if size := isSurrogate(value[index+at:]); size > 0 {
			return true
		}
		index += at + 1
	}
	return false
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
			unit := uint16(0xD800 + int(r-unitMarkerLow))
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

// AppendQuoted appends JSON.stringify's spelling of one string: WTF-8 surrogate
// bytes become lower-case \udXXX escapes, and every other character is written
// as UTF-8 (JSON.stringify does not HTML-escape).
func AppendQuoted(out *strings.Builder, text string) {
	out.WriteByte('"')
	for index := 0; index < len(text); {
		if size := isSurrogate(text[index:]); size > 0 {
			unit := uint16(text[index]&0x0F)<<12 | uint16(text[index+1]&0x3F)<<6 | uint16(text[index+2]&0x3F)
			out.WriteString(`\u`)
			out.WriteString(string(hex4(unit)))
			index += size
			continue
		}
		r, size := utf8.DecodeRuneInString(text[index:])
		if r == utf8.RuneError && size == 1 {
			out.WriteRune(utf8.RuneError)
			index++
			continue
		}
		switch {
		case r == '"':
			out.WriteString(`\"`)
		case r == '\\':
			out.WriteString(`\\`)
		case r == '\b':
			out.WriteString(`\b`)
		case r == '\f':
			out.WriteString(`\f`)
		case r == '\n':
			out.WriteString(`\n`)
		case r == '\r':
			out.WriteString(`\r`)
		case r == '\t':
			out.WriteString(`\t`)
		case r < 0x20:
			out.WriteString(`\u00`)
			out.WriteString(string([]byte{hex(uint16(r) >> 4), hex(uint16(r) & 0xF)}))
		default:
			out.WriteString(text[index : index+size])
		}
		index += size
	}
	out.WriteByte('"')
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
