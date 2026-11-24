package routines

import (
	"context"
	"encoding/json"
	"errors"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/orpc"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/shared"
)

// RoutineRun is the wire shape of RoutineRunSchema (packages/contracts/src/runs/runs.ts:92).
// Error is a JSON literal because a clamped diagnostic can end inside a surrogate pair.
type RoutineRun struct {
	ID          string           `json:"id"`
	BotID       string           `json:"botId"`
	GroupID     *string          `json:"groupId"`
	Status      string           `json:"status"`
	Error       *json.RawMessage `json:"error"`
	CreatedAt   string           `json:"createdAt"`
	StartedAt   *string          `json:"startedAt"`
	LateSince   *string          `json:"lateSince"`
	CompletedAt *string          `json:"completedAt"`
	MessageID   *string          `json:"messageId"`
}

// RoutineHistory is the wire shape of RoutineHistorySchema (runs.ts:112).
type RoutineHistory struct {
	Runs       []RoutineRun `json:"runs"`
	NextCursor *CursorOut   `json:"nextCursor"`
}

// CursorOut is RoutineRunCursorSchema on the wire.
type CursorOut struct {
	ID        string `json:"id"`
	CreatedAt string `json:"createdAt"`
}

var errHistoryNotFound = orpc.NotFound("Not Found")

// runStatuses is RunStatus (packages/contracts/src/ids.ts:15).
var runStatuses = []string{
	"queued", "leased", "running", "waiting_input", "waiting_takeover", "completed", "failed", "cancelled",
}

// History implements routines.history: listRoutineRuns (apps/api/src/routines/routine-runs.ts:8).
func History(ctx context.Context, database *db.DB, actor db.Actor, raw orpc.Input) (any, *orpc.Error) {
	input, failure := parseHistory(raw)
	if failure != nil {
		return nil, failure
	}
	before, ok := cursorInstant(input.Before)
	if !ok {
		// An ISO datetime Zod accepted but Date cannot hold is an Invalid Date Prisma refuses.
		return nil, orpc.Internal()
	}
	result := RoutineHistory{Runs: []RoutineRun{}}
	err := database.Tenant(ctx, actor, func(tx pgx.Tx) error {
		result = RoutineHistory{Runs: []RoutineRun{}}
		var botID string
		err := tx.QueryRow(ctx, `SELECT r."botId" FROM routines r
			JOIN bots b ON b.id = r."botId"
			WHERE r.id = $1 AND r."spaceId" = $2 AND b."archivedAt" IS NULL`,
			input.RoutineID, actor.SpaceID).Scan(&botID)
		if errors.Is(err, pgx.ErrNoRows) {
			return errHistoryNotFound
		}
		if err != nil {
			return err
		}
		rows, err := loadRuns(ctx, tx, actor, input, botID, before)
		if err != nil {
			return err
		}
		if len(rows) == 0 {
			return nil
		}
		// runs take limit + 1: the extra row only says a next page exists.
		page := rows
		if len(page) > input.Limit {
			page = page[:input.Limit]
		}
		replies, err := firstReplies(ctx, tx, actor, page)
		if err != nil {
			return err
		}
		runs := make([]RoutineRun, len(page))
		for index, row := range page {
			runs[index] = RoutineRun{
				ID:          row.ID,
				BotID:       row.BotID,
				GroupID:     row.GroupID,
				Status:      row.Status,
				Error:       runFailureError(row.Status, row.Error),
				CreatedAt:   shared.ISOString(row.CreatedAt),
				StartedAt:   isoOptional(row.StartedAt),
				LateSince:   isoOptional(row.LateSince),
				CompletedAt: isoOptional(row.CompletedAt),
				MessageID:   replies[row.ID],
			}
		}
		result.Runs = runs
		if len(rows) > input.Limit && len(runs) > 0 {
			last := runs[len(runs)-1]
			result.NextCursor = &CursorOut{ID: last.ID, CreatedAt: last.CreatedAt}
		}
		return nil
	})
	if err != nil {
		return nil, shared.Failure(err)
	}
	for _, run := range result.Runs {
		if !run.valid() {
			return nil, shared.OutputInvalid()
		}
	}
	return result, nil
}

