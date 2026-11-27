package integration

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/auth"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/gateway"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/local"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/orpc"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/shared"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/spendinglimit"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/tickets"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/routes"
)

// logSink collects the JSON log records of one server so a test can assert on the lines the
// deployment's journal would carry.
type logSink struct {
	mu      sync.Mutex
	records []map[string]any
}

func (s *logSink) Write(payload []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, line := range strings.Split(string(payload), "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		var record map[string]any
		if err := json.Unmarshal([]byte(line), &record); err != nil {
			continue
		}
		s.records = append(s.records, record)
	}
	return len(payload), nil
}

// matching returns the records whose msg is one of msg, in the order they were written.
func (s *logSink) matching(msg string) []map[string]any {
	s.mu.Lock()
	defer s.mu.Unlock()
	var found []map[string]any
	for _, record := range s.records {
		if record["msg"] == msg {
			found = append(found, record)
		}
	}
	return found
}

// waitFor polls until a record with msg exists, so a test never races the handler's last write.
func (s *logSink) waitFor(t *testing.T, msg string, timeout time.Duration) map[string]any {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if records := s.matching(msg); len(records) > 0 {
			return records[len(records)-1]
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("no %q log line within %s; records: %v", msg, timeout, s.all())
	return nil
}

func (s *logSink) all() []map[string]any {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]map[string]any{}, s.records...)
}

// level counts records by their slog level name.
func (s *logSink) level(name string) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	count := 0
	for _, record := range s.records {
		if record["level"] == name {
			count++
		}
	}
	return count
}

type cancelServer struct {
	url string
	log *logSink
}

// cancelServerWith serves the given procedures, logging into the returned sink.
func cancelServerWith(t *testing.T, database *db.DB, procedures []local.Procedure) *cancelServer {
	t.Helper()
	sink := &logSink{}
	logger := slog.New(slog.NewJSONHandler(sink, &slog.HandlerOptions{Level: slog.LevelDebug}))
	secret, authURL := testAuthConfig()
	sessions := auth.New(database, auth.Config{Secret: secret, AuthURL: authURL})
	server := local.New(database, sessions, procedures, local.Config{
		BuildID:        testBuildID,
		MaxUploadBytes: 10 * 1024 * 1024,
		WebOrigin:      "https://app.example.test",
		TrustedOrigins: []string{"https://app.example.test"},
		Logger:         logger,
	})
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		server.ServeHTTP(w, r, routes.ProcedureKey(r.URL.Path))
	})
	httpServer := httptest.NewServer(handler)
	t.Cleanup(httpServer.Close)
	return &cancelServer{url: httpServer.URL, log: sink}
}

// cancelingRequest starts a request and cancels its context after delay, returning the
// error the client saw.
func cancelingRequest(t *testing.T, method, url, cookie, body string, delay time.Duration) error {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	request, err := http.NewRequestWithContext(ctx, method, url, strings.NewReader(body))
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	request.Header.Set("content-type", "application/json")
	request.Header.Set("origin", "https://app.example.test")
	if cookie != "" {
		request.Header.Set("cookie", cookie)
	}
	go func() {
		time.Sleep(delay)
		cancel()
	}()
	response, err := http.DefaultClient.Do(request)
	if err == nil {
		payload, _ := io.ReadAll(response.Body)
		response.Body.Close()
		t.Fatalf("client did not go away: %d %s", response.StatusCode, payload)
	}
	cancel()
	return err
}

