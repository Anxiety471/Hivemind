package bots

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/effects"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/orpc"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/shared"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/secretstore"
)

const webhookSecretKind = "webhook"

// webhookPath is the path bots.rotateWebhookSecret returns (routes/bots.ts:684).
func webhookPath(botID string) string { return "/api/v1/bots/" + botID + "/webhook" }

// requireCreator is the creator check both webhook routes make: webhook runs act as the bot's
// creator, so only they can issue or read its secret (routes/bots.ts:668-670,694-695).
func requireCreator(actor db.Actor, creator string) *orpc.Error {
	if creator != actor.UserID {
		return orpc.Forbidden("Forbidden")
	}
	return nil
}

// RotateWebhookSecret implements bots.rotateWebhookSecret (routes/bots.ts:666-686): a fresh
// 32-byte secret is sealed, the bot row is repointed under its lock, and the previous secret
// row is deleted in the same transaction.
func RotateWebhookSecret(
	ctx context.Context,
	database *db.DB,
	deployment shared.Deployment,
	actor db.Actor,
	raw orpc.Input,
) (any, *orpc.Error) {
	botID, failure := parseBotID(raw)
	if failure != nil {
		return nil, failure
	}
	vault, err := shared.VaultDeps(deployment.Vault)
	if err != nil {
		return nil, shared.Failure(err)
	}
	var creator string
	err = database.Tenant(ctx, actor, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT "userId" FROM bots WHERE id = $1 AND "spaceId" = $2 AND "archivedAt" IS NULL`,
			botID, actor.SpaceID).Scan(&creator)
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, shared.NotFound
	}
	if err != nil {
		return nil, shared.Failure(err)
	}
	if failure := requireCreator(actor, creator); failure != nil {
		return nil, failure
	}
	plaintext, saved, err := storeBotWebhookKey(ctx, database, vault, actor, botID, true)
	if err != nil {
		return nil, shared.Failure(err)
	}
	if !saved {
		return nil, orpc.NotFound("Not Found")
	}
	return map[string]any{
		"secret":            plaintext,
		"path":              webhookPath(botID),
		"webhookConfigured": true,
	}, nil
}

// RevealWebhookSecret implements bots.revealWebhookSecret (routes/bots.ts:688-730): creator
// only, a recent identity confirmation, the sealed value opened, and a re-check that the bot
// still holds that secret so a rotation that committed during the decrypt cannot hand back a
// revoked key. The reveal is recorded as a security event before the reply.
func RevealWebhookSecret(
	ctx context.Context,
	database *db.DB,
	deployment shared.Deployment,
	actor db.Actor,
	raw orpc.Input,
) (any, *orpc.Error) {
	botID, failure := parseBotID(raw)
	if failure != nil {
		return nil, failure
	}
	vault, err := shared.VaultDeps(deployment.Vault)
	if err != nil {
		return nil, shared.Failure(err)
	}
	var creator, secretID string
	err = database.Tenant(ctx, actor, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT "userId", coalesce("webhookSecretId", '') FROM bots
			WHERE id = $1 AND "spaceId" = $2 AND "archivedAt" IS NULL`,
			botID, actor.SpaceID).Scan(&creator, &secretID)
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, shared.NotFound
	}
	if err != nil {
		return nil, shared.Failure(err)
	}
	if failure := requireCreator(actor, creator); failure != nil {
		return nil, failure
	}
	if failure := shared.RequireIdentityConfirmation(ctx, database, actor); failure != nil {
		return nil, failure
	}
	storedID, ciphertext := "", ""
	if secretID != "" {
		err = database.Tenant(ctx, actor, func(tx pgx.Tx) error {
			return tx.QueryRow(ctx, `SELECT id, ciphertext FROM secrets
				WHERE id = $1 AND "userId" = $2 AND "spaceId" = $3 AND kind = $4`,
				secretID, actor.UserID, actor.SpaceID, webhookSecretKind).Scan(&storedID, &ciphertext)
		})
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, orpc.NotFound("Webhook key not found")
		}
		if err != nil {
			return nil, shared.Failure(err)
		}
	} else {
		return nil, orpc.NotFound("Webhook key not found")
	}
	secret, err := vault.Writer.Load(ctx, ciphertext, storedID)
	if err != nil {
		return nil, shared.Failure(err)
	}
	var current string
	err = database.Tenant(ctx, actor, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT coalesce("webhookSecretId", '') FROM bots WHERE id = $1`, botID).Scan(&current)
	})
	if errors.Is(err, pgx.ErrNoRows) {
		// The bot was deleted or moved while the value decrypted: a rotation or removal did commit.
		return nil, orpc.Conflict("The webhook key just changed")
	}
	if err != nil {
		return nil, shared.Failure(err)
	}
	if current != storedID {
		return nil, orpc.Conflict("The webhook key just changed")
	}
	if deployment.Audit != nil {
		if err := deployment.Audit.Record(ctx, effects.SecurityEvent{
			Type: "credential.revealed", UserID: actor.UserID, SpaceID: actor.SpaceID,
			Metadata: []effects.Meta{
				{Key: "procedure", Value: "bots.revealWebhookSecret"},
				{Key: "kind", Value: "webhook"},
				{Key: "botId", Value: botID},
			},
		}); err != nil {
			return nil, shared.Failure(err)
		}
	}
	return map[string]any{"secret": secret}, nil
}

// storeBotWebhookKey is storeBotWebhookKey (routine-triggers.ts:202-246): the sealed secret is
// written first, then the bot is repointed under FOR UPDATE and the previous row deleted. The
// write is tracked before the INSERT and the previous ref captured before the DELETE, so the
// hook cleans either side of a failed transaction.
func storeBotWebhookKey(
	ctx context.Context,
	database *db.DB,
	vault *shared.SecretVault,
	actor db.Actor,
	botID string,
	replace bool,
) (string, bool, error) {
	if !replace {
		var held string
		err := database.Tenant(ctx, actor, func(tx pgx.Tx) error {
			return tx.QueryRow(ctx, `SELECT coalesce("webhookSecretId", '') FROM bots WHERE id = $1`, botID).Scan(&held)
		})
		if err != nil {
			return "", false, err
		}
		if held != "" {
			return "", false, nil
		}
	}
	var raw [32]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", false, err
	}
	plaintext := base64.RawURLEncoding.EncodeToString(raw[:])
	record, err := vault.Writer.Put(ctx, plaintext, secretstore.PutOptions{})
	if err != nil {
		return "", false, err
	}
	state := vault.Persistence.NewState()
	saved := false
	err = database.Tenant(ctx, actor, func(tx pgx.Tx) error {
		var previous string
		err := tx.QueryRow(ctx, `SELECT coalesce("webhookSecretId", '') FROM bots WHERE id = $1 FOR UPDATE`, botID).Scan(&previous)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		if err != nil {
			return err
		}
		if previous != "" && !replace {
			return nil
		}
		vault.Persistence.TrackWrite(state, secretstore.Secret, record.ID, record.Ciphertext)
		if _, err := tx.Exec(ctx, `INSERT INTO secrets (id, "userId", "spaceId", kind, ciphertext)
			VALUES ($1, $2, $3, $4, $5)`,
			record.ID, actor.UserID, actor.SpaceID, webhookSecretKind, record.Ciphertext); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `UPDATE bots SET "webhookSecretId" = $2, "updatedAt" = $3 WHERE id = $1`,
			botID, record.ID, time.Now().UTC().Truncate(time.Millisecond)); err != nil {
			return err
		}
		if previous != "" {
			if err := vault.Persistence.CaptureDropped(ctx, tx, state, secretstore.Secret,
				`SELECT id FROM secrets WHERE id = $1 AND "spaceId" = $2 AND "userId" = $3 AND kind = $4`,
				previous, actor.SpaceID, actor.UserID, webhookSecretKind); err != nil {
				return err
			}
			if _, err := tx.Exec(ctx, `DELETE FROM secrets
				WHERE id = $1 AND "spaceId" = $2 AND "userId" = $3 AND kind = $4`,
				previous, actor.SpaceID, actor.UserID, webhookSecretKind); err != nil {
				return err
			}
		}
		saved = true
		return nil
	})
	vault.Persistence.Finish(ctx, state, err)
	if err != nil || !saved {
		return "", false, err
	}
	return plaintext, true, nil
}
