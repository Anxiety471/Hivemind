package integration

import (
	"context"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/onboarding"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/shared"
)

// TestThreadLockTimeoutIsAGeneric500 holds the thread row past the transaction's budget, as a
// concurrent writer does: Prisma fails with P2028, which is not an outage, so the API answers the
// generic 500 rather than the 503 a lost database gets (rpc-errors.ts:150-180).
func TestThreadLockTimeoutIsAGeneric500(t *testing.T) {
	database := openTestDB(t)
	s := seed(t, database)
	ring := keyedRing(t, database)
	actor := db.Actor{UserID: s.UserID, SpaceID: s.Space1}
	ctx := context.Background()
	bot := "bot-lock-" + s.UserID
	thread := "th-lock-" + s.UserID
	addBot(t, database, bot, s.Space1, s.UserID, "Locked bot")
	exec(t, database, `INSERT INTO threads (id, "spaceId", "userId", "botId", "nextMessageSeq", "nextEventSeq")
		VALUES ($1, $2, $3, $4, 0, 0)`, thread, s.Space1, s.UserID, bot)

	restore := onboarding.SetThreadLockTimeoutForTest(300 * time.Millisecond)
	defer restore()

	// Another writer takes the row's lock and keeps it until the procedure has given up.
	holder, stop := context.WithTimeout(ctx, 30*time.Second)
	defer stop()
	locked := make(chan struct{})
	release := make(chan struct{})
	held := make(chan error, 1)
	go func() {
		held <- database.Tenant(holder, actor, func(tx pgx.Tx) error {
			if _, err := tx.Exec(holder, `SELECT id FROM threads WHERE id = $1 FOR UPDATE`, thread); err != nil {
				return err
			}
			close(locked)
			<-release
			return nil
		})
	}()
	<-locked

	deployment := shared.Deployment{Content: ring}
	started := time.Now()
	_, failure := onboarding.PromptFocus(ctx, database, deployment, actor, raw(`{"botId":"`+bot+`"}`))
	close(release)
	if err := <-held; err != nil {
		t.Fatalf("the lock holder failed: %v", err)
	}
	if failure == nil {
		t.Fatal("an expired lock wait must fail")
	}
	if failure.Status != 500 || failure.Code != "INTERNAL_SERVER_ERROR" || failure.Message != "Internal server error" {
		t.Fatalf("failure = %+v", failure)
	}
	if elapsed := time.Since(started); elapsed > 10*time.Second {
		t.Fatalf("the wait took %s, so it never reached the shortened budget", elapsed)
	}
	// Nothing was written.
	if got := systemScalar[int64](t, database, `SELECT count(*) FROM messages WHERE "threadId" = $1`, thread); got != 0 {
		t.Fatalf("messages = %d", got)
	}
	if got := systemScalar[int64](t, database, `SELECT "nextMessageSeq" FROM threads WHERE id = $1`, thread); got != 0 {
		t.Fatalf("nextMessageSeq = %d", got)
	}
}
