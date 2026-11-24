// Package jobs adds and removes background jobs in the caller's transaction.
//
// Graphile Worker lives in the same database, so a job commits or rolls back
// with the writes that need it. The worker that runs them is the TypeScript one.
package jobs

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/effects"
)

// Job is BackgroundJob (packages/adapter-kit/src/background-jobs.ts) for a job
// whose payload is a plain object.
type Job struct {
	Name    string
	Payload map[string]any
	// RunAt is availableAt; the zero time runs it now.
	RunAt time.Time
	// ReplaceKey is the job key: adding a job with a queued key replaces it.
	ReplaceKey string
}

// correlationField is CORRELATION_FIELD (packages/logging/src/jobs.ts).
const correlationField = "__rakazoLog"

// RoutineKey is routineJobKey.
func RoutineKey(routineID string) string { return "routine:" + routineID }

// RoutineWakeup is routineWakeupJob: the routine's next occurrence, keyed so a
// routine never has two queued.
func RoutineWakeup(routineID string, scheduledFor time.Time) Job {
	return Job{
		Name: "routine.wakeup",
		Payload: map[string]any{
			"routineId":    routineID,
			"scheduledFor": scheduledFor.UTC().Format("2006-01-02T15:04:05.000Z"),
		},
		RunAt:      scheduledFor,
		ReplaceKey: RoutineKey(routineID),
	}
}

// EnqueueIn is enqueueIn (packages/adapters/src/runs/wakeups/wakeup.ts).
func EnqueueIn(ctx context.Context, tx pgx.Tx, job Job) error {
	payload, err := json.Marshal(wrapPayload(job.Payload))
	if err != nil {
		return fmt.Errorf("encode %s payload: %w", job.Name, err)
	}
	var runAt, key *string
	if !job.RunAt.IsZero() {
		// As text with its zone, so a session in another time zone reads the same instant.
		value := job.RunAt.UTC().Format(time.RFC3339Nano)
		runAt = &value
	}
	if job.ReplaceKey != "" {
		key = &job.ReplaceKey
	}
	// writeaudit:dynamic graphile add_job stores its own json payload; TS uses $executeRawUnsafe + JSON.stringify without Prisma sanitization
	_, err = tx.Exec(ctx, `select graphile_worker.add_job($1::text, $2::json, queue_name => $3::text,
	   run_at => $4::timestamptz, max_attempts => $5::int, job_key => $6::text)`,
		job.Name, string(payload), nil, runAt, nil, key)
	if err != nil {
		return fmt.Errorf("add %s job: %w", job.Name, err)
	}
	return nil
}

// CancelIn is cancelIn: drop the queued job with this key, if any.
func CancelIn(ctx context.Context, tx pgx.Tx, key string) error {
	// writeaudit:dynamic graphile remove_job takes a job-key filter; TS uses the same raw call without sanitization
	if _, err := tx.Exec(ctx, `select graphile_worker.remove_job($1::text)`, key); err != nil {
		return fmt.Errorf("remove job %s: %w", key, err)
	}
	return nil
}

// wrapPayload is wrapJobPayload for a plain-object payload: the correlation
// rides beside the payload's own fields.
func wrapPayload(payload map[string]any) map[string]any {
	wrapped := make(map[string]any, len(payload)+1)
	for key, value := range payload {
		wrapped[key] = value
	}
	wrapped[correlationField] = map[string]any{
		"v": 1,
		"correlation": map[string]any{
			"jobId":   effects.NewUUID(),
			"traceId": traceID(),
		},
	}
	return wrapped
}

// traceID is generateTraceId: 16 random bytes as lower-case hex.
func traceID() string {
	var bytes [16]byte
	if _, err := rand.Read(bytes[:]); err != nil {
		panic("jobs: no randomness: " + err.Error())
	}
	return hex.EncodeToString(bytes[:])
}
