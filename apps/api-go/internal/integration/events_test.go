package integration

import (
	"context"
	"errors"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/contentcrypto"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/events"
)

type eventsFixture struct {
	userID, spaceID, botID, threadID, taskID, runID string
}

func seedEventsFixture(t *testing.T, database *db.DB) eventsFixture {
	t.Helper()
	suffix := strconv.FormatInt(time.Now().UnixNano(), 36)
	fixture := eventsFixture{
		userID:   "u-ev-" + suffix,
		spaceID:  "sp-ev-" + suffix,
		botID:    "bot-ev-" + suffix,
		threadID: "th-ev-" + suffix,
		taskID:   "task-ev-" + suffix,
		runID:    "run-ev-" + suffix,
	}
	ctx := context.Background()
	err := database.System(ctx, "seed events fixture", func(tx pgx.Tx) error {
		orgID := "org-ev-" + suffix
		steps := []struct {
			sql  string
			args []any
		}{
			{`INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
			  VALUES ($1, 'Events User', $2, true, now(), now())`, []any{fixture.userID, fixture.userID + "@example.test"}},
			{`INSERT INTO organization (id, name, slug, "createdAt") VALUES ($1, 'Events Org', $2, now())`,
				[]any{orgID, "org-ev-" + suffix}},
			{`INSERT INTO spaces (id, "organizationId", name, "isDefault", "createdAt")
			  VALUES ($1, $2, 'Events Space', true, now())`, []any{fixture.spaceID, orgID}},
			{`INSERT INTO bots (id, "spaceId", "userId", name, color, "createdAt", "updatedAt")
			  VALUES ($1, $2, $3, 'Events Bot', 'blue', now(), now())`,
				[]any{fixture.botID, fixture.spaceID, fixture.userID}},
			{`INSERT INTO threads (id, "spaceId", "userId", "botId", "createdAt")
			  VALUES ($1, $2, $3, $4, now())`,
				[]any{fixture.threadID, fixture.spaceID, fixture.userID, fixture.botID}},
			{`INSERT INTO tasks (id, "spaceId", "botId", "threadId", "userId", prompt, status, "createdAt", "updatedAt")
			  VALUES ($1, $2, $3, $4, $5, 'proof', 'running', now(), now())`,
				[]any{fixture.taskID, fixture.spaceID, fixture.botID, fixture.threadID, fixture.userID}},
			{`INSERT INTO runs (id, "spaceId", "botId", "threadId", "taskId", "userId", status, trigger,
				"leaseOwner", "leaseFence", "startedAt", "createdAt", "updatedAt")
			  VALUES ($1, $2, $3, $4, $5, $6, 'running', 'user', 'worker-1', 1, now(), now(), now())`,
				[]any{fixture.runID, fixture.spaceID, fixture.botID, fixture.threadID, fixture.taskID, fixture.userID}},
		}
		for _, step := range steps {
			if _, err := tx.Exec(ctx, step.sql, step.args...); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		t.Fatalf("seed: %v", err)
	}
	return fixture
}

func appendInSystem(ctx context.Context, database *db.DB, ring *contentcrypto.KeyRing,
	input events.Input, inTx bool) (events.Event, error) {
	var event events.Event
	err := database.System(ctx, "append a test event", func(tx pgx.Tx) error {
		var appendErr error
		if inTx {
			event, appendErr = events.AppendTx(ctx, tx, ring, input)
		} else {
			event, appendErr = events.Append(ctx, tx, ring, input)
		}
		return appendErr
	})
	return event, err
}

func TestAppendAllocatesGapFreeSeqs(t *testing.T) {
	database := openTestDB(t)
	fixture := seedEventsFixture(t, database)
	ring := keyedRing(t, database)
	ctx := context.Background()

	for index := range 3 {
		event, err := appendInSystem(ctx, database, ring, events.Input{
			SpaceID: fixture.spaceID, ThreadID: fixture.threadID, BotID: fixture.botID,
			Type: "thread.progress", Payload: map[string]any{"delta": "chunk", "streaming": true},
		}, false)
		if err != nil {
			t.Fatalf("append %d: %v", index, err)
		}
		if event.Seq != int32(index) {
			t.Fatalf("seq %d = %d", index, event.Seq)
		}
		if event.Payload["delta"] != "chunk" {
			t.Fatalf("returned payload = %#v", event.Payload)
		}
	}
	var raw string
	if err := database.System(ctx, "read raw event", func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT payload::text FROM events WHERE "threadId" = $1 ORDER BY seq LIMIT 1`,
			fixture.threadID).Scan(&raw)
	}); err != nil {
		t.Fatalf("read raw: %v", err)
	}
	if strings.Contains(raw, "chunk") {
		t.Fatalf("stored payload is not sealed: %s", raw)
	}

	// Appended inside an existing transaction, the same thread continues.
	second, err := appendInSystem(ctx, database, ring, events.Input{
		SpaceID: fixture.spaceID, ThreadID: fixture.threadID, BotID: fixture.botID,
		Type: "thread.meta", Payload: map[string]any{"activity": map[string]any{"thinking": false}},
		RunID: fixture.runID, Lease: &events.Lease{Owner: "worker-1", Fence: 1},
	}, true)
	if err != nil {
		t.Fatalf("append tx: %v", err)
	}
	if second.Seq != 3 {
		t.Fatalf("transactional seq = %d, want 3", second.Seq)
	}
	var next int32
	if err := database.System(ctx, "read next seq", func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT "nextEventSeq" FROM threads WHERE id = $1`, fixture.threadID).Scan(&next)
	}); err != nil {
		t.Fatalf("next seq: %v", err)
	}
	if next != 4 {
		t.Fatalf("nextEventSeq = %d, want 4", next)
	}
}

