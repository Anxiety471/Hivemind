package placeholderlint

import (
	"slices"
	"testing"
)

func TestTemplateTokenExtraDenylistedNames(t *testing.T) {
	t.Parallel()

	custom := TemplateToken{ExtraDenylistedNames: []string{"widget", "MyTag"}}
	cases := []struct {
		name  string
		value string
		want  bool
	}{
		{name: "extra whole value", value: "<widget>", want: false},
		{name: "extra case insensitive", value: "<Widget>", want: false},
		{name: "extra camel case", value: "<mytag>", want: false},
		{name: "built-in markup", value: "<html>", want: false},
		{name: "real placeholder", value: "<name>", want: true},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			t.Parallel()
			got := custom.Check(Argument{Path: "field", Name: "field", Value: testCase.value})
			if got != testCase.want {
				t.Fatalf("TemplateToken.Check(%q) = %v, want %v", testCase.value, got, testCase.want)
			}
		})
	}

	if !(TemplateToken{}).Check(Argument{Path: "field", Name: "field", Value: "<widget>"}) {
		t.Fatal("the default rule no longer flags a name only the custom rule denies")
	}
}

func TestDeniedAngleNames(t *testing.T) {
	t.Parallel()

	names := DeniedAngleNames()
	for _, want := range []string{"html", "vector", "stdio.h", "feed", "config"} {
		if !slices.Contains(names, want) {
			t.Fatalf("DeniedAngleNames() does not contain %q", want)
		}
	}
	if slices.Contains(names, "widget") {
		t.Fatal("DeniedAngleNames() contains a name that is not a default")
	}

	names[0] = "changed"
	if slices.Contains(DeniedAngleNames(), "changed") {
		t.Fatal("DeniedAngleNames() returns the mutable backing slice")
	}
}

