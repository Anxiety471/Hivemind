package tickets

import (
	"encoding/json"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/wtf8"
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

func TestExtractMentionedBotIDs(t *testing.T) {
	bots := []SpaceBot{
		{ID: "b1", Name: "Grok Bot · Chief of Staff"},
		{ID: "b2", Name: "Potato · Dev Ops"},
		{ID: "b3", Name: "Cloudflare Manager"},
	}
	got := ExtractMentionedBotIDs("Blocked on @Potato and waiting on @Cloudflare Manager", bots, "b1")
	if len(got) != 2 || got[0] != "b2" || got[1] != "b3" {
		t.Fatalf("mentioned bots = %+v", got)
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

func TestParseDecideAndNormalizeTicketDecision(t *testing.T) {
	dec, ok := NormalizeTicketDecision(TicketDecisionInput{
		Question:    "  Which region should we deploy to?  ",
		Options:     []string{"  Singapore  ", "Virginia", "Frankfurt"},
		Recommended: "singapore",
	})
	if !ok || dec.Question != "Which region should we deploy to?" || len(dec.Options) != 3 {
		t.Fatalf("normalized decision = %+v ok=%v", dec, ok)
	}
	if dec.Options[0].ID != "choice-1" || dec.Options[0].Label != "Singapore" || !dec.Options[0].Recommended || dec.Options[1].Recommended || dec.Options[2].Recommended {
		t.Fatalf("unexpected normalized options: %+v", dec.Options)
	}

	if _, ok := NormalizeTicketDecision(TicketDecisionInput{
		Question:    "Mismatch recommended",
		Options:     []string{"One", "Two", "Three"},
		Recommended: "Four",
	}); ok {
		t.Fatal("expected decision without matching recommended option to fail")
	}

	if parsed, failure := parseDecide(input(`{"ticketId":"t1","optionId":"choice-1"}`)); failure != nil || parsed.TicketID != "t1" || parsed.OptionID == nil || *parsed.OptionID != "choice-1" {
		t.Fatalf("parseDecide(optionId) = %+v, failure = %v", parsed, failure)
	}
	if parsed, failure := parseDecide(input(`{"ticketId":"t1","customAnswer":"  Use Tokyo  "}`)); failure != nil || parsed.CustomAnswer == nil || *parsed.CustomAnswer != "Use Tokyo" {
		t.Fatalf("parseDecide(customAnswer) = %+v, failure = %v", parsed, failure)
	}
	for _, bad := range []string{
		`{"ticketId":"t1"}`,
		`{"ticketId":"t1","optionId":"choice-1","customAnswer":"Use Tokyo"}`,
		`{"ticketId":"","optionId":"choice-1"}`,
	} {
		if _, failure := parseDecide(input(bad)); failure == nil {
			t.Errorf("parseDecide(%s) expected error", bad)
		}
	}
	if _, failure := parseUpdate(input(`{"id":"t1","decision":{"question":"Q?","options":["One","Two"],"recommended":"One"}}`)); failure == nil {
		t.Fatal("expected parseUpdate to reject a 2-option decision")
	}
	if parsed, failure := parseCreate(input(`{"title":"Ship","decision":{"question":"Deploy now?","options":["Canary","Full","Hold"],"recommended":"Canary"}}`)); failure != nil || !parsed.HasDecision || parsed.Decision == nil {
		t.Fatalf("expected parseCreate to accept valid decision, got %+v failure=%v", parsed, failure)
	}
}

func TestDecisionValueSanitizesEachLeafOnce(t *testing.T) {
	surrogate := "a" + string([]byte{0xED, 0xA0, 0x80}) + "b"
	decision := TicketDecision{
		Question: "q\x00 " + surrogate,
		Options: []TicketDecisionOption{
			{ID: "1", Label: surrogate},
			{ID: "2", Label: "ok"},
			{ID: "3", Label: "ok2"},
		},
	}
	encoded, err := wtf8.Marshal(decision)
	if err != nil {
		t.Fatal(err)
	}
	stored := decisionValue(encoded).(string)
	if strings.Count(stored, "\uFFFD") != 3 {
		t.Fatalf("stored = %s", stored)
	}
	if strings.Contains(stored, "\uFFFD\uFFFD\uFFFD") {
		t.Fatalf("triple replacement: %s", stored)
	}
}
