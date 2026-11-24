// Package validate reproduces the zod 4 checks the contracts apply to procedure
// inputs: the same issues, in the same order, with the same messages. A failing
// parse reports every issue (zod does not stop at the first), so callers
// collect them with the helpers here and answer with Fail.
package validate

import (
	"bytes"
	"encoding/json"
	"io"
	"math"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/orpc"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/wtf8"
)

// Issue is one zod issue as it appears in the error envelope.
type Issue = map[string]any

// Path is an issue path: object keys (string) and array indexes (int).
type Path []any

func (p Path) with(key any) Path {
	next := make(Path, len(p)+1)
	copy(next, p)
	next[len(p)] = key
	return next
}

// With returns the path extended by one key.
func (p Path) With(key any) Path { return p.with(key) }

// Raw is the path as the issue's `path` array.
func (p Path) Raw() []any { return p.json() }

func (p Path) json() []any {
	if p == nil {
		return []any{}
	}
	return p
}

// Fail is the BAD_REQUEST an input that broke its schema is answered with.
func Fail(issues []Issue) *orpc.Error {
	return orpc.InvalidInput(issues...)
}

// Object is a decoded JSON object with JavaScript's key order: integer-like keys
// ascending first, then the rest in insertion order, a repeated key keeping its
// first position and its last value.
type Object struct {
	Keys   []string
	Values map[string]any
}

// Decode reads raw as a z.object() input. When it is not an object, the issue
// names what it was instead (undefined when nothing was sent).
func Decode(raw json.RawMessage, path Path) (*Object, []Issue) {
	if len(raw) == 0 {
		return nil, []Issue{TypeIssue("object", "undefined", path)}
	}
	value, err := decodeValue(raw)
	if err != nil {
		return nil, []Issue{TypeIssue("object", "undefined", path)}
	}
	return AsObject(value, path)
}

// AsObject treats an already decoded value as a z.object() input.
func AsObject(value any, path Path) (*Object, []Issue) {
	raw, ok := value.(*Object)
	if !ok {
		return nil, []Issue{TypeIssue("object", JSType(value), path)}
	}
	return raw, nil
}

// Get returns the value of a key and whether it was present.
func (o *Object) Get(key string) (any, bool) {
	value, ok := o.Values[key]
	return value, ok
}

type undefinedValue struct{}

// Undefined stands for a key that was not sent, which zod reports as "undefined".
var Undefined any = undefinedValue{}

// Field is the value of a key, or Undefined when it was not sent.
func (o *Object) Field(key string) any {
	if value, ok := o.Values[key]; ok {
		return value
	}
	return Undefined
}

// Unrecognized is the strictObject check: an issue naming keys outside allowed.
func (o *Object) Unrecognized(path Path, allowed ...string) []Issue {
	known := map[string]bool{}
	for _, key := range allowed {
		known[key] = true
	}
	var unknown []string
	for _, key := range o.Keys {
		if !known[key] {
			unknown = append(unknown, key)
		}
	}
	if len(unknown) == 0 {
		return nil
	}
	quoted := make([]string, len(unknown))
	for index, key := range unknown {
		quoted[index] = `"` + key + `"`
	}
	label := "key"
	if len(unknown) > 1 {
		label = "keys"
	}
	return []Issue{{
		"code": "unrecognized_keys", "keys": unknown, "path": path.json(),
		"message": "Unrecognized " + label + ": " + strings.Join(quoted, ", "),
	}}
}

