package threads

import (
	"encoding/json"
	"testing"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/orpc"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/validate"
)

func messageIssues(t *testing.T, text string) []map[string]any {
	t.Helper()
	_, failure := parseMessagesInput(orpc.Input{Raw: json.RawMessage(text)})
	if failure == nil {
		return nil
	}
	return failure.Data.(map[string]any)["issues"].([]map[string]any)
}

func issueSummary(issues []map[string]any) []string {
	out := make([]string, 0, len(issues))
	for _, issue := range issues {
		out = append(out, issue["code"].(string)+"@"+string(mustJSON(issue["path"])))
	}
	return out
}

func mustJSON(value any) []byte {
	text, _ := json.Marshal(value)
	return text
}

// The extended schema reports shape issues in definition order, then the "exactly one" refinement,
// and only when no issue was an invalid_type (zod aborts refinements then).
func TestMessagesInputIssuesMatchZod(t *testing.T) {
	for text, want := range map[string]string{
		`{"botId":"","before":-1}`:                        `["too_small@[\"botId\"]","too_small@[\"before\"]","custom@[\"botId\"]"]`,
		`{"botId":"","before":"x"}`:                       `["too_small@[\"botId\"]","invalid_type@[\"before\"]"]`,
		`{"botId":5,"before":-1}`:                         `["invalid_type@[\"botId\"]","too_small@[\"before\"]"]`,
		`{"botId":"","around":{"seq":"x"}}`:               `["too_small@[\"botId\"]","invalid_type@[\"around\",\"seq\"]"]`,
		`{"botId":"b","around":{"seq":1,"messageId":5}}`:  `["invalid_type@[\"around\",\"messageId\"]"]`,
		`{"botId":"b","before":9007199254740992}`:         `["too_big@[\"before\"]"]`,
		`{"botId":"b","around":{"seq":9007199254740992}}`: `["too_big@[\"around\",\"seq\"]"]`,
		`{"botId":"b","includePeerRuns":null}`:            `["invalid_type@[\"includePeerRuns\"]"]`,
		`{"botId":"b","around":null}`:                     `["invalid_type@[\"around\"]"]`,
		`{"botId":"b","around":5}`:                        `["invalid_type@[\"around\"]"]`,
		`{"botId":"b","groupId":"g"}`:                     `["custom@[\"botId\"]"]`,
		`{}`:                                              `["custom@[\"botId\"]"]`,
	} {
		if got := string(mustJSON(issueSummary(messageIssues(t, text)))); got != want {
			t.Errorf("%s: issues %s, want %s", text, got, want)
		}
	}
}

func TestMessagesInputAccepts(t *testing.T) {
	for _, text := range []string{
		`{"botId":"b"}`,
		`{"botId":"b","before":0}`,
		`{"botId":"b","includePeerRuns":false,"includePeerReceipts":true}`,
		`{"botId":"b","around":{}}`,
		`{"botId":"b","around":{"messageId":"m","extra":1}}`,
		`{"botId":"b","around":{"seq":0}}`,
		`{"groupId":"g","before":5}`,
		`{"botId":"b","more":1}`,
	} {
		if issues := messageIssues(t, text); issues != nil {
			t.Errorf("%s rejected: %v", text, issues)
		}
	}
	in, failure := parseMessagesInput(orpc.Input{Raw: json.RawMessage(`{"botId":"b","before":7,"includePeerReceipts":true,"around":{"messageId":"m"}}`)})
	if failure != nil {
		t.Fatalf("failure: %+v", failure)
	}
	if in.BotID != "b" || in.Before == nil || *in.Before != 7 || !in.IncludePeerReceipts || in.IncludePeerRuns {
		t.Errorf("parsed %+v", in)
	}
	if in.Around == nil || in.Around.MessageID != "m" || in.Around.Seq != nil {
		t.Errorf("around %+v", in.Around)
	}
}

// A non-object input is reported by the object parse alone, as safeExtend's base schema does.
func TestMessagesInputNonObject(t *testing.T) {
	for text, want := range map[string]string{
		``:     "Invalid input: expected object, received undefined",
		`null`: "Invalid input: expected object, received null",
		`[]`:   "Invalid input: expected object, received array",
		`5`:    "Invalid input: expected object, received number",
		`"x"`:  "Invalid input: expected object, received string",
	} {
		issues := messageIssues(t, text)
		if len(issues) != 1 || issues[0]["message"] != want {
			t.Errorf("%q: %v", text, issues)
		}
	}
}

func TestValidateMessages(t *testing.T) {
	ok := []map[string]any{{"id": "m", "threadId": "t", "seq": int32(0)}}
	if failure := ValidateMessages(ok); failure != nil {
		t.Errorf("valid page failed: %+v", failure)
	}
	for _, bad := range []map[string]any{
		{"id": "", "threadId": "t", "seq": int32(0)},
		{"id": "m", "threadId": "", "seq": int32(0)},
		{"id": "m", "threadId": "t", "seq": int32(-1)},
	} {
		failure := ValidateMessages([]map[string]any{bad})
		if failure == nil || failure.Status != 500 || failure.Message != "Output validation failed" {
			t.Errorf("%v: %+v", bad, failure)
		}
	}
}

var _ = validate.Issue{}
