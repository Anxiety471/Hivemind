package models

import (
	"context"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/orpc"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/shared"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/validate"
)

// MAX_MODEL_CONNECTION_LABEL (packages/contracts/src/model-connections.ts:193).
const connectionLabelMax = 80

// parseRename mirrors z.object({ credentialId: Id, label: z.string().trim().min(1).max(80) }).
func parseRename(raw orpc.Input) (id, label string, failure *orpc.Error) {
	object, issues := validate.Decode(raw.Raw, nil)
	if issues != nil {
		return "", "", validate.Fail(issues)
	}
	var found []validate.Issue
	id, problems := validate.String(validate.Path{"credentialId"}, object.Field("credentialId"), validate.StringRules{Min: 1})
	found = append(found, problems...)
	label, problems = validate.String(validate.Path{"label"}, object.Field("label"), validate.StringRules{Trim: true, Min: 1, Max: connectionLabelMax})
	found = append(found, problems...)
	if found != nil {
		return "", "", validate.Fail(found)
	}
	return id, label, nil
}

// Rename implements models.rename: the label of one of the member's own model connections.
// A connection belongs to the account, so any Space can rename it. Only the label and the
// change time are written: the sealed key (secretId) is never read, and none of the hooks on
// the API's Prisma client acts on a user_model_credentials write (secret persistence covers
// secrets, bot_secrets, vault_credentials and integration_provider_configs). The label is
// stored as the sanitizing client stores text: NUL becomes U+FFFD.
func Rename(ctx context.Context, database *db.DB, actor db.Actor, raw orpc.Input) (any, *orpc.Error) {
	id, label, failure := parseRename(raw)
	if failure != nil {
		return nil, failure
	}
	err := database.Tenant(ctx, actor, func(tx pgx.Tx) error {
		tag, err := tx.Exec(ctx, `UPDATE user_model_credentials SET label = $1, "updatedAt" = $2 WHERE id = $3 AND "userId" = $4`,
			append(db.Data(strings.ReplaceAll(label, "\x00", "\uFFFD"), time.Now().UTC().Truncate(time.Millisecond)), id, actor.UserID)...)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return orpc.NotFound("Connection not found")
		}
		return nil
	})
	if err != nil {
		return nil, shared.Failure(err)
	}
	return map[string]any{"ok": true}, nil
}
