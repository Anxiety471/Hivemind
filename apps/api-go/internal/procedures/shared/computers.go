package shared

import (
	"context"
	"errors"
	"fmt"
	"math"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/orpc"
)

// MaxComputersPerUser is resolveMaxComputersPerUser (packages/db/src/computers.ts:136):
// an unset, blank or "0" value means no configured cap; anything else must be a positive
// whole number. TypeScript throws for a bad value, which the API answers with a generic
// 500, so the caller returns Internal on error.
func MaxComputersPerUser(configured string) (int, error) {
	value := strings.TrimSpace(configured)
	if value == "" || value == "0" {
		return 0, nil
	}
	number, err := strconv.ParseFloat(value, 64)
	if err != nil || math.IsNaN(number) || math.IsInf(number, 0) || math.Trunc(number) != number || number < 1 || number > 1<<53-1 {
		return 0, errors.New("SANDBOX_MAX_COMPUTERS_PER_USER must be a positive integer, or 0 for no configured cap")
	}
	return int(number), nil
}

// RestoreBotUnderComputerQuota is restoreBotUnderComputerQuota (packages/db/src/computers.ts:241):
// clear a bot's archivedAt inside the caller's transaction, under the per-user computer
// quota. The quota covers every Space the owner has, so the counts run as system
// (countInUseComputersForUser, :174). A restore that would exceed the limit leaves the
// bot archived and answers the quota ClientError.
func RestoreBotUnderComputerQuota(ctx context.Context, database *db.DB, tx pgx.Tx, limit int, userID, botID, computerID string, at time.Time) error {
	if limit > 0 {
		// Seed 1 keeps this keyspace apart from lockSpaceForContentCreation (seed 0).
		if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1, 1))`, userID); err != nil {
			return err
		}
		var live int
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM computers c
			WHERE c.id = $1
				AND EXISTS (SELECT 1 FROM bots b WHERE b."computerId" = c.id AND b."archivedAt" IS NULL)`,
			computerID).Scan(&live); err != nil {
			return err
		}
		if live == 0 {
			inUse := 0
			if err := database.InSystem(ctx, tx, func() error {
				return tx.QueryRow(ctx, `SELECT count(*) FROM computers c
					WHERE c."userId" = $1
						AND EXISTS (SELECT 1 FROM bots b WHERE b."computerId" = c.id AND b."archivedAt" IS NULL)`,
					userID).Scan(&inUse)
			}); err != nil {
				return err
			}
			if inUse >= limit {
				return orpc.BadRequest(fmt.Sprintf("User computer limit (%d) reached", limit))
			}
		}
	}
	tag, err := tx.Exec(ctx, `UPDATE bots SET "archivedAt" = NULL, "updatedAt" = $1 WHERE id = $2`, at, botID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		// Prisma's update throws when the row is gone, which the API answers with a 500.
		return errors.New("bot to restore not found")
	}
	return nil
}
