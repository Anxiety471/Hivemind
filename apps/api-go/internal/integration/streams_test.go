package integration

import (
	"bufio"
	"context"
	"encoding/json"
	"net/http"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/contentcrypto"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/events"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/local"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/shared"
)

// The live-update streams: threads.subscribe, threads.helperSubscribe, notifications.subscribe and
// notifications.subscribeCalls. The contract harness compares them against TypeScript frame by
// frame; these tests pin the parts no comparison can show (goroutines, LISTEN connections, the
// pooled connection a stream must not hold) and the frame contents' edge cases.

// streamTiming keeps heartbeats out of the way of assertions and re-checks the session quickly.
func streamTiming() local.StreamTiming {
	return local.StreamTiming{
		Keepalive: 50 * time.Millisecond,
		Heartbeat: 5 * time.Second,
		Recheck:   3 * time.Second,
	}
}

// openStreamBody posts to a streaming procedure and returns the frames as they arrive.
func openStreamBody(t *testing.T, url, cookie, space, body string) (*http.Response, <-chan sseFrame) {
	t.Helper()
	request, err := http.NewRequest(http.MethodPost, url, strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("cookie", cookie)
	request.Header.Set("origin", "https://app.example.test")
	request.Header.Set("content-type", "application/json")
	request.Header.Set("x-rakazo-space-id", space)
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	response, err := http.DefaultClient.Do(request.WithContext(ctx))
	if err != nil {
		t.Fatalf("open stream: %v", err)
	}
	t.Cleanup(func() { response.Body.Close() })
	frames := make(chan sseFrame, 256)
	go func() {
		defer close(frames)
		readFrames(response, frames)
	}()
	return response, frames
}

// readFrames splits a server-sent event body into frames until the connection ends.
func readFrames(response *http.Response, frames chan<- sseFrame) {
	reader := bufio.NewReader(response.Body)
	var frame sseFrame
	for {
		line, err := reader.ReadString('\n')
		if err != nil {
			return
		}
		line = strings.TrimSuffix(line, "\n")
		switch {
		case line == "":
			frames <- frame
			frame = sseFrame{}
		case strings.HasPrefix(line, "event: "):
			frame.event = strings.TrimPrefix(line, "event: ")
		case strings.HasPrefix(line, "data: "):
			frame.data = strings.TrimPrefix(line, "data: ")
		}
	}
}

// nextMessageWithin is nextMessage with its own deadline.
func nextMessageWithin(t *testing.T, frames <-chan sseFrame, wait time.Duration) (map[string]any, bool) {
	t.Helper()
	deadline := time.After(wait)
	for {
		select {
		case <-deadline:
			return nil, false
		case frame, ok := <-frames:
			if !ok {
				return nil, false
			}
			if frame.event != "message" {
				if frame.event == "error" {
					return map[string]any{"__error": frame.data}, true
				}
				continue
			}
			var envelope struct {
				JSON map[string]any `json:"json"`
			}
			if err := json.Unmarshal([]byte(frame.data), &envelope); err != nil {
				t.Fatalf("frame %q: %v", frame.data, err)
			}
			return envelope.JSON, true
		}
	}
}

func streamInput(t *testing.T, value any) string {
	t.Helper()
	raw, err := json.Marshal(map[string]any{"json": value})
	if err != nil {
		t.Fatalf("marshal input: %v", err)
	}
	return string(raw)
}

// addStreamChat seeds one bot of the Space with its direct chat.
func addStreamChat(t *testing.T, database *db.DB, tag, spaceID, userID string) (string, string) {
	t.Helper()
	botID, threadID := "sb-"+tag+"-"+userID, "st-"+tag+"-"+userID
	addBot(t, database, botID, spaceID, userID, "Stream "+tag+" bot")
	exec(t, database, `INSERT INTO threads (id, "spaceId", "userId", "botId", "nextMessageSeq", "nextEventSeq", "createdAt")
		VALUES ($1, $2, $3, $4, 1, 1, now())`, threadID, spaceID, userID, botID)
	return botID, threadID
}

// addStreamRun seeds one run the peer/background filter can classify.
func addStreamRun(t *testing.T, database *db.DB, id, spaceID, botID, threadID, userID, trigger string) {
	t.Helper()
	exec(t, database, `INSERT INTO tasks (id, "spaceId", "botId", "threadId", "userId", prompt, status, "createdAt", "updatedAt")
		VALUES ($1, $2, $3, $4, $5, 'stream fixture', 'running', now(), now())`,
		"task-"+id, spaceID, botID, threadID, userID)
	exec(t, database, `INSERT INTO runs (id, "spaceId", "botId", "threadId", "taskId", "userId", status, trigger, "createdAt", "updatedAt")
		VALUES ($1, $2, $3, $4, $5, $6, 'running', $7, now(), now())`,
		id, spaceID, botID, threadID, "task-"+id, userID, trigger)
}

// addHelperChat seeds a background helper's own thread: no botId, only helperBotId.
func addHelperChat(t *testing.T, database *db.DB, tag, spaceID, userID string) (string, string) {
	t.Helper()
	botID, threadID := "sb-"+tag+"-"+userID, "st-"+tag+"-"+userID
	addBot(t, database, botID, spaceID, userID, "Stream "+tag+" bot")
	exec(t, database, `INSERT INTO threads (id, "spaceId", "userId", "helperBotId", "nextMessageSeq", "nextEventSeq", "createdAt")
		VALUES ($1, $2, $3, $4, 1, 1, now())`, threadID, spaceID, userID, botID)
	return botID, threadID
}

// publishSignal publishes one realtime envelope on the channel every process listens to.
func publishSignal(t *testing.T, database *db.DB, topic, payload string) {
	t.Helper()
	envelope, err := json.Marshal(map[string]string{"topic": topic, "payload": payload})
	if err != nil {
		t.Fatalf("envelope: %v", err)
	}
	exec(t, database, `SELECT pg_notify('rakazo_events', $1)`, string(envelope))
}

// realtimeListenerCount is how many LISTEN connections this test's fanout holds open.
func realtimeListenerCount(t *testing.T, database *db.DB) int {
	t.Helper()
	var count int
	if err := database.Pool.QueryRow(context.Background(),
		`SELECT count(*) FROM pg_stat_activity WHERE application_name = 'rakazo-api-go-realtime'`).Scan(&count); err != nil {
		t.Fatalf("count listeners: %v", err)
	}
	return count
}

// waitForListener blocks until the fanout's connection is listening and has handed every current
// subscriber its catch-up signal (which happens right after LISTEN).
func waitForListener(t *testing.T, database *db.DB) {
	t.Helper()
	for attempt := 0; attempt < 200; attempt++ {
		var idle int
		if err := database.Pool.QueryRow(context.Background(),
			`SELECT count(*) FROM pg_stat_activity
			 WHERE application_name = 'rakazo-api-go-realtime' AND state = 'idle'`).Scan(&idle); err == nil && idle > 0 {
			// LISTEN committed; the catch-up delivery is the next thing the listener does.
			time.Sleep(100 * time.Millisecond)
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("the realtime listener never connected")
}

// drainInitial reads exactly count frames, skipping comments.
func drainInitial(t *testing.T, frames <-chan sseFrame, count int) []map[string]any {
	t.Helper()
	var out []map[string]any
	for len(out) < count {
		frame, ok := nextMessageWithin(t, frames, 5*time.Second)
		if !ok {
			t.Fatalf("only %d of %d initial frames arrived: %v", len(out), count, out)
		}
		out = append(out, frame)
	}
	return out
}

func frameTypes(frames []map[string]any) []string {
	types := make([]string, len(frames))
	for index, frame := range frames {
		types[index], _ = frame["type"].(string)
	}
	sort.Strings(types)
	return types
}

func TestThreadSubscribeReplaysInOrderFiltersPeerAndBackgroundRuns(t *testing.T) {
	database := openTestDB(t)
	s := seed(t, database)
	ctx := context.Background()
	ring := keyedRing(t, database)
	botID, threadID := addStreamChat(t, database, "replay", s.Space1, s.UserID)
	addStreamRun(t, database, "sr-peer-"+s.UserID, s.Space1, botID, threadID, s.UserID, "bot_message")
	addStreamRun(t, database, "sr-ticket-"+s.UserID, s.Space1, botID, threadID, s.UserID, "tickets")
	addStreamRun(t, database, "sr-user-"+s.UserID, s.Space1, botID, threadID, s.UserID, "user")
	peerRun, ticketRun := "sr-peer-"+s.UserID, "sr-ticket-"+s.UserID

	mustAppend := func(input events.Input) events.Event {
		t.Helper()
		event, err := appendInSystem(ctx, database, ring, input, false)
		if err != nil {
			t.Fatalf("append %s: %v", input.Type, err)
		}
		return event
	}
	// 0: plain progress, 1: a peer run's progress (filtered), 2: a peer run's receipt (kept),
	// 3: a ticket run's chatter (filtered), 4: a peer run's terminal (kept).
	progress := mustAppend(events.Input{SpaceID: s.Space1, ThreadID: threadID, BotID: botID,
		Type: "thread.progress", Payload: map[string]any{"label": "thinking"}})
	mustAppend(events.Input{SpaceID: s.Space1, ThreadID: threadID, BotID: botID, RunID: peerRun,
		Type: "thread.progress", Payload: map[string]any{"label": "peer progress"}})
	message := mustAppend(events.Input{SpaceID: s.Space1, ThreadID: threadID, BotID: botID, RunID: peerRun,
		Type: "thread.message.created", Payload: map[string]any{
			"messageId": "m-1", "role": "bot",
			"blocks": []any{map[string]any{"kind": "text", "text": "hello"}},
		}})
	mustAppend(events.Input{SpaceID: s.Space1, ThreadID: threadID, BotID: botID, RunID: ticketRun,
		Type: "thread.message.created", Payload: map[string]any{
			"messageId": "m-2", "role": "bot",
			"blocks": []any{map[string]any{"kind": "text", "text": "ticket work"}},
		}})
	completed := mustAppend(events.Input{SpaceID: s.Space1, ThreadID: threadID, BotID: botID, RunID: peerRun,
		Type: "run.completed", Payload: map[string]any{"status": "completed"}})

	server := testServerDeployed(t, database, local.Config{Stream: streamTiming()}, nil,
		shared.Deployment{Content: ring, Realtime: events.NewFanout(database.Pool.Config().ConnConfig, nil)})
	cookie := "better-auth.session_token=" + signedCookie(testSecret, s.SessionToken)
	url := server.URL + "/rpc/threads/subscribe"

	_, frames := openStreamBody(t, url, cookie, s.Space1, streamInput(t, map[string]any{"botId": botID, "cursor": -1}))
	received := drainInitial(t, frames, 3)
	if got := []any{received[0]["seq"], received[1]["seq"], received[2]["seq"]}; got[0] != float64(progress.Seq) || got[1] != float64(message.Seq) || got[2] != float64(completed.Seq) {
		t.Fatalf("replayed seqs = %v, want [%d %d %d]: %v", got, progress.Seq, message.Seq, completed.Seq, received)
	}
	if received[0]["type"] != "thread.progress" || received[1]["type"] != "thread.message.created" ||
		received[2]["type"] != "run.completed" {
		t.Fatalf("replayed types = %v", received)
	}
	first := received[0]
	if first["id"] == "" || first["spaceId"] != s.Space1 || first["threadId"] != threadID ||
		first["botId"] != botID {
		t.Fatalf("frame identity = %v", first)
	}
	if _, hasRun := first["runId"]; hasRun {
		t.Fatalf("an event without a run named one: %v", first)
	}
	payload, _ := first["payload"].(map[string]any)
	if payload["label"] != "thinking" {
		t.Fatalf("payload = %v", first["payload"])
	}
	created, _ := first["createdAt"].(string)
	if _, err := time.Parse("2006-01-02T15:04:05.000Z", created); err != nil {
		t.Fatalf("createdAt %q: %v", created, err)
	}
	if received[1]["runId"] != peerRun {
		t.Fatalf("peer receipt runId = %v", received[1]["runId"])
	}

	// A live event arrives after its signal.
	live := mustAppend(events.Input{SpaceID: s.Space1, ThreadID: threadID, BotID: botID,
		Type: "thread.message.updated", Payload: map[string]any{"messageId": "m-1"}})
	publishSignal(t, database, "thread:"+threadID, `{"cursor":`+strconv.Itoa(int(live.Seq))+`}`)
	frame, ok := nextMessageWithin(t, frames, 5*time.Second)
	if !ok || frame["seq"] != float64(live.Seq) {
		t.Fatalf("live frame = %v", frame)
	}

	// A cursor resumes after it: nothing at or below it is replayed.
	_, resumed := openStreamBody(t, url, cookie, s.Space1,
		streamInput(t, map[string]any{"botId": botID, "cursor": live.Seq}))
	if extra, ok := nextMessageWithin(t, resumed, 500*time.Millisecond); ok {
		t.Fatalf("a cursor at the newest event replayed %v", extra)
	}
}

func TestThreadSubscribeCursorReplaysOnlyNewerEvents(t *testing.T) {
	database := openTestDB(t)
	s := seed(t, database)
	ctx := context.Background()
	ring := keyedRing(t, database)
	botID, threadID := addStreamChat(t, database, "cursor", s.Space1, s.UserID)
	var seqs []int32
	for index := range 3 {
		event, err := appendInSystem(ctx, database, ring, events.Input{SpaceID: s.Space1,
			ThreadID: threadID, BotID: botID, Type: "thread.progress",
			Payload: map[string]any{"index": index}}, false)
		if err != nil {
			t.Fatalf("append: %v", err)
		}
		seqs = append(seqs, event.Seq)
	}
	server := testServerDeployed(t, database, local.Config{Stream: streamTiming()}, nil,
		shared.Deployment{Content: ring})
	cookie := "better-auth.session_token=" + signedCookie(testSecret, s.SessionToken)
	_, frames := openStreamBody(t, server.URL+"/rpc/threads/subscribe", cookie, s.Space1,
		streamInput(t, map[string]any{"botId": botID, "cursor": seqs[0]}))
	first, ok := nextMessageWithin(t, frames, 5*time.Second)
	if !ok || first["seq"] != float64(seqs[1]) {
		t.Fatalf("first frame after cursor = %v, want seq %d", first, seqs[1])
	}
	second, ok := nextMessageWithin(t, frames, 5*time.Second)
	if !ok || second["seq"] != float64(seqs[2]) {
		t.Fatalf("second frame = %v", second)
	}
	if extra, ok := nextMessageWithin(t, frames, 400*time.Millisecond); ok {
		t.Fatalf("unexpected extra frame %v", extra)
	}
}

func TestThreadSubscribeRejectsForeignArchivedAndBadInput(t *testing.T) {
	database := openTestDB(t)
	s := seed(t, database)
	server := testServerDeployed(t, database, local.Config{Stream: streamTiming()}, nil,
		shared.Deployment{})
	cookie := "better-auth.session_token=" + signedCookie(testSecret, s.SessionToken)
	url := server.URL + "/rpc/threads/subscribe"
	foreignBot, _ := addStreamChat(t, database, "foreign", s.Space2, s.UserID)
	archivedBot, _ := addStreamChat(t, database, "archived", s.Space1, s.UserID)
	exec(t, database, `UPDATE bots SET "archivedAt" = now() WHERE id = $1`, archivedBot)

	cases := []struct {
		name   string
		body   string
		status int
		code   string
	}{
		{"foreign", streamInput(t, map[string]any{"botId": foreignBot, "cursor": -1}), 404, "NOT_FOUND"},
		{"archived", streamInput(t, map[string]any{"botId": archivedBot, "cursor": -1}), 404, "NOT_FOUND"},
		{"missing-bot", streamInput(t, map[string]any{"botId": "nope", "cursor": -1}), 404, "NOT_FOUND"},
		{"both-targets", streamInput(t, map[string]any{"botId": foreignBot, "groupId": "g", "cursor": -1}), 400, "BAD_REQUEST"},
		{"no-target", streamInput(t, map[string]any{"cursor": -1}), 400, "BAD_REQUEST"},
		{"cursor-missing", streamInput(t, map[string]any{"botId": foreignBot}), 400, "BAD_REQUEST"},
		{"cursor-below-min", streamInput(t, map[string]any{"botId": foreignBot, "cursor": -2}), 400, "BAD_REQUEST"},
		{"cursor-float", streamInput(t, map[string]any{"botId": foreignBot, "cursor": 1.5}), 400, "BAD_REQUEST"},
		{"bot-id-empty", streamInput(t, map[string]any{"botId": "", "cursor": -1}), 400, "BAD_REQUEST"},
		{"no-input", ``, 400, "BAD_REQUEST"},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			response, body := do(t, http.MethodPost, url, cookie, testCase.body, nil)
			if response.StatusCode != testCase.status {
				t.Fatalf("status = %d, want %d: %s", response.StatusCode, testCase.status, body)
			}
			var envelope struct {
				JSON struct {
					Code string `json:"code"`
				} `json:"json"`
			}
			if err := json.Unmarshal(body, &envelope); err == nil && envelope.JSON.Code != "" &&
				envelope.JSON.Code != testCase.code {
				t.Fatalf("code = %s, want %s", envelope.JSON.Code, testCase.code)
			}
		})
	}
}

func TestHelperSubscribeForwardsEveryEventOfItsThread(t *testing.T) {
	database := openTestDB(t)
	s := seed(t, database)
	ctx := context.Background()
	ring := keyedRing(t, database)
	helperBot, threadID := addHelperChat(t, database, "helper", s.Space1, s.UserID)
	addStreamRun(t, database, "sr-helper-"+s.UserID, s.Space1, helperBot, threadID, s.UserID, "helper")
	// A helper run's own chatter is exactly what the helper stream exists for.
	event, err := appendInSystem(ctx, database, ring, events.Input{SpaceID: s.Space1, ThreadID: threadID,
		BotID: helperBot, RunID: "sr-helper-" + s.UserID, Type: "thread.progress",
		Payload: map[string]any{"label": "helper work"}}, false)
	if err != nil {
		t.Fatalf("append: %v", err)
	}
	server := testServerDeployed(t, database, local.Config{Stream: streamTiming()}, nil,
		shared.Deployment{Content: ring})
	cookie := "better-auth.session_token=" + signedCookie(testSecret, s.SessionToken)
	_, frames := openStreamBody(t, server.URL+"/rpc/threads/helperSubscribe", cookie, s.Space1,
		streamInput(t, map[string]any{"threadId": threadID, "cursor": -1}))
	frame, ok := nextMessageWithin(t, frames, 5*time.Second)
	if !ok || frame["seq"] != float64(event.Seq) || frame["botId"] != helperBot {
		t.Fatalf("helper frame = %v", frame)
	}
	// A chat that is not a helper thread is not found.
	_, chatThread := addStreamChat(t, database, "plain", s.Space1, s.UserID)
	response, body := do(t, http.MethodPost, server.URL+"/rpc/threads/helperSubscribe", cookie,
		streamInput(t, map[string]any{"threadId": chatThread, "cursor": -1}), nil)
	if response.StatusCode != 404 {
		t.Fatalf("helperSubscribe on a chat: %d %s", response.StatusCode, body)
	}
}

func TestThreadSubscribeHeartbeatNamesTheChat(t *testing.T) {
	database := openTestDB(t)
	s := seed(t, database)
	ring := keyedRing(t, database)
	botID, threadID := addStreamChat(t, database, "beat", s.Space1, s.UserID)
	server := testServerDeployed(t, database, local.Config{Stream: local.StreamTiming{
		Keepalive: 50 * time.Millisecond, Heartbeat: 200 * time.Millisecond, Recheck: 10 * time.Second,
	}}, nil, shared.Deployment{Content: ring})
	cookie := "better-auth.session_token=" + signedCookie(testSecret, s.SessionToken)
	_, frames := openStreamBody(t, server.URL+"/rpc/threads/subscribe", cookie, s.Space1,
		streamInput(t, map[string]any{"botId": botID, "cursor": -1}))
	frame, ok := nextMessageWithin(t, frames, 3*time.Second)
	if !ok {
		t.Fatal("no heartbeat frame")
	}
	if frame["id"] != "heartbeat" || frame["type"] != "heartbeat" || frame["seq"] != float64(0) ||
		frame["spaceId"] != s.Space1 || frame["threadId"] != threadID || frame["botId"] != botID {
		t.Fatalf("heartbeat = %v", frame)
	}
	payload, ok := frame["payload"].(map[string]any)
	if !ok || len(payload) != 0 {
		t.Fatalf("heartbeat payload = %v", frame["payload"])
	}
}

func TestNotificationsSubscribeSendsInitialSignalsAndLiveFrames(t *testing.T) {
	database := openTestDB(t)
	s := seed(t, database)
	fanout := events.NewFanout(database.Pool.Config().ConnConfig, nil)
	t.Cleanup(fanout.Close)
	server := testServerDeployed(t, database, local.Config{Stream: streamTiming()}, nil,
		shared.Deployment{Realtime: fanout, PhoneCallsEnabled: true})
	cookie := "better-auth.session_token=" + signedCookie(testSecret, s.SessionToken)
	url := server.URL + "/rpc/notifications/subscribe"

	// Warm the process's single listener so no catch-up burst mixes into the assertions.
	_, warm := openStreamBody(t, url, cookie, s.Space1, `{"json":{}}`)
	drainInitial(t, warm, 6)
	waitForListener(t, database)

	_, frames := openStreamBody(t, url, cookie, s.Space1, `{"json":{}}`)
	initial := drainInitial(t, frames, 6)
	want := []string{"computerUpdates", "files", "organizations", "roster", "routines", "runs"}
	if got := frameTypes(initial); strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("initial types = %v, want %v", got, want)
	}

	// A chat alert for this Space arrives; one for another Space does not.
	alert := map[string]any{
		"kind": "completion", "title": "Done", "body": "All done", "spaceId": s.Space1,
		"botId": "b-alert", "threadId": "t-alert",
	}
	other := map[string]any{"kind": "completion", "title": "Other", "body": "Elsewhere",
		"spaceId": s.Space2, "botId": "b-other", "threadId": "t-other"}
	otherJSON, _ := json.Marshal(other)
	publishSignal(t, database, "chat-alerts:"+s.UserID, string(otherJSON))
	alertJSON, _ := json.Marshal(alert)
	publishSignal(t, database, "chat-alerts:"+s.UserID, string(alertJSON))
	frame, ok := nextMessageWithin(t, frames, 5*time.Second)
	if !ok || frame["type"] != "alert" {
		t.Fatalf("alert frame = %v", frame)
	}
	gotAlert, _ := frame["alert"].(map[string]any)
	if gotAlert["title"] != "Done" || gotAlert["spaceId"] != s.Space1 {
		t.Fatalf("alert = %v", gotAlert)
	}
	if _, extra := gotAlert["extra"]; extra {
		t.Fatalf("unknown keys survived: %v", gotAlert)
	}

	// A Space signal names its kind once.
	publishSignal(t, database, "space-changes:"+s.Space1, "runs")
	frame, ok = nextMessageWithin(t, frames, 5*time.Second)
	if !ok || frame["type"] != "runs" {
		t.Fatalf("space change frame = %v", frame)
	}

	// The legacy computer-updates topic still maps to computerUpdates.
	publishSignal(t, database, "computer-updates:"+s.Space1, "")
	frame, ok = nextMessageWithin(t, frames, 5*time.Second)
	if !ok || frame["type"] != "computerUpdates" {
		t.Fatalf("legacy frame = %v", frame)
	}

	// A roster and an organization signal each wake their source once.
	publishSignal(t, database, "roster-user:"+s.UserID, "")
	publishSignal(t, database, "organization-changes:"+s.UserID, "")
	kinds := map[string]int{}
	for range 2 {
		frame, ok := nextMessageWithin(t, frames, 5*time.Second)
		if !ok {
			t.Fatalf("missing roster/organization frame after %v", kinds)
		}
		kind, _ := frame["type"].(string)
		kinds[kind] += 1
	}
	if kinds["roster"] != 1 || kinds["organizations"] != 1 {
		t.Fatalf("roster/organization frames = %v", kinds)
	}
}

