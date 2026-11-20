package onboarding

import (
	"encoding/json"
	"testing"
)

func TestPendingChoiceFollowsJavaScriptFalsiness(t *testing.T) {
	cases := []struct {
		name  string
		block map[string]any
		want  bool
	}{
		{"no answerId", map[string]any{"kind": "choice"}, true},
		{"null answerId", map[string]any{"kind": "choice", "answerId": nil}, true},
		{"empty answerId", map[string]any{"kind": "choice", "answerId": ""}, true},
		{"false answerId", map[string]any{"kind": "choice", "answerId": false}, true},
		{"zero answerId", map[string]any{"kind": "choice", "answerId": json.Number("0")}, true},
		{"answered", map[string]any{"kind": "choice", "answerId": "day"}, false},
		{"object answer", map[string]any{"kind": "choice", "answerId": map[string]any{}}, false},
		{"not a choice", map[string]any{"kind": "ask"}, false},
	}
	for _, c := range cases {
		if got := pendingChoice(c.block); got != c.want {
			t.Errorf("%s: got %v want %v", c.name, got, c.want)
		}
	}
}

func TestChoiceBlockCarriesOnlyTheCardFields(t *testing.T) {
	block := choiceBlock()
	if block["kind"] != "choice" || block["question"] != "What do you want me on first?" {
		t.Fatalf("block = %v", block)
	}
	options := block["options"].([]any)
	if len(options) != 4 {
		t.Fatalf("options = %v", options)
	}
	first := options[0].(map[string]any)
	if first["id"] != "day" || first["letter"] != "A" || first["label"] != "Day-to-day work" || len(first) != 3 {
		t.Fatalf("first option = %v", first)
	}
	if _, answered := block["answerId"]; answered {
		t.Fatal("a posted card has no answerId")
	}
}
