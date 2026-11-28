package routines

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/events"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/orpc"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/shared"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/validate"
)

// errSetPrepareNotFound is the answer for a routine outside the caller's Space or on an
// archived bot: the lookup routines.update makes (`new ORPCError("NOT_FOUND")`).
var errSetPrepareNotFound = orpc.NotFound("Not Found")

// errSetPrepareOwner refuses a member who is not the routine's owner: a prepare command runs
// with the owner's accounts and tools, so only the owner may name it.
var errSetPrepareOwner = orpc.Forbidden("Only the routine's owner can change what it runs first.")

// prepareInput is a caller's RoutinePrepareSchema: the saved command's name and its arguments,
// a record that is `{}` when the caller passed none.
type prepareInput struct {
	Command string
	Args    map[string]any
}

// setPrepareInput is routines.setPrepare's input; a nil Prepare clears the routine's command.
type setPrepareInput struct {
	RoutineID string
	Prepare   *prepareInput
}

// parseSetPrepare mirrors z.object({ routineId: Id, prepare: RoutinePrepareSchema.nullable() }).
func parseSetPrepare(raw orpc.Input) (setPrepareInput, *orpc.Error) {
	var input setPrepareInput
	object, issues := validate.Decode(raw.Raw, nil)
	if issues != nil {
		return input, validate.Fail(issues)
	}
	var found []validate.Issue
	routineID, problems := validate.String(validate.Path{"routineId"}, object.Field("routineId"), validate.StringRules{Min: 1})
	found = append(found, problems...)
	path := validate.Path{"prepare"}
	value, present := object.Get("prepare")
	switch {
	case !present:
		// The key is required: z.object reads a missing one as undefined.
		found = append(found, validate.TypeIssue("object", "undefined", path))
	case value != nil:
		prepare, problems := parsePrepareInput(value, path)
		found = append(found, problems...)
		input.Prepare = prepare
	}
	if found != nil {
		return setPrepareInput{}, validate.Fail(found)
	}
	input.RoutineID = routineID
	return input, nil
}

// parsePrepareInput is RoutinePrepareSchema: a command matching CODE_COMMAND_NAME_PATTERN and
// an args record whose values are JSON. Unknown keys are stripped, as zod's default object
// does, and a missing args is {}.
func parsePrepareInput(value any, path validate.Path) (*prepareInput, []validate.Issue) {
	inner, problems := validate.AsObject(value, path)
	if problems != nil {
		return nil, problems
	}
	var found []validate.Issue
	commandPath := path.With("command")
	command, problems := validate.String(commandPath, inner.Field("command"), validate.StringRules{})
	found = append(found, problems...)
	// zod runs the regex only on a value that passed the string check.
	if problems == nil && !prepareCommandPattern.MatchString(command) {
		found = append(found, validate.Issue{
			"origin": "string", "code": "invalid_format", "format": "regex",
			"pattern": prepareCommandSource, "path": commandPath.Raw(),
			"message": "Invalid string: must match pattern " + prepareCommandSource,
		})
	}
	args := map[string]any{}
	if value, present := inner.Get("args"); present {
		record, ok := value.(*validate.Object)
		if !ok {
			// z.record's type check names "record", not "object".
			found = append(found, validate.TypeIssue("record", validate.JSType(value), path.With("args")))
		} else {
			args = inputRecord(record)
		}
	}
	if found != nil {
		return nil, found
	}
	return &prepareInput{Command: command, Args: args}, nil
}

// inputRecord is a caller's record as the column stores it: objects become maps, a __proto__
// key is dropped at every level (zod's record drops it), and numbers stay json.Number until
// db.JSONText prints them as JSON.stringify does.
func inputRecord(object *validate.Object) map[string]any {
	return recordValue(object).(map[string]any)
}

// prepareDocument is the column value RoutinePrepareSchema writes: `{command, args}`, or nil
// (SQL NULL) to clear it. db.JSON sanitizes the text and prints numbers as JSON.stringify
// does, because the TypeScript API writes zod's parsed JS value through Prisma.
func prepareDocument(prepare *prepareInput) any {
	if prepare == nil {
		return nil
	}
	return db.JSON(map[string]any{"command": prepare.Command, "args": prepare.Args})
}

