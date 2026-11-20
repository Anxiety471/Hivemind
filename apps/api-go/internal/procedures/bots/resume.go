package bots

import (
	"context"
	"errors"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/cron"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/effects"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/jobs"
)

// ResumeRoutinesAfterRestore is resumeRoutinesAfterRestore
// (apps/api/src/routines/routine-resume.ts): turn back on the routines that
// archiving these bots turned off, each on its next occurrence from now.
//
// Only the restoring member's own routines resume: a routine runs with its
// owner's accounts, so another member's stays off until they turn it on. A
// one-time routine stays off too, because archiving dropped the time it was
// set for. Safe to repeat, so a restore that failed part-way is finished by
// restoring again.
//
// Like TypeScript, it announces "routines" for each Space it touched, on top of
// the generic bots.restore effect (the authed middleware announces the same
// procedure signal in TypeScript).
func ResumeRoutinesAfterRestore(ctx context.Context, database *db.DB, actor db.Actor, botIDs []string) error {
	if len(botIDs) == 0 {
		return nil
	}
	marked, err := markedRoutines(ctx, database, actor, botIDs)
	if err != nil {
		return err
	}
	for _, routine := range marked {
		if err := resumeRoutine(ctx, database, actor, botIDs, routine); err != nil {
			return err
		}
	}
	if len(marked) == 0 {
		return nil
	}
	// TypeScript announces every Space whose routines it touched here; the generic
	// procedure effect (effects.SpaceChangesFor) announces "routines" for
	// bots.restore as well, just as the authed middleware does in TypeScript, so
	// this signal goes out twice. Wait, so it has left before the procedure returns.
	publisher := effects.NewNotifier(database, slog.Default())
	seen := map[string]bool{}
	for _, routine := range marked {
		if seen[routine.SpaceID] {
			continue
		}
		seen[routine.SpaceID] = true
		publisher.PublishSpaceChange(routine.SpaceID, "routines")
	}
	publisher.Wait()
	return nil
}

// markedRoutine is one row of the findMany before the per-routine transactions:
// still marked, its bot restored, and this member's own.
type markedRoutine struct {
	ID      string
	SpaceID string
}

func markedRoutines(ctx context.Context, database *db.DB, actor db.Actor, botIDs []string) ([]markedRoutine, error) {
	var marked []markedRoutine
	err := database.Tenant(ctx, actor, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `SELECT r.id, r."spaceId" FROM routines r
			JOIN bots b ON b.id = r."botId"
			WHERE r."botId" = ANY($1) AND r."userId" = $2
				AND r."resumeOnRestore" AND b."archivedAt" IS NULL`, botIDs, actor.UserID)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var routine markedRoutine
			if err := rows.Scan(&routine.ID, &routine.SpaceID); err != nil {
				return err
			}
			marked = append(marked, routine)
		}
		return rows.Err()
	})
	return marked, err
}

// resumeRoutine is the per-routine transaction: under the row lock, re-read the
// routine as it stands, then turn it on with its wakeup in the same
// transaction so a routine is never on without one.
func resumeRoutine(ctx context.Context, database *db.DB, actor db.Actor, botIDs []string, routine markedRoutine) error {
	return database.Tenant(ctx, actor, func(tx pgx.Tx) error {
		// The lock result is ignored, as TypeScript ignores $queryRaw's rows.
		var locked string
		if err := tx.QueryRow(ctx, `SELECT id FROM routines WHERE id = $1 FOR UPDATE`, routine.ID).Scan(&locked); err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		var (
			active   bool
			crons    []string
			timezone string
			watch    bool
		)
		err := tx.QueryRow(ctx, `SELECT r.active, r.crons, r.timezone,
				COALESCE(r.watch IS NOT NULL AND r.watch <> 'null'::jsonb, false)
			FROM routines r
			JOIN bots b ON b.id = r."botId"
			WHERE r.id = $1 AND r."botId" = ANY($2) AND r."userId" = $3
				AND r."resumeOnRestore" AND b."archivedAt" IS NULL`,
			routine.ID, botIDs, actor.UserID).Scan(&active, &crons, &timezone, &watch)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		if err != nil {
			return err
		}
		at := now()
		if active || cron.IsOneShotRoutineCrons(crons) {
			// Prisma's @updatedAt writes the new time on every update.
			_, err := tx.Exec(ctx, `UPDATE routines SET "resumeOnRestore" = false, "updatedAt" = $2 WHERE id = $1`,
				routine.ID, at)
			return err
		}
		var nextRunAt *time.Time
		if watch {
			// firstWatchCheck: a new or re-armed watch takes its first reading a moment from now.
			first := at.Add(2 * time.Second)
			nextRunAt = &first
		} else if next, ok := cron.NextCronDateAcross(crons, at, timezone); ok {
			nextRunAt = &next
		}
		tag, err := tx.Exec(ctx, `UPDATE routines SET active = true, "nextRunAt" = $2,
			"resumeOnRestore" = false, "updatedAt" = $3 WHERE id = $1`,
			routine.ID, nextRunAt, at)
		if err != nil {
			return err
		}
		if tag.RowsAffected() != 1 {
			return errors.New("routine to resume not found")
		}
		if nextRunAt != nil {
			return jobs.EnqueueIn(ctx, tx, jobs.RoutineWakeup(routine.ID, *nextRunAt))
		}
		return nil
	})
}
