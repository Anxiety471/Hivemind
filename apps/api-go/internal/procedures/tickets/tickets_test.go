package tickets

import (
	"encoding/json"
	"fmt"
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

func TestNormalizePullRequestURLMatchesTheContract(t *testing.T) {
	base := "https://github.com/o/r/pull/1"
	accepted := map[string]string{
		"https://github.com/acme/app/pull/241":                          "https://github.com/acme/app/pull/241",
		"  HTTPS://GitHub.com/Acme/App/Pull/241/files  ":                "https://github.com/acme/app/pull/241",
		"https://github.com/acme/app/pull/241?diff=split#discussion_r1": "https://github.com/acme/app/pull/241",
		"https://github.com/acme/app/pull/241/":                         "https://github.com/acme/app/pull/241",
		"https://gitlab.com/group/project/-/merge_requests/42":          "https://gitlab.com/group/project/-/merge_requests/42",
		"https://gitlab.com/group/sub/project/-/merge_requests/7/files": "https://gitlab.com/group/sub/project/-/merge_requests/7",
		"https://example.com/owner/repo/pulls/12":                       "https://example.com/owner/repo/pulls/12",
		"https://example.com/owner/repo/pull-requests/12":               "https://example.com/owner/repo/pull-requests/12",
		"https://example.com/owner/repo/pull/1234567890":                "https://example.com/owner/repo/pull/1234567890",
	}
	// The limit is 500 UTF-16 code units of the trimmed, lowercased text; anything after the
	// number is dropped from the stored form.
	accepted[base+"?"+strings.Repeat("a", linkURLMaxLength-len(base)-1)] = base
	accepted[base+"?"+strings.Repeat("😀", (linkURLMaxLength-len(base)-1)/2)] = base
	for text, want := range accepted {
		got, ok := normalizePullRequestURL(text)
		if !ok || got != want {
			t.Errorf("normalizePullRequestURL(%q) = %q, %v; want %q", text, got, ok, want)
		}
	}
	for _, text := range []string{
		"http://github.com/acme/app/pull/241",
		"https://github.com/acme/app/issues/241",
		"https://github.com/acme/app/pull/0",
		"https://github.com/acme/app/pull/012",
		"https://github.com/acme/app/pull/12345678901",
		"https://github.com/acme/app/pull/-1",
		"https://github.com/acme/app/pull",
		"https://github.com/acme/app",
		"https://github.com/pull/1",
		"https://github.com/acme/app/pull/241 extra",
		"https://",
		"mailto:someone@example.com",
		base + "?" + strings.Repeat("a", linkURLMaxLength-len(base)),
		base + "?" + strings.Repeat("😀", linkURLMaxLength/2+1),
	} {
		if got, ok := normalizePullRequestURL(text); ok {
			t.Errorf("normalizePullRequestURL(%q) = %q, want rejected", text, got)
		}
	}
}

func TestNormalizeIssueURLMatchesTheContract(t *testing.T) {
	base := "https://github.com/acme/app/issues/1"
	accepted := map[string]string{
		"https://github.com/acme/app/issues/241":                "https://github.com/acme/app/issues/241",
		"  HTTPS://GitHub.com/Acme/App/Issues/241/files  ":      "https://github.com/acme/app/issues/241",
		"https://github.com/acme/app/issues/241?q=1#c":          "https://github.com/acme/app/issues/241",
		"https://github.com/acme/app/issues/241/":               "https://github.com/acme/app/issues/241",
		"https://gitlab.com/group/project/-/issues/42":          "https://gitlab.com/group/project/-/issues/42",
		"https://gitlab.com/group/sub/project/-/issues/7/files": "https://gitlab.com/group/sub/project/-/issues/7",
		"https://example.com/owner/repo/issues/1234567890":      "https://example.com/owner/repo/issues/1234567890",
	}
	accepted[base+"?"+strings.Repeat("a", linkURLMaxLength-len(base)-1)] = base
	accepted[base+"?"+strings.Repeat("😀", (linkURLMaxLength-len(base)-1)/2)] = base
	for text, want := range accepted {
		got, ok := normalizeIssueURL(text)
		if !ok || got != want {
			t.Errorf("normalizeIssueURL(%q) = %q, %v; want %q", text, got, ok, want)
		}
	}
	for _, text := range []string{
		"https://github.com/acme/app/pull/241",
		"https://github.com/acme/app/pulls/241",
		"https://github.com/acme/app/merge_requests/241",
		"https://github.com/acme/app/pull-requests/241",
		"https://github.com/acme/app/issues/0",
		"https://github.com/acme/app/issues/012",
		"https://github.com/acme/app/issues/12345678901",
		"http://github.com/acme/app/issues/1",
		"https://github.com/acme/app",
		"https://github.com/acme/app/issues/1 extra",
		"https://",
		"mailto:someone@example.com",
		base + "?" + strings.Repeat("a", linkURLMaxLength-len(base)),
		base + "?" + strings.Repeat("😀", linkURLMaxLength/2+1),
	} {
		if got, ok := normalizeIssueURL(text); ok {
			t.Errorf("normalizeIssueURL(%q) = %q, want rejected", text, got)
		}
	}
	// Each normalizer refuses the other kind, so a pull request link cannot land in tickets.issues.
	if got, ok := normalizePullRequestURL("https://github.com/acme/app/issues/1"); ok {
		t.Errorf("normalizePullRequestURL accepted an issue link: %q", got)
	}
	if got, ok := normalizeIssueURL("https://github.com/acme/app/pull/1"); ok {
		t.Errorf("normalizeIssueURL accepted a pull request link: %q", got)
	}
}

func TestNormalizeRepositoryURLMatchesTheContract(t *testing.T) {
	accepted := map[string]string{
		"https://github.com/acme/app":            "https://github.com/acme/app",
		"  HTTPS://GitHub.com/Acme/App/  ":       "https://github.com/acme/app",
		"https://github.com/acme/app.git":        "https://github.com/acme/app",
		"https://github.com/acme/app.git/":       "https://github.com/acme/app",
		"https://github.com/acme/app/":           "https://github.com/acme/app",
		"https://github.com/acme/app?tab=readme": "https://github.com/acme/app",
		"https://github.com/acme/app#readme":     "https://github.com/acme/app",
		"https://gitlab.com/group/sub/project":   "https://gitlab.com/group/sub/project",
		"https://github.com/acme/app/tree/main":  "https://github.com/acme/app/tree/main",
		"https://github.com/a/b/c/d/e/f/g/h":     "https://github.com/a/b/c/d/e/f/g/h",
		"https://github.com/acme/app/issues":     "https://github.com/acme/app/issues",
	}
	repo := "https://github.com/acme/app"
	accepted[repo+"?"+strings.Repeat("a", linkURLMaxLength-len(repo)-1)] = repo
	for text, want := range accepted {
		got, ok := normalizeRepositoryURL(text)
		if !ok || got != want {
			t.Errorf("normalizeRepositoryURL(%q) = %q, %v; want %q", text, got, ok, want)
		}
	}
	for _, text := range []string{
		"https://github.com/acme",
		"https://github.com/acme/",
		"https://github.com/a/b/c/d/e/f/g/h/i",
		"https://github.com/acme/app/pull/1",
		"https://github.com/acme/app/issues/1",
		"https://github.com/acme/app/merge_requests/1",
		"https://github.com/acme/.git",
		"https://github.com/acme/app/.git",
		"http://github.com/acme/app",
		"https://github.com/acme/app extra",
		"mailto:someone@example.com",
		repo + "?" + strings.Repeat("a", linkURLMaxLength-len(repo)),
	} {
		if got, ok := normalizeRepositoryURL(text); ok {
			t.Errorf("normalizeRepositoryURL(%q) = %q, want rejected", text, got)
		}
	}
}

func TestMergeTicketPullRequestsKeepsRecordedState(t *testing.T) {
	merged := "merged"
	current := []TicketPullRequest{{URL: "a", State: "open"}, {URL: "b", State: "merged"}}
	got := mergeTicketLinks(current, []ticketLinkInput{
		{URL: "a"}, {URL: "c", State: &merged}, {URL: "a", State: &merged}, {URL: "b"},
	})
	want := []TicketPullRequest{
		{URL: "a", State: "open"}, {URL: "c", State: "merged"}, {URL: "b", State: "merged"},
	}
	if !slices.Equal(got, want) {
		t.Fatalf("merge = %+v, want %+v", got, want)
	}
	if created := mergeTicketLinks(nil, []ticketLinkInput{{URL: "x"}}); !slices.Equal(created, []TicketPullRequest{{URL: "x", State: "open"}}) {
		t.Fatalf("a new link is open: %+v", created)
	}
	// Duplicates in the recorded list resolve the way the Map in TypeScript does: the last wins.
	later := mergeTicketLinks([]TicketPullRequest{{URL: "a", State: "merged"}, {URL: "a", State: "closed"}}, []ticketLinkInput{{URL: "a"}})
	if !slices.Equal(later, []TicketPullRequest{{URL: "a", State: "closed"}}) {
		t.Fatalf("recorded duplicate = %+v", later)
	}
	// An empty input empties the list, and the result is never nil.
	if empty := mergeTicketLinks(current, nil); empty == nil || len(empty) != 0 {
		t.Fatalf("empty merge = %#v", empty)
	}
}

func TestPullRequestMergeFinishesTicketNeedsANewMergeAndNothingOpen(t *testing.T) {
	merged := TicketPullRequest{URL: "a", State: "merged"}
	cases := []struct {
		name          string
		before, after []TicketPullRequest
		want          bool
	}{
		{"no links", nil, nil, false},
		{"only closed", nil, []TicketPullRequest{{URL: "a", State: "closed"}}, false},
		{"another still open", nil, []TicketPullRequest{merged, {URL: "b", State: "open"}}, false},
		{"new merge, rest closed", nil, []TicketPullRequest{merged, {URL: "b", State: "closed"}}, true},
		{"open becomes merged", []TicketPullRequest{{URL: "a", State: "open"}}, []TicketPullRequest{merged}, true},
		{"merge already recorded", []TicketPullRequest{merged, {URL: "b", State: "open"}}, []TicketPullRequest{merged, {URL: "b", State: "closed"}}, false},
	}
	for _, tc := range cases {
		if got := pullRequestMergeFinishesTicket(tc.before, tc.after); got != tc.want {
			t.Errorf("%s: got %v, want %v", tc.name, got, tc.want)
		}
	}
}

func TestReadStoredPullRequestsFallsBackForTheWholeList(t *testing.T) {
	list, ok := readStoredPullRequests([]byte(`[{"url":"https://github.com/acme/app/pull/1","state":"merged","label":"acme/app#1"},{"state":"open","url":"https://github.com/acme/app/pull/2"}]`))
	want := []TicketPullRequest{
		{URL: "https://github.com/acme/app/pull/1", State: "merged"},
		{URL: "https://github.com/acme/app/pull/2", State: "open"},
	}
	if !ok || !slices.Equal(list, want) {
		t.Fatalf("stored = %+v, ok=%v", list, ok)
	}
	empty, ok := readStoredPullRequests([]byte(`[]`))
	if !ok || empty == nil || len(empty) != 0 {
		t.Fatalf("empty stored = %#v, ok=%v", empty, ok)
	}
	for _, raw := range []string{
		``,
		`null`,
		`{}`,
		`"https://github.com/acme/app/pull/1"`,
		`[null]`,
		`[[]]`,
		`["https://github.com/acme/app/pull/1"]`,
		`[{"url":1,"state":"open"}]`,
		`[{"url":"https://github.com/acme/app/pull/1","state":"opened"}]`,
		`[{"url":"https://github.com/acme/app/pull/1"}]`,
		`[{"state":"open"}]`,
		`[{"url":"https://github.com/acme/app/pull/1","state":"merged"},{"url":"https://github.com/acme/app/pull/2"}]`,
	} {
		if got, ok := readStoredPullRequests([]byte(raw)); ok || len(got) != 0 {
			t.Errorf("readStoredPullRequests(%s) = %+v, %v; want a mismatch", raw, got, ok)
		}
		if got := readTicketPullRequests([]byte(raw)); got == nil || len(got) != 0 {
			t.Errorf("readTicketPullRequests(%s) = %#v; want an empty list", raw, got)
		}
	}
}

func TestReadStoredIssuesFallsBackForTheWholeList(t *testing.T) {
	list, ok := readStoredIssues([]byte(`[{"url":"https://github.com/acme/app/issues/1","state":"closed","label":"acme/app#1"},{"state":"open","url":"https://github.com/acme/app/issues/2"}]`))
	want := []TicketIssue{
		{URL: "https://github.com/acme/app/issues/1", State: "closed"},
		{URL: "https://github.com/acme/app/issues/2", State: "open"},
	}
	if !ok || !slices.Equal(list, want) {
		t.Fatalf("stored = %+v, ok=%v", list, ok)
	}
	empty, ok := readStoredIssues([]byte(`[]`))
	if !ok || empty == nil || len(empty) != 0 {
		t.Fatalf("empty stored = %#v, ok=%v", empty, ok)
	}
	for _, raw := range []string{
		``,
		`null`,
		`{}`,
		`"https://github.com/acme/app/issues/1"`,
		`[null]`,
		`[[]]`,
		`["https://github.com/acme/app/issues/1"]`,
		`[{"url":1,"state":"open"}]`,
		// A pull request state is not an issue state.
		`[{"url":"https://github.com/acme/app/issues/1","state":"merged"}]`,
		`[{"url":"https://github.com/acme/app/issues/1"}]`,
		`[{"state":"open"}]`,
		`[{"url":"https://github.com/acme/app/issues/1","state":"closed"},{"url":"https://github.com/acme/app/issues/2"}]`,
	} {
		if got, ok := readStoredIssues([]byte(raw)); ok || len(got) != 0 {
			t.Errorf("readStoredIssues(%s) = %+v, %v; want a mismatch", raw, got, ok)
		}
		if got := readTicketIssues([]byte(raw)); got == nil || len(got) != 0 {
			t.Errorf("readTicketIssues(%s) = %#v; want an empty list", raw, got)
		}
	}
}

func TestTicketDtoAlwaysCarriesIssuesAndRepository(t *testing.T) {
	issue := "https://github.com/acme/app/issues/9"
	repository := "https://github.com/acme/app"
	mapped, ok := dto(ticketRow{
		ID: "t1", BoardID: "b1", SpaceID: "s1", Number: 1, Title: "Ship", Status: "todo",
		Issues:     []byte(`[{"url":"` + issue + `","state":"closed","label":"acme/app#9"}]`),
		Repository: &repository,
	}, "RAK")
	if !ok || !slices.Equal(mapped.Issues, []TicketIssue{{URL: issue, State: "closed"}}) ||
		mapped.Repository == nil || *mapped.Repository != repository {
		t.Fatalf("dto = %+v, ok=%v", mapped, ok)
	}
	body, err := json.Marshal(mapped)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(body), `"issues":[{"url":"`+issue+`","state":"closed"}]`) ||
		!strings.Contains(string(body), `"repository":"`+repository+`"`) {
		t.Fatalf("body = %s", body)
	}
	// A ticket with neither link still carries both keys: the list and a null.
	empty, ok := dto(ticketRow{
		ID: "t1", BoardID: "b1", SpaceID: "s1", Number: 1, Title: "Ship", Status: "todo",
	}, "RAK")
	if !ok || empty.Issues == nil || len(empty.Issues) != 0 || empty.Repository != nil {
		t.Fatalf("a ticket without links = %+v, ok=%v", empty, ok)
	}
	emptyBody, err := json.Marshal(empty)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(emptyBody), `"issues":[]`) || !strings.Contains(string(emptyBody), `"repository":null`) {
		t.Fatalf("body = %s", emptyBody)
	}
	// A stored value this release does not know shows no issues.
	broken, ok := dto(ticketRow{
		ID: "t1", BoardID: "b1", SpaceID: "s1", Number: 1, Title: "Ship", Status: "todo",
		Issues: []byte(`{"url":"` + issue + `"}`),
	}, "RAK")
	if !ok || broken.Issues == nil || len(broken.Issues) != 0 {
		t.Fatalf("a stored shape this release does not know shows no issues: %#v", broken.Issues)
	}
	// TicketSchema's order: pullRequests, then issues, then repository.
	ordered, err := json.Marshal(Ticket{
		ID: "t1", Number: 1, PullRequests: []TicketPullRequest{}, Issues: []TicketIssue{},
		Repository: &repository, WaitingOnBotIDs: []string{"bot-1"},
	})
	if err != nil {
		t.Fatal(err)
	}
	atPullRequests := strings.Index(string(ordered), `"pullRequests"`)
	atIssues := strings.Index(string(ordered), `"issues"`)
	atRepository := strings.Index(string(ordered), `"repository"`)
	atWaiting := strings.Index(string(ordered), `"waitingOnBotIds"`)
	if atPullRequests < 0 || atIssues < 0 || atRepository < 0 || atWaiting < 0 ||
		!(atPullRequests < atIssues && atIssues < atRepository && atRepository < atWaiting) {
		t.Fatalf("key order = %s", ordered)
	}
}

