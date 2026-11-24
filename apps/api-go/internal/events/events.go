// Package events is the Go side of the product-event stream: appending an
// event to a thread with its seq allocated under the thread lock, sealing the
// payload like any encrypted column, and notifying committed readers. It is the
// port of packages/db/src/events.ts (appendEvent, appendEventInTransaction,
// insertEventAlone) and event-stream.ts (notifyCommittedEvent).
package events

import (
	"context"
	"errors"
	"fmt"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/wtf8"
	"log/slog"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/contentcrypto"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/effects"
)

// ErrRunHistoryWrite is RunHistoryWriteError: the run may not write this
// thread's history (deleted, cancelled, superseded lease, missing input).
var ErrRunHistoryWrite = errors.New("Run cannot write thread history")

// ErrThreadNotFound is what appendEvent throws for a thread that no longer
// exists when the event names no run.
var ErrThreadNotFound = errors.New("Thread not found")

// Lease is the executing attempt's lease; a superseded attempt cannot write.
type Lease struct {
	Owner string `json:"owner"`
	Fence int32  `json:"fence"`
}

// Input is AppendEventInput.
type Input struct {
	SpaceID  string
	ThreadID string
	BotID    string
	// Type is a ProductEvent type, as the caller validated it.
	Type string
	// Payload is the plaintext product payload.
	Payload map[string]any
	// RunID is empty for events that belong to no run.
	RunID string
	// AllowCancelledRun lets a terminal echo be appended after the run is
	// already cancelled. Every other event stays rejected.
	AllowCancelledRun bool
	// Lease is the executing attempt's lease, when the caller has one.
	Lease *Lease
}

// Event is a stored product event, as appendEvent returns it: the payload is
// the sanitized plaintext the caller passed, not the sealed form.
type Event struct {
	ID            string
	SpaceID       string
	ThreadID      string
	BotID         string
	Seq           int32
	Type          string
	Payload       map[string]any
	RunID         *string
	CreatedAt     time.Time
	FirstResponse bool
}

