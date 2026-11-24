package mcpassignments

// DB-free tests for mcp.assignments.dismiss and mcp.assignments.replace inputs: the defaults zod
// applies, the issue order the router's error envelope shows, and the two predicates the shared
// card repaint uses.

import (
	"strconv"
	"strings"
	"testing"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/orpc"
)

func parse(t *testing.T, body string) (ReplaceInput, *orpc.Error) {
	t.Helper()
	return parseReplace(orpc.Input{Raw: []byte(body)})
}

func issuesOf(t *testing.T, failure *orpc.Error) []map[string]any {
	t.Helper()
	if failure == nil {
		t.Fatal("parse passed, want an issue")
	}
	payload, ok := failure.Data.(map[string]any)
	if !ok {
		t.Fatalf("failure has no issue payload: %+v", failure)
	}
	found, ok := payload["issues"].([]map[string]any)
	if !ok {
		t.Fatalf("failure has no issue list: %+v", failure)
	}
	return found
}

func TestParseReplaceDefaults(t *testing.T) {
	input, failure := parse(t, `{"botId":"b1","assignments":[{"serverId":"s1"}]}`)
	if failure != nil {
		t.Fatalf("parse failed: %+v", failure)
	}
	if input.BotID != "b1" || len(input.Assignments) != 1 {
		t.Fatalf("input = %+v", input)
	}
	only := input.Assignments[0]
	if only.ServerID != "s1" || !only.AllowAllTools || only.AllowedTools == nil || len(only.AllowedTools) != 0 {
		t.Fatalf("defaults = %+v, want allowAllTools true and an empty tool list", only)
	}
}

func TestParseReplaceExplicitValues(t *testing.T) {
	input, failure := parse(t,
		`{"botId":"b1","assignments":[{"serverId":"s1","allowAllTools":false,"allowedTools":["read","search"]},{"serverId":"s2"}]}`)
	if failure != nil {
		t.Fatalf("parse failed: %+v", failure)
	}
	if input.Assignments[0].AllowAllTools || len(input.Assignments[0].AllowedTools) != 2 ||
		input.Assignments[0].AllowedTools[1] != "search" {
		t.Fatalf("first = %+v", input.Assignments[0])
	}
}

func TestParseReplaceEmptyListClears(t *testing.T) {
	input, failure := parse(t, `{"botId":"b1","assignments":[]}`)
	if failure != nil {
		t.Fatalf("parse failed: %+v", failure)
	}
	if input.Assignments == nil || len(input.Assignments) != 0 {
		t.Fatalf("assignments = %#v, want an empty list", input.Assignments)
	}
}

func TestParseReplaceIssues(t *testing.T) {
	for _, testCase := range []struct {
		name string
		body string
		want []string
	}{
		{"missing-both", `{}`, []string{"botId", "assignments"}},
		{"bot-not-string", `{"botId":5,"assignments":[]}`, []string{"botId"}},
		{"empty-bot", `{"botId":"","assignments":[]}`, []string{"botId"}},
		{"assignments-not-array", `{"botId":"b1","assignments":{}}`, []string{"assignments"}},
		{"item-not-object", `{"botId":"b1","assignments":[5]}`, []string{"assignments.0"}},
		{"missing-server", `{"botId":"b1","assignments":[{"allowAllTools":true}]}`,
			[]string{"assignments.0.serverId"}},
		{"server-number", `{"botId":"b1","assignments":[{"serverId":1}]}`,
			[]string{"assignments.0.serverId"}},
		{"allow-null", `{"botId":"b1","assignments":[{"serverId":"s1","allowAllTools":null}]}`,
			[]string{"assignments.0.allowAllTools"}},
		{"tools-null", `{"botId":"b1","assignments":[{"serverId":"s1","allowedTools":null}]}`,
			[]string{"assignments.0.allowedTools"}},
		{"tool-empty", `{"botId":"b1","assignments":[{"serverId":"s1","allowedTools":[""]}]}`,
			[]string{"assignments.0.allowedTools.0"}},
		{"tool-number", `{"botId":"b1","assignments":[{"serverId":"s1","allowedTools":[7]}]}`,
			[]string{"assignments.0.allowedTools.0"}},
		{"tool-too-long", `{"botId":"b1","assignments":[{"serverId":"s1","allowedTools":["` +
			strings.Repeat("x", 201) + `"]}]}`, []string{"assignments.0.allowedTools.0"}},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			_, failure := parse(t, testCase.body)
			issues := issuesOf(t, failure)
			if len(issues) != len(testCase.want) {
				t.Fatalf("issues = %v, want paths %v", issues, testCase.want)
			}
			for index, want := range testCase.want {
				path := issues[index]["path"].([]any)
				got := make([]string, len(path))
				for position, part := range path {
					if number, ok := part.(int); ok {
						got[position] = itoa(number)
					} else {
						got[position] = part.(string)
					}
				}
				if strings.Join(got, ".") != want {
					t.Fatalf("issue %d path = %v, want %s (all: %v)", index, got, want, issues)
				}
			}
		})
	}
}