func TestNotificationsSubscribeWithoutRealtimeIsNotFound(t *testing.T) {
	database := openTestDB(t)
	s := seed(t, database)
	server := testServerDeployed(t, database, local.Config{Stream: streamTiming()}, nil, shared.Deployment{})
	cookie := "better-auth.session_token=" + signedCookie(testSecret, s.SessionToken)
	for _, procedure := range []string{"notifications/subscribe", "notifications/subscribeCalls"} {
		response, body := do(t, http.MethodPost, server.URL+"/rpc/"+procedure, cookie, `{"json":{}}`, nil)
		if response.StatusCode != 404 {
			t.Fatalf("%s without a fanout: %d %s", procedure, response.StatusCode, body)
		}
	}
}

// TestNotificationsSubscribeCallsRingsAndEnds covers loadUserIncomingCalls: only the owner's own
// bots, only live ringing requests, newest first and one per bot.
func TestNotificationsSubscribeCallsRingsAndEnds(t *testing.T) {
	database := openTestDB(t)
	s := seed(t, database)
	ctx := context.Background()
	ring := keyedRing(t, database)
	fanout := events.NewFanout(database.Pool.Config().ConnConfig, nil)
	t.Cleanup(fanout.Close)

	ringingBot, ringingThread := addStreamChat(t, database, "ring", s.Space1, s.UserID)
	expiredBot, expiredThread := addStreamChat(t, database, "expired", s.Space1, s.UserID)
	closedBot, closedThread := addStreamChat(t, database, "closed", s.Space2, s.UserID)
	otherBot, otherThread := addStreamChat(t, database, "other", s.Space1, s.User2ID)

	expiresAt := time.Now().Add(45 * time.Second).UTC().Format("2006-01-02T15:04:05.000Z")
	insertCall := func(messageID, threadID, botID, callID, status, expiry string) {
		t.Helper()
		sealed, err := ring.SealRow(ctx, "Message", map[string]any{
			"id": messageID, "threadId": threadID,
			"blocks": []any{map[string]any{
				"kind": "call_request", "callId": callID, "reason": "Checking in",
				"opening": "Hi there", "status": status, "expiresAt": expiry,
			}},
		})
		if err != nil {
			t.Fatalf("seal call: %v", err)
		}
		body, err := json.Marshal(sealed["blocks"])
		if err != nil {
			t.Fatalf("encode blocks: %v", err)
		}
		exec(t, database, `INSERT INTO messages (id, "threadId", "botId", seq, role, "clientNonce", blocks, "createdAt")
			VALUES ($1, $2, $3, 1, 'bot', $4, $5::jsonb, now())`,
			messageID, threadID, botID, "call:"+callID+":request", string(body))
	}
	insertCall("m-ring-"+s.UserID, ringingThread, ringingBot, "call-ring", "ringing", expiresAt)
	insertCall("m-expired-"+s.UserID, expiredThread, expiredBot, "call-expired", "ringing",
		time.Now().Add(-time.Minute).UTC().Format("2006-01-02T15:04:05.000Z"))
	insertCall("m-closed-"+s.UserID, closedThread, closedBot, "call-closed", "ringing", expiresAt)
	insertCall("m-other-"+s.UserID, otherThread, otherBot, "call-other", "ringing", expiresAt)

	server := testServerDeployed(t, database, local.Config{Stream: streamTiming()}, nil,
		shared.Deployment{Realtime: fanout, PhoneCallsEnabled: true, Content: ring})
	cookie := "better-auth.session_token=" + signedCookie(testSecret, s.SessionToken)
	url := server.URL + "/rpc/notifications/subscribeCalls"
	_, warm := openStreamBody(t, url, cookie, s.Space1, `{"json":{}}`)
	if _, ok := nextMessageWithin(t, warm, 5*time.Second); !ok {
		t.Fatal("no initial calls frame")
	}
	waitForListener(t, database)

	_, frames := openStreamBody(t, url, cookie, s.Space1, `{"json":{}}`)
	frame, ok := nextMessageWithin(t, frames, 5*time.Second)
	if !ok || frame["type"] != "incoming.calls" {
		t.Fatalf("calls frame = %v", frame)
	}
	payload, _ := frame["payload"].(map[string]any)
	calls, _ := payload["calls"].([]any)
	// The owner's calls across their Spaces: the bot in Space 1 and the one in Space 2 both ring,
	// while another user's bot and an expired request do not.
	if len(calls) != 2 {
		t.Fatalf("calls = %v, want the two ringing bots", calls)
	}
	byID := map[string]map[string]any{}
	for _, raw := range calls {
		call, _ := raw.(map[string]any)
		id, _ := call["id"].(string)
		byID[id] = call
	}
	call := byID[ringingBot]
	if call == nil || call["spaceId"] != s.Space1 || call["name"] != "Stream ring bot" ||
		call["color"] != "blue" || call["avatarSet"] != "organic" {
		t.Fatalf("call identity = %v", call)
	}
	incoming, _ := call["incomingCall"].(map[string]any)
	if incoming["callId"] != "call-ring" || incoming["reason"] != "Checking in" ||
		incoming["opening"] != "Hi there" || incoming["expiresAt"] != expiresAt {
		t.Fatalf("incomingCall = %v", incoming)
	}
	if _, present := byID[expiredBot]; present {
		t.Fatal("an expired request still rings")
	}
	if _, present := byID[otherBot]; present {
		t.Fatal("another user's bot rang")
	}

	// Settling the call and signalling re-reads: the bot no longer rings.
	exec(t, database, `UPDATE messages SET blocks = jsonb_set(blocks, '{0,status}', '"declined"') WHERE id = $1`,
		"m-ring-"+s.UserID)
	publishSignal(t, database, "incoming-calls:"+s.UserID, "")
	frame, ok = nextMessageWithin(t, frames, 5*time.Second)
	if !ok || frame["type"] != "incoming.calls" {
		t.Fatalf("second calls frame = %v", frame)
	}
	payload, _ = frame["payload"].(map[string]any)
	remaining, _ := payload["calls"].([]any)
	if len(remaining) != 1 {
		t.Fatalf("calls after settling = %v, want only the other Space's bot", remaining)
	}
	if left, _ := remaining[0].(map[string]any); left["id"] != closedBot {
		t.Fatalf("the settled call still rings: %v", remaining)
	}
}

