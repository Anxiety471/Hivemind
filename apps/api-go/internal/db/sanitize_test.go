package db

import (
	"testing"
)

func TestSanitizeArgsAppliesThePrismaWriteRule(t *testing.T) {
	surrogate := "\xed\xa0\x80"
	args := []any{"a" + surrogate + "b", "plain", "n\x00ul", []string{"x" + surrogate, "y"}, 7}
	safe := sanitizeArgs("UPDATE pages SET title = $1", args)
	if safe[0] != "a\uFFFDb" {
		t.Errorf("string = %q", safe[0])
	}
	if safe[1] != "plain" || safe[4] != 7 {
		t.Errorf("unchanged args = %#v", safe)
	}
	if safe[2] != "n\uFFFDul" {
		t.Errorf("NUL string = %q", safe[2])
	}
	list, ok := safe[3].([]string)
	if !ok || len(list) != 2 || list[0] != "x\uFFFD" || list[1] != "y" {
		t.Errorf("[]string = %#v", safe[3])
	}
}

func TestSanitizeArgsKeepsTheOriginalSliceWhenNothingChanges(t *testing.T) {
	args := []any{"plain", 1}
	safe := sanitizeArgs("UPDATE pages SET title = $1", args)
	if &safe[0] != &args[0] {
		t.Fatal("an argument list with nothing to sanitize was copied")
	}
}

func TestSanitizeArgsReadsReplaceSurrogatesButKeepNUL(t *testing.T) {
	surrogate := "\xed\xa0\x80"
	args := []any{"a" + surrogate + "b", "n\x00ul"}
	safe := sanitizeArgs("SELECT title FROM pages WHERE title = $1", args)
	if safe[0] != "a\uFFFDb" {
		t.Errorf("read surrogate = %q", safe[0])
	}
	if safe[1] != "n\x00ul" {
		t.Errorf("read NUL = %q, want it kept for PostgreSQL to reject", safe[1])
	}
	write := sanitizeArgs("UPDATE pages SET title = $1", args)
	if write[1] != "n\uFFFDul" {
		t.Errorf("write NUL = %q", write[1])
	}
}
