package mcpservers

// mcp.oauth.disconnect (apps/api/src/routes/mcp.ts:639-653, McpOAuthBroker.disconnect at
// packages/adapters/src/mcp/mcp-oauth.ts:1546-1594): end this member's pending sign-ins for the
// server, drop the stored OAuth state from the server's sealed material, raise the authorization
// generation so an authorization still in flight cannot connect the server afterwards, bump the
// server's revision, and reset the health verdict that belonged to the old credential.
//
// The shipped broker also discards its in-process pending sign-ins. Go never runs
// mcp.oauth.begin (it is proxied), so it has none to discard; the generation raise below is the
// cross-process protection, and the callback checks it before it would store tokens.

import (
	"context"
	"errors"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/effects"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/local"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/orpc"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/shared"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/secretstore"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/validate"
)

// oauthPendingMessage is MCP_OAUTH_PENDING_MESSAGE (apps/api/src/integrations/mcp-servers.ts:90).
const oauthPendingMessage = "Connect this server's account to check it."

// materialTries is replaceMaterial's retry count (mcp-oauth.ts:1774).
const materialTries = 5

// materialSnapshot is MaterialSnapshot (mcp-oauth.ts:1129-1132).
type materialSnapshot struct {
	endpoint   *string
	secretID   *string
	ciphertext *string
	secretRow  string
}

// Disconnect implements mcp.oauth.disconnect.
func Disconnect(
	ctx context.Context,
	database *db.DB,
	deployment shared.Deployment,
	actor db.Actor,
	raw orpc.Input,
) (any, *orpc.Error) {
	values, failure := shared.IDFields(raw, "serverId")
	if failure != nil {
		return nil, failure
	}
	// The security event carries this id, and the server does not have to exist; a value the
	// TypeScript redactor could rewrite goes to TypeScript (gateway decline) rather than being
	// recorded differently or dropped.
	if !effects.AuditedMetadataServable(values["serverId"]) {
		return nil, local.ErrDecline
	}
	vault, err := shared.VaultDeps(deployment.Vault)
	if err != nil {
		return nil, shared.Failure(err)
	}
	serverID := values["serverId"]
	// End this actor's pending sign-ins first, whether or not the server is still visible: a
	// callback that lands after the disconnect must not find them.
	err = database.Tenant(ctx, actor, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `DELETE FROM mcp_oauth_sessions
			WHERE "serverId" = $1 AND "spaceId" = $2 AND "userId" = $3`,
			serverID, actor.SpaceID, actor.UserID)
		return err
	})
	if err != nil {
		return nil, shared.Failure(err)
	}
	var revision *int32
	err = database.Tenant(ctx, actor, func(tx pgx.Tx) error {
		var found string
		//writeaudit:dynamic read: the predicate is the fixed serverAvailable const; the ids are filters
		err := tx.QueryRow(ctx, `SELECT id FROM mcp_servers WHERE id = $3 AND `+serverAvailable,
			actor.SpaceID, actor.UserID, serverID).Scan(&found)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		if err != nil {
			return err
		}
		committed, err := replaceMaterial(ctx, database, vault, actor, serverID)
		if err != nil {
			return err
		}
		revision = &committed
		return nil
	})
	if err != nil {
		return nil, shared.Failure(err)
	}
	if revision != nil {
		// recordMcpServerHealth is best effort: its failure is logged, never returned.
		recordHealth(ctx, database, actor, serverID, *revision)
	}
	return map[string]any{"ok": true}, nil
}

// recordHealth is recordMcpServerHealth (mcp-server-health.ts:31-58) for this reset: only this
// revision's verdict changes, and a server deleted mid-write is a silent no-op.
func recordHealth(ctx context.Context, database *db.DB, actor db.Actor, serverID string, revision int32) {
	now := time.Now().UTC().Truncate(time.Millisecond)
	err := database.Tenant(ctx, actor, func(tx pgx.Tx) error {
		arguments := append(db.Data(oauthPendingMessage, now), serverID, revision)
		_, err := tx.Exec(ctx, `UPDATE mcp_servers SET "healthStatus" = 'unknown',
			"healthMessage" = $1, "healthToolCount" = NULL, "healthCheckedAt" = $2,
			"updatedAt" = $2 WHERE id = $3 AND revision = $4`, arguments...)
		return err
	})
	if err != nil {
		slog.Default().Error("mcp server health write failed", "mcp.server.id", serverID, "error", err)
	}
}

