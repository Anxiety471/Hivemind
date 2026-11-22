package integration

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/shared"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/runs"
)

// TestCancelConversationLockTimeoutIsAGeneric500 holds the thread row past the
// transaction budget, as a concurrent writer does. TypeScript's Prisma gives the
// thread-lock transaction 20 s and fails with P2028, which is not an outage, so
// the API answers the generic 500 rather than the 503 a lost database gets
// (transaction-retry.ts:9-11, packages/db/src/client.ts:167-194).
func TestCancelConversationLockTimeoutIsAGeneric500(t *testing.T) {
	database := openTestDB(t)
	fixture := seedRunsFixture(t, database)
	ctx := context.Background()
	created := createRun(t, database, fixture, runs.CreateInput{}, nil)
	actor := db.Actor{UserID: fixture.userID, SpaceID: fixture.spaceID}

	restore := runs.SetThreadLockTimeoutForTest(300 * time.Millisecond)
	defer restore()

	// Another writer takes the row's lock and keeps it until the cancel has
	// given up.
	holder, stop := context.WithTimeout(ctx, 30*time.Second)
	defer stop()
	locked := make(chan struct{})
	release := make(chan struct{})
	held := make(chan error, 1)
	go func() {
		held <- database.System(holder, "hold the thread row", func(tx pgx.Tx) error {
			if _, err := tx.Exec(holder, `SELECT id FROM threads WHERE id = $1 FOR UPDATE`, fixture.threadID); err != nil {
				return err
			}
			close(locked)
			<-release
			return nil
		})
	}()
	<-locked

	started := time.Now()
	_, err := runs.Canceller{Ring: plainRing()}.CancelConversationFor(ctx, database, actor, runs.ConversationTarget{
		SpaceID:  fixture.spaceID,
		ThreadID: fixture.threadID,
		BotIDs:   []string{fixture.botID},
		Note:     &runs.Note{BotID: fixture.botID, Text: runs.StoppedByMessageNote},
		WriteNote: func(ctx context.Context, tx pgx.Tx, note runs.Note) (int32, error) {
			t.Error("a cancel that never got the lock must not write a note")
			return 0, nil
		},
	}, time.Now(), nil)
	close(release)
	if err := <-held; err != nil {
		t.Fatalf("the lock holder failed: %v", err)
	}
	if !errors.Is(err, runs.ErrLockTimeout) {
		t.Fatalf("cancel = %v, want ErrLockTimeout", err)
	}
	// P2028 is not an unavailable database: the caller maps it to the generic 500.
	if db.IsUnavailable(err) {
		t.Fatal("a lock timeout must not read as an outage")
	}
	failure := shared.Failure(err)
	if failure.Status != 500 || failure.Code != "INTERNAL_SERVER_ERROR" || failure.Message != "Internal server error" {
		t.Fatalf("failure = %+v", failure)
	}
	if elapsed := time.Since(started); elapsed > 10*time.Second {
		t.Fatalf("the wait took %s, so it never reached the shortened budget", elapsed)
	}
	// The transaction rolled back: the run is untouched and no event was written.
	if got := runRow(t, database, created.RunID)["status"]; got != "queued" {
		t.Fatalf("run status = %v, want queued", got)
	}
	if got := systemScalar[int64](t, database,
		`SELECT count(*) FROM events WHERE "threadId" = $1`, fixture.threadID); got != 0 {
		t.Fatalf("events = %d, want none", got)
	}
}
