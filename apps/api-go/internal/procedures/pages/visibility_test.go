package pages

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/orpc"
)

func TestPageShareURLMatchesTheContractHelper(t *testing.T) {
	token := strings.Repeat("a", 43)
	for _, test := range []struct {
		title string
		want  string
	}{
		{"Hello, World!", "https://app.example.test/p/hello-world-" + token},
		{"Café au lait", "https://app.example.test/p/cafe-au-lait-" + token},
		{"  --  ", "https://app.example.test/p/" + token},
		{"Unicode", "https://app.example.test/p/unicode-" + token},
		{strings.Repeat("a", 61) + " b", "https://app.example.test/p/" + strings.Repeat("a", 60) + "-" + token},
	} {
		got, err := pageShareURL("https://app.example.test", test.title, token)
		if err != nil {
			t.Errorf("pageShareURL(%q) failed: %v", test.title, err)
			continue
		}
		if got != test.want {
			t.Errorf("pageShareURL(%q) = %q, want %q", test.title, got, test.want)
		}
	}
	got, err := pageShareURL("https://app.example.test/base?query#fragment", "Hello", token)
	if err != nil {
		t.Fatalf("pageShareURL with a base path failed: %v", err)
	}
	if want := "https://app.example.test/p/hello-" + token; got != want {
		t.Errorf("pageShareURL(base with path) = %q, want %q", got, want)
	}
}

func rawVisibilityInput(text string) orpc.Input {
	return orpc.Input{Raw: json.RawMessage(text)}
}

func TestParseVisibilityIsStrict(t *testing.T) {
	for _, test := range []struct {
		raw    string
		status int
	}{
		{`{"pageId":"p","visibility":"link"}`, 0},
		{`{"pageId":"p","visibility":"private"}`, 0},
		{`{"pageId":"p","visibility":"public"}`, 400},
		{`{"pageId":"p","visibility":"link","extra":1}`, 400},
		{`{"pageId":"","visibility":"link"}`, 400},
	} {
		parsed, _, failure := parseVisibility(rawVisibilityInput(test.raw))
		if test.status == 0 {
			if failure != nil {
				t.Errorf("parseVisibility(%s) failed: %+v", test.raw, failure)
			} else if parsed == "" {
				t.Errorf("parseVisibility(%s) returned no page id", test.raw)
			}
			continue
		}
		if failure == nil || failure.Status != test.status {
			t.Errorf("parseVisibility(%s) = %+v, want status %d", test.raw, failure, test.status)
		}
	}
}
