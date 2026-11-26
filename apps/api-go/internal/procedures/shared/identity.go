package shared

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/orpc"
)

// IdentityConfirmationRequired is IDENTITY_CONFIRMATION_REQUIRED
// (packages/contracts/src/account/auth.ts:125): the answer clients retry after
// confirming who they are.
func IdentityConfirmationRequired() *orpc.Error {
	return orpc.New("IDENTITY_CONFIRMATION_REQUIRED", 403, "Confirm it's you")
}

// IdentityConfirmed is hasRecentIdentityConfirmation
// (packages/auth/src/identity-confirmation.ts:66-81): this session confirmed
// its identity within the window, by password/code or a fresh SSO sign-in. Both
// proofs are verification rows bound to the session and its user.
func IdentityConfirmed(ctx context.Context, database *db.DB, actor db.Actor) (bool, error) {
	if actor.SessionID == "" || actor.UserID == "" {
		return false, nil
	}
	confirmed := false
	// findVerificationValue (better-auth internal-adapter.mjs:789-804) reads the *newest* row for
	// the identifier — findMany sorted by createdAt descending, limit 1, and Postgres sorts
	// descending nulls first, so no NULLS clause — and then deletes every expired verification
	// row, for any identifier. hasRecentIdentityConfirmation looks up
	// `identity-confirmed:<session>` and `oidc-reauth:<session>` with Promise.all
	// (identity-confirmation.ts:55-67), so both newest rows are read before either cleanup runs.
	// Read both here first and clean once: deleting between the reads would let the first
	// identifier's cleanup hide the second identifier's newer expired row, which TypeScript never
	// does in its nominal interleaving.
	identifiers := []string{
		"identity-confirmed-" + actor.SessionID,
		"oidc-reauth-" + actor.SessionID,
	}
	type proof struct {
		value   string
		expires time.Time
	}
	err := database.System(ctx, "check a session's recent identity confirmation", func(tx pgx.Tx) error {
		now := time.Now().UTC()
		proofs := make([]proof, 0, len(identifiers))
		for _, identifier := range identifiers {
			var p proof
			err := tx.QueryRow(ctx,
				`SELECT value, "expiresAt" FROM verification
				 WHERE identifier = $1
				 ORDER BY "createdAt" DESC
				 LIMIT 1`,
				identifier).Scan(&p.value, &p.expires)
			if err != nil {
				if errors.Is(err, pgx.ErrNoRows) {
					continue
				}
				return err
			}
			proofs = append(proofs, p)
		}
		for _, p := range proofs {
			if p.value == actor.UserID && p.expires.After(now) {
				confirmed = true
			}
		}
		// "expiresAt" is a timestamp without zone and Prisma writes UTC wall clock, so the
		// instant becomes UTC wall clock before the comparison (a bare time.Time parameter
		// would be encoded in its own location).
		if _, cleanup := tx.Exec(ctx,
			`DELETE FROM verification WHERE "expiresAt" < ($1::timestamptz AT TIME ZONE 'UTC')`,
			now); cleanup != nil {
			return cleanup
		}
		return nil
	})
	return confirmed, err
}

// RequireIdentityConfirmation is requireIdentityConfirmation
// (apps/api/src/auth/identity-confirmation.ts:10-23).
func RequireIdentityConfirmation(ctx context.Context, database *db.DB, actor db.Actor) *orpc.Error {
	confirmed, err := IdentityConfirmed(ctx, database, actor)
	if err != nil {
		return Failure(err)
	}
	if confirmed {
		return nil
	}
	return IdentityConfirmationRequired()
}
