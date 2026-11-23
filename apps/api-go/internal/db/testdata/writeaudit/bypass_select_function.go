package writeauditfixture

import (
	"context"

	"github.com/jackc/pgx/v5"
)

// Reviewer bypass 5: a SELECT that calls a data-modifying function.
func enqueued(ctx context.Context, tx pgx.Tx) error {
	_, err := tx.Exec(ctx, `select graphile_worker.add_job($1::text, $2::json)`, "task", "{}")
	return err
}
