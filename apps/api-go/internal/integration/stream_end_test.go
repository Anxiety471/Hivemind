package integration

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/contentcrypto"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/events"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/local"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/shared"
)

// ownerExec runs a statement as the fixture's owner, for what the runtime role may not do: the
// migrations URL is the only login with the grants to revoke one.
func ownerExec(t *testing.T, database *db.DB, query string, args ...any) {
	t.Helper()
	url := os.Getenv("DATABASE_MIGRATION_URL")
	if url == "" {
		t.Skip("set DATABASE_MIGRATION_URL to the fixture owner to inject a permission failure")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	conn, err := pgx.Connect(ctx, url)
	if err != nil {
		t.Fatalf("owner connect: %v", err)
	}
	defer conn.Close(context.WithoutCancel(ctx))
	if _, err := conn.Exec(ctx, query, args...); err != nil {
		t.Fatalf("owner exec %q: %v", query, err)
	}
}

// roleThatCannotReadThreads revokes the runtime role's SELECT on threads and returns the grant
// that puts it back.
func roleThatCannotReadThreads(t *testing.T, database *db.DB) func() {
	t.Helper()
	role := pgx.Identifier{database.Pool.Config().ConnConfig.User}.Sanitize()
	ownerExec(t, database, `REVOKE SELECT ON threads FROM `+role)
	return func() {
		ownerExec(t, database, `GRANT SELECT ON threads TO `+role)
	}
}

// An unopenable payload: a ciphertext whose key does not exist. Every reader that opens it fails.
const unopenablePayload = `{"$sealed":"rkz1:nokey:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}`

// errorCode reads the code out of an `event: error` body.
func errorCode(t *testing.T, data string) string {
	t.Helper()
	var envelope struct {
		JSON struct {
			Code string `json:"code"`
		} `json:"json"`
	}
	if err := json.Unmarshal([]byte(data), &envelope); err != nil {
		t.Fatalf("error frame %q: %v", data, err)
	}
	return envelope.JSON.Code
}

// closedWithin reports whether the server ended the body within the wait.
func closedWithin(t *testing.T, frames <-chan sseFrame, wait time.Duration) bool {
	t.Helper()
	deadline := time.After(wait)
	for {
		select {
		case <-deadline:
			return false
		case _, ok := <-frames:
			if !ok {
				return true
			}
		}
	}
}

// TestThreadSubscribeEndsWhenAFrameFailsItsSchema: oRPC's output validation throws
// EVENT_ITERATOR_VALIDATION_FAILED inside the iterator, which the server writes as one `error`
// event and closes (measured against TypeScript: 26 ms, one frame, the body ends). Before this
// test the Go stream dropped the frame and kept heartbeating for as long as the tab was open.
func TestThreadSubscribeEndsWhenAFrameFailsItsSchema(t *testing.T) {
	database := openTestDB(t)
	s := seed(t, database)
	botID, threadID := addStreamChat(t, database, "schema-end", s.Space1, s.UserID)
	exec(t, database, `INSERT INTO events (id, "spaceId", "threadId", "botId", seq, type, payload, "createdAt")
		VALUES ($1, $2, $3, $4, 1, 'thread.progress', '{"step":1}'::jsonb, now())`,
		"ev-schema-1-"+s.UserID, s.Space1, threadID, botID)
	// thread.thinking needs its run; ProductEventSchema rejects the frame without one.
	exec(t, database, `INSERT INTO events (id, "spaceId", "threadId", "botId", seq, type, payload, "createdAt")
		VALUES ($1, $2, $3, $4, 2, 'thread.thinking', '{"segment":0,"durationMs":5,"lines":["x"]}'::jsonb, now())`,
		"ev-schema-2-"+s.UserID, s.Space1, threadID, botID)
	exec(t, database, `INSERT INTO events (id, "spaceId", "threadId", "botId", seq, type, payload, "createdAt")
		VALUES ($1, $2, $3, $4, 3, 'thread.progress', '{"step":3}'::jsonb, now())`,
		"ev-schema-3-"+s.UserID, s.Space1, threadID, botID)

	ring := contentcrypto.NewKeyRing(nil, nil, contentcrypto.KeyRingOptions{})
	server := testServerDeployed(t, database, local.Config{Stream: streamTiming()}, nil,
		shared.Deployment{Content: ring})
	cookie := "better-auth.session_token=" + signedCookie(testSecret, s.SessionToken)
	response, frames := openStreamBody(t, server.URL+"/rpc/threads/subscribe", cookie, s.Space1,
		streamInput(t, map[string]any{"botId": botID, "cursor": -1}))
	if response.StatusCode != http.StatusOK {
		t.Fatalf("status = %d", response.StatusCode)
	}
	first, ok := nextFrameWithin(t, frames, 2*time.Second)
	if !ok || first.event != "message" || !strings.Contains(first.data, `"seq":1`) {
		t.Fatalf("first frame = %+v", first)
	}
	failure, ok := nextFrameWithin(t, frames, time.Second)
	if !ok || failure.event != "error" {
		t.Fatalf("second frame = %+v", failure)
	}
	// The exact bytes TypeScript sends for this failure.
	want := `{"json":{"defined":false,"code":"EVENT_ITERATOR_VALIDATION_FAILED","status":500,"message":"Event iterator validation failed"}}`
	if failure.data != want {
		t.Fatalf("error frame = %s\nwant %s", failure.data, want)
	}
	if !closedWithin(t, frames, time.Second) {
		t.Fatal("the stream kept running after its frame failed the schema")
	}
}

// TestThreadSubscribeEndsWhenAReadFails: a payload no key can open fails the batch read, so no
// frame from that batch goes out and the stream ends with one INTERNAL_SERVER_ERROR event — what
// TypeScript does (measured: 14 ms, one error frame, the body ends).
func TestThreadSubscribeEndsWhenAReadFails(t *testing.T) {
	database := openTestDB(t)
	s := seed(t, database)
	botID, threadID := addStreamChat(t, database, "read-end", s.Space1, s.UserID)
	exec(t, database, `INSERT INTO events (id, "spaceId", "threadId", "botId", seq, type, payload, "createdAt")
		VALUES ($1, $2, $3, $4, 1, 'thread.progress', '{"step":1}'::jsonb, now())`,
		"ev-read-1-"+s.UserID, s.Space1, threadID, botID)
	exec(t, database, `INSERT INTO events (id, "spaceId", "threadId", "botId", seq, type, payload, "createdAt")
		VALUES ($1, $2, $3, $4, 2, 'thread.progress', $5::jsonb, now())`,
		"ev-read-2-"+s.UserID, s.Space1, threadID, botID, unopenablePayload)

	ring := contentcrypto.NewKeyRing(nil, nil, contentcrypto.KeyRingOptions{})
	server := testServerDeployed(t, database, local.Config{Stream: streamTiming()}, nil,
		shared.Deployment{Content: ring})
	cookie := "better-auth.session_token=" + signedCookie(testSecret, s.SessionToken)
	response, frames := openStreamBody(t, server.URL+"/rpc/threads/subscribe", cookie, s.Space1,
		streamInput(t, map[string]any{"botId": botID, "cursor": -1}))
	if response.StatusCode != http.StatusOK {
		t.Fatalf("status = %d", response.StatusCode)
	}
	failure, ok := nextFrameWithin(t, frames, 2*time.Second)
	if !ok || failure.event != "error" {
		t.Fatalf("first frame = %+v (a failing batch must send no message)", failure)
	}
	if code := errorCode(t, failure.data); code != "INTERNAL_SERVER_ERROR" {
		t.Fatalf("error code = %s", code)
	}
	if !closedWithin(t, frames, time.Second) {
		t.Fatal("the stream kept running after its read failed")
	}
}

// TestThreadSubscribeSkipsAPayloadOnlyANestedStringLooksEncrypted: openJson opens a sealed value
// and nothing else, so a nested ciphertext-shaped string is data (content-crypto.ts:121-125).
func TestThreadSubscribeSkipsAPayloadOnlyANestedStringLooksEncrypted(t *testing.T) {
	database := openTestDB(t)
	s := seed(t, database)
	botID, threadID := addStreamChat(t, database, "nested", s.Space1, s.UserID)
	exec(t, database, `INSERT INTO events (id, "spaceId", "threadId", "botId", seq, type, payload, "createdAt")
		VALUES ($1, $2, $3, $4, 1, 'thread.progress', $5::jsonb, now())`,
		"ev-nested-"+s.UserID, s.Space1, threadID, botID,
		`{"note":"rkz1:nokey:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}`)

	ring := contentcrypto.NewKeyRing(nil, nil, contentcrypto.KeyRingOptions{})
	server := testServerDeployed(t, database, local.Config{Stream: streamTiming()}, nil,
		shared.Deployment{Content: ring})
	cookie := "better-auth.session_token=" + signedCookie(testSecret, s.SessionToken)
	_, frames := openStreamBody(t, server.URL+"/rpc/threads/subscribe", cookie, s.Space1,
		streamInput(t, map[string]any{"botId": botID, "cursor": -1}))
	frame, ok := nextFrameWithin(t, frames, 2*time.Second)
	if !ok || frame.event != "message" ||
		!strings.Contains(frame.data, `"payload":{"note":"rkz1:nokey:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}`) {
		t.Fatalf("frame = %+v", frame)
	}
}

// TestNotificationsSubscribeRosterScopeFailureEndsTheStream: TypeScript's first `await watch()`
// throws, account.ts holds SIGNAL_FAILURE_HOLD_MS and rethrows, and the whole stream ends. (A
// *re-read* failure is different: followRosterChanges swallows it, "the next wake tries again".)
func TestNotificationsSubscribeRosterScopeFailureEndsTheStream(t *testing.T) {
	database := openTestDB(t)
	s := seed(t, database)
	fanout := events.NewFanout(database.Pool.Config().ConnConfig, nil)
	t.Cleanup(fanout.Close)
	// The roster scope reads threads; the revoked grant fails the first watch and nothing else.
	restore := roleThatCannotReadThreads(t, database)
	defer restore()
	server := testServerDeployed(t, database, local.Config{Stream: streamTiming()}, nil, shared.Deployment{Realtime: fanout})
	cookie := "better-auth.session_token=" + signedCookie(testSecret, s.SessionToken)
	response, frames := openStreamBody(t, server.URL+"/rpc/notifications/subscribe", cookie, s.Space1, `{"json":{}}`)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("status = %d", response.StatusCode)
	}
	// The sources that do not need a scope still deliver their opening burst (the roster never
	// arrives: its first watch failed). Extra Space frames are the listener's catch-up, which the
	// TypeScript source adds the same way.
	seen := map[string]bool{}
	deadline := time.After(3 * time.Second)
	for !seen["organizations"] {
		select {
		case <-deadline:
			t.Fatalf("initial burst = %v", seen)
		case frame, ok := <-frames:
			if !ok {
				t.Fatalf("the stream ended during its opening burst: %v", seen)
			}
			if frame.event == "error" {
				t.Fatalf("error frame during the opening burst: %+v", frame)
			}
			var body struct {
				JSON struct {
					Type string `json:"type"`
				} `json:"json"`
			}
			if json.Unmarshal([]byte(frame.data), &body) == nil && body.JSON.Type != "" {
				seen[body.JSON.Type] = true
			}
		}
	}
	if seen["roster"] {
		t.Fatalf("a roster frame arrived although its scope could not be read: %v", seen)
	}
	// The failure is held, not sent at once. Later Space frames (the listener's catch-up) are
	// expected; an error or a roster frame is not.
	hold := time.After(2 * time.Second)
	for waiting := true; waiting; {
		select {
		case <-hold:
			waiting = false
		case frame, ok := <-frames:
			if !ok {
				t.Fatal("the stream ended before the hold")
			}
			if frame.event == "error" {
				t.Fatalf("the failure was not held: %+v", frame)
			}
			if strings.Contains(frame.data, `"type":"roster"`) {
				t.Fatalf("a roster frame arrived although its scope could not be read: %+v", frame)
			}
		}
	}
	// Heartbeats keep the stream alive during the hold; the error comes when it ends.
	failure, ok := errorWithin(t, frames, 35*time.Second)
	if !ok {
		t.Fatal("the held failure never ended the stream")
	}
	if code := errorCode(t, failure.data); code != "INTERNAL_SERVER_ERROR" {
		t.Fatalf("error code = %s", code)
	}
	if !closedWithin(t, frames, time.Second) {
		t.Fatal("the stream kept running after its roster scope failed")
	}
}

