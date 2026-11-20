package integration

import (
	"context"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/jobs"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/bots"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/groups"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/shared"
)

// addRoutineRow inserts a routine the restore paths read. watch is JSON text
// when the routine watches something.
func addRoutineRow(t *testing.T, database *db.DB, id, spaceID, botID, userID string, crons []string, active, resumeOnRestore bool, watch *string) {
	t.Helper()
	var watchValue any
	if watch != nil {
		watchValue = *watch
	}
	exec(t, database, `INSERT INTO routines (id, "spaceId", "botId", "userId", name, prompt, crons, timezone, active, "resumeOnRestore", watch, "updatedAt")
		VALUES ($1, $2, $3, $4, $5, $5, $6, 'UTC', $7, $8, $9::jsonb, now())`,
		id, spaceID, botID, userID, "Routine "+id, crons, active, resumeOnRestore, watchValue)
}

type resumeRoutineState struct {
	Active          bool
	ResumeOnRestore bool
	NextRunAt       *time.Time
}

func routineState(t *testing.T, database *db.DB, id string) resumeRoutineState {
	t.Helper()
	var state resumeRoutineState
	if err := database.System(context.Background(), "test read routine", func(tx pgx.Tx) error {
		return tx.QueryRow(context.Background(),
			`SELECT active, "resumeOnRestore", "nextRunAt" FROM routines WHERE id = $1`, id).
			Scan(&state.Active, &state.ResumeOnRestore, &state.NextRunAt)
	}); err != nil {
		t.Fatalf("read routine %s: %v", id, err)
	}
	return state
}

// routineJobs is the queued wakeups for a routine, by the job key a routine
// never has twice.
func routineJobs(t *testing.T, database *db.DB, id string) int {
	t.Helper()
	return systemScalar[int](t, database,
		`SELECT count(*) FROM graphile_worker.jobs WHERE key = $1 AND task_identifier = 'routine.wakeup'`,
		jobs.RoutineKey(id))
}

func cleanupResumeFixture(t *testing.T, database *db.DB, botID string, routineIDs ...string) {
	t.Helper()
	t.Cleanup(func() {
		ctx := context.Background()
		_ = database.System(ctx, "test clean routines", func(tx pgx.Tx) error {
			for _, id := range routineIDs {
				if _, err := tx.Exec(ctx, `SELECT graphile_worker.remove_job($1)`, jobs.RoutineKey(id)); err != nil {
					return err
				}
			}
			// The bot's routines cascade with it.
			_, err := tx.Exec(ctx, `DELETE FROM bots WHERE id = $1`, botID)
			return err
		})
	})
}