func TestTicketDtoAlwaysCarriesPullRequests(t *testing.T) {
	link := "https://github.com/acme/app/pull/241"
	mapped, ok := dto(ticketRow{
		ID: "t1", BoardID: "b1", SpaceID: "s1", Number: 1, Title: "Ship", Status: "todo",
		PullRequests: []byte(`[{"url":"` + link + `","state":"closed","label":"acme/app#241"}]`),
	}, "RAK")
	if !ok || !slices.Equal(mapped.PullRequests, []TicketPullRequest{{URL: link, State: "closed"}}) {
		t.Fatalf("dto = %+v, ok=%v", mapped, ok)
	}
	body, err := json.Marshal(mapped)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(body), `"pullRequests":[{"url":"`+link+`","state":"closed"}]`) {
		t.Fatalf("body = %s", body)
	}
	broken, ok := dto(ticketRow{
		ID: "t1", BoardID: "b1", SpaceID: "s1", Number: 1, Title: "Ship", Status: "todo",
		PullRequests: []byte(`{"url":"` + link + `"}`),
	}, "RAK")
	if !ok || broken.PullRequests == nil || len(broken.PullRequests) != 0 {
		t.Fatalf("a stored shape this release does not know shows no links: %#v", broken.PullRequests)
	}
	// TicketSchema's order: decision, then pullRequests, then waitingOnBotIds.
	decision := &TicketDecision{
		Question: "Deploy?",
		Options: []TicketDecisionOption{
			{ID: "choice-1", Label: "Yes"}, {ID: "choice-2", Label: "No"}, {ID: "choice-3", Label: "Later"},
		},
	}
	ordered, err := json.Marshal(Ticket{
		ID: "t1", Number: 1, Decision: decision, PullRequests: []TicketPullRequest{},
		WaitingOnBotIDs: []string{"bot-1"},
	})
	if err != nil {
		t.Fatal(err)
	}
	atDecision := strings.Index(string(ordered), `"decision"`)
	atPullRequests := strings.Index(string(ordered), `"pullRequests"`)
	atWaiting := strings.Index(string(ordered), `"waitingOnBotIds"`)
	if atDecision < 0 || atPullRequests < 0 || atWaiting < 0 || !(atDecision < atPullRequests && atPullRequests < atWaiting) {
		t.Fatalf("key order = %s", ordered)
	}
}

