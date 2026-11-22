package whatwgurl

import (
	"compress/gzip"
	"encoding/json"
	"os"
	"strings"
	"testing"
	"unicode/utf8"
)

// TestSingleCodePointHosts is the exhaustive host-parity fixture: for every
// non-surrogate code point, Node/ICU parsed
//
//	https://一<percent-encoded cp>一.ü/
//
// and recorded either the resulting hostname or a throw. The percent encoding
// keeps URL delimiters inside the host, so this tests the host parser rather
// than the URL state machine. The fixture comes from
// tools/idna-mapping-cases.mts and is the same Node/ICU build as the tables.
//
// The test is gated because it parses 1,112,064 short URLs; run it explicitly:
//
//	INFRA_B_EXHAUSTIVE=1 go test -run TestSingleCodePointHosts ./internal/whatwgurl
func TestSingleCodePointHosts(t *testing.T) {
	if os.Getenv("INFRA_B_EXHAUSTIVE") != "1" {
		t.Skip("set INFRA_B_EXHAUSTIVE=1 to run the 1.1M single-code-point host fixture")
	}
	file, err := os.Open("testdata/single-cp-host.json.gz")
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	reader, err := gzip.NewReader(file)
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	var fixture struct {
		Hosts []*string `json:"hosts"`
	}
	if err := json.NewDecoder(reader).Decode(&fixture); err != nil {
		t.Fatal(err)
	}
	if len(fixture.Hosts) != 0x110000 {
		t.Fatalf("fixture has %d entries, want 0x110000", len(fixture.Hosts))
	}
	failures := 0
	checked := 0
	var encoded [4]byte
	var input strings.Builder
	for cp := rune(0); cp <= utf8.MaxRune; cp++ {
		if cp >= 0xd800 && cp <= 0xdfff {
			continue
		}
		expected := fixture.Hosts[cp]
		length := utf8.EncodeRune(encoded[:], cp)
		input.Reset()
		input.Grow(len("https://一") + 3*length + len("一.ü/"))
		input.WriteString("https://一")
		for _, b := range encoded[:length] {
			const hex = "0123456789ABCDEF"
			input.WriteByte('%')
			input.WriteByte(hex[b>>4])
			input.WriteByte(hex[b&0xf])
		}
		input.WriteString("一.ü/")
		parsed, parseErr := Parse(input.String())
		checked++
		if expected == nil {
			if parseErr == nil {
				failures++
				if failures <= 20 {
					t.Errorf("U+%04X: parsed %q, Node throws", cp, parsed.Href())
				}
			}
			continue
		}
		if parseErr != nil {
			failures++
			if failures <= 20 {
				t.Errorf("U+%04X: %v, Node hostname %q", cp, parseErr, *expected)
			}
			continue
		}
		if hostname := parsed.Hostname(); hostname != *expected {
			failures++
			if failures <= 20 {
				t.Errorf("U+%04X: hostname %q, Node %q", cp, hostname, *expected)
			}
		}
	}
	if failures > 20 {
		t.Errorf("%d total single-code-point mismatches (first 20 shown)", failures)
	}
	t.Logf("checked %d non-surrogate code points", checked)
}
