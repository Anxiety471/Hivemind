package bots

import (
	"context"

	"github.com/jackc/pgx/v5"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/orpc"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/shared"
)

// maxTransactionTries mirrors withTransactionRetry's three attempts.
const maxTransactionTries = 3

// Restore implements bots.restore: unarchive the bot, within its computer's owner's
// quota (restoreBotUnderComputerQuota, packages/db/src/computers.ts:241). A live bot is
// left alone. The roster and Space-change signals come from the effects runner.
//
// TypeScript runs the quota path's transaction (and the lone update of the no-computer
// path, through row-security's retry) with withTransactionRetry, so a serialization or
// deadlock failure is rerun up to three times; this loop matches that.
func Restore(ctx context.Context, database *db.DB, actor db.Actor, deployment shared.Deployment, raw orpc.Input) (any, *orpc.Error) {
	botID, failure := parseBotID(raw)
	if failure != nil {
		return nil, failure
	}
	for attempt := 1; ; attempt++ {
		err := database.Tenant(ctx, actor, func(tx pgx.Tx) error {
			bot, err := loadBot(ctx, tx, actor, botID, true)
			if err != nil {
				return err
			}
			if bot.ArchivedAt == nil {
				return nil
			}
			at := now()
			if bot.ComputerID != nil && bot.ComputerUserID != nil {
				limit, err := shared.MaxComputersPerUser(deployment.MaxComputersPerUser)
				if err != nil {
					return orpc.Internal()
				}
				return shared.RestoreBotUnderComputerQuota(ctx, database, tx, limit, *bot.ComputerUserID, bot.ID, *bot.ComputerID, at)
			}
			tag, err := tx.Exec(ctx, `UPDATE bots SET "archivedAt" = NULL, "updatedAt" = $1 WHERE id = $2 AND "spaceId" = $3`,
				at, bot.ID, actor.SpaceID)
			if err != nil {
				return err
			}
			if tag.RowsAffected() != 1 {
				return orpc.Internal()
			}
			return nil
		})
		if err == nil {
			return map[string]any{"ok": true}, nil
		}
		if attempt >= maxTransactionTries || !shared.TransactionConflict(err) {
			return nil, shared.Failure(err)
		}
	}
}
