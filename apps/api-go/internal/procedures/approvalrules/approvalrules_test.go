package approvalrules

import (
	"encoding/json"
	"testing"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/orpc"
)

// jsLower must agree with String.prototype.toLowerCase wherever Go's simple mapping does not.
func TestJSLowerMatchesToLowerCase(t *testing.T) {
	for input, want := range map[string]string{
		"BASH":         "bash",
		"MiXed":        "mixed",
		"\u0130x":      "i\u0307x", // dotted capital I becomes i and a combining dot
		"ΑΣ":           "ας",       // final sigma
		"ΑΣ Β":         "ας β",
		"ΑΣΑ":          "ασα",
		"Σ":            "σ",
		"Α'Σ":          "α'ς",
		"ΑΣ.":          "ας.",
		"ΑΣ1":          "ας1", // a digit is not cased
		"Ǆ":            "ǆ",
		"ß":            "ß",
		"ключ-😀":       "ключ-😀",
		"_%":           "_%",
		"\u03a3\u0301": "σ\u0301",
	} {
		if got := jsLower(input); got != want {
			t.Errorf("jsLower(%q) = %q, want %q", input, got, want)
		}
	}
}

func parseSetMessages(t *testing.T, text string) []string {
	t.Helper()
	_, failure := parseSet(orpc.Input{Raw: json.RawMessage(text)})
	if failure == nil {
		return nil
	}
	var messages []string
	for _, issue := range failure.Data.(map[string]any)["issues"].([]map[string]any) {
		messages = append(messages, issue["path"].([]any)[0].(string)+": "+issue["message"].(string))
	}
	return messages
}

func TestSetInputIsZodExact(t *testing.T) {
	if got := parseSetMessages(t, `{"effect":"deny","matchKind":"tool","matchValue":"  x  ","scope":"space","more":1}`); got != nil {
		t.Errorf("valid input rejected: %v", got)
	}
	input, failure := parseSet(orpc.Input{Raw: json.RawMessage(`{"effect":"deny","matchKind":"site","matchValue":" \u00a0x\t"}`)})
	if failure != nil || input.MatchValue != "x" || input.Scope != "" {
		t.Errorf("value is trimmed and scope optional: %+v %v", input, failure)
	}
	got := parseSetMessages(t, `{"scope":1,"effect":2,"matchKind":"category","matchValue":" "}`)
	want := []string{
		`scope: Invalid option: expected one of "account"|"space"`,
		`effect: Invalid option: expected one of "always_allow"|"require_approval"|"deny"`,
		`matchKind: Invalid option: expected one of "tool"|"connector"|"site"`,
		"matchValue: Too small: expected string to have >=1 characters",
	}
	if len(got) != len(want) {
		t.Fatalf("issues = %v", got)
	}
	for index := range want {
		if got[index] != want[index] {
			t.Errorf("issue %d = %q, want %q", index, got[index], want[index])
		}
	}
}
