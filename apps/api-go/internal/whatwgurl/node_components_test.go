package whatwgurl

import (
	"encoding/json"
	"os"
	"testing"
)

type corpusCase struct {
	ID       string `json:"id"`
	Input    string `json:"input"`
	Base     string `json:"base"`
	Throws   bool   `json:"throws"`
	Href     string `json:"href"`
	Origin   string `json:"origin"`
	Host     string `json:"host"`
	Hostname string `json:"hostname"`
	Port     string `json:"port"`
}

// TestNodeCorpus is the WHATWG-level differential: each case is parsed with
// Node's new URL (or new URL(ref, base)) by tools/whatwg-url-oracle.mts and
// compared component-for-component here. It includes the reviewer's 17,842
// origins and the WPT urltestdata inputs, so it is far larger than the 5k bar.
func TestNodeCorpus(t *testing.T) {
	raw, err := os.ReadFile("testdata/whatwg-url-corpus.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []corpusCase
	if err := json.Unmarshal(raw, &cases); err != nil {
		t.Fatal(err)
	}
	if len(cases) < 5000 {
		t.Fatalf("URL corpus has %d cases, want at least 5000", len(cases))
	}
	for _, tc := range cases {
		var parsed *URL
		if tc.Base == "" {
			parsed, err = Parse(tc.Input)
		} else {
			parsed, err = ParseRef(tc.Input, tc.Base)
		}
		if (err != nil) != tc.Throws {
			t.Errorf("%s: parse error = %v, Node throws = %v (%q base %q)", tc.ID, err, tc.Throws, tc.Input, tc.Base)
			continue
		}
		if tc.Throws {
			continue
		}
		if parsed.Href() != tc.Href || parsed.Origin() != tc.Origin ||
			parsed.Host() != tc.Host || parsed.Hostname() != tc.Hostname || parsed.Port() != tc.Port {
			t.Errorf("%s: got href=%q origin=%q host=%q hostname=%q port=%q, want href=%q origin=%q host=%q hostname=%q port=%q (%q base %q)",
				tc.ID, parsed.Href(), parsed.Origin(), parsed.Host(), parsed.Hostname(), parsed.Port(),
				tc.Href, tc.Origin, tc.Host, tc.Hostname, tc.Port, tc.Input, tc.Base)
		}
	}
}

func TestParseMatchesNodeComponents(t *testing.T) {
	tests := []struct {
		raw, href, origin, host, hostname, port, pathname, search, hash string
	}{
		{
			raw: "https://[::1]:8080/a?b#c", href: "https://[::1]:8080/a?b#c",
			origin: "https://[::1]:8080", host: "[::1]:8080", hostname: "[::1]", port: "8080",
			pathname: "/a", search: "?b", hash: "#c",
		},
		{
			raw: "http://example.com:80/x", href: "http://example.com/x",
			origin: "http://example.com", host: "example.com", hostname: "example.com",
			pathname: "/x",
		},
		{
			raw: "https://@example.com", href: "https://example.com/",
			origin: "https://example.com", host: "example.com", hostname: "example.com", pathname: "/",
		},
		{
			raw: "https://exa%6dple.com", href: "https://example.com/",
			origin: "https://example.com", host: "example.com", hostname: "example.com", pathname: "/",
		},
		{
			raw: "blob:https://example.com/id", href: "blob:https://example.com/id",
			origin: "https://example.com", pathname: "https://example.com/id",
		},
		{
			raw: "file:///x", href: "file:///x", origin: "null", pathname: "/x",
		},
	}
	for _, test := range tests {
		parsed, err := Parse(test.raw)
		if err != nil {
			t.Fatalf("%q: %v", test.raw, err)
		}
		if parsed.Href() != test.href || parsed.Origin() != test.origin ||
			parsed.Host() != test.host || parsed.Hostname() != test.hostname ||
			parsed.Port() != test.port || parsed.Pathname() != test.pathname ||
			parsed.Search() != test.search || parsed.Hash() != test.hash {
			t.Errorf("%q: got href=%q origin=%q host=%q hostname=%q port=%q path=%q search=%q hash=%q",
				test.raw, parsed.Href(), parsed.Origin(), parsed.Host(), parsed.Hostname(),
				parsed.Port(), parsed.Pathname(), parsed.Search(), parsed.Hash())
		}
	}
}

func TestParseRejectsNonASCIIHostSpace(t *testing.T) {
	if _, err := Parse("https://example.com\u00a0"); err == nil {
		t.Fatal("U+00A0 in a host must fail")
	}
}
