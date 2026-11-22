package whatwgurl

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
)

// wptCase is one record of web-platform-tests urltestdata.json. A missing href
// (with "failure": true) means the constructor must throw, which is Parse's
// error.
type wptCase struct {
	Input    string  `json:"input"`
	Base     *string `json:"base"`
	Href     *string `json:"href"`
	Origin   *string `json:"origin"`
	Protocol *string `json:"protocol"`
	Username *string `json:"username"`
	Password *string `json:"password"`
	Host     *string `json:"host"`
	Hostname *string `json:"hostname"`
	Port     *string `json:"port"`
	Pathname *string `json:"pathname"`
	Search   *string `json:"search"`
	Hash     *string `json:"hash"`
	Failure  bool    `json:"failure"`
}

func readWPT[T any](t *testing.T, name string) T {
	t.Helper()
	raw, err := os.ReadFile("testdata/" + name)
	if err != nil {
		t.Fatal(err)
	}
	var records T
	if err := json.Unmarshal(raw, &records); err != nil {
		t.Fatal(err)
	}
	return records
}

func TestWPTURLTestData(t *testing.T) {
	records := readWPT[[]json.RawMessage](t, "urltestdata.json")
	cases := 0
	for _, raw := range records {
		if len(raw) > 0 && raw[0] == '"' {
			continue // the leading comment strings
		}
		var record wptCase
		if err := json.Unmarshal(raw, &record); err != nil {
			t.Fatalf("record %s: %v", raw, err)
		}
		if record.Input == "" && record.Href == nil && !record.Failure {
			continue
		}
		cases++
		var u *URL
		var err error
		if record.Base != nil {
			u, err = ParseRef(record.Input, *record.Base)
		} else {
			u, err = Parse(record.Input)
		}
		if record.Href == nil {
			if err == nil {
				t.Errorf("%q base=%v: parsed as %q, want failure", record.Input, record.Base, u.Href())
			}
			continue
		}
		if err != nil {
			t.Errorf("%q base=%v: %v, want %q", record.Input, record.Base, err, *record.Href)
			continue
		}
		check := func(field string, got string, want *string) {
			if want != nil && got != *want {
				t.Errorf("%q base=%v: %s = %q, want %q", record.Input, record.Base, field, got, *want)
			}
		}
		check("href", u.Href(), record.Href)
		check("origin", u.Origin(), record.Origin)
		check("protocol", u.Protocol(), record.Protocol)
		check("username", u.Username(), record.Username)
		check("password", u.Password(), record.Password)
		check("host", u.Host(), record.Host)
		check("hostname", u.Hostname(), record.Hostname)
		check("port", u.Port(), record.Port)
		check("pathname", u.Pathname(), record.Pathname)
		check("search", u.Search(), record.Search)
		check("hash", u.Hash(), record.Hash)
		if record.Failure {
			t.Errorf("%q base=%v: parsed, want failure", record.Input, record.Base)
		}
	}
	if cases < 800 {
		t.Fatalf("only %d cases read", cases)
	}
}

type setterCase struct {
	Href     string            `json:"href"`
	NewValue string            `json:"new_value"`
	Expected map[string]string `json:"expected"`
}

func applySetter(t *testing.T, u *URL, attribute, value string) {
	t.Helper()
	switch attribute {
	case "protocol":
		u.SetProtocol(value)
	case "username":
		u.SetUsername(value)
	case "password":
		u.SetPassword(value)
	case "host":
		u.SetHost(value)
	case "hostname":
		u.SetHostname(value)
	case "port":
		u.SetPort(value)
	case "pathname":
		u.SetPathname(value)
	case "search":
		u.SetSearch(value)
	case "hash":
		u.SetHash(value)
	default:
		t.Fatalf("setter %q not exposed", attribute)
	}
}

