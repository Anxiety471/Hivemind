package bots

import (
	"context"

	"github.com/jackc/pgx/v5"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/orpc"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/shared"
)

// RemovedGroup is one entry of bots.removePreview's answer.
type RemovedGroup struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// RemovePreview implements bots.removePreview: the groups that deleting the bot would
// dissolve, because fewer than GROUP_MEMBER_MIN active bots would remain
// (groupsRemovedByDeletingBot, packages/adapters/src/child-bots.ts:625 with
// groupsDissolvedByRemovingBot at :612). Archived members count for nothing.
func RemovePreview(ctx context.Context, database *db.DB, actor db.Actor, raw orpc.Input) (any, *orpc.Error) {
	botID, failure := parseBotID(raw)
	if failure != nil {
		return nil, failure
	}
	removed := []RemovedGroup{}
	err := database.Tenant(ctx, actor, func(tx pgx.Tx) error {
		bot, err := loadBot(ctx, tx, actor, botID, true)
		if err != nil {
			return err
		}
		// Any member can archive; only the bot's creator or the Space owner deletes for good
		// (bot-removal.ts:8).
		if bot.UserID != actor.UserID {
			if err := requireOwner(ctx, tx, actor); err != nil {
				return err
			}
		}
		rows, err := tx.Query(ctx, `SELECT g.id, g.name,
				(SELECT count(*) FROM chat_group_members m JOIN bots b ON b.id = m."botId"
					WHERE m."groupId" = g.id AND m."botId" <> $1 AND b."archivedAt" IS NULL) AS active
			FROM chat_groups g
			WHERE EXISTS (SELECT 1 FROM chat_group_members m WHERE m."groupId" = g.id AND m."botId" = $1)
			ORDER BY g.name ASC, g.id ASC`, bot.ID)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var group RemovedGroup
			var active int64
			if err := rows.Scan(&group.ID, &group.Name, &active); err != nil {
				return err
			}
			if active < groupMemberMin {
				removed = append(removed, group)
			}
		}
		return rows.Err()
	})
	if err != nil {
		return nil, shared.Failure(err)
	}
	return removed, nil
}