// TestNotificationsSubscribeSurvivesARosterReReadFailure: followRosterChanges keeps the chats it
// already watches when a re-read fails (roster-changes.ts:145-150), so the stream neither ends nor
// stops delivering the sources that do not need the scope.
func TestNotificationsSubscribeSurvivesARosterReReadFailure(t *testing.T) {
	database := openTestDB(t)
	s := seed(t, database)
	fanout := events.NewFanout(database.Pool.Config().ConnConfig, nil)
	t.Cleanup(fanout.Close)
	server := testServerDeployed(t, database, local.Config{Stream: streamTiming()}, nil, shared.Deployment{Realtime: fanout})
	cookie := "better-auth.session_token=" + signedCookie(testSecret, s.SessionToken)
	_, frames := openStreamBody(t, server.URL+"/rpc/notifications/subscribe", cookie, s.Space1, `{"json":{}}`)
	for !untilType(t, frames, "roster", 5*time.Second) {
	}
	// Take away what the re-read needs, wake the roster, and check the stream keeps going.
	restore := roleThatCannotReadThreads(t, database)
	defer restore()
	publishSignal(t, database, "roster-user:"+s.UserID, "")
	// No roster frame while the re-read fails; the held wake is spent, the stream is alive.
	if frame, ok := nextFrameWithin(t, frames, 500*time.Millisecond); ok && frame.event == "error" {
		t.Fatalf("a re-read failure ended the stream: %+v", frame)
	}
	restore()
	publishSignal(t, database, "roster-user:"+s.UserID, "")
	// The next wake re-reads fine and frames the roster.
	deadline := time.After(5 * time.Second)
	for {
		select {
		case <-deadline:
			t.Fatal("the roster frame never arrived after the re-read recovered")
		case frame, ok := <-frames:
			if !ok {
				t.Fatal("the stream ended")
			}
			if frame.event == "message" && strings.Contains(frame.data, `"type":"roster"`) {
				return
			}
		}
	}
}

