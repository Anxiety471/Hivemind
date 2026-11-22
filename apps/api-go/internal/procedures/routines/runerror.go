package routines

import (
	"encoding/json"
	"strings"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/validate"
)

// runFailureErrorMax is RUN_FAILURE_ERROR_MAX (packages/core/src/messages/events.ts:295):
// a failed run's diagnostic is clamped to this many UTF-16 code units for display.
const runFailureErrorMax = 300

// runFailureError is runFailureError (events.ts:298): the reason a run failed, clamped and
// with each model's fallback diagnostic clamped too, or nil when there is nothing to show.
// The value is built as the JSON literal TypeScript's JSON.stringify writes, because a clamp
// that splits a surrogate pair leaves a code unit a Go string cannot hold.
func runFailureError(status string, message *string) *json.RawMessage {
	if status != "failed" || message == nil {
		return nil
	}
	text := validate.JSTrim(*message)
	if text == "" {
		return nil
	}
	if fallback, ok := parseModelFallbackFailure(text); ok {
		return rawMessage(quoteText(string(encodeFallback(fallback))))
	}
	return rawMessage(quoteUnits(clampUnits(text)))
}

// RunFailureError is runFailureError for the other procedures that show a run (threads.get).
func RunFailureError(status string, message *string) *json.RawMessage {
	return runFailureError(status, message)
}

// clampUnits is clampRunFailure: the first 300 UTF-16 code units and an ellipsis when the
// text was longer.
func clampUnits(text string) []uint16 {
	units, total := sliceUnits(text, runFailureErrorMax)
	if total > runFailureErrorMax {
		units = append(units, '…')
	}
	return units
}

// fallbackFailure is a persisted model fallback summary: parseModelFallbackFailure's result.
type fallbackFailure struct {
	primary []uint16
	backups []fallbackBackup
}

type fallbackBackup struct {
	// object is the stored outcome with its own key order; the spread in modelFallbackFailure
	// keeps every key, including ones this release does not know.
	object *validate.Object
	reason []uint16
}

// parseModelFallbackFailure is parseModelFallbackFailure (packages/core/src/runs/run-error.ts:186):
// a persisted fallback summary, or false for any other text.
func parseModelFallbackFailure(details string) (fallbackFailure, bool) {
	value, err := validate.DecodeAny([]byte(details))
	if err != nil {
		return fallbackFailure{}, false
	}
	record, ok := value.(*validate.Object)
	if !ok {
		return fallbackFailure{}, false
	}
	version, ok := record.Values["modelFallbackVersion"].(json.Number)
	if !ok {
		return fallbackFailure{}, false
	}
	parsedVersion, err := version.Float64()
	if err != nil || parsedVersion != 1 {
		return fallbackFailure{}, false
	}
	primary, ok := record.Values["primaryError"].(string)
	if !ok {
		return fallbackFailure{}, false
	}
	backups, ok := record.Values["backups"].([]any)
	if !ok || len(backups) == 0 {
		return fallbackFailure{}, false
	}
	parsed := make([]fallbackBackup, len(backups))
	for index, item := range backups {
		outcome, ok := item.(*validate.Object)
		if !ok {
			return fallbackFailure{}, false
		}
		reason, ok := outcome.Values["reason"].(string)
		if !ok {
			return fallbackFailure{}, false
		}
		for _, key := range []string{"provider", "modelId"} {
			if _, ok := outcome.Values[key].(string); !ok {
				return fallbackFailure{}, false
			}
		}
		status, ok := outcome.Values["status"].(string)
		if !ok || (status != "failed" && status != "skipped") {
			return fallbackFailure{}, false
		}
		parsed[index] = fallbackBackup{object: outcome, reason: clampUnits(reason)}
	}
	return fallbackFailure{primary: clampUnits(primary), backups: parsed}, true
}

// encodeFallback is modelFallbackFailure (run-error.ts:181): JSON.stringify of
// {modelFallbackVersion: 1, primaryError, backups}, each backup spread as stored with its
// reason clamped.
func encodeFallback(fallback fallbackFailure) []byte {
	var out strings.Builder
	out.WriteString(`{"modelFallbackVersion":1,"primaryError":`)
	out.Write(quoteUnits(fallback.primary))
	out.WriteString(`,"backups":[`)
	for index, backup := range fallback.backups {
		if index > 0 {
			out.WriteByte(',')
		}
		out.WriteByte('{')
		for keyIndex, key := range backup.object.Keys {
			if keyIndex > 0 {
				out.WriteByte(',')
			}
			out.Write(quoteText(key))
			out.WriteByte(':')
			if key == "reason" {
				out.Write(quoteUnits(backup.reason))
				continue
			}
			out.WriteString(validate.Stringify(backup.object.Values[key]))
		}
		out.WriteByte('}')
	}
	out.WriteString(`]}`)
	return []byte(out.String())
}

func rawMessage(value []byte) *json.RawMessage {
	raw := json.RawMessage(value)
	return &raw
}
