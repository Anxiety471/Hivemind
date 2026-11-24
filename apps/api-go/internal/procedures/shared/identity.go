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
	now := time.Now()
	// findVerificationValue reads one row per identifier (findFirst with no order, as the
	// identifier has only an index): a second row for the same key is not a second proof.
	identifiers := []string{
		"identity-confirmed-" + actor.SessionID,
		"oidc-reauth-" + actor.SessionID,
	}
	err := database.System(ctx, "check a session's recent identity confirmation", func(tx pgx.Tx) error {
		for _, identifier := range identifiers {
			var value string
			var expires time.Time
			err := tx.QueryRow(ctx,
				`SELECT value, "expiresAt" FROM verification WHERE identifier = $1 LIMIT 1`,
				identifier).Scan(&value, &expires)
			if errors.Is(err, pgx.ErrNoRows) {
				continue
			}
			if err != nil {
				return err
			}
			if value == actor.UserID && expires.After(now) {
				confirmed = true
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
