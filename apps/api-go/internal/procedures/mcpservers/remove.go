package mcpservers

// mcp.servers.remove (apps/api/src/routes/mcp.ts:385-398): deleting a server closes every
// approval card that names it (including cards that were never assigned), deletes the row with
// its assignments and OAuth sessions (both cascade in the schema), and deletes the encrypted
// credential with it. The secret deletion passes through the secret-persistence hook, which
// captures the reference before the row goes and announces its cleanup after the commit.

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/effects"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/events"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/local"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/orpc"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/mcpassignments"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/shared"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/secretstore"
)

// Remove implements mcp.servers.remove.
func Remove(
	ctx context.Context,
	database *db.DB,
	deployment shared.Deployment,
	actor db.Actor,
	raw orpc.Input,
) (any, *orpc.Error) {
	values, failure := shared.IDFields(raw, "id")
	if failure != nil {
		return nil, failure
	}
	// The security event carries this id; a value the TypeScript redactor could rewrite goes
	// to TypeScript (gateway decline) instead of being recorded differently or dropped.
	if !effects.AuditedMetadataServable(values["id"]) {
		return nil, local.ErrDecline
	}
	vault, err := shared.VaultDeps(deployment.Vault)
	if err != nil {
		return nil, shared.Failure(err)
	}
	ring := deployment.Content
	if ring == nil {
		return nil, shared.Failure(errors.New("encryption is not configured"))
	}
	var serverID, secretID string
	err = database.Tenant(ctx, actor, func(tx pgx.Tx) error {
		//writeaudit:dynamic read: the predicate is the fixed serverAvailable const; the ids are filters
		return tx.QueryRow(ctx, `SELECT id, coalesce("secretId", '') FROM mcp_servers
			WHERE id = $3 AND `+serverAvailable, actor.SpaceID, actor.UserID, values["id"]).
			Scan(&serverID, &secretID)
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, shared.NotFound
	}
	if err != nil {
		return nil, shared.Failure(err)
	}
	state := vault.Persistence.NewState()
	var seqs []mcpassignments.Seq
	err = database.Tenant(ctx, actor, func(tx pgx.Tx) error {
		seqs, err = mcpassignments.CloseServerCards(ctx, tx, ring, actor, serverID)
		if err != nil {
			return err
		}
		deleted, err := tx.Exec(ctx, `DELETE FROM mcp_servers WHERE id = $1`, serverID)
		if err != nil {
			return err
		}
		if deleted.RowsAffected() == 0 {
			// Prisma's delete on a missing row is a fault, not an isolation answer.
			return errors.New("mcp server disappeared during removal")
		}
		if secretID == "" {
			return nil
		}
		if err := vault.Persistence.CaptureDropped(ctx, tx, state, secretstore.Secret,
			`SELECT id FROM secrets WHERE id = $1 AND "userId" = $2 AND ("spaceId" = $3 OR "spaceId" IS NULL)`,
			secretID, actor.UserID, actor.SpaceID); err != nil {
			return err
		}
		_, err = tx.Exec(ctx, `DELETE FROM secrets
			WHERE id = $1 AND "userId" = $2 AND ("spaceId" = $3 OR "spaceId" IS NULL)`,
			secretID, actor.UserID, actor.SpaceID)
		return err
	})
	vault.Persistence.Finish(ctx, state, err)
	if err != nil {
		return nil, shared.Failure(err)
	}
	for _, cursor := range seqs {
		// mcp-approval.ts notifies the committed cursors without an event type.
		events.NotifyCommitted(ctx, deployment.Events, nil, nil, cursor.ThreadID, cursor.Seq, "", "")
	}
	return map[string]any{"ok": true}, nil
}
