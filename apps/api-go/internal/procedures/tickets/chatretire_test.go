package tickets

import (
	"context"
	"strings"
	"testing"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/shared"
)

func TestSettledAnswerNamesTheTicketChange(t *testing.T) {
	cases := []struct {
		name          string
		statusChanged bool
		status        string
		decisionClear bool
		wantAnswer    string
		wantSettled   bool
	}{
		{"closing settles as closed", true, "closed", false, "Closed TASK-441", true},
		{"marking done settles as done", true, "done", false, "Marked TASK-441 done", true},
		{"a completed status that did not change settles nothing", false, "done", false, "", false},
		{"a merge that finishes a ticket without a stored decision settles", true, "done", false, "Marked TASK-441 done", true},
		{"a cleared decision settles as resolved", false, "doing", true, "Resolved on TASK-441", true},
		{"a completed status wins over a cleared decision", true, "closed", true, "Closed TASK-441", true},
		{"a plain status move settles nothing", true, "doing", false, "", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			answer, settled := settledAnswer("TASK-441", tc.statusChanged, tc.status, tc.decisionClear)
			if settled != tc.wantSettled || answer != tc.wantAnswer {
				t.Fatalf("settledAnswer = (%q, %v), want (%q, %v)", answer, settled, tc.wantAnswer, tc.wantSettled)
			}
		})
	}
}

// askBlock is a stored pending ask about a ticket, as the opened Message blocks hold it.
func askBlock(overrides map[string]any) map[string]any {
	block := map[string]any{
		"kind":      "ask",
		"text":      "Ship the release?",
		"status":    "pending",
		"ticketRef": "TASK-441",
		"actions": []any{
			map[string]any{"id": "choice-1", "label": "Ship"},
			map[string]any{"id": "choice-2", "label": "Hold"},
		},
	}
	for key, value := range overrides {
		if value == nil {
			delete(block, key)
			continue
		}
		block[key] = value
	}
	return block
}

// botMessageWith is one bot message of a run whose blocks are the given entries.
func botMessageWith(id string, entries ...any) botMessage {
	return botMessage{id: id, threadID: "thread-1", blocks: append([]any{}, entries...)}
}

func TestPlanRetirementAnswersOnlyTheMatchingSingleQuestion(t *testing.T) {
	text := map[string]any{"kind": "text", "text": "Here is the plan."}
	messages := []botMessage{botMessageWith("msg-1", text, askBlock(nil))}

	updates, ok := planRetirement(messages, "task-441", "Closed TASK-441")
	if !ok || len(updates) != 1 {
		t.Fatalf("planRetirement = (%v, %v), want one update", updates, ok)
	}
	if updates[0].id != "msg-1" {
		t.Fatalf("updated message = %q, want msg-1", updates[0].id)
	}
	got := updates[0].blocks
	if len(got) != 2 || got[0]["kind"] != "text" {
		t.Fatalf("blocks = %v, want the text block kept first", got)
	}
	if got[1]["status"] != "answered" || got[1]["answer"] != "Closed TASK-441" {
		t.Fatalf("question = %v, want answered with the settlement", got[1])
	}
	if got[1]["ticketRef"] != "TASK-441" {
		t.Fatalf("ticketRef = %v, want kept", got[1]["ticketRef"])
	}
}

func TestPlanRetirementNeverAnswersSecretApprovalOrBatchAsks(t *testing.T) {
	cases := map[string]map[string]any{
		"secret":   askBlock(map[string]any{"input": "secret"}),
		"approval": askBlock(map[string]any{"approvalEffectId": "effect-1"}),
		"batch":    askBlock(map[string]any{"items": []any{map[string]any{"id": "item-1", "question": "Ship?"}}}),
	}
	for name, block := range cases {
		t.Run(name, func(t *testing.T) {
			if _, ok := planRetirement([]botMessage{botMessageWith("msg-1", block)}, "task-441", "Closed TASK-441"); ok {
				t.Fatalf("a %s ask must leave its run alone", name)
			}
		})
	}
}

func TestPlanRetirementLeavesRunsWithOtherPendingQuestions(t *testing.T) {
	otherTicket := askBlock(map[string]any{"ticketRef": "TASK-7"})
	unlinked := askBlock(map[string]any{"ticketRef": nil})
	for name, entries := range map[string][]any{
		"another ticket":  {askBlock(nil), otherTicket},
		"an unlinked ask": {askBlock(nil), unlinked},
	} {
		t.Run(name, func(t *testing.T) {
			if _, ok := planRetirement([]botMessage{botMessageWith("msg-1", entries...)}, "task-441", "Closed TASK-441"); ok {
				t.Fatalf("a run with %s pending must be left alone", name)
			}
		})
	}
}

func TestPlanRetirementRefusesRowsItCannotReadWhole(t *testing.T) {
	notAList := botMessage{id: "msg-1", threadID: "thread-1", blocks: map[string]any{"kind": "ask"}}
	if _, ok := planRetirement([]botMessage{notAList}, "task-441", "Closed TASK-441"); ok {
		t.Fatal("blocks that are not a list must not be read as answered")
	}
	dropped := botMessageWith("msg-1", askBlock(nil), "not a block")
	if _, ok := planRetirement([]botMessage{dropped}, "task-441", "Closed TASK-441"); ok {
		t.Fatal("a row that holds entries which are not blocks is not intact, so it is left alone")
	}
}

func TestPlanRetirementIgnoresAnsweredAndUnlinkedHistory(t *testing.T) {
	answered := askBlock(map[string]any{"status": "answered", "answer": "Ship"})
	history := botMessageWith("msg-1", answered, map[string]any{"kind": "text", "text": "Done."})
	if updates, ok := planRetirement([]botMessage{history}, "task-441", "Closed TASK-441"); ok || len(updates) != 0 {
		t.Fatalf("answered history must not retire anything, got %v %v", updates, ok)
	}
}

func TestPlanRetirementMatchesTheRefCaseInsensitively(t *testing.T) {
	block := askBlock(map[string]any{"ticketRef": "  task-441 "})
	updates, ok := planRetirement([]botMessage{botMessageWith("msg-1", block)}, "task-441", "Closed TASK-441")
	if !ok || len(updates) != 1 {
		t.Fatalf("a padded, lower-case ref must match, got %v %v", updates, ok)
	}
}

func TestRetireWaitingQuestionsDoesNothingWithoutAnAnswerOrRef(t *testing.T) {
	ctx := context.Background()
	if err := RetireWaitingQuestions(ctx, nil, shared.Deployment{}, db.Actor{}, " ", "Closed"); err != nil {
		t.Fatalf("an empty ref must do nothing: %v", err)
	}
	if err := RetireWaitingQuestions(ctx, nil, shared.Deployment{}, db.Actor{}, "TASK-441", " "); err != nil {
		t.Fatalf("an empty answer must do nothing: %v", err)
	}
	err := RetireWaitingQuestions(ctx, nil, shared.Deployment{}, db.Actor{}, "TASK-441", "Closed TASK-441")
	if err == nil || !strings.Contains(err.Error(), "content key ring") {
		t.Fatalf("retiring without the key ring must refuse, got %v", err)
	}
}