// SetPrepare implements routines.setPrepare: name the saved command this routine runs before
// its model, or clear it. The command must exist in the caller's Space, and only the routine's
// owner may change it. The answer is the updated routine; the bot's chat hears routine.updated
// after the write commits, as routines.update's does.
func SetPrepare(ctx context.Context, database *db.DB, deployment shared.Deployment, actor db.Actor, raw orpc.Input) (any, *orpc.Error) {
	input, failure := parseSetPrepare(raw)
	if failure != nil {
		return nil, failure
	}
	// The column stores RoutinePrepareSchema's parsed value; SQL NULL clears it.
	document := prepareDocument(input.Prepare)
	var mapped Routine
	var botID, threadID string
	err := database.Tenant(ctx, actor, func(tx pgx.Tx) error {
		var ownerID string
		err := tx.QueryRow(ctx, `SELECT r."userId", r."botId" FROM routines r
			JOIN bots b ON b.id = r."botId"
			WHERE r.id = $1 AND r."spaceId" = $2 AND b."archivedAt" IS NULL`,
			input.RoutineID, actor.SpaceID).Scan(&ownerID, &botID)
		if errors.Is(err, pgx.ErrNoRows) {
			return errSetPrepareNotFound
		}
		if err != nil {
			return err
		}
		if ownerID != actor.UserID {
			return errSetPrepareOwner
		}
		if input.Prepare != nil {
			var name string
			err := tx.QueryRow(ctx, `SELECT name FROM code_commands
				WHERE "spaceId" = $1 AND name = $2`, actor.SpaceID, input.Prepare.Command).Scan(&name)
			if errors.Is(err, pgx.ErrNoRows) {
				return orpc.BadRequest("There is no saved command named " + input.Prepare.Command + ".")
			}
			if err != nil {
				return err
			}
		}
		// repos.getBot's thread: one per bot, and the event needs its id. A bot that vanished
		// or was archived between the two reads is repos.getBot's IsolationError.
		var thread *string
		err = tx.QueryRow(ctx, `SELECT t.id FROM bots b
			LEFT JOIN threads t ON t."botId" = b.id
			WHERE b.id = $1 AND b."spaceId" = $2 AND b."archivedAt" IS NULL
			LIMIT 1`, botID, actor.SpaceID).Scan(&thread)
		if errors.Is(err, pgx.ErrNoRows) {
			return shared.NotFound
		}
		if err != nil {
			return err
		}
		if thread != nil {
			threadID = *thread
		}
		now := time.Now().UTC().Truncate(time.Millisecond)
		arguments := append([]any{input.RoutineID}, db.Data(document, now)...)
		// writeaudit:dynamic the dynamic fragment is the fixed RETURNING list; SET payloads are db.Data
		row, err := scanRoutine(tx.QueryRow(ctx, `UPDATE routines SET prepare = $2::jsonb, "updatedAt" = $3
			WHERE id = $1 RETURNING `+routineColumns, arguments...))
		if errors.Is(err, pgx.ErrNoRows) {
			return errSetPrepareNotFound
		}
		if err != nil {
			return err
		}
		mapped = mapRoutine(row)
		return nil
	})
	if err != nil {
		return nil, shared.Failure(err)
	}
	if threadID != "" {
		ring := deployment.Content
		if ring == nil {
			return nil, shared.Failure(errors.New("encryption is not configured"))
		}
		// appendEvent is its own statement after the write committed, as deps.events.append is.
		event, err := events.AppendAlone(ctx, database, ring, events.Input{
			SpaceID: actor.SpaceID, ThreadID: threadID, BotID: botID,
			Type:    "routine.updated",
			Payload: map[string]any{"routineId": mapped.ID, "active": mapped.Active},
		})
		if err != nil {
			return nil, shared.Failure(err)
		}
		events.NotifyCommitted(ctx, deployment.Events, nil, nil, event.ThreadID, event.Seq, "", event.Type)
	}
	if !mapped.valid() {
		return nil, shared.OutputInvalid()
	}
	return mapped, nil
}
