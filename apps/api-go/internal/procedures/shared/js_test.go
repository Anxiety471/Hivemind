package shared

import (
	"testing"
	"time"
)

func TestBase64URLMatchesNode(t *testing.T) {
	for input, want := range map[string]string{
		"eyJhIjoxfQ":         `{"a":1}`,
		"eyJhIjoxfQ==":       `{"a":1}`,
		"ey Jh Ijox fQ":      `{"a":1}`,
		"eyJhIjox*fQ":        `{"a":1}`,
		"*eyJhIjoxfQ":        `{"a":1}`,
		"e":                  ``,
		"eyJhIjoxfQx":        "{\"a\":1}\f",
		"eyJhIjoxfQ*garbage": "{\"a\":1}\b\x1a\xad\xb6\xa0",
	} {
		if got := string(Base64URL(input)); got != want {
			t.Errorf("%q = %q, want %q", input, got, want)
		}
	}
}

// Expected values are what Buffer.prototype.toString("utf8") returns: one U+FFFD per maximal
// subpart of an ill-formed sequence.
func TestUTF8ReplacesMaximalSubparts(t *testing.T) {
	for name, tc := range map[string]struct {
		in   []byte
		want string
	}{
		"valid":                   {[]byte("a\u00e9\u20ac\U0001F600"), "a\u00e9\u20ac\U0001F600"},
		"stray continuation":      {[]byte{'a', 0x80, 'b'}, "a\uFFFDb"},
		"two continuations":       {[]byte{0x80, 0x80}, "\uFFFD\uFFFD"},
		"truncated three byte":    {[]byte{0xE2, 0x82}, "\uFFFD"},
		"truncated then ascii":    {[]byte{0xE2, 0x82, 'x'}, "\uFFFDx"},
		"truncated four byte":     {[]byte{0xF0, 0x9F, 0x98}, "\uFFFD"},
		"overlong lead":           {[]byte{0xC0, 0x80}, "\uFFFD\uFFFD"},
		"overlong three byte":     {[]byte{0xE0, 0x80, 0x80}, "\uFFFD\uFFFD\uFFFD"},
		"surrogate encoded":       {[]byte{0xED, 0xA0, 0x80}, "\uFFFD\uFFFD\uFFFD"},
		"above max":               {[]byte{0xF4, 0x90, 0x80, 0x80}, "\uFFFD\uFFFD\uFFFD\uFFFD"},
		"invalid lead":            {[]byte{0xFF, 'a'}, "\uFFFDa"},
		"truncated then restart":  {[]byte{0xE2, 0x82, 0xE2, 0x82, 0xAC}, "\uFFFD\u20ac"},
		"lead then second wrong":  {[]byte{0xE1, 0x7F}, "\uFFFD\x7f"},
		"four byte second bad":    {[]byte{0xF0, 0x8F, 0xBF, 0xBF}, "\uFFFD\uFFFD\uFFFD\uFFFD"},
		"four byte third bad":     {[]byte{0xF1, 0x80, 0x7F}, "\uFFFD\x7f"},
		"empty":                   {nil, ""},
		"truncated at end of two": {[]byte{'z', 0xC3}, "z\uFFFD"},
	} {
		if got := UTF8(tc.in); got != tc.want {
			t.Errorf("%s: %q, want %q", name, got, tc.want)
		}
	}
}

func TestParseDate(t *testing.T) {
	utc := func(y int, m time.Month, d, h, mi, s, ms int) int64 {
		return time.Date(y, m, d, h, mi, s, ms*1_000_000, time.UTC).UnixMilli()
	}
	for text, want := range map[string]int64{
		"2026-05-01":                   utc(2026, 5, 1, 0, 0, 0, 0),
		"2026-05":                      utc(2026, 5, 1, 0, 0, 0, 0),
		"2026":                         utc(2026, 1, 1, 0, 0, 0, 0),
		"2026-05-01T10:00:00.000Z":     utc(2026, 5, 1, 10, 0, 0, 0),
		"2026-05-01T10:00:00z":         utc(2026, 5, 1, 10, 0, 0, 0),
		"2026-05-01T10:00:00.1234567Z": utc(2026, 5, 1, 10, 0, 0, 123),
		"2026-05-01T10:00:00+05:30":    utc(2026, 5, 1, 4, 30, 0, 0),
		"2026-05-01T24:00:00Z":         utc(2026, 5, 2, 0, 0, 0, 0),
		"+020000-01-01T00:00:00Z":      utc(20000, 1, 1, 0, 0, 0, 0),
	} {
		got, ok := ParseDate(text)
		if !ok || got.UnixMilli() != want {
			t.Errorf("%q = %v ok=%v, want %d", text, got.UnixMilli(), ok, want)
		}
	}
	for _, text := range []string{"", "yesterday", "2026-13-01", "2026-05-32", "2026-05-01T10:60", "2026-05-01T24:00:01Z", "May 1 2026"} {
		if _, ok := ParseDate(text); ok {
			t.Errorf("%q accepted", text)
		}
	}
}

func TestISOStringMatchesToISOString(t *testing.T) {
	for want, at := range map[string]time.Time{
		"2026-05-01T12:00:00.000Z":    time.Date(2026, 5, 1, 12, 0, 0, 0, time.UTC),
		"2026-05-01T12:00:00.123Z":    time.Date(2026, 5, 1, 12, 0, 0, 123_000_000, time.UTC),
		"0000-01-01T00:00:00.000Z":    time.Date(0, 1, 1, 0, 0, 0, 0, time.UTC),
		"9999-12-31T23:59:59.999Z":    time.Date(9999, 12, 31, 23, 59, 59, 999_000_000, time.UTC),
		"+010000-01-01T00:00:00.000Z": time.Date(10000, 1, 1, 0, 0, 0, 0, time.UTC),
		"+020000-06-07T08:09:10.011Z": time.Date(20000, 6, 7, 8, 9, 10, 11_000_000, time.UTC),
		"-000001-01-01T00:00:00.000Z": time.Date(-1, 1, 1, 0, 0, 0, 0, time.UTC),
	} {
		if got := ISOString(at); got != want {
			t.Errorf("%v = %s, want %s", at, got, want)
		}
	}
}
