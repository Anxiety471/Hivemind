package routines

import (
	"encoding/json"
	"math"
	"net/url"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/validate"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/wtf8"
)

// Watch is the wire shape of RoutineWatchSchema (packages/contracts/src/routines/routine-watch.ts:35).
// Zod parses a stored value through the schema on every read, which applies the defaults,
// trims the strings, drops unknown keys and rejects a value that does not fit; the field
// order here is the schema's declaration order.
type Watch struct {
	Kind         string          `json:"kind"`
	Paths        []string        `json:"paths,omitempty"`
	Command      *string         `json:"command,omitempty"`
	Tool         *string         `json:"tool,omitempty"`
	URL          *string         `json:"url,omitempty"`
	Args         *map[string]any `json:"args,omitempty"`
	Track        []string        `json:"track,omitempty"`
	EveryMinutes int             `json:"everyMinutes"`
	Loud         bool            `json:"loud"`
}

// WatchState is the wire shape of RoutineWatchStateSchema (routine-watch.ts:88).
type WatchState struct {
	CheckedAt   string             `json:"checkedAt"`
	Outcome     string             `json:"outcome"`
	Retrying    *bool              `json:"retrying,omitempty"`
	Fingerprint *string            `json:"fingerprint"`
	Entries     *map[string]string `json:"entries,omitempty"`
	Detail      *string            `json:"detail"`
}

// watchKinds and watchOutcomes are ROUTINE_WATCH_KINDS and ROUTINE_WATCH_OUTCOMES.
var watchKinds = []string{"files", "command", "tool", "http"}

var watchOutcomes = []string{"baseline", "unchanged", "changed", "failed"}

// Watch defaults, from ROUTINE_WATCH_DEFAULT_MINUTES and ROUTINE_WATCH_MIN_MINUTES.
const (
	watchDefaultMinutes = 15
	watchMinMinutes     = 5
	watchMaxMinutes     = 1440
)

// parseWatch is parseRoutineWatch (packages/adapters/src/routines/routine-watch.ts:110):
// the stored change trigger as the schema reads it, or nil when the column is empty or the
// value no longer fits the schema.
func parseWatch(raw []byte) *Watch {
	value, ok := decodeJSON(raw)
	if !ok {
		return nil
	}
	object, ok := value.(map[string]any)
	if !ok {
		return nil
	}
	kind, ok := object["kind"].(string)
	if !ok || !contains(watchKinds, kind) {
		return nil
	}
	watch := &Watch{Kind: kind, EveryMinutes: watchDefaultMinutes}
	if paths, present := object["paths"]; present {
		items, ok := paths.([]any)
		if !ok || len(items) == 0 || len(items) > 20 {
			return nil
		}
		for _, item := range items {
			text, ok := item.(string)
			if !ok {
				return nil
			}
			text = validate.JSTrim(text)
			if !wtf8.Fits(text, 1, 500) {
				return nil
			}
			watch.Paths = append(watch.Paths, text)
		}
	}
	if command, ok := optionalText(object, "command", 1, 2000); !ok {
		return nil
	} else if command != nil {
		watch.Command = command
	}
	if tool, ok := optionalText(object, "tool", 1, 200); !ok {
		return nil
	} else if tool != nil {
		watch.Tool = tool
	}
	if endpoint, ok := optionalText(object, "url", 1, 2000); !ok {
		return nil
	} else if endpoint != nil {
		watch.URL = endpoint
	}
	if args, present := object["args"]; present {
		record, ok := args.(map[string]any)
		if !ok {
			return nil
		}
		normalizeZero(record)
		watch.Args = &record
	}
	if track, present := object["track"]; present {
		items, ok := track.([]any)
		if !ok || len(items) == 0 || len(items) > 5 {
			return nil
		}
		for _, item := range items {
			text, ok := item.(string)
			if !ok {
				return nil
			}
			text = validate.JSTrim(text)
			if !wtf8.Fits(text, 1, 100) {
				return nil
			}
			watch.Track = append(watch.Track, text)
		}
	}
	if minutes, present := object["everyMinutes"]; present {
		number, ok := minutes.(float64)
		if !ok || number != math.Trunc(number) || number < watchMinMinutes || number > watchMaxMinutes {
			return nil
		}
		watch.EveryMinutes = int(number)
	}
	if loud, present := object["loud"]; present {
		flag, ok := loud.(bool)
		if !ok {
			return nil
		}
		watch.Loud = flag
	}
	// The schema's superRefine: the fields the chosen kind needs, and the ones it forbids.
	switch kind {
	case "files":
		if len(watch.Paths) == 0 || watch.Track != nil {
			return nil
		}
	case "command":
		if watch.Command == nil {
			return nil
		}
	case "tool":
		if watch.Tool == nil {
			return nil
		}
	case "http":
		if watch.URL == nil || !watchEndpoint(*watch.URL) {
			return nil
		}
	}
	return watch
}

