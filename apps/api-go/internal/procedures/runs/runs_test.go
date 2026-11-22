package runs

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestPromptSnippetCollapsesAndTruncates(t *testing.T) {
	if got := promptSnippet("  Review \n\t the\t report  ", 120); got != "Review the report" {
		t.Errorf("promptSnippet = %q", got)
	}
	short := strings.Repeat("x", 120)
	if got := promptSnippet(short, 120); got != short {
		t.Errorf("120 units must pass through")
	}
	long := promptSnippet(strings.Repeat("x", 130), 120)
	if len([]rune(long)) != 120 || !strings.HasSuffix(long, "…") {
		t.Errorf("promptSnippet(130) = %q (%d units)", long, len([]rune(long)))
	}
	// A surrogate pair straddling the cut is dropped whole (UTF-16 length counts 2).
	astral := strings.Repeat("😀", 61)
	if got := promptSnippet(astral, 120); len([]rune(got)) != 60 {
		t.Errorf("promptSnippet astral = %d runes, want 60", len([]rune(got)))
	}
}

func TestActivityPreview(t *testing.T) {
	snippet, message, declined := activityPreview("user", "Do it", nil)
	if declined || snippet != "Do it" || message != nil {
		t.Fatalf("user trigger: %q %v %v", snippet, message, declined)
	}
	for _, blocks := range []any{nil, []any{}} {
		snippet, message, declined = activityPreview("bot_message", "ignored", blocks)
		if declined || snippet != "Message from another agent" || message == nil || message.Kind != "unknown" {
			t.Fatalf("empty blocks: %q %v %v", snippet, message, declined)
		}
	}
	block := map[string]any{
		"kind":        "bot_message_received",
		"fromBotId":   "bot-1",
		"fromBotName": "Researcher",
		"text":        "Can you check this?",
		"intent":      "request",
	}
	snippet, message, declined = activityPreview("bot_message", "ignored", []any{block})
	if declined || snippet != "Researcher asked: Can you check this?" ||
		message == nil || message.Kind != "request" ||
		message.FromBotName != "Researcher" || message.Text != "Can you check this?" {
		t.Fatalf("request block: %q %+v %v", snippet, message, declined)
	}
	result := map[string]any{"kind": "bot_message_received", "fromBotId": "b", "fromBotName": "R", "text": "", "intent": "fyi"}
	snippet, message, declined = activityPreview("bot_message", "ignored", []any{result})
	if declined || snippet != "Update from R" || message == nil || message.Kind != "update" {
		t.Fatalf("fyi block: %q %+v %v", snippet, message, declined)
	}
	badIntent := map[string]any{"kind": "bot_message_received", "fromBotId": "b", "fromBotName": "R", "text": "x", "intent": "shout"}
	if _, message, declined = activityPreview("bot_message", "ignored", []any{badIntent}); declined || message.Kind != "unknown" {
		t.Fatalf("invalid intent must read as unknown (a failed MessageBlock parse)")
	}
	// text that JS trim() empties: U+FEFF and U+3000 are JS whitespace. U+0085 is not
	// whitespace in ECMAScript (though Go's unicode.IsSpace trims it), so it stays text.
	for blank, want := range map[string]string{
		"\ufeff": "Ops asked",
		"\u3000": "Ops asked",
		"\u0085": "Ops asked: \u0085",
	} {
		block := map[string]any{
			"kind": "bot_message_received", "fromBotId": "b", "fromBotName": "Ops", "text": blank,
		}
		snippet, message, declined = activityPreview("bot_message", "ignored", []any{block})
		if declined || message == nil || message.Kind != "request" || snippet != want {
			t.Fatalf("JS-blank text %q: %q %+v %v (want %q)", blank, snippet, message, declined, want)
		}
	}
	// hop: sealed blocks decode as json.Number, legacy plaintext jsonb as float64.
	for _, hop := range []any{json.Number("3"), float64(0), float64(2)} {
		block := map[string]any{
			"kind": "bot_message_received", "fromBotId": "b", "fromBotName": "Ops", "text": "H", "hop": hop,
		}
		if _, _, declined = activityPreview("bot_message", "ignored", []any{block}); declined {
			t.Fatalf("hop %v must be accepted", hop)
		}
	}
	for _, hop := range []any{float64(1.5), float64(-1), json.Number("-1"), json.Number("1.5"), "2"} {
		block := map[string]any{
			"kind": "bot_message_received", "fromBotId": "b", "fromBotName": "Ops", "text": "H", "hop": hop,
		}
		if _, message, declined = activityPreview("bot_message", "ignored", []any{block}); declined || message.Kind != "unknown" {
			t.Fatalf("hop %v must read as unknown", hop)
		}
	}
	// Two blocks are a MessageBlock union this port does not validate: hand it back.
	valid := map[string]any{"kind": "bot_message_received", "fromBotId": "b", "fromBotName": "Ops", "text": "H"}
	_, _, declined = activityPreview("bot_message", "ignored", []any{valid, valid})
	if !declined {
		t.Fatal("multi-block bot_message must decline")
	}
	if _, _, declined = activityPreview("bot_message", "ignored", []any{map[string]any{"kind": "text", "text": "hi"}}); !declined {
		t.Fatal("a single non-received block must decline")
	}
}

func TestAgentMessageJSON(t *testing.T) {
	unknown, _ := json.Marshal(AgentMessage{Kind: "unknown"})
	if string(unknown) != `{"kind":"unknown"}` {
		t.Errorf("unknown = %s", unknown)
	}
	update, _ := json.Marshal(AgentMessage{FromBotName: "", Kind: "update", Text: "hi"})
	if string(update) != `{"fromBotName":"","kind":"update","text":"hi"}` {
		t.Errorf("update = %s", update)
	}
}