// TestNotificationsSubscribeCallsEndsWhenTheReadFails: the handler awaits loadUserIncomingCalls
// inside the generator, so a read failure is one error event and a closed body.
func TestNotificationsSubscribeCallsEndsWhenTheReadFails(t *testing.T) {
	database := openTestDB(t)
	s := seed(t, database)
	ctx := t.Context()
	ring := keyedRing(t, database)
	fanout := events.NewFanout(database.Pool.Config().ConnConfig, nil)
	t.Cleanup(fanout.Close)
	_, threadID := addStreamChat(t, database, "calls-end", s.Space1, s.UserID)
	sealed, err := ring.SealRow(ctx, "Message", map[string]any{
		"id": "call-end-" + s.UserID, "threadId": threadID, "seq": 1, "role": "bot",
		"clientNonce": "call:end-" + s.UserID + ":request",
		"blocks": []any{map[string]any{
			"kind": "call_request", "status": "ringing", "callId": "end-" + s.UserID,
			"reason": "Checking in", "opening": "Hello?",
			"expiresAt": time.Now().Add(time.Minute).UTC().Format("2006-01-02T15:04:05.000Z"),
		}},
		"createdAt": time.Now().UTC(),
	})
	if err != nil {
		t.Fatalf("seal message: %v", err)
	}
	exec(t, database, `INSERT INTO messages (id, "threadId", seq, role, blocks, "clientNonce", "createdAt")
		VALUES ($1, $2, 1, 'bot', $3::jsonb, $4, now())`,
		"call-end-"+s.UserID, threadID, sealed["blocks"], "call:end-"+s.UserID+":request")
	server := testServerDeployed(t, database, local.Config{Stream: streamTiming()}, nil,
		shared.Deployment{Realtime: fanout, Content: ring, PhoneCallsEnabled: true})
	cookie := "better-auth.session_token=" + signedCookie(testSecret, s.SessionToken)
	// The call reads fine, then its block becomes unopenable.
	response, frames := openStreamBody(t, server.URL+"/rpc/notifications/subscribeCalls", cookie, s.Space1, `{"json":{}}`)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("status = %d", response.StatusCode)
	}
	if frame, ok := nextFrameWithin(t, frames, 2*time.Second); !ok || frame.event != "message" ||
		!strings.Contains(frame.data, "end-"+s.UserID) {
		t.Fatalf("ringing frame = %+v", frame)
	}
	// The plain scalars the query filters on stay, so the row is still a ringing request; only the
	// ciphertext is one no key can open.
	exec(t, database, `UPDATE messages SET blocks = $2::jsonb WHERE id = $1`,
		"call-end-"+s.UserID, `[{"status":"ringing","$sealed":"rkz1:nokey:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}]`)
	publishSignal(t, database, "incoming-calls:"+s.UserID, "")
	failure, ok := nextFrameWithin(t, frames, 2*time.Second)
	if !ok || failure.event != "error" {
		t.Fatalf("after the failing read: %+v", failure)
	}
	if code := errorCode(t, failure.data); code != "INTERNAL_SERVER_ERROR" {
		t.Fatalf("error code = %s", code)
	}
	if !closedWithin(t, frames, time.Second) {
		t.Fatal("the stream kept running after its read failed")
	}
}

