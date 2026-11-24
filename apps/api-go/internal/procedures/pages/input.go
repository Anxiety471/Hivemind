package pages

import (
	"bytes"
	"encoding/json"
	"io"
	"math"
	"sort"
	"strconv"
	"strings"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/orpc"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/wtf8"
)

const (
	pageListMaxLimit = 60
	cursorMaxLength  = 500
	queryMaxLength   = 200
)

// ListInput is pages.list's validated input.
type ListInput struct {
	BotID   string
	GroupID string
	Cursor  string
	Limit   int
	Query   string
	// Presence flags: validation guarantees a present string is non-empty.
	HasBotID, HasGroupID, HasCursor, HasLimit, HasQuery bool
}

// parseList mirrors
//
//	z.strictObject({ botId: Id.optional(), groupId: Id.optional(),
//	  cursor: z.string().max(500).optional(), limit: z.number().int().min(1).max(60).optional(),
//	  query: z.string().trim().min(1).max(200).optional() })
//
// and reports every issue, in zod's order: shape keys first, then unrecognized keys.
func parseList(input orpc.Input) (ListInput, *orpc.Error) {
	var parsed ListInput
	if len(input.Raw) == 0 {
		return parsed, invalid(typeIssue("object", "undefined"))
	}
	keys, values, err := decodeObject(input.Raw)
	if err != nil {
		return parsed, orpc.BadRequest("Malformed request.")
	}
	if values == nil {
		var any any
		dec := json.NewDecoder(bytes.NewReader(input.Raw))
		dec.UseNumber()
		_ = dec.Decode(&any)
		return parsed, invalid(typeIssue("object", jsType(any)))
	}
	var issues []map[string]any

	for _, field := range []string{"botId", "groupId"} {
		raw, ok := values[field]
		if !ok {
			continue
		}
		text, found := stringValue(raw, field, 1, 0)
		if found == nil && !wtf8.ZodMinPass(text, 1) {
			found = []map[string]any{tooSmallString(field, 1)}
		}
		if found != nil {
			issues = append(issues, found...)
			continue
		}
		if field == "botId" {
			parsed.BotID, parsed.HasBotID = text, true
		} else {
			parsed.GroupID, parsed.HasGroupID = text, true
		}
	}
	if raw, ok := values["cursor"]; ok {
		text, found := stringValue(raw, "cursor", 0, cursorMaxLength)
		if found == nil && !wtf8.ZodMaxPass(text, cursorMaxLength) {
			found = []map[string]any{tooBigString("cursor", cursorMaxLength)}
		}
		if found != nil {
			issues = append(issues, found...)
		} else {
			// An empty cursor is falsy in the handler (`input.cursor ?`), so it is no cursor.
			parsed.Cursor, parsed.HasCursor = text, text != ""
		}
	}
	if raw, ok := values["limit"]; ok {
		limit, found := numberIssues("limit", raw)
		if len(found) > 0 {
			issues = append(issues, found...)
		} else {
			parsed.Limit, parsed.HasLimit = limit, true
		}
	}
	if raw, ok := values["query"]; ok {
		text, found := stringValue(raw, "query", 1, queryMaxLength)
		if found == nil {
			text = jsTrim(text)
			// min and max both run on the trimmed text; at most one can fail.
			if !wtf8.ZodMinPass(text, 1) {
				found = []map[string]any{tooSmallString("query", 1)}
			} else if !wtf8.ZodMaxPass(text, queryMaxLength) {
				found = []map[string]any{tooBigString("query", queryMaxLength)}
			}
		}
		if found != nil {
			issues = append(issues, found...)
		} else {
			parsed.Query, parsed.HasQuery = text, true
		}
	}
	var unknown []string
	for _, key := range keys {
		switch key {
		case "botId", "groupId", "cursor", "limit", "query":
		default:
			unknown = append(unknown, key)
		}
	}
	if len(unknown) > 0 {
		quoted := make([]string, len(unknown))
		for index, key := range unknown {
			quoted[index] = `"` + key + `"`
		}
		label := "key"
		if len(unknown) > 1 {
			label = "keys"
		}
		issues = append(issues, map[string]any{
			"code": "unrecognized_keys", "keys": unknown, "path": []string{},
			"message": "Unrecognized " + label + ": " + strings.Join(quoted, ", "),
		})
	}
	if len(issues) > 0 {
		return ListInput{}, invalid(issues...)
	}
	return parsed, nil
}

