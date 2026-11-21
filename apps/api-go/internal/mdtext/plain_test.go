package mdtext

import (
	"encoding/base64"
	"encoding/json"
	"os"
	"strings"
	"testing"
)

// goldenRecord is one pinned case from tools/mdtext-diff.mts --golden. Strings
// travel as base64 of UTF-16LE so lone surrogates stay exact.
type goldenRecord struct {
	Input     string `json:"i"`
	Cap       int    `json:"c"`
	MaxChars  int    `json:"m"`
	Plain     string `json:"o"`
	Truncated string `json:"t"`
	Shortened int    `json:"s"`
	Boundary  int    `json:"b"`
}

func decodeUnits(t *testing.T, value string) []uint16 {
	t.Helper()
	raw, err := base64.StdEncoding.DecodeString(value)
	if err != nil {
		t.Fatalf("base64: %v", err)
	}
	if len(raw)%2 != 0 {
		t.Fatalf("odd UTF-16LE payload length %d", len(raw))
	}
	units := make([]uint16, len(raw)/2)
	for index := range units {
		units[index] = uint16(raw[2*index]) | uint16(raw[2*index+1])<<8
	}
	return units
}

func encodeUnits(units []uint16) string {
	raw := make([]byte, 2*len(units))
	for index, unit := range units {
		raw[2*index] = byte(unit)
		raw[2*index+1] = byte(unit >> 8)
	}
	return base64.StdEncoding.EncodeToString(raw)
}

func describeUnits(units []uint16) string {
	var out strings.Builder
	for _, unit := range units {
		switch {
		case unit == '\n':
			out.WriteString(`\n`)
		case unit == '\r':
			out.WriteString(`\r`)
		case unit == '\t':
			out.WriteString(`\t`)
		case unit >= 0x20 && unit < 0x7f:
			out.WriteByte(byte(unit))
		default:
			out.WriteString(`\u`)
			const hex = "0123456789abcdef"
			out.WriteByte(hex[unit>>12&0xf])
			out.WriteByte(hex[unit>>8&0xf])
			out.WriteByte(hex[unit>>4&0xf])
			out.WriteByte(hex[unit&0xf])
		}
	}
	return out.String()
}

// TestGolden pins PlainTextFromMarkdown and the truncation helpers to the
// TypeScript, over cases written by the differential harness.
func TestGolden(t *testing.T) {
	raw, err := os.ReadFile("testdata/golden.json")
	if err != nil {
		t.Fatalf("read golden: %v", err)
	}
	var records []goldenRecord
	if err := json.Unmarshal(raw, &records); err != nil {
		t.Fatalf("parse golden: %v", err)
	}
	if len(records) < 200 {
		t.Fatalf("golden fixture holds %d cases, want at least 200", len(records))
	}
	for index, record := range records {
		source := decodeUnits(t, record.Input)
		wantPlain := decodeUnits(t, record.Plain)
		gotPlain := PlainTextFromMarkdownUnits(source, record.Cap)
		if encodeUnits(gotPlain) != record.Plain {
			t.Errorf("case %d: plainText(%s, cap=%d)\n got: %s\nwant: %s",
				index, describeUnits(source), record.Cap, describeUnits(gotPlain), describeUnits(wantPlain))
			continue
		}
		if got := ShortenedTextLength(gotPlain); got != record.Shortened {
			t.Errorf("case %d: shortenedTextLength = %d, want %d", index, got, record.Shortened)
		}
		if got := TextBoundary(gotPlain, record.MaxChars); got != record.Boundary {
			t.Errorf("case %d: textBoundary(%d) = %d, want %d", index, record.MaxChars, got, record.Boundary)
		}
		if record.Truncated != "" {
			if got := TruncatedPlainTextUnits(source, record.MaxChars); encodeUnits(got) != record.Truncated {
				t.Errorf("case %d: truncatedPlainText(%s, %d)\n got: %s\nwant: %s",
					index, describeUnits(source), record.MaxChars, describeUnits(got),
					describeUnits(decodeUnits(t, record.Truncated)))
			}
		}
	}
}

func TestStringAndUnits(t *testing.T) {
	if got := Units("a👍b"); len(got) != 4 || got[1] != 0xD83D || got[2] != 0xDC4D {
		t.Fatalf("Units = %v", got)
	}
	// A lone surrogate has no UTF-8 form and reads as U+FFFD, as a Go string always holds.
	if got := String([]uint16{'a', 0xD800, 'b', 0xDC00}); got != "a\uFFFDb\uFFFD" {
		t.Fatalf("String = %q", got)
	}
	// Every other unit round-trips exactly.
	text := "héllo 中文 🧑🏽\u0301"
	if got := String(Units(text)); got != text {
		t.Fatalf("round trip = %q, want %q", got, text)
	}
}

func TestPlainTextFromMarkdown(t *testing.T) {
	cases := []struct{ markdown, want string }{
		{"# Hello **world**\n\n- a\n- b", "Hello world a b"},
		{"| a | b |\n|---|---|\n| 1 | 2 |", "a, b 1, 2"},
		{"snake_case_name and _emphasis_", "snake_case_name and emphasis"},
		{"`a * b` and **bold**", "a * b and bold"},
		{"[label](https://example.com/x) ![alt](y)", "label alt"},
		{"<https://example.com/x> and <a@b.co>", "https://example.com/x and a@b.co"},
		{"<div class=\"x\">text</div>", "text"},
		{"a<br/>b <!-- c -->d", "a b d"},
		{"```js\nlet x = 1;\n```", "let x = 1;"},
		{"~~~\n# not a heading\n~~~", "# not a heading"},
		{"---\n***\n___", ""},
		{"\r\n\r\n  padded\r\n", "padded"},
		{"escaped \\*star\\* here", "escaped *star* here"},
		{"&amp; &lt; stay", "&amp; &lt; stay"},
		{"**a** *b* ~~c~~", "a b c"},
	}
	for _, item := range cases {
		if got := PlainTextFromMarkdown(item.markdown); got != item.want {
			t.Errorf("plainTextFromMarkdown(%q) = %q, want %q", item.markdown, got, item.want)
		}
	}
}

func TestTruncatePlainText(t *testing.T) {
	// A cut inside a surrogate pair backs up one unit, as textBoundary does.
	if got := TruncatePlainText("a👍b", 2); got != "a" {
		t.Fatalf("TruncatePlainText = %q", got)
	}
	if got := TruncatePlainText("abcdef", 3); got != "abc" {
		t.Fatalf("TruncatePlainText = %q", got)
	}
	if got := ShortenedTextLength(Units("👍x")); got != 2 {
		t.Fatalf("ShortenedTextLength = %d", got)
	}
	if got := ShortenedTextLength(Units("a")); got != 0 {
		t.Fatalf("ShortenedTextLength = %d", got)
	}
}

func TestPreviewCap(t *testing.T) {
	// Leading whitespace does not spend the window.
	markdown := strings.Repeat(" ", 5000) + "body"
	if got := PlainTextFromMarkdown(markdown); got != "body" {
		t.Fatalf("padded preview = %q", got)
	}
	// Past the cap, a fence that lost its closer keeps its body verbatim.
	body := strings.Repeat("x ", 3000)
	if got := PlainTextFromMarkdownCapped("```\n"+body, 100); !strings.HasPrefix(got, "x x x") {
		t.Fatalf("truncated fence preview = %q", got)
	}
}