func TestWPTSetters(t *testing.T) {
	records := readWPT[map[string]json.RawMessage](t, "setters_tests.json")
	ran := 0
	for attribute, raw := range records {
		if attribute == "comment" || attribute == "href" {
			continue
		}
		var rows []setterCase
		if err := json.Unmarshal(raw, &rows); err != nil {
			t.Fatalf("%s: %v", attribute, err)
		}
		for _, row := range rows {
			u, err := Parse(row.Href)
			if err != nil {
				t.Fatalf("%s: %q does not parse: %v", attribute, row.Href, err)
			}
			applySetter(t, u, attribute, row.NewValue)
			for field, want := range row.Expected {
				var got string
				switch field {
				case "href":
					got = u.Href()
				case "protocol":
					got = u.Protocol()
				case "username":
					got = u.Username()
				case "password":
					got = u.Password()
				case "host":
					got = u.Host()
				case "hostname":
					got = u.Hostname()
				case "port":
					got = u.Port()
				case "pathname":
					got = u.Pathname()
				case "search":
					got = u.Search()
				case "hash":
					got = u.Hash()
				default:
					continue
				}
				if got != want {
					t.Errorf("%s=%q on %q: %s = %q, want %q", attribute, row.NewValue, row.Href, field, got, want)
				}
			}
			ran++
		}
	}
	if ran < 250 {
		t.Fatalf("only %d setter cases ran", ran)
	}
}

// TestNodeVectors pins values read from Node 24.22.3 (Ada 4.0.0). The
// differential proof regenerates them; these keep `go test` honest offline.
func TestNodeVectors(t *testing.T) {
	type vector struct {
		input, href, origin, protocol, username, password, host, hostname, port, pathname, search, hash, params string
	}
	vectors := []vector{
		{"http://א._/", "http://xn--4db._/", "http://xn--4db._", "http:", "", "", "xn--4db._", "xn--4db._", "", "/", "", "", ""},
		{"https://faß.de/", "https://xn--fa-hia.de/", "https://xn--fa-hia.de", "https:", "", "", "xn--fa-hia.de", "xn--fa-hia.de", "", "/", "", "", ""},
		{"https://例え.テスト/パス", "https://xn--r8jz45g.xn--zckzah/%E3%83%91%E3%82%B9", "https://xn--r8jz45g.xn--zckzah", "https:", "", "", "xn--r8jz45g.xn--zckzah", "xn--r8jz45g.xn--zckzah", "", "/%E3%83%91%E3%82%B9", "", "", ""},
		{"https://0x7f.1/x", "https://127.0.0.1/x", "https://127.0.0.1", "https:", "", "", "127.0.0.1", "127.0.0.1", "", "/x", "", "", ""},
		{"https://0177.1/", "https://127.0.0.1/", "https://127.0.0.1", "https:", "", "", "127.0.0.1", "127.0.0.1", "", "/", "", "", ""},
		{"https://2130706433/", "https://127.0.0.1/", "https://127.0.0.1", "https:", "", "", "127.0.0.1", "127.0.0.1", "", "/", "", "", ""},
		{"https://example.com./x", "https://example.com./x", "https://example.com.", "https:", "", "", "example.com.", "example.com.", "", "/x", "", "", ""},
		{"https://1.2.3.4./x", "https://1.2.3.4/x", "https://1.2.3.4", "https:", "", "", "1.2.3.4", "1.2.3.4", "", "/x", "", "", ""},
		{"https://%65xample.com/", "https://example.com/", "https://example.com", "https:", "", "", "example.com", "example.com", "", "/", "", "", ""},
		{"https://ｅｘａｍｐｌｅ.com/", "https://example.com/", "https://example.com", "https:", "", "", "example.com", "example.com", "", "/", "", "", ""},
		{"blob:https://example.com/x", "blob:https://example.com/x", "https://example.com", "blob:", "", "", "", "", "", "https://example.com/x", "", "", ""},
		{"blob:ftp://example.com/x", "blob:ftp://example.com/x", "null", "blob:", "", "", "", "", "", "ftp://example.com/x", "", "", ""},
		{"blob:blob:https://example.com/", "blob:blob:https://example.com/", "null", "blob:", "", "", "", "", "", "blob:https://example.com/", "", "", ""},
		{"ftp://host/path", "ftp://host/path", "ftp://host", "ftp:", "", "", "host", "host", "", "/path", "", "", ""},
		{"ws://host/x", "ws://host/x", "ws://host", "ws:", "", "", "host", "host", "", "/x", "", "", ""},
		{"wss://host:443/", "wss://host/", "wss://host", "wss:", "", "", "host", "host", "", "/", "", "", ""},
		{"file:///C:/a", "file:///C:/a", "null", "file:", "", "", "", "", "", "/C:/a", "", "", ""},
		{"mailto:x@y", "mailto:x@y", "null", "mailto:", "", "", "", "", "", "x@y", "", "", ""},
		{"foo://host/x", "foo://host/x", "null", "foo:", "", "", "host", "host", "", "/x", "", "", ""},
		{"  https://exa\nmple.com/a/../b?q#f  ", "https://example.com/b?q#f", "https://example.com", "https:", "", "", "example.com", "example.com", "", "/b", "?q", "#f", "q="},
		{"https://user:p%40ss@example.com:8443/a%2fb", "https://user:p%40ss@example.com:8443/a%2fb", "https://example.com:8443", "https:", "user", "p%40ss", "example.com:8443", "example.com", "8443", "/a%2fb", "", "", ""},
		{"https://[::1]:8080/x", "https://[::1]:8080/x", "https://[::1]:8080", "https:", "", "", "[::1]:8080", "[::1]", "8080", "/x", "", "", ""},
	}
	for _, v := range vectors {
		u, err := Parse(v.input)
		if err != nil {
			t.Errorf("%q: %v", v.input, err)
			continue
		}
		got := vector{v.input, u.Href(), u.Origin(), u.Protocol(), u.Username(), u.Password(), u.Host(), u.Hostname(), u.Port(), u.Pathname(), u.Search(), u.Hash(), u.SearchParams().String()}
		if got != v {
			t.Errorf("%q:\n got %+v\nwant %+v", v.input, got, v)
		}
	}

	for _, input := range []string{"http://aא.example/", "http://א_/", "http://f:999999/c", "https://", ""} {
		if u, err := Parse(input); err == nil {
			t.Errorf("%q: parsed as %q, want failure", input, u.Href())
		}
	}
}

