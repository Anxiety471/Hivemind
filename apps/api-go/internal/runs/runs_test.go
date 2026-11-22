package runs

import "testing"

// TestTransitionTableMatchesRunState pins `allowed`
// (packages/core/src/runs/run-state.ts:53-63).
func TestTransitionTableMatchesRunState(t *testing.T) {
	allowed := map[string][]string{
		"queued":           {"leased", "cancelled"},
		"leased":           {"running", "queued", "cancelled"},
		"running":          {"waiting_input", "waiting_takeover", "completed", "failed", "cancelled", "leased"},
		"waiting_input":    {"queued", "leased", "cancelled"},
		"waiting_takeover": {"queued", "leased", "cancelled"},
		"completed":        {},
		"failed":           {"queued"},
		"cancelled":        {},
	}
	statuses := []string{"queued", "leased", "running", "waiting_input", "waiting_takeover", "completed", "failed", "cancelled"}
	for _, from := range statuses {
		for _, to := range statuses {
			want := false
			for _, candidate := range allowed[from] {
				if candidate == to {
					want = true
				}
			}
			if got := CanTransition(from, to); got != want {
				t.Errorf("CanTransition(%q, %q) = %v, want %v", from, to, got, want)
			}
		}
	}
}

func TestStatusSetsMatchCore(t *testing.T) {
	if IsActive("waiting_input") != true || IsActive("completed") || IsActive("failed") {
		t.Errorf("active set is wrong: %v", ActiveStatuses)
	}
	if len(QueueHoldingStatuses) != 4 || contains(QueueHoldingStatuses, "waiting_input") {
		t.Errorf("queue-holding set is wrong: %v", QueueHoldingStatuses)
	}
	if len(ResumableStatuses) != 3 || !contains(ResumableStatuses, "waiting_takeover") {
		t.Errorf("resumable set is wrong: %v", ResumableStatuses)
	}
	if !IsTerminal("cancelled") || IsTerminal("waiting_input") {
		t.Error("terminal set is wrong")
	}
}

func TestConversationNotesMatchThreadStop(t *testing.T) {
	routineID := "routine-1"
	name := "Morning brief"
	notes := conversationNotes([]Cancelled{
		{ID: "a", Trigger: "routine", RoutineID: &routineID, RoutineName: &name, BotID: "bot-1"},
		{ID: "b", Trigger: "user", BotID: "bot-2"},
	}, &Note{BotID: "bot-2", Text: StoppedByMessageNote})
	if len(notes) != 2 {
		t.Fatalf("notes = %+v", notes)
	}
	if notes[0].Text != `Stopped the routine "Morning brief".` || notes[0].BotID != "bot-1" {
		t.Errorf("routine note = %+v", notes[0])
	}
	if notes[1].Text != StoppedByMessageNote || notes[1].BotID != "bot-2" {
		t.Errorf("stop note = %+v", notes[1])
	}
	// The caller supplies only the bot: thread-stop.ts writes its own constant.
	custom := conversationNotes([]Cancelled{{ID: "b", Trigger: "user", BotID: "bot-3"}},
		&Note{BotID: "bot-3", Text: "something else"})
	if len(custom) != 1 || custom[0].Text != StoppedByMessageNote {
		t.Errorf("custom stop text leaked: %+v", custom)
	}
	// Only routines: the stop-by-message note is not added alongside them.
	only := conversationNotes([]Cancelled{
		{ID: "a", Trigger: "routine", RoutineID: &routineID, RoutineName: &name, BotID: "bot-1"},
	}, &Note{BotID: "bot-2", Text: StoppedByMessageNote})
	if len(only) != 1 {
		t.Fatalf("routine-only notes = %+v", only)
	}
}