// errorWithin waits for the stream's `error` frame, skipping messages.
func errorWithin(t *testing.T, frames <-chan sseFrame, wait time.Duration) (sseFrame, bool) {
	t.Helper()
	deadline := time.After(wait)
	for {
		select {
		case <-deadline:
			return sseFrame{}, false
		case frame, ok := <-frames:
			if !ok {
				return sseFrame{}, false
			}
			if frame.event == "error" {
				return frame, true
			}
		}
	}
}

// untilType drains frames until one names want, reporting whether it arrived.
func untilType(t *testing.T, frames <-chan sseFrame, want string, wait time.Duration) bool {
	t.Helper()
	deadline := time.After(wait)
	for {
		select {
		case <-deadline:
			return false
		case frame, ok := <-frames:
			if !ok {
				return false
			}
			if frame.event == "message" && strings.Contains(frame.data, `"type":"`+want+`"`) {
				return true
			}
		}
	}
}

// drainInitialTypes collects count message frames and returns their types in arrival order.
func drainInitialTypes(t *testing.T, frames <-chan sseFrame, count int) []string {
	t.Helper()
	types := make([]string, 0, count)
	for len(types) < count {
		frame, ok := nextMessageWithin(t, frames, 5*time.Second)
		if !ok {
			t.Fatalf("only %d of %d initial frames arrived: %v", len(types), count, types)
		}
		kind, _ := frame["type"].(string)
		types = append(types, kind)
	}
	return types
}