// waitForBlockedRead blocks until a tenant statement from the test's pool is waiting on a lock,
// so the client never goes away before the read is really in flight. Only the wait event is
// visible to the runtime role: other backends' query text needs pg_read_all_stats.
func waitForBlockedRead(t *testing.T, database *db.DB) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		var waiting int64
		if err := database.Pool.QueryRow(context.Background(), `SELECT count(*) FROM pg_stat_activity
			WHERE datname = current_database() AND application_name = 'rakazo-api-go-tests'
				AND state = 'active' AND wait_event_type = 'Lock'`).Scan(&waiting); err != nil {
			t.Fatalf("read pg_stat_activity: %v", err)
		}
		if waiting > 0 {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	rows, err := database.Pool.Query(context.Background(), `SELECT state, coalesce(wait_event_type, ''), coalesce(wait_event, '')
		FROM pg_stat_activity WHERE datname = current_database() AND application_name = 'rakazo-api-go-tests'`)
	if err == nil {
		defer rows.Close()
		for rows.Next() {
			var state, eventType, event string
			_ = rows.Scan(&state, &eventType, &event)
			t.Logf("backend: state=%s wait=%s/%s", state, eventType, event)
		}
	}
	t.Fatal("the served read never blocked on the locked table")
}

// TestClientCancelOnGoServedRead cancels the client while tickets.list waits on the database.
// The handler fails with context.Canceled (or the canceled statement's 57014); the request must
// be recorded as 499 with a warn and never as a 500, and no error body may be written.
func TestClientCancelOnGoServedRead(t *testing.T) {
	database := openTestDB(t)
	seed := seed(t, database)
	cookie := "better-auth.session_token=" + signedCookie(testSecret, seed.SessionToken)
	procedures := []local.Procedure{{
		Name:     "tickets.list",
		ReadOnly: true,
		Serve: func(ctx context.Context, actor db.Actor, input orpc.Input) (any, *orpc.Error) {
			return tickets.List(ctx, database, shared.Deployment{BoardLab: true}, actor, input)
		},
	}}
	server := cancelServerWith(t, database, procedures)

	// Hold the board table exclusively so the read is provably in flight when the client leaves:
	// the SELECT blocks in Postgres until the canceled connection aborts it.
	lockCtx, releaseLock := context.WithCancel(context.Background())
	defer releaseLock()
	lock, err := database.Pool.Begin(lockCtx)
	if err != nil {
		t.Fatalf("lock transaction: %v", err)
	}
	if _, err := lock.Exec(lockCtx, `LOCK TABLE boards IN ACCESS EXCLUSIVE MODE`); err != nil {
		t.Fatalf("lock boards: %v", err)
	}
	unlock := sync.OnceFunc(func() { _ = lock.Rollback(context.Background()) })
	defer unlock()

	ctx, cancel := context.WithCancel(context.Background())
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, server.url+"/rpc/tickets/list", strings.NewReader(`{"json":{}}`))
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	request.Header.Set("content-type", "application/json")
	request.Header.Set("origin", "https://app.example.test")
	request.Header.Set("cookie", cookie)
	client := make(chan error, 1)
	go func() {
		response, err := http.DefaultClient.Do(request)
		if err == nil {
			payload, _ := io.ReadAll(response.Body)
			response.Body.Close()
			err = errors.New("the client was answered: " + string(payload))
		}
		client <- err
	}()
	waitForBlockedRead(t, database)
	cancel()
	if err := <-client; !errors.Is(err, context.Canceled) {
		t.Fatalf("client error = %v, want context.Canceled", err)
	}
	completion := server.log.waitFor(t, "http.request.completed", 10*time.Second)
	unlock()
	time.Sleep(100 * time.Millisecond) // let any late line land before counting

	if status, _ := completion["http.status"].(float64); status != 499 {
		t.Fatalf("recorded status = %v, want 499 (line %v)", completion["http.status"], completion)
	}
	disconnects := server.log.matching("client disconnected")
	if len(disconnects) != 1 {
		t.Fatalf("client disconnected lines = %d, want 1: %v", len(disconnects), server.log.all())
	}
	if disconnects[0]["level"] != "WARN" || disconnects[0]["procedure"] != "tickets.list" {
		t.Fatalf("disconnect line = %v, want WARN for tickets.list", disconnects[0])
	}
	if cause, _ := disconnects[0]["error"].(string); !strings.Contains(cause, "context canceled") && !strings.Contains(cause, "canceling statement") {
		t.Fatalf("disconnect cause = %q, want the canceled context or canceled statement", cause)
	}
	if errors := server.log.matching("tickets.list failed"); len(errors) != 0 {
		t.Fatalf("a real 500 was logged: %v", errors)
	}
	if level := server.log.level("ERROR"); level != 0 {
		t.Fatalf("ERROR lines = %d, want 0: %v", level, server.log.all())
	}
}

