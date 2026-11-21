package tickets

import (
	"encoding/json"
	"slices"
	"strings"
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
	if ticketValid(Ticket{Number: 1, OwnerUserID: &empty}) {
		t.Fatal("an empty owner user id is not a valid ticket")
	}
	if ticketValid(Ticket{Number: 1, OwnerBotID: &empty}) {
		t.Fatal("an empty owner bot id is not a valid ticket")
	}
	if ticketValid(Ticket{Number: 1, WorkerBotIDs: []string{"bot-1", ""}}) {
		t.Fatal("an empty worker bot id is not a valid ticket")
	}
	if ticketValid(Ticket{Number: 0}) {
		t.Fatal("a non-positive number is not a valid ticket")
	}
	botID := "bot-1"
	userID := "user-1"
	mapped, ok := dto(ticketRow{
		ID:            "t1",
		BoardID:       "b1",
		SpaceID:       "s1",
		Number:        1,
		Title:         "Ship",
		Status:        "todo",
		AssigneeBotID: &botID,
		OwnerUserID:   &userID,
	}, "RAK")
	if !ok || mapped.OwnerUserID == nil || *mapped.OwnerUserID != "user-1" {
		t.Fatalf("unexpected dto: %+v ok=%v", mapped, ok)
	}
	if len(mapped.WorkerBotIDs) != 1 || mapped.WorkerBotIDs[0] != "bot-1" {
		t.Fatalf("expected legacy assigneeBotId to populate WorkerBotIDs, got %+v", mapped.WorkerBotIDs)
	}
}

func TestWakesOnStatusAsksForWorkOnly(t *testing.T) {
	for status, want := range map[string]bool{
		"todo": true, "doing": true, "review": true, "blocked": false, "done": false, "closed": false,
	} {
		if wakesOnStatus(status) != want {
			t.Errorf("%s: wakesOnStatus = %v, want %v", status, !want, want)
		}
	}
}

func TestCommentNoteQuotesAndCutsTheComment(t *testing.T) {
	if got := commentNote(`Use "staging"`); got != `A person commented: "Use \"staging\""` {
		t.Fatalf("note = %s", got)
	}
	long := commentNote(strings.Repeat("é", 500))
	if !strings.HasSuffix(long, `…"`) || len([]rune(long)) > len("A person commented: ")+400+3 {
		t.Fatalf("a long comment is cut: %d runes", len([]rune(long)))
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

func TestParseListValidatesOptionalFilters(t *testing.T) {
	parsed, failure := parseList(input(`{"status":"doing","q":"  redis %_  ","workerBotId":"bot-1"}`))
	if failure != nil || parsed.Status == nil || *parsed.Status != "doing" || parsed.Q == nil || *parsed.Q != "redis %_" {
		t.Fatalf("parsed = %+v failure = %v", parsed, failure)
	}
	if escapeSearchWildcards(*parsed.Q) != `redis \%\_` {
		t.Fatalf("escaped = %s", escapeSearchWildcards(*parsed.Q))
	}
	if _, failure := parseList(input(`{"status":"unknown"}`)); failure == nil {
		t.Fatal("invalid status must be refused")
	}
}

func TestParseCreateAndUpdateValidateOwnerAndWorkers(t *testing.T) {
	created, failure := parseCreate(input(`{"title":"  Ship queue  ","workerBotIds":["bot-1","bot-2"]}`))
	if failure != nil || created.Title != "Ship queue" || created.Priority != "normal" || len(created.WorkerBotIDs) != 2 {
		t.Fatalf("created = %+v failure = %v", created, failure)
	}
	if _, failure := parseCreate(input(`{"title":"Ship","ownerUserId":"u1","ownerBotId":"b1"}`)); failure == nil {
		t.Fatal("setting both ownerUserId and ownerBotId must be refused")
	}
	updated, failure := parseUpdate(input(`{"id":"t1","status":"review","ownerUserId":null}`))
	if failure != nil || updated.ID != "t1" || !updated.HasStatus || updated.Status != "review" || !updated.HasOwnerUserID || updated.OwnerUserID != nil {
		t.Fatalf("updated = %+v failure = %v", updated, failure)
	}
	if _, failure := parseUpdate(input(`{"id":"t1","ownerUserId":"u1","ownerBotId":"b1"}`)); failure == nil {
		t.Fatal("setting both ownerUserId and ownerBotId on update must be refused")
	}
}

func TestExtractMentionedBotIDsAndTextMentionsUser(t *testing.T) {
	bots := []SpaceBot{
		{ID: "b1", Name: "Grok Bot · Chief of Staff"},
		{ID: "b2", Name: "Potato · Dev Ops"},
		{ID: "b3", Name: "Cloudflare Manager"},
	}
	got := ExtractMentionedBotIDs("Blocked on @Potato and waiting on @Cloudflare Manager", bots, "b1")
	if len(got) != 2 || got[0] != "b2" || got[1] != "b3" {
		t.Fatalf("mentioned bots = %+v", got)
	}
	if !TextMentionsUser("Still blocked on Joshua: excludes go/no-go", []string{"Joshua"}) {
		t.Fatal("expected blocked on Joshua to match user mention")
	}
	if !TextMentionsUser("Need approval from @user before proceeding", nil) {
		t.Fatal("expected @user to match user mention")
	}
	if TextMentionsUser("Routine background check completed", []string{"Joshua"}) {
		t.Fatal("expected unrelated text not to match user mention")
	}

	desc := "Blocked on @Joshua for approval"
	blockedTicket := Ticket{ID: "t1", Status: "blocked", Title: "Deploy", Description: &desc}
	if !ticketMentionsUser(blockedTicket, nil, "u1", []string{"Joshua"}) {
		t.Fatal("expected blocked ticket mentioning user to flag MentionsMe")
	}
	userID := "u1"
	if ticketMentionsUser(blockedTicket, &latestTicketComment{AuthorUserID: &userID, Body: "Approved"}, "u1", []string{"Joshua"}) {
		t.Fatal("expected user reply comment to resolve MentionsMe")
	}
	doingTicket := Ticket{ID: "t1", Status: "doing", Title: "Deploy", Description: &desc}
	if ticketMentionsUser(doingTicket, nil, "u1", []string{"Joshua"}) {
		t.Fatal("expected doing ticket not to flag MentionsMe")
	}
	doneTicket := Ticket{ID: "t1", Status: "done", Title: "Deploy", Description: &desc}
	if ticketMentionsUser(doneTicket, nil, "u1", []string{"Joshua"}) {
		t.Fatal("expected done ticket not to flag MentionsMe")
	}
}

func TestWaitingOnBotIDs(t *testing.T) {
	bots := []SpaceBot{
		{ID: "b1", Name: "Grok Bot"},
		{ID: "b2", Name: "Potato · Dev Ops"},
		{ID: "b3", Name: "Eggbot"},
	}
	desc := "Blocked on @Potato for the host grant; @GrokBot keeps going after."
	blocked := Ticket{ID: "t1", Status: "blocked", Title: "Deploy", Description: &desc, WorkerBotIDs: []string{"b1"}}
	comment := &latestTicketComment{Body: "Also waiting on @Eggbot to ship."}
	if got := waitingOnBotIDs(blocked, comment, bots); !slices.Equal(got, []string{"b2", "b3"}) {
		t.Fatalf("waiting on = %+v, want the mentioned bots without the ticket's own worker", got)
	}
	doing := blocked
	doing.Status = "doing"
	if got := waitingOnBotIDs(doing, comment, bots); got != nil {
		t.Fatalf("a ticket that is not blocked waits on nobody, got %+v", got)
	}
}