// Restoring an archived bot turns the actor's own marked routines back on,
// each with a wakeup, and leaves another member's, one-shot and malformed
// schedules as routine-resume.ts does.
func TestRestoreResumesMarkedRoutines(t *testing.T) {
	database := openTestDB(t)
	s := seed(t, database)
	actor := db.Actor{UserID: s.UserID, SpaceID: s.Space1}
	ctx := context.Background()
	botID := "rb-" + s.UserID
	addBotRow(t, database, botID, s.Space1, s.UserID, "Routine bot", archivedAt(t), nil)
	own := "r-own-" + s.UserID
	theirs := "r-theirs-" + s.UserID
	once := "r-once-" + s.UserID
	watching := "r-watch-" + s.UserID
	broken := "r-broken-" + s.UserID
	addRoutineRow(t, database, own, s.Space1, botID, s.UserID, []string{"*/5 * * * *"}, false, true, nil)
	addRoutineRow(t, database, theirs, s.Space1, botID, s.User2ID, []string{"*/5 * * * *"}, false, true, nil)
	addRoutineRow(t, database, once, s.Space1, botID, s.UserID, []string{"@once"}, false, true, nil)
	watchJSON := `{"kind":"http","url":"https://example.test"}`
	addRoutineRow(t, database, watching, s.Space1, botID, s.UserID, []string{}, false, true, &watchJSON)
	addRoutineRow(t, database, broken, s.Space1, botID, s.UserID, []string{"not a cron"}, false, true, nil)
	cleanupResumeFixture(t, database, botID, own, theirs, once, watching, broken)

	before := time.Now()
	_, failure := bots.Restore(ctx, database, actor, shared.Deployment{}, raw(`{"botId":"`+botID+`"}`))
	after := time.Now()
	if failure != nil {
		t.Fatal(failure)
	}
	if archived := systemScalar[bool](t, database, `SELECT "archivedAt" IS NOT NULL FROM bots WHERE id = $1`, botID); archived {
		t.Fatal("the bot must be live after restore")
	}

	mine := routineState(t, database, own)
	if !mine.Active || mine.ResumeOnRestore || mine.NextRunAt == nil {
		t.Fatalf("own routine = %+v, want active and scheduled", mine)
	}
	if mine.NextRunAt.Before(before) || mine.NextRunAt.After(after.Add(5*time.Minute)) {
		t.Fatalf("own nextRunAt = %s, want the next */5 occurrence", mine.NextRunAt)
	}
	if count := routineJobs(t, database, own); count != 1 {
		t.Fatalf("own routine jobs = %d, want 1", count)
	}
	runAt := systemScalar[time.Time](t, database, `SELECT run_at FROM graphile_worker.jobs WHERE key = $1`, jobs.RoutineKey(own))
	if runAt.UnixMilli() != mine.NextRunAt.UnixMilli() {
		t.Fatalf("job run_at = %s, want the routine's nextRunAt %s", runAt, mine.NextRunAt)
	}

	theirsState := routineState(t, database, theirs)
	if theirsState.Active || !theirsState.ResumeOnRestore || theirsState.NextRunAt != nil {
		t.Fatalf("another member's routine = %+v, want it untouched", theirsState)
	}
	if count := routineJobs(t, database, theirs); count != 0 {
		t.Fatalf("another member's routine jobs = %d, want 0", count)
	}

	onceState := routineState(t, database, once)
	if onceState.Active || onceState.ResumeOnRestore || onceState.NextRunAt != nil {
		t.Fatalf("one-shot routine = %+v, want it off with its mark cleared", onceState)
	}
	if count := routineJobs(t, database, once); count != 0 {
		t.Fatalf("one-shot routine jobs = %d, want 0", count)
	}

	watchState := routineState(t, database, watching)
	if !watchState.Active || watchState.ResumeOnRestore || watchState.NextRunAt == nil {
		t.Fatalf("watch routine = %+v, want active and scheduled", watchState)
	}
	if watchState.NextRunAt.Before(before.Add(1500*time.Millisecond)) || watchState.NextRunAt.After(after.Add(3*time.Second)) {
		t.Fatalf("watch nextRunAt = %s, want about two seconds from now", watchState.NextRunAt)
	}
	if count := routineJobs(t, database, watching); count != 1 {
		t.Fatalf("watch routine jobs = %d, want 1", count)
	}

	brokenState := routineState(t, database, broken)
	if !brokenState.Active || brokenState.ResumeOnRestore || brokenState.NextRunAt != nil {
		t.Fatalf("malformed routine = %+v, want active without a run time", brokenState)
	}
	if count := routineJobs(t, database, broken); count != 0 {
		t.Fatalf("malformed routine jobs = %d, want 0", count)
	}
}

// Restoring a bot that is already live finishes a restore that stopped before
// its routines, and does not touch the bot row.
func TestRestoreOnLiveBotFinishesResume(t *testing.T) {
	database := openTestDB(t)
	s := seed(t, database)
	actor := db.Actor{UserID: s.UserID, SpaceID: s.Space1}
	ctx := context.Background()
	botID := "rl-" + s.UserID
	seededAt := time.Date(2020, 1, 1, 0, 0, 0, 0, time.UTC)
	exec(t, database, `INSERT INTO bots (id, "spaceId", "userId", name, color, "createdAt", "updatedAt")
		VALUES ($1, $2, $3, 'Live bot', 'blue', $4, $4)`, botID, s.Space1, s.UserID, seededAt)
	routine := "r-live-" + s.UserID
	addRoutineRow(t, database, routine, s.Space1, botID, s.UserID, []string{"*/5 * * * *"}, false, true, nil)
	cleanupResumeFixture(t, database, botID, routine)

	if _, failure := bots.Restore(ctx, database, actor, shared.Deployment{}, raw(`{"botId":"`+botID+`"}`)); failure != nil {
		t.Fatal(failure)
	}
	state := routineState(t, database, routine)
	if !state.Active || state.ResumeOnRestore || state.NextRunAt == nil {
		t.Fatalf("routine = %+v, want the interrupted restore finished", state)
	}
	if count := routineJobs(t, database, routine); count != 1 {
		t.Fatalf("routine jobs = %d, want 1", count)
	}
	if updatedAt := systemScalar[time.Time](t, database, `SELECT "updatedAt" FROM bots WHERE id = $1`, botID); !updatedAt.Equal(seededAt) {
		t.Fatalf("bot updatedAt = %s, want the live row left alone", updatedAt)
	}

	// Restoring again changes nothing: the routine is no longer marked, and the
	// wakeup keeps its one keyed job.
	if _, failure := bots.Restore(ctx, database, actor, shared.Deployment{}, raw(`{"botId":"`+botID+`"}`)); failure != nil {
		t.Fatal(failure)
	}
	if count := routineJobs(t, database, routine); count != 1 {
		t.Fatalf("routine jobs after a second restore = %d, want 1", count)
	}
}

