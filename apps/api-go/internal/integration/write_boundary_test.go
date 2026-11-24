package integration

import (
	"context"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
)

// TestWriteBoundaryMatchesPrisma proves the database boundary: a Text write
// value stores U+FFFD for NUL and unpaired surrogates, a JSON write sanitizes
// every leaf and key, bytea passes through, and a NUL in a filter reaches
// PostgreSQL unchanged (error 22021), as Prisma leaves WHERE alone.
func TestWriteBoundaryMatchesPrisma(t *testing.T) {
	database := openTestDB(t)
	ctx := context.Background()
	err := database.System(ctx, "write boundary test", func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `CREATE TEMP TABLE wire_boundary (
			id text primary key,
			plain text not null,
			payload jsonb not null,
			blob bytea not null
		)`); err != nil {
			return err
		}
		surrogate := "a" + string([]byte{0xED, 0xA0, 0x80}) + "b"
		blob := []byte{0x00, 0xED, 0xA0, 0x80, 0xFF}
		if _, err := tx.Exec(ctx,
			`INSERT INTO wire_boundary (id, plain, payload, blob) VALUES ($1, $2, $3, $4)`,
			db.Data("row-1", "nul\x00and "+surrogate, db.JSON(map[string]any{
				"name":     "nul\x00and " + surrogate,
				"a\x00b":   map[string]any{"nested": surrogate},
				"a\uFFFDb": "collision",
			}), blob)...); err != nil {
			return err
		}
		var plain string
		var payload string
		var stored []byte
		if err := tx.QueryRow(ctx, `SELECT plain, payload::text, blob FROM wire_boundary WHERE id = $1`, "row-1").
			Scan(&plain, &payload, &stored); err != nil {
			return err
		}
		if plain != "nul\uFFFDand a\uFFFDb" {
			t.Errorf("text = %q", plain)
		}
		for _, want := range []string{"nul\uFFFDand a\uFFFDb", "\"a\uFFFDb\":", "\"a\uFFFDb#2\":", "\"nested\": \"a\uFFFDb\""} {
			if !strings.Contains(payload, want) {
				t.Errorf("json %s missing %q", payload, want)
			}
		}
		if string(stored) != string(blob) {
			t.Errorf("bytea = %x", stored)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	// A filter is not a write value: PostgreSQL rejects the NUL instead of
	// receiving U+FFFD, which is what the TypeScript gateway surfaces. A failed
	// statement aborts its transaction, so this runs on its own.
	filterErr := database.System(ctx, "write boundary filter", func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `UPDATE wire_boundary SET plain = $1 WHERE id = $2`, db.Data("changed")[0], "wrong\x00id")
		if err == nil {
			t.Fatal("NUL in WHERE did not fail")
		}
		return err
	})
	if filterErr == nil || (!strings.Contains(filterErr.Error(), "22021") && !strings.Contains(filterErr.Error(), "invalid byte sequence")) {
		t.Errorf("unexpected WHERE error: %v", filterErr)
	}
}
