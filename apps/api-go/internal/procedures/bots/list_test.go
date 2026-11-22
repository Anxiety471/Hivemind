package bots

import (
	"testing"
	"time"
)

func TestDisabledBuiltinToolSet(t *testing.T) {
	// Trimmed known names, in order, once each; a name the catalogue no longer has is dropped.
	got := disabledBuiltinToolSet([]string{" shell ", "not_a_tool", "shell", "web_search", ""})
	if len(got) != 2 || got[0] != "shell" || got[1] != "web_search" {
		t.Fatalf("disabledBuiltinToolSet = %v", got)
	}
	if len(disabledBuiltinToolSet(nil)) != 0 {
		t.Fatal("nil names should be empty")
	}
}

func TestParseInstructionHistory(t *testing.T) {
	value := []any{
		map[string]any{
			"id": "v1", "instructions": "be kind", "reason": "first", "createdAt": "2026-01-01T00:00:00.000Z",
			"unknown": "dropped",
		},
	}
	history, failure := parseInstructionHistory(value)
	if failure != nil {
		t.Fatalf("failure = %v", failure)
	}
	if len(history) != 1 || history[0].ID != "v1" || history[0].Instructions != "be kind" {
		t.Fatalf("history = %+v", history)
	}
	if nilValue, failure := parseInstructionHistory(nil); failure != nil || len(nilValue) != 0 {
		t.Fatalf("null = %v, %v", nilValue, failure)
	}
	// A value the schema rejects throws out of mapBot: an opaque 500, not the output failure.
	for _, bad := range []any{
		"[]",
		map[string]any{},
		[]any{"entry"},
		[]any{map[string]any{"id": "", "instructions": "x", "reason": "y", "createdAt": "z"}},
		[]any{map[string]any{"id": "v", "reason": "y", "createdAt": "z"}},
		[]any{map[string]any{"id": "v", "instructions": 1, "reason": "y", "createdAt": "z"}},
	} {
		if _, failure := parseInstructionHistory(bad); failure == nil || failure.Status != 500 || failure.Message != "Internal server error" {
			t.Errorf("parseInstructionHistory(%v) = %v, want the opaque 500", bad, failure)
		}
	}
}

func TestPrimaryRunStatus(t *testing.T) {
	cases := []struct {
		statuses []string
		want     string
	}{
		{nil, "idle"},
		{[]string{"queued"}, "queued"},
		{[]string{"queued", "running"}, "running"},
		{[]string{"queued", "leased"}, "leased"},
		{[]string{"queued", "waiting_input"}, "waiting_input"},
		{[]string{"running", "waiting_takeover"}, "waiting_takeover"},
		{[]string{"queued", "running", "waiting_input", "waiting_takeover"}, "waiting_takeover"},
	}
	for _, item := range cases {
		if got := primaryRunStatus(item.statuses); got != item.want {
			t.Errorf("primaryRunStatus(%v) = %q, want %q", item.statuses, got, item.want)
		}
	}
}

func TestRosterRunErrorID(t *testing.T) {
	failed := &threadRun{ID: "run-1", Status: "failed"}
	if got := rosterRunErrorID(failed, "idle"); got == nil || *got != "run-1" {
		t.Fatalf("failed run = %v", got)
	}
	if got := rosterRunErrorID(failed, "waiting_input"); got != nil {
		t.Fatal("a paused bot shows no error")
	}
	if got := rosterRunErrorID(failed, "waiting_takeover"); got != nil {
		t.Fatal("a takeover shows no error")
	}
	if got := rosterRunErrorID(&threadRun{ID: "run-2", Status: "completed"}, "idle"); got != nil {
		t.Fatal("a completed run is not an error")
	}
	if got := rosterRunErrorID(nil, "idle"); got != nil {
		t.Fatal("no run is not an error")
	}
}

