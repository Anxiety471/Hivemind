package runs

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/contentcrypto"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/events"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/secretstore"
)

// Cancelled is one run whose status this turn moved to cancelled.
type Cancelled struct {
	ID              string
	TaskID          string
	UserID          string
	SpaceID         string
	ThreadID        string
	BotID           string
	Trigger         string
	SourceMessageID *string
	RoutineID       *string
	RoutineName     *string
}

// Canceller performs the run-side cancellation each procedure needs. Ring is
// the content key ring the run.cancelled events seal with and the approval
// cards open with; it is required. A deployment with content encryption off
// builds a pass-through ring (contentcrypto.NewKeyRing(nil, nil,
// contentcrypto.KeyRingOptions{})), as the secret store's tests do: TypeScript
// always has a cipher, so a nil ring is a wiring mistake, not an
// encryption-off deployment, and would silently skip sealed blocks.
// Vault, when set, announces the run-only secrets the cancellation drops, as
// withSecretPersistence does for a Prisma delete (Infrastructure C).
type Canceller struct {
	Ring  *contentcrypto.KeyRing
	Vault *secretstore.Persistence
}

// errRingRequired is the cancel refusing a nil ring (see Canceller.Ring).
var errRingRequired = errors.New("runs: cancels need the content key ring (a pass-through ring when content encryption is off)")

func (c Canceller) requireRing() error {
	if c.Ring == nil {
		return errRingRequired
	}
	return nil
}

const (
	// RunTurnCheckpointKind is RUN_TURN_CHECKPOINT_KIND (run-turn-checkpoint.ts:8).
	RunTurnCheckpointKind = "runtime_checkpoint"
	// StoppedByMessageNote is STOPPED_BY_MESSAGE_NOTE (thread-stop.ts:30).
	StoppedByMessageNote = "Stopped. Anything already done stays done."
)

// cancelColumns is the row each caller reads after a cancel.
const cancelColumns = `id, "taskId", "userId", "spaceId", "threadId", "botId", trigger,
	"sourceMessageId", "routineId"`

// CancelActive is cancelRunsInTransaction (packages/db/src/runs/cancel-runs.ts:9):
// cancel those of these runs that are still active, drop what they kept for
// resuming, cancel their running attempts and their tasks. A run that finished
// after the caller's read keeps its outcome and is not returned.
//
// Callers cancel under the thread row lock when they touch a conversation, so a
// concurrent clear sees the same runs (thread-then-run lock order).
func (c Canceller) CancelActive(
	ctx context.Context,
	tx pgx.Tx,
	ids []string,
	at time.Time,
	state *secretstore.State,
) ([]Cancelled, error) {
	if len(ids) == 0 {
		return nil, nil
	}
	if err := c.requireRing(); err != nil {
		return nil, err
	}
	at = now(at)
	rows, err := tx.Query(ctx, `
		UPDATE runs SET status = 'cancelled', "completedAt" = $2,
			"leaseOwner" = NULL, "leaseExpiresAt" = NULL, "updatedAt" = now()
		WHERE id = ANY($1::text[]) AND status = ANY($3::text[])
		RETURNING `+cancelColumns, ids, at, ActiveStatuses)
	if err != nil {
		return nil, fmt.Errorf("cancel runs: %w", err)
	}
	cancelled := make([]Cancelled, 0, len(ids))
	byID := make(map[string]Cancelled, len(ids))
	for rows.Next() {
		run, err := scanCancelled(rows)
		if err != nil {
			rows.Close()
			return nil, err
		}
		byID[run.ID] = run
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	// TypeScript returns its input rows in input order; keep that for event seqs.
	for _, id := range ids {
		if run, ok := byID[id]; ok {
			cancelled = append(cancelled, run)
		}
	}
	if len(cancelled) == 0 {
		return nil, nil
	}
	if err := loadRoutineNames(ctx, tx, cancelled); err != nil {
		return nil, err
	}
	cancelledIDs := idsOf(cancelled)
	if err := c.clearEndedState(ctx, tx, cancelledIDs, state); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `
		UPDATE attempts SET status = 'cancelled', "finishedAt" = $2
		WHERE "runId" = ANY($1::text[]) AND status = 'running'`, cancelledIDs, at); err != nil {
		return nil, fmt.Errorf("cancel attempts: %w", err)
	}
	taskIDs := taskIDsOf(cancelled)
	if _, err := tx.Exec(ctx, `
		UPDATE tasks SET status = 'cancelled', "updatedAt" = now()
		WHERE id = ANY($1::text[])`, taskIDs); err != nil {
		return nil, fmt.Errorf("cancel tasks: %w", err)
	}
	return cancelled, nil
}

