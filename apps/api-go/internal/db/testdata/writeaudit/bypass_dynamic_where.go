package writeauditfixture

import (
	"context"

	"github.com/jackc/pgx/v5"
)

// A predicate spliced after WHERE is unresolved even though no value is bound.
func dynamicPredicate(ctx context.Context, tx pgx.Tx, predicate string) error {
	rows, err := tx.Query(ctx, "SELECT id FROM reviewer WHERE "+predicate)
	if err != nil {
		return err
	}
	rows.Close()
	return nil
}
