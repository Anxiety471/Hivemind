package shared

import "testing"

func TestPreviewFromBlocks(t *testing.T) {
	blocks := func(values ...any) []any { return values }
	cases := []struct {
		name   string
		blocks any
		want   string
	}{
		{"not a list", "x", ""},
		{"nil", nil, ""},
		{"empty", blocks(), ""},
		{"text", blocks(map[string]any{"kind": "text", "text": "# Hi **there**"}), "Hi there"},
		{"delivery hides everything", blocks(
			map[string]any{"kind": "text", "text": "hello"},
			map[string]any{"kind": "delivery", "text": "prompt"},
		), ""},
		{"non-string text is skipped", blocks(
			map[string]any{"kind": "card", "text": 7},
			map[string]any{"kind": "text", "text": "second"},
		), "second"},
		{"stray entries are skipped", blocks("x", nil, []any{"a"}, map[string]any{"kind": "text", "text": "- a\n- b"}),
			"a b"},
		{"first text wins", blocks(
			map[string]any{"kind": "text", "text": "one"},
			map[string]any{"kind": "text", "text": "two"},
		), "one"},
	}
	for _, item := range cases {
		if got := PreviewFromBlocks(item.blocks); got != item.want {
			t.Errorf("%s: PreviewFromBlocks = %q, want %q", item.name, got, item.want)
		}
	}
}
