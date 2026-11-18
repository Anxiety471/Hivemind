// Package botsections ports botSections.list. create, update and remove stay on
// the TypeScript API: they publish roster changes (roster-procedures.ts:44-46).
package botsections

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/orpc"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/shared"
)

// Section is the wire shape of BotSectionSchema; the Space id is stripped there.
type Section struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Position  int32  `json:"position"`
	CreatedAt string `json:"createdAt"`
	UpdatedAt string `json:"updatedAt"`
}

const isoMillis = "2006-01-02T15:04:05.000Z"

// List implements botSections.list (repos.ts listBotSections): every section of
// the actor's Space, whoever made it, by position then creation time.
func List(ctx context.Context, database *db.DB, actor db.Actor) ([]Section, *orpc.Error) {
	sections := []Section{}
	err := database.Tenant(ctx, actor, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `SELECT id, name, position, "createdAt", "updatedAt"
			FROM bot_sections WHERE "spaceId" = $1 ORDER BY position ASC, "createdAt" ASC`, actor.SpaceID)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var section Section
			var createdAt, updatedAt time.Time
			if err := rows.Scan(&section.ID, &section.Name, &section.Position, &createdAt, &updatedAt); err != nil {
				return err
			}
			// The router parses the output: a section's position is a nonnegative count.
			if section.Position < 0 {
				return shared.OutputInvalid()
			}
			section.CreatedAt = createdAt.UTC().Format(isoMillis)
			section.UpdatedAt = updatedAt.UTC().Format(isoMillis)
			sections = append(sections, section)
		}
		return rows.Err()
	})
	if err != nil {
		var failure *orpc.Error
		if errors.As(err, &failure) {
			return nil, failure
		}
		if db.IsUnavailable(err) {
			return nil, orpc.Unavailable()
		}
		return nil, orpc.Internal()
	}
	return sections, nil
}
