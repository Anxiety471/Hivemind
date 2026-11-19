package bots

import (
	"context"
	"time"

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
//
// TypeScript loads each member's bot through the Prisma client, whose row-level security
// hides a bot of another Space: the relation then reads as null and
// `member.bot.archivedAt` throws, which the route answers with a generic 500. A member
// row whose bot is not visible therefore fails the call the same way here.
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
		groupRows, err := tx.Query(ctx, `SELECT g.id, g.name
			FROM chat_groups g
			WHERE EXISTS (SELECT 1 FROM chat_group_members m WHERE m."groupId" = g.id AND m."botId" = $1)
			ORDER BY g.name ASC, g.id ASC`, bot.ID)
		if err != nil {
			return err
		}
		groups := []RemovedGroup{}
		ids := []string{}
		for groupRows.Next() {
			var group RemovedGroup
			if err := groupRows.Scan(&group.ID, &group.Name); err != nil {
				groupRows.Close()
				return err
			}
			groups = append(groups, group)
			ids = append(ids, group.ID)
		}
		groupRows.Close()
		if err := groupRows.Err(); err != nil {
			return err
		}
		if len(groups) == 0 {
			return nil
		}
		// A LEFT JOIN keeps the member row while row-level security hides the bot: a null
		// bot id is the relation Prisma reads as null, which throws in TypeScript.
		memberRows, err := tx.Query(ctx, `SELECT m."groupId", m."botId", b.id, b."archivedAt"
			FROM chat_group_members m
			LEFT JOIN bots b ON b.id = m."botId"
			WHERE m."groupId" = ANY($1)`, ids)
		if err != nil {
			return err
		}
		active := map[string]int64{}
		for memberRows.Next() {
			var groupID, memberBotID string
			var visibleID *string
			var archivedAt *time.Time
			if err := memberRows.Scan(&groupID, &memberBotID, &visibleID, &archivedAt); err != nil {
				memberRows.Close()
				return err
			}
			if visibleID == nil {
				memberRows.Close()
				return orpc.Internal()
			}
			if memberBotID != bot.ID && archivedAt == nil {
				active[groupID]++
			}
		}
		memberRows.Close()
		if err := memberRows.Err(); err != nil {
			return err
		}
		for _, group := range groups {
			if active[group.ID] < groupMemberMin {
				removed = append(removed, group)
			}
		}
		return nil
	})
	if err != nil {
		return nil, shared.Failure(err)
	}
	return removed, nil
}
