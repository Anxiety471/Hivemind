package writeauditfixture

import (
	"context"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
)

type executant interface {
	Exec(context.Context, string, ...any) (int64, error)
}

// Reviewer bypass 1: the slice was wrapped, then index-assigned before the call.
func mutated(tx executant) {
	args := []any{db.Data("safe")}
	args[0] = "raw"
	tx.Exec(context.Background(), `INSERT INTO reviewer (payload) VALUES ($1)`, args...)
}