// TestThreadSubscribeEndsWhenARunLookupFails: the peer/background classification queries runs; a
// failure there is thrown out of the generator like any other read, so one error event and close.
func TestThreadSubscribeEndsWhenARunLookupFails(t *testing.T) {
	database := openTestDB(t)
	s := seed(t, database)
	botID, threadID := addStreamChat(t, database, "run-lookup", s.Space1, s.UserID)
	runID := "run-lookup-fail-" + s.UserID
	addStreamRun(t, database, runID, s.Space1, botID, threadID, s.UserID, "user_message")
	// The run is what the filter classifies, so the event has to name it.
	exec(t, database, `INSERT INTO events (id, "spaceId", "threadId", "botId", seq, type, payload, "runId", "createdAt")
		VALUES ($1, $2, $3, $4, 1, 'thread.progress', '{"step":1}'::jsonb, $5, now())`,
		"ev-lookup-"+s.UserID, s.Space1, threadID, botID, runID)
	role := pgx.Identifier{database.Pool.Config().ConnConfig.User}.Sanitize()
	ownerExec(t, database, `REVOKE SELECT ON runs FROM `+role)
	defer ownerExec(t, database, `GRANT SELECT ON runs TO `+role)
	server := testServerDeployed(t, database, local.Config{Stream: streamTiming()}, nil, shared.Deployment{})
	cookie := "better-auth.session_token=" + signedCookie(testSecret, s.SessionToken)
	_, frames := openStreamBody(t, server.URL+"/rpc/threads/subscribe", cookie, s.Space1,
		streamInput(t, map[string]any{"botId": botID, "cursor": -1}))
	failure, ok := errorWithin(t, frames, 3*time.Second)
	if !ok {
		t.Fatal("the stream did not report the failed run lookup")
	}
	if code := errorCode(t, failure.data); code != "INTERNAL_SERVER_ERROR" {
		t.Fatalf("error code = %s", code)
	}
	if !closedWithin(t, frames, time.Second) {
		t.Fatal("the stream kept running after its run lookup failed")
	}
}