// Append is appendEvent: one autocommit statement whose CTE allocates the seq,
// checks the run and inserts the sealed event. The thread row lock it takes is
// held only while Postgres runs this statement, so readers trust that events
// commit in seq order without a waiting writer holding the run lock.
//
// tx must carry the caller's row-level-security context (db.Tenant or
// db.System); the caller commits it. For the lock window of the TS path, run
// Append as the last statement of a short transaction.
func Append(ctx context.Context, tx pgx.Tx, ring *contentcrypto.KeyRing, input Input) (Event, error) {
	activity, err := isActivityEvent(input)
	if err != nil {
		return Event{}, err
	}
	if input.Type == "run.cancelled" && input.RunID == "" {
		return Event{}, ErrRunHistoryWrite
	}
	sanitized, ok := SanitizeJSON(input.Payload).(map[string]any)
	if !ok {
		sanitized = map[string]any{}
	}
	rowID := effects.NewID()
	row := map[string]any{
		"id":       rowID,
		"spaceId":  input.SpaceID,
		"threadId": input.ThreadID,
		"botId":    input.BotID,
		"payload":  sanitized,
	}
	sealedRow, err := ring.SealRow(ctx, "Event", row)
	if err != nil {
		return Event{}, err
	}
	payloadJSON, err := wtf8.Marshal(sealedRow["payload"])
	if err != nil {
		return Event{}, fmt.Errorf("seal event payload: %w", err)
	}
	recordsFirstResponse := input.RunID != "" && IsRunResponse(input.Type, input.Payload)

	// $1 is the thread, $2 the run (NULL when the event names none); the run
	// conditions take the next placeholders (runWritable, events.ts:686-719).
	args := []any{input.ThreadID, nullableString(input.RunID)}
	place := func(value any) string {
		args = append(args, value)
		return fmt.Sprintf("$%d", len(args))
	}
	// placeData is a write value: db.Data marks the boundary for every data
	// argument, never for the filters above.
	placeData := func(value any) string {
		args = append(args, db.Data(value)...)
		return fmt.Sprintf("$%d", len(args))
	}
	conditions := []string{}
	if input.RunID != "" {
		if input.Type == "run.cancelled" {
			conditions = append(conditions, "r.status = 'cancelled'")
		} else {
			if input.AllowCancelledRun {
				conditions = append(conditions, "TRUE")
			} else {
				conditions = append(conditions, "r.status <> 'cancelled'")
			}
			if input.Lease != nil {
				conditions = append(conditions, `r."leaseFence" = `+place(input.Lease.Fence)+
					` AND (r."leaseOwner" IS NULL OR r."leaseOwner" = `+place(input.Lease.Owner)+`)`)
			}
			if activity {
				conditions = append(conditions, `r.status = 'running' AND r."leaseOwner" = `+
					place(input.Lease.Owner))
			}
		}
	}
	idArg := placeData(rowID)
	spaceArg := placeData(input.SpaceID)
	threadArg := placeData(input.ThreadID)
	botArg := placeData(input.BotID)
	typeArg := placeData(input.Type)
	payloadArg := placeData(db.JSONText(string(payloadJSON)))

	runWhere := ""
	insertedWhere := "TRUE"
	if input.RunID != "" {
		runWhere = " AND " + strings.Join(conditions, " AND ")
		insertedWhere = "EXISTS (SELECT 1 FROM run)"
	}
	firstWhere := "FALSE"
	if recordsFirstResponse {
		firstWhere = "TRUE"
	}
	query := `
		WITH next AS (
			UPDATE threads SET "nextEventSeq" = "nextEventSeq" + 1
			WHERE id = $1
			RETURNING "nextEventSeq" - 1 AS seq
		),
		run AS (
			SELECT r.id FROM runs r CROSS JOIN next
			WHERE r.id = $2` + runWhere + `
			FOR SHARE OF r
		),
		inserted AS (
			INSERT INTO events (id, "spaceId", "threadId", "botId", seq, type, payload, "runId")
			SELECT ` + idArg + `, ` + spaceArg + `, ` + threadArg + `, ` + botArg + `, next.seq,
				` + typeArg + `, ` + payloadArg + `::jsonb, $2
			FROM next
			WHERE ` + insertedWhere + `
			RETURNING id, seq, "createdAt", "runId"
		),
		first AS (
			UPDATE runs SET "firstResponseAt" = inserted."createdAt"
			FROM inserted
			WHERE ` + firstWhere + ` AND runs.id = inserted."runId" AND runs."firstResponseAt" IS NULL
			RETURNING runs.id
		)
		SELECT inserted.id, inserted.seq, inserted."createdAt", inserted."runId",
			EXISTS (SELECT 1 FROM first) AS "firstResponse"
		FROM inserted`
	var event Event
	var runID *string
	//writeaudit:dynamic the CTE is built in branches; placeData wraps every payload, place only filters
	err = tx.QueryRow(ctx, query, args...).Scan(&event.ID, &event.Seq, &event.CreatedAt,
		&runID, &event.FirstResponse)
	if errors.Is(err, pgx.ErrNoRows) {
		if input.RunID != "" {
			return Event{}, ErrRunHistoryWrite
		}
		return Event{}, ErrThreadNotFound
	}
	if err != nil {
		return Event{}, err
	}
	event.SpaceID, event.ThreadID, event.BotID = input.SpaceID, input.ThreadID, input.BotID
	event.Type, event.Payload, event.RunID = input.Type, sanitized, runID
	return event, nil
}