// CancelConversation is cancelThreadRuns (apps/api/src/threads/thread-stop.ts:63):
// under the thread row lock, cancel the conversation's active runs and the
// background helpers it started (or only the helper behind helperMessageID),
// drop their resumable state, clear pending steering, append one run.cancelled
// event per run in this thread, and create the stop notes through WriteNote.
//
// It stops before sandbox teardown: Leases/Computers are the teardown
// coordinates a procedure snapshots before commit (finishThreadStop). EventSeq
// is the cursor to notify with after commit.
//
// The caller owns the transaction and its budget: run it through
// CancelConversationFor (or ThreadLockTransaction) so the thread-lock wait is
// bounded as in TypeScript.
func (c Canceller) CancelConversation(
	ctx context.Context,
	tx pgx.Tx,
	target ConversationTarget,
	at time.Time,
	state *secretstore.State,
) (ConversationCancel, error) {
	// Thread row first, then run rows: the order clearThread/finalizeRun use, so
	// a concurrent clear cannot deadlock here (thread-stop.ts:78).
	if err := LockThread(ctx, tx, target.ThreadID); err != nil {
		return ConversationCancel{}, err
	}
	return c.cancelConversationLocked(ctx, tx, target, at, state)
}

// CancelConversationFor is CancelConversation in the tenant transaction
// THREAD_LOCK_TRANSACTION_OPTIONS describes: the thread row first, the whole
// body inside the 20 s budget, and ErrLockTimeout (a generic 500) when the wait
// runs out. A procedure that already owns the transaction calls
// CancelConversation inside ThreadLockTransaction instead.
func (c Canceller) CancelConversationFor(
	ctx context.Context,
	database *db.DB,
	actor db.Actor,
	target ConversationTarget,
	at time.Time,
	state *secretstore.State,
) (ConversationCancel, error) {
	var result ConversationCancel
	err := ThreadLockTransaction(ctx, database, actor, target.ThreadID,
		func(ctx context.Context, tx pgx.Tx) error {
			var err error
			result, err = c.cancelConversationLocked(ctx, tx, target, at, state)
			return err
		})
	if err != nil {
		return ConversationCancel{}, err
	}
	return result, nil
}

