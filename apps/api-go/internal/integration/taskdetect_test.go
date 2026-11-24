package integration

import (
	"context"
	"testing"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/tickets"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/taskdetect"
)

// TestTaskDetectDecisionWritesSanitizeLikePrisma pins the two ticket writes in
// taskdetect.Apply: the decision JSON is a Prisma json write value, so NUL and
// an unpaired surrogate become U+FFFD in every leaf instead of reaching jsonb
// (PostgreSQL rejects \u0000 with 22P05; TypeScript's Prisma extension sanitizes it).
func TestTaskDetectDecisionWritesSanitizeLikePrisma(t *testing.T) {
	database := openTestDB(t)
	s := seed(t, database)
	bot := "bot-td-" + s.UserID
	addBot(t, database, bot, s.Space1, s.UserID, "Task detector")
	service := &taskdetect.Service{DB: database, BoardLab: true}
	ctx := context.Background()

	decision := tickets.TicketDecisionInput{
		Question:    "nul\x00question",
		Options:     []string{"one", "two", "three"},
		Recommended: "one",
	}
	created, err := service.Apply(ctx, taskdetect.ApplyRequest{
		SpaceID: s.Space1,
		UserID:  s.UserID,
		BotID:   bot,
		Actions: []taskdetect.Action{{Op: "create", Title: "NUL decision", Decision: &decision}},
	})
	if err != nil || len(created.Created) != 1 {
		t.Fatalf("create = %+v %v", created, err)
	}
	ticketID := created.Created[0].ID
	if got := systemScalar[string](t, database, `SELECT decision->>'question' FROM tickets WHERE id = $1`, ticketID); got != "nul\uFFFDquestion" {
		t.Fatalf("created decision question = %q", got)
	}
	if got := systemScalar[int](t, database, `SELECT jsonb_array_length(decision->'options') FROM tickets WHERE id = $1`, ticketID); got != 3 {
		t.Fatalf("created decision options = %d", got)
	}
	if got := systemScalar[string](t, database, `SELECT decision->'options'->1->>'label' FROM tickets WHERE id = $1`, ticketID); got != "two" {
		t.Fatalf("created decision second label = %q", got)
	}

	lone := string([]byte{0xED, 0xA0, 0x80}) // WTF-8 for an unpaired high surrogate
	updatedDecision := tickets.TicketDecisionInput{
		Question:    "s" + lone + "?",
		Options:     []string{"one", "two", "three"},
		Recommended: "two",
	}
	updated, err := service.Apply(ctx, taskdetect.ApplyRequest{
		SpaceID: s.Space1,
		UserID:  s.UserID,
		BotID:   bot,
		Actions: []taskdetect.Action{{Op: "update", TicketID: ticketID, Decision: &updatedDecision}},
	})
	if err != nil || len(updated.Updated) != 1 {
		t.Fatalf("update = %+v %v", updated, err)
	}
	if got := systemScalar[string](t, database, `SELECT decision->>'question' FROM tickets WHERE id = $1`, ticketID); got != "s\uFFFD?" {
		t.Fatalf("updated decision question = %q", got)
	}
}
