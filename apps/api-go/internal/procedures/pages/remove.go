package pages

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/orpc"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/shared"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/secretstore"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/validate"
)

// Remove implements pages.remove (apps/api/src/content/pages.ts:347-364): the page and its
// link's secret row are deleted in one transaction, then the sealed token is deleted from the
// store best effort, as forgetPageShareSecrets does.
func Remove(
	ctx context.Context,
	database *db.DB,
	deployment shared.Deployment,
	actor db.Actor,
	raw orpc.Input,
) (any, *orpc.Error) {
	pageID, failure := parseRemove(raw)
	if failure != nil {
		return nil, failure
	}
	vault, err := shared.VaultDeps(deployment.Vault)
	if err != nil {
		return nil, shared.Failure(err)
	}
	var shareSecretID string
	err = database.Tenant(ctx, actor, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT coalesce("shareSecretId", '') FROM pages
			WHERE id = $1 AND "spaceId" = $2 AND "userId" = $3`,
			pageID, actor.SpaceID, actor.UserID).Scan(&shareSecretID)
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, shared.NotFound
	}
	if err != nil {
		return nil, shared.Failure(err)
	}
	state := vault.Persistence.NewState()
	removedID, removedCiphertext := "", ""
	err = database.Tenant(ctx, actor, func(tx pgx.Tx) error {
		var deleted string
		err := tx.QueryRow(ctx, `DELETE FROM pages WHERE id = $1 RETURNING coalesce("shareSecretId", '')`,
			pageID).Scan(&deleted)
		if errors.Is(err, pgx.ErrNoRows) {
			return shared.NotFound
		}
		if err != nil {
			return err
		}
		if deleted == "" {
			return nil
		}
		if err := tx.QueryRow(ctx, `SELECT id, ciphertext FROM secrets WHERE id = $1`, deleted).
			Scan(&removedID, &removedCiphertext); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				removedID = ""
				return nil
			}
			return err
		}
		if err := vault.Persistence.CaptureDropped(ctx, tx, state, secretstore.Secret,
			`SELECT id FROM secrets WHERE id = $1`, deleted); err != nil {
			return err
		}
		_, err = tx.Exec(ctx, `DELETE FROM secrets WHERE id = $1`, deleted)
		return err
	})
	vault.Persistence.Finish(ctx, state, err)
	if err != nil {
		return nil, shared.Failure(err)
	}
	if removedID != "" {
		// forgetPageShareSecrets (page-share-secrets.ts:9-24): the row's delete already
		// announced the dropped ref; this is the explicit store delete that a remote store
		// needs, so the local store announces it a second time, as TypeScript does.
		vault.Writer.Delete(ctx, removedCiphertext, removedID)
	}
	return map[string]any{"ok": true}, nil
}

func parseRemove(raw orpc.Input) (string, *orpc.Error) {
	object, issues := validate.Decode(raw.Raw, nil)
	if issues != nil {
		return "", validate.Fail(issues)
	}
	pageID, problems := validate.String(validate.Path{"pageId"}, object.Field("pageId"),
		validate.StringRules{Min: 1})
	problems = append(problems, object.Unrecognized(nil, "pageId")...)
	if problems != nil {
		return "", validate.Fail(problems)
	}
	return pageID, nil
}
