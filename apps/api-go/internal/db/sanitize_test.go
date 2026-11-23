package db

import (
	"testing"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/wtf8"
)

func TestWireArgsReplacesSurrogatesAndKeepsNUL(t *testing.T) {
	surrogate := "a" + string([]byte{0xED, 0xA0, 0x80}) + "b"
	args := wireArgs([]any{surrogate, "a\x00b", []string{surrogate}})
	if got := args[0].(string); got != "a\uFFFDb" {
		t.Fatalf("surrogate = %q", got)
	}
	if got := args[1].(string); got != "a\x00b" {
		t.Fatalf("NUL was rewritten: %q", got)
	}
	if got := args[2].([]string)[0]; got != "a\uFFFDb" {
		t.Fatalf("[]string surrogate = %q", got)
	}
}

func TestWireArgsLeavesTextAlone(t *testing.T) {
	text := Text("a\x00" + string([]byte{0xED, 0xA0, 0x80}))
	args := wireArgs([]any{text})
	if args[0] != text {
		t.Fatalf("Text was rewritten: %#v", args[0])
	}
	value, err := text.Value()
	if err != nil {
		t.Fatal(err)
	}
	if value != "a\uFFFD\uFFFD" {
		t.Fatalf("Text.Value = %q", value)
	}
}

func TestDataSanitizesStringsAndPassesTheRest(t *testing.T) {
	ciphertext := []byte{0x00, 0xED, 0xA0, 0x80}
	args := Data("a\x00b", 7, ciphertext, nil)
	if args[0] != Text("a\x00b") {
		t.Fatalf("string was not wrapped: %#v", args[0])
	}
	if args[1] != 7 {
		t.Fatalf("number changed: %#v", args[1])
	}
	if got := args[2].([]byte); string(got) != string(ciphertext) {
		t.Fatalf("bytea changed: %x", got)
	}
	if args[3] != nil {
		t.Fatalf("nil changed: %#v", args[3])
	}
}

func TestReplaceSurrogatesMatchesTheWireRule(t *testing.T) {
	input := "x" + string([]byte{0xED, 0xB0, 0x80}) + "y"
	if got := wtf8.ReplaceSurrogates(input); got != "x\uFFFDy" {
		t.Fatalf("ReplaceSurrogates = %q", got)
	}
}

func TestDataSanitizesStringArrays(t *testing.T) {
	surrogate := "a" + string([]byte{0xED, 0xA0, 0x80}) + "b"
	args := Data([]string{"nul\x00", surrogate}, []any{"x\x00", 3})
	first := args[0].([]string)
	if first[0] != "nul\uFFFD" || first[1] != "a\uFFFDb" {
		t.Fatalf("[]string = %q", first)
	}
	second := args[1].([]any)
	if second[0] != Text("x\x00") || second[1] != 3 {
		t.Fatalf("[]any = %#v", second)
	}
}

func TestDataSanitizesNullableStrings(t *testing.T) {
	text := "a\x00b"
	surrogate := "c" + string([]byte{0xED, 0xB0, 0x80}) + "d"
	args := Data(&text, (*string)(nil), &surrogate)
	if args[0] != Text(text) || args[1] != nil || args[2] != Text(surrogate) {
		t.Fatalf("nullable strings = %#v", args)
	}
}

func TestWireArgsReplacesSurrogatesInNullableFilters(t *testing.T) {
	surrogate := "a" + string([]byte{0xED, 0xA0, 0x80}) + "b"
	value := &surrogate
	args := wireArgs([]any{value, (*string)(nil)})
	if got := args[0].(*string); *got != "a\uFFFDb" {
		t.Fatalf("pointer = %q", *got)
	}
	if args[1] != (*string)(nil) {
		t.Fatalf("nil pointer = %#v", args[1])
	}
}