func invalid(issues ...map[string]any) *orpc.Error { return orpc.InvalidInput(issues...) }

func typeIssue(expected, received string, path ...string) map[string]any {
	if path == nil {
		path = []string{}
	}
	return map[string]any{
		"expected": expected, "code": "invalid_type", "path": path,
		"message": "Invalid input: expected " + expected + ", received " + received,
	}
}

// stringValue checks the type of a z.string() field. Zod still runs the length
// checks on a non-string that has a length (an array, or an object with a
// "length" key), so those add their own issues after the type issue.
func stringValue(raw any, field string, minimum, maximum int) (string, []map[string]any) {
	text, ok := raw.(string)
	if ok {
		return text, nil
	}
	issues := []map[string]any{typeIssue("string", jsType(raw), field)}
	length, origin, has := lengthOf(raw)
	if !has {
		return "", issues
	}
	if minimum > 0 && !(length >= float64(minimum)) {
		issues = append(issues, map[string]any{
			"origin": origin, "code": "too_small", "minimum": minimum, "inclusive": true, "path": []string{field},
			"message": "Too small: expected " + origin + " to " + sizing(origin, ">=", minimum),
		})
	}
	if maximum > 0 && !(length <= float64(maximum)) {
		issues = append(issues, map[string]any{
			"origin": origin, "code": "too_big", "maximum": maximum, "inclusive": true, "path": []string{field},
			"message": "Too big: expected " + origin + " to " + sizing(origin, "<=", maximum),
		})
	}
	return "", issues
}

func sizing(origin, comparison string, limit int) string {
	if origin == "array" {
		return "have " + comparison + strconv.Itoa(limit) + " items"
	}
	return "be " + comparison + strconv.Itoa(limit)
}

// lengthOf is `value.length` for a decoded JSON value, read as a number the way
// a comparison does; has is false when the value has no length.
func lengthOf(raw any) (length float64, origin string, has bool) {
	switch value := raw.(type) {
	case []any:
		return float64(len(value)), "array", true
	case map[string]any:
		field, ok := value["length"]
		if !ok {
			return 0, "", false
		}
		switch number := field.(type) {
		case json.Number:
			parsed, err := strconv.ParseFloat(number.String(), 64)
			if err != nil {
				parsed = math.NaN()
			}
			return parsed, "unknown", true
		case nil:
			return 0, "unknown", true
		case bool:
			if number {
				return 1, "unknown", true
			}
			return 0, "unknown", true
		default:
			return math.NaN(), "unknown", true
		}
	}
	return 0, "", false
}

func tooSmallString(field string, minimum int) map[string]any {
	return map[string]any{
		"origin": "string", "code": "too_small", "minimum": minimum, "inclusive": true,
		"path": []string{field}, "message": "Too small: expected string to have >=" + strconv.Itoa(minimum) + " characters",
	}
}

func tooBigString(field string, maximum int) map[string]any {
	return map[string]any{
		"origin": "string", "code": "too_big", "maximum": maximum, "inclusive": true,
		"path": []string{field}, "message": "Too big: expected string to have <=" + strconv.Itoa(maximum) + " characters",
	}
}