// A group restore brings its bots back and then resumes the caller's marked
// routines on every member, archived or already live, as the route does.
func TestGroupRestoreResumesMarkedRoutines(t *testing.T) {
	database := openTestDB(t)
	s := seed(t, database)
	actor := db.Actor{UserID: s.UserID, SpaceID: s.Space1}
	ctx := context.Background()
	group := "g-rr-" + s.UserID
	archivedBot := "gb-arch-" + s.UserID
	liveBot := "gb-live-" + s.UserID
	otherBot := "gb-other-" + s.UserID
	addGroupRow(t, database, group, s.Space1, s.UserID, "Routines group", archivedAt(t))
	addBotRow(t, database, archivedBot, s.Space1, s.UserID, "Archived member", archivedAt(t), nil)
	addBotRow(t, database, liveBot, s.Space1, s.UserID, "Live member", nil, nil)
	addBotRow(t, database, otherBot, s.Space1, s.UserID, "Other member", nil, nil)
	memberRoutine := "r-garch-" + s.UserID
	liveRoutine := "r-glive-" + s.UserID
	otherRoutine := "r-gother-" + s.UserID
	addRoutineRow(t, database, memberRoutine, s.Space1, archivedBot, s.UserID, []string{"*/5 * * * *"}, false, true, nil)
	addRoutineRow(t, database, liveRoutine, s.Space1, liveBot, s.UserID, []string{"*/5 * * * *"}, false, true, nil)
	addRoutineRow(t, database, otherRoutine, s.Space1, otherBot, s.User2ID, []string{"*/5 * * * *"}, false, true, nil)
	addGroupMemberRow(t, database, "gm-rr-a-"+s.UserID, group, archivedBot, time.Now())
	addGroupMemberRow(t, database, "gm-rr-b-"+s.UserID, group, liveBot, time.Now())
	addGroupMemberRow(t, database, "gm-rr-c-"+s.UserID, group, otherBot, time.Now())
	t.Cleanup(func() {
		cleanup := context.Background()
		_ = database.System(cleanup, "test clean group routines", func(tx pgx.Tx) error {
			for _, id := range []string{memberRoutine, liveRoutine, otherRoutine} {
				if _, err := tx.Exec(cleanup, `SELECT graphile_worker.remove_job($1)`, jobs.RoutineKey(id)); err != nil {
					return err
				}
			}
			if _, err := tx.Exec(cleanup, `DELETE FROM chat_groups WHERE id = $1`, group); err != nil {
				return err
			}
			_, err := tx.Exec(cleanup, `DELETE FROM bots WHERE id = ANY($1)`, []string{archivedBot, liveBot, otherBot})
			return err
		})
	})

	if _, failure := groups.Restore(ctx, database, actor, shared.Deployment{}, raw(`{"groupId":"`+group+`"}`)); failure != nil {
		t.Fatal(failure)
	}
	if archived := systemScalar[bool](t, database, `SELECT "archivedAt" IS NOT NULL FROM chat_groups WHERE id = $1`, group); archived {
		t.Fatal("the group must be live after restore")
	}
	if archived := systemScalar[bool](t, database, `SELECT "archivedAt" IS NOT NULL FROM bots WHERE id = $1`, archivedBot); archived {
		t.Fatal("the archived member bot must be live after restore")
	}
	for _, id := range []string{memberRoutine, liveRoutine} {
		state := routineState(t, database, id)
		if !state.Active || state.ResumeOnRestore || state.NextRunAt == nil {
			t.Fatalf("routine %s = %+v, want it resumed", id, state)
		}
		if count := routineJobs(t, database, id); count != 1 {
			t.Fatalf("routine %s jobs = %d, want 1", id, count)
		}
	}
	theirs := routineState(t, database, otherRoutine)
	if theirs.Active || !theirs.ResumeOnRestore || theirs.NextRunAt != nil {
		t.Fatalf("another member's routine = %+v, want it untouched", theirs)
	}
	if count := routineJobs(t, database, otherRoutine); count != 0 {
		t.Fatalf("another member's routine jobs = %d, want 0", count)
	}
}
