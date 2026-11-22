package computer

import (
	"context"
	"errors"
	"math/big"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/orpc"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/shared"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/validate"
)

// ok is the `{ok: true}` both dismiss procedures answer.
var ok = map[string]any{"ok": true}

// DismissUpdate implements computer.dismissUpdate (apps/api/src/routes/computer.ts:317-328): mark
// a failed update dismissed for a computer of this Space that still has a live bot. Only a row
// that changed publishes the computerUpdates signal.
func DismissUpdate(ctx context.Context, database *db.DB, deployment shared.Deployment, actor db.Actor, raw orpc.Input) (any, *orpc.Error) {
	id, failure := parseID(raw, "id")
	if failure != nil {
		return nil, failure
	}
	var dismissed bool
	err := database.Tenant(ctx, actor, func(tx pgx.Tx) error {
		at := time.Now().UTC().Truncate(time.Millisecond)
		arguments := append([]any{id}, db.Data(at)...)
		arguments = append(arguments, actor.SpaceID)
		tag, err := tx.Exec(ctx, `UPDATE computer_updates u SET status = 'dismissed', "updatedAt" = $2
			FROM computers c
			WHERE u.id = $1 AND u.status = 'failed' AND c.id = u."computerId" AND c."spaceId" = $3
				AND EXISTS (SELECT 1 FROM bots b WHERE b."computerId" = c.id AND b."archivedAt" IS NULL)`,
			arguments...)
		if err != nil {
			return err
		}
		dismissed = tag.RowsAffected() > 0
		return nil
	})
	if err != nil {
		return nil, shared.Failure(err)
	}
	if dismissed && deployment.Signals != nil {
		deployment.Signals.PublishSpaceChange(actor.SpaceID, "computerUpdates")
	}
	return ok, nil
}

// DismissDiskWarning implements computer.dismissDiskWarning
// (apps/api/src/routes/computer.ts:329-339): remember the disk's fill so the warning stays away
// until it deepens. A bot without a computer, or one never measured, changes nothing.
func DismissDiskWarning(ctx context.Context, database *db.DB, actor db.Actor, raw orpc.Input) (any, *orpc.Error) {
	botID, failure := parseID(raw, "botId")
	if failure != nil {
		return nil, failure
	}
	err := database.Tenant(ctx, actor, func(tx pgx.Tx) error {
		var computerID *string
		var used, free *int64
		err := tx.QueryRow(ctx, `SELECT c.id, c."diskUsedBytes", c."diskFreeBytes"
			FROM bots b LEFT JOIN computers c ON c.id = b."computerId"
			WHERE b.id = $1 AND b."spaceId" = $2 AND b."archivedAt" IS NULL`,
			botID, actor.SpaceID).Scan(&computerID, &used, &free)
		if errors.Is(err, pgx.ErrNoRows) {
			return shared.NotFound
		}
		if err != nil {
			return err
		}
		if computerID == nil {
			return nil
		}
		percent, present := diskUsedPercent(used, free)
		if !present {
			return nil
		}
		at := time.Now().UTC().Truncate(time.Millisecond)
		_, err = tx.Exec(ctx, `UPDATE computers SET "diskDismissedPercent" = $2, "updatedAt" = $3 WHERE id = $1`,
			append([]any{*computerID}, db.Data(percent, at)...)...)
		return err
	})
	if err != nil {
		return nil, shared.Failure(err)
	}
	return ok, nil
}

// diskUsedPercent is diskUsedPercent (packages/adapters/src/computers/computer-disk.ts:83-87): the
// ceiling percent of a disk last measured, or false when it never was or holds nothing.
func diskUsedPercent(used, free *int64) (int64, bool) {
	if used == nil || free == nil {
		return 0, false
	}
	usedValue, freeValue := big.NewInt(*used), big.NewInt(*free)
	total := new(big.Int).Add(usedValue, freeValue)
	if total.Sign() == 0 {
		return 0, false
	}
	numerator := new(big.Int).Mul(usedValue, big.NewInt(100))
	numerator.Add(numerator, usedValue)
	numerator.Add(numerator, freeValue)
	numerator.Sub(numerator, big.NewInt(1))
	return new(big.Int).Div(numerator, total).Int64(), true
}

// parseID is z.object({ key: Id }): one non-empty string field, unknown keys dropped.
func parseID(raw orpc.Input, key string) (string, *orpc.Error) {
	object, issues := validate.Decode(raw.Raw, nil)
	if issues != nil {
		return "", validate.Fail(issues)
	}
	value, problems := validate.String(validate.Path{key}, object.Field(key), validate.StringRules{Min: 1})
	if problems != nil {
		return "", validate.Fail(problems)
	}
	return value, nil
}