// TestClientCancelOnSlowStatement cancels a directory read inside a tenant transaction that is
// waiting on pg_sleep: a canceled statement, not just a canceled commit, must be a disconnect.
func TestClientCancelOnSlowStatement(t *testing.T) {
	database := openTestDB(t)
	seed := seed(t, database)
	cookie := "better-auth.session_token=" + signedCookie(testSecret, seed.SessionToken)
	procedures := []local.Procedure{{
		Name:     "cancel.slow",
		ReadOnly: true,
		Serve: func(ctx context.Context, actor db.Actor, _ orpc.Input) (any, *orpc.Error) {
			err := database.Tenant(ctx, actor, func(tx pgx.Tx) error {
				_, err := tx.Exec(ctx, `SELECT pg_sleep(5)`)
				return err
			})
			if err != nil {
				return nil, shared.Failure(err)
			}
			return map[string]any{"ok": true}, nil
		},
	}}
	server := cancelServerWith(t, database, procedures)
	if err := cancelingRequest(t, http.MethodPost, server.url+"/rpc/cancel/slow", cookie, `{"json":{}}`, 150*time.Millisecond); err == nil {
		t.Fatal("client did not go away")
	}
	completion := server.log.waitFor(t, "http.request.completed", 10*time.Second)
	time.Sleep(100 * time.Millisecond)
	if status, _ := completion["http.status"].(float64); status != 499 {
		t.Fatalf("recorded status = %v, want 499: %v", completion["http.status"], completion)
	}
	if lines := server.log.matching("client disconnected"); len(lines) != 1 {
		t.Fatalf("client disconnected lines = %d, want 1: %v", len(lines), server.log.all())
	}
	if level := server.log.level("ERROR"); level != 0 {
		t.Fatalf("ERROR lines = %d, want 0: %v", level, server.log.all())
	}
}

// TestInnerTimeoutStaysAFailure keeps the request context live: a timeout the procedure imposes
// on itself is still the deployment's failure, mapped exactly as before (503 for a deadline,
// 500 for a canceled statement) and logged with its cause.
func TestInnerTimeoutStaysAFailure(t *testing.T) {
	database := openTestDB(t)
	seed := seed(t, database)
	cookie := "better-auth.session_token=" + signedCookie(testSecret, seed.SessionToken)
	procedures := []local.Procedure{
		{
			Name:     "cancel.deadline",
			ReadOnly: true,
			Serve: func(ctx context.Context, actor db.Actor, _ orpc.Input) (any, *orpc.Error) {
				runCtx, stop := context.WithTimeout(ctx, 100*time.Millisecond)
				defer stop()
				err := database.Tenant(runCtx, actor, func(tx pgx.Tx) error {
					_, err := tx.Exec(runCtx, `SELECT pg_sleep(5)`)
					return err
				})
				if err != nil {
					return nil, shared.Failure(err)
				}
				return map[string]any{"ok": true}, nil
			},
		},
		{
			Name:     "cancel.statementTimeout",
			ReadOnly: true,
			Serve: func(ctx context.Context, actor db.Actor, _ orpc.Input) (any, *orpc.Error) {
				err := database.Tenant(ctx, actor, func(tx pgx.Tx) error {
					if _, err := tx.Exec(ctx, `SET LOCAL statement_timeout = 100`); err != nil {
						return err
					}
					_, err := tx.Exec(ctx, `SELECT pg_sleep(5)`)
					return err
				})
				if err != nil {
					return nil, shared.Failure(err)
				}
				return map[string]any{"ok": true}, nil
			},
		},
	}
	server := cancelServerWith(t, database, procedures)

	response, body := do(t, http.MethodPost, server.url+"/rpc/cancel/deadline", cookie, `{"json":{}}`, nil)
	if response.StatusCode != http.StatusServiceUnavailable || envelopeCode(t, body) != "SERVICE_UNAVAILABLE" {
		t.Fatalf("inner deadline = %d %s, want the unchanged 503", response.StatusCode, body)
	}
	response, body = do(t, http.MethodPost, server.url+"/rpc/cancel/statementTimeout", cookie, `{"json":{}}`, nil)
	if response.StatusCode != http.StatusInternalServerError || envelopeCode(t, body) != "INTERNAL_SERVER_ERROR" {
		t.Fatalf("inner statement timeout = %d %s, want the unchanged 500", response.StatusCode, body)
	}

	if lines := server.log.matching("client disconnected"); len(lines) != 0 {
		t.Fatalf("a live request was recorded as a disconnect: %v", lines)
	}
	failures := server.log.matching("cancel.statementTimeout failed")
	if len(failures) != 1 {
		t.Fatalf("500 lines = %d, want 1 with its cause: %v", len(failures), server.log.all())
	}
	cause, _ := failures[0]["error"].(string)
	if !strings.Contains(cause, "57014") && !strings.Contains(cause, "canceling statement due to statement timeout") {
		t.Fatalf("500 cause = %q, want the canceled statement", cause)
	}
	if failures[0]["level"] != "ERROR" {
		t.Fatalf("500 line level = %v, want ERROR", failures[0]["level"])
	}
}