// cancelConversationLocked is the body of cancelThreadRuns under the thread row
// lock the caller took.
func (c Canceller) cancelConversationLocked(
	ctx context.Context,
	tx pgx.Tx,
	target ConversationTarget,
	at time.Time,
	state *secretstore.State,
) (ConversationCancel, error) {
	if err := c.requireRing(); err != nil {
		return ConversationCancel{}, err
	}
	at = now(at)
	var helper any
	if target.HelperMessageID != nil {
		helper = *target.HelperMessageID
	}
	rows, err := tx.Query(ctx, `
		WITH scoped AS (
			SELECT r.id
			FROM runs r
			LEFT JOIN messages sm ON sm.id = r."sourceMessageId"
			WHERE r.status = ANY($2::text[])
			  AND (
				($3::text IS NULL AND r."threadId" = $1)
				OR (r.trigger = 'helper' AND sm."threadId" = $1
					AND ($3::text IS NULL OR sm.id = $3::text))
				OR (r.trigger = 'helper' AND EXISTS (
					SELECT 1
					FROM threads ht
					JOIN runs hr ON hr."threadId" = ht.id AND hr.trigger = 'helper'
					JOIN messages hm ON hm.id = hr."sourceMessageId"
					WHERE hm."threadId" = $1
					  AND ($3::text IS NULL OR hm.id = $3::text)
					  AND ht.id = sm."threadId"))
			  )
		)
		UPDATE runs SET status = 'cancelled', "completedAt" = $4, "updatedAt" = now()
		WHERE id IN (SELECT id FROM scoped)
		RETURNING `+cancelColumns, target.ThreadID, ActiveStatuses, helper, at)
	if err != nil {
		return ConversationCancel{}, fmt.Errorf("cancel conversation runs: %w", err)
	}
	var result ConversationCancel
	for rows.Next() {
		run, err := scanCancelled(rows)
		if err != nil {
			rows.Close()
			return ConversationCancel{}, err
		}
		result.Runs = append(result.Runs, run)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return ConversationCancel{}, err
	}
	if err := loadRoutineNames(ctx, tx, result.Runs); err != nil {
		return ConversationCancel{}, err
	}
	ids := idsOf(result.Runs)
	if err := c.clearEndedState(ctx, tx, ids, state); err != nil {
		return ConversationCancel{}, err
	}
	if target.HelperMessageID == nil {
		if _, err := tx.Exec(ctx, `
			DELETE FROM steering_messages st USING messages m
			WHERE st."messageId" = m.id AND m."threadId" = $1 AND st."botId" = ANY($2::text[])`,
			target.ThreadID, target.BotIDs); err != nil {
			return ConversationCancel{}, fmt.Errorf("clear steering: %w", err)
		}
	}
	// Snapshot teardown coordinates before commit: once cancellation is visible a
	// worker can release its lease immediately (thread-stop.ts:100-112).
	if len(ids) > 0 {
		leaseRows, err := tx.Query(ctx, `
			SELECT "computerId", "botId", "runId", fence
			FROM computer_execution_leases WHERE "runId" = ANY($1::text[])`, ids)
		if err != nil {
			return ConversationCancel{}, err
		}
		for leaseRows.Next() {
			var lease Lease
			if err := leaseRows.Scan(&lease.ComputerID, &lease.BotID, &lease.RunID, &lease.Fence); err != nil {
				leaseRows.Close()
				return ConversationCancel{}, err
			}
			result.Leases = append(result.Leases, lease)
		}
		leaseRows.Close()
		if err := leaseRows.Err(); err != nil {
			return ConversationCancel{}, err
		}
		computerIDs := make([]string, 0, len(result.Leases))
		for _, lease := range result.Leases {
			computerIDs = append(computerIDs, lease.ComputerID)
		}
		if len(computerIDs) > 0 {
			computerRows, err := tx.Query(ctx, `
				SELECT id, "homeKey", kind, "providerRef" FROM computers
				WHERE id = ANY($1::text[])`, unique(computerIDs))
			if err != nil {
				return ConversationCancel{}, err
			}
			for computerRows.Next() {
				var computer Computer
				if err := computerRows.Scan(&computer.ID, &computer.HomeKey, &computer.Kind, &computer.ProviderRef); err != nil {
					computerRows.Close()
					return ConversationCancel{}, err
				}
				result.Computers = append(result.Computers, computer)
			}
			computerRows.Close()
			if err := computerRows.Err(); err != nil {
				return ConversationCancel{}, err
			}
		}
	}
	spaceID := target.SpaceID
	if spaceID == "" {
		if err := tx.QueryRow(ctx, `SELECT "spaceId" FROM runs WHERE id = ANY($1::text[]) LIMIT 1`, ids).Scan(&spaceID); err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return ConversationCancel{}, err
		}
	}
	// One terminal event per cancelled run in this thread, in the same commit as
	// the status flip and the progress purge (thread-stop.ts:120-137). A helper in
	// a thread of its own gets none: its card tells the chat.
	for _, run := range result.Runs {
		if run.ThreadID != target.ThreadID {
			continue
		}
		event, err := events.Append(ctx, tx, c.Ring, events.Input{
			SpaceID:  spaceID,
			ThreadID: target.ThreadID,
			BotID:    run.BotID,
			Type:     "run.cancelled",
			RunID:    run.ID,
			Payload:  map[string]any{},
		})
		if err != nil {
			return ConversationCancel{}, err
		}
		seq := event.Seq
		result.EventSeq = &seq
	}
	// The notes come after the run.cancelled events and before the transient
	// purge, exactly as thread-stop.ts:145-172 orders them. Each note's event seq
	// becomes the cursor, so EventSeq ends at the last note, which is what
	// finishThreadStop notifies with (thread-stop.ts:199-205). A cancel that owes
	// a note and has no writer fails instead of returning text its caller could
	// write after the notify: that is the R1 cursor trap.
	notes := conversationNotes(result.Runs, target.Note)
	if len(notes) > 0 && target.WriteNote == nil {
		return ConversationCancel{}, ErrNotesNotWritten
	}
	for _, note := range notes {
		seq, err := target.WriteNote(ctx, tx, note)
		if err != nil {
			return ConversationCancel{}, err
		}
		if seq <= 0 {
			return ConversationCancel{}, fmt.Errorf("runs: WriteNote returned no event seq for %q", note.Text)
		}
		value := seq
		result.EventSeq = &value
	}
	if len(ids) > 0 {
		if err := deleteTransientRunEvents(ctx, tx, ids); err != nil {
			return ConversationCancel{}, err
		}
	}
	for _, run := range result.Runs {
		if run.Trigger == "helper" {
			result.StoppedHelpers = append(result.StoppedHelpers, run)
		}
	}
	return result, nil
}

