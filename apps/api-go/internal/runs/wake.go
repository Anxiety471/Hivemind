package runs

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
)

// Publisher is the realtime fanout's one signal a wake needs
// (effects.Notifier.PublishRunReady). It publishes one pg_notify envelope on
// rakazo_events: {"topic":"runs:ready","payload":"<runId>"}.
type Publisher interface {
	PublishRunReady(runID string)
}

// WakeOptions is wakeRun(runId, { at, keepExisting }). A zero At means "now",
// as `availableAt ?? new Date()` does.
type WakeOptions struct {
	At time.Time
	// KeepExisting leaves a wake time the run already has: `AND "wakeAt" IS NULL`.
	KeepExisting bool
	// Now is the instant written to updatedAt; zero means time.Now.
	Now time.Time
}

// Wake is RunJobPublisher.enqueue for run.continue (run-wakeup.ts:184-193):
// make the durable row due at At, then hand the run to whichever TypeScript
// process listens on runs:ready. It must run after the creating transaction
// commits, never inside one: TypeScript's enqueueIn refuses run.continue
// ("Runs are not started inside a transaction").
//
// A run already due is announced; a future one is not, because TypeScript's
// RunStarter.start schedules a local timer for a later time and a process that
// cannot take the run returns without publishing (run-wakeup.ts:104-114). The
// durable wakeAt is what recovery reads, and the worker's scan starts it when
// it comes due.
//
// When the run is due, the signal is published even if no row was updated, as
// the TypeScript publisher calls RunStarter.start without inspecting the
// update count; the worker's claim decides whether it may start. A process that
// cannot take the run hands it on this way, so the frame is the same one a TS
// process without capacity publishes.
//
// reported is false when the run was not resumable (running, leased, finished)
// or already had a wake time under KeepExisting; the run is untouched then.
func Wake(ctx context.Context, exec Execer, publisher Publisher, runID string, options WakeOptions) (bool, error) {
	if runID == "" {
		return false, nil
	}
	at := now(options.At)
	updated := now(options.Now)
	query := `UPDATE runs SET "wakeAt" = $2, "updatedAt" = $3
		WHERE id = $1 AND status = ANY($4::text[])`
	if options.KeepExisting {
		query += ` AND "wakeAt" IS NULL`
	}
	tag, err := exec.Exec(ctx, query, runID, at, updated, ResumableStatuses)
	if err != nil {
		return false, fmt.Errorf("wake run %s: %w", runID, err)
	}
	// `delay <= 0` in RunStarter.start: announce only a run that is due now.
	if publisher != nil && !at.After(updated) {
		publisher.PublishRunReady(runID)
	}
	return tag.RowsAffected() == 1, nil
}

// WakeFor is Wake in its own tenant transaction, which is how a procedure
// wakes a run after it committed: the row-level security context of the
// request decides which run it may touch, exactly as the TypeScript handler's
// Prisma client does. A wake is never part of the transaction that created the
// run (TypeScript refuses run.continue inside one).
func WakeFor(ctx context.Context, database *db.DB, actor db.Actor, publisher Publisher, runID string, options WakeOptions) (bool, error) {
	var changed bool
	err := database.Tenant(ctx, actor, func(tx pgx.Tx) error {
		var err error
		changed, err = Wake(ctx, tx, publisher, runID, options)
		return err
	})
	return changed, err
}

// TryWake is wakeRun's own error policy: a failed nudge is logged and dropped,
// because the row is durable and recovery starts a run whose nudge was lost
// (packages/adapters/src/runs/wakeups/wake-run.ts:9-21). Use it after a commit.
func TryWake(ctx context.Context, exec Execer, publisher Publisher, logger *slog.Logger, runID string, options WakeOptions) {
	if _, err := Wake(ctx, exec, publisher, runID, options); err != nil {
		logWakeError(logger, runID, err)
	}
}

// TryWakeFor is TryWake in its own tenant transaction (WakeFor).
func TryWakeFor(ctx context.Context, database *db.DB, actor db.Actor, publisher Publisher, logger *slog.Logger, runID string, options WakeOptions) {
	if _, err := WakeFor(ctx, database, actor, publisher, runID, options); err != nil {
		logWakeError(logger, runID, err)
	}
}

func logWakeError(logger *slog.Logger, runID string, err error) {
	if logger != nil {
		logger.Error("run wake failed", "run.id", runID, "error", err)
	}
}

// WakeMany is enqueueRunsNeedingContinue (thread-target.ts:164-171): wake each
// of these runs, never failing the work that recorded them.
func WakeMany(ctx context.Context, database *db.DB, actor db.Actor, publisher Publisher, logger *slog.Logger, runIDs []string) {
	for _, runID := range runIDs {
		TryWakeFor(ctx, database, actor, publisher, logger, runID, WakeOptions{})
	}
}