// commitSpendingLimit is the write half of the commit-vs-cancel probes: one tenant transaction
// that upserts the caller's limit and sends its NOTIFY, so the commit is the last thing that
// happens before the client goes away.
func commitSpendingLimit(ctx context.Context, database *db.DB, actor db.Actor, amount int32) error {
	return database.Tenant(ctx, actor, func(tx pgx.Tx) error {
		now := time.Now().UTC().Truncate(time.Millisecond)
		if _, err := tx.Exec(ctx, `INSERT INTO spending_limits ("userId", amount, currency, period, "updatedAt")
			VALUES ($1, $2, 'eur', 'week', $3)
			ON CONFLICT ("userId") DO UPDATE SET amount = EXCLUDED.amount, "updatedAt" = EXCLUDED."updatedAt"`,
			db.Data(actor.UserID, amount, now)...); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, `SELECT pg_notify('cancel_fix_probe', $1)`, "cancel-fix")
		return err
	})
}

// TestWriteCommitSurvivesClientCancel writes inside a tenant transaction, sends its NOTIFY, and
// only then loses the client. The committed row and the notification must stand; the answer
// must be suppressed as a 499 with no 5xx.
func TestWriteCommitSurvivesClientCancel(t *testing.T) {
	database := openTestDB(t)
	seed := seed(t, database)
	cookie := "better-auth.session_token=" + signedCookie(testSecret, seed.SessionToken)

	listener, err := database.Pool.Acquire(context.Background())
	if err != nil {
		t.Fatalf("listen connection: %v", err)
	}
	t.Cleanup(listener.Release)
	if _, err := listener.Exec(context.Background(), `LISTEN cancel_fix_probe`); err != nil {
		t.Fatalf("listen: %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	canceled := false
	procedures := []local.Procedure{{
		Name: "cancel.commit",
		Serve: func(ctx context.Context, actor db.Actor, _ orpc.Input) (any, *orpc.Error) {
			if err := commitSpendingLimit(ctx, database, actor, 2750); err != nil {
				return nil, shared.Failure(err)
			}
			// The commit has landed; the client goes away before the answer can be written.
			canceled = true
			cancel()
			// Wait for the disconnect to reach this side, then take a step that needs the
			// request context, as a post-commit read would.
			select {
			case <-ctx.Done():
			case <-time.After(5 * time.Second):
				return nil, shared.Failure(errors.New("the client never disconnected"))
			}
			if _, err := database.Pool.Exec(ctx, `SELECT 1`); err != nil {
				return nil, shared.Failure(err)
			}
			return map[string]any{"ok": true}, nil
		},
	}}
	server := cancelServerWith(t, database, procedures)
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, server.url+"/rpc/cancel/commit", strings.NewReader(`{"json":{}}`))
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	request.Header.Set("content-type", "application/json")
	request.Header.Set("origin", "https://app.example.test")
	request.Header.Set("cookie", cookie)
	if response, err := http.DefaultClient.Do(request); err == nil {
		payload, _ := io.ReadAll(response.Body)
		response.Body.Close()
		t.Fatalf("client did not go away: %d %s", response.StatusCode, payload)
	}
	if !canceled {
		t.Fatal("the handler never reached the commit")
	}

	completion := server.log.waitFor(t, "http.request.completed", 10*time.Second)
	time.Sleep(100 * time.Millisecond)
	if status, _ := completion["http.status"].(float64); status != 499 {
		t.Fatalf("recorded status = %v, want 499: %v", completion["http.status"], completion)
	}
	if lines := server.log.matching("client disconnected"); len(lines) != 1 {
		t.Fatalf("client disconnected lines = %d, want 1: %v", len(lines), server.log.all())
	}
	if level := server.log.level("ERROR"); level != 0 {
		t.Fatalf("ERROR lines = %d, want 0: %v", level, server.log.all())
	}
	if amount := systemScalar[int32](t, database, `SELECT amount FROM spending_limits WHERE "userId" = $1`, seed.UserID); amount != 2750 {
		t.Fatalf("committed amount = %d, want 2750: the transaction must not roll back", amount)
	}
	notifyCtx, stopWaiting := context.WithTimeout(context.Background(), 5*time.Second)
	defer stopWaiting()
	notification, err := listener.Conn().WaitForNotification(notifyCtx)
	if err != nil {
		t.Fatalf("the committed NOTIFY never arrived: %v", err)
	}
	if notification.Payload != "cancel-fix" {
		t.Fatalf("notification = %q", notification.Payload)
	}
}

// TestWriteEffectsRunAfterClientCancel is the commit that wins outright: the handler returns
// success, the client is gone, and the security event and audit row must still be recorded
// (effects run on a context without the request's cancellation).
func TestWriteEffectsRunAfterClientCancel(t *testing.T) {
	database := openTestDB(t)
	seed := seed(t, database)
	cookie := "better-auth.session_token=" + signedCookie(testSecret, seed.SessionToken)
	ctx, cancel := context.WithCancel(context.Background())
	procedures := []local.Procedure{{
		Name: "spendingLimit.set",
		Serve: func(ctx context.Context, actor db.Actor, input orpc.Input) (any, *orpc.Error) {
			status, failure := spendinglimit.Set(ctx, database, actor, input, nil)
			if failure != nil {
				return nil, failure
			}
			// The write is committed when the client goes away.
			cancel()
			return status, nil
		},
	}}
	server := cancelServerWith(t, database, procedures)
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, server.url+"/rpc/spendingLimit/set", strings.NewReader(`{"json":{"limit":{"amount":900,"currency":"eur","period":"week"}}}`))
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	request.Header.Set("content-type", "application/json")
	request.Header.Set("origin", "https://app.example.test")
	request.Header.Set("cookie", cookie)
	if response, err := http.DefaultClient.Do(request); err == nil {
		payload, _ := io.ReadAll(response.Body)
		response.Body.Close()
		t.Fatalf("client did not go away: %d %s", response.StatusCode, payload)
	}

	completion := server.log.waitFor(t, "http.request.completed", 10*time.Second)
	time.Sleep(200 * time.Millisecond)
	if status, _ := completion["http.status"].(float64); status != 200 {
		t.Fatalf("recorded status = %v, want the successful 200: %v", completion["http.status"], completion)
	}
	if lines := server.log.matching("client disconnected"); len(lines) != 0 {
		t.Fatalf("a successful write was recorded as a disconnect: %v", lines)
	}
	if amount := systemScalar[int32](t, database, `SELECT amount FROM spending_limits WHERE "userId" = $1`, seed.UserID); amount != 900 {
		t.Fatalf("committed amount = %d, want 900", amount)
	}
	events := systemScalar[int64](t, database, `SELECT count(*) FROM security_events WHERE "userId" = $1 AND type = 'approval.policy.changed'`, seed.UserID)
	if events != 1 {
		t.Fatalf("security events = %d, want 1", events)
	}
	audits := systemScalar[int64](t, database, `SELECT count(*) FROM audit_events WHERE "actorId" = $1 AND action = 'approval.policy.changed'`, seed.UserID)
	if audits != 1 {
		t.Fatalf("audit rows = %d, want 1", audits)
	}
}