// SupersedeQueued is cancelSupersededQueuedRuns (thread-target.ts:254): a new
// user or reaction run replaces the ones still queued for the same bots in the
// same chat, so only the newest message gets answered.
func (c Canceller) SupersedeQueued(
	ctx context.Context,
	tx pgx.Tx,
	threadID string,
	botIDs []string,
	keepRunIDs []string,
	at time.Time,
	state *secretstore.State,
) ([]Cancelled, error) {
	if len(botIDs) == 0 {
		return nil, nil
	}
	if err := c.requireRing(); err != nil {
		return nil, err
	}
	at = now(at)
	rows, err := tx.Query(ctx, `
		UPDATE runs r SET status = 'cancelled', "completedAt" = $4, "updatedAt" = now()
		WHERE r."threadId" = $1 AND r."botId" = ANY($2::text[]) AND r.status = 'queued'
		  AND r.id <> ALL($3::text[])
		  AND (r.trigger = 'reaction'
			OR (r.trigger = 'user' AND EXISTS (
				SELECT 1 FROM messages m WHERE m.id = r."sourceMessageId" AND m.role = 'user')))
		RETURNING `+cancelColumns, threadID, botIDs, keepRunIDs, at)
	if err != nil {
		return nil, fmt.Errorf("supersede queued runs: %w", err)
	}
	var cancelled []Cancelled
	for rows.Next() {
		run, err := scanCancelled(rows)
		if err != nil {
			rows.Close()
			return nil, err
		}
		cancelled = append(cancelled, run)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(cancelled) == 0 {
		return nil, nil
	}
	if err := loadRoutineNames(ctx, tx, cancelled); err != nil {
		return nil, err
	}
	if err := c.clearEndedState(ctx, tx, idsOf(cancelled), state); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `
		UPDATE tasks SET status = 'cancelled', "updatedAt" = now()
		WHERE id = ANY($1::text[])`, taskIDsOf(cancelled)); err != nil {
		return nil, fmt.Errorf("cancel superseded tasks: %w", err)
	}
	return cancelled, nil
}

