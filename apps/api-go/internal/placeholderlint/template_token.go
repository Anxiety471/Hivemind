package placeholderlint

import (
	"slices"
	"strings"
)

// TemplateToken flags values that are, or contain as a clearly delimited
// token, a template escape: "${...}", "{{...}}", an angle token such as
// "<name>", or a printf token such as "%s", "%d" or "%1".
//
// The check stays conservative around characters that are ordinary in real
// values: percent-encoding in URLs ("%20", "%2F") is not a printf token, and
// comparison prose ("x < y", "5 < 10 > 3") is not an angle token.
type TemplateToken struct{}

// Name implements Rule.
func (TemplateToken) Name() string { return "template-token" }

// Check implements Rule.
func (TemplateToken) Check(argument Argument) bool {
	value := argument.Value
	return containsDollarToken(value) ||
		containsBraceToken(value) ||
		containsAngleToken(value) ||
		containsPrintfToken(value)
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
func containsAngleToken(value string) bool {
	for start := range len(value) {
		if value[start] != '<' {
			continue
		}
		closing := strings.IndexByte(value[start+1:], '>')
		if closing < 0 {
			return false
		}
		end := start + 1 + closing
		if angleTokenContent(value[start+1:end]) && angleDelimited(value, start, end) {
			return true
		}
	}
	return false
}

func angleTokenContent(content string) bool {
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
	return hasLetter && !angleTokenDenied(content)
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
	// C++ standard headers.
	"algorithm", "array", "atomic", "bitset", "cassert", "cctype", "cerrno",
	"cfloat", "chrono", "cinttypes", "climits", "cmath", "codecvt", "complex",
	"condition_variable", "csetjmp", "csignal", "cstdarg", "cstddef",
	"cstdint", "cstdio", "cstdlib", "cstring", "ctime", "cwchar", "cwctype",
	"deque", "exception", "filesystem", "forward_list", "fstream",
	"functional", "future", "initializer_list", "iomanip", "ios", "iosfwd",
	"iostream", "istream", "iterator", "limits", "list", "locale", "map",
	"memory", "mutex", "new", "numeric", "optional", "ostream", "queue",
	"random", "ratio", "regex", "set", "shared_mutex", "sstream", "stack",
	"stdbool", "stdexcept", "stdio.h", "stdlib.h", "string", "string.h",
	"string_view", "system_error", "thread", "tuple", "type_traits",
	"typeindex", "typeinfo", "unordered_map", "unordered_set", "utility",
	"valarray", "variant", "vector", "wchar.h", "wctype.h",
}

func angleTokenDenied(content string) bool {
	normalized := strings.ToLower(strings.TrimSpace(content))
	return slices.Contains(angleTokenDenylist, normalized)
}

func angleDelimited(value string, start, end int) bool {
	if start > 0 && isWordByte(value[start-1]) {
		return false
	}
	if end+1 < len(value) && isWordByte(value[end+1]) {
		return false
	}
	return true
}

func isWordByte(character byte) bool {
	return character >= 'A' && character <= 'Z' ||
		character >= 'a' && character <= 'z' ||
		character >= '0' && character <= '9' ||
		character == '_'
}

// containsPrintfToken looks for "%s", "%d" and "%1" through "%9". A token
// followed by another word character does not count, which keeps words like
// "%done" and positional text alone; two characters after "%2" or "%1" that
// are both hexadecimal digits mean percent-encoding, not printf.
func containsPrintfToken(value string) bool {
	for index := range len(value) - 1 {
		if value[index] != '%' {
			continue
		}
		switch verb := value[index+1]; {
		case verb == 's' || verb == 'd':
			if index+2 >= len(value) || !isWordByte(value[index+2]) {
				return true
			}
		case verb >= '1' && verb <= '9':
			if index+2 >= len(value) || !isHexByte(value[index+2]) {
				return true
			}
		}
	}
	return false
}

func isHexByte(character byte) bool {
	return character >= '0' && character <= '9' ||
		character >= 'a' && character <= 'f' ||
		character >= 'A' && character <= 'F'
}
