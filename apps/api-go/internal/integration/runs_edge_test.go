package integration

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/contentcrypto"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/runs"
)

func uniqueSuffix() string { return time.Now().Format("150405.000000000") }

func TestCancelActiveDedupesInputIds(t *testing.T) {
	database := openTestDB(t)
	fixture := seedRunsFixture(t, database)
	created := createRun(t, database, fixture, runs.CreateInput{}, nil)
	var cancelled []runs.Cancelled
	err := database.System(context.Background(), "cancel duplicate ids", func(tx pgx.Tx) error {
		var err error
		cancelled, err = runs.Canceller{Ring: contentcrypto.NoEncryptionKeyRing()}.
			CancelActive(context.Background(), tx, []string{created.RunID, created.RunID}, time.Now(), nil)
		return err
	})
	if err != nil {
		t.Fatalf("cancel: %v", err)
	}
	if len(cancelled) != 1 || cancelled[0].ID != created.RunID {
		t.Fatalf("cancelled = %+v, want the run once", cancelled)
	}
}

func TestCancelConversationRequiresTheActorsSpace(t *testing.T) {
	database := openTestDB(t)
	fixture := seedRunsFixture(t, database)
	created := createRun(t, database, fixture, runs.CreateInput{}, nil)
	err := database.System(context.Background(), "cancel without a space", func(tx pgx.Tx) error {
		_, err := runs.Canceller{Ring: contentcrypto.NoEncryptionKeyRing()}.CancelConversation(
			context.Background(), tx,
			runs.ConversationTarget{ThreadID: fixture.threadID, BotIDs: []string{fixture.botID}},
			time.Now(), nil)
		return err
	})
	if err == nil || !strings.Contains(err.Error(), "space") {
		t.Fatalf("cancel without a space = %v", err)
	}
	if got := runRow(t, database, created.RunID)["status"]; got != "queued" {
		t.Fatalf("refused cancel wrote status = %v", got)
	}
}

func TestCancelActiveForThreadRefusesAForeignRun(t *testing.T) {
	database := openTestDB(t)
	fixture := seedRunsFixture(t, database)
	created := createRun(t, database, fixture, runs.CreateInput{}, nil)
	otherThread := "th-other-" + uniqueSuffix()
	exec(t, database, `INSERT INTO threads (id, "spaceId", "userId", "botId", "nextMessageSeq", "nextEventSeq", "createdAt")
		VALUES ($1, $2, $3, $4, 1, 1, now())`, otherThread, fixture.spaceID, fixture.userID, fixture.botID)
	_, err := runs.Canceller{Ring: contentcrypto.NoEncryptionKeyRing()}.CancelActiveForThread(
		context.Background(), database,
		db.Actor{SpaceID: fixture.spaceID, UserID: fixture.userID},
		otherThread, []string{created.RunID}, time.Now(), nil)
	if err == nil || !strings.Contains(err.Error(), "not in thread") {
		t.Fatalf("foreign run = %v", err)
	}
	if got := runRow(t, database, created.RunID)["status"]; got != "queued" {
		t.Fatalf("refused cancel wrote status = %v", got)
	}
}

func TestCreateRefusesOwnersOutsideTheSpace(t *testing.T) {
	database := openTestDB(t)
	fixture := seedRunsFixture(t, database)
	otherBot := "bot-other-" + uniqueSuffix()
	otherThread := "th-other-" + uniqueSuffix()
	exec(t, database, `INSERT INTO bots (id, "spaceId", "userId", name, color, "createdAt", "updatedAt")
		VALUES ($1, $2, $3, 'Other Bot', 'blue', now(), now())`, otherBot, fixture.space2, fixture.userID)
	exec(t, database, `INSERT INTO threads (id, "spaceId", "userId", "botId", "nextMessageSeq", "nextEventSeq", "createdAt")
		VALUES ($1, $2, $3, $4, 1, 1, now())`, otherThread, fixture.space2, fixture.userID, otherBot)
	create := func(botID, threadID string) error {
		return database.System(context.Background(), "create with foreign owners", func(tx pgx.Tx) error {
			_, err := runs.Create(context.Background(), tx, runs.CreateInput{
				SpaceID: fixture.spaceID, BotID: botID, ThreadID: threadID,
				UserID: fixture.userID, Prompt: "p", Trigger: "user",
			})
			return err
		})
	}
	if err := create(otherBot, fixture.threadID); err == nil || !strings.Contains(err.Error(), "not in space") {
		t.Fatalf("foreign bot = %v", err)
	}
	if err := create(fixture.botID, otherThread); err == nil || !strings.Contains(err.Error(), "not in space") {
		t.Fatalf("foreign thread = %v", err)
	}
	if got := systemScalar[int64](t, database, `SELECT count(*) FROM runs WHERE "spaceId" = $1`, fixture.spaceID); got != 0 {
		t.Fatalf("refused creates wrote %d runs", got)
	}
}

