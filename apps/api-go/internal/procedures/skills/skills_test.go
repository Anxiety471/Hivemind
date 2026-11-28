package skills

import (
	"encoding/json"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	"strings"
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
	// Not an object: buildPlaybookFromRecording("", []) and its non-empty defaults.
	for _, value := range []any{nil, "nope", 7, true} {
		fallback := parsePlaybook(value)
		if fallback.WhenToUse != defaultWhenToUse || len(fallback.Steps) != 1 || fallback.Steps[0] != defaultStep {
			t.Fatalf("%v: fallback = %+v", value, fallback)
		}
		if fallback.HowToCheck != defaultHowToCheck || fallback.WhatToReturn != defaultWhatToReturn ||
			fallback.ApprovalBoundaries != defaultApproval || fallback.FailureHandling != defaultFailure ||
			len(fallback.Inputs) != 0 {
			t.Fatalf("%v: fallback = %+v", value, fallback)
		}
	}
	// An array is an object to JavaScript: its fields are absent, so they coerce to empty.
	list := parsePlaybook([]any{"a"})
	if list.WhenToUse != "" || len(list.Steps) != 0 || len(list.Inputs) != 0 {
		t.Fatalf("list playbook = %+v", list)
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
		{float64(2), "2"},
		{[]any{float64(2), nil}, "2,"},
		{float64(1e21), "1e+21"},
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
	// An astral character is two units, so a slice between its halves keeps both units.
	if got := sliceUTF16("😀😀", 0, 2); got != "😀" {
		t.Fatalf("got %q", got)
	}
	// A cut inside a pair leaves a lone half, and the write sanitizer turns it into U+FFFD:
	// goal.slice(0, 80) then sanitizeUtf16ForJson (text-sanitization.ts:58).
	if got := sliceUTF16("😀x", 1, 3); got != "\uFFFDx" {
		t.Fatalf("a low half alone becomes U+FFFD: %q", got)
	}
	if got := sliceUTF16("a"+"😀", 0, 2); got != "a\uFFFD" {
		t.Fatalf("a high half alone becomes U+FFFD: %q", got)
	}
	if got := sliceUTF16("short", 0, 80); got != "short" {
		t.Fatalf("got %q", got)
	}
}

func TestOutputValidChecksTheStoredRows(t *testing.T) {
	valid := Skill{
		ID: "s", BotID: "b", Status: "draft",
		Recording: Recording{Events: []RecordingEvent{}, Snapshots: []RecordingSnapshot{}},
	}
	if !outputValid(valid) {
		t.Fatal("a draft with an empty recording is valid")
	}
	bad := valid
	bad.Status = "weird"
	if outputValid(bad) {
		t.Fatal("a status outside the enum fails the output parse")
	}
	if _, ok := parseRecording(map[string]any{"events": []any{map[string]any{"at": "x", "kind": "weird"}}, "snapshots": []any{}}); ok {
		t.Fatal("an event kind outside the enum fails the output parse")
	}
	if _, ok := parseRecording(map[string]any{"events": []any{}, "snapshots": []any{map[string]any{"at": "x"}}}); ok {
		t.Fatal("a snapshot without a summary fails the output parse")
	}
	// A present optional key must hold a value: zod's .optional() refuses null.
	if _, ok := parseRecording(map[string]any{"events": []any{map[string]any{"at": "x", "kind": "key", "x": nil}}, "snapshots": []any{}}); ok {
		t.Fatal("a null x fails the output parse")
	}
	if _, ok := parseRecording(map[string]any{"events": []any{}, "snapshots": []any{map[string]any{"at": "x", "summary": "s", "hash": nil}}}); ok {
		t.Fatal("a null hash fails the output parse")
	}
	// An unknown key is stripped: the output carries the schema's keys only.
	recording, ok := parseRecording(map[string]any{
		"events": []any{map[string]any{
			"at": "x", "kind": "key", "key": "a", "sensitive": true, "x": json.Number("3"), "extra": 1,
		}},
		"snapshots":      []any{map[string]any{"at": "y", "summary": "s", "extra": true}},
		"controlLeaseId": "lease",
		"unknown":        "dropped",
	})
	if !ok {
		t.Fatal("a recording inside the schema is valid")
	}
	if len(recording.Events) != 1 || recording.Events[0].Key == nil || *recording.Events[0].Key != "a" ||
		recording.Events[0].X == nil || *recording.Events[0].X != 3 || recording.Events[0].Sensitive == nil {
		t.Fatalf("event = %+v", recording.Events)
	}
	body, err := json.Marshal(recording)
	if err != nil {
		t.Fatal(err)
	}
	want := `{"events":[{"at":"x","kind":"key","x":3,"key":"a","sensitive":true}],"snapshots":[{"at":"y","summary":"s"}],"controlLeaseId":"lease"}`
	if string(body) != want {
		t.Fatalf("recording = %s", body)
	}
	// A stored recording that is not an object reads as an empty one on both sides.
	if empty, ok := parseRecording("nope"); !ok || len(empty.Events) != 0 || len(empty.Snapshots) != 0 {
		t.Fatalf("scalar recording = %+v %v", empty, ok)
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

func TestPlaybookJSONSanitizesASurrogateOnce(t *testing.T) {
	surrogate := "a" + string([]byte{0xED, 0xB0, 0x80}) + "b"
	playbook := Playbook{WhenToUse: surrogate, Steps: []string{"x"}}
	stored := db.JSONText(mustJSON(playbook))
	if strings.Count(stored, "\uFFFD") != 1 {
		t.Fatalf("stored = %s", stored)
	}
	if !strings.Contains(stored, "a\uFFFDb") {
		t.Fatalf("stored = %s", stored)
	}
}
