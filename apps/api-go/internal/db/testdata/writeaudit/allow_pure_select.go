package writeauditfixture

import (
	"context"

	"github.com/jackc/pgx/v5"
)

// A read of a known-pure function is not an exemption candidate.
func counted(ctx context.Context, tx pgx.Tx) error {
	var count int
	return tx.QueryRow(ctx, `SELECT count(*) FROM reviewer WHERE payload = $1`, "x").Scan(&count)
}
