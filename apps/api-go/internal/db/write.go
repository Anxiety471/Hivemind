package db

import (
	"database/sql/driver"
	"encoding/json"
	"strconv"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/validate"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/wtf8"
)

// Text is a string written as a Prisma `data` value: at encode time NUL and an
// unpaired UTF-16 surrogate become U+FFFD (sanitizeUtf16ForJson,
// packages/core/src/messages/events.ts:640-645), exactly as sanitizeWriteArgs
// does before Prisma's driver sees the value. A WHERE value is never wrapped:
// it is a filter, and PostgreSQL must reject NUL in it as TypeScript sees.
type Text string

// Value implements driver.Valuer; pgx encodes the sanitized string.
func (t Text) Value() (driver.Value, error) { return wtf8.SanitizeText(string(t)), nil }

// Data marks the payload arguments of an INSERT or UPDATE. Every string becomes
// a Text value; every other argument (numbers, timestamps, bytea ciphertext,
// already-sanitized JSON text) passes through untouched. Use it for the
// VALUES list and the SET clause, never for WHERE.
func Data(values ...any) []any {
	out := make([]any, len(values))
	for index, value := range values {
		out[index] = dataValue(value)
	}
	return out
}

// dataValue applies the same recursion Prisma's sanitizeValue does for a write
// argument: strings become Text, and a string array is sanitized element by
// element (pgx needs a plain []string for a text[] column).
func dataValue(value any) any {
	switch typed := value.(type) {
	case string:
		return Text(typed)
	case *string:
		if typed == nil {
			return nil
		}
		return Text(*typed)
	case []*string:
		out := make([]any, len(typed))
		for index, item := range typed {
			out[index] = dataValue(item)
		}
		return out
	case []string:
		out := make([]string, len(typed))
		for index, item := range typed {
			out[index] = wtf8.SanitizeText(item)
		}
		return out
	case []any:
		out := make([]any, len(typed))
		for index, item := range typed {
			out[index] = dataValue(item)
		}
		return out
	}
	return value
}

// JSON is a Go value stored in a json/jsonb column. Prisma sanitizes a JSON
// write argument recursively: every string leaf and key becomes U+FFFD for NUL
// or an unpaired surrogate, and keys that collide after that get the
// deterministic "#n" suffix in the object's own key order
// (sanitizeJsonValue, packages/core/src/messages/events.ts:648-671).
func JSON(value any) string {
	body, err := wtf8.Marshal(value)
	if err != nil {
		fallback, _ := json.Marshal(value)
		return string(fallback)
	}
	return JSONText(string(body))
}

// JSONText is a JSON document that already exists as text (wtf8.Marshal output,
// a policies payload). It is parsed with the WTF-8 boundary and JSON.stringify's
// number rules (validate.DecodeAny), sanitized per leaf in the document's key
// order, and written back compactly, so a WTF-8 surrogate becomes one U+FFFD
// rather than the three the standard encoder writes for its bytes.
func JSONText(text string) string {
	value, err := validate.DecodeAny([]byte(text))
	if err != nil {
		return text
	}
	return validate.Stringify(sanitizeJSONValue(value))
}

// sanitizeJSONValue is sanitizeJsonValue with the write hook applied: strings
// become U+FFFD, arrays recurse, and objects recurse keys with a "#n" suffix for
// a collision after replacement. Go maps have no insertion order, so keys are
// visited sorted, which makes the suffix deterministic.
func sanitizeJSONValue(value any) any {
	switch typed := value.(type) {
	case string:
		return wtf8.SanitizeText(typed)
	case []any:
		out := make([]any, len(typed))
		for index, item := range typed {
			out[index] = sanitizeJSONValue(item)
		}
		return out
	case *validate.Object:
		out := &validate.Object{Keys: make([]string, 0, len(typed.Keys)), Values: map[string]any{}}
		used := make(map[string]int, len(typed.Keys))
		for _, key := range typed.Keys {
			safe := wtf8.SanitizeText(key)
			seen := used[safe]
			used[safe] = seen + 1
			if seen > 0 {
				safe += "#" + strconv.Itoa(seen+1)
			}
			out.Keys = append(out.Keys, safe)
			out.Values[safe] = sanitizeJSONValue(typed.Values[key])
		}
		return out
	}
	return value
}