func TestTemplateToken(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name  string
		value string
		want  bool
	}{
		{name: "dollar whole value", value: "${name}", want: true},
		{name: "dollar empty", value: "${}", want: true},
		{name: "dollar inside a sentence", value: "Hello ${name}, welcome", want: true},
		{name: "brace whole value", value: "{{name}}", want: true},
		{name: "brace inside a sentence", value: "Deploy to {{host}} now", want: true},
		{name: "angle whole value", value: "<name>", want: true},
		{name: "angle with underscore", value: "<your_name>", want: true},
		{name: "angle inside a sentence", value: "Hi <name>, welcome", want: true},
		{name: "angle value placeholder", value: "<value>", want: true},
		{name: "angle id placeholder", value: "<id>", want: true},
		{name: "angle path placeholder", value: "<path>", want: true},
		{name: "angle placeholder word", value: "<placeholder>", want: true},
		{name: "printf string", value: "%s", want: true},
		{name: "printf decimal", value: "id=%d", want: true},
		{name: "printf positional one", value: "%1", want: true},
		{name: "printf positional with text", value: "%9 items", want: true},
		{name: "printf in a query", value: "SELECT * FROM t WHERE id = %s", want: true},
		{name: "printf precision float", value: "Total: %.2f", want: true},
		{name: "printf value", value: "value=%v", want: true},
		{name: "printf quoted", value: "name=%q", want: true},
		{name: "printf float", value: "ratio %f", want: true},
		{name: "printf zero padded", value: "count %02d", want: true},
		{name: "printf width and precision", value: "value %3.1f", want: true},
		{name: "printf width string", value: "value %8s", want: true},
		{name: "printf plus value", value: "%+v", want: true},
		{name: "printf hash value", value: "%#v", want: true},
		{name: "printf left aligned", value: "%-10s", want: true},
		{name: "printf plus decimal", value: "%+d", want: true},
		{name: "printf hex", value: "id=%x", want: true},
		{name: "printf upper hex", value: "hex=%X", want: true},
		{name: "printf boolean", value: "flag=%t", want: true},
		{name: "printf scientific", value: "ratio=%e", want: true},
		{name: "printf upper scientific", value: "ratio=%E", want: true},
		{name: "printf short float", value: "short=%g", want: true},
		{name: "printf upper short float", value: "short=%G", want: true},
		{name: "printf binary", value: "bits=%b", want: true},
		{name: "printf octal", value: "mode=%o", want: true},

		{name: "empty", value: "", want: false},
		{name: "plain", value: "plain value", want: false},
		{name: "url percent encoding space", value: "https://x/a%20b", want: false},
		{name: "url percent encodings", value: "https://example.com/a%2Fb?q=100%25", want: false},
		{name: "percent encoded text", value: "50%25 done", want: false},
		{name: "literal percent", value: "100% done", want: false},
		{name: "percent word", value: "%done", want: false},
		{name: "percent then hex", value: "%d0", want: false},
		{name: "percent then hex digit", value: "%1F", want: false},
		{name: "encoded carriage return", value: "a%0d%0ab", want: false},
		{name: "trailing encoded carriage return", value: "line%0d", want: false},
		{name: "encoded form feed", value: "%0f ", want: false},
		{name: "uppercase encoded control pair", value: "%0D%0A", want: false},
		{name: "encoded line feed", value: "%0a", want: false},
		{name: "width two decimal ambiguity", value: "%2d", want: false},
		{name: "width ten string ambiguity", value: "%10s", want: false},
		{name: "width twenty string ambiguity", value: "%20s", want: false},
		{name: "less than prose", value: "x < y", want: false},
		{name: "angle comparison prose", value: "a < b and c > d", want: false},
		{name: "numeric comparison", value: "5 < 10 > 3", want: false},
		{name: "heart emoticon", value: "<3", want: false},
		{name: "heart emoticon in text", value: "I <3 Go", want: false},
		{name: "closing tag", value: "</div>", want: false},
		{name: "tag with attribute", value: `<div class="x">`, want: false},
		{name: "html tag", value: "<html>", want: false},
		{name: "break tag", value: "<br>", want: false},
		{name: "paragraph tag", value: "<p>", want: false},
		{name: "svg tag", value: "<svg>", want: false},
		{name: "emphasis tag in text", value: "Use <em> here", want: false},
		{name: "div tag", value: "<div>", want: false},
		{name: "span tag", value: "<span>", want: false},
		{name: "svg circle", value: "<circle>", want: false},
		{name: "svg rect", value: "<rect>", want: false},
		{name: "include vector", value: "#include <vector>", want: false},
		{name: "include stdio header", value: "#include <stdio.h>", want: false},
		{name: "include string header", value: "#include <string>", want: false},
		{name: "uppercase html tag", value: "<HTML>", want: false},
		{name: "uppercase vector header", value: "<Vector>", want: false},
		{name: "xml feed", value: "<feed>", want: false},
		{name: "xml rss", value: "<rss>", want: false},
		{name: "xml urlset", value: "<urlset>", want: false},
		{name: "xml sitemapindex", value: "<sitemapindex>", want: false},
		{name: "xml catalog", value: "<catalog>", want: false},
		{name: "xml note", value: "<note>", want: false},
		{name: "xml config", value: "<config>", want: false},
		{name: "xml manifest", value: "<manifest>", want: false},
		{name: "xml root", value: "<root>", want: false},
		{name: "c assert header", value: "#include <assert.h>", want: false},
		{name: "c unistd header", value: "#include <unistd.h>", want: false},
		{name: "c pthread header", value: "#include <pthread.h>", want: false},
		{name: "cpp any header", value: "#include <any>", want: false},
		{name: "cpp ranges header", value: "#include <ranges>", want: false},
		{name: "cpp spanstream header", value: "<spanstream>", want: false},
		{name: "angle token glued to a word", value: "a<name>b", want: false},
		{name: "email", value: "user@example.com", want: false},
		{name: "square brackets", value: "use [name] instead", want: false},
		{name: "unclosed brace token", value: "{{", want: false},
		{name: "unclosed dollar token", value: "${name", want: false},
		{name: "trailing percent", value: "100%", want: false},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			t.Parallel()
			got := (TemplateToken{}).Check(Argument{Path: "field", Name: "field", Value: testCase.value})
			if got != testCase.want {
				t.Fatalf("TemplateToken.Check(%q) = %v, want %v", testCase.value, got, testCase.want)
			}
		})
	}
}