// cursorInstant is `new Date(before.createdAt)` for the validated cursor.
func cursorInstant(before *Cursor) (time.Time, bool) {
	if before == nil {
		return time.Time{}, true
	}
	return shared.ParseDate(before.CreatedAt)
}

// runRow is the selected run and its thread's group.
type runRow struct {
	ID          string
	BotID       string
	GroupID     *string
	Status      string
	Error       *string
	LateSince   *time.Time
	CreatedAt   time.Time
	StartedAt   *time.Time
	CompletedAt *time.Time
}

// loadRuns is the run.findMany in listRoutineRuns: newest first, one page plus the row that
// says another page follows.
func loadRuns(ctx context.Context, tx pgx.Tx, actor db.Actor, input HistoryInput, botID string, before time.Time) ([]runRow, error) {
	query := `SELECT r.id, r."botId", t."groupId", r.status, r.error, r."lateSince", r."createdAt",
		r."startedAt", r."completedAt"
		FROM runs r JOIN threads t ON t.id = r."threadId"
		WHERE r."routineId" = $1 AND r."botId" = $2 AND r."spaceId" = $3`
	args := []any{input.RoutineID, botID, actor.SpaceID}
	if input.Before != nil {
		// The same instant and id tie-break Prisma's cursor where-clause uses.
		query += ` AND (r."createdAt" < $4 OR (r."createdAt" = $4 AND r.id < $5))`
		args = append(args, before, input.Before.ID)
	}
	query += ` ORDER BY r."createdAt" DESC, r.id DESC LIMIT ` + strconv.Itoa(input.Limit+1)
	// writeaudit:dynamic read: the cursor/limit fragments are fixed; args are filters
	rows, err := tx.Query(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	loaded := []runRow{}
	for rows.Next() {
		var row runRow
		if err := rows.Scan(&row.ID, &row.BotID, &row.GroupID, &row.Status, &row.Error,
			&row.LateSince, &row.CreatedAt, &row.StartedAt, &row.CompletedAt); err != nil {
			return nil, err
		}
		loaded = append(loaded, row)
	}
	return loaded, rows.Err()
}

// firstReplies is listRoutineRuns' raw query: the first message each run posted, because a
// routine run can finish silently and a chat link opens that message.
func firstReplies(ctx context.Context, tx pgx.Tx, actor db.Actor, page []runRow) (map[string]*string, error) {
	ids := make([]string, len(page))
	for index, row := range page {
		ids[index] = row.ID
	}
	rows, err := tx.Query(ctx, `SELECT DISTINCT ON (m."runId") m.id, m."runId"
		FROM messages m
		INNER JOIN runs r ON r.id = m."runId" AND r."threadId" = m."threadId"
		INNER JOIN threads t ON t.id = m."threadId"
		WHERE r.id = ANY($1) AND r."spaceId" = $2 AND t."spaceId" = $2 AND m.role = 'bot'
		ORDER BY m."runId", m.seq`, ids, actor.SpaceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	replies := map[string]*string{}
	for rows.Next() {
		var id, runID string
		if err := rows.Scan(&id, &runID); err != nil {
			return nil, err
		}
		messageID := id
		replies[runID] = &messageID
	}
	return replies, rows.Err()
}

// valid is the part of RoutineRunSchema a stored row can break: its enum and its ids.
func (r RoutineRun) valid() bool {
	if r.ID == "" || r.BotID == "" {
		return false
	}
	if r.GroupID != nil && *r.GroupID == "" {
		return false
	}
	if r.MessageID != nil && *r.MessageID == "" {
		return false
	}
	return contains(runStatuses, r.Status)
}
