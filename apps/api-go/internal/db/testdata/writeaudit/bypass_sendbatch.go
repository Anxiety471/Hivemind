package writeauditfixture

import (
	"context"

	"github.com/jackc/pgx/v5"
)

// Reviewer bypass 3: batch.Queue carries the SQL and SendBatch sends it.
func batched(ctx context.Context, tx pgx.Tx) error {
	batch := &pgx.Batch{}
	batch.Queue(`INSERT INTO reviewer (payload) VALUES ($1)`, "raw")
	return tx.SendBatch(ctx, batch).Close()
}