// TestThreadSubscribeResolveFailureIsOneErrorEvent: the target lookup runs inside the generator in
// TypeScript, so a database failure at open is a 200 whose stream carries one error event — not
// an HTTP 503. (A refused target already answers this way.)
func TestThreadSubscribeResolveFailureIsOneErrorEvent(t *testing.T) {
	database := openTestDB(t)
	s := seed(t, database)
	botID, _ := addStreamChat(t, database, "resolve-fail", s.Space1, s.UserID)
	role := pgx.Identifier{database.Pool.Config().ConnConfig.User}.Sanitize()
	ownerExec(t, database, `REVOKE SELECT ON bots FROM `+role)
	defer ownerExec(t, database, `GRANT SELECT ON bots TO `+role)
	server := testServerDeployed(t, database, local.Config{Stream: streamTiming()}, nil, shared.Deployment{})
	cookie := "better-auth.session_token=" + signedCookie(testSecret, s.SessionToken)
	response, frames := openStreamBody(t, server.URL+"/rpc/threads/subscribe", cookie, s.Space1,
		streamInput(t, map[string]any{"botId": botID, "cursor": -1}))
	if response.StatusCode != http.StatusOK {
		t.Fatalf("status = %d", response.StatusCode)
	}
	failure, ok := errorWithin(t, frames, 3*time.Second)
	if !ok || failure.event != "error" {
		t.Fatalf("frame = %+v", failure)
	}
	if code := errorCode(t, failure.data); code != "INTERNAL_SERVER_ERROR" && code != "SERVICE_UNAVAILABLE" {
		t.Fatalf("error code = %s", code)
	}
	if !closedWithin(t, frames, time.Second) {
		t.Fatal("the stream kept running after its target lookup failed")
	}
}

