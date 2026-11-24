package writeauditfixture

import (
	"context"

	"github.com/jackc/pgx/v5"
)

// Reviewer bypass 2: CopyFrom never maps $n arguments.
func copied(ctx context.Context, tx pgx.Tx) error {
	_, err := tx.CopyFrom(ctx, pgx.Identifier{"reviewer"}, []string{"payload"},
		pgx.CopyFromRows([][]any{{"raw"}}))
	return err
}