// TestStreamsReleaseGoroutinesAndListeners opens and drops 200 streams: every source, every retry
// ticker and every fanout subscription must be gone afterwards, and the process keeps exactly the
// one LISTEN connection a fanout has.
func TestStreamsReleaseGoroutinesAndListeners(t *testing.T) {
	database := openTestDB(t)
	s := seed(t, database)
	ring := keyedRing(t, database)
	botID, _ := addStreamChat(t, database, "leak", s.Space1, s.UserID)
	_, helperThreadID := addHelperChat(t, database, "leakhelper", s.Space1, s.UserID)
	fanout := events.NewFanout(database.Pool.Config().ConnConfig, nil)
	t.Cleanup(fanout.Close)
	server := testServerDeployed(t, database, local.Config{Stream: streamTiming()}, nil,
		shared.Deployment{Content: ring, Realtime: fanout, PhoneCallsEnabled: true})
	cookie := "better-auth.session_token=" + signedCookie(testSecret, s.SessionToken)

	streams := []struct {
		path string
		body string
	}{
		{"/rpc/threads/subscribe", streamInput(t, map[string]any{"botId": botID, "cursor": -1})},
		{"/rpc/threads/helperSubscribe", streamInput(t, map[string]any{"threadId": helperThreadID, "cursor": -1})},
		{"/rpc/notifications/subscribe", `{"json":{}}`},
		{"/rpc/notifications/subscribeCalls", `{"json":{}}`},
	}
	// Warm every source once so the process's own listener, pools and one-shot caches exist
	// before the baseline is taken.
	for _, stream := range streams {
		response, frames := openStreamBody(t, server.URL+stream.path, cookie, s.Space1, stream.body)
		if response.StatusCode != 200 {
			t.Fatalf("%s status %d", stream.path, response.StatusCode)
		}
		nextMessageWithin(t, frames, 5*time.Second)
	}
	waitForListener(t, database)
	baselineGoroutines := runtime.NumGoroutine()
	baselineListeners := realtimeListenerCount(t, database)

	for index := range 200 {
		stream := streams[index%len(streams)]
		response, _ := openStreamBody(t, server.URL+stream.path, cookie, s.Space1, stream.body)
		if response.StatusCode != 200 {
			t.Fatalf("open %d (%s) status %d", index, stream.path, response.StatusCode)
		}
		// Let the source run, then drop the connection.
		time.Sleep(20 * time.Millisecond)
		response.Body.Close()
	}

	deadline := time.Now().Add(20 * time.Second)
	for {
		settled := runtime.NumGoroutine()
		if settled <= baselineGoroutines+2 && realtimeListenerCount(t, database) <= baselineListeners {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("leak: goroutines %d (baseline %d), listeners %d (baseline %d)",
				settled, baselineGoroutines, realtimeListenerCount(t, database), baselineListeners)
		}
		time.Sleep(50 * time.Millisecond)
	}
}