func TestParseReplaceTooManyTools(t *testing.T) {
	tools := make([]string, 501)
	for index := range tools {
		tools[index] = "t"
	}
	body := `{"botId":"b1","assignments":[{"serverId":"s1","allowedTools":["` +
		strings.Join(tools, `","`) + `"]}]}`
	_, failure := parse(t, body)
	issues := issuesOf(t, failure)
	if len(issues) != 1 || issues[0]["code"] != "too_big" {
		t.Fatalf("issues = %v, want one too_big", issues)
	}
}

func TestParseReplaceExtraKeysIgnored(t *testing.T) {
	_, failure := parse(t,
		`{"botId":"b1","assignments":[{"serverId":"s1","more":1}],"extra":true}`)
	if failure != nil {
		t.Fatalf("extra keys must be stripped, got %+v", failure)
	}
}

func TestParseDismissSharesTheApproveInput(t *testing.T) {
	input, failure := parseDismiss(orpc.Input{Raw: []byte(`{"botId":"b1","serverId":"s1","threadId":"t1"}`)})
	if failure != nil {
		t.Fatalf("parse failed: %+v", failure)
	}
	if input.botID != "b1" || input.serverID != "s1" || input.threadID == nil || *input.threadID != "t1" {
		t.Fatalf("input = %+v", input)
	}
	_, failure = parseDismiss(orpc.Input{Raw: []byte(`{"botId":"b1"}`)})
	issues := issuesOf(t, failure)
	if len(issues) != 1 || issues[0]["code"] != "invalid_type" {
		t.Fatalf("issues = %v, want a missing serverId", issues)
	}
}

func TestPendingAndClosePredicates(t *testing.T) {
	connected := map[string]any{"kind": "mcp_approval", "serverId": "s1", "status": "connected"}
	pending := map[string]any{"kind": "mcp_approval", "serverId": "s1", "status": "pending"}
	dismissed := map[string]any{"kind": "mcp_approval", "serverId": "s1", "status": "dismissed"}
	open := map[string]any{"kind": "mcp_approval", "serverId": "s1"}
	if !connectedOnly(connected) || connectedOnly(pending) || connectedOnly(open) {
		t.Error("a pending revert must repaint only connected cards")
	}
	if notDismissed(dismissed) || !notDismissed(connected) || !notDismissed(open) {
		t.Error("a server removal must repaint every card except a dismissed one")
	}
}

func TestRepaintToPending(t *testing.T) {
	pending := map[string]any{"kind": "mcp_approval", "serverId": "s1", "status": "connected"}
	change := repaint("s1", pendingCard, connectedOnly)
	next, changed := change(pending)
	if !changed || next["status"] != pendingCard {
		t.Fatalf("repaint = %v (changed %v), want pending", next, changed)
	}
	if pending["status"] != "connected" {
		t.Errorf("the stored block was mutated: %v", pending)
	}
	if _, changed := change(map[string]any{"kind": "text", "text": "x"}); changed {
		t.Error("a text block changed")
	}
}

// itoa keeps the test's path formatting local; validate's issue paths carry Go ints.
func itoa(value int) string { return strconv.Itoa(value) }
