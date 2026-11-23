package integration

import (
	"context"
	"errors"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/contentcrypto"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/effects"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/runs"
)

type runsFixture struct {
	userID, spaceID, space2, botID, threadID string
}

func seedRunsFixture(t *testing.T, database *db.DB) runsFixture {
	t.Helper()
	suffix := strconv.FormatInt(time.Now().UnixNano(), 36)
	fixture := runsFixture{
		userID:   "u-rn-" + suffix,
		spaceID:  "sp-rn-" + suffix,
		space2:   "sp-rn2-" + suffix,
		botID:    "bot-rn-" + suffix,
		threadID: "th-rn-" + suffix,
	}
	ctx := context.Background()
	err := database.System(ctx, "seed runs fixture", func(tx pgx.Tx) error {
		orgID := "org-rn-" + suffix
		steps := []struct {
			sql  string
			args []any
		}{
			{`INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
			  VALUES ($1, 'Runs User', $2, true, now(), now())`, []any{fixture.userID, fixture.userID + "@example.test"}},
			{`INSERT INTO organization (id, name, slug, "createdAt") VALUES ($1, 'Runs Org', $2, now())`,
				[]any{orgID, "org-rn-" + suffix}},
			{`INSERT INTO spaces (id, "organizationId", name, "isDefault", "createdAt")
			  VALUES ($1, $2, 'Runs Space', true, now())`, []any{fixture.spaceID, orgID}},
			{`INSERT INTO spaces (id, "organizationId", name, "isDefault", "createdAt")
			  VALUES ($1, $2, 'Runs Space Two', false, now())`, []any{fixture.space2, orgID}},
			{`INSERT INTO bots (id, "spaceId", "userId", name, color, "createdAt", "updatedAt")
			  VALUES ($1, $2, $3, 'Runs Bot', 'blue', now(), now())`,
				[]any{fixture.botID, fixture.spaceID, fixture.userID}},
			{`INSERT INTO threads (id, "spaceId", "userId", "botId", "nextMessageSeq", "nextEventSeq", "createdAt")
			  VALUES ($1, $2, $3, $4, 1, 1, now())`,
				[]any{fixture.threadID, fixture.spaceID, fixture.userID, fixture.botID}},
		}
		for _, step := range steps {
			if _, err := tx.Exec(ctx, step.sql, step.args...); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		t.Fatalf("seed runs fixture: %v", err)
	}
	t.Cleanup(func() {
		ctx := context.Background()
		_ = database.System(ctx, "clean runs fixture", func(tx pgx.Tx) error {
			_, err := tx.Exec(ctx, `DELETE FROM spaces WHERE id = ANY($1::text[])`,
				[]string{fixture.spaceID, fixture.space2})
			return err
		})
	})
	return fixture
}

func createRun(t *testing.T, database *db.DB, fixture runsFixture, input runs.CreateInput, mutate func(*runs.CreateInput)) runs.Created {
	t.Helper()
	input.SpaceID = fixture.spaceID
	input.BotID = fixture.botID
	input.ThreadID = fixture.threadID
	input.UserID = fixture.userID
	if input.Trigger == "" {
		input.Trigger = "user"
	}
	if input.Prompt == "" {
		input.Prompt = "say hello"
	}
	if mutate != nil {
		mutate(&input)
	}
	var created runs.Created
	err := database.System(context.Background(), "create a test run", func(tx pgx.Tx) error {
		var err error
		created, err = runs.Create(context.Background(), tx, input)
		return err
	})
	if err != nil {
		t.Fatalf("create run: %v", err)
	}
	return created
}

func runRow(t *testing.T, database *db.DB, runID string) map[string]any {
	t.Helper()
	var row map[string]any
	err := database.System(context.Background(), "read a test run", func(tx pgx.Tx) error {
		rows, err := tx.Query(context.Background(), `SELECT * FROM runs WHERE id = $1`, runID)
		if err != nil {
			return err
		}
		defer rows.Close()
		fields := rows.FieldDescriptions()
		if !rows.Next() {
			return errors.New("run not found")
		}
		values, err := rows.Values()
		if err != nil {
			return err
		}
		row = map[string]any{}
		for index, field := range fields {
			row[string(field.Name)] = values[index]
		}
		return rows.Err()
	})
	if err != nil {
		t.Fatalf("read run %s: %v", runID, err)
	}
	return row
}

func strPtr(value string) *string { return &value }

func TestCreateRunWritesTheTypeScriptRow(t *testing.T) {
	database := openTestDB(t)
	fixture := seedRunsFixture(t, database)
	nonce := "send:msg-" + strconv.FormatInt(time.Now().UnixNano(), 36)
	at := time.Date(2026, 11, 22, 10, 0, 0, 123_000_000, time.UTC)
	created := createRun(t, database, fixture, runs.CreateInput{
		Trigger:     "user",
		ClientNonce: &nonce,
		Model:       &runs.ModelPin{Provider: "openai", Model: "gpt-x", Thinking: strPtr("high"), Pinned: true},
		Now:         at,
	}, nil)

	row := runRow(t, database, created.RunID)
	cases := map[string]any{
		"spaceId":            fixture.spaceID,
		"botId":              fixture.botID,
		"threadId":           fixture.threadID,
		"userId":             fixture.userID,
		"taskId":             created.TaskID,
		"status":             "queued",
		"trigger":            "user",
		"modelProvider":      "openai",
		"modelId":            "gpt-x",
		"thinkingLevel":      "high",
		"modelPinned":        true,
		"groupReplyOptional": false,
		"leaseFence":         int32(0),
		"clientNonce":        nonce,
		"wakeAt":             nil,
		"leaseOwner":         nil,
		"leaseExpiresAt":     nil,
		"checkpoint":         nil,
		"startedAt":          nil,
		"completedAt":        nil,
		"retryOfRunId":       nil,
	}
	for column, want := range cases {
		if got := row[column]; got != want {
			t.Errorf("runs.%s = %v, want %v", column, got, want)
		}
	}
	if !row["createdAt"].(time.Time).Equal(at) || !row["updatedAt"].(time.Time).Equal(at) {
		t.Errorf("timestamps = %v/%v, want %v", row["createdAt"], row["updatedAt"], at)
	}
	task := systemScalar[string](t, database, `SELECT status || '|' || prompt FROM tasks WHERE id = $1`, created.TaskID)
	if task != "queued|say hello" {
		t.Errorf("task = %q", task)
	}
	if len(created.RunID) != 25 || created.RunID[0] != 'c' {
		t.Errorf("run id %q is not a cuid", created.RunID)
	}
}

func TestWakePublishesTheTypeScriptFrame(t *testing.T) {
	database := openTestDB(t)
	fixture := seedRunsFixture(t, database)
	created := createRun(t, database, fixture, runs.CreateInput{}, nil)

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	conn, err := pgx.Connect(ctx, mustEnv(t, "RAKAZO_TEST_DATABASE_URL"))
	if err != nil {
		t.Fatalf("listen connection: %v", err)
	}
	defer conn.Close(ctx)
	if _, err := conn.Exec(ctx, "LISTEN rakazo_events"); err != nil {
		t.Fatalf("listen: %v", err)
	}

	notifier := effects.NewNotifier(database, nil)
	at := time.Date(2026, 11, 22, 11, 0, 0, 456_000_000, time.UTC)
	actor := db.Actor{SpaceID: fixture.spaceID, UserID: fixture.userID}
	changed, err := runs.WakeFor(ctx, database, actor, notifier, created.RunID, runs.WakeOptions{At: at, Now: at})
	if err != nil {
		t.Fatalf("wake: %v", err)
	}
	if !changed {
		t.Fatal("wake reported no change for a queued run")
	}
	notifier.Wait()
	notification, err := conn.WaitForNotification(ctx)
	if err != nil {
		t.Fatalf("notification: %v", err)
	}
	want := `{"topic":"runs:ready","payload":"` + created.RunID + `"}`
	if notification.Payload != want {
		t.Fatalf("frame = %s, want %s", notification.Payload, want)
	}
	row := runRow(t, database, created.RunID)
	if !row["wakeAt"].(time.Time).Equal(at) || !row["updatedAt"].(time.Time).Equal(at) {
		t.Errorf("wakeAt/updatedAt = %v/%v, want %v", row["wakeAt"], row["updatedAt"], at)
	}
}

func TestWakeLeavesNonResumableRunsAlone(t *testing.T) {
	database := openTestDB(t)
	fixture := seedRunsFixture(t, database)
	created := createRun(t, database, fixture, runs.CreateInput{}, nil)
	exec(t, database, `UPDATE runs SET status = 'running', "leaseOwner" = 'worker-a', "leaseFence" = 1 WHERE id = $1`, created.RunID)
	actor := db.Actor{SpaceID: fixture.spaceID, UserID: fixture.userID}
	changed, err := runs.WakeFor(context.Background(), database, actor, nil, created.RunID, runs.WakeOptions{})
	if err != nil {
		t.Fatalf("wake: %v", err)
	}
	if changed {
		t.Fatal("wake changed a running run")
	}
	if got := runRow(t, database, created.RunID)["wakeAt"]; got != nil {
		t.Fatalf("wakeAt = %v, want nil", got)
	}
	// KeepExisting leaves a wake time the run already has.
	exec(t, database, `UPDATE runs SET status = 'queued', "leaseOwner" = NULL, "wakeAt" = $2 WHERE id = $1`,
		created.RunID, time.Date(2026, 11, 22, 12, 0, 0, 0, time.UTC))
	changed, err = runs.WakeFor(context.Background(), database, actor, nil, created.RunID,
		runs.WakeOptions{KeepExisting: true, At: time.Date(2026, 11, 22, 13, 0, 0, 0, time.UTC)})
	if err != nil {
		t.Fatalf("wake keepExisting: %v", err)
	}
	if changed {
		t.Fatal("keepExisting overwrote an existing wake time")
	}
}

func TestCancelActiveClearsEndedRunState(t *testing.T) {
	database := openTestDB(t)
	fixture := seedRunsFixture(t, database)
	ring := keyedRing(t, database)
	created := createRun(t, database, fixture, runs.CreateInput{}, nil)
	exec(t, database, `UPDATE runs SET status = 'running', "leaseOwner" = 'worker-a', "leaseFence" = 1 WHERE id = $1`, created.RunID)
	exec(t, database, `INSERT INTO attempts (id, "runId", fence, status, "startedAt") VALUES ($1, $2, 1, 'running', now())`,
		"at-"+created.RunID, created.RunID)
	exec(t, database, `INSERT INTO external_effects (id, "spaceId", "runId", kind, status, "idempotencyKey", request, "updatedAt")
		VALUES ($1, $2, $3, $4, $4, $5, '{}'::jsonb, now())`, "cp-"+created.RunID, fixture.spaceID, created.RunID, runs.RunTurnCheckpointKind, created.RunID)
	exec(t, database, `INSERT INTO messages (id, "threadId", seq, role, blocks, "createdAt")
		VALUES ($1, $2, 1, 'bot', $3::jsonb, now())`,
		"msg-"+created.RunID, fixture.threadID,
		`[{"kind":"ask","status":"pending","text":"Allow?","approvalEffectId":"ef-`+created.RunID+`"}]`)
	exec(t, database, `INSERT INTO external_effects (id, "spaceId", "runId", kind, status, "idempotencyKey", request, "updatedAt")
		VALUES ($1, $2, $3, 'web_fetch', 'intended', $1, '{}'::jsonb, now())`, "ef-"+created.RunID, fixture.spaceID, created.RunID)
	exec(t, database, `UPDATE messages SET "runId" = $2 WHERE id = $1`, "msg-"+created.RunID, created.RunID)
	exec(t, database, `INSERT INTO secrets (id, "userId", "spaceId", kind, ciphertext)
		VALUES ($1, $2, $3, $4, 'v2:test')`, "sec-"+created.RunID, fixture.userID, fixture.spaceID, "run-secret:"+created.RunID)
	exec(t, database, `INSERT INTO secrets (id, "userId", "spaceId", kind, ciphertext)
		VALUES ($1, $2, $3, $4, 'v2:test')`, "sec2-"+created.RunID, fixture.userID, fixture.spaceID, "run-login:"+created.RunID+":github")
	exec(t, database, `INSERT INTO secrets (id, "userId", "spaceId", kind, ciphertext)
		VALUES ($1, $2, $3, 'unrelated', 'v2:test')`, "keep-"+created.RunID, fixture.userID, fixture.spaceID)

	var cancelled []runs.Cancelled
	at := time.Date(2026, 11, 22, 9, 30, 0, 0, time.UTC)
	err := database.System(context.Background(), "cancel a test run", func(tx pgx.Tx) error {
		var err error
		cancelled, err = runs.Canceller{Ring: ring}.CancelActive(context.Background(), tx, []string{created.RunID}, at, nil)
		return err
	})
	if err != nil {
		t.Fatalf("cancel: %v", err)
	}
	if len(cancelled) != 1 || cancelled[0].ID != created.RunID {
		t.Fatalf("cancelled = %+v", cancelled)
	}
	row := runRow(t, database, created.RunID)
	if row["status"] != "cancelled" || row["leaseOwner"] != nil || row["leaseExpiresAt"] != nil {
		t.Errorf("run after cancel = %v/%v/%v", row["status"], row["leaseOwner"], row["leaseExpiresAt"])
	}
	if !row["completedAt"].(time.Time).Equal(at) {
		t.Errorf("completedAt = %v, want %v", row["completedAt"], at)
	}
	if got := systemScalar[string](t, database, `SELECT status FROM attempts WHERE id = $1`, "at-"+created.RunID); got != "cancelled" {
		t.Errorf("attempt = %q", got)
	}
	if got := systemScalar[string](t, database, `SELECT status FROM tasks WHERE id = $1`, created.TaskID); got != "cancelled" {
		t.Errorf("task = %q", got)
	}
	if got := systemScalar[int](t, database, `SELECT count(*) FROM external_effects WHERE id = $1`, "cp-"+created.RunID); got != 0 {
		t.Errorf("checkpoint rows = %d", got)
	}
	if got := systemScalar[string](t, database, `SELECT status FROM external_effects WHERE id = $1`, "ef-"+created.RunID); got != "denied" {
		t.Errorf("approval effect = %q", got)
	}
	if got := systemScalar[int](t, database, `SELECT count(*) FROM secrets WHERE "userId" = $1 AND "spaceId" = $2 AND kind LIKE 'run-%'`, fixture.userID, fixture.spaceID); got != 0 {
		t.Errorf("run secrets left = %d", got)
	}
	if got := systemScalar[string](t, database, `SELECT kind FROM secrets WHERE id = $1`, "keep-"+created.RunID); got != "unrelated" {
		t.Errorf("unrelated secret = %q", got)
	}
}

func TestCancelOfAFinishedRunKeepsItsOutcome(t *testing.T) {
	database := openTestDB(t)
	fixture := seedRunsFixture(t, database)
	created := createRun(t, database, fixture, runs.CreateInput{}, nil)
	exec(t, database, `UPDATE runs SET status = 'completed', "completedAt" = now(), error = NULL WHERE id = $1`, created.RunID)
	var cancelled []runs.Cancelled
	err := database.System(context.Background(), "cancel a finished run", func(tx pgx.Tx) error {
		var err error
		cancelled, err = runs.Canceller{Ring: plainRing()}.CancelActive(context.Background(), tx, []string{created.RunID}, time.Now(), nil)
		return err
	})
	if err != nil {
		t.Fatalf("cancel: %v", err)
	}
	if len(cancelled) != 0 {
		t.Fatalf("cancelled = %+v", cancelled)
	}
	if got := runRow(t, database, created.RunID)["status"]; got != "completed" {
		t.Fatalf("status = %v", got)
	}
}

func TestDuplicateNonceFailsAndResolves(t *testing.T) {
	database := openTestDB(t)
	fixture := seedRunsFixture(t, database)
	nonce := "routine-run:" + fixture.userID + ":n-" + strconv.FormatInt(time.Now().UnixNano(), 36)
	first := createRun(t, database, fixture, runs.CreateInput{Trigger: "routine", ClientNonce: &nonce}, nil)
	failure := database.System(context.Background(), "insert a duplicate nonce", func(tx pgx.Tx) error {
		_, err := runs.Create(context.Background(), tx, runs.CreateInput{
			SpaceID: fixture.spaceID, BotID: fixture.botID, ThreadID: fixture.threadID,
			UserID: fixture.userID, Prompt: "again", Trigger: "routine", ClientNonce: &nonce,
		})
		return err
	})
	if !runs.IsUniqueViolation(failure) {
		t.Fatalf("duplicate insert = %v, want a unique violation", failure)
	}
	var found runs.RunRef
	var ok bool
	err := database.System(context.Background(), "resolve a run nonce", func(tx pgx.Tx) error {
		var err error
		found, ok, err = runs.ByNonce(context.Background(), tx, fixture.spaceID, nonce)
		return err
	})
	if err != nil || !ok || found.ID != first.RunID || found.TaskID != first.TaskID {
		t.Fatalf("ByNonce = %+v/%v/%v", found, ok, err)
	}
}

func TestEmptyPromptAndRoutineReplayLookups(t *testing.T) {
	database := openTestDB(t)
	fixture := seedRunsFixture(t, database)
	nonce := "routine-run:" + fixture.userID + ":e-" + strconv.FormatInt(time.Now().UnixNano(), 36)
	var created runs.Created
	if err := database.System(context.Background(), "create an empty-prompt run", func(tx pgx.Tx) error {
		var err error
		created, err = runs.Create(context.Background(), tx, runs.CreateInput{
			SpaceID: fixture.spaceID, BotID: fixture.botID, ThreadID: fixture.threadID,
			UserID: fixture.userID, Trigger: "routine", ClientNonce: &nonce, Prompt: "",
		})
		return err
	}); err != nil {
		t.Fatalf("create empty prompt: %v", err)
	}
	if got := systemScalar[string](t, database, `SELECT prompt FROM tasks WHERE id = $1`, created.TaskID); got != "" {
		t.Errorf("task prompt = %q, want empty", got)
	}
	var found runs.RunRef
	var ok bool
	err := database.System(context.Background(), "resolve the thread/user nonce", func(tx pgx.Tx) error {
		var err error
		found, ok, err = runs.ByThreadUserNonce(context.Background(), tx, fixture.threadID, fixture.userID, nonce)
		return err
	})
	if err != nil || !ok || found.ID != created.RunID {
		t.Fatalf("ByThreadUserNonce = %+v/%v/%v", found, ok, err)
	}
	// Another thread's run with the same nonce is not this chat's replay.
	otherThread := "th-other-" + strconv.FormatInt(time.Now().UnixNano(), 36)
	err = database.System(context.Background(), "look up another thread", func(tx pgx.Tx) error {
		var err error
		found, ok, err = runs.ByThreadUserNonce(context.Background(), tx, otherThread, fixture.userID, nonce)
		return err
	})
	if err != nil || ok {
		t.Fatalf("other-thread lookup = %+v/%v/%v", found, ok, err)
	}
}

func TestWakeManyWakesOnlyContinuations(t *testing.T) {
	database := openTestDB(t)
	fixture := seedRunsFixture(t, database)
	queued := createRun(t, database, fixture, runs.CreateInput{}, nil)
	takeover := createRun(t, database, fixture, runs.CreateInput{Trigger: "follow_up"}, nil)
	exec(t, database, `UPDATE runs SET status = 'waiting_takeover' WHERE id = $1`, takeover.RunID)
	waiting := createRun(t, database, fixture, runs.CreateInput{Trigger: "follow_up"}, nil)
	exec(t, database, `UPDATE runs SET status = 'waiting_input' WHERE id = $1`, waiting.RunID)
	finished := createRun(t, database, fixture, runs.CreateInput{}, nil)
	exec(t, database, `UPDATE runs SET status = 'completed', "completedAt" = now() WHERE id = $1`, finished.RunID)
	notifier := effects.NewNotifier(database, nil)
	runs.WakeMany(context.Background(), database,
		db.Actor{SpaceID: fixture.spaceID, UserID: fixture.userID}, notifier, nil,
		[]string{waiting.RunID, queued.RunID, takeover.RunID, finished.RunID})
	notifier.Wait()
	// RUNS_NEEDING_CONTINUE = {queued, waiting_takeover} (thread-target.ts:78).
	for _, run := range []struct {
		name string
		id   string
		wake bool
	}{
		{"queued", queued.RunID, true},
		{"waiting_takeover", takeover.RunID, true},
		{"waiting_input", waiting.RunID, false},
		{"completed", finished.RunID, false},
	} {
		woke := runRow(t, database, run.id)["wakeAt"] != nil
		if woke != run.wake {
			t.Errorf("%s run wakeAt set = %v, want %v", run.name, woke, run.wake)
		}
	}
}

type countingPublisher struct{ ids []string }

func (p *countingPublisher) PublishRunReady(runID string) { p.ids = append(p.ids, runID) }

func TestWakeDueDecisionUsesTheWallClock(t *testing.T) {
	database := openTestDB(t)
	fixture := seedRunsFixture(t, database)
	created := createRun(t, database, fixture, runs.CreateInput{}, nil)
	publisher := &countingPublisher{}
	// A caller's injected clock 50 ms behind real time must not suppress the
	// frame: the due decision is the wall clock, as RunStarter.start's is
	// (run-wakeup.ts:88-93).
	changed, err := runs.WakeFor(context.Background(), database,
		db.Actor{SpaceID: fixture.spaceID, UserID: fixture.userID}, publisher, created.RunID,
		runs.WakeOptions{Now: time.Now().Add(-50 * time.Millisecond)})
	if err != nil || !changed {
		t.Fatalf("wake = %v/%v", changed, err)
	}
	if len(publisher.ids) != 1 || publisher.ids[0] != created.RunID {
		t.Fatalf("frames = %v, want exactly [%s]", publisher.ids, created.RunID)
	}
}

func TestCreateAndCancelRace(t *testing.T) {
	database := openTestDB(t)
	fixture := seedRunsFixture(t, database)
	type outcome struct {
		created runs.Created
		err     error
	}
	createdCh := make(chan outcome, 1)
	cancelledCh := make(chan int, 1)
	start := make(chan struct{})
	go func() {
		<-start
		var created runs.Created
		err := database.System(context.Background(), "race create", func(tx pgx.Tx) error {
			var err error
			created, err = runs.Create(context.Background(), tx, runs.CreateInput{
				SpaceID: fixture.spaceID, BotID: fixture.botID, ThreadID: fixture.threadID,
				UserID: fixture.userID, Prompt: "race", Trigger: "user",
			})
			return err
		})
		createdCh <- outcome{created, err}
	}()
	go func() {
		<-start
		// The canceller reads the run first, as every procedure does, then cancels
		// it under its own transaction. It either sees the committed run or not.
		deadline := time.Now().Add(5 * time.Second)
		for time.Now().Before(deadline) {
			var ids []string
			err := database.System(context.Background(), "race read", func(tx pgx.Tx) error {
				rows, err := tx.Query(context.Background(), `SELECT id FROM runs WHERE "threadId" = $1`, fixture.threadID)
				if err != nil {
					return err
				}
				defer rows.Close()
				for rows.Next() {
					var id string
					if err := rows.Scan(&id); err != nil {
						return err
					}
					ids = append(ids, id)
				}
				return rows.Err()
			})
			if err != nil {
				cancelledCh <- -1
				return
			}
			if len(ids) > 0 {
				count := 0
				err = database.System(context.Background(), "race cancel", func(tx pgx.Tx) error {
					cancelled, err := runs.Canceller{Ring: plainRing()}.CancelActive(context.Background(), tx, ids, time.Now(), nil)
					count = len(cancelled)
					return err
				})
				if err != nil {
					cancelledCh <- -1
					return
				}
				if count > 0 {
					cancelledCh <- count
					return
				}
			}
			time.Sleep(2 * time.Millisecond)
		}
		cancelledCh <- 0
	}()
	close(start)
	result := <-createdCh
	if result.err != nil {
		t.Fatalf("race create: %v", result.err)
	}
	cancelled := <-cancelledCh
	if cancelled < 0 {
		t.Fatal("race cancel errored")
	}
	status := runRow(t, database, result.created.RunID)["status"]
	if cancelled > 0 && status != "cancelled" {
		t.Fatalf("cancel won (%d rows) but status = %v", cancelled, status)
	}
	if cancelled == 0 && status != "queued" {
		t.Fatalf("cancel found nothing but status = %v", status)
	}
}

func TestSupersedeQueuedKeepsTheNewestRun(t *testing.T) {
	database := openTestDB(t)
	fixture := seedRunsFixture(t, database)
	nonce := "send:m-" + strconv.FormatInt(time.Now().UnixNano(), 36)
	first := createRun(t, database, fixture, runs.CreateInput{ClientNonce: &nonce}, nil)
	exec(t, database, `UPDATE runs SET trigger = 'reaction' WHERE id = $1`, first.RunID)
	second := createRun(t, database, fixture, runs.CreateInput{}, nil)
	var cancelled []runs.Cancelled
	err := database.System(context.Background(), "supersede queued runs", func(tx pgx.Tx) error {
		var err error
		cancelled, err = runs.Canceller{Ring: plainRing()}.SupersedeQueued(context.Background(), tx,
			fixture.threadID, []string{fixture.botID}, []string{second.RunID}, time.Now(), nil)
		return err
	})
	if err != nil {
		t.Fatalf("supersede: %v", err)
	}
	if len(cancelled) != 1 || cancelled[0].ID != first.RunID {
		t.Fatalf("cancelled = %+v", cancelled)
	}
	if got := runRow(t, database, second.RunID)["status"]; got != "queued" {
		t.Fatalf("newest run = %v", got)
	}
}

func mustEnv(t *testing.T, name string) string {
	t.Helper()
	value := os.Getenv(name)
	if value == "" {
		t.Fatalf("%s is required", name)
	}
	return value
}

func TestCancelConversationWritesItsNotesOrRefuses(t *testing.T) {
	database := openTestDB(t)
	fixture := seedRunsFixture(t, database)
	// A deployment with content encryption off builds a pass-through ring; there
	// is no nil-ring mode (a nil ring would silently skip sealed blocks).
	ring := contentcrypto.NewKeyRing(nil, nil, contentcrypto.KeyRingOptions{})
	ctx := context.Background()
	created := createRun(t, database, fixture, runs.CreateInput{}, nil)
	target := runs.ConversationTarget{
		SpaceID:  fixture.spaceID,
		ThreadID: fixture.threadID,
		BotIDs:   []string{fixture.botID},
		Note:     &runs.StopNote{BotID: fixture.botID},
	}

	// A note is due and there is no writer: the cancel refuses rather than hand
	// back text its caller could write after the notify, and writes nothing.
	err := database.System(ctx, "cancel with an unwritten note", func(tx pgx.Tx) error {
		_, err := runs.Canceller{Ring: ring}.CancelConversation(ctx, tx, target, time.Now(), nil)
		return err
	})
	if !errors.Is(err, runs.ErrNotesNotWritten) {
		t.Fatalf("cancel without a note writer = %v, want ErrNotesNotWritten", err)
	}
	if got := runRow(t, database, created.RunID)["status"]; got != "queued" {
		t.Fatalf("refused cancel wrote status = %v", got)
	}

	// With one, the callback writes each note in order and EventSeq is the last
	// note's event seq, the cursor finishThreadStop notifies with.
	var written []runs.Note
	next := int32(10)
	var result runs.ConversationCancel
	target.WriteNote = func(ctx context.Context, tx pgx.Tx, note runs.Note) (int32, error) {
		written = append(written, note)
		next += 1
		return next, nil
	}
	err = database.System(ctx, "cancel with notes", func(tx pgx.Tx) error {
		var err error
		result, err = runs.Canceller{Ring: ring}.CancelConversation(ctx, tx, target, time.Now(), nil)
		return err
	})
	if err != nil {
		t.Fatalf("cancel with notes: %v", err)
	}
	if len(written) != 1 || written[0].Text != runs.StoppedByMessageNote || written[0].BotID != fixture.botID {
		t.Fatalf("notes = %+v", written)
	}
	if result.EventSeq == nil || *result.EventSeq != next {
		t.Fatalf("eventSeq = %v, want the last note's %d", result.EventSeq, next)
	}
	if len(result.Runs) != 1 || result.Runs[0].ID != created.RunID {
		t.Fatalf("runs = %+v", result.Runs)
	}

	// A writer that returns no seq would make the cursor unusable: refuse it.
	other := createRun(t, database, fixture, runs.CreateInput{}, nil)
	target.HelperMessageID = nil
	target.WriteNote = func(ctx context.Context, tx pgx.Tx, note runs.Note) (int32, error) {
		return 0, nil
	}
	err = database.System(ctx, "cancel with a seq-less writer", func(tx pgx.Tx) error {
		_, err := runs.Canceller{Ring: ring}.CancelConversation(ctx, tx, target, time.Now(), nil)
		return err
	})
	if err == nil || errors.Is(err, runs.ErrNotesNotWritten) {
		t.Fatalf("seq-less writer = %v, want a refusal", err)
	}
	if got := runRow(t, database, other.RunID)["status"]; got != "queued" {
		t.Fatalf("refused cancel wrote status = %v", got)
	}
}

// plainRing is the pass-through ring a deployment with content encryption off
// builds: NewKeyRing with no provider or store and EncryptWrites false never
// seals and opens only plaintext.
func plainRing() *contentcrypto.KeyRing {
	return contentcrypto.NewKeyRing(nil, nil, contentcrypto.KeyRingOptions{})
}

func TestCancelsRequireTheRing(t *testing.T) {
	database := openTestDB(t)
	fixture := seedRunsFixture(t, database)
	ctx := context.Background()
	created := createRun(t, database, fixture, runs.CreateInput{}, nil)
	// TypeScript always has a cipher (a pass-through one when encryption is off),
	// so a nil ring is a wiring mistake in all three cancels, not a mode.
	err := database.System(ctx, "active cancel without a ring", func(tx pgx.Tx) error {
		_, err := runs.Canceller{}.CancelActive(ctx, tx, []string{created.RunID}, time.Now(), nil)
		return err
	})
	if err == nil || !strings.Contains(err.Error(), "content key ring") {
		t.Fatalf("nil-ring CancelActive = %v", err)
	}
	err = database.System(ctx, "conversation cancel without a ring", func(tx pgx.Tx) error {
		_, err := runs.Canceller{}.CancelConversation(ctx, tx, runs.ConversationTarget{
			SpaceID: fixture.spaceID, ThreadID: fixture.threadID, BotIDs: []string{fixture.botID},
		}, time.Now(), nil)
		return err
	})
	if err == nil || !strings.Contains(err.Error(), "content key ring") {
		t.Fatalf("nil-ring CancelConversation = %v", err)
	}
	err = database.System(ctx, "supersede without a ring", func(tx pgx.Tx) error {
		_, err := runs.Canceller{}.SupersedeQueued(ctx, tx, fixture.threadID, []string{fixture.botID}, nil, time.Now(), nil)
		return err
	})
	if err == nil || !strings.Contains(err.Error(), "content key ring") {
		t.Fatalf("nil-ring SupersedeQueued = %v", err)
	}
	_, err = runs.Canceller{}.CancelConversationFor(ctx, database,
		db.Actor{UserID: fixture.userID, SpaceID: fixture.spaceID}, runs.ConversationTarget{
			SpaceID: fixture.spaceID, ThreadID: fixture.threadID, BotIDs: []string{fixture.botID},
		}, time.Now(), nil)
	if err == nil || !strings.Contains(err.Error(), "content key ring") {
		t.Fatalf("nil-ring CancelConversationFor = %v", err)
	}
	if got := runRow(t, database, created.RunID)["status"]; got != "queued" {
		t.Fatalf("a refused cancel wrote status = %v", got)
	}
}

func TestCreateWritesTheNullableModelPin(t *testing.T) {
	database := openTestDB(t)
	fixture := seedRunsFixture(t, database)
	// routineRunModelPin with provider/model and a NULL thinkingLevel keeps the
	// NULL (model-selection.ts:1054-1067).
	thinkingNull := createRun(t, database, fixture, runs.CreateInput{
		Trigger: "routine",
		Model:   &runs.ModelPin{Provider: "openai", Model: "gpt-x", Pinned: true},
	}, nil)
	row := runRow(t, database, thinkingNull.RunID)
	if row["modelProvider"] != "openai" || row["modelId"] != "gpt-x" {
		t.Fatalf("pin = %v/%v", row["modelProvider"], row["modelId"])
	}
	if row["thinkingLevel"] != nil {
		t.Fatalf("thinkingLevel = %v, want NULL", row["thinkingLevel"])
	}
	if row["modelPinned"] != true {
		t.Fatalf("modelPinned = %v", row["modelPinned"])
	}
	// sendUserMessage sets modelPinned for any pin object; the model columns stay
	// NULL when the object names none.
	presence := createRun(t, database, fixture, runs.CreateInput{
		Trigger: "webhook",
		Model:   &runs.ModelPin{Pinned: true},
	}, nil)
	row = runRow(t, database, presence.RunID)
	if row["modelProvider"] != nil || row["modelId"] != nil || row["thinkingLevel"] != nil {
		t.Fatalf("presence pin wrote columns: %v/%v/%v", row["modelProvider"], row["modelId"], row["thinkingLevel"])
	}
	if row["modelPinned"] != true {
		t.Fatalf("presence pin modelPinned = %v", row["modelPinned"])
	}
	// No pin object at all writes nothing, as a spread of routineRunModelPin's {}.
	bare := createRun(t, database, fixture, runs.CreateInput{Trigger: "routine"}, nil)
	row = runRow(t, database, bare.RunID)
	if row["modelPinned"] != false || row["modelProvider"] != nil {
		t.Fatalf("bare run pin = %v/%v", row["modelPinned"], row["modelProvider"])
	}
}
