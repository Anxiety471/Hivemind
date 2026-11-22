// Package runs hands agent runs to the TypeScript worker exactly as the
// TypeScript API does: it creates the task/run rows a procedure records, wakes
// a durable run through runs.wakeAt plus a runs:ready signal, and cancels runs
// with the same row, attempt, task, event and secret side effects.
//
// The worker stays TypeScript. Nothing here executes a run: a Go-created run is
// indistinguishable from one the TS API committed, so the TS
// RunWorkerHost/RunStarter picks it up through its normal wakeup path
// (packages/adapters/src/runs/wakeups/run-wakeup.ts).
//
// Every write is byte-compatible with the Prisma calls it replaces: same
// columns, same defaults, millisecond timestamps (JS Date precision), and
// cuid ids from effects.NewID.
//
// Callers run inside the transaction budget TypeScript uses for thread work:
// a 20 second transaction timeout (THREAD_LOCK_TRANSACTION_OPTIONS,
// packages/db/src/database/transaction-retry.ts:9). The Go gateway has no
// per-request timeout, so a procedure that takes the thread lock first runs its
// body through ThreadLockTransaction (or CancelConversationFor); a wait that
// runs out is ErrLockTimeout, the generic 500 TS gets from P2028.
package runs

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/effects"
)

// Statuses are RunStatus (packages/contracts/src/ids.ts).
const (
	StatusQueued          = "queued"
	StatusLeased          = "leased"
	StatusRunning         = "running"
	StatusWaitingInput    = "waiting_input"
	StatusWaitingTakeover = "waiting_takeover"
	StatusCompleted       = "completed"
	StatusFailed          = "failed"
	StatusCancelled       = "cancelled"
)

// ActiveStatuses is ACTIVE_RUN_STATUSES (packages/core/src/runs/run-state.ts:14).
var ActiveStatuses = []string{
	StatusQueued, StatusLeased, StatusRunning, StatusWaitingInput, StatusWaitingTakeover,
}

// QueueHoldingStatuses is QUEUE_HOLDING_RUN_STATUSES (run-state.ts:19): every
// active status but a pending input card, which holds no compute.
var QueueHoldingStatuses = []string{
	StatusQueued, StatusLeased, StatusRunning, StatusWaitingTakeover,
}

// ResumableStatuses is RESUMABLE (run-wakeup.ts:16): the statuses a wake may
// schedule. A running, leased or finished run's wakeAt is left alone.
var ResumableStatuses = []string{StatusQueued, StatusWaitingInput, StatusWaitingTakeover}

// transitions is `allowed` (run-state.ts:53-63).
var transitions = map[string][]string{
	StatusQueued:          {StatusLeased, StatusCancelled},
	StatusLeased:          {StatusRunning, StatusQueued, StatusCancelled},
	StatusRunning:         {StatusWaitingInput, StatusWaitingTakeover, StatusCompleted, StatusFailed, StatusCancelled, StatusLeased},
	StatusWaitingInput:    {StatusQueued, StatusLeased, StatusCancelled},
	StatusWaitingTakeover: {StatusQueued, StatusLeased, StatusCancelled},
	StatusCompleted:       {},
	StatusFailed:          {StatusQueued},
	StatusCancelled:       {},
}

// CanTransition is canTransition (run-state.ts:61).
func CanTransition(from, to string) bool {
	for _, allowed := range transitions[from] {
		if allowed == to {
			return true
		}
	}
	return false
}

// IsActive is isActive (run-state.ts:72).
func IsActive(status string) bool { return contains(ActiveStatuses, status) }

// IsTerminal is isTerminal (run-state.ts:101).
func IsTerminal(status string) bool {
	return status == StatusCompleted || status == StatusFailed || status == StatusCancelled
}

func contains(values []string, value string) bool {
	for _, candidate := range values {
		if candidate == value {
			return true
		}
	}
	return false
}

// ModelPin is a run's pinned model. Pinned is `modelPinned`: sendUserMessage
// and routineRunModelPin set it, continuationModelPin does not. Thinking is
// nullable: routineRunModelPin keeps a routine's NULL thinkingLevel NULL.
type ModelPin struct {
	Provider string
	Model    string
	Thinking *string
	Pinned   bool
}

// CreateInput is one task + run pair as a procedure commits it. Fields with no
// value are NULL/default exactly as the Prisma create omits them.
type CreateInput struct {
	SpaceID  string
	BotID    string
	ThreadID string
	UserID   string
	Prompt   string
	Trigger  string
	// Status defaults to queued.
	Status string
	// TaskStatus defaults to queued.
	TaskStatus string

	ClientNonce     *string
	SourceMessageID *string
	RoutineID       *string
	// DelegatedFromRunID is set for helper work delegated from another run.
	DelegatedFromRunID *string
	// RetryOfRunID is the routine run this one retries (unique).
	RetryOfRunID *string
	Model        *ModelPin
	// GroupReplyOptional is a group message that named nobody.
	GroupReplyOptional bool
	// WakeAt is a durable due time, as ticket wakes store at creation.
	WakeAt *time.Time
	// Now is the request time; zero means time.Now truncated to milliseconds.
	Now time.Time
}

// Created is the pair a procedure then links (messages.runId) and wakes.
type Created struct {
	TaskID string
	RunID  string
}

// Execer is the statement surface Create needs: a transaction.
type Execer interface {
	Exec(ctx context.Context, sql string, arguments ...any) (pgconn.CommandTag, error)
}