func decodeValue(raw []byte) (any, error) {
	if wtf8.NeedsTransform(raw) {
		transformed, err := wtf8.Transform(raw)
		if err != nil {
			// The standard decoder reports the canonical syntax error.
			transformed = raw
		}
		raw = transformed
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	value, err := readValue(dec)
	if err != nil {
		return nil, err
	}
	if _, err := dec.Token(); err != io.EOF {
		return nil, io.ErrUnexpectedEOF
	}
	return value, nil
}

// readValue decodes one JSON value; objects become *Object, arrays []any.
func readValue(dec *json.Decoder) (any, error) {
	token, err := dec.Token()
	if err != nil {
		return nil, err
	}
	delim, isDelim := token.(json.Delim)
	if !isDelim {
		if text, ok := token.(string); ok {
			return wtf8.RestoreString(text), nil
		}
		return token, nil
	}
	if delim == '[' {
		items := []any{}
		for dec.More() {
			item, err := readValue(dec)
			if err != nil {
				return nil, err
			}
			items = append(items, item)
		}
		if _, err := dec.Token(); err != nil {
			return nil, err
		}
		return items, nil
	}
	object := &Object{Values: map[string]any{}}
	var order []string
	for dec.More() {
		keyToken, err := dec.Token()
		if err != nil {
			return nil, err
		}
		key := wtf8.RestoreString(keyToken.(string))
		item, err := readValue(dec)
		if err != nil {
			return nil, err
		}
		if _, seen := object.Values[key]; !seen {
			order = append(order, key)
		}
		object.Values[key] = item
	}
	if _, err := dec.Token(); err != nil {
		return nil, err
	}
	var indexed, named []string
	for _, key := range order {
		if isArrayIndex(key) {
			indexed = append(indexed, key)
		} else {
			named = append(named, key)
		}
	}
	sort.Slice(indexed, func(a, b int) bool {
		left, _ := strconv.ParseUint(indexed[a], 10, 64)
		right, _ := strconv.ParseUint(indexed[b], 10, 64)
		return left < right
	})
	object.Keys = append(indexed, named...)
	return object, nil
}

func isArrayIndex(key string) bool {
	if key == "" || (len(key) > 1 && key[0] == '0') {
		return false
	}
	number, err := strconv.ParseUint(key, 10, 64)
	return err == nil && number < 4294967295
}

// JSType names a decoded JSON value the way zod's parsedType does.
func JSType(value any) string {
	switch value.(type) {
	case undefinedValue:
		return "undefined"
	case nil:
		return "null"
	case []any:
		return "array"
	case *Object:
		return "object"
	case string:
		return "string"
	case bool:
		return "boolean"
	default:
		return "number"
	}
}

// TypeIssue is zod's invalid_type.
func TypeIssue(expected, received string, path Path) Issue {
	return Issue{
		"expected": expected, "code": "invalid_type", "path": path.json(),
		"message": "Invalid input: expected " + expected + ", received " + received,
	}
}

// StringRules are the checks chained onto z.string().
type StringRules struct {
	// Trim is .trim(): the value is trimmed before the length checks.
	Trim     bool
	Min, Max int // 0 means no check
}

// String validates z.string() with its length checks. Zod still runs the length
// checks on a non-string that has a length (an array, or an object with a
// "length" key), after the type issue.
func String(path Path, raw any, rules StringRules) (string, []Issue) {
	text, ok := raw.(string)
	if !ok {
		issues := []Issue{TypeIssue("string", JSType(raw), path)}
		length, origin, has := lengthOf(raw)
		if !has {
			return "", issues
		}
		if rules.Min > 0 && !(length >= float64(rules.Min)) {
			issues = append(issues, tooSmall(origin, rules.Min, path))
		}
		if rules.Max > 0 && !(length <= float64(rules.Max)) {
			issues = append(issues, tooBig(origin, rules.Max, path))
		}
		return "", issues
	}
	if rules.Trim {
		text = JSTrim(text)
	}
	var issues []Issue
	if rules.Min > 0 && !wtf8.ZodMinPass(text, rules.Min) {
		issues = append(issues, tooSmall("string", rules.Min, path))
	}
	if rules.Max > 0 && !wtf8.ZodMaxPass(text, rules.Max) {
		issues = append(issues, tooBig("string", rules.Max, path))
	}
	if issues != nil {
		return "", issues
	}
	return text, nil
}

func tooSmall(origin string, minimum int, path Path) Issue {
	return Issue{
		"origin": origin, "code": "too_small", "minimum": minimum, "inclusive": true, "path": path.json(),
		"message": "Too small: expected " + origin + " to " + sizing(origin, ">=", minimum),
	}
}

func tooBig(origin string, maximum int, path Path) Issue {
	return Issue{
		"origin": origin, "code": "too_big", "maximum": maximum, "inclusive": true, "path": path.json(),
		"message": "Too big: expected " + origin + " to " + sizing(origin, "<=", maximum),
	}
}

func sizing(origin, comparison string, limit int) string {
	switch origin {
	case "array":
		return "have " + comparison + strconv.Itoa(limit) + " items"
	case "string":
		return "have " + comparison + strconv.Itoa(limit) + " characters"
	}
	return "be " + comparison + strconv.Itoa(limit)
}

// lengthOf is `value.length` for a decoded JSON value, read as a number the way
// a comparison does; has is false when the value has no length.
func lengthOf(raw any) (length float64, origin string, has bool) {
	switch value := raw.(type) {
	case []any:
		return float64(len(value)), "array", true
	case *Object:
		field, ok := value.Values["length"]
		if !ok {
			return 0, "", false
		}
		// The comparison coerces the member with ToPrimitive/ToNumber, so a
		// string, array or NaN-producing object is read exactly as JS reads it.
		return toNumber(field), "unknown", true
	}
	return 0, "", false
}

// toNumber is JS ToNumber for a decoded JSON value: Number(string) semantics
// (JS whitespace trim, "" = 0, 0x/0o/0b literals, Infinity, otherwise a full
// decimal literal), Number(array) through its ","-joined string, null/bool as
// 0/1, and NaN for an object.
func toNumber(value any) float64 {
	switch typed := value.(type) {
	case nil:
		return 0
	case bool:
		if typed {
			return 1
		}
		return 0
	case json.Number:
		parsed, err := strconv.ParseFloat(typed.String(), 64)
		if err != nil {
			return math.NaN()
		}
		return parsed
	case string:
		return stringToNumber(typed)
	case []any:
		return stringToNumber(joinElements(typed))
	}
	return math.NaN()
}

// joinElements is Array.prototype.join.call(value, ","): each element's
// ToString, with null (and undefined) becoming the empty string.
func joinElements(items []any) string {
	parts := make([]string, len(items))
	for index, item := range items {
		parts[index] = elementText(item)
	}
	return strings.Join(parts, ",")
}

func elementText(value any) string {
	switch typed := value.(type) {
	case nil:
		return ""
	case bool:
		return strconv.FormatBool(typed)
	case string:
		return typed
	case json.Number:
		text := jsNumber(typed.String())
		if text == "null" {
			return "NaN"
		}
		return text
	case []any:
		return joinElements(typed)
	}
	return "[object Object]"
}

// stringToNumber is Number(string) (ECMA-262 StringNumericLiteral).
func stringToNumber(text string) float64 {
	text = JSTrim(text)
	if text == "" {
		return 0
	}
	switch text {
	case "Infinity", "+Infinity":
		return math.Inf(1)
	case "-Infinity":
		return math.Inf(-1)
	}
	if len(text) > 2 && text[0] == '0' {
		switch text[1] {
		case 'x', 'X':
			return parseBaseNumber(text[2:], 16)
		case 'o', 'O':
			return parseBaseNumber(text[2:], 8)
		case 'b', 'B':
			return parseBaseNumber(text[2:], 2)
		}
	}
	if !decimalLiteral(text) {
		return math.NaN()
	}
	parsed, err := strconv.ParseFloat(text, 64)
	if err != nil {
		return math.NaN()
	}
	return parsed
}

func parseBaseNumber(digits string, base int) float64 {
	if digits == "" {
		return math.NaN()
	}
	parsed, err := strconv.ParseUint(digits, base, 64)
	if err != nil {
		return math.NaN()
	}
	return float64(parsed)
}

// decimalLiteral reports whether text is StrDecimalLiteral: an optional sign,
// then digits with an optional fraction and exponent (at least one digit in
// the significand).
func decimalLiteral(text string) bool {
	index := 0
	if index < len(text) && (text[index] == '+' || text[index] == '-') {
		index++
	}
	digits := 0
	for index < len(text) && text[index] >= '0' && text[index] <= '9' {
		index++
		digits++
	}
	if index < len(text) && text[index] == '.' {
		index++
		for index < len(text) && text[index] >= '0' && text[index] <= '9' {
			index++
			digits++
		}
	}
	if digits == 0 {
		return false
	}
	if index < len(text) && (text[index] == 'e' || text[index] == 'E') {
		index++
		if index < len(text) && (text[index] == '+' || text[index] == '-') {
			index++
		}
		exponent := 0
		for index < len(text) && text[index] >= '0' && text[index] <= '9' {
			index++
			exponent++
		}
		if exponent == 0 {
			return false
		}
	}
	return index == len(text)
}

// NumberRules are the checks chained onto z.number().int().
type NumberRules struct {
	// Gt is .positive() (>0) when set; Min and Max are inclusive bounds.
	Gt       *float64
	Min, Max *float64
}

// Float returns a pointer for a rule bound.
func Float(value float64) *float64 { return &value }

// Integer validates z.number().int() followed by its bound checks, in order:
// int, greater-than, minimum, maximum.
func Integer(path Path, raw any, rules NumberRules) (int64, []Issue) {
	number, ok := raw.(json.Number)
	if !ok {
		return 0, []Issue{TypeIssue("number", JSType(raw), path)}
	}
	value, err := strconv.ParseFloat(number.String(), 64)
	if err != nil {
		name := "Infinity"
		if strings.HasPrefix(number.String(), "-") {
			name = "-Infinity"
		}
		// z.number() refuses a non-finite number, naming it in the message.
		return 0, []Issue{{
			"expected": "number", "code": "invalid_type", "path": path.json(),
			"message": "Invalid input: expected number, received " + name,
		}}
	}
	if value != math.Trunc(value) {
		// A failed integer check stops the checks after it.
		return 0, []Issue{{
			"expected": "int", "format": "safeint", "code": "invalid_type", "path": path.json(),
			"message": "Invalid input: expected int, received number",
		}}
	}
	var issues []Issue
	if math.Abs(value) > 9007199254740991 {
		if value > 0 {
			issues = append(issues, Issue{
				"code": "too_big", "maximum": int64(9007199254740991), "note": "Integers must be within the safe integer range.",
				"origin": "int", "inclusive": true, "path": path.json(),
				"message": "Too big: expected int to be <=9007199254740991",
			})
		} else {
			issues = append(issues, Issue{
				"code": "too_small", "minimum": int64(-9007199254740991), "note": "Integers must be within the safe integer range.",
				"origin": "int", "inclusive": true, "path": path.json(),
				"message": "Too small: expected int to be >=-9007199254740991",
			})
		}
	}
	if rules.Gt != nil && !(value > *rules.Gt) {
		issues = append(issues, Issue{
			"origin": "number", "code": "too_small", "minimum": numberValue(*rules.Gt), "inclusive": false, "path": path.json(),
			"message": "Too small: expected number to be >" + formatNumber(*rules.Gt),
		})
	}
	if rules.Min != nil && value < *rules.Min {
		issues = append(issues, Issue{
			"origin": "number", "code": "too_small", "minimum": numberValue(*rules.Min), "inclusive": true, "path": path.json(),
			"message": "Too small: expected number to be >=" + formatNumber(*rules.Min),
		})
	}
	if rules.Max != nil && value > *rules.Max {
		issues = append(issues, Issue{
			"origin": "number", "code": "too_big", "maximum": numberValue(*rules.Max), "inclusive": true, "path": path.json(),
			"message": "Too big: expected number to be <=" + formatNumber(*rules.Max),
		})
	}
	if len(issues) > 0 {
		return 0, issues
	}
	return int64(value), nil
}

func numberValue(value float64) any {
	if value == math.Trunc(value) {
		return int64(value)
	}
	return value
}

func formatNumber(value float64) string {
	return strconv.FormatFloat(value, 'f', -1, 64)
}

// Boolean validates z.boolean().
func Boolean(path Path, raw any) (bool, []Issue) {
	value, ok := raw.(bool)
	if !ok {
		return false, []Issue{TypeIssue("boolean", JSType(raw), path)}
	}
	return value, nil
}

// AsArray validates the type of z.array(...); the caller validates each item,
// then applies ArrayBounds (zod checks the length after the items).
func AsArray(path Path, raw any) ([]any, []Issue) {
	items, ok := raw.([]any)
	if !ok {
		return nil, []Issue{TypeIssue("array", JSType(raw), path)}
	}
	return items, nil
}

// ArrayBounds are .min(n) and .max(n) on an array of the given length; 0 skips a bound.
func ArrayBounds(path Path, length, minimum, maximum int) []Issue {
	var issues []Issue
	if minimum > 0 && length < minimum {
		issues = append(issues, tooSmall("array", minimum, path))
	}
	if maximum > 0 && length > maximum {
		issues = append(issues, tooBig("array", maximum, path))
	}
	return issues
}

const (
	isoDateSource = `(?:(?:\d\d[2468][048]|\d\d[13579][26]|\d\d0[48]|[02468][048]00|[13579][26]00)-02-29|\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\d|30)|(?:02)-(?:0[1-9]|1\d|2[0-8])))`
	isoTimeSource = `(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?`
	// z.iso.datetime({ offset: true }): seconds are required wherever the time carries Z or an offset.
	isoDateTimeSource = `^` + isoDateSource + `T(?:` + isoTimeSource + `(?:Z|([+-](?:[01]\d|2[0-3]):[0-5]\d)))$`
)

var isoDateTimePattern = regexp.MustCompile(isoDateTimeSource)

// ISODateTime validates z.iso.datetime({ offset: true }); nullable adds .nullable().
// A valid value is returned as text (nil for an accepted null).
func ISODateTime(path Path, raw any, nullable bool) (*string, []Issue) {
	if raw == nil && nullable {
		return nil, nil
	}
	text, ok := raw.(string)
	if !ok {
		return nil, []Issue{TypeIssue("string", JSType(raw), path)}
	}
	if !isoDateTimePattern.MatchString(text) {
		return nil, []Issue{{
			"origin": "string", "code": "invalid_format", "format": "datetime",
			"pattern": "/" + isoDateTimeSource + "/", "path": path.json(), "message": "Invalid ISO datetime",
		}}
	}
	return &text, nil
}

// Enum validates z.enum([...]): anything else, whatever its type, is invalid_value.
func Enum(path Path, raw any, values ...string) (string, []Issue) {
	if text, ok := raw.(string); ok {
		for _, candidate := range values {
			if candidate == text {
				return text, nil
			}
		}
	}
	quoted := make([]string, len(values))
	for index, value := range values {
		quoted[index] = `"` + value + `"`
	}
	return "", []Issue{{
		"code": "invalid_value", "values": values, "path": path.json(),
		"message": "Invalid option: expected one of " + strings.Join(quoted, "|"),
	}}
}

// JSTrim is String.prototype.trim: ECMAScript WhiteSpace and LineTerminator.
func JSTrim(text string) string {
	return strings.TrimFunc(text, IsJSSpace)
}

// IsJSSpace is what the regular expression class \s matches, and what trim removes.
func IsJSSpace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ', 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff:
		return true
	}
	return r >= 0x2000 && r <= 0x200a
}