func TestDefaultsAreDroppedAndSetters(t *testing.T) {
	u, err := Parse("HTTPS://EXAMPLE.COM:443/a/./b/../c?x=1#frag")
	if err != nil {
		t.Fatal(err)
	}
	if got, want := u.Href(), "https://example.com/a/c?x=1#frag"; got != want {
		t.Fatalf("href = %q, want %q", got, want)
	}
	u.SetHostname("example.com.")
	if got := u.Hostname(); got != "example.com." {
		t.Fatalf("hostname = %q", got)
	}
	u.SetPathname("/x/y/../z")
	if got, want := u.Pathname(), "/x/z"; got != want {
		t.Fatalf("pathname = %q, want %q", got, want)
	}
	u.SetHash("")
	if got := u.Hash(); got != "" {
		t.Fatalf("hash = %q", got)
	}
	u.SetSearch("?view_only=true")
	u.SearchParams().Set("view_only", "false")
	if got, want := u.Href(), "https://example.com./x/z?view_only=false"; got != want {
		t.Fatalf("href = %q, want %q", got, want)
	}
	if got := u.SearchParams().Get("view_only"); got != "false" {
		t.Fatalf("param = %q", got)
	}
}

func TestParseRefJoins(t *testing.T) {
	u, err := ParseRef("/p/my-title-Token_1234", "https://bots.bocchi.trade")
	if err != nil {
		t.Fatal(err)
	}
	if got, want := u.Href(), "https://bots.bocchi.trade/p/my-title-Token_1234"; got != want {
		t.Fatalf("href = %q, want %q", got, want)
	}
	if _, err := ParseRef("x", "not a url"); err == nil {
		t.Fatal("an invalid base must fail the reference")
	}
}

func TestZodURL(t *testing.T) {
	accepted := []string{
		"https://example.com", "mailto:x@y", "foo:", "  https://example.com  ",
		"\u00a0https://example.com\u00a0", "\ufeffhttps://example.com\ufeff",
		"https://exa\nmple.com", "custom://host/x", "blob:https://x/y",
	}
	for _, value := range accepted {
		if !ZodURLAccepts(value) {
			t.Errorf("zod rejects %q", value)
		}
	}
	rejected := []string{"", "example.com", "https://", "not a url", " ", "\u0085https://example.com"}
	for _, value := range rejected {
		if ZodURLAccepts(value) {
			t.Errorf("zod accepts %q", value)
		}
	}
	// zod stores the trimmed input with tab/LF/CR removed, not the href.
	if got, ok := ZodURLValue("  https://exa\nmple.com/a/../b  "); !ok || got != "https://example.com/a/../b" {
		t.Fatalf("value = %q, ok=%v", got, ok)
	}
	if _, ok := ZodURLValue("example.com"); ok {
		t.Fatal("a bare host must be rejected")
	}
}

