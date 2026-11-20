package skills

import (
	"encoding/json"
	"testing"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/orpc"
)

func input(text string) orpc.Input { return orpc.Input{Raw: json.RawMessage(text)} }

func TestParsePlaybookCoercesLikeTypeScript(t *testing.T) {
	playbook := parsePlaybook(map[string]any{
		"whenToUse": "when", "inputs": []any{"a", json.Number("2"), true},
		"steps": []any{}, "howToCheck": nil, "whatToReturn": "back",
	})
	if playbook.WhenToUse != "when" || playbook.HowToCheck != "" {
		t.Fatalf("playbook = %+v", playbook)
	}
	if len(playbook.Inputs) != 3 || playbook.Inputs[1] != "2" || playbook.Inputs[2] != "true" {
		t.Fatalf("inputs = %v", playbook.Inputs)
	}
	// Not an object: every field is empty, as buildPlaybookFromRecording("", []) gives.
	if empty := parsePlaybook("nope"); empty.WhenToUse != "" || len(empty.Steps) != 0 {
		t.Fatalf("empty playbook = %+v", empty)
	}
}

func TestJsStringIsJavaScriptString(t *testing.T) {
	cases := []struct {
		value any
		want  string
	}{
		{"text", "text"},
		{nil, "null"},
		{true, "true"},
		{false, "false"},
		{json.Number("7"), "7"},
		{[]any{"a", json.Number("1")}, "a,1"},
		{map[string]any{"k": "v"}, "[object Object]"},
	}
	for _, c := range cases {
		if got := jsString(c.value); got != c.want {
			t.Errorf("%v: got %q want %q", c.value, got, c.want)
		}
	}
}

func TestSliceUTF16CountsCodeUnits(t *testing.T) {
	if got := sliceUTF16("abcdef", 0, 3); got != "abc" {
		t.Fatalf("got %q", got)
	}
	// An astral character is two units, so a slice between its halves cannot include it.
	if got := sliceUTF16("😀😀", 0, 2); got != "😀" {
		t.Fatalf("got %q", got)
	}
	// A start inside a pair cannot exist in a Go string: the helper never splits one, where
	// JavaScript's slice would hand back an unpaired surrogate.
	if got := sliceUTF16("😀x", 1, 3); got != "😀x" {
		t.Fatalf("got %q", got)
	}
	if got := sliceUTF16("short", 0, 80); got != "short" {
		t.Fatalf("got %q", got)
	}
}

func TestOutputValidChecksTheStoredRows(t *testing.T) {
	valid := Skill{
		ID: "s", BotID: "b", Status: "draft",
		Recording: Recording{Events: []any{}, Snapshots: []any{}},
	}
	if !outputValid(valid) {
		t.Fatal("a draft with an empty recording is valid")
	}
	bad := valid
	bad.Status = "weird"
	if outputValid(bad) {
		t.Fatal("a status outside the enum fails the output parse")
	}
	bad = valid
	bad.Recording = Recording{Events: []any{map[string]any{"at": "x", "kind": "weird"}}, Snapshots: []any{}}
	if outputValid(bad) {
		t.Fatal("an event kind outside the enum fails the output parse")
	}
	bad = valid
	bad.Recording = Recording{Events: []any{}, Snapshots: []any{map[string]any{"at": "x"}}}
	if outputValid(bad) {
		t.Fatal("a snapshot without a summary fails the output parse")
	}
	ok := valid
	ok.Recording = Recording{Events: []any{map[string]any{"at": "x", "kind": "key", "key": "a", "sensitive": true, "x": json.Number("3")}}, Snapshots: []any{map[string]any{"at": "y", "summary": "s"}}}
	if !outputValid(ok) {
		t.Fatal("a recording inside the schema is valid")
	}
}

func TestParseDraftNeedsEveryPlaybookField(t *testing.T) {
	full := `{"skillId":"s","playbook":{"whenToUse":"w","inputs":[],"steps":[],"howToCheck":"c","whatToReturn":"r","approvalBoundaries":"a","failureHandling":"f"}}`
	if _, failure := parseDraft(input(full)); failure != nil {
		t.Fatalf("failure = %v", failure)
	}
	missing := `{"skillId":"s","playbook":{"whenToUse":"w","inputs":[],"steps":[],"howToCheck":"c","whatToReturn":"r","approvalBoundaries":"a"}}`
	if _, failure := parseDraft(input(missing)); failure == nil || failure.Code != "BAD_REQUEST" {
		t.Fatal("a missing playbook field is refused")
	}
	wrong := `{"skillId":"s","name":7,"playbook":{"whenToUse":"w","inputs":[],"steps":[],"howToCheck":"c","whatToReturn":"r","approvalBoundaries":"a","failureHandling":"f"}}`
	if _, failure := parseDraft(input(wrong)); failure == nil {
		t.Fatal("a non-string name is refused")
	}
}
