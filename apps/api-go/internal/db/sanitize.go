package db

import (
	"context"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/wtf8"
)

// sanitizingTx is the transaction every caller runs in: a string parameter is
// written the way Prisma's text sanitization writes it (sanitizeWriteArgs in
// packages/db/src/database/text-sanitization.ts), so a JavaScript string with
// an unpaired surrogate reaches Postgres as U+FFFD, not as the WTF-8 bytes the
// JSON boundary keeps in memory.
type sanitizingTx struct{ pgx.Tx }

func (tx sanitizingTx) Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	return tx.Tx.Exec(ctx, sql, sanitizeArgs(sql, args)...)
}

func (tx sanitizingTx) Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error) {
	return tx.Tx.Query(ctx, sql, sanitizeArgs(sql, args)...)
}

func (tx sanitizingTx) QueryRow(ctx context.Context, sql string, args ...any) pgx.Row {
	return tx.Tx.QueryRow(ctx, sql, sanitizeArgs(sql, args)...)
}

// writeStatement reports whether sql is one of the statements Prisma sanitizes:
// a create, update or delete. A SELECT keeps NUL (PostgreSQL rejects it, which
// is what the TypeScript client sees too) but replaces unpaired surrogates,
// which Node's UTF-8 encoder writes as U+FFFD on the wire.
func writeStatement(sql string) bool {
	keyword := strings.ToUpper(strings.TrimLeft(sql, " \t\r\n("))
	for _, write := range []string{"INSERT", "UPDATE", "DELETE"} {
		if strings.HasPrefix(keyword, write) {
			return true
		}
	}
	return false
}

// sanitizeArgs applies the write rule to every string parameter. Filters see
// the same replacement: the TypeScript driver encodes a lone surrogate as
// U+FFFD on the wire too, so a lookup behaves identically.
func sanitizeArgs(sql string, args []any) []any {
	clean := wtf8.ReplaceSurrogates
	if writeStatement(sql) {
		clean = wtf8.SanitizeText
	}
	changed := false
	out := make([]any, len(args))
	for index, arg := range args {
		switch value := arg.(type) {
		case string:
			safe := clean(value)
			changed = changed || safe != value
			out[index] = safe
		case []string:
			safe := make([]string, len(value))
			for item, text := range value {
				safe[item] = clean(text)
				changed = changed || safe[item] != text
			}
			out[index] = safe
		default:
			out[index] = arg
		}
	}
	if !changed {
		return args
	}
	return out
}
