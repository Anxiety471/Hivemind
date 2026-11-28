package routines

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/orpc"
)

func TestParsePrepareReadsTheStoredSchema(t *testing.T) {
	// A stored value without args reads as the schema's default, {}.
	prepare := parsePrepare([]byte(`{"command":"fetch_status"}`))
	if prepare == nil || prepare.Command != "fetch_status" || prepare.Args == nil || len(prepare.Args) != 0 {
		t.Fatalf("default args = %+v", prepare)
	}
	body, err := json.Marshal(prepare)
	if err != nil {
		t.Fatal(err)
	}
	if string(body) != `{"command":"fetch_status","args":{}}` {
		t.Fatalf("prepare json = %s", body)
	}

	// Unknown keys are stripped, a __proto__ key is dropped at every level (zod's record
	// drops it), 1.0 prints as 1, and -0 as 0 (JSON.stringify's numbers).
	prepare = parsePrepare([]byte(`{"command":"fetch_status","extra":1,
		"args":{"n":1.0,"z":-0,"nested":{"__proto__":{"polluted":true},"k":true},
		"__proto__":{"polluted":true}}}`))
	if prepare == nil {
		t.Fatal("a valid prepare did not parse")
	}
	if len(prepare.Args) != 3 {
		t.Fatalf("args = %#v", prepare.Args)
	}
	if prepare.Args["n"] != float64(1) || prepare.Args["z"] != float64(0) {
		t.Fatalf("numbers = %#v", prepare.Args)
	}
	nested, ok := prepare.Args["nested"].(map[string]any)
	if !ok || len(nested) != 1 || nested["k"] != true {
		t.Fatalf("nested = %#v", prepare.Args["nested"])
	}
	body, err = json.Marshal(prepare)
	if err != nil {
		t.Fatal(err)
	}
	if string(body) != `{"command":"fetch_status","args":{"n":1,"nested":{"k":true},"z":0}}` {
		t.Fatalf("prepare json = %s", body)
	}
}

func TestParsePrepareRejectsWhatTheSchemaRejects(t *testing.T) {
	for name, stored := range map[string]string{
		"null":          `null`,
		"array":         `[]`,
		"string":        `"fetch_status"`,
		"no-command":    `{}`,
		"number":        `{"command":1}`,
		"empty":         `{"command":""}`,
		"uppercase":     `{"command":"Fetch"}`,
		"hyphen":        `{"command":"fetch-status"}`,
		"digit-first":   `{"command":"1fetch"}`,
		"too-long":      `{"command":"` + strings.Repeat("a", 49) + `"}`,
		"args-null":     `{"command":"fetch_status","args":null}`,
		"args-array":    `{"command":"fetch_status","args":[]}`,
		"args-string":   `{"command":"fetch_status","args":"x"}`,
		"args-number":   `{"command":"fetch_status","args":1}`,
		"command-space": `{"command":"fetch status"}`,
	} {
		if prepare := parsePrepare([]byte(stored)); prepare != nil {
			t.Errorf("%s parsed as %+v", name, prepare)
		}
	}
	if prepare := parsePrepare(nil); prepare != nil {
		t.Error("an empty column is not a prepare")
	}
	// 48 characters is the schema's maximum.
	longest := "a" + strings.Repeat("b", 47)
	if prepare := parsePrepare([]byte(`{"command":"` + longest + `"}`)); prepare == nil {
		t.Error("a 48-character name is valid")
	}
}

func TestParseSetPrepareInput(t *testing.T) {
	input, failure := parseSetPrepare(orpc.Input{Raw: json.RawMessage(`{"routineId":"r1","prepare":null}`)})
	if failure != nil || input.RoutineID != "r1" || input.Prepare != nil {
		t.Fatalf("null = %+v %v", input, failure)
	}

	input, failure = parseSetPrepare(orpc.Input{Raw: json.RawMessage(`{"routineId":"r1",
		"prepare":{"command":"fetch_status","unknown":true,
		"args":{"q":"x","deep":{"__proto__":1,"ok":true}}},"extra":true}`)})
	if failure != nil || input.Prepare == nil || input.Prepare.Command != "fetch_status" {
		t.Fatalf("prepare = %+v %v", input, failure)
	}
	args, err := json.Marshal(input.Prepare.Args)
	if err != nil {
		t.Fatal(err)
	}
	if string(args) != `{"deep":{"ok":true},"q":"x"}` {
		t.Fatalf("args = %s", args)
	}

	// A missing args is the schema's default, {}, and the shortest name is valid.
	input, failure = parseSetPrepare(orpc.Input{Raw: json.RawMessage(`{"routineId":"r1","prepare":{"command":"a"}}`)})
	if failure != nil || input.Prepare == nil || input.Prepare.Args == nil || len(input.Prepare.Args) != 0 {
		t.Fatalf("default args = %+v %v", input, failure)
	}
}

