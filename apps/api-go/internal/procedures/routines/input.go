package routines

import (
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/orpc"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/validate"
)

// mentionBatchMax is ROUTINE_MENTION_BATCH_MAX (packages/contracts/src/routines/routine.ts:43).
const mentionBatchMax = 100

// historyPageSize is ROUTINE_HISTORY_PAGE_SIZE (packages/contracts/src/runs/runs.ts:110) and
// the default listRoutineRuns gives an omitted limit.
const historyPageSize = 20

// Cursor is RoutineRunCursorSchema: a run's id and creation instant.
type Cursor struct {
	ID        string
	CreatedAt string
}

// HistoryInput is routines.history's input.
type HistoryInput struct {
	RoutineID string
	Before    *Cursor
	Limit     int
}

// parseBotID mirrors z.object({ botId: Id }) (packages/contracts/src/rpc/inputs.ts:4).
func parseBotID(raw orpc.Input) (string, *orpc.Error) {
	object, issues := validate.Decode(raw.Raw, nil)
	if issues != nil {
		return "", validate.Fail(issues)
	}
	botID, problems := validate.String(validate.Path{"botId"}, object.Field("botId"), validate.StringRules{Min: 1})
	if problems != nil {
		return "", validate.Fail(problems)
	}
	return botID, nil
}

// parseMentions mirrors z.object({ botIds: z.array(Id).min(1).max(100) }).
func parseMentions(raw orpc.Input) ([]string, *orpc.Error) {
	object, issues := validate.Decode(raw.Raw, nil)
	if issues != nil {
		return nil, validate.Fail(issues)
	}
	path := validate.Path{"botIds"}
	items, problems := validate.AsArray(path, object.Field("botIds"))
	if problems != nil {
		return nil, validate.Fail(problems)
	}
	var found []validate.Issue
	ids := make([]string, len(items))
	for index, item := range items {
		text, problems := validate.String(path.With(index), item, validate.StringRules{Min: 1})
		ids[index] = text
		found = append(found, problems...)
	}
	// zod checks the items first, then the length.
	found = append(found, validate.ArrayBounds(path, len(items), 1, mentionBatchMax)...)
	if found != nil {
		return nil, validate.Fail(found)
	}
	return ids, nil
}

// parseHistory mirrors
//
//	z.object({
//	  routineId: Id,
//	  before: z.object({ id: Id, createdAt: IsoDate }).optional(),
//	  limit: z.number().int().min(1).max(20).optional(),
//	}).
func parseHistory(raw orpc.Input) (HistoryInput, *orpc.Error) {
	input := HistoryInput{Limit: historyPageSize}
	object, issues := validate.Decode(raw.Raw, nil)
	if issues != nil {
		return input, validate.Fail(issues)
	}
	var found []validate.Issue
	routineID, problems := validate.String(validate.Path{"routineId"}, object.Field("routineId"), validate.StringRules{Min: 1})
	found = append(found, problems...)
	if value, present := object.Get("before"); present {
		path := validate.Path{"before"}
		before, problems := validate.AsObject(value, path)
		found = append(found, problems...)
		if problems == nil {
			id, problems := validate.String(path.With("id"), before.Field("id"), validate.StringRules{Min: 1})
			found = append(found, problems...)
			createdAt, problems := validate.ISODateTime(path.With("createdAt"), before.Field("createdAt"), false)
			found = append(found, problems...)
			if problems == nil {
				input.Before = &Cursor{ID: id, CreatedAt: *createdAt}
			}
		}
	}
	if value, present := object.Get("limit"); present {
		limit, problems := validate.Integer(validate.Path{"limit"}, value,
			validate.NumberRules{Min: validate.Float(1), Max: validate.Float(historyPageSize)})
		found = append(found, problems...)
		if problems == nil {
			input.Limit = int(limit)
		}
	}
	if found != nil {
		return input, validate.Fail(found)
	}
	input.RoutineID = routineID
	return input, nil
}