// AppendAlone is appendEvent's standalone shape: the same one-statement CTE,
// run in its own transaction on database (a system context, like the server's
// event appends), committed even when the run check inserted nothing. A rejected
// run therefore still consumes its seq, exactly as the TS statement's autocommit
// does (events.ts:663-733); the thread row lock is held from the UPDATE to the
// commit, so events still commit in seq order and no caller work is committed.
// Use Append to join a caller's transaction: a rejection there rolls the seq back
// with that transaction instead.
func AppendAlone(ctx context.Context, database *db.DB, ring *contentcrypto.KeyRing, input Input) (Event, error) {
	var event Event
	var appendErr error
	err := database.System(ctx, "append a product event", func(tx pgx.Tx) error {
		event, appendErr = Append(ctx, tx, ring, input)
		if errors.Is(appendErr, ErrRunHistoryWrite) || errors.Is(appendErr, ErrThreadNotFound) {
			// The thread UPDATE ran inside this transaction; commit it so the
			// allocated seq is used exactly as TS's autocommit statement does.
			return nil
		}
		return appendErr
	})
	if err != nil {
		return Event{}, err
	}
	if appendErr != nil {
		return Event{}, appendErr
	}
	return event, nil
}

// AppendTx is appendEventInTransaction: the seq is allocated with a thread
// UPDATE, the run's writability is asserted with SELECTs, and the event is
// inserted, all inside the caller's transaction.
func AppendTx(ctx context.Context, tx pgx.Tx, ring *contentcrypto.KeyRing, input Input) (Event, error) {
	activity, err := isActivityEvent(input)
	if err != nil {
		return Event{}, err
	}
	var nextSeq int32
	err = tx.QueryRow(ctx,
		`UPDATE threads SET "nextEventSeq" = "nextEventSeq" + 1 WHERE id = $1 RETURNING "nextEventSeq"`,
		input.ThreadID).Scan(&nextSeq)
	if errors.Is(err, pgx.ErrNoRows) {
		if input.RunID != "" {
			return Event{}, ErrRunHistoryWrite
		}
		return Event{}, ErrThreadNotFound
	}
	if err != nil {
		return Event{}, err
	}
	var firstResponseAt *time.Time
	if input.Type == "run.cancelled" {
		if err := assertRunIsCancelled(ctx, tx, input.RunID); err != nil {
			return Event{}, err
		}
	} else {
		run, err := assertRunCanWriteHistory(ctx, tx, input.RunID, input.AllowCancelledRun, input.Lease)
		if err != nil {
			return Event{}, err
		}
		if activity && (!run.found || run.status != "running" ||
			run.leaseOwner == nil || *run.leaseOwner != input.Lease.Owner) {
			return Event{}, ErrRunHistoryWrite
		}
		firstResponseAt = run.firstResponseAt
	}
	sanitized, ok := SanitizeJSON(input.Payload).(map[string]any)
	if !ok {
		sanitized = map[string]any{}
	}
	rowID := effects.NewID()
	row := map[string]any{
		"id":       rowID,
		"spaceId":  input.SpaceID,
		"threadId": input.ThreadID,
		"botId":    input.BotID,
		"payload":  sanitized,
	}
	sealedRow, err := ring.SealRow(ctx, "Event", row)
	if err != nil {
		return Event{}, err
	}
	payloadJSON, err := wtf8.Marshal(sealedRow["payload"])
	if err != nil {
		return Event{}, fmt.Errorf("seal event payload: %w", err)
	}
	event := Event{
		SpaceID: input.SpaceID, ThreadID: input.ThreadID, BotID: input.BotID,
		Seq: nextSeq - 1, Type: input.Type, Payload: sanitized,
	}
	if input.RunID != "" {
		runID := input.RunID
		event.RunID = &runID
	}
	err = tx.QueryRow(ctx,
		`INSERT INTO events (id, "spaceId", "threadId", "botId", seq, type, payload, "runId")
		 VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
		 RETURNING id, "createdAt"`,
		db.Data(rowID, input.SpaceID, input.ThreadID, input.BotID, event.Seq, input.Type,
			db.JSONText(string(payloadJSON)), nullableString(input.RunID))...).Scan(&event.ID, &event.CreatedAt)
	if err != nil {
		return Event{}, err
	}
	if input.RunID != "" && firstResponseAt == nil && IsRunResponse(input.Type, input.Payload) {
		tag, err := tx.Exec(ctx,
			`UPDATE runs SET "firstResponseAt" = $2 WHERE id = $1 AND "firstResponseAt" IS NULL`,
			append([]any{input.RunID}, db.Data(event.CreatedAt)...)...)
		if err != nil {
			return Event{}, err
		}
		event.FirstResponse = tag.RowsAffected() == 1
	}
	return event, nil
}