// TestClientCancelOnStreamFollow cancels the client while boards.subscribe's follow step is
// still running its Gate query: the pre-stream failure is a disconnect (499), not a 500.
func TestClientCancelOnStreamFollow(t *testing.T) {
	database := openTestDB(t)
	seed := seed(t, database)
	cookie := "better-auth.session_token=" + signedCookie(testSecret, seed.SessionToken)
	procedures := []local.Procedure{{
		Name:     "boards.subscribe",
		ReadOnly: true,
		Stream: &local.Stream{
			Follow: func(ctx context.Context, actor db.Actor, input orpc.Input) (*local.Follow, *orpc.Error) {
				// The client goes away, then the follow step's own Gate query runs on the
				// canceled context, as it would if the abort landed inside FollowBoard.
				<-ctx.Done()
				err := tickets.Gate(ctx, database, shared.Deployment{BoardLab: true}, actor)
				if err != nil {
					return nil, shared.Failure(err)
				}
				return &local.Follow{Signals: make(chan string), Stop: func() {}}, nil
			},
			Frame: func(db.Actor, string) any { return nil },
		},
	}}
	server := cancelServerWith(t, database, procedures)
	if err := cancelingRequest(t, http.MethodPost, server.url+"/rpc/boards/subscribe", cookie, `{"json":{}}`, 150*time.Millisecond); err == nil {
		t.Fatal("client did not go away")
	}
	completion := server.log.waitFor(t, "http.request.completed", 10*time.Second)
	time.Sleep(100 * time.Millisecond)
	if status, _ := completion["http.status"].(float64); status != 499 {
		t.Fatalf("recorded status = %v, want 499: %v", completion["http.status"], completion)
	}
	if lines := server.log.matching("client disconnected"); len(lines) != 1 {
		t.Fatalf("client disconnected lines = %d, want 1: %v", len(lines), server.log.all())
	}
	if errors := server.log.matching("boards.subscribe failed"); len(errors) != 0 {
		t.Fatalf("a 500 was logged for the follow step: %v", errors)
	}
	if level := server.log.level("ERROR"); level != 0 {
		t.Fatalf("ERROR lines = %d, want 0: %v", level, server.log.all())
	}
}

