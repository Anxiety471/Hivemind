package events

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
)

// timingFieldOrder is the order runTimingFields spreads its optional fields
// (packages/db/src/run-timing.ts:44-67).
var timingFieldOrder = []string{
	"run.trigger",
	"run.pre_run_wait_ms",
	"run.queue_wait_ms",
	"run.first_response_ms",
	"run.total_ms",
	"run.execution_wall_ms",
}

// TimingRun is the run shape runTimingFields reads.
type TimingRun struct {
	Trigger         string
	CreatedAt       time.Time
	StartedAt       *time.Time
	FirstResponseAt *time.Time
	CompletedAt     *time.Time
	SourceCreatedAt *time.Time
}

// RunTimingFields is runTimingFields: elapsed milliseconds from the source
// message (or the run's own creation) to each milestone, never negative.
func RunTimingFields(run TimingRun) map[string]any {
	origin := run.CreatedAt
	if run.SourceCreatedAt != nil {
		origin = *run.SourceCreatedAt
	}
	elapsed := func(end, start time.Time) int64 {
		value := end.Sub(start).Milliseconds()
		if value < 0 {
			return 0
		}
		return value
	}
	fields := map[string]any{
		"run.trigger":         run.Trigger,
		"run.pre_run_wait_ms": elapsed(run.CreatedAt, origin),
	}
	if run.StartedAt != nil {
		fields["run.queue_wait_ms"] = elapsed(*run.StartedAt, run.CreatedAt)
	}
	if run.FirstResponseAt != nil {
		fields["run.first_response_ms"] = elapsed(*run.FirstResponseAt, origin)
	}
	if run.CompletedAt != nil {
		fields["run.total_ms"] = elapsed(*run.CompletedAt, origin)
		if run.StartedAt != nil {
			fields["run.execution_wall_ms"] = elapsed(*run.CompletedAt, *run.StartedAt)
		}
	}
	return fields
}

// ReadRunTimingFields is readRunTimingFields: observability only, so a failure
// or a hidden row returns an empty map and never fails the committed
// operation. It reads in a system context because it runs after commit, when
// the caller's transaction-local settings are gone; the row is selected by id.
func ReadRunTimingFields(ctx context.Context, database *db.DB, runID string) map[string]any {
	var run TimingRun
	found := false
	err := database.System(ctx, "read a run's timing fields", func(tx pgx.Tx) error {
		err := tx.QueryRow(ctx, `SELECT r.trigger, r."createdAt", r."startedAt", r."completedAt",
				r."firstResponseAt", m."createdAt"
			FROM runs r LEFT JOIN messages m ON m.id = r."sourceMessageId"
			WHERE r.id = $1`, runID).
			Scan(&run.Trigger, &run.CreatedAt, &run.StartedAt, &run.CompletedAt,
				&run.FirstResponseAt, &run.SourceCreatedAt)
		if err != nil {
			return err
		}
		found = true
		return nil
	})
	if err != nil || !found {
		return map[string]any{}
	}
	return RunTimingFields(run)
}
