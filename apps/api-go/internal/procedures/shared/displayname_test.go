package shared

import "testing"

func TestDisplayName(t *testing.T) {
	text := func(value string) *string { return &value }
	cases := []struct {
		name *string
		want string
	}{
		{nil, "fallback"},
		{text(""), "fallback"},
		{text("   "), "fallback"},
		{text("---"), "fallback"},
		{text("  Team  "), "Team"},
		{text("Привет"), "Привет"},
		{text("__token__"), "fallback"},
		{text("123e4567-e89b-12d3-a456-426614174000"), "fallback"},
		{text("ckjh2k3l4m5n6o7p8q9r0s1t2"), "fallback"},
		{text("abcdefghijklmnopqrstuvw1"), "fallback"},
		{text("Marketing2"), "Marketing2"},
		{text("Q3Plans"), "Q3Plans"},
		{text("aB3dEf6hIj9lMn2pQr5tUv8"), "fallback"},
	}
	for _, c := range cases {
		if got := DisplayName(c.name, "fallback"); got != c.want {
			label := "<nil>"
			if c.name != nil {
				label = *c.name
			}
			t.Errorf("DisplayName(%q) = %q, want %q", label, got, c.want)
		}
	}
}

func TestUTF16Length(t *testing.T) {
	for text, want := range map[string]int{"": 0, "abc": 3, "é": 1, "😀": 2, "a😀b": 4} {
		if got := UTF16Length(text); got != want {
			t.Errorf("UTF16Length(%q) = %d, want %d", text, got, want)
		}
	}
}

func TestStoredTextReplacesNUL(t *testing.T) {
	if got := StoredText("a\x00b"); got != "a\uFFFDb" {
		t.Fatalf("StoredText = %q", got)
	}
}
