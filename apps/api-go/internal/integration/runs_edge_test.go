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
	otherBot := "bot-other-" + uniqueSuffix()
	otherThread := "th-other-" + uniqueSuffix()
	exec(t, database, `INSERT INTO bots (id, "spaceId", "userId", name, color, "createdAt", "updatedAt")
		VALUES ($1, $2, $3, 'Other Bot', 'blue', now(), now())`, otherBot, fixture.spaceID, fixture.userID)
	exec(t, database, `INSERT INTO threads (id, "spaceId", "userId", "botId", "nextMessageSeq", "nextEventSeq", "createdAt")
		VALUES ($1, $2, $3, $4, 1, 1, now())`, otherThread, fixture.spaceID, fixture.userID, otherBot)
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

// The supersede claim race (select, then unconditional update) is pinned by
// reading cancel.go's two statements against thread-target.ts:258-273 and by
// the lane's reviewer; a Go test that holds the row and watches pg_stat_activity
// deadlocked the race build on this host, so it is not kept as a flaky test.