// clearEndedState is clearEndedState (run-secrets.ts:61-90): a cancelled run
// never resumes, so its turn checkpoint, an unanswered card's intended effect
// and the answer/login/code it kept for itself all go with it.
func (c Canceller) clearEndedState(
	ctx context.Context,
	tx pgx.Tx,
	ids []string,
	state *secretstore.State,
) error {
	if len(ids) == 0 {
		return nil
	}
	if _, err := tx.Exec(ctx, `
		DELETE FROM external_effects
		WHERE "runId" = ANY($1::text[]) AND kind = $2 AND status = $2`,
		ids, RunTurnCheckpointKind); err != nil {
		return fmt.Errorf("clear run turn checkpoints: %w", err)
	}
	approvalIDs, err := openApprovalEffects(ctx, tx, c.Ring, ids)
	if err != nil {
		return err
	}
	if len(approvalIDs) > 0 {
		if _, err := tx.Exec(ctx, `
			UPDATE external_effects SET status = 'denied'
			WHERE id = ANY($1::text[]) AND "runId" = ANY($2::text[]) AND status = 'intended'`,
			approvalIDs, ids); err != nil {
			return fmt.Errorf("deny open approval effects: %w", err)
		}
	}
	return c.deleteRunSecrets(ctx, tx, ids, state)
}