// replaceMaterial is replaceMaterial with raiseGeneration and incrementRevision
// (mcp-oauth.ts:1756-1875): re-read the material under the credential lock, drop its OAuth state,
// raise its generation, store a new secret row, and swap the server's pointer in one transaction.
// A snapshot that changed under it is retried; a fifth refusal is the broker's own error.
func replaceMaterial(
	ctx context.Context,
	database *db.DB,
	vault *shared.SecretVault,
	actor db.Actor,
	serverID string,
) (int32, error) {
	for range materialTries {
		snapshot, err := snapshotMaterial(ctx, database, actor, serverID)
		if err != nil {
			return 0, err
		}
		var material any = EmptyMaterial()
		if snapshot.ciphertext != nil {
			material, err = ReadMaterial(vault, ctx, *snapshot.ciphertext, snapshot.secretRow)
			if err != nil {
				return 0, err
			}
		}
		deleteMaterialKey(material, "oauth")
		raiseGeneration(material)
		record, err := vault.Writer.Put(ctx, validate.Stringify(material), secretstore.PutOptions{})
		if err != nil {
			return 0, err
		}
		state := vault.Persistence.NewState()
		vault.Persistence.TrackWrite(state, secretstore.Secret, record.ID, record.Ciphertext)
		committed := false
		var revision int32
		txErr := database.Tenant(ctx, actor, func(tx pgx.Tx) error {
			//writeaudit:dynamic transaction-scoped advisory lock; no row payload
			if _, err := tx.Exec(ctx,
				`SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))`,
				"mcp-oauth-material", serverID); err != nil {
				return err
			}
			var current materialSnapshot
			var spaceID string
			var allSpaces bool
			//writeaudit:dynamic read: the predicate is the fixed serverAvailable const; the ids are filters
			err := tx.QueryRow(ctx, `SELECT endpoint, "secretId", "spaceId", "allSpaces"
				FROM mcp_servers WHERE id = $3 AND `+serverAvailable,
				actor.SpaceID, actor.UserID, serverID).Scan(
				&current.endpoint, &current.secretID, &spaceID, &allSpaces)
			if errors.Is(err, pgx.ErrNoRows) {
				return errors.New("MCP server is unavailable")
			}
			if err != nil {
				return err
			}
			if !sameText(current.endpoint, snapshot.endpoint) ||
				!sameText(current.secretID, snapshot.secretID) {
				return nil
			}
			if current.secretID != nil {
				var locked string
				err := tx.QueryRow(ctx, `SELECT id FROM secrets WHERE id = $1 FOR UPDATE`,
					*current.secretID).Scan(&locked)
				if err != nil && !errors.Is(err, pgx.ErrNoRows) {
					return err
				}
			}
			current.ciphertext = nil
			current.secretRow = ""
			if current.secretID != nil {
				err := tx.QueryRow(ctx, `SELECT id, ciphertext FROM secrets
					WHERE id = $1 AND "userId" = $2 AND ("spaceId" = $3 OR "spaceId" IS NULL)`,
					*current.secretID, actor.UserID, actor.SpaceID).
					Scan(&current.secretRow, &current.ciphertext)
				if err != nil && !errors.Is(err, pgx.ErrNoRows) {
					return err
				}
			}
			if !sameText(current.ciphertext, snapshot.ciphertext) {
				return nil
			}
			// A server available beyond this Space keeps its credential on the account.
			sharedElsewhere := allSpaces || spaceID != actor.SpaceID
			if !sharedElsewhere {
				var joined int
				if err := tx.QueryRow(ctx, `SELECT count(*)::int FROM mcp_server_spaces
					WHERE "serverId" = $1`, serverID).Scan(&joined); err != nil {
					return err
				}
				sharedElsewhere = joined > 0
			}
			var secretSpace any
			if !sharedElsewhere {
				secretSpace = actor.SpaceID
			}
			if _, err := tx.Exec(ctx, `INSERT INTO secrets (id, "spaceId", "userId", kind, ciphertext)
				VALUES ($1, $2, $3, 'mcp', $4)`,
				db.Data(record.ID, secretSpace, actor.UserID, record.Ciphertext)...); err != nil {
				return err
			}
			at := time.Now().UTC().Truncate(time.Millisecond)
			arguments := append(db.Data(record.ID, at), serverID)
			err = tx.QueryRow(ctx, `UPDATE mcp_servers SET "secretId" = $1,
				revision = revision + 1, "updatedAt" = $2 WHERE id = $3 RETURNING revision`,
				arguments...).Scan(&revision)
			if err != nil {
				return err
			}
			if current.secretID != nil && *current.secretID != record.ID {
				if err := vault.Persistence.CaptureDropped(ctx, tx, state, secretstore.Secret,
					`SELECT id FROM secrets WHERE id = $1`, *current.secretID); err != nil {
					return err
				}
				if _, err := tx.Exec(ctx, `DELETE FROM secrets WHERE id = $1`,
					*current.secretID); err != nil {
					return err
				}
			}
			committed = true
			return nil
		})
		vault.Persistence.Finish(ctx, state, txErr)
		if txErr != nil {
			return 0, txErr
		}
		if committed {
			return revision, nil
		}
	}
	return 0, errors.New("MCP credentials changed during authorization; retry")
}

// snapshotMaterial is McpOAuthBroker.snapshot (mcp-oauth.ts:1877-1897): the server and its
// credential as one transaction saw them, before the sealed material is read outside it.
func snapshotMaterial(
	ctx context.Context,
	database *db.DB,
	actor db.Actor,
	serverID string,
) (materialSnapshot, error) {
	var snapshot materialSnapshot
	err := database.Tenant(ctx, actor, func(tx pgx.Tx) error {
		//writeaudit:dynamic read: the predicate is the fixed serverAvailable const; the ids are filters
		err := tx.QueryRow(ctx, `SELECT endpoint, "secretId" FROM mcp_servers
			WHERE id = $3 AND `+serverAvailable, actor.SpaceID, actor.UserID, serverID).
			Scan(&snapshot.endpoint, &snapshot.secretID)
		if errors.Is(err, pgx.ErrNoRows) {
			return errors.New("MCP server is unavailable")
		}
		if err != nil {
			return err
		}
		if snapshot.secretID == nil {
			return nil
		}
		err = tx.QueryRow(ctx, `SELECT id, ciphertext FROM secrets
			WHERE id = $1 AND "userId" = $2 AND ("spaceId" = $3 OR "spaceId" IS NULL)`,
			*snapshot.secretID, actor.UserID, actor.SpaceID).
			Scan(&snapshot.secretRow, &snapshot.ciphertext)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		return err
	})
	return snapshot, err
}

// sameText compares two optional strings as Prisma's equality on a nullable column does.
func sameText(left, right *string) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	return *left == *right
}