func TestParseSetPrepareRejectsWhatTheSchemaRejects(t *testing.T) {
	for name, raw := range map[string]string{
		"no-input":       ``,
		"null":           `null`,
		"array":          `[]`,
		"no-routine":     `{}`,
		"empty-routine":  `{"routineId":""}`,
		"number-routine": `{"routineId":5,"prepare":null}`,
		"no-prepare":     `{"routineId":"r1"}`,
		"prepare-string": `{"routineId":"r1","prepare":"fetch"}`,
		"prepare-array":  `{"routineId":"r1","prepare":[]}`,
		"no-command":     `{"routineId":"r1","prepare":{}}`,
		"number-command": `{"routineId":"r1","prepare":{"command":5}}`,
		"bad-command":    `{"routineId":"r1","prepare":{"command":"Fetch"}}`,
		"long-command":   `{"routineId":"r1","prepare":{"command":"` + strings.Repeat("a", 49) + `"}}`,
		"null-args":      `{"routineId":"r1","prepare":{"command":"ok","args":null}}`,
		"array-args":     `{"routineId":"r1","prepare":{"command":"ok","args":[]}}`,
		"string-args":    `{"routineId":"r1","prepare":{"command":"ok","args":"x"}}`,
		"number-args":    `{"routineId":"r1","prepare":{"command":"ok","args":1}}`,
	} {
		_, failure := parseSetPrepare(orpc.Input{Raw: json.RawMessage(raw)})
		if failure == nil || failure.Code != "BAD_REQUEST" || failure.Status != 400 {
			t.Errorf("%s = %v", name, failure)
		}
	}

	// Every failing field is reported in zod's order: routineId, then prepare's command.
	_, failure := parseSetPrepare(orpc.Input{Raw: json.RawMessage(`{}`)})
	if failure == nil {
		t.Fatal("no failure")
	}
	issues, _ := failure.Data.(map[string]any)["issues"].([]map[string]any)
	if len(issues) != 2 {
		t.Fatalf("issues = %v", issues)
	}
	if issues[0]["code"] != "invalid_type" || issues[0]["expected"] != "string" ||
		issues[0]["message"] != "Invalid input: expected string, received undefined" ||
		issues[1]["code"] != "invalid_type" || issues[1]["expected"] != "object" ||
		issues[1]["message"] != "Invalid input: expected object, received undefined" {
		t.Fatalf("issues = %v", issues)
	}
	if path, _ := issues[1]["path"].([]any); len(path) != 1 || path[0] != "prepare" {
		t.Fatalf("prepare path = %v", issues[1]["path"])
	}

	// The regex issue is zod's invalid_format, with the pattern as zod prints it.
	_, failure = parseSetPrepare(orpc.Input{Raw: json.RawMessage(`{"routineId":"r1","prepare":{"command":"Fetch"}}`)})
	issues, _ = failure.Data.(map[string]any)["issues"].([]map[string]any)
	if len(issues) != 1 || issues[0]["code"] != "invalid_format" || issues[0]["format"] != "regex" ||
		issues[0]["pattern"] != prepareCommandSource ||
		issues[0]["message"] != "Invalid string: must match pattern "+prepareCommandSource {
		t.Fatalf("regex issue = %v", issues)
	}

	// A record's type check names "record", not "object".
	_, failure = parseSetPrepare(orpc.Input{Raw: json.RawMessage(`{"routineId":"r1","prepare":{"command":"ok","args":[]}}`)})
	issues, _ = failure.Data.(map[string]any)["issues"].([]map[string]any)
	if len(issues) != 1 || issues[0]["expected"] != "record" ||
		issues[0]["message"] != "Invalid input: expected record, received array" {
		t.Fatalf("record issue = %v", issues)
	}
}

func TestPrepareDocumentWritesJSONStringifyNumbers(t *testing.T) {
	if document := prepareDocument(nil); document != nil {
		t.Fatalf("clearing wrote %v", document)
	}
	input, failure := parseSetPrepare(orpc.Input{Raw: json.RawMessage(`{"routineId":"r1",
		"prepare":{"command":"fetch","args":{"n":1.50,"big":12345678901234567890,"neg":-0,"s":"<&>"}}}`)})
	if failure != nil || input.Prepare == nil {
		t.Fatalf("input = %+v %v", input, failure)
	}
	document, ok := prepareDocument(input.Prepare).(string)
	if !ok {
		t.Fatalf("document = %v", prepareDocument(input.Prepare))
	}
	want := `{"args":{"big":12345678901234567000,"n":1.5,"neg":0,"s":"<&>"},"command":"fetch"}`
	if document != want {
		t.Fatalf("document = %s", document)
	}
}

func TestParseCommandsInput(t *testing.T) {
	for _, raw := range []string{`{}`, `{"anything":1}`, `{"spaceId":"s1"}`} {
		if failure := parseCommands(orpc.Input{Raw: json.RawMessage(raw)}); failure != nil {
			t.Errorf("%s = %v", raw, failure)
		}
	}
	for name, raw := range map[string]string{
		"no-input": ``,
		"null":     `null`,
		"array":    `[]`,
		"string":   `"x"`,
		"number":   `1`,
	} {
		failure := parseCommands(orpc.Input{Raw: json.RawMessage(raw)})
		if failure == nil || failure.Code != "BAD_REQUEST" {
			t.Errorf("%s = %v", name, failure)
		}
	}
}