func pullRequestIssues(t *testing.T, failure *orpc.Error) string {
	t.Helper()
	if failure == nil {
		t.Fatal("expected a validation failure")
	}
	if failure.Code != "BAD_REQUEST" || failure.Status != 400 || failure.Message != "Input validation failed" {
		t.Fatalf("failure = %+v", failure)
	}
	body, err := orpc.Marshal(failure.Data)
	if err != nil {
		t.Fatal(err)
	}
	return string(body)
}

func sameJSON(left, right string) bool {
	var a, b any
	if json.Unmarshal([]byte(left), &a) != nil || json.Unmarshal([]byte(right), &b) != nil {
		return false
	}
	encodedA, _ := json.Marshal(a)
	encodedB, _ := json.Marshal(b)
	return string(encodedA) == string(encodedB)
}

func TestParsePullRequestsIsZodExact(t *testing.T) {
	parsed, failure := parseCreate(input(`{"title":"Ship","pullRequests":[{"url":" HTTPS://GitHub.com/Acme/App/Pull/241/files ","state":"merged"},{"url":"https://gitlab.com/g/a/b/-/merge_requests/7"}]}`))
	if failure != nil || !parsed.HasPullRequests || len(parsed.PullRequests) != 2 {
		t.Fatalf("parsed = %+v failure = %v", parsed, failure)
	}
	if parsed.PullRequests[0].URL != "https://github.com/acme/app/pull/241" ||
		parsed.PullRequests[0].State == nil || *parsed.PullRequests[0].State != "merged" {
		t.Fatalf("first link = %+v", parsed.PullRequests[0])
	}
	if parsed.PullRequests[1].URL != "https://gitlab.com/g/a/b/-/merge_requests/7" || parsed.PullRequests[1].State != nil {
		t.Fatalf("second link = %+v", parsed.PullRequests[1])
	}
	if absent, failure := parseCreate(input(`{"title":"Ship"}`)); failure != nil || absent.HasPullRequests {
		t.Fatalf("an absent list = %+v failure = %v", absent, failure)
	}
	if updated, failure := parseUpdate(input(`{"id":"t1","pullRequests":[]}`)); failure != nil || !updated.HasPullRequests || len(updated.PullRequests) != 0 {
		t.Fatalf("an empty update list = %+v failure = %v", updated, failure)
	}

	eleven := make([]string, 0, pullRequestMaxCount+1)
	for index := 1; index <= pullRequestMaxCount+1; index++ {
		eleven = append(eleven, fmt.Sprintf(`{"url":"https://example.com/o/r/pull/%d"}`, index))
	}
	cases := map[string]string{
		`{"title":"Ship","pullRequests":[{"url":"https://github.com/acme/app/issues/1"}]}`:            `{"issues":[{"code":"custom","message":"Use a pull request link such as https://example.com/owner/repo/pull/12.","path":["pullRequests",0,"url"]}]}`,
		`{"title":"Ship","pullRequests":"x"}`:                                                         `{"issues":[{"code":"invalid_type","expected":"array","message":"Invalid input: expected array, received string","path":["pullRequests"]}]}`,
		`{"title":"Ship","pullRequests":null}`:                                                        `{"issues":[{"code":"invalid_type","expected":"array","message":"Invalid input: expected array, received null","path":["pullRequests"]}]}`,
		`{"title":"Ship","pullRequests":[7]}`:                                                         `{"issues":[{"code":"invalid_type","expected":"object","message":"Invalid input: expected object, received number","path":["pullRequests",0]}]}`,
		`{"title":"Ship","pullRequests":[[]]}`:                                                        `{"issues":[{"code":"invalid_type","expected":"object","message":"Invalid input: expected object, received array","path":["pullRequests",0]}]}`,
		`{"title":"Ship","pullRequests":[{}]}`:                                                        `{"issues":[{"code":"invalid_type","expected":"string","message":"Invalid input: expected string, received undefined","path":["pullRequests",0,"url"]}]}`,
		`{"title":"Ship","pullRequests":[{"url":null}]}`:                                              `{"issues":[{"code":"invalid_type","expected":"string","message":"Invalid input: expected string, received null","path":["pullRequests",0,"url"]}]}`,
		`{"title":"Ship","pullRequests":[{"url":"https://example.com/o/r/pull/1","state":"done"}]}`:   `{"issues":[{"code":"invalid_value","message":"Invalid option: expected one of \"open\"|\"merged\"|\"closed\"","path":["pullRequests",0,"state"],"values":["open","merged","closed"]}]}`,
		`{"title":"Ship","pullRequests":[{"url":"https://example.com/o/r/pull/1","state":null}]}`:     `{"issues":[{"code":"invalid_value","message":"Invalid option: expected one of \"open\"|\"merged\"|\"closed\"","path":["pullRequests",0,"state"],"values":["open","merged","closed"]}]}`,
		`{"title":"Ship","pullRequests":[{"url":"` + strings.Repeat("a", linkURLMaxLength+1) + `"}]}`: `{"issues":[{"code":"too_big","inclusive":true,"maximum":500,"message":"Too big: expected string to have <=500 characters","origin":"string","path":["pullRequests",0,"url"]}]}`,
		`{"title":"Ship","pullRequests":[` + strings.Join(eleven, ",") + `]}`:                         `{"issues":[{"code":"too_big","inclusive":true,"maximum":10,"message":"Too big: expected array to have <=10 items","origin":"array","path":["pullRequests"]}]}`,
		// A past-the-limit array reports only the length: zod's size cap stops before the items.
		`{"title":"Ship","pullRequests":[{"url":"https://example.com/o/r/issues/1"},` + strings.Join(eleven[:len(eleven)-1], ",") + `]}`: `{"issues":[{"code":"too_big","inclusive":true,"maximum":10,"message":"Too big: expected array to have <=10 items","origin":"array","path":["pullRequests"]}]}`,
	}
	for raw, want := range cases {
		_, failure := parseCreate(input(raw))
		got := pullRequestIssues(t, failure)
		if !sameJSON(got, want) {
			t.Errorf("%s:\n got %s\nwant %s", raw, got, want)
		}
	}
}