func TestMappedCoercions(t *testing.T) {
	if got := resolveAvatarSet("rakazo"); got != "rakazo" {
		t.Fatalf("rakazo = %q", got)
	}
	if got := resolveAvatarSet("something"); got != "organic" {
		t.Fatalf("unknown avatar set = %q", got)
	}
	empty, provider := "", "azure-openai-responses"
	if canonicalProviderID(&empty) != nil {
		t.Fatal("an empty provider is absent")
	}
	if got := canonicalProviderID(&provider); got == nil || *got != "azure" {
		t.Fatalf("azure provider = %v", got)
	}
	if got := canonicalProviderID(nil); got != nil {
		t.Fatal("nil provider")
	}
	if replyMode("messages") != "messages" || replyMode("CHAT") != "chat" || replyMode("") != "chat" {
		t.Fatal("reply mode coercion")
	}
}

func TestRingingCall(t *testing.T) {
	now := time.Date(2026, 11, 21, 12, 0, 0, 0, time.UTC)
	ringing := func(expiresAt string, status string) []any {
		return []any{map[string]any{
			"kind": "call_request", "status": status, "callId": "call-1", "reason": "r",
			"opening": "o", "expiresAt": expiresAt,
		}}
	}
	if call := ringingCall("bot", ringing("2026-11-21T12:00:45.000Z", "ringing"), now); call == nil ||
		call.CallID != "call-1" || call.ExpiresAt != "2026-11-21T12:00:45.000Z" {
		t.Fatalf("ringing call = %+v", call)
	}
	if call := ringingCall("bot", ringing("2026-11-21T12:00:00.000Z", "ringing"), now); call != nil {
		t.Fatal("an expired call is not ringing")
	}
	if call := ringingCall("bot", ringing("2026-11-21T12:00:45.000Z", "ended"), now); call != nil {
		t.Fatal("an ended call is not ringing")
	}
	if call := ringingCall("user", ringing("2026-11-21T12:00:45.000Z", "ringing"), now); call != nil {
		t.Fatal("only a bot message rings")
	}
	// The block must be the first one, and a person's message never rings.
	if call := ringingCall("bot", []any{map[string]any{"kind": "text", "text": "x"}}, now); call != nil {
		t.Fatal("a non-call block does not ring")
	}
	if call := ringingCall("bot", "not a list", now); call != nil {
		t.Fatal("non-list blocks do not ring")
	}
}

func block(kind string, fields map[string]any) map[string]any {
	out := map[string]any{"kind": kind}
	for key, value := range fields {
		out[key] = value
	}
	return out
}

