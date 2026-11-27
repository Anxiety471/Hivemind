package bots

import "testing"

func text(value string) map[string]any { return map[string]any{"kind": "text", "text": value} }

func thinking() map[string]any { return map[string]any{"kind": "thinking"} }

func TestIsNoResponseMessage(t *testing.T) {
	bot := func(id string, blocks ...any) *outlineMessage {
		return &outlineMessage{ID: id, Role: "bot", Loaded: true, Blocks: blocks}
	}
	cases := []struct {
		name    string
		message *outlineMessage
		want    bool
	}{
		{"persisted fallback text", bot("m1", text("No response. Try again.")), true},
		{"fallback padded with whitespace", bot("m2", text("  \n No response. Try again. \t")), true},
		{"fallback split across text blocks", bot("m3", text("No response. "), text("Try again.")), true},
		{"fallback after thinking", bot("m4", thinking(), text("No response. Try again.")), true},
		{"thinking only", bot("m5", thinking()), true},
		{"thinking and whitespace text", bot("m6", thinking(), text("  \n")), true},
		{"empty blocks nil", &outlineMessage{ID: "m7", Role: "bot", Loaded: true}, true},
		{"empty blocks slice", &outlineMessage{ID: "m8", Role: "bot", Loaded: true, Blocks: []any{}}, true},
		{"whitespace-only text", bot("m9", text("   ")), true},
		{"unloaded outline empty", &outlineMessage{ID: "m10", Role: "bot", Loaded: false, Blocks: []any{}}, false},
		{"unloaded outline text kind", &outlineMessage{ID: "m11", Role: "bot", Loaded: false,
			Blocks: []any{map[string]any{"kind": "text"}}}, false},
		{"live progress thinking only", bot("progress:run-1", thinking()), false},
		{"user literal fallback", &outlineMessage{ID: "m12", Role: "user", Loaded: true,
			Blocks: []any{text("No response. Try again.")}}, false},
		{"user empty", &outlineMessage{ID: "m13", Role: "user", Loaded: true}, false},
		{"bot prose quoting fallback", bot("m14", text(`I got "No response. Try again." from the tool.`)), false},
		{"steps block", bot("m15", thinking(), map[string]any{"kind": "steps"}), false},
		{"ask block", bot("m16", thinking(), map[string]any{"kind": "ask"}), false},
		{"image block", bot("m17", thinking(), map[string]any{"kind": "image"}), false},
		{"file block", bot("m18", thinking(), map[string]any{"kind": "file"}), false},
		{"non-object block", bot("m19", "text"), false},
		{"text with non-string text", bot("m20", map[string]any{"kind": "text", "text": 1}), false},
		{"non-empty bot reply", bot("m21", text("Hello there")), false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := isNoResponseMessage(tc.message); got != tc.want {
				t.Fatalf("isNoResponseMessage() = %v, want %v", got, tc.want)
			}
		})
	}
}
