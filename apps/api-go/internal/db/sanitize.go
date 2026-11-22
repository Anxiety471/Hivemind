package db

import (
	"context"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/wtf8"
)

// wireTx is the transaction every caller runs in. It reproduces what
// node-postgres does when it encodes a JavaScript string to UTF-8: an unpaired
// UTF-16 surrogate becomes U+FFFD on the wire, while NUL is rejected by
// PostgreSQL (22021). Prisma's sanitizeWriteArgs only rewrites write values;
// filters are left to this wire rule, which is why a NUL in a WHERE still makes
// PostgreSQL fail in TypeScript.
//
// A write value is already a Text value (see Data/Text) and is not touched
// again; every other string is a filter and gets the wire replacement.
type wireTx struct{ pgx.Tx }

func (tx wireTx) Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	return tx.Tx.Exec(ctx, sql, wireArgs(args)...)
}

func (tx wireTx) Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error) {
	return tx.Tx.Query(ctx, sql, wireArgs(args)...)
}

func (tx wireTx) QueryRow(ctx context.Context, sql string, args ...any) pgx.Row {
	return tx.Tx.QueryRow(ctx, sql, wireArgs(args)...)
}

// wireArgs applies the UTF-8 wire encoding to filter arguments. Text, JSON and
// JSONText output are already in their final form.
func wireArgs(args []any) []any {
	changed := false
	out := make([]any, len(args))
	for index, arg := range args {
		switch value := arg.(type) {
		case Text:
			out[index] = arg
		case string:
			safe := wtf8.ReplaceSurrogates(value)
			changed = changed || safe != value
			out[index] = safe
		case []string:
			safe := make([]string, len(value))
			for item, text := range value {
				safe[item] = wtf8.ReplaceSurrogates(text)
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