// openApprovalEffects finds the effects behind unanswered ask cards on the
// runs' bot messages, opening sealed blocks with the ring.
func openApprovalEffects(ctx context.Context, tx pgx.Tx, ring *contentcrypto.KeyRing, ids []string) ([]string, error) {
	rows, err := tx.Query(ctx, `
		SELECT id, "threadId", blocks FROM messages
		WHERE "runId" = ANY($1::text[]) AND role = 'bot'`, ids)
	if err != nil {
		return nil, err
	}
	var messages []map[string]any
	for rows.Next() {
		var id, threadID string
		var blocks any
		if err := rows.Scan(&id, &threadID, &blocks); err != nil {
			rows.Close()
			return nil, err
		}
		messages = append(messages, map[string]any{
			"id": id, "threadId": threadID, "blocks": blocks,
		})
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(messages) > 0 {
		if err := ring.OpenRows(ctx, "Message", messages); err != nil {
			return nil, err
		}
	}
	var approvalIDs []string
	for _, message := range messages {
		blocks, ok := message["blocks"].([]any)
		if !ok {
			continue
		}
		for _, raw := range blocks {
			block, ok := raw.(map[string]any)
			if !ok || block["kind"] != "ask" {
				continue
			}
			if block["status"] == "answered" {
				continue
			}
			if effectID, ok := block["approvalEffectId"].(string); ok && effectID != "" {
				approvalIDs = append(approvalIDs, effectID)
			}
		}
	}
	return approvalIDs, nil
}

// deleteRunSecrets is deleteRunSecretsInTransaction: the run's waiting answer,
// one-time codes and run-only logins (run-secrets.ts:14-59).
func (c Canceller) deleteRunSecrets(
	ctx context.Context,
	tx pgx.Tx,
	ids []string,
	state *secretstore.State,
) error {
	selection := `SELECT s.id FROM secrets s
		JOIN (SELECT unnest($1::text[]) AS run, unnest($2::text[]) AS uid, unnest($3::text[]) AS sid) r
		  ON s."userId" = r.uid AND s."spaceId" = r.sid
		WHERE s.kind IN ('run-secret:' || r.run, 'run-code:' || r.run, 'run-code-spent:' || r.run)
		   OR s.kind LIKE 'run-login:' || r.run || ':%'`
	owners, err := runSecretOwners(ctx, tx, ids)
	if err != nil {
		return err
	}
	runIDs, userIDs, spaceIDs := owners.columns()
	if c.Vault != nil && state != nil {
		if err := c.Vault.CaptureDropped(ctx, tx, state, secretstore.Secret, selection, runIDs, userIDs, spaceIDs); err != nil {
			return err
		}
	}
	if _, err := tx.Exec(ctx, `DELETE FROM secrets s
		USING (SELECT unnest($1::text[]) AS run, unnest($2::text[]) AS uid, unnest($3::text[]) AS sid) r
		WHERE s."userId" = r.uid AND s."spaceId" = r.sid
		  AND (s.kind IN ('run-secret:' || r.run, 'run-code:' || r.run, 'run-code-spent:' || r.run)
		       OR s.kind LIKE 'run-login:' || r.run || ':%')`,
		runIDs, userIDs, spaceIDs); err != nil {
		return fmt.Errorf("delete run secrets: %w", err)
	}
	return nil
}

type secretOwners struct {
	runIDs   []string
	userIDs  []string
	spaceIDs []string
}

func (o secretOwners) columns() ([]string, []string, []string) {
	return o.runIDs, o.userIDs, o.spaceIDs
}

func runSecretOwners(ctx context.Context, tx pgx.Tx, ids []string) (secretOwners, error) {
	var owners secretOwners
	rows, err := tx.Query(ctx, `SELECT id, "userId", "spaceId" FROM runs WHERE id = ANY($1::text[])`, ids)
	if err != nil {
		return owners, err
	}
	defer rows.Close()
	for rows.Next() {
		var runID, userID, spaceID string
		if err := rows.Scan(&runID, &userID, &spaceID); err != nil {
			return owners, err
		}
		owners.runIDs = append(owners.runIDs, runID)
		owners.userIDs = append(owners.userIDs, userID)
		owners.spaceIDs = append(owners.spaceIDs, spaceID)
	}
	return owners, rows.Err()
}

// loadRoutineNames fills the name a stopped routine run shows in its note.
func loadRoutineNames(ctx context.Context, tx pgx.Tx, runs []Cancelled) error {
	ids := make([]string, 0, len(runs))
	for _, run := range runs {
		if run.RoutineID != nil {
			ids = append(ids, *run.RoutineID)
		}
	}
	if len(ids) == 0 {
		return nil
	}
	rows, err := tx.Query(ctx, `SELECT id, name FROM routines WHERE id = ANY($1::text[])`, unique(ids))
	if err != nil {
		return err
	}
	defer rows.Close()
	names := map[string]string{}
	for rows.Next() {
		var id, name string
		if err := rows.Scan(&id, &name); err != nil {
			return err
		}
		names[id] = name
	}
	if err := rows.Err(); err != nil {
		return err
	}
	for index := range runs {
		if runs[index].RoutineID == nil {
			continue
		}
		if name, ok := names[*runs[index].RoutineID]; ok {
			value := name
			runs[index].RoutineName = &value
		}
	}
	return nil
}

// deleteTransientRunEvents is the `event.deleteMany` of transientRunEventsWhere
// (events.ts:114-123). The thread.meta branches compare the stored payload
// structurally; with content encryption on, the activity key is inside the
// sealed copy, so those two match nothing — exactly as TypeScript's Prisma
// equality filter behaves.
func deleteTransientRunEvents(ctx context.Context, tx pgx.Tx, ids []string) error {
	if _, err := tx.Exec(ctx, `
		DELETE FROM events
		WHERE "runId" = ANY($1::text[])
		  AND (type IN ('thread.progress', 'thread.thinking')
		       OR (type = 'thread.meta' AND payload = $2::jsonb)
		       OR (type = 'thread.meta' AND payload = $3::jsonb))`,
		ids, `{"activity":{"thinking":true}}`, `{"activity":{"thinking":false}}`); err != nil {
		return fmt.Errorf("delete transient run events: %w", err)
	}
	return nil
}

// ConversationTarget is what cancelThreadRuns reads off the resolved target.
type ConversationTarget struct {
	SpaceID         string
	ThreadID        string
	BotIDs          []string
	HelperMessageID *string
	// Note is the stop-by-message note: added once when a cancelled run is not a
	// named routine (thread-stop.ts:145-152).
	Note *Note
	// WriteNote creates each note as a system message in this same transaction
	// (the thread message counter and a thread.message.created event, as
	// createThreadMessageInTransaction + appendEventInTransaction do) and returns
	// that event's seq. It is required whenever a note is due: the cancel writes
	// the notes itself, in TS order, so EventSeq can only end at their last event.
	WriteNote func(ctx context.Context, tx pgx.Tx, note Note) (int32, error)
}

// Note is one system message the cancel creates in this transaction: a routine
// name that was stopped, or the stop-by-message note.
type Note struct {
	BotID string
	Text  string
}

// ErrNotesNotWritten is the cancel refusing to hand back note text it did not
// write: without WriteNote a caller could notify below the notes' cursor or
// write them after the run.cancelled events were visible.
var ErrNotesNotWritten = errors.New("runs: cancel conversation owes stop notes but has no WriteNote")

// ConversationCancel is cancelThreadRuns' result.
type ConversationCancel struct {
	Runs      []Cancelled
	Leases    []Lease
	Computers []Computer
	// EventSeq is the last event this cancel committed: the last note's seq when
	// notes were due, else the last run.cancelled seq. finishThreadStop notifies
	// with exactly this cursor. Nil when nothing was appended.
	EventSeq       *int32
	StoppedHelpers []Cancelled
}

// Lease is one computer_execution_leases row (expired ones still name the
// run's screen).
type Lease struct {
	ComputerID string
	BotID      string
	RunID      string
	Fence      int32
}

// Computer is the teardown target a cancelled run's lease names.
type Computer struct {
	ID          string
	HomeKey     *string
	Kind        string
	ProviderRef *string
}

// conversationNotes is the routine/stop note list in thread-stop order.
func conversationNotes(cancelled []Cancelled, note *Note) []Note {
	var notes []Note
	seen := map[string]bool{}
	unnamed := false
	for _, run := range cancelled {
		if run.Trigger == "routine" && run.RoutineID != nil && run.RoutineName != nil && *run.RoutineName != "" {
			if seen[*run.RoutineID] {
				continue
			}
			seen[*run.RoutineID] = true
			notes = append(notes, Note{BotID: run.BotID, Text: `Stopped the routine "` + *run.RoutineName + `".`})
			continue
		}
		unnamed = true
	}
	// The stop-by-message note is added when anything but a named routine was
	// stopped, alongside the routine notes (thread-stop.ts:145-152).
	if note != nil && unnamed {
		notes = append(notes, *note)
	}
	return notes
}

func scanCancelled(rows pgx.Rows) (Cancelled, error) {
	var run Cancelled
	err := rows.Scan(&run.ID, &run.TaskID, &run.UserID, &run.SpaceID, &run.ThreadID,
		&run.BotID, &run.Trigger, &run.SourceMessageID, &run.RoutineID)
	return run, err
}

func idsOf(runs []Cancelled) []string {
	ids := make([]string, 0, len(runs))
	for _, run := range runs {
		ids = append(ids, run.ID)
	}
	return ids
}

func taskIDsOf(runs []Cancelled) []string {
	ids := make([]string, 0, len(runs))
	seen := map[string]bool{}
	for _, run := range runs {
		if seen[run.TaskID] {
			continue
		}
		seen[run.TaskID] = true
		ids = append(ids, run.TaskID)
	}
	return ids
}

func unique(values []string) []string {
	seen := make(map[string]bool, len(values))
	out := values[:0]
	for _, value := range values {
		if seen[value] {
			continue
		}
		seen[value] = true
		out = append(out, value)
	}
	return out
}