func TestAppendConcurrentlyKeepsSeqsDistinct(t *testing.T) {
	database := openTestDB(t)
	fixture := seedEventsFixture(t, database)
	ring := keyedRing(t, database)
	ctx := context.Background()
	const writers = 12
	var wait sync.WaitGroup
	seqs := make([]int32, writers)
	errs := make([]error, writers)
	for index := range writers {
		wait.Add(1)
		go func() {
			defer wait.Done()
			event, err := appendInSystem(ctx, database, ring, events.Input{
				SpaceID: fixture.spaceID, ThreadID: fixture.threadID, BotID: fixture.botID,
				Type: "thread.progress", Payload: map[string]any{"delta": "x", "streaming": true},
			}, false)
			seqs[index], errs[index] = event.Seq, err
		}()
	}
	wait.Wait()
	seen := map[int32]bool{}
	for index, err := range errs {
		if err != nil {
			t.Fatalf("writer %d: %v", index, err)
		}
		if seen[seqs[index]] {
			t.Fatalf("duplicate seq %d", seqs[index])
		}
		seen[seqs[index]] = true
	}
	for index := range int32(writers) {
		if !seen[index] {
			t.Fatalf("seq %d missing from %v", index, seqs)
		}
	}
}

func TestAppendEnforcesRunHistoryRules(t *testing.T) {
	database := openTestDB(t)
	fixture := seedEventsFixture(t, database)
	ring := keyedRing(t, database)
	ctx := context.Background()

	base := events.Input{
		SpaceID: fixture.spaceID, ThreadID: fixture.threadID, BotID: fixture.botID,
		Type: "thread.progress", Payload: map[string]any{"delta": "x", "streaming": true},
		RunID: fixture.runID,
	}
	if _, err := appendInSystem(ctx, database, ring, base, false); err != nil {
		t.Fatalf("append: %v", err)
	}
	if _, err := appendInSystem(ctx, database, ring, events.Input{
		SpaceID: fixture.spaceID, ThreadID: fixture.threadID, BotID: fixture.botID,
		Type: "run.cancelled", Payload: map[string]any{},
	}, false); !errors.Is(err, events.ErrRunHistoryWrite) {
		t.Fatalf("run.cancelled without a run = %v", err)
	}
	superseded := base
	superseded.Lease = &events.Lease{Owner: "worker-2", Fence: 2}
	if _, err := appendInSystem(ctx, database, ring, superseded, false); !errors.Is(err, events.ErrRunHistoryWrite) {
		t.Fatalf("superseded lease = %v", err)
	}
	if err := database.System(ctx, "cancel the run", func(tx pgx.Tx) error {
		tag, err := tx.Exec(ctx, `UPDATE runs SET status = 'cancelled' WHERE id = $1`, fixture.runID)
		if err != nil {
			return err
		}
		if tag.RowsAffected() != 1 {
			return errors.New("run not updated")
		}
		return nil
	}); err != nil {
		t.Fatalf("cancel run: %v", err)
	}
	if _, err := appendInSystem(ctx, database, ring, base, false); !errors.Is(err, events.ErrRunHistoryWrite) {
		t.Fatalf("cancelled run = %v", err)
	}
	allowed := base
	allowed.AllowCancelledRun = true
	if _, err := appendInSystem(ctx, database, ring, allowed, false); err != nil {
		t.Fatalf("allowCancelledRun: %v", err)
	}
	cancelled := base
	cancelled.Type = "run.cancelled"
	cancelled.Payload = map[string]any{}
	if _, err := appendInSystem(ctx, database, ring, cancelled, false); err != nil {
		t.Fatalf("run.cancelled: %v", err)
	}
	// A thinking marker must be exactly the schema and carry a lease.
	if _, err := appendInSystem(ctx, database, ring, events.Input{
		SpaceID: fixture.spaceID, ThreadID: fixture.threadID, BotID: fixture.botID,
		Type: "thread.meta", Payload: map[string]any{"activity": map[string]any{"thinking": true}},
		RunID: fixture.runID,
	}, false); !errors.Is(err, events.ErrRunHistoryWrite) {
		t.Fatalf("activity without lease = %v", err)
	}
}

