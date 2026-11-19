package bots

import (
	"context"

	"github.com/jackc/pgx/v5"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/orpc"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/shared"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/validate"
)

// parseReorder mirrors ReorderBotsInput (packages/contracts/src/domain.ts:161): a
// non-empty array of distinct ids. The item checks and the length bound all run for a
// string array; the distinctness refinement is skipped when an item is not a string.
func parseReorder(raw orpc.Input) ([]string, *orpc.Error) {
	object, issues := validate.Decode(raw.Raw, nil)
	if issues != nil {
		return nil, validate.Fail(issues)
	}
	path := validate.Path{"botIds"}
	items, typeIssues := validate.AsArray(path, object.Field("botIds"))
	if typeIssues != nil {
		return nil, validate.Fail(typeIssues)
	}
	var found []validate.Issue
	ids := make([]string, len(items))
	seen := make(map[string]bool, len(items))
	duplicate := false
	aborted := false
	for index, item := range items {
		text, problems := validate.String(path.With(index), item, validate.StringRules{Min: 1})
		if _, ok := item.(string); ok {
			if seen[text] {
				duplicate = true
			}
			seen[text] = true
		} else {
			aborted = true
		}
		ids[index] = text
		found = append(found, problems...)
	}
	found = append(found, validate.ArrayBounds(path, len(items), 1, 0)...)
	if !aborted && duplicate {
		found = append(found, validate.Issue{
			"code": "custom", "path": path.Raw(), "message": "botIds must be distinct",
		})
	}
	if found != nil {
		return nil, validate.Fail(found)
	}
	return ids, nil
}

// Reorder implements bots.reorder: the roster order of every live bot in the Space.
// The ids must name exactly the live bots, each once, or the call is refused.
func Reorder(ctx context.Context, database *db.DB, actor db.Actor, raw orpc.Input) (any, *orpc.Error) {
	ids, failure := parseReorder(raw)
	if failure != nil {
		return nil, failure
	}
	err := database.Tenant(ctx, actor, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `SELECT id FROM bots WHERE "spaceId" = $1 AND "archivedAt" IS NULL`, actor.SpaceID)
		if err != nil {
			return err
		}
		existing := map[string]bool{}
		for rows.Next() {
			var id string
			if err := rows.Scan(&id); err != nil {
				rows.Close()
				return err
			}
			existing[id] = true
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}
		if len(existing) != len(ids) {
			return errIsolation
		}
		for _, id := range ids {
			if !existing[id] {
				return errIsolation
			}
		}
		at := now()
		for position, id := range ids {
			if _, err := tx.Exec(ctx, `UPDATE bots SET position = $1, "updatedAt" = $2 WHERE id = $3 AND "spaceId" = $4`,
				position, at, id, actor.SpaceID); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return nil, shared.Failure(err)
	}
	return map[string]any{"ok": true}, nil
}
