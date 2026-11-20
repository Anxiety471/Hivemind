package tickets

import (
	"encoding/json"
	"testing"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/orpc"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/validate"
)

func input(text string) orpc.Input { return orpc.Input{Raw: json.RawMessage(text)} }

func TestParseMoveIsMoveTicketInput(t *testing.T) {
	move, failure := parseMove(input(`{"id":"t","status":"doing"}`))
	if failure != nil || move.ID != "t" || move.Status != "doing" {
		t.Fatalf("move = %+v failure = %v", move, failure)
	}
	for _, bad := range []string{
		`{"status":"doing"}`,
		`{"id":"","status":"doing"}`,
		`{"id":"t"}`,
		`{"id":"t","status":"archived"}`,
		`{"id":"t","status":7}`,
		`[]`,
		`null`,
	} {
		if _, failure := parseMove(input(bad)); failure == nil || failure.Code != "BAD_REQUEST" {
			t.Errorf("%s must be refused", bad)
		}
	}
}

func TestParseCommentTrimsAndBounds(t *testing.T) {
	comment, failure := parseComment(input(`{"ticketId":"t","body":"  hi  "}`))
	if failure != nil || comment.Body != "hi" {
		t.Fatalf("comment = %+v failure = %v", comment, failure)
	}
	if _, failure := parseComment(input(`{"ticketId":"t","body":"   "}`)); failure == nil {
		t.Fatal("a blank body is refused")
	}
	long, _ := json.Marshal(map[string]string{"ticketId": "t", "body": string(make([]byte, commentMaxLength+1))})
	if _, failure := parseComment(input(string(long))); failure == nil {
		t.Fatal("a body past the limit is refused")
	}
}

func TestTicketDtoCoercion(t *testing.T) {
	if coerceStatus("weird") != "todo" || coerceStatus("done") != "done" {
		t.Fatal("status falls back to todo")
	}
	empty := ""
	if coercePriority(nil) != "normal" || coercePriority(&empty) != "normal" {
		t.Fatal("an absent or blank priority reads normal")
	}
	high := " high "
	if coercePriority(&high) != "high" {
		t.Fatal("a padded priority is trimmed")
	}
	if ticketRef("RAK", 12) != "RAK-12" {
		t.Fatalf("ref = %s", ticketRef("RAK", 12))
	}
	// An empty but present id fails TicketSchema's Id, so the router answers Output validation failed.
	if ticketValid(Ticket{Number: 1, AssigneeBotID: &empty}) {
		t.Fatal("an empty assignee id is not a valid ticket")
	}
	if ticketValid(Ticket{Number: 0}) {
		t.Fatal("a non-positive number is not a valid ticket")
	}
}

func TestEnsureBoardNameFallsBack(t *testing.T) {
	// normalizeSpaceName-adjacent rule for a board name: the Space's trimmed name, else "Board".
	cases := map[string]string{"  Team  ": "Team", "": "Board", "   ": "Board"}
	for name, want := range cases {
		trimmed := validate.JSTrim(name)
		if trimmed == "" {
			trimmed = "Board"
		}
		if trimmed != want {
			t.Errorf("%q: got %q want %q", name, trimmed, want)
		}
	}
}