// runRow is the subset of a run the history assertions read.
type runRow struct {
	found           bool
	status          string
	startedAt       *time.Time
	firstResponseAt *time.Time
	userID          string
	leaseOwner      *string
	leaseFence      int32
}

// assertRunCanWriteHistory is assertRunCanWriteHistory
// (packages/db/src/messages.ts:210-248): the run exists and is writable, and a
// lease the caller presented still owns it. A lease takes a SHARE lock first,
// so a concurrent re-lease or cancellation cannot slip between the check and
// the write.
func assertRunCanWriteHistory(ctx context.Context, tx pgx.Tx, runID string, allowCancelled bool, lease *Lease) (runRow, error) {
	if runID == "" {
		return runRow{}, nil
	}
	if lease != nil {
		if _, err := tx.Exec(ctx, `SELECT id FROM runs WHERE id = $1 FOR SHARE`, runID); err != nil {
			return runRow{}, err
		}
	}
	var run runRow
	err := tx.QueryRow(ctx, `SELECT status, "startedAt", "firstResponseAt", "userId",
			"leaseOwner", "leaseFence" FROM runs WHERE id = $1`, runID).
		Scan(&run.status, &run.startedAt, &run.firstResponseAt, &run.userID,
			&run.leaseOwner, &run.leaseFence)
	if errors.Is(err, pgx.ErrNoRows) {
		return runRow{}, ErrRunHistoryWrite
	}
	if err != nil {
		return runRow{}, err
	}
	run.found = true
	if run.status == "cancelled" && !allowCancelled {
		return runRow{}, ErrRunHistoryWrite
	}
	if lease != nil && (run.leaseFence != lease.Fence ||
		(run.leaseOwner != nil && *run.leaseOwner != lease.Owner)) {
		return runRow{}, ErrRunHistoryWrite
	}
	return run, nil
}

// assertRunIsCancelled is assertRunIsCancelled: the row must already read
// cancelled, so a run.cancelled event never announces a cancellation nothing
// committed (messages.ts:256-268).
func assertRunIsCancelled(ctx context.Context, tx pgx.Tx, runID string) error {
	if runID == "" {
		return ErrRunHistoryWrite
	}
	var status string
	err := tx.QueryRow(ctx, `SELECT status FROM runs WHERE id = $1`, runID).Scan(&status)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrRunHistoryWrite
	}
	if err != nil {
		return err
	}
	if status != "cancelled" {
		return ErrRunHistoryWrite
	}
	return nil
}

func nullableString(value string) any {
	if value == "" {
		return nil
	}
	return value
}

// NotifyCommitted is notifyCommittedEvent (event-stream.ts:14-26): a committed
// event tells thread subscribers the new cursor and, when the caller names it,
// its type, then a run's first response is logged once with its timing. A
// notification failure is swallowed: the event is durable and subscribers
// recover it from their persisted cursor.
func NotifyCommitted(ctx context.Context, publisher Publisher, logger *slog.Logger,
	database *db.DB, threadID string, seq int32, firstResponseRunID, eventType string) {
	if publisher != nil {
		_ = publisher.PublishThread(ctx, threadID, seq, eventType)
	}
	if firstResponseRunID == "" || database == nil {
		return
	}
	if logger == nil {
		logger = slog.Default()
	}
	fields := ReadRunTimingFields(ctx, database, firstResponseRunID)
	attributes := []any{"run.id", firstResponseRunID}
	for _, name := range timingFieldOrder {
		if value, ok := fields[name]; ok {
			attributes = append(attributes, name, value)
		}
	}
	logger.Info("run.first_response", attributes...)
}
