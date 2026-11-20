package messageblocks

import "testing"

func TestStoredKeepsOnlyEntriesThatNameTheirKind(t *testing.T) {
	blocks := []any{
		map[string]any{"kind": "text", "text": "hi"},
		"stray",
		nil,
		[]any{"not", "a", "block"},
		map[string]any{"kind": 7},
		map[string]any{"text": "no kind"},
		map[string]any{"kind": "choice", "question": "q"},
	}
	kept := Stored(blocks)
	if len(kept) != 2 || kept[0]["kind"] != "text" || kept[1]["kind"] != "choice" {
		t.Fatalf("stored = %v", kept)
	}
	if got := Stored(map[string]any{"kind": "text"}); got != nil {
		t.Fatalf("a non-list reads as no blocks, got %v", got)
	}
}

func TestRewriteKeepsDroppedEntriesAsTheyWereAndReportsChange(t *testing.T) {
	stray := map[string]any{"no": "kind"}
	blocks := []any{
		map[string]any{"kind": "choice", "question": "q"},
		stray,
	}
	stored, shown, changed, ok := Rewrite(blocks, func(block map[string]any) (map[string]any, bool) {
		if block["kind"] != "choice" {
			return block, false
		}
		next := map[string]any{"kind": "choice", "question": "q", "answerId": "_dismissed"}
		return next, true
	})
	if !ok || !changed {
		t.Fatalf("ok=%v changed=%v", ok, changed)
	}
	if len(shown) != 1 || shown[0]["answerId"] != "_dismissed" {
		t.Fatalf("shown = %v", shown)
	}
	if len(stored) != 2 {
		t.Fatalf("stored keeps the stray entry: %v", stored)
	}
	if strayBack, isMap := stored[1].(map[string]any); !isMap || strayBack["no"] != "kind" {
		t.Fatalf("stored keeps the stray entry as it was: %v", stored[1])
	}
	// A change that returns every block itself writes nothing back (message-blocks.ts:99).
	unchanged := func(block map[string]any) (map[string]any, bool) { return block, false }
	if _, _, changed, ok = Rewrite(blocks, unchanged); !ok || changed {
		t.Fatalf("an unchanged rewrite: ok=%v changed=%v", ok, changed)
	}
	if _, _, _, ok = Rewrite("not a list", unchanged); ok {
		t.Fatal("a value that is not a list has nothing to write")
	}
	if _, _, _, ok = Rewrite(nil, unchanged); ok {
		t.Fatal("null has nothing to write")
	}
}