// numberIssues validates z.number().int().min(1).max(60).
func numberIssues(field string, raw any) (int, []map[string]any) {
	number, ok := raw.(json.Number)
	if !ok {
		return 0, []map[string]any{typeIssue("number", jsType(raw), field)}
	}
	value, err := strconv.ParseFloat(number.String(), 64)
	if err != nil {
		// Out of float64 range: JSON.parse reads it as Infinity, which is not a finite number.
		value = math.Inf(1)
		if strings.HasPrefix(number.String(), "-") {
			value = math.Inf(-1)
		}
	}
	path := []string{field}
	if math.IsInf(value, 0) {
		// z.number() refuses Infinity as an invalid_type, with the value named in the message.
		name := "Infinity"
		if value < 0 {
			name = "-Infinity"
		}
		return 0, []map[string]any{{
			"expected": "number", "code": "invalid_type", "path": path,
			"message": "Invalid input: expected number, received " + name,
		}}
	}
	var issues []map[string]any
	if value != math.Trunc(value) {
		// An integer check that fails stops the checks after it.
		return 0, []map[string]any{{
			"expected": "int", "format": "safeint", "code": "invalid_type", "path": path,
			"message": "Invalid input: expected int, received number",
		}}
	}
	if math.Abs(value) > 9007199254740991 {
		if value > 0 {
			issues = append(issues, map[string]any{
				"code": "too_big", "maximum": int64(9007199254740991), "note": "Integers must be within the safe integer range.",
				"origin": "int", "inclusive": true, "path": path,
				"message": "Too big: expected int to be <=9007199254740991",
			})
		} else {
			issues = append(issues, map[string]any{
				"code": "too_small", "minimum": int64(-9007199254740991), "note": "Integers must be within the safe integer range.",
				"origin": "int", "inclusive": true, "path": path,
				"message": "Too small: expected int to be >=-9007199254740991",
			})
		}
	}
	if value < 1 {
		issues = append(issues, map[string]any{
			"origin": "number", "code": "too_small", "minimum": 1, "inclusive": true, "path": path,
			"message": "Too small: expected number to be >=1",
		})
	}
	if value > pageListMaxLimit {
		issues = append(issues, map[string]any{
			"origin": "number", "code": "too_big", "maximum": pageListMaxLimit, "inclusive": true, "path": path,
			"message": "Too big: expected number to be <=60",
		})
	}
	if len(issues) > 0 {
		return 0, issues
	}
	return int(value), nil
}

// decodeObject reads a JSON object keeping JavaScript's key order (integer-like
// keys first, ascending; then insertion order, last duplicate winning). values
// is nil when the document is not an object.
func decodeObject(raw []byte) (keys []string, values map[string]any, err error) {
	if wtf8.NeedsTransform(raw) {
		if transformed, transformErr := wtf8.Transform(raw); transformErr == nil {
			raw = transformed
		}
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	first, err := dec.Token()
	if err != nil {
		return nil, nil, err
	}
	if delim, ok := first.(json.Delim); !ok || delim != '{' {
		return nil, nil, nil
	}
	values = map[string]any{}
	var order []string
	for dec.More() {
		keyToken, err := dec.Token()
		if err != nil {
			return nil, nil, err
		}
		key := wtf8.RestoreString(keyToken.(string))
		var value any
		if err := dec.Decode(&value); err != nil {
			return nil, nil, err
		}
		value = wtf8.RestoreValue(value)
		if _, seen := values[key]; !seen {
			order = append(order, key)
		}
		values[key] = value
	}
	if _, err := dec.Token(); err != nil {
		return nil, nil, err
	}
	if _, err := dec.Token(); err != io.EOF {
		return nil, nil, io.ErrUnexpectedEOF
	}
	var indexed []string
	var named []string
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
	return append(indexed, named...), values, nil
}

func isArrayIndex(key string) bool {
	if key == "" || (len(key) > 1 && key[0] == '0') {
		return false
	}
	number, err := strconv.ParseUint(key, 10, 64)
	return err == nil && number < 4294967295
}

// jsType names a decoded JSON value the way zod's parsedType does.
func jsType(value any) string {
	switch value.(type) {
	case nil:
		return "null"
	case []any:
		return "array"
	case map[string]any:
		return "object"
	case string:
		return "string"
	case bool:
		return "boolean"
	default:
		return "number"
	}
}

// jsTrim is String.prototype.trim: ECMAScript WhiteSpace and LineTerminator.
func jsTrim(text string) string {
	return strings.TrimFunc(text, func(r rune) bool {
		switch r {
		case '\t', '\n', '\v', '\f', '\r', ' ', 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff:
			return true
		}
		return r >= 0x2000 && r <= 0x200a
	})
}
