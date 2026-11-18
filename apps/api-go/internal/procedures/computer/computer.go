// Package computer ports computer.updates (routes/computer.ts). Every other computer
// procedure controls a sandbox or starts jobs and stays on the TypeScript API.
package computer

import (
	"context"

	"github.com/jackc/pgx/v5"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/orpc"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/shared"
)

// Update is the wire shape of ComputerUpdateSchema as computerUpdateView fills it.
type Update struct {
	CanReleaseReservation bool   `json:"canReleaseReservation"`
	Action                string `json:"action"`
	ID                    string `json:"id"`
	BotID                 string `json:"botId"`
	Name                  string `json:"name"`
	Mode                  string `json:"mode"`
	Status                string `json:"status"`
	Stage                 string `json:"stage"`
}

var (
	actions = map[string]bool{"update": true, "recover": true}
	stages  = map[string]bool{"preparing": true, "saving": true, "recreating": true, "restoring": true, "reconnecting": true}
)

type bot struct{ id, name string }

// Updates implements computer.updates: the Space's computer updates that are queued,
// running, interrupted or failed, for computers that still have a live bot, newest
// first. A row the schema cannot parse (an unknown action or stage) fails the call, as
// ComputerUpdateSchema.parse does.
func Updates(ctx context.Context, database *db.DB, actor db.Actor) ([]Update, *orpc.Error) {
	updates := []Update{}
	err := database.Tenant(ctx, actor, func(tx pgx.Tx) error {
		type row struct {
			id, action, status, stage, botID, computerID, scope string
		}
		rows, err := tx.Query(ctx, `SELECT u.id, u.action, u.status, u.stage, u."botId", u."computerId", c.scope
			FROM computer_updates u JOIN computers c ON c.id = u."computerId"
			WHERE u.status IN ('queued', 'running', 'interrupted', 'failed') AND c."spaceId" = $1
				AND EXISTS (SELECT 1 FROM bots b WHERE b."computerId" = c.id AND b."archivedAt" IS NULL)
			ORDER BY u."createdAt" DESC`, actor.SpaceID)
		if err != nil {
			return err
		}
		var found []row
		for rows.Next() {
			var r row
			if err := rows.Scan(&r.id, &r.action, &r.status, &r.stage, &r.botID, &r.computerID, &r.scope); err != nil {
				rows.Close()
				return err
			}
			found = append(found, r)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}
		if len(found) == 0 {
			return nil
		}
		computerIDs := make([]string, len(found))
		for index, r := range found {
			computerIDs[index] = r.computerID
		}
		botRows, err := tx.Query(ctx, `SELECT id, name, "computerId" FROM bots WHERE "computerId" = ANY($1) AND "archivedAt" IS NULL`, computerIDs)
		if err != nil {
			return err
		}
		bots := map[string][]bot{}
		for botRows.Next() {
			var computerID string
			var b bot
			if err := botRows.Scan(&b.id, &b.name, &computerID); err != nil {
				botRows.Close()
				return err
			}
			bots[computerID] = append(bots[computerID], b)
		}
		botRows.Close()
		if err := botRows.Err(); err != nil {
			return err
		}
		for _, r := range found {
			if !actions[r.action] || !stages[r.stage] || r.id == "" || r.botID == "" {
				return orpc.Internal()
			}
			members := bots[r.computerID]
			update := Update{Action: r.action, ID: r.id, BotID: r.botID, Status: r.status, Stage: r.stage, Mode: "dedicated"}
			if r.scope == "team" {
				update.Mode = "team"
			}
			named := false
			for _, b := range members {
				if b.id == r.botID {
					named = true
					update.Name = b.name
					break
				}
			}
			// A bot that is gone falls back to the computer's first live bot, with no name.
			if !named && len(members) > 0 {
				update.BotID = members[0].id
			}
			updates = append(updates, update)
		}
		return nil
	})
	if err != nil {
		return nil, shared.Failure(err)
	}
	return updates, nil
}
