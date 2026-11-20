package placeholderlint

import (
	"slices"
	"strings"
	"unicode"
	"unicode/utf8"
)

// TemplateToken flags values that are, or contain as a clearly delimited
// token, a template escape: "${...}", "{{...}}", an angle token such as
// "<name>", or a printf token such as "%s", "%d" or "%1".
//
// The check stays conservative around characters that are ordinary in real
// values: percent-encoding in URLs ("%20", "%2F") is not a printf token, and
// comparison prose ("x < y", "5 < 10 > 3") is not an angle token. Markup tag
// names and C/C++ standard header names are not angle placeholders either.
//
// The zero value uses the built-in denylist. ExtraDenylistedNames adds more
// names for this rule (matching is case-insensitive), and DeniedAngleNames
// returns the built-in list for inspection or composition. DefaultRules uses
// the zero value, so its behavior is unchanged.
type TemplateToken struct {
	// ExtraDenylistedNames extends the built-in markup and header denylist.
	ExtraDenylistedNames []string
}

// Name implements Rule.
func (TemplateToken) Name() string { return "template-token" }

// Check implements Rule.
func (t TemplateToken) Check(argument Argument) bool {
	value := argument.Value
	return containsDollarToken(value) ||
		containsBraceToken(value) ||
		containsAngleToken(value, t.ExtraDenylistedNames) ||
		containsPrintfToken(value)
}

// DeniedAngleNames returns a copy of the names that TemplateToken's angle
// check treats as markup or standard headers rather than placeholders.
func DeniedAngleNames() []string {
	return slices.Clone(angleTokenDenylist)
}

func containsDollarToken(value string) bool {
	start := strings.Index(value, "${")
	return start >= 0 && strings.Contains(value[start+2:], "}")
}

func containsBraceToken(value string) bool {
	start := strings.Index(value, "{{")
	return start >= 0 && strings.Contains(value[start+2:], "}}")
}

// containsAngleToken scans for "<...>" tokens whose content can be a
// placeholder name. Anything with an attribute, a closing tag, a doctype or
// non-name characters is left alone, as is a token that touches a word
// character on either side.
func containsAngleToken(value string, extra []string) bool {
	for start := range len(value) {
		if value[start] != '<' {
			continue
		}
		closing := strings.IndexByte(value[start+1:], '>')
		if closing < 0 {
			return false
		}
		end := start + 1 + closing
		if angleTokenContent(value[start+1:end], extra) && angleDelimited(value, start, end) {
			return true
		}
	}
	return false
}

func angleTokenContent(content string, extra []string) bool {
	if len(content) == 0 || len(content) > 60 {
		return false
	}
	first := content[0]
	if !(first >= 'A' && first <= 'Z') && !(first >= 'a' && first <= 'z') && first != '_' {
		return false
	}
	hasLetter := false
	for index := range len(content) {
		character := content[index]
		switch {
		case character >= 'A' && character <= 'Z',
			character >= 'a' && character <= 'z':
			hasLetter = true
		case character >= '0' && character <= '9',
			character == '_', character == '-', character == '.', character == ' ':
		default:
			return false
		}
	}
	return hasLetter && !angleTokenDenied(content, extra)
}

// angleTokenDenylist holds markup tag names and C++ standard header names
// that are real content rather than placeholders. Add names here; matching is
// case-insensitive. "path" and "text" are deliberately absent because they
// are also common placeholder names.
var angleTokenDenylist = []string{
	// HTML elements.
	"a", "abbr", "address", "area", "article", "aside", "audio", "b", "base",
	"bdi", "bdo", "blockquote", "body", "br", "button", "canvas", "caption",
	"cite", "code", "col", "colgroup", "data", "datalist", "dd", "del",
	"details", "dfn", "dialog", "div", "dl", "dt", "em", "embed", "fieldset",
	"figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5",
	"h6", "head", "header", "hgroup", "hr", "html", "i", "iframe", "img",
	"input", "ins", "kbd", "label", "legend", "li", "link", "main", "map",
	"mark", "menu", "meta", "meter", "nav", "noscript", "object", "ol",
	"optgroup", "option", "output", "p", "picture", "pre", "progress", "q",
	"rp", "rt", "ruby", "s", "samp", "script", "search", "section", "select",
	"slot", "small", "source", "span", "strong", "style", "sub", "summary",
	"sup", "table", "tbody", "td", "template", "textarea", "tfoot", "th",
	"thead", "time", "title", "tr", "track", "u", "ul", "var", "video", "wbr",
	// Common SVG elements.
	"circle", "clippath", "defs", "desc", "ellipse", "g", "image", "line",
	"lineargradient", "marker", "mask", "metadata", "pattern", "polygon",
	"polyline", "radialgradient", "rect", "stop", "svg", "switch", "symbol",
	"tspan", "use", "view",
	// Common XML roots.
	"catalog", "config", "feed", "manifest", "note", "root", "rss",
	"sitemapindex", "urlset",
	// C standard headers.
	"assert.h", "complex.h", "ctype.h", "errno.h", "fenv.h", "float.h",
	"inttypes.h", "iso646.h", "limits.h", "locale.h", "math.h", "pthread.h",
	"setjmp.h", "signal.h", "stdalign.h", "stdarg.h", "stdatomic.h",
	"stddef.h", "stdint.h", "stdnoreturn.h", "tgmath.h", "threads.h",
	"time.h", "uchar.h", "unistd.h",
	// C++ standard headers.
	"algorithm", "any", "array", "atomic", "barrier", "bit", "bitset",
	"cassert", "cctype", "cerrno", "cfenv", "cfloat", "charconv", "chrono",
	"cinttypes", "climits", "clocale", "cmath", "codecvt", "compare",
	"complex", "concepts", "condition_variable", "coroutine", "csetjmp",
	"csignal", "cstdarg", "cstddef", "cstdint", "cstdio", "cstdlib",
	"cstring", "ctgmath", "ctime", "cuchar", "cwchar", "cwctype", "deque",
	"exception", "execution", "expected", "filesystem", "format",
	"forward_list", "fstream", "functional", "future", "generator",
	"initializer_list", "iomanip", "ios", "iosfwd", "iostream", "istream",
	"iterator", "latch", "limits", "list", "locale", "map", "mdspan",
	"memory", "memory_resource", "mutex", "new", "numbers", "numeric",
	"optional", "ostream", "queue", "random", "ranges", "ratio", "regex",
	"scoped_allocator", "semaphore", "set", "shared_mutex", "source_location",
	"spanstream", "sstream", "stack", "stacktrace", "stdbool", "stdexcept",
	"stdio.h", "stdlib.h", "stop_token", "streambuf", "string", "string.h",
	"string_view", "strstream", "syncstream", "system_error", "thread",
	"tuple", "type_traits", "typeindex", "typeinfo", "unordered_map",
	"unordered_set", "utility", "valarray", "variant", "vector", "version",
	"wchar.h", "wctype.h",
}

