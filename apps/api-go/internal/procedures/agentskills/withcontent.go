package agentskills

import (
	"context"

	"github.com/jackc/pgx/v5"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/orpc"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/shared"
)

// ListWithContent is agentSkills.listWithContent (apps/api/src/routes/memory.ts:
// agentSkills.listWithContent): the same merged catalog List serves, bodies included.
// routines.testRun expands `/Name` and `@Name` references against it.
func ListWithContent(ctx context.Context, database *db.DB, actor db.Actor) ([]Skill, *orpc.Error) {
	var rows []skillRow
	err := database.Tenant(ctx, actor, func(tx pgx.Tx) error {
		found, err := listRows(ctx, tx, actor)
		rows = found
		return err
	})
	if err != nil {
		return nil, shared.Failure(err)
	}
	userSkills := make([]Skill, 0, len(rows))
	for _, row := range rows {
		userSkills = append(userSkills, row.skill())
	}
	return mergeBuiltinSkills(builtinCatalog(), userSkills), nil
}
