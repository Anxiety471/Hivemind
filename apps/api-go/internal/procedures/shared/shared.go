// Package shared holds what the ported procedures have in common.
package shared

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/orpc"
)

// ISOMillis is Date.prototype.toISOString for a UTC instant.
const ISOMillis = "2006-01-02T15:04:05.000Z"

// ISO formats a database timestamp as toISOString does.
func ISO(at time.Time) string { return at.UTC().Format(ISOMillis) }

// NotFound is the IsolationError the API answers for a row outside the caller's Space.
var NotFound = orpc.NotFound("Resource not found")

// Failure turns an error out of a database call into the response the API gives:
// a failure raised on purpose as is, an unreachable database as 503, anything else 500.
func Failure(err error) *orpc.Error {
	var failure *orpc.Error
	if errors.As(err, &failure) {
		return failure
	}
	if db.IsUnavailable(err) {
		return orpc.Unavailable()
	}
	return orpc.Internal()
}

// OutputInvalid is the failure the router answers when a procedure's result breaks its
// contract schema (a stored value outside an enum, say): a 500 with its own message.
func OutputInvalid() *orpc.Error {
	return orpc.New("INTERNAL_SERVER_ERROR", 500, "Output validation failed")
}

// Deployment is the process configuration some procedures read: where links to the web
// app point, and whether the server sends email (which decides whether an invitee must
// have verified theirs before accepting).
type Deployment struct {
	WebOrigin     string
	EmailDelivery bool
}

// RequireBot is repos.getBot (packages/db/src/repos.ts:415): a bot of the actor's Space that
// is not archived, or the isolation error. TypeScript reads the whole bot, thread and computer
// rows to answer; the thread's encrypted compaction summary is decrypted on the way and the
// value discarded, so the only observable difference is when that ciphertext is unreadable
// (hook-audit.md R1).
func RequireBot(ctx context.Context, tx pgx.Tx, actor db.Actor, botID string) error {
	var found string
	err := tx.QueryRow(ctx, `SELECT id FROM bots WHERE id = $1 AND "spaceId" = $2 AND "archivedAt" IS NULL`, botID, actor.SpaceID).Scan(&found)
	if errors.Is(err, pgx.ErrNoRows) {
		return NotFound
	}
	return err
}
