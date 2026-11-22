// Package models ports models.backups (routes/models.ts). The rest of models handles
// credentials and provider calls and stays on the TypeScript API.
package models

import (
	"context"

	"github.com/jackc/pgx/v5"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/orpc"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/shared"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/spacesettings"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/validate"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/wtf8"
)

// Backup is the wire shape of ModelBackupChoiceSchema.
type Backup struct {
	Provider string `json:"provider"`
	ModelID  string `json:"modelId"`
}

// Backups implements models.backups: the member's fallback models for the main role, as
// they apply in this Space (the Space's own copy when it overrides models, else the
// account's), in order. The credential and thinking level of each are not returned.
func Backups(ctx context.Context, database *db.DB, actor db.Actor) ([]Backup, *orpc.Error) {
	backups := []Backup{}
	err := database.Tenant(ctx, actor, func(tx pgx.Tx) error {
		target, err := spacesettings.Target(ctx, tx, actor, "models", "")
		if err != nil {
			return err
		}
		var rows pgx.Rows
		if target == "space" {
			rows, err = tx.Query(ctx, `SELECT provider, "modelId" FROM space_model_role_choices
				WHERE "userId" = $1 AND "spaceId" = $2 AND role = 'main' AND "position" > 0 ORDER BY "position" ASC`, actor.UserID, actor.SpaceID)
		} else {
			rows, err = tx.Query(ctx, `SELECT provider, "modelId" FROM user_model_role_choices
				WHERE "userId" = $1 AND role = 'main' AND "position" > 0 ORDER BY "position" ASC`, actor.UserID)
		}
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var backup Backup
			if err := rows.Scan(&backup.Provider, &backup.ModelID); err != nil {
				return err
			}
			// The router parses the output as z.string().trim().min(1).max(n): the values are
			// returned trimmed, and a stored one that is blank or too long fails the call.
			backup.Provider, backup.ModelID = validate.JSTrim(backup.Provider), validate.JSTrim(backup.ModelID)
			if !wtf8.Fits(backup.Provider, 1, 128) {
				return shared.OutputInvalid()
			}
			if !wtf8.Fits(backup.ModelID, 1, 512) {
				return shared.OutputInvalid()
			}
			backups = append(backups, backup)
		}
		return rows.Err()
	})
	if err != nil {
		return nil, shared.Failure(err)
	}
	return backups, nil
}
