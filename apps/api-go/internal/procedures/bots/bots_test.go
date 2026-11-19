package bots

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/orpc"
)

func input(text string) orpc.Input { return orpc.Input{Raw: json.RawMessage(text)} }

func issuesOf(t *testing.T, failure *orpc.Error) []map[string]any {
	t.Helper()
	if failure == nil {
		t.Fatal("expected a validation failure")
	}
	data, ok := failure.Data.(map[string]any)
	if !ok {
		t.Fatalf("failure data = %#v", failure.Data)
	}
	issues, _ := data["issues"].([]map[string]any)
	return issues
}

func TestParseReorderMatchesReorderBotsInput(t *testing.T) {
	if ids, failure := parseReorder(input(`{"botIds":["a","b"]}`)); failure != nil || len(ids) != 2 {
		t.Fatalf("ids = %v, failure = %v", ids, failure)
	}
	if _, failure := parseReorder(input(`{"botIds":["a","a"]}`)); failure == nil {
		t.Fatal("a repeated id must fail")
	}
}

func TestParseReorderIssues(t *testing.T) {
	cases := []struct {
		name  string
		raw   string
		codes []string
		last  map[string]any
	}{
		{"missing", `{}`, []string{"invalid_type"}, map[string]any{
			"expected": "array", "code": "invalid_type", "path": []any{"botIds"},
			"message": "Invalid input: expected array, received undefined",
		}},
		{"empty", `{"botIds":[]}`, []string{"too_small"}, map[string]any{
			"origin": "array", "code": "too_small", "minimum": 1, "inclusive": true,
			"path": []any{"botIds"}, "message": "Too small: expected array to have >=1 items",
		}},
		{"duplicate", `{"botIds":["a","a"]}`, []string{"custom"}, map[string]any{
			"code": "custom", "path": []any{"botIds"}, "message": "botIds must be distinct",
		}},
		{"empty-strings", `{"botIds":["",""]}`, []string{"too_small", "too_small", "custom"}, map[string]any{
			"code": "custom", "path": []any{"botIds"}, "message": "botIds must be distinct",
		}},
		{"non-string-aborts-refine", `{"botIds":["a","a",5]}`, []string{"invalid_type"}, map[string]any{
			"expected": "string", "code": "invalid_type", "path": []any{"botIds", 2},
			"message": "Invalid input: expected string, received number",
		}},
		{"not-array", `{"botIds":"x"}`, []string{"invalid_type"}, map[string]any{
			"expected": "array", "code": "invalid_type", "path": []any{"botIds"},
			"message": "Invalid input: expected array, received string",
		}},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			_, failure := parseReorder(input(testCase.raw))
			issues := issuesOf(t, failure)
			if len(issues) != len(testCase.codes) {
				t.Fatalf("issues = %#v", issues)
			}
			for index, code := range testCase.codes {
				if issues[index]["code"] != code {
					t.Fatalf("issue %d = %#v, want %s", index, issues[index], code)
				}
			}
			last := issues[len(issues)-1]
			for key, want := range testCase.last {
				if got := last[key]; !equalJSON(got, want) {
					t.Fatalf("issue %q = %#v, want %#v (%#v)", key, got, want, last)
				}
			}
		})
	}
	if _, failure := parseReorder(input(`{"botIds":["a"],"extra":1}`)); failure != nil {
		t.Fatalf("extra keys are stripped, not refused: %v", failure)
	}
	if _, failure := parseReorder(input(`[]`)); issuesOf(t, failure)[0]["code"] != "invalid_type" {
		t.Fatal("an array input is not an object")
	}
}

func equalJSON(left, right any) bool {
	leftJSON, _ := json.Marshal(left)
	rightJSON, _ := json.Marshal(right)
	return string(leftJSON) == string(rightJSON)
}

func TestParseEmailNameMatchesBotEmailNameSchema(t *testing.T) {
	cases := []struct {
		value string
		name  string
		codes []string
		last  map[string]any
	}{
		{"  AB  ", "ab", nil, nil},
		{"A", "", []string{"too_small"}, map[string]any{
			"origin": "string", "code": "too_small", "minimum": 2, "inclusive": true,
			"path": []any{"name"}, "message": "Use at least 2 characters",
		}},
		{"a..b", "", []string{"custom"}, map[string]any{
			"code": "custom", "path": []any{"name"},
			"message": "Use letters, numbers, dots, dashes or underscores",
		}},
		{"admin", "", []string{"custom"}, map[string]any{
			"code": "custom", "path": []any{"name"}, "message": "That address isn't available",
		}},
		{" Admin ", "", []string{"custom"}, map[string]any{
			"code": "custom", "path": []any{"name"}, "message": "That address isn't available",
		}},
		{"rakazo-bot", "", []string{"custom"}, map[string]any{
			"code": "custom", "path": []any{"name"}, "message": "That address isn't available",
		}},
		{"a b", "", []string{"invalid_format"}, map[string]any{
			"origin": "string", "code": "invalid_format", "format": "regex",
			"pattern": "/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/", "path": []any{"name"},
			"message": "Use letters, numbers, dots, dashes or underscores",
		}},
		{strings.Repeat("a", 65), "", []string{"too_big"}, map[string]any{
			"origin": "string", "code": "too_big", "maximum": 64, "inclusive": true,
			"path": []any{"name"}, "message": "Use at most 64 characters",
		}},
		{"!", "", []string{"too_small", "invalid_format"}, map[string]any{
			"code": "invalid_format",
		}},
		{"supportive", "supportive", nil, nil},
		{"supporting", "supporting", nil, nil},
	}
	for _, testCase := range cases {
		t.Run(testCase.value, func(t *testing.T) {
			name, issues := parseEmailName(testCase.value)
			if testCase.codes == nil {
				if issues != nil || name != testCase.name {
					t.Fatalf("name = %q, issues = %#v", name, issues)
				}
				return
			}
			if len(issues) != len(testCase.codes) {
				t.Fatalf("issues = %#v", issues)
			}
			for index, code := range testCase.codes {
				if issues[index]["code"] != code {
					t.Fatalf("issue %d = %#v, want %s", index, issues[index], code)
				}
			}
			last := issues[len(issues)-1]
			for key, want := range testCase.last {
				if got := last[key]; !equalJSON(got, want) {
					t.Fatalf("issue %q = %#v, want %#v (%#v)", key, got, want, last)
				}
			}
		})
	}
	if _, issues := parseEmailName(float64(5)); len(issues) != 1 || issues[0]["code"] != "invalid_type" {
		t.Fatalf("number issues = %#v", issues)
	}
	if _, issues := parseEmailName(nil); len(issues) != 1 || issues[0]["message"] != "Invalid input: expected string, received null" {
		t.Fatalf("null issues = %#v", issues)
	}
}

func TestReservedEmailNames(t *testing.T) {
	for _, name := range []string{"support", "support-team", "support.team", "support_x", "noreply", "rakazo", "rakazox", "no-reply"} {
		if !isReservedEmailName(name) {
			t.Errorf("%q should be reserved", name)
		}
	}
	for _, name := range []string{"supporting", "noreplies", "teamwork", "helpx"} {
		if isReservedEmailName(name) {
			t.Errorf("%q should be available", name)
		}
	}
}