// normalizeZero rewrites a nested -0 as 0: JSON.stringify writes -0 as "0", while Go's
// JSON encoder keeps the sign.
func normalizeZero(value any) {
	switch typed := value.(type) {
	case map[string]any:
		for key, item := range typed {
			typed[key] = zeroNormalized(item)
		}
	case []any:
		for index, item := range typed {
			typed[index] = zeroNormalized(item)
		}
	}
}

func zeroNormalized(value any) any {
	if number, ok := value.(float64); ok && number == 0 && math.Signbit(number) {
		return float64(0)
	}
	normalizeZero(value)
	return value
}

// optionalText is one of the schema's trimmed bounded strings: text is nil for an absent key,
// and ok is false for a value the schema rejects.
func optionalText(object map[string]any, key string, minLength, maxLength int) (text *string, ok bool) {
	value, present := object[key]
	if !present {
		return nil, true
	}
	raw, isText := value.(string)
	if !isText {
		return nil, false
	}
	raw = validate.JSTrim(raw)
	if !wtf8.Fits(raw, minLength, maxLength) {
		return nil, false
	}
	return &raw, true
}

// watchEndpoint is the schema's http check: `new URL(url)` is https, with no credentials,
// fragment or port of its own.
func watchEndpoint(text string) bool {
	parsed, err := url.Parse(text)
	if err != nil {
		return false
	}
	if parsed.Scheme != "https" || parsed.Opaque != "" || parsed.Host == "" {
		return false
	}
	if parsed.User != nil {
		password, hasPassword := parsed.User.Password()
		if parsed.User.Username() != "" || (hasPassword && password != "") {
			return false
		}
	}
	if parsed.Fragment != "" {
		return false
	}
	// URL drops a scheme's default port, so an explicit :443 is not a port of its own.
	if port := parsed.Port(); port != "" && port != "443" {
		return false
	}
	return true
}

// parseWatchState is parseRoutineWatchState (routine-watch.ts:116): the last check's
// result, or nil when the column is empty or the value no longer fits the schema.
func parseWatchState(raw []byte) *WatchState {
	value, ok := decodeJSON(raw)
	if !ok {
		return nil
	}
	object, ok := value.(map[string]any)
	if !ok {
		return nil
	}
	state := &WatchState{}
	checkedAt, ok := object["checkedAt"].(string)
	if !ok {
		return nil
	}
	state.CheckedAt = checkedAt
	outcome, ok := object["outcome"].(string)
	if !ok || !contains(watchOutcomes, outcome) {
		return nil
	}
	state.Outcome = outcome
	if retrying, present := object["retrying"]; present {
		flag, ok := retrying.(bool)
		if !ok {
			return nil
		}
		state.Retrying = &flag
	}
	fingerprint, present := object["fingerprint"]
	if !present {
		return nil
	}
	switch typed := fingerprint.(type) {
	case nil:
	case string:
		state.Fingerprint = &typed
	default:
		return nil
	}
	if entries, present := object["entries"]; present {
		record, ok := entries.(map[string]any)
		if !ok {
			return nil
		}
		parsed := make(map[string]string, len(record))
		for key, entry := range record {
			text, ok := entry.(string)
			if !ok {
				return nil
			}
			parsed[key] = text
		}
		state.Entries = &parsed
	}
	detail, present := object["detail"]
	if !present {
		return nil
	}
	switch typed := detail.(type) {
	case nil:
	case string:
		state.Detail = &typed
	default:
		return nil
	}
	return state
}

// decodeJSON unmarshals a stored jsonb value; an empty column or unreadable text is not a value.
func decodeJSON(raw []byte) (any, bool) {
	if len(raw) == 0 {
		return nil, false
	}
	var value any
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil, false
	}
	return value, true
}

func contains(values []string, value string) bool {
	for _, candidate := range values {
		if candidate == value {
			return true
		}
	}
	return false
}
