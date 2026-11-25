package routines

import (
	"context"

	"github.com/jackc/pgx/v5"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/orpc"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/shared"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/validate"
)

// codeCommandMaxCount is CODE_COMMAND_MAX_COUNT (packages/adapters/src/tools/code-commands.ts:11):
// a Space holds at most this many saved commands, and listCodeCommands takes no more.
const codeCommandMaxCount = 500

// RoutineCommand is the wire shape of RoutineCommandSchema (routine-prepare.ts:19), in the
// schema's declaration order. Icon is a Lucide name, null for the default; Parameters is the
// JSON Schema for the command's args, null when it takes none.
type RoutineCommand struct {
	Name        string         `json:"name"`
	Description string         `json:"description"`
	Icon        *string        `json:"icon"`
	Parameters  map[string]any `json:"parameters"`
}

// Commands implements routines.commands: the saved commands of the caller's Space as the
// routine editor picks one (listCodeCommands, code-commands.ts:101).
func Commands(ctx context.Context, database *db.DB, actor db.Actor, raw orpc.Input) (any, *orpc.Error) {
	if failure := parseCommands(raw); failure != nil {
		return nil, failure
	}
	commands := []RoutineCommand{}
	err := database.Tenant(ctx, actor, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `SELECT name, description, icon, parameters FROM code_commands
			WHERE "spaceId" = $1 ORDER BY name ASC LIMIT $2`, actor.SpaceID, codeCommandMaxCount)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var name, description string
			var icon *string
			var parameters []byte
			if err := rows.Scan(&name, &description, &icon, &parameters); err != nil {
				return err
			}
			command := RoutineCommand{Name: name, Description: description, Parameters: storedParameters(parameters)}
			// summary() keeps an icon only when it is truthy, and the handler sends null otherwise.
			if icon != nil && *icon != "" {
				command.Icon = icon
			}
			commands = append(commands, command)
		}
		return rows.Err()
	})
	if err != nil {
		return nil, shared.Failure(err)
	}
	return commands, nil
}

// parseCommands mirrors routines.commands' input, z.object({}): any object is accepted, with
// its keys stripped as zod's default object does; a missing input or another type fails.
func parseCommands(raw orpc.Input) *orpc.Error {
	if _, issues := validate.Decode(raw.Raw, nil); issues != nil {
		return validate.Fail(issues)
	}
	return nil
}
