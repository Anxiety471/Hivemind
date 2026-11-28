package whatwgurl

import (
	"strings"
	"unicode/utf8"
)

// ZodURLAccepts is `z.string().url().safeParse(value).success` for zod 4.6.7,
// the version packages/contracts pins.
//
// zod trims the input with String.prototype.trim (ECMAScript white space:
// no-break space, the Unicode space separators and BOM, unlike the URL
// parser's C0-or-space trim), then accepts when `URL.canParse(trimmed)`
// succeeds. It does not require a scheme, a host or a special scheme: `mailto:`
// and `foo:` pass; a whitespace-only string, a bare `example.com` and `https://`
// do not. No `.url()` call site in this tree passes hostname, protocol or
// normalize options.
func ZodURLAccepts(value string) bool {
	return CanParse(TrimJS(value))
}

// ZodURLValue is what a successful `z.string().url()` parse stores: the
// trimmed input with ASCII tab, LF and CR removed, not the normalized href.
// zod's own stripTabAndNewline rewrites only those three characters because
// the URL parser already deleted them before reading the input; the stored
// value is otherwise the string the caller sent. ok is false when the schema
// rejects it.
func ZodURLValue(value string) (string, bool) {
	trimmed := TrimJS(value)
	if !CanParse(trimmed) {
		return "", false
	}
	return StripTabNewline(trimmed), true
}

// TrimJS is String.prototype.trim: leading and trailing ECMAScript white space
// and line terminators, in the spec's set. It differs from strings.TrimSpace,
// which uses Unicode's White_Space property: JavaScript trims U+FEFF (BOM)
// but not U+0085 (NEL), and trims U+180E neither, like Unicode 15.
func TrimJS(value string) string {
	start := 0
	for start < len(value) {
		r, size := utf8.DecodeRuneInString(value[start:])
		if !isJSWhitespace(r) {
			break
		}
		start += size
	}
	end := len(value)
	for end > start {
		r, size := utf8.DecodeLastRuneInString(value[start:end])
		if !isJSWhitespace(r) {
			break
		}
		end -= size
	}
	return value[start:end]
}

// StripTabNewline removes every ASCII tab, line feed and carriage return, as
// zod's stripTabAndNewline and the URL parser's preprocessing do.
func StripTabNewline(value string) string {
	if !strings.ContainsAny(value, "\t\n\r") {
		return value
	}
	var out strings.Builder
	out.Grow(len(value))
	for _, r := range value {
		if r != '\t' && r != '\n' && r != '\r' {
			out.WriteRune(r)
		}
	}
	return out.String()
}

// isJSWhitespace is the WhiteSpace and LineTerminator set of ECMA-262 §12.2:
// TAB, LF, VT, FF, CR, SP, NBSP, OGHAM SPACE MARK, U+2000..U+200A, LS, PS,
// NARROW NBSP, MEDIUM MATHEMATICAL SPACE, IDEOGRAPHIC SPACE and BOM.
func isJSWhitespace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ',
		'\u00a0', '\u1680',
		'\u2000', '\u2001', '\u2002', '\u2003', '\u2004', '\u2005',
		'\u2006', '\u2007', '\u2008', '\u2009', '\u200a',
		'\u2028', '\u2029', '\u202f', '\u205f', '\u3000', '\ufeff':
		return true
	}
	return false
}