// Querier reads rows back.
type Querier interface {
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

// now is the millisecond instant the TypeScript writes: Prisma sends JS Dates,
// and every timestamp column is TIMESTAMP(3).
func now(at time.Time) time.Time {
	if at.IsZero() {
		at = time.Now()
	}
	return at.UTC().Truncate(time.Millisecond)
}

// Create inserts the task and the run in the caller's transaction. The run is
// queued, unfenced (leaseFence 0), and carries the same trigger-specific
// columns each TypeScript call site sets.
func Create(ctx context.Context, tx Execer, input CreateInput) (Created, error) {
	if input.SpaceID == "" || input.BotID == "" || input.ThreadID == "" || input.UserID == "" {
		return Created{}, errors.New("runs: create needs space, bot, thread and user")
	}
	// An empty prompt is legitimate: skills.testRun stores
	// `prompt ?? formatSkillRunPrompt(...)`, and an explicit "" is a prompt.
	if input.Trigger == "" {
		return Created{}, errors.New("runs: create needs a trigger")
	}
	status := input.Status
	if status == "" {
		status = StatusQueued
	}
	taskStatus := input.TaskStatus
	if taskStatus == "" {
		taskStatus = StatusQueued
	}
	at := now(input.Now)
	var wakeAt any
	if input.WakeAt != nil {
		wakeAt = now(*input.WakeAt)
	}
	taskID, runID := effects.NewID(), effects.NewID()
	if _, err := tx.Exec(ctx, `
		INSERT INTO tasks (id, "spaceId", "botId", "threadId", "userId", prompt, status, "createdAt", "updatedAt")
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)`,
		taskID, input.SpaceID, input.BotID, input.ThreadID, input.UserID, input.Prompt,
		taskStatus, at); err != nil {
		return Created{}, fmt.Errorf("insert task: %w", err)
	}
	var provider, model, thinking any
	pinned := false
	// routineRunModelPin returns {} unless both provider and model are set.
	if input.Model != nil && input.Model.Provider != "" && input.Model.Model != "" {
		provider, model = input.Model.Provider, input.Model.Model
		if input.Model.Thinking != nil {
			thinking = *input.Model.Thinking
		}
		pinned = input.Model.Pinned
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO runs (
			id, "spaceId", "botId", "threadId", "taskId", "userId", status, trigger,
			"modelProvider", "modelId", "thinkingLevel", "modelPinned", "groupReplyOptional",
			"clientNonce", "sourceMessageId", "routineId", "delegatedFromRunId", "retryOfRunId",
			"wakeAt", "createdAt", "updatedAt")
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
			$14, $15, $16, $17, $18, $19, $20, $20)`,
		runID, input.SpaceID, input.BotID, input.ThreadID, taskID, input.UserID, status,
		input.Trigger, provider, model, thinking, pinned, input.GroupReplyOptional,
		input.ClientNonce, input.SourceMessageID, input.RoutineID, input.DelegatedFromRunID,
		input.RetryOfRunID, wakeAt, at); err != nil {
		return Created{}, fmt.Errorf("insert run: %w", err)
	}
	return Created{TaskID: taskID, RunID: runID}, nil
}

// RunRef is the run a live-creation replay resolves to.
type RunRef struct {
	ID     string
	TaskID string
	Status string
}

// ByNonce is the runs_spaceId_clientNonce_key unique-key lookup. It is NOT the
// routines.testRun replay predicate: that prechecks
// {threadId, userId, clientNonce} (apps/api/src/routes/routines.ts:369-380)
// and must use ByThreadUserNonce.
func ByNonce(ctx context.Context, q Querier, spaceID, nonce string) (RunRef, bool, error) {
	return scanRunRef(q.QueryRow(ctx, `
		SELECT id, "taskId", status FROM runs WHERE "spaceId" = $1 AND "clientNonce" = $2`,
		spaceID, nonce))
}

// ByThreadUserNonce is routines.testRun's replay predicate
// (apps/api/src/routes/routines.ts:373-380): a run already saved in this chat
// by this person under the nonce. Another thread's or person's run with the
// same nonce is not a replay.
func ByThreadUserNonce(ctx context.Context, q Querier, threadID, userID, nonce string) (RunRef, bool, error) {
	return scanRunRef(q.QueryRow(ctx, `
		SELECT id, "taskId", status FROM runs
		WHERE "threadId" = $1 AND "userId" = $2 AND "clientNonce" = $3
		ORDER BY "createdAt" ASC, id ASC LIMIT 1`, threadID, userID, nonce))
}

// BySourceMessage is the run a message created, oldest first
// (sendUserMessage's replay: orderBy createdAt asc).
func BySourceMessage(ctx context.Context, q Querier, messageID string) (RunRef, bool, error) {
	return scanRunRef(q.QueryRow(ctx, `
		SELECT id, "taskId", status FROM runs
		WHERE "sourceMessageId" = $1 ORDER BY "createdAt" ASC, id ASC LIMIT 1`, messageID))
}

func scanRunRef(row pgx.Row) (RunRef, bool, error) {
	var run RunRef
	err := row.Scan(&run.ID, &run.TaskID, &run.Status)
	if errors.Is(err, pgx.ErrNoRows) {
		return RunRef{}, false, nil
	}
	if err != nil {
		return RunRef{}, false, err
	}
	return run, true, nil
}

// IsUniqueViolation reports the runs_spaceId_clientNonce_key collision a
// concurrent retry of the same submission makes.
func IsUniqueViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505"
}
