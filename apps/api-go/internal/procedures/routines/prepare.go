package routines

import (
	"regexp"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/validate"
)

// The routine prepare step: a saved command (table code_commands) the worker runs read-only
// before the routine's model (packages/contracts/src/routines/routine-prepare.ts).
// routines.setPrepare names it and routines.commands lists what the editor can pick; the run
// side lives in the worker (packages/adapters/src/runs/assembly/run-routine-prepare.ts).

// prepareCommandSource is CODE_COMMAND_NAME_PATTERN as zod prints it in an invalid_format
// issue; it is the check itself too.
const prepareCommandSource = `/^[a-z][a-z0-9_]{0,47}$/`

// prepareCommandPattern is CODE_COMMAND_NAME_PATTERN: the name after `codemode.cmd.`.
var prepareCommandPattern = regexp.MustCompile(`^[a-z][a-z0-9_]{0,47}$`)

// Prepare is the wire shape of RoutinePrepareSchema (routine-prepare.ts:12), in the schema's
// declaration order. Args is always an object, `{}` when the routine passes none.
type Prepare struct {
	Command string         `json:"command"`
	Args    map[string]any `json:"args"`
}

// parsePrepare is RoutinePrepareSchema.safeParse on the stored column: the saved command as the
// schema reads it, or nil when the column is empty or the value no longer fits. Zod strips
// unknown keys (only command and args are emitted anyway), defaults args to {}, and never keeps
// a __proto__ record key.
func parsePrepare(raw []byte) *Prepare {
	value, ok := decodeJSON(raw)
	if !ok {
		return nil
	}
	object, ok := value.(map[string]any)
	if !ok {
		return nil
	}
	command, ok := object["command"].(string)
	if !ok || !prepareCommandPattern.MatchString(command) {
		return nil
	}
	prepare := &Prepare{Command: command, Args: map[string]any{}}
	if args, present := object["args"]; present {
		record, ok := storedRecord(args)
		if !ok {
			return nil
		}
		prepare.Args = record
	}
	return prepare
}

// storedRecord is a z.record(z.string(), z.json()) read from a decoded column value: nested -0
// reads as 0 (JSON.stringify writes it so), and recordValue shapes the object.
func storedRecord(value any) (map[string]any, bool) {
	object, ok := value.(map[string]any)
	if !ok {
		return nil, false
	}
	normalizeZero(object)
	record, _ := recordValue(object).(map[string]any)
	return record, true
}

// storedParameters is CodeCommand.parameters (a JSON Schema object) as the routine editor lists
// it, or nil when the column is empty or the value is not an object. listCodeCommands reads the
// column through the same record schema and drops a value that fails it
// (packages/adapters/src/tools/code-commands.ts:75-87).
func storedParameters(raw []byte) map[string]any {
	value, ok := decodeJSON(raw)
	if !ok {
		return nil
	}
	record, ok := storedRecord(value)
	if !ok {
		return nil
	}
	return record
}

// recordValue is a z.record(z.string(), z.json()) value as the API stores and answers it:
// objects become maps, arrays recurse, and a __proto__ key is dropped at every level — zod's
// record skips it so a value cannot rewrite a result's prototype. Numbers pass through as they
// were decoded (json.Number from a request, float64 from a column).
func recordValue(value any) any {
	switch typed := value.(type) {
	case map[string]any:
		out := make(map[string]any, len(typed))
		for key, item := range typed {
			if key == "__proto__" {
				continue
			}
			out[key] = recordValue(item)
		}
		return out
	case *validate.Object:
		out := make(map[string]any, len(typed.Keys))
		for _, key := range typed.Keys {
			if key == "__proto__" {
				continue
			}
			out[key] = recordValue(typed.Values[key])
		}
		return out
	case []any:
		out := make([]any, len(typed))
		for index, item := range typed {
			out[index] = recordValue(item)
		}
		return out
	default:
		return value
	}
}
