package runs

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
)

// ThreadLockTimeout is THREAD_LOCK_TRANSACTION_OPTIONS.timeout
// (packages/db/src/database/transaction-retry.ts:9-11): a transaction that takes
// the thread row is given 20 seconds for its whole body, and a conflict is not
// retried. Only the timeout is shared; there is no maxWait, as in TS. A var so
// the integration test can shorten the wait; SetThreadLockTimeoutForTest is its
// only other writer.
var ThreadLockTimeout = 20 * time.Second

// SetThreadLockTimeoutForTest shortens the thread-lock wait and returns the
// restore. Tests only.
func SetThreadLockTimeoutForTest(timeout time.Duration) func() {
	previous := ThreadLockTimeout
	ThreadLockTimeout = timeout
	return func() { ThreadLockTimeout = previous }
}

// ErrLockTimeout stands for Prisma's P2028 when the transaction's budget ran out
// while it waited for the thread row. P2028 is not in UNAVAILABLE_CODES
// (packages/db/src/client.ts:167-194), so the API answers the generic 500
// (shared.Failure), not the 503 a lost database gets.
var ErrLockTimeout = errors.New("the thread lock wait expired")

// LockThread is the `SELECT id FROM threads WHERE id = $1 FOR UPDATE` every
// thread write takes first (thread-stop.ts:78, events.ts:478). A thread this
// tenant cannot see is not an error here: the write that follows decides, as
// the Prisma path's later update does.
func LockThread(ctx context.Context, tx pgx.Tx, threadID string) error {
	var locked string
	err := tx.QueryRow(ctx, `SELECT id FROM threads WHERE id = $1 FOR UPDATE`, threadID).Scan(&locked)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	return nil
}

// ThreadLockTransaction runs fn in the tenant transaction
// THREAD_LOCK_TRANSACTION_OPTIONS describes: the thread row is locked first and
// the whole body is bounded by ThreadLockTimeout. A wait that runs out is
// ErrLockTimeout, the generic 500 TS returns rather than the 503 a lost
// database gets.
//
// The Go gateway sets no per-request transaction deadline, so every procedure
// that takes the thread lock (CancelConversation, a send or answer that writes
// run rows under it) must run its body through this helper; otherwise a held
// thread lock waits indefinitely.
func ThreadLockTransaction(
	ctx context.Context,
	database *db.DB,
	actor db.Actor,
	threadID string,
	fn func(context.Context, pgx.Tx) error,
) error {
	runCtx, cancel := context.WithTimeout(ctx, ThreadLockTimeout)
	defer cancel()
	err := database.Tenant(runCtx, actor, func(tx pgx.Tx) error {
		if err := LockThread(runCtx, tx, threadID); err != nil {
			return err
		}
		return fn(runCtx, tx)
	})
	if lockExpired(runCtx, err) {
		return ErrLockTimeout
	}
	return err
}

// lockExpired reports whether err is the transaction's budget running out: its
// own deadline, or the statement Postgres cancelled because of it. A failure
// raised on purpose is never.
func lockExpired(ctx context.Context, err error) bool {
	if err == nil || ctx.Err() == nil {
		return false
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return true
	}
	var postgres interface{ SQLState() string }
	return errors.As(err, &postgres) && postgres.SQLState() == "57014"
}