// TestDeclinedRequestIsNotProxiedAfterCancel: a MayDecline procedure answers a decline under a
// canceled request, and the gateway must not proxy it — that request's only possible outcome is
// a WARN "upstream request failed" and a 503 nothing reads.
func TestDeclinedRequestIsNotProxiedAfterCancel(t *testing.T) {
	database := openTestDB(t)
	seed := seed(t, database)
	cookie := "better-auth.session_token=" + signedCookie(testSecret, seed.SessionToken)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Errorf("a canceled declined request reached TypeScript")
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(upstream.Close)
	sink := &logSink{}
	logger := slog.New(slog.NewJSONHandler(sink, nil))
	target, err := url.Parse(upstream.URL)
	if err != nil {
		t.Fatalf("upstream url: %v", err)
	}
	secret, authURL := testAuthConfig()
	sessions := auth.New(database, auth.Config{Secret: secret, AuthURL: authURL})
	localServer := local.New(database, sessions, []local.Procedure{{
		Name:       "decline.probe",
		ReadOnly:   true,
		MayDecline: true,
		Serve: func(ctx context.Context, _ db.Actor, _ orpc.Input) (any, *orpc.Error) {
			<-ctx.Done()
			return nil, local.ErrDecline
		},
	}}, local.Config{BuildID: testBuildID, WebOrigin: "https://app.example.test",
		TrustedOrigins: []string{"https://app.example.test"}, Logger: logger})
	handler := gateway.New(gateway.Options{
		Upstream: target,
		Routes:   routesStore(t, `{"default":"proxy","routes":{"decline.probe":{"mode":"go","readOnly":true}}}`),
		Logger:   logger,
		Local:    localServer,
	})
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)

	if err := cancelingRequest(t, http.MethodPost, server.URL+"/rpc/decline/probe", cookie, `{"json":{}}`, 100*time.Millisecond); err == nil {
		t.Fatal("client did not go away")
	}
	completion := sink.waitFor(t, "http.request.completed", 10*time.Second)
	time.Sleep(200 * time.Millisecond)
	if status, _ := completion["http.status"].(float64); status != 499 {
		t.Fatalf("gateway recorded %v, want 499: %v", completion["http.status"], completion)
	}
	if lines := sink.matching("upstream request failed"); len(lines) != 0 {
		t.Fatalf("the canceled request was proxied: %v", lines)
	}
	if level := sink.level("ERROR"); level != 0 {
		t.Fatalf("ERROR lines = %d, want 0: %v", level, sink.all())
	}
}

