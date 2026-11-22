package whatwgurl

import (
	"compress/gzip"
	"encoding/json"
	"os"
	"testing"
)

// TestReviewerALabelCorpora replays the round-4 review corpora and the
// project's own seeded A-label mutations. Each row is an input, an optional
// base, and Node's decision plus every component `messageblocks.validOrigin`
// reads. The reviewer corpora were produced by the reviewer from Node/ICU;
// alabel-corpus.json.gz is regenerated from tools/whatwg-url-alabel-cases.mts
// and tools/whatwg-url-oracle.mts.
func TestReviewerALabelCorpora(t *testing.T) {
	for _, corpus := range []struct {
		name string
		path string
		want int
	}{
		{"reviewer-alabel", "testdata/reviewer-alabel-corpus.json.gz", 20000},
		{"reviewer-fresh", "testdata/reviewer-fresh-corpus.json.gz", 30000},
		{"own-alabel", "testdata/alabel-corpus.json.gz", 6000},
	} {
		t.Run(corpus.name, func(t *testing.T) {
			cases := readGzipCorpus(t, corpus.path)
			if len(cases) != corpus.want {
				t.Fatalf("%s has %d cases, want %d", corpus.path, len(cases), corpus.want)
			}
			for index, tc := range cases {
				var parsed *URL
				var err error
				if tc.Base == "" {
					parsed, err = Parse(tc.Input)
				} else {
					parsed, err = ParseRef(tc.Base, tc.Input)
				}
				if (err != nil) != tc.Throws {
					t.Errorf("%s[%d]: parse error = %v, Node throws = %v (%q base %q)",
						corpus.name, index, err, tc.Throws, tc.Input, tc.Base)
					continue
				}
				if tc.Throws {
					continue
				}
				if got := [11]string{parsed.Href(), parsed.Origin(), parsed.Protocol(),
					parsed.Username(), parsed.Password(), parsed.Host(), parsed.Hostname(),
					parsed.Port(), parsed.Pathname(), parsed.Search(), parsed.Hash()}; got != [11]string{
					tc.Href, tc.Origin, tc.Protocol, tc.Username, tc.Password, tc.Host,
					tc.Hostname, tc.Port, tc.Pathname, tc.Search, tc.Hash,
				} {
					t.Errorf("%s[%d]: got %#v, want %#v (%q base %q)",
						corpus.name, index, got, [11]string{tc.Href, tc.Origin, tc.Protocol,
							tc.Username, tc.Password, tc.Host, tc.Hostname, tc.Port,
							tc.Pathname, tc.Search, tc.Hash}, tc.Input, tc.Base)
				}
			}
		})
	}
}

func readGzipCorpus(t *testing.T, path string) []corpusCase {
	t.Helper()
	file, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	reader, err := gzip.NewReader(file)
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	var cases []corpusCase
	if err := json.NewDecoder(reader).Decode(&cases); err != nil {
		t.Fatal(err)
	}
	return cases
}

// TestALabelLeadingHyphen pins the class x/net/idna's punycode decoder rejects
// but ICU accepts: a delimiter at index zero, so `xn---tda` decodes to "ü".
// Node keeps the mapped label unchanged, which is what the rewrite produces.
func TestALabelLeadingHyphen(t *testing.T) {
	accepted := []struct {
		raw      string
		hostname string
	}{
		{raw: "https://xn---tda.ü/", hostname: "xn---tda.xn--tda"},
		{raw: "https://xn---0ca.ü/", hostname: "xn---0ca.xn--tda"},
		{raw: "https://XN---\u00adbcher.example\u3002:0", hostname: "xn---bcher.example."},
		{raw: "https://xN---\u00adls8h:443/x", hostname: "xn---ls8h"},
		{raw: "https://Xn---\u24e7ls8h..example", hostname: "xn---xls8h..example"},
		{raw: "https://\uff38\uff2e\uff0d\uff0d-\u2160ls8h.EXAMPLE/x", hostname: "xn---ils8h.example"},
	}
	for _, test := range accepted {
		parsed, err := Parse(test.raw)
		if err != nil {
			t.Errorf("%q: %v", test.raw, err)
			continue
		}
		if parsed.Hostname() != test.hostname {
			t.Errorf("%q: hostname = %q, want %q", test.raw, parsed.Hostname(), test.hostname)
		}
	}
	rejected := []string{
		"https://xn---.ü/",
		"https://xn---abc-.ü/",
		"https://xn---。example/",
		"https://xn--.ü/",
		"https://xn--abc-.ü/",
		"https://xn--a!.ü/",
		"https://xn--。example/",
		"https://xn--bcüer-kva.example/",
		"https://xN--xü-/?",
	}
	for _, raw := range rejected {
		if parsed, err := Parse(raw); err == nil {
			t.Errorf("%q: parsed as %q, want an error", raw, parsed.Href())
		}
	}
}
