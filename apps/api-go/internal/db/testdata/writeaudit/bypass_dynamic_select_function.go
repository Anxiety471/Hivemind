package writeauditfixture

import (
	"context"

	"github.com/jackc/pgx/v5"
)

// A function name spliced into a SELECT is unresolved, so the pure-function
// allowlist cannot be applied.
func dynamicFunction(ctx context.Context, tx pgx.Tx, function string) error {
	_, err := tx.Exec(ctx, "SELECT "+function+"($1)", 1)
	return err
}