// TestShadowSkipsClientCancel shadows a slow TypeScript answer and cancels the client while it
// runs: the comparison must be skipped, never reported as a wire difference.
func TestShadowSkipsClientCancel(t *testing.T) {
	database := openTestDB(t)
	seed := seed(t, database)
	cookie := "better-auth.session_token=" + signedCookie(testSecret, seed.SessionToken)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(400 * time.Millisecond)
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("X-Rakazo-Build", testBuildID)
		_, _ = w.Write([]byte(`{"json":{"from":"typescript"}}`))
	}))
	t.Cleanup(upstream.Close)
	target, err := url.Parse(upstream.URL)
	if err != nil {
		t.Fatalf("upstream url: %v", err)
	}

	sink := &logSink{}
	logger := slog.New(slog.NewJSONHandler(sink, &slog.HandlerOptions{Level: slog.LevelDebug}))
	secret, authURL := testAuthConfig()
	sessions := auth.New(database, auth.Config{Secret: secret, AuthURL: authURL})
	localServer := local.New(database, sessions, []local.Procedure{{
		Name:     "shadow.probe",
		ReadOnly: true,
		Serve: func(context.Context, db.Actor, orpc.Input) (any, *orpc.Error) {
			return map[string]any{"from": "go"}, nil
		},
	}}, local.Config{BuildID: testBuildID, WebOrigin: "https://app.example.test",
		TrustedOrigins: []string{"https://app.example.test"}, Logger: logger})
	handler := gateway.New(gateway.Options{
		Upstream: target,
		Routes:   routesStore(t, `{"default":"proxy","routes":{"shadow.probe":{"mode":"shadow","readOnly":true}}}`),
		Logger:   logger,
		Local:    localServer,
	})
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)

	if err := cancelingRequest(t, http.MethodPost, server.URL+"/rpc/shadow/probe", cookie, `{"json":{}}`, 100*time.Millisecond); err == nil {
		t.Fatal("client did not go away")
	}
	time.Sleep(700 * time.Millisecond) // past the TypeScript answer and the comparison
	if diffs := sink.matching("go.wire.diff"); len(diffs) != 0 {
		t.Fatalf("a canceled shadow recorded %d diffs: %v", len(diffs), diffs)
	}
	if skips := sink.matching("go.shadow.skipped"); len(skips) != 1 {
		t.Fatalf("skips = %d, want 1: %v", len(skips), sink.all())
	}
	if level := sink.level("ERROR"); level != 0 {
		t.Fatalf("ERROR lines = %d, want 0: %v", level, sink.all())
	}
}