func TestParseIssuesAndRepositoryIsZodExact(t *testing.T) {
	parsed, failure := parseCreate(input(`{"title":"Ship","issues":[{"url":" HTTPS://GitHub.com/Acme/App/Issues/241/files ","state":"closed","label":"acme/app#241"},{"url":"https://gitlab.com/g/a/b/-/issues/7"}],"repository":" HTTPS://GitHub.com/Acme/App.GIT "}`))
	if failure != nil || !parsed.HasIssues || len(parsed.Issues) != 2 || !parsed.HasRepository || parsed.Repository == nil {
		t.Fatalf("parsed = %+v failure = %v", parsed, failure)
	}
	if parsed.Issues[0].URL != "https://github.com/acme/app/issues/241" ||
		parsed.Issues[0].State == nil || *parsed.Issues[0].State != "closed" {
		t.Fatalf("first issue = %+v", parsed.Issues[0])
	}
	if parsed.Issues[1].URL != "https://gitlab.com/g/a/b/-/issues/7" || parsed.Issues[1].State != nil {
		t.Fatalf("second issue = %+v", parsed.Issues[1])
	}
	if *parsed.Repository != "https://github.com/acme/app" {
		t.Fatalf("repository = %q", *parsed.Repository)
	}
	// Neither key sent leaves both out of the write.
	if absent, failure := parseCreate(input(`{"title":"Ship"}`)); failure != nil || absent.HasIssues || absent.HasRepository || absent.Repository != nil {
		t.Fatalf("absent links = %+v failure = %v", absent, failure)
	}
	// Null is a sent value: it clears the repository and leaves the issues alone.
	if cleared, failure := parseUpdate(input(`{"id":"t1","repository":null}`)); failure != nil || !cleared.HasRepository || cleared.Repository != nil || cleared.HasIssues {
		t.Fatalf("cleared repository = %+v failure = %v", cleared, failure)
	}
	if createdNull, failure := parseCreate(input(`{"title":"Ship","repository":null}`)); failure != nil || !createdNull.HasRepository || createdNull.Repository != nil {
		t.Fatalf("null repository on create = %+v failure = %v", createdNull, failure)
	}
	if updated, failure := parseUpdate(input(`{"id":"t1","issues":[]}`)); failure != nil || !updated.HasIssues || len(updated.Issues) != 0 {
		t.Fatalf("an empty update list = %+v failure = %v", updated, failure)
	}

	eleven := make([]string, 0, issueMaxCount+1)
	for index := 1; index <= issueMaxCount+1; index++ {
		eleven = append(eleven, fmt.Sprintf(`{"url":"https://example.com/o/r/issues/%d"}`, index))
	}
	issueMessage := "Use an issue link such as https://example.com/owner/repo/issues/12."
	repositoryMessage := "Use a repository link such as https://example.com/owner/repo."
	// The issues array reports only the length past the cap, as zod's size cap stops before the items.
	elevenWithABadLink := append([]string{`{"url":"https://example.com/o/r/pull/1"}`}, eleven[:len(eleven)-1]...)
	cases := []struct {
		raw  string
		want string
	}{
		{
			`{"title":"Ship","issues":[{"url":"https://github.com/acme/app/pull/1"}]}`,
			`{"issues":[{"code":"custom","message":"` + issueMessage + `","path":["issues",0,"url"]}]}`,
		},
		{
			`{"title":"Ship","repository":"https://github.com/acme/app/pull/1"}`,
			`{"issues":[{"code":"custom","message":"` + repositoryMessage + `","path":["repository"]}]}`,
		},
		{
			`{"title":"Ship","repository":"https://github.com/acme/app/issues/1"}`,
			`{"issues":[{"code":"custom","message":"` + repositoryMessage + `","path":["repository"]}]}`,
		},
		{
			`{"title":"Ship","repository":"https://github.com/acme"}`,
			`{"issues":[{"code":"custom","message":"` + repositoryMessage + `","path":["repository"]}]}`,
		},
		{
			`{"title":"Ship","repository":""}`,
			`{"issues":[{"code":"custom","message":"` + repositoryMessage + `","path":["repository"]}]}`,
		},
		{
			`{"title":"Ship","repository":5}`,
			`{"issues":[{"code":"invalid_type","expected":"string","message":"Invalid input: expected string, received number","path":["repository"]}]}`,
		},
		{
			`{"title":"Ship","repository":true}`,
			`{"issues":[{"code":"invalid_type","expected":"string","message":"Invalid input: expected string, received boolean","path":["repository"]}]}`,
		},
		{
			`{"title":"Ship","repository":` + `"` + strings.Repeat("a", linkURLMaxLength+1) + `"}`,
			`{"issues":[{"code":"too_big","inclusive":true,"maximum":500,"message":"Too big: expected string to have <=500 characters","origin":"string","path":["repository"]}]}`,
		},
		{
			`{"title":"Ship","issues":[{"url":"https://example.com/o/r/issues/1","state":"merged"}]}`,
			`{"issues":[{"code":"invalid_value","message":"Invalid option: expected one of \"open\"|\"closed\"","path":["issues",0,"state"],"values":["open","closed"]}]}`,
		},
		{
			`{"title":"Ship","issues":[{"url":"https://example.com/o/r/issues/1","state":null}]}`,
			`{"issues":[{"code":"invalid_value","message":"Invalid option: expected one of \"open\"|\"closed\"","path":["issues",0,"state"],"values":["open","closed"]}]}`,
		},
		{
			`{"title":"Ship","issues":"x"}`,
			`{"issues":[{"code":"invalid_type","expected":"array","message":"Invalid input: expected array, received string","path":["issues"]}]}`,
		},
		{
			`{"title":"Ship","issues":[7]}`,
			`{"issues":[{"code":"invalid_type","expected":"object","message":"Invalid input: expected object, received number","path":["issues",0]}]}`,
		},
		{
			`{"title":"Ship","issues":[{}]}`,
			`{"issues":[{"code":"invalid_type","expected":"string","message":"Invalid input: expected string, received undefined","path":["issues",0,"url"]}]}`,
		},
		{
			`{"title":"Ship","issues":[{"url":null}]}`,
			`{"issues":[{"code":"invalid_type","expected":"string","message":"Invalid input: expected string, received null","path":["issues",0,"url"]}]}`,
		},
		{
			`{"title":"Ship","issues":[{"url":"` + strings.Repeat("a", linkURLMaxLength+1) + `"}]}`,
			`{"issues":[{"code":"too_big","inclusive":true,"maximum":500,"message":"Too big: expected string to have <=500 characters","origin":"string","path":["issues",0,"url"]}]}`,
		},
		{
			`{"title":"Ship","issues":[` + strings.Join(eleven, ",") + `]}`,
			`{"issues":[{"code":"too_big","inclusive":true,"maximum":10,"message":"Too big: expected array to have <=10 items","origin":"array","path":["issues"]}]}`,
		},
		{
			`{"title":"Ship","issues":[` + strings.Join(elevenWithABadLink, ",") + `]}`,
			`{"issues":[{"code":"too_big","inclusive":true,"maximum":10,"message":"Too big: expected array to have <=10 items","origin":"array","path":["issues"]}]}`,
		},
		// Schema order: pullRequests, then issues, then repository.
		{
			`{"title":"Ship","pullRequests":[{"url":"https://github.com/acme/app/issues/1"}],"issues":[{"url":"https://github.com/acme/app/pull/1"}],"repository":"nope"}`,
			`{"issues":[` +
				`{"code":"custom","message":"Use a pull request link such as https://example.com/owner/repo/pull/12.","path":["pullRequests",0,"url"]},` +
				`{"code":"custom","message":"` + issueMessage + `","path":["issues",0,"url"]},` +
				`{"code":"custom","message":"` + repositoryMessage + `","path":["repository"]}` +
				`]}`,
		},
	}
	for _, tc := range cases {
		_, failure := parseCreate(input(tc.raw))
		got := pullRequestIssues(t, failure)
		if !sameJSON(got, tc.want) {
			t.Errorf("%s:\n got %s\nwant %s", tc.raw, got, tc.want)
		}
	}
	// The update schema parses the same fields, including the repository clear.
	if _, failure := parseUpdate(input(`{"id":"t1","issues":[{"url":"https://github.com/acme/app/pull/1"}]}`)); failure == nil {
		t.Fatal("a pull request link is refused as an issue on update")
	}
	if _, failure := parseUpdate(input(`{"id":"t1","repository":"https://github.com/acme/app/merge_requests/1"}`)); failure == nil {
		t.Fatal("a merge request link is refused as a repository on update")
	}
}
