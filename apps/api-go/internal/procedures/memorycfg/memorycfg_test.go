package memorycfg

import (
	"encoding/json"
	"testing"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/orpc"
)

func input(text string) orpc.Input { return orpc.Input{Raw: json.RawMessage(text)} }

func TestParseDefaultScopeMatchesTheEnum(t *testing.T) {
	if input, failure := ParseDefaultScope(input(`{"defaultMemoryScope":"shared","extra":1}`)); failure != nil || input.DefaultMemoryScope != "shared" {
		t.Fatalf("input = %+v, failure = %v", input, failure)
	}
	for _, raw := range []string{`{}`, `{"defaultMemoryScope":5}`, `{"defaultMemoryScope":"x"}`, `{"defaultMemoryScope":null}`} {
		_, failure := ParseDefaultScope(input(raw))
		if failure == nil {
			t.Fatalf("%s parsed", raw)
		}
		data := failure.Data.(map[string]any)
		issues := data["issues"].([]map[string]any)
		if len(issues) != 1 || issues[0]["code"] != "invalid_value" || issues[0]["message"] != `Invalid option: expected one of "isolated"|"shared"` {
			t.Fatalf("%s issues = %#v", raw, issues)
		}
	}
}

func TestConnectionLabelMatchesTheProviders(t *testing.T) {
	cases := []struct {
		provider string
		settings map[string]string
		want     string
		absent   bool
	}{
		{"supermemory", map[string]string{"mode": "cloud"}, "Supermemory Cloud", false},
		{"supermemory", map[string]string{"baseUrl": "http://mem.test"}, "Self-hosted (http://mem.test)", false},
		{"supermemory", map[string]string{}, "Self-hosted (undefined)", false},
		{"serenity", map[string]string{"brainLabel": " Team ", "allowWrites": "true"}, "Team, read/write", false},
		{"serenity", map[string]string{"endpoint": "http://x.test"}, "http://x.test, recall only", false},
		{"serenity", map[string]string{"brainLabel": "   ", "endpoint": "http://x.test"}, "http://x.test, recall only", false},
		{"honcho", map[string]string{"mode": "local", "baseUrl": "http://h.test", "workspaceId": "ws"}, "Self-hosted (http://h.test), ws", false},
		{"honcho", map[string]string{"mode": "local"}, "Self-hosted (undefined)", false},
		{"honcho", map[string]string{"workspaceId": "ws"}, "Honcho Cloud (ws)", false},
		{"honcho", map[string]string{}, "Honcho Cloud", false},
		{"hindsight", map[string]string{"mode": "local", "baseUrl": "http://r.test"}, "Self-hosted (http://r.test)", false},
		{"hindsight", map[string]string{}, "Hindsight Cloud", false},
		{"someone", map[string]string{}, "", true},
	}
	for _, testCase := range cases {
		label := connectionLabel(testCase.provider, testCase.settings)
		if testCase.absent {
			if label != nil {
				t.Errorf("%s = %q, want none", testCase.provider, *label)
			}
			continue
		}
		if label == nil || *label != testCase.want {
			t.Errorf("%s %v = %v, want %q", testCase.provider, testCase.settings, label, testCase.want)
		}
	}
}

func TestToStringRecordKeepsOnlyStrings(t *testing.T) {
	record := toStringRecord(map[string]any{"a": "x", "b": float64(2), "c": nil, "d": []any{"x"}, "e": true})
	if len(record) != 1 || record["a"] != "x" {
		t.Fatalf("record = %#v", record)
	}
	if empty := toStringRecord([]any{"x"}); len(empty) != 0 {
		t.Fatalf("array record = %#v", empty)
	}
}