func angleTokenDenied(content string, extra []string) bool {
	normalized := strings.ToLower(strings.TrimSpace(content))
	if slices.Contains(angleTokenDenylist, normalized) {
		return true
	}
	for _, name := range extra {
		if strings.EqualFold(strings.TrimSpace(name), normalized) {
			return true
		}
	}
	return false
}

func angleDelimited(value string, start, end int) bool {
	if start > 0 {
		previous, _ := utf8.DecodeLastRuneInString(value[:start])
		if isWordRune(previous) {
			return false
		}
	}
	if end+1 < len(value) {
		next, _ := utf8.DecodeRuneInString(value[end+1:])
		if isWordRune(next) {
			return false
		}
	}
	return true
}

func isWordRune(character rune) bool {
	return unicode.IsLetter(character) || unicode.IsDigit(character) || character == '_'
}

func isWordByte(character byte) bool {
	return character >= 'A' && character <= 'Z' ||
		character >= 'a' && character <= 'z' ||
		character >= '0' && character <= '9' ||
		character == '_'
}

// containsPrintfToken looks for "%s", "%d", "%f", "%v", "%q", "%t", "%x",
// "%X", "%e", "%g", "%E", "%G", "%b" and "%o", numeric width and precision
// forms such as "%.2f", "%02d" and "%3.1f", flag forms such as "%+v", "%#v"
// and "%-10s", and the positional tokens "%1" through "%9". Percent-encoding
// comes first: a leading 1-9 followed by a hexadecimal digit, or 0 followed
// by d/D/f/F, is treated as an escape ("%20", "%2F", "%25", "%1F", "%0d"),
// never as printf. A token followed by another word character does not count,
// which keeps words like "%done" and "%d0" alone.
func containsPrintfToken(value string) bool {
	for index := range len(value) {
		if value[index] != '%' || percentEncodingLike(value, index) {
			continue
		}
		if numericPrintfToken(value, index) {
			return true
		}
		if index+1 < len(value) && value[index+1] >= '1' && value[index+1] <= '9' {
			return true
		}
	}
	return false
}

func percentEncodingLike(value string, index int) bool {
	if index+2 >= len(value) {
		return false
	}
	leading := value[index+1]
	if leading == '0' {
		switch value[index+2] {
		case 'd', 'D', 'f', 'F':
			return true
		}
		return false
	}
	return leading >= '1' && leading <= '9' && isHexByte(value[index+2])
}

func numericPrintfToken(value string, index int) bool {
	cursor := index + 1
	for cursor < len(value) && isPrintfFlag(value[cursor]) {
		cursor++
	}
	for cursor < len(value) && (isASCIIDigit(value[cursor]) || value[cursor] == '.') {
		cursor++
	}
	if cursor >= len(value) {
		return false
	}
	switch value[cursor] {
	case 's', 'd', 'f', 'v', 'q', 't', 'x', 'X', 'e', 'g', 'E', 'G', 'b', 'o':
	default:
		return false
	}
	following := cursor + 1
	return following >= len(value) || !isWordByte(value[following])
}

func isPrintfFlag(character byte) bool {
	switch character {
	case '+', '#', '-', ' ':
		return true
	default:
		return false
	}
}

func isASCIIDigit(character byte) bool {
	return character >= '0' && character <= '9'
}

func isHexByte(character byte) bool {
	return character >= '0' && character <= '9' ||
		character >= 'a' && character <= 'f' ||
		character >= 'A' && character <= 'F'
}
