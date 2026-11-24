package messageblocks

import "testing"

func TestStrMaxUsesZodSurrogateLength(t *testing.T) {
	emoji := "😀"
	lone := "\xed\xa0\x80"
	for _, accepted := range []struct {
		limit int
		input string
	}{{2, "ab"}, {2, emoji}, {3, emoji + "a"}, {1, lone}} {
		if _, ok := strMax(accepted.limit)(accepted.input); !ok {
			t.Errorf("strMax(%d)(%q) rejected", accepted.limit, accepted.input)
		}
	}
	for limit, input := range map[int]string{
		0: lone,
		2: emoji + "ab",
	} {
		if _, ok := strMax(limit)(input); ok {
			t.Errorf("strMax(%d)(%q) accepted", limit, input)
		}
	}
}
