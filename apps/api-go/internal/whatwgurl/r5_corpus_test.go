package whatwgurl_test

import (
	"compress/gzip"
	"encoding/json"
	"os"
	"testing"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/messageblocks"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/whatwgurl"
)

// r5Case is the round-5 reviewer's independent 22,000-case differential. It
// compares all eleven WHATWG components and, because the reviewer proved the
// write path, the TypeScript MessageBlock schema's credential and oneTimeCode
// decisions for the same raw origin string.
type r5Case struct {
	ID       string `json:"id"`
	Input    string `json:"input"`
	Base     string `json:"base"`
	Tag      string `json:"tag"`
	Throws   bool   `json:"throws"`
	Href     string `json:"href"`
	Origin   string `json:"origin"`
	Protocol string `json:"protocol"`
	Username string `json:"username"`
	Password string `json:"password"`
	Host     string `json:"host"`
	Hostname string `json:"hostname"`
	Port     string `json:"port"`
	Pathname string `json:"pathname"`
	Search   string `json:"search"`
	Hash     string `json:"hash"`
	Cred     bool   `json:"cred"`
	OTP      bool   `json:"otp"`
}

func loadR5Corpus(t *testing.T) []r5Case {
	t.Helper()
	file, err := os.Open("testdata/reviewer-r5-corpus.json.gz")
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	reader, err := gzip.NewReader(file)
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	var cases []r5Case
	if err := json.NewDecoder(reader).Decode(&cases); err != nil {
		t.Fatal(err)
	}
	return cases
}

func TestReviewerR5Corpus(t *testing.T) {
	cases := loadR5Corpus(t)
	if len(cases) != 22000 {
		t.Fatalf("reviewer r5 corpus has %d cases, want 22000", len(cases))
	}
	failures := 0
	fail := func(format string, args ...any) {
		failures++
		if failures <= 20 {
			t.Errorf(format, args...)
		}
	}
	for _, tc := range cases {
		var parsed *whatwgurl.URL
		var err error
		if tc.Base == "" {
			parsed, err = whatwgurl.Parse(tc.Input)
		} else {
			parsed, err = whatwgurl.ParseRef(tc.Input, tc.Base)
		}
		if (err != nil) != tc.Throws {
			fail("%s: parse error = %v, Node throws = %v (%q base %q)", tc.ID, err, tc.Throws, tc.Input, tc.Base)
			continue
		}
		if !tc.Throws {
			got := [11]string{parsed.Href(), parsed.Origin(), parsed.Protocol(),
				parsed.Username(), parsed.Password(), parsed.Host(), parsed.Hostname(),
				parsed.Port(), parsed.Pathname(), parsed.Search(), parsed.Hash()}
			want := [11]string{tc.Href, tc.Origin, tc.Protocol, tc.Username, tc.Password,
				tc.Host, tc.Hostname, tc.Port, tc.Pathname, tc.Search, tc.Hash}
			if got != want {
				fail("%s: got %#v, want %#v (%q base %q)", tc.ID, got, want, tc.Input, tc.Base)
			}
		}

		credential := []any{map[string]any{
			"kind": "ask", "text": "fresh credential card",
			"credential": map[string]any{
				"name": "site_login", "origin": tc.Input, "auth": map[string]any{"type": "bearer"},
			},
		}}
		_, credentialValid := messageblocks.ParseBlocks(credential)
		if credentialValid != tc.Cred {
			fail("%s: credential card valid = %v, zod = %v (origin %q)", tc.ID, credentialValid, tc.Cred, tc.Input)
		}
		oneTimeCode := []any{map[string]any{
			"kind": "ask", "text": "fresh code card",
			"oneTimeCode": map[string]any{"origin": tc.Input},
		}}
		_, oneTimeCodeValid := messageblocks.ParseBlocks(oneTimeCode)
		if oneTimeCodeValid != tc.OTP {
			fail("%s: oneTimeCode card valid = %v, zod = %v (origin %q)", tc.ID, oneTimeCodeValid, tc.OTP, tc.Input)
		}
	}
	if failures > 20 {
		t.Errorf("%d total mismatches (first 20 shown)", failures)
	}
}