func TestAppendRecordsFirstResponse(t *testing.T) {
	database := openTestDB(t)
	fixture := seedEventsFixture(t, database)
	ring := keyedRing(t, database)
	ctx := context.Background()
	payload := map[string]any{
		"messageId": "msg-1",
		"role":      "bot",
		"blocks":    []any{map[string]any{"kind": "text", "text": "hello"}},
	}
	first, err := appendInSystem(ctx, database, ring, events.Input{
		SpaceID: fixture.spaceID, ThreadID: fixture.threadID, BotID: fixture.botID,
		Type: "thread.message.created", Payload: payload, RunID: fixture.runID,
	}, false)
	if err != nil {
		t.Fatalf("append: %v", err)
	}
	if !first.FirstResponse {
		t.Fatal("first response not recorded")
	}
	second, err := appendInSystem(ctx, database, ring, events.Input{
		SpaceID: fixture.spaceID, ThreadID: fixture.threadID, BotID: fixture.botID,
		Type: "thread.message.created", Payload: payload, RunID: fixture.runID,
	}, true)
	if err != nil {
		t.Fatalf("append tx: %v", err)
	}
	if second.FirstResponse {
		t.Fatal("second response recorded again")
	}
	var firstResponseAt *time.Time
	if err := database.System(ctx, "read first response", func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT "firstResponseAt" FROM runs WHERE id = $1`, fixture.runID).Scan(&firstResponseAt)
	}); err != nil {
		t.Fatalf("read run: %v", err)
	}
	if firstResponseAt == nil || firstResponseAt.UnixMilli() != first.CreatedAt.UnixMilli() {
		t.Fatalf("firstResponseAt = %v, event at %v", firstResponseAt, first.CreatedAt)
	}

	timing := events.ReadRunTimingFields(ctx, database, fixture.runID)
	if timing["run.trigger"] != "user" {
		t.Fatalf("timing = %#v", timing)
	}
	if _, ok := timing["run.first_response_ms"]; !ok {
		t.Fatalf("timing lacks first response: %#v", timing)
	}
}

func TestNotifyCommittedPublishesExactEnvelope(t *testing.T) {
	database := openTestDB(t)
	fixture := seedEventsFixture(t, database)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	connection, err := database.Pool.Acquire(ctx)
	if err != nil {
		t.Fatalf("acquire: %v", err)
	}
	defer connection.Release()
	if _, err := connection.Exec(ctx, `LISTEN rakazo_events`); err != nil {
		t.Fatalf("listen: %v", err)
	}
	publisher := &events.PGPublisher{Pool: database.Pool}
	events.NotifyCommitted(ctx, publisher, nil, nil, fixture.threadID, 7, "")
	notification, err := connection.Conn().WaitForNotification(ctx)
	if err != nil {
		t.Fatalf("wait: %v", err)
	}
	expected := `{"topic":"thread:` + fixture.threadID + `","payload":"{\"cursor\":7}"}`
	if notification.Channel != events.RealtimeChannel || notification.Payload != expected {
		t.Fatalf("notification = %s %s, want %s", notification.Channel, notification.Payload, expected)
	}
}