func TestVisibleMessages(t *testing.T) {
	run := func(id string) *string { return &id }
	withRun := func(message *outlineMessage, runID string) *outlineMessage {
		message.RunID = run(runID)
		return message
	}
	loaded := func(blocks ...any) []any { return blocks }
	messages := []*outlineMessage{
		// A delivery is never shown.
		withRun(&outlineMessage{ID: "m0", Blocks: loaded(block("delivery", nil), block("text", map[string]any{"text": "hidden"}))}, "other"),
		// Ordinary user text.
		{ID: "m1", Role: "user", Blocks: loaded(block("text", map[string]any{"text": "hi"}))},
		// A background run's step text is hidden, while a non-delivery user message linked to it stays.
		withRun(&outlineMessage{ID: "m2", Role: "bot", Blocks: loaded(block("text", map[string]any{"text": "ticket work"}))}, "bg"),
		withRun(&outlineMessage{ID: "m2u", Role: "user", Blocks: loaded(block("text", map[string]any{"text": "follow up"}))}, "bg"),
		withRun(&outlineMessage{ID: "m2d", Role: "user", Blocks: loaded(block("delivery", nil), block("text", map[string]any{"text": "hidden"}))}, "bg"),
		// Its ask card stays.
		withRun(&outlineMessage{ID: "m3", Role: "bot", Blocks: loaded(block("ask", map[string]any{"text": "?"}))}, "bg"),
		// Peer receipt rows are dropped in previews.
		{ID: "m4", Role: "bot", Blocks: loaded(block("bot_message_received", map[string]any{"intent": "result"}))},
		// A peer run's text reply is dropped unless it relays.
		withRun(&outlineMessage{ID: "m5", Role: "bot", Blocks: loaded(block("text", map[string]any{"text": "peer"})),
			ReplyToMessageID: run("root")}, "peer"),
	}
	// The peer run's marker is a relay when it threads back to this bot's own message.
	marker := withRun(&outlineMessage{ID: "m6", Role: "bot", ReplyToMessageID: run("m1"),
		Blocks: loaded(block("bot_message_received", map[string]any{"intent": "result"}))}, "peer")
	messages = append(messages, marker)

	visible := visibleMessages(messages, map[string]bool{"peer": true}, map[string]bool{"bg": true})
	ids := []string{}
	for _, message := range visible {
		ids = append(ids, message.ID)
	}
	// m4 is a bare receipt and drops; m5 relays (its run's marker threads back to m1), so its
	// text stays even with delegated reply text off.
	want := []string{"m1", "m2u", "m3", "m5"}
	if len(ids) != len(want) {
		t.Fatalf("visible = %v, want %v", ids, want)
	}
	for index := range want {
		if ids[index] != want[index] {
			t.Fatalf("visible = %v, want %v", ids, want)
		}
	}

	// An unloaded marker carries only its kind, so its intent reads as unknown and it starts
	// peer work rather than relaying.
	unloadedMarker := withRun(&outlineMessage{ID: "m7", Role: "bot",
		Blocks: loaded(block("bot_message_received", nil))}, "peer")
	visible = visibleMessages([]*outlineMessage{unloadedMarker}, map[string]bool{"peer": true}, nil)
	if len(visible) != 0 {
		t.Fatalf("receipt rows are dropped, got %d", len(visible))
	}
	// The same run's text reply is not a relay, so it disappears.
	peerText := withRun(&outlineMessage{ID: "m8", Role: "bot", ReplyToMessageID: run("other"),
		Blocks: loaded(block("text", map[string]any{"text": "peer"}))}, "peer")
	if visible := visibleMessages([]*outlineMessage{unloadedMarker, peerText}, map[string]bool{"peer": true}, nil); len(visible) != 0 {
		t.Fatalf("a peer reply should fold away, got %d", len(visible))
	}
}

func TestValidateBot(t *testing.T) {
	valid := func() Bot {
		return Bot{
			ID: "b", SpaceID: "s", ThreadID: "t", AvatarSet: "organic", ReplyMode: "chat",
			ComputerMode: "team", ThinkingLevel: nil,
		}
	}
	if failure := validateBot(valid()); failure != nil {
		t.Fatalf("valid bot = %v", failure)
	}
	for name, mutate := range map[string]func(*Bot){
		"empty id":         func(bot *Bot) { bot.ID = "" },
		"bad avatar":       func(bot *Bot) { bot.AvatarSet = "x" },
		"bad memory":       func(bot *Bot) { scope := "x"; bot.MemoryScope = &scope },
		"bad thinking":     func(bot *Bot) { level := ""; bot.ThinkingLevel = &level },
		"bad reply mode":   func(bot *Bot) { bot.ReplyMode = "x" },
		"bad computer":     func(bot *Bot) { bot.ComputerMode = "x" },
		"bad call field":   func(bot *Bot) { bot.IncomingCall = &IncomingCall{CallID: 1, Reason: "r", Opening: "o", ExpiresAt: "e"} },
		"empty section id": func(bot *Bot) { empty := ""; bot.SectionID = &empty },
	} {
		bot := valid()
		mutate(&bot)
		failure := validateBot(bot)
		if failure == nil || failure.Status != 500 || failure.Message != "Output validation failed" {
			t.Errorf("%s: validateBot = %v", name, failure)
		}
	}
}