func TestTrimJS(t *testing.T) {
	trimmed := "\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"
	if got := TrimJS(trimmed + "x" + trimmed); got != "x" {
		t.Fatalf("TrimJS = %q", got)
	}
	// Not ECMAScript white space: NEL and zero-width characters.
	for _, value := range []string{"\u0085x\u0085", "\u200bx", "\u180ex", "\u2060x"} {
		if got := TrimJS(value); got != value {
			t.Fatalf("TrimJS(%q) = %q", value, got)
		}
	}
	if got := StripTabNewline("a\tb\nc\rd"); got != "abcd" {
		t.Fatalf("StripTabNewline = %q", got)
	}
}

func FuzzParseRoundTrip(f *testing.F) {
	seeds := []string{
		"https://example.com", "http://0x7f.1/", "https://例え.テスト/パス?q#f",
		"file:///C:/a", "blob:https://example.com/x", "mailto:x@y", "foo://h/p",
		"  https://exa\nmple.com/a/../b  ", "//@host", "http://[::1]:0/",
	}
	for _, seed := range seeds {
		f.Add(seed)
	}
	f.Fuzz(func(t *testing.T, input string) {
		u, err := Parse(input)
		if err != nil {
			return
		}
		again, err := Parse(u.Href())
		if err != nil {
			t.Fatalf("href %q of %q does not reparse: %v", u.Href(), input, err)
		}
		if again.Href() != u.Href() {
			t.Fatalf("%q: reparsing %q gave %q", input, u.Href(), again.Href())
		}
	})
}

func TestSearchEmptyVersusPresent(t *testing.T) {
	for input, want := range map[string]string{
		"http://x/":   "",
		"http://x/?":  "",
		"http://x/?#": "",
		"http://x/#":  "",
	} {
		u, err := Parse(input)
		if err != nil {
			t.Fatal(err)
		}
		if u.Search() != want || u.Hash() != "" {
			t.Errorf("%q: search=%q hash=%q", input, u.Search(), u.Hash())
		}
	}
	if u, _ := Parse("http://x/?"); !strings.HasSuffix(u.Href(), "?") {
		t.Fatalf("href %q lost the empty query", u.Href())
	}
}

func TestNewSearchParams(t *testing.T) {
	params := NewSearchParams([]Pair{
		{Name: "autoconnect", Value: "true"},
		{Name: "path", Value: "/novnc/session/view/1.t/websockify"},
		{Name: "space", Value: "1 2"},
		{Name: "dup", Value: "1"},
		{Name: "dup", Value: "2"},
	})
	want := "autoconnect=true&path=%2Fnovnc%2Fsession%2Fview%2F1.t%2Fwebsockify&space=1+2&dup=1&dup=2"
	if got := params.String(); got != want {
		t.Fatalf("String() = %q, want %q", got, want)
	}
	if got := params.Get("space"); got != "1 2" {
		t.Fatalf("Get(space) = %q", got)
	}
	if got := params.Get("dup"); got != "1" {
		t.Fatalf("Get(dup) = %q", got)
	}
	if got := params.Get("absent"); got != "" {
		t.Fatalf("Get(absent) = %q", got)
	}
	params.Append("dup", "3")
	params.Delete("autoconnect")
	if got, want := params.String(), "path=%2Fnovnc%2Fsession%2Fview%2F1.t%2Fwebsockify&space=1+2&dup=1&dup=2&dup=3"; got != want {
		t.Fatalf("after Append/Delete = %q, want %q", got, want)
	}
	u, err := Parse("https://screen.example.com/vnc?old=1")
	if err != nil {
		t.Fatal(err)
	}
	u.SetSearch(NewSearchParams([]Pair{{Name: "view_only", Value: "false"}}).String())
	if got, want := u.Href(), "https://screen.example.com/vnc?view_only=false"; got != want {
		t.Fatalf("href = %q, want %q", got, want)
	}
	u.SetSearch(NewSearchParams(nil).String())
	if got, want := u.Href(), "https://screen.example.com/vnc"; got != want {
		t.Fatalf("empty params href = %q, want %q", got, want)
	}
}
