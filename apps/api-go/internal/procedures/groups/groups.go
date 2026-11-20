// Package groups ports groups.restore (apps/api/src/routes/bots.ts:784 over
// packages/db/src/groups.ts:599), including the routine resume the route runs after
// the group and its bots are back. The rest of the group stays on TypeScript:
// create/update/archive/duplicate/remove run thread teardown, run cancellation and
// product events, and the reads build previews from decrypted message blocks.
package groups

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/orpc"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/bots"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/shared"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/validate"
)

const maxTransactionTries = 3

var errIsolation = shared.NotFound

func now() time.Time { return time.Now().UTC().Truncate(time.Millisecond) }

// parseGroupID mirrors z.object({ groupId: Id }).
func parseGroupID(raw orpc.Input) (string, *orpc.Error) {
	object, issues := validate.Decode(raw.Raw, nil)
	if issues != nil {
		return "", validate.Fail(issues)
	}
	groupID, problems := validate.String(validate.Path{"groupId"}, object.Field("groupId"), validate.StringRules{Min: 1})
	if problems != nil {
		return "", validate.Fail(problems)
	}
	return groupID, nil
}

type archivedMember struct {
	BotID          string
	ComputerID     *string
	ComputerUserID *string
}

// Restore implements groups.restore: unarchive the group and every archived bot in it,
// each within its computer's owner's quota, all in one transaction, so one bot that does
// not fit leaves everything archived (restoreGroup, packages/db/src/groups.ts:599). The
// group row is locked first, and the transaction reruns on a serialization conflict as
// withTransactionRetry does. After it commits, every member bot's routines the archive
// turned off resume, as the route does. The roster signal comes from the effects runner.
func Restore(ctx context.Context, database *db.DB, actor db.Actor, deployment shared.Deployment, raw orpc.Input) (any, *orpc.Error) {
	groupID, failure := parseGroupID(raw)
	if failure != nil {
		return nil, failure
	}
	for attempt := 1; ; attempt++ {
		err := database.Tenant(ctx, actor, func(tx pgx.Tx) error {
			return restore(ctx, database, tx, actor, deployment, groupID)
		})
		if err == nil {
			// The route reads the group's members after restoreGroup, then resumes the
			// caller's marked routines on every one of them, live or just restored.
			botIDs, err := groupMemberBotIDs(ctx, database, actor, groupID)
			if err != nil {
				return nil, shared.Failure(err)
			}
			if err := bots.ResumeRoutinesAfterRestore(ctx, database, actor, botIDs); err != nil {
				return nil, shared.Failure(err)
			}
			return map[string]any{"ok": true}, nil
		}
		if attempt >= maxTransactionTries || !shared.TransactionConflict(err) {
			return nil, shared.Failure(err)
		}
	}
}

func restore(ctx context.Context, database *db.DB, tx pgx.Tx, actor db.Actor, deployment shared.Deployment, groupID string) error {
	// lockSpaceGroup: the group row, scoped to the actor's Space, held for the transaction.
	var locked string
	err := tx.QueryRow(ctx, `SELECT id FROM chat_groups WHERE id = $1 AND "spaceId" = $2 FOR NO KEY UPDATE`,
		groupID, actor.SpaceID).Scan(&locked)
	if errors.Is(err, pgx.ErrNoRows) {
		return errIsolation
	}
	if err != nil {
		return err
	}
	rows, err := tx.Query(ctx, `SELECT b.id, b."computerId", c."userId"
		FROM chat_group_members m
		JOIN bots b ON b.id = m."botId"
		LEFT JOIN computers c ON c.id = b."computerId"
		WHERE m."groupId" = $1 AND b."archivedAt" IS NOT NULL
		ORDER BY m."createdAt" ASC, m."botId" ASC`, groupID)
	if err != nil {
		return err
	}
	members := []archivedMember{}
	for rows.Next() {
		var member archivedMember
		if err := rows.Scan(&member.BotID, &member.ComputerID, &member.ComputerUserID); err != nil {
			rows.Close()
			return err
		}
		members = append(members, member)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	at := now()
	for _, member := range members {
		if member.ComputerID != nil && member.ComputerUserID != nil {
			limit, err := shared.MaxComputersPerUser(deployment.MaxComputersPerUser)
			if err != nil {
				return orpc.Internal()
			}
			if err := shared.RestoreBotUnderComputerQuota(ctx, database, tx, limit, *member.ComputerUserID, member.BotID, *member.ComputerID, at); err != nil {
				return err
			}
			continue
		}
		tag, err := tx.Exec(ctx, `UPDATE bots SET "archivedAt" = NULL, "updatedAt" = $1 WHERE id = $2`, at, member.BotID)
		if err != nil {
			return err
		}
		if tag.RowsAffected() != 1 {
			return orpc.Internal()
		}
	}
	tag, err := tx.Exec(ctx, `UPDATE chat_groups SET "archivedAt" = NULL, "updatedAt" = $1 WHERE id = $2 AND "spaceId" = $3`,
		at, groupID, actor.SpaceID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return orpc.Internal()
	}
	return nil
}

// groupMemberBotIDs is the chatGroupMember.findMany between restoreGroup and the
// resume: every member of the group in the caller's Space, archived or not.
func groupMemberBotIDs(ctx context.Context, database *db.DB, actor db.Actor, groupID string) ([]string, error) {
	var botIDs []string
	err := database.Tenant(ctx, actor, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `SELECT m."botId" FROM chat_group_members m
			JOIN chat_groups g ON g.id = m."groupId"
			WHERE m."groupId" = $1 AND g."spaceId" = $2`, groupID, actor.SpaceID)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var botID string
			if err := rows.Scan(&botID); err != nil {
				return err
			}
			botIDs = append(botIDs, botID)
		}
		return rows.Err()
	})
	return botIDs, err
}