func TestSupersedeQueuedCancelsARunClaimedAfterTheSelect(t *testing.T) {
	database := openTestDB(t)
	fixture := seedRunsFixture(t, database)
	ctx := context.Background()
	messageID := "msg-source-" + uniqueSuffix()
	exec(t, database, `INSERT INTO messages (id, "threadId", seq, role, blocks, "createdAt")
		VALUES ($1, $2, 1, 'user', '[{"kind":"text","text":"first"}]'::jsonb, now())`,
		messageID, fixture.threadID)
	taskID := "task-race-" + uniqueSuffix()
	exec(t, database, `INSERT INTO tasks (id, "spaceId", "botId", "threadId", "userId", prompt, status, "createdAt", "updatedAt")
		VALUES ($1, $2, $3, $4, $5, 'first', 'queued', now(), now())`,
		taskID, fixture.spaceID, fixture.botID, fixture.threadID, fixture.userID)
	runID := "run-race-" + uniqueSuffix()
	exec(t, database, `INSERT INTO runs (id, "spaceId", "botId", "threadId", "taskId", "userId", status, trigger, "sourceMessageId", "createdAt", "updatedAt")
		VALUES ($1, $2, $3, $4, $5, $6, 'queued', 'user', $7, now(), now())`,
		runID, fixture.spaceID, fixture.botID, fixture.threadID, taskID, fixture.userID, messageID)

	// Another transaction claims the run and keeps the row lock until the
	// supersede has selected (it still sees queued) and blocked on its update.
	locked := make(chan struct{})
	release := make(chan struct{})
	held := make(chan error, 1)
	go func() {
		held <- database.System(ctx, "hold the claimed run", func(tx pgx.Tx) error {
			if _, err := tx.Exec(ctx, `UPDATE runs SET status = 'leased', "leaseOwner" = 'race-worker', "leaseFence" = 1 WHERE id = $1`, runID); err != nil {
				return err
			}
			close(locked)
			<-release
			return nil
		})
	}()
	<-locked
	done := make(chan error, 1)
	go func() {
		done <- database.System(ctx, "supersede a claimed run", func(tx pgx.Tx) error {
			_, err := runs.Canceller{Ring: contentcrypto.NoEncryptionKeyRing()}.SupersedeQueued(
				ctx, tx, fixture.threadID, []string{fixture.botID}, nil, time.Now(), nil)
			return err
		})
	}()
	deadline := time.Now().Add(5 * time.Second)
	for {
		var waiting bool
		if err := database.Pool.QueryRow(ctx, `SELECT EXISTS (
			SELECT 1 FROM pg_stat_activity
			WHERE state = 'active' AND wait_event_type = 'Lock'
			  AND query ILIKE '%UPDATE runs SET status = ''cancelled''%')`).Scan(&waiting); err != nil {
			t.Fatalf("poll lock: %v", err)
		}
		if waiting {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("supersede never blocked on the claimed run")
		}
		time.Sleep(20 * time.Millisecond)
	}
	close(release)
	if err := <-held; err != nil {
		t.Fatalf("holder: %v", err)
	}
	if err := <-done; err != nil {
		t.Fatalf("supersede: %v", err)
	}
	if got := runRow(t, database, runID)["status"]; got != "cancelled" {
		t.Fatalf("claimed run = %v, want cancelled (the TS race)", got)
	}
}
