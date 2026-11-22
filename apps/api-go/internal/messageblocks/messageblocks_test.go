package messageblocks

import "testing"

func TestParseBlocksDropsTheWholeListOnOneInvalidEntry(t *testing.T) {
	valid := []any{
		map[string]any{"kind": "text", "text": "hi"},
		map[string]any{"kind": "ask", "text": "Allow?", "status": "pending", "approvalEffectId": "effect-1"},
	}
	blocks, ok, decidable := ParseBlocks(valid)
	if !ok || !decidable || len(blocks) != 2 {
		t.Fatalf("valid list = %v/%v/%v", blocks, ok, decidable)
	}
	malformed := append(append([]any{}, valid...), map[string]any{
		"kind": "card", "lines": []any{map[string]any{"k": "missing v"}},
	})
	if _, ok, decidable := ParseBlocks(malformed); ok || !decidable {
		t.Fatalf("malformed card list = ok=%v decidable=%v, want false/true", ok, decidable)
	}
	badStatus := []any{
		map[string]any{"kind": "text", "text": "hi"},
		map[string]any{"kind": "ask", "text": "Allow?", "status": "not-a-status", "approvalEffectId": "effect-1"},
	}
	if _, ok, decidable := ParseBlocks(badStatus); ok || !decidable {
		t.Fatalf("bad ask status = ok=%v decidable=%v, want false/true", ok, decidable)
	}
	unknown := []any{map[string]any{"kind": "text", "text": "hi"}, map[string]any{"kind": "no-such-kind"}}
	if _, ok, decidable := ParseBlocks(unknown); ok || !decidable {
		t.Fatalf("unknown kind = ok=%v decidable=%v, want false/true", ok, decidable)
	}
}

func TestParseBlocksReportsNestedSchemasItCannotDecide(t *testing.T) {
	credential := []any{map[string]any{
		"kind": "ask", "text": "Sign in?", "credential": map[string]any{"kind": "password"},
	}}
	if _, ok, decidable := ParseBlocks(credential); ok || decidable {
		t.Fatalf("credential ask = ok=%v decidable=%v, want false/false", ok, decidable)
	}
}
