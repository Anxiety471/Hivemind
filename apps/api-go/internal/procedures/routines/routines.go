package routines

import (
	"context"

	"github.com/jackc/pgx/v5"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/orpc"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/shared"
)

// ListedRoutines is one bot's routines in routines.listForMentions' answer.
type ListedRoutines struct {
	BotID    string    `json:"botId"`
	Routines []Routine `json:"routines"`
}

// List implements routines.list: a bot of the actor's Space that is not archived
// (repos.getBot, packages/db/src/repos.ts:415), then its routines.
//
// listRoutinesDto (apps/api/src/routines/routines.ts:138) sets no order on its query, and
// neither does this one: the order is whatever the database returns, as in TypeScript.
func List(ctx context.Context, database *db.DB, actor db.Actor, raw orpc.Input) (any, *orpc.Error) {
	botID, failure := parseBotID(raw)
	if failure != nil {
		return nil, failure
	}
	list := []Routine{}
	err := database.Tenant(ctx, actor, func(tx pgx.Tx) error {
		if err := shared.RequireBot(ctx, tx, actor, botID); err != nil {
			return err
		}
		loaded, err := loadRoutines(ctx, tx, actor.SpaceID, []string{botID})
		list = loaded
		return err
	})
	if err != nil {
		return nil, shared.Failure(err)
	}
	for _, routine := range list {
		if !routine.valid() {
			return nil, shared.OutputInvalid()
		}
	}
	return list, nil
}

// ListForMentions implements routines.listForMentions: the routines of the named bots the
// actor's Space is allowed to list, grouped by bot in the order the bot query returned them.
// The ownership predicates are getBot's, so a batch never widens what routines.list allows.
func ListForMentions(ctx context.Context, database *db.DB, actor db.Actor, raw orpc.Input) (any, *orpc.Error) {
	botIDs, failure := parseMentions(raw)
	if failure != nil {
		return nil, failure
	}
	// A list the API builds with .map() is [] and never null.
	listed := []ListedRoutines{}
	err := database.Tenant(ctx, actor, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `SELECT id FROM bots
			WHERE id = ANY($1) AND "spaceId" = $2 AND "archivedAt" IS NULL`, botIDs, actor.SpaceID)
		if err != nil {
			return err
		}
		ids := []string{}
		for rows.Next() {
			var id string
			if err := rows.Scan(&id); err != nil {
				rows.Close()
				return err
			}
			ids = append(ids, id)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}
		routines, err := loadRoutines(ctx, tx, actor.SpaceID, ids)
		if err != nil {
			return err
		}
		position := make(map[string]int, len(ids))
		for index, id := range ids {
			position[id] = index
			listed = append(listed, ListedRoutines{BotID: id, Routines: []Routine{}})
		}
		// The API groups with a filter over the routine query's own rows, so each bot's
		// routines keep the order the database returned.
		for _, routine := range routines {
			index, ok := position[routine.BotID]
			if !ok {
				continue
			}
			listed[index].Routines = append(listed[index].Routines, routine)
		}
		return nil
	})
	if err != nil {
		return nil, shared.Failure(err)
	}
	for _, group := range listed {
		if group.BotID == "" {
			return nil, shared.OutputInvalid()
		}
		for _, routine := range group.Routines {
			if !routine.valid() {
				return nil, shared.OutputInvalid()
			}
		}
	}
	return listed, nil
}
