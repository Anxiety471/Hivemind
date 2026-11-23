package writeauditfixture

import (
	"context"

	"github.com/jackc/pgx/v5"
)

// Reviewer bypass 4: a method value hides the selector from the call audit.
func aliased(ctx context.Context, tx pgx.Tx) error {
	exec := tx.Exec
	_, err := exec(ctx, `INSERT INTO reviewer (payload) VALUES ($1)`, "raw")
	return err
}
