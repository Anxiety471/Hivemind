package threads

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/orpc"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/validate"
)

func targetMessages(t *testing.T, text string) []string {
	t.Helper()
	_, failure := parseWith(orpc.Input{Raw: json.RawMessage(text)}, nil)
	if failure == nil {
		return nil
	}
	var messages []string
	for _, issue := range failure.Data.(map[string]any)["issues"].([]map[string]any) {
		messages = append(messages, issue["message"].(string))
	}
	return messages
}

func TestThreadTargetNeedsExactlyOneId(t *testing.T) {
	for _, ok := range []string{`{"botId":"b"}`, `{"groupId":"g"}`, `{"botId":"b","more":1}`} {
		if got := targetMessages(t, ok); got != nil {
			t.Errorf("%s rejected: %v", ok, got)
		}
	}
	const exactlyOne = "Provide exactly one of botId or groupId"
	for text, want := range map[string]string{
		`{}`:                          exactlyOne,
		`{"botId":"b","groupId":"g"}`: exactlyOne,
		`{"botId":5}`:                 "Invalid input: expected string, received number",
		`{"botId":""}`:                "Too small: expected string to have >=1 characters",
		`[]`:                          "Invalid input: expected object, received array",
	} {
		got := targetMessages(t, text)
		if len(got) == 0 || got[0] != want {
			t.Errorf("%s: %q want first %q", text, got, want)
		}
	}
	// An empty id is a length failure, which does not stop the refinement: both ids "" are neither.
	if got := targetMessages(t, `{"botId":""}`); len(got) != 2 || got[1] != exactlyOne {
		t.Errorf("empty id = %q", got)
	}
	// A type failure does.
	if got := targetMessages(t, `{"botId":5,"groupId":"g"}`); len(got) != 1 {
		t.Errorf("type failure = %q", got)
	}
}

func TestIntersectionReportsEachSideOnABadObject(t *testing.T) {
	_, failure := parseWith(orpc.Input{Raw: json.RawMessage(`[]`)}, func(*validate.Object) []validate.Issue { return nil })
	if failure == nil || len(failure.Data.(map[string]any)["issues"].([]map[string]any)) != 2 {
		t.Fatalf("failure = %+v", failure)
	}
}

func TestSnoozeDatetimeFormat(t *testing.T) {
	for _, valid := range []string{"2026-11-18T10:00:00Z", "2026-11-18T10:00:00.123Z", "2026-11-18T10:00:00.123456+05:30", "2026-02-28T23:59:59-23:59"} {
		if _, issues := validate.ISODateTime(validate.Path{"until"}, valid, true); issues != nil {
			t.Errorf("%s rejected", valid)
		}
	}
	for _, invalid := range []string{"2026-11-18", "2026-11-18T10:00Z", "2026-11-18T10:00:00", "2026-02-30T10:00:00Z", "2026-11-18T24:00:00Z", "2026-11-18T10:00:00+0530", "2026-11-18 10:00:00Z", "", " 2026-11-18T10:00:00Z", strings.Repeat("x", 30)} {
		if _, issues := validate.ISODateTime(validate.Path{"until"}, invalid, true); issues == nil {
			t.Errorf("%q accepted", invalid)
		}
	}
	if value, issues := validate.ISODateTime(validate.Path{"until"}, nil, true); issues != nil || value != nil {
		t.Error("null is accepted")
	}
	if _, issues := validate.ISODateTime(validate.Path{"until"}, nil, false); issues == nil {
		t.Error("null needs nullable")
	}
	if _, issues := validate.ISODateTime(validate.Path{"until"}, validate.Undefined, true); issues == nil || issues[0]["message"] != "Invalid input: expected string, received undefined" {
		t.Errorf("undefined = %v", issues)
	}
}