// TestNotificationsSubscribeKeepsEverySpaceKindInABurst: the fanout's channel drops the newest
// signal when thirty-two pile up behind a slow reader, and a Space frame carries its kind, so a
// mixed burst could lose one. TypeScript adds each kind to a Set in the subscribe callback; the
// Go source does the same through the fanout's callback, so forty signals in one batch keep all
// four kinds.
func TestNotificationsSubscribeKeepsEverySpaceKindInABurst(t *testing.T) {
	database := openTestDB(t)
	s := seed(t, database)
	fanout := events.NewFanout(database.Pool.Config().ConnConfig, nil)
	t.Cleanup(fanout.Close)
	server := testServerDeployed(t, database, local.Config{Stream: streamTiming()}, nil, shared.Deployment{Realtime: fanout})
	cookie := "better-auth.session_token=" + signedCookie(testSecret, s.SessionToken)
	_, frames := openStreamBody(t, server.URL+"/rpc/notifications/subscribe", cookie, s.Space1, `{"json":{}}`)
	for !untilType(t, frames, "organizations", 5*time.Second) {
	}
	// One statement, forty notifications: the listener hands them over in one batch.
	notifies := make([]string, 0, 40)
	args := make([]any, 0, 40)
	kinds := []string{"computerUpdates", "runs", "routines", "files"}
	for index := range 40 {
		notifies = append(notifies, fmt.Sprintf(`pg_notify('rakazo_events', $%d)`, index+1))
		payload, _ := json.Marshal(map[string]string{"topic": "space-changes:" + s.Space1, "payload": kinds[index%len(kinds)]})
		args = append(args, string(payload))
	}
	exec(t, database, `SELECT `+strings.Join(notifies, ", "), args...)
	seen := map[string]bool{}
	deadline := time.After(5 * time.Second)
	for len(seen) < len(kinds) {
		select {
		case <-deadline:
			t.Fatalf("kinds after the burst = %v", seen)
		case frame, ok := <-frames:
			if !ok {
				t.Fatalf("the stream ended; kinds = %v", seen)
			}
			if frame.event != "message" {
				continue
			}
			for _, kind := range kinds {
				if strings.Contains(frame.data, `"type":"`+kind+`"`) {
					seen[kind] = true
				}
			}
		}
	}
}

// TestStreamKeepaliveWaitsForSilence: oRPC arms its keepalive timer per pull and clears it when a
// frame arrives, so a stream that keeps sending carries no comment after the opening one.
func TestStreamKeepaliveWaitsForSilence(t *testing.T) {
	database := openTestDB(t)
	s := seed(t, database)
	fanout := events.NewFanout(database.Pool.Config().ConnConfig, nil)
	t.Cleanup(fanout.Close)
	server := testServerDeployed(t, database, local.Config{Stream: streamTiming()}, nil, shared.Deployment{Realtime: fanout})
	cookie := "better-auth.session_token=" + signedCookie(testSecret, s.SessionToken)
	_, frames := openStreamBody(t, server.URL+"/rpc/notifications/subscribe", cookie, s.Space1, `{"json":{}}`)
	// A frame every few milliseconds for longer than the keepalive interval (50 ms in
	// streamTiming), so every keepalive timer would fire if it were not reset by a frame.
	messages, comments := 0, 0
	deadline := time.After(400 * time.Millisecond)
	for waiting := true; waiting; {
		publishSignal(t, database, "space-changes:"+s.Space1, "runs")
		select {
		case <-deadline:
			waiting = false
		case frame, ok := <-frames:
			if !ok {
				t.Fatal("the stream ended")
			}
			switch frame.event {
			case "message":
				messages += 1
			case "":
				// A comment block: the opening one is the only one allowed.
				comments += 1
			}
		case <-time.After(10 * time.Millisecond):
		}
	}
	if messages < 3 {
		t.Fatalf("only %d frames arrived; the keepalive check needs a busy stream", messages)
	}
	if comments > 1 {
		t.Fatalf("%d keepalive comments arrived while frames were flowing", comments)
	}
}