// TestStreamsHoldNoConnectionAndServeUnderFour pins the pool discipline: fifty open, idle streams
// acquire nothing, and ordinary calls still answer with the gateway's four-connection pool.
func TestStreamsHoldNoConnectionAndServeUnderFour(t *testing.T) {
	database := openTestDB(t)
	s := seed(t, database)
	ring := keyedRing(t, database)
	botID, _ := addStreamChat(t, database, "pool", s.Space1, s.UserID)
	fanout := events.NewFanout(database.Pool.Config().ConnConfig, nil)
	t.Cleanup(fanout.Close)
	server := testServerDeployed(t, database, local.Config{Stream: streamTiming()}, nil,
		shared.Deployment{Content: ring, Realtime: fanout, PhoneCallsEnabled: true})
	cookie := "better-auth.session_token=" + signedCookie(testSecret, s.SessionToken)
	if database.Pool.Stat().MaxConns() != 4 {
		t.Fatalf("pool max = %d, want 4", database.Pool.Stat().MaxConns())
	}

	type open struct {
		response *http.Response
		frames   <-chan sseFrame
	}
	var opened []open
	paths := []struct{ path, body string }{
		{"/rpc/notifications/subscribe", `{"json":{}}`},
		{"/rpc/threads/subscribe", streamInput(t, map[string]any{"botId": botID, "cursor": -1})},
		{"/rpc/notifications/subscribeCalls", `{"json":{}}`},
	}
	for index := range 50 {
		stream := paths[index%len(paths)]
		response, frames := openStreamBody(t, server.URL+stream.path, cookie, s.Space1, stream.body)
		if response.StatusCode != 200 {
			t.Fatalf("open %d (%s) status %d", index, stream.path, response.StatusCode)
		}
		opened = append(opened, open{response: response, frames: frames})
	}
	defer func() {
		for _, stream := range opened {
			stream.response.Body.Close()
		}
	}()

	// No stream may hold a pooled connection while it waits for a signal.
	deadline := time.Now().Add(5 * time.Second)
	for {
		if database.Pool.Stat().AcquiredConns() == 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("idle streams hold %d pooled connections", database.Pool.Stat().AcquiredConns())
		}
		time.Sleep(20 * time.Millisecond)
	}
	var inTransaction int
	if err := database.Pool.QueryRow(context.Background(),
		`SELECT count(*) FROM pg_stat_activity WHERE state = 'idle in transaction'
		 AND application_name NOT LIKE 'rakazo-api-go-content-keys%'`).Scan(&inTransaction); err != nil {
		t.Fatalf("count transactions: %v", err)
	}
	if inTransaction != 0 {
		t.Fatalf("%d connections idle in transaction with 50 streams open", inTransaction)
	}

	// Ordinary calls are served alongside them: twenty reads, four at a time.
	type result struct {
		status int
		err    error
	}
	results := make(chan result, 20)
	for index := range 20 {
		go func(index int) {
			response, body := do(t, http.MethodPost, server.URL+"/rpc/threads/head", cookie,
				`{"json":{"botId":"`+botID+`"}}`, nil)
			if response.StatusCode != 200 {
				results <- result{status: response.StatusCode, err: nil}
				t.Logf("call %d body %s", index, body)
				return
			}
			results <- result{status: response.StatusCode}
		}(index)
	}
	for range 20 {
		select {
		case got := <-results:
			if got.status != 200 {
				t.Fatalf("a call beside 50 streams answered %d", got.status)
			}
		case <-time.After(10 * time.Second):
			t.Fatal("a call beside 50 streams timed out")
		}
	}
	// The streams still work afterwards: a thread event reaches an open thread stream.
	live, err := appendInSystem(context.Background(), database, ring, events.Input{
		SpaceID: s.Space1, ThreadID: "st-pool-" + s.UserID, BotID: botID, Type: "thread.progress",
		Payload: map[string]any{"late": true}}, false)
	if err != nil {
		t.Fatalf("append after the calls: %v", err)
	}
	publishSignal(t, database, "thread:st-pool-"+s.UserID, `{"cursor":`+strconv.Itoa(int(live.Seq))+`}`)
	found := false
	deadline = time.Now().Add(8 * time.Second)
	for !found && time.Now().Before(deadline) {
		frame, ok := nextMessageWithin(t, opened[1].frames, time.Until(deadline))
		if !ok {
			break
		}
		found = frame["seq"] == float64(live.Seq)
	}
	if !found {
		t.Fatal("an open thread stream missed a live event")
	}
	deadline = time.Now().Add(5 * time.Second)
	for database.Pool.Stat().AcquiredConns() != 0 {
		if time.Now().After(deadline) {
			t.Fatalf("streams held %d connections after the calls", database.Pool.Stat().AcquiredConns())
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// TestStreamsEndWithTheSession proves the mid-stream re-check: revoking the session ends a Go
// stream with an error event and the UNAUTHORIZED code.
func TestStreamsEndWithTheSession(t *testing.T) {
	database := openTestDB(t)
	s := seed(t, database)
	fanout := events.NewFanout(database.Pool.Config().ConnConfig, nil)
	t.Cleanup(fanout.Close)
	server := testServerDeployed(t, database, local.Config{Stream: local.StreamTiming{
		Keepalive: 50 * time.Millisecond, Heartbeat: 200 * time.Millisecond, Recheck: 100 * time.Millisecond,
	}}, nil, shared.Deployment{Realtime: fanout})
	cookie := "better-auth.session_token=" + signedCookie(testSecret, s.SessionToken)
	response, frames := openStreamBody(t, server.URL+"/rpc/notifications/subscribe", cookie, s.Space1, `{"json":{}}`)
	if response.StatusCode != 200 {
		t.Fatalf("status %d", response.StatusCode)
	}
	drainInitial(t, frames, 2)
	exec(t, database, `DELETE FROM session WHERE id = $1`, s.SessionID)
	for {
		frame, ok := nextMessageWithin(t, frames, 5*time.Second)
		if !ok {
			t.Fatalf("the stream did not end with an error frame")
		}
		if _, failed := frame["__error"]; failed {
			var envelope struct {
				JSON struct {
					Code string `json:"code"`
				} `json:"json"`
			}
			raw := frame["__error"].(string)
			if err := json.Unmarshal([]byte(raw), &envelope); err != nil || envelope.JSON.Code != "UNAUTHORIZED" {
				t.Fatalf("error frame = %s", raw)
			}
			return
		}
	}
}

// TestThreadSubscribePrintsStoredNumbersLikeJSONStringify reads a payload straight out of jsonb:
// the frame's bytes must be JSON.stringify's, so 1.0 becomes 1, the numeric 1e-7 becomes 1e-7, the
// 21-digit integer becomes 1e+21, and -0 becomes 0. The payload is stored unsealed (a ring with no
// encryption), so jsonb keeps the number text the TypeScript API would have parsed.
func TestThreadSubscribePrintsStoredNumbersLikeJSONStringify(t *testing.T) {
	database := openTestDB(t)
	s := seed(t, database)
	botID, threadID := addStreamChat(t, database, "numbers", s.Space1, s.UserID)
	exec(t, database, `INSERT INTO events (id, "spaceId", "threadId", "botId", seq, type, payload, "createdAt")
		VALUES ($1, $2, $3, $4, 1, 'thread.progress', $5::jsonb, now())`,
		"ev-numbers-"+s.UserID, s.Space1, threadID, botID,
		`{"n":[1.0,1e21,-0,1e-7,0.30000000000000004],"s":"x"}`)
	ring := contentcrypto.NewKeyRing(nil, nil, contentcrypto.KeyRingOptions{})
	server := testServerDeployed(t, database, local.Config{Stream: streamTiming()}, nil,
		shared.Deployment{Content: ring})
	cookie := "better-auth.session_token=" + signedCookie(testSecret, s.SessionToken)
	_, frames := openStreamBody(t, server.URL+"/rpc/threads/subscribe", cookie, s.Space1,
		streamInput(t, map[string]any{"botId": botID, "cursor": -1}))
	deadline := time.After(5 * time.Second)
	for {
		select {
		case frame, ok := <-frames:
			if !ok {
				t.Fatal("stream ended before a frame")
			}
			if frame.event != "message" {
				continue
			}
			want := `"payload":{"n":[1,1e+21,0,1e-7,0.30000000000000004],"s":"x"}`
			if !strings.Contains(frame.data, want) {
				t.Fatalf("frame data =\n%s\nmissing\n%s", frame.data, want)
			}
			return
		case <-deadline:
			t.Fatal("no frame within 5s")
		}
	}
}
