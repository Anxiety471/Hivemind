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
	// row, for any identifier. Both statements run per identifier, in that order:
	// hasRecentIdentityConfirmation looks up `identity-confirmed:<session>` and
	// `oidc-reauth:<session>` independently. A newer expired row therefore hides an older valid
	// one, exactly as it does in TypeScript.
	identifiers := []string{
		"identity-confirmed-" + actor.SessionID,
		"oidc-reauth-" + actor.SessionID,
	}
	err := database.System(ctx, "check a session's recent identity confirmation", func(tx pgx.Tx) error {
		for _, identifier := range identifiers {
			var value string
			var expires time.Time
			err := tx.QueryRow(ctx,
				`SELECT value, "expiresAt" FROM verification
				 WHERE identifier = $1
				 ORDER BY "createdAt" DESC
				 LIMIT 1`,
				identifier).Scan(&value, &expires)
			if err != nil && !errors.Is(err, pgx.ErrNoRows) {
				return err
			}
			if err == nil && value == actor.UserID && expires.After(time.Now().UTC()) {
				confirmed = true
			}
			// "expiresAt" is a timestamp without zone and Prisma writes UTC wall clock, so the
			// instant becomes UTC wall clock before the comparison (a bare time.Time parameter
			// would be encoded in its own location).
			if _, cleanup := tx.Exec(ctx,
				`DELETE FROM verification WHERE "expiresAt" < ($1::timestamptz AT TIME ZONE 'UTC')`,
				time.Now()); cleanup != nil {
				return cleanup
			}
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
