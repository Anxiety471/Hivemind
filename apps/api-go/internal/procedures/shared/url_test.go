package shared

import (
	"encoding/json"
	"errors"
	"os"
	"testing"
)

// The corpus is what Node's `new URL("/join/" + id, origin).toString()` answers
// (tools/url-corpus.mts): every ASCII character in each position, dot segments, separators,
// query and fragment parts, and non-ASCII text.
func TestJoinURLMatchesTheWHATWGParser(t *testing.T) {
	var rows []struct{ ID, Href string }
	body, err := os.ReadFile("testdata/join-urls.json")
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(body, &rows); err != nil {
		t.Fatal(err)
	}
	if len(rows) < 500 {
		t.Fatalf("corpus has %d rows", len(rows))
	}
	for _, row := range rows {
		got, err := JoinURL("https://bots.bocchi.trade", "/join/"+row.ID)
		if err != nil || got != row.Href {
			t.Errorf("JoinURL(%q) = %q, %v; want %q", row.ID, got, err, row.Href)
		}
	}
}

func TestJoinURLNormalisesTheOrigin(t *testing.T) {
	var rows []struct{ Origin, Href string }
	body, err := os.ReadFile("testdata/join-origins.json")
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(body, &rows); err != nil {
		t.Fatal(err)
	}
	for _, row := range rows {
		got, err := JoinURL(row.Origin, "/join/abc")
		switch row.Origin {
		case "https://bücher.example", "https://user:pw@example.com":
			// Not plain scheme://host[:port]: refused rather than answered differently.
			if !errors.Is(err, ErrUnsupportedURL) {
				t.Errorf("JoinURL(%q) = %q, %v; want ErrUnsupportedURL", row.Origin, got, err)
			}
		default:
			if err != nil || got != row.Href {
				t.Errorf("JoinURL(%q) = %q, %v; want %q", row.Origin, got, err, row.Href)
			}
		}
	}
}

func TestJoinURLRefusesHostsWHATWGRewrites(t *testing.T) {
	for _, origin := range []string{"http://127.1:5173", "http://0x7f.1", "http://2130706433", "http://1.2.3", "http://[0:0:0:0:0:0:0:1]:80", "http://[::FFFF:1.2.3.4]", "http://example.1"} {
		if got, err := JoinURL(origin, "/join/abc"); !errors.Is(err, ErrUnsupportedURL) {
			t.Errorf("JoinURL(%q) = %q, %v; want ErrUnsupportedURL", origin, got, err)
		}
	}
	for origin, want := range map[string]string{"http://127.0.0.1:5173": "http://127.0.0.1:5173/join/abc", "http://[::1]:5173": "http://[::1]:5173/join/abc", "https://a1.example": "https://a1.example/join/abc"} {
		if got, err := JoinURL(origin, "/join/abc"); err != nil || got != want {
			t.Errorf("JoinURL(%q) = %q, %v", origin, got, err)
		}
	}
}
