package integration

import (
	"context"
	"encoding/json"
	"net/http"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/local"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/threads"
)

func addThread(t *testing.T, database *db.DB, id, spaceID, userID string, botID, groupID *string, nextSeq int) {
	t.Helper()
	exec(t, database, `INSERT INTO threads (id, "spaceId", "botId", "groupId", "userId", "nextMessageSeq", "nextEventSeq") VALUES ($1, $2, $3, $4, $5, $6, $6)`,
		id, spaceID, botID, groupID, userID, nextSeq)
}

func addRead(t *testing.T, database *db.DB, threadID, spaceID, userID string, unread bool, lastRead int, snoozedUntil *time.Time) {
	t.Helper()
	exec(t, database, `INSERT INTO thread_reads ("threadId", "userId", "spaceId", unread, "lastReadSeq", "snoozedUntil") VALUES ($1, $2, $3, $4, $5, $6)`,
		threadID, userID, spaceID, unread, lastRead, snoozedUntil)
}

type readRow struct {
	Unread       bool
	LastRead     int
	SnoozedUntil *time.Time
	Exists       bool
}

func readOf(t *testing.T, database *db.DB, threadID, userID string) readRow {
	t.Helper()
	var row readRow
	err := database.System(context.Background(), "test read", func(tx pgx.Tx) error {
		rows, err := tx.Query(context.Background(), `SELECT unread, "lastReadSeq", "snoozedUntil" FROM thread_reads WHERE "threadId" = $1 AND "userId" = $2`, threadID, userID)
		if err != nil {
			return err
		}
		defer rows.Close()
		if rows.Next() {
			row.Exists = true
			return rows.Scan(&row.Unread, &row.LastRead, &row.SnoozedUntil)
		}
		return rows.Err()
	})
	if err != nil {
		t.Fatal(err)
	}
	return row
}

func unreadAfter(t *testing.T, output any) *int32 {
	t.Helper()
	body, _ := json.Marshal(output)
	var parsed struct {
		OK             bool   `json:"ok"`
		UnreadAfterSeq *int32 `json:"unreadAfterSeq"`
	}
	if err := json.Unmarshal(body, &parsed); err != nil || !parsed.OK {
		t.Fatalf("output = %s", body)
	}
	return parsed.UnreadAfterSeq
}

func TestMarkReadStates(t *testing.T) {
	database := openTestDB(t)
	s := seed(t, database)
	actor := db.Actor{UserID: s.UserID, SpaceID: s.Space1}
	ctx := context.Background()
	bot := "b-" + s.UserID
	thread := "t-" + s.UserID
	addBot(t, database, bot, s.Space1, s.UserID, "Bot")
	addThread(t, database, thread, s.Space1, s.UserID, &bot, nil, 10)
	input := raw(`{"botId":"` + bot + `"}`)

	// No read state: caught up, nothing to do and no row is created.
	output, failure := threads.MarkRead(ctx, database, actor, input)
	if failure != nil || unreadAfter(t, output) != nil || readOf(t, database, thread, s.UserID).Exists {
		t.Fatalf("no state = %v %v", output, failure)
	}
	// Unread with a gap: the divider goes after what was read, and the cursor moves to the latest.
	addRead(t, database, thread, s.Space1, s.UserID, true, 4, nil)
	output, failure = threads.MarkRead(ctx, database, actor, input)
	if got := unreadAfter(t, output); failure != nil || got == nil || *got != 4 {
		t.Fatalf("unread gap = %v %v", output, failure)
	}
	if row := readOf(t, database, thread, s.UserID); row.Unread || row.LastRead != 9 {
		t.Fatalf("row = %+v", row)
	}
	// Already caught up: no change, null.
	output, _ = threads.MarkRead(ctx, database, actor, input)
	if unreadAfter(t, output) != nil {
		t.Fatalf("caught up = %v", output)
	}
	// Unread dot with nothing new: the dot clears but no divider is placed.
	exec(t, database, `UPDATE thread_reads SET unread = true WHERE "threadId" = $1`, thread)
	output, _ = threads.MarkRead(ctx, database, actor, input)
	if unreadAfter(t, output) != nil || readOf(t, database, thread, s.UserID).Unread {
		t.Fatalf("dot only = %v", output)
	}
	// A snooze that has woken ends when the chat is read; a running one stays.
	past := time.Now().UTC().Add(-time.Hour)
	exec(t, database, `UPDATE thread_reads SET "snoozedUntil" = $2 WHERE "threadId" = $1`, thread, past)
	threads.MarkRead(ctx, database, actor, input)
	if row := readOf(t, database, thread, s.UserID); row.SnoozedUntil != nil {
		t.Fatalf("woken snooze kept: %+v", row)
	}
	future := time.Now().UTC().Add(time.Hour)
	exec(t, database, `UPDATE thread_reads SET "snoozedUntil" = $2, unread = true, "lastReadSeq" = 1 WHERE "threadId" = $1`, thread, future)
	threads.MarkRead(ctx, database, actor, input)
	if row := readOf(t, database, thread, s.UserID); row.SnoozedUntil == nil || row.Unread {
		t.Fatalf("running snooze = %+v", row)
	}

	for _, bad := range []string{`{"botId":"nope"}`, `{"groupId":"nope"}`} {
		if _, failure := threads.MarkRead(ctx, database, actor, raw(bad)); failureCode(failure) != "NOT_FOUND" || failure.Message != "Resource not found" {
			t.Errorf("%s = %v", bad, failure)
		}
	}
	if _, failure := threads.MarkRead(ctx, database, db.Actor{UserID: s.UserID, SpaceID: s.Space2}, input); failureCode(failure) != "NOT_FOUND" {
		t.Errorf("other space = %v", failure)
	}
}

// Concurrent reads of one chat: the row lock lets exactly one of them place the divider.
func TestMarkReadIsSafeUnderConcurrency(t *testing.T) {
	database := openTestDB(t)
	s := seed(t, database)
	actor := db.Actor{UserID: s.UserID, SpaceID: s.Space1}
	bot := "b-" + s.UserID
	thread := "t-" + s.UserID
	addBot(t, database, bot, s.Space1, s.UserID, "Bot")
	addThread(t, database, thread, s.Space1, s.UserID, &bot, nil, 50)
	addRead(t, database, thread, s.Space1, s.UserID, true, 7, nil)
	input := raw(`{"botId":"` + bot + `"}`)

	const callers = 24
	var wg sync.WaitGroup
	answers := make([]*int32, callers)
	failures := make([]string, callers)
	start := make(chan struct{})
	for i := 0; i < callers; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start
			output, failure := threads.MarkRead(context.Background(), database, actor, input)
			if failure != nil {
				failures[i] = failure.Message
				return
			}
			answers[i] = unreadAfter(t, output)
		}(i)
	}
	close(start)
	wg.Wait()
	divider := 0
	for i := 0; i < callers; i++ {
		if failures[i] != "" {
			t.Fatalf("caller %d failed: %s", i, failures[i])
		}
		if answers[i] != nil {
			divider++
			if *answers[i] != 7 {
				t.Errorf("divider seq = %d", *answers[i])
			}
		}
	}
	if divider != 1 {
		t.Fatalf("%d callers placed the divider, want exactly 1", divider)
	}
	if row := readOf(t, database, thread, s.UserID); row.Unread || row.LastRead != 49 {
		t.Fatalf("row = %+v", row)
	}
}

// Mark as unread racing reads never loses the unread flag: the last writer in lock order wins,
// and the row is always consistent.
func TestMarkUnreadAndReadInterleave(t *testing.T) {
	database := openTestDB(t)
	s := seed(t, database)
	actor := db.Actor{UserID: s.UserID, SpaceID: s.Space1}
	bot := "b-" + s.UserID
	thread := "t-" + s.UserID
	addBot(t, database, bot, s.Space1, s.UserID, "Bot")
	addThread(t, database, thread, s.Space1, s.UserID, &bot, nil, 5)
	input := raw(`{"botId":"` + bot + `"}`)
	var wg sync.WaitGroup
	for i := 0; i < 30; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			var failure interface{ Error() string }
			if i%2 == 0 {
				if _, f := threads.MarkUnread(context.Background(), database, actor, input); f != nil {
					failure = f
				}
			} else {
				if _, f := threads.MarkRead(context.Background(), database, actor, input); f != nil {
					failure = f
				}
			}
			if failure != nil {
				t.Errorf("call %d: %v", i, failure)
			}
		}(i)
	}
	wg.Wait()
	row := readOf(t, database, thread, s.UserID)
	if !row.Exists || row.LastRead != 4 {
		t.Fatalf("row = %+v", row)
	}
}

func TestMarkUnreadFromMessageAndSnooze(t *testing.T) {
	database := openTestDB(t)
	s := seed(t, database)
	actor := db.Actor{UserID: s.UserID, SpaceID: s.Space1}
	ctx := context.Background()
	group := "g-" + s.UserID
	thread := "t-" + s.UserID
	b1, b2 := "b1-"+s.UserID, "b2-"+s.UserID
	addBot(t, database, b1, s.Space1, s.UserID, "One")
	addBot(t, database, b2, s.Space1, s.UserID, "Two")
	exec(t, database, `INSERT INTO chat_groups (id, "spaceId", "userId", name, "updatedAt") VALUES ($1, $2, $3, 'G', now())`, group, s.Space1, s.UserID)
	exec(t, database, `INSERT INTO chat_group_members (id, "groupId", "botId") VALUES ($1, $2, $3)`, "m1-"+s.UserID, group, b1)
	addThread(t, database, thread, s.Space1, s.UserID, nil, &group, 8)
	// A group with one active member cannot be opened.
	if _, failure := threads.MarkUnread(ctx, database, actor, raw(`{"groupId":"`+group+`"}`)); failureCode(failure) != "NOT_FOUND" {
		t.Fatalf("group of one = %v", failure)
	}
	exec(t, database, `INSERT INTO chat_group_members (id, "groupId", "botId") VALUES ($1, $2, $3)`, "m2-"+s.UserID, group, b2)
	exec(t, database, `INSERT INTO messages (id, "threadId", seq, role, blocks) VALUES ($1, $2, 5, 'user', '[]')`, "msg-"+s.UserID, thread)

	// Without a messageId the chat is flagged unread where it stands (everything read).
	if _, failure := threads.MarkUnread(ctx, database, actor, raw(`{"groupId":"`+group+`"}`)); failure != nil {
		t.Fatal(failure)
	}
	if row := readOf(t, database, thread, s.UserID); !row.Unread || row.LastRead != 7 {
		t.Fatalf("flagged = %+v", row)
	}
	// From a message, the cursor goes to just before it.
	if _, failure := threads.MarkUnread(ctx, database, actor, raw(`{"groupId":"`+group+`","messageId":"msg-`+s.UserID+`"}`)); failure != nil {
		t.Fatal(failure)
	}
	if row := readOf(t, database, thread, s.UserID); !row.Unread || row.LastRead != 4 {
		t.Fatalf("from message = %+v", row)
	}
	if _, failure := threads.MarkUnread(ctx, database, actor, raw(`{"groupId":"`+group+`","messageId":"gone"}`)); failureCode(failure) != "NOT_FOUND" || failure.Message != "Not Found" {
		t.Fatalf("gone message = %v", failure)
	}

	// Snooze: waking clears, a time within the year sets it, outside the window is refused.
	soon := time.Now().UTC().Add(2 * time.Hour).Format("2006-01-02T15:04:05.000Z")
	if _, failure := threads.Snooze(ctx, database, actor, raw(`{"groupId":"`+group+`","until":"`+soon+`"}`)); failure != nil {
		t.Fatal(failure)
	}
	if row := readOf(t, database, thread, s.UserID); row.SnoozedUntil == nil {
		t.Fatal("not snoozed")
	}
	if _, failure := threads.Snooze(ctx, database, actor, raw(`{"groupId":"`+group+`","until":null}`)); failure != nil {
		t.Fatal(failure)
	}
	if row := readOf(t, database, thread, s.UserID); row.SnoozedUntil != nil {
		t.Fatal("still snoozed")
	}
	for _, bad := range []string{"2020-01-01T00:00:00.000Z", time.Now().UTC().Add(400 * 24 * time.Hour).Format("2006-01-02T15:04:05.000Z")} {
		if _, failure := threads.Snooze(ctx, database, actor, raw(`{"groupId":"`+group+`","until":"`+bad+`"}`)); failureCode(failure) != "BAD_REQUEST" || failure.Message != "Pick a time within the next year" {
			t.Errorf("%s = %v", bad, failure)
		}
	}
	// A snooze on a chat with no read state creates one that counts everything as read.
	if n := systemScalar[int](t, database, `SELECT count(*)::int FROM thread_reads WHERE "threadId" = $1`, thread); n != 1 {
		t.Fatalf("rows = %d", n)
	}
}

func TestThreadHead(t *testing.T) {
	database := openTestDB(t)
	s := seed(t, database)
	actor := db.Actor{UserID: s.UserID, SpaceID: s.Space1}
	bot := "b-" + s.UserID
	thread := "t-" + s.UserID
	addBot(t, database, bot, s.Space1, s.UserID, "Bot")
	addThread(t, database, thread, s.Space1, s.UserID, &bot, nil, 0)
	output, failure := threads.Head(context.Background(), database, actor, raw(`{"botId":"`+bot+`"}`))
	body, _ := json.Marshal(output)
	if failure != nil || string(body) != `{"threadId":"`+thread+`","cursor":-1}` {
		t.Fatalf("empty = %s %v", body, failure)
	}
	exec(t, database, `INSERT INTO events (id, "spaceId", "threadId", "botId", seq, type, payload) VALUES ($1, $2, $3, $4, 0, 'x', '{}'), ($5, $2, $3, $4, 7, 'x', '{}'), ($6, $2, $3, $4, 3, 'x', '{}')`,
		"e1-"+s.UserID, s.Space1, thread, bot, "e2-"+s.UserID, "e3-"+s.UserID)
	output, _ = threads.Head(context.Background(), database, actor, raw(`{"botId":"`+bot+`"}`))
	body, _ = json.Marshal(output)
	if string(body) != `{"threadId":"`+thread+`","cursor":7}` {
		t.Fatalf("head = %s", body)
	}
}

func TestHTTPThreadsSignalsOnce(t *testing.T) {
	database := openTestDB(t)
	s := seed(t, database)
	server := testServer(t, database, local.Config{})
	cookie := "better-auth.session_token=" + signedCookie(testSecret, s.SessionToken)
	bot := "b-" + s.UserID
	addBot(t, database, bot, s.Space1, s.UserID, "Bot")
	addThread(t, database, "t-"+s.UserID, s.Space1, s.UserID, &bot, nil, 3)
	collect := listen(t, database, s.UserID, s.Space1, s.Space2)
	headers := map[string]string{"x-rakazo-space-id": s.Space1}
	response, body := do(t, http.MethodPost, server.URL+"/rpc/threads/markRead", cookie, `{"json":{"botId":"`+bot+`"}}`, headers)
	if response.StatusCode != 200 || string(body) != `{"json":{"ok":true,"unreadAfterSeq":null}}` {
		t.Fatalf("markRead = %d %s", response.StatusCode, body)
	}
	got := collect(400 * time.Millisecond)
	if len(got) != 1 || got[0] != `{"topic":"roster-user:`+s.UserID+`","payload":""}` {
		t.Fatalf("signals = %q", got)
	}
	// A failed call signals nothing.
	do(t, http.MethodPost, server.URL+"/rpc/threads/markRead", cookie, `{"json":{"botId":"nope"}}`, headers)
	response, body = do(t, http.MethodPost, server.URL+"/rpc/threads/head", cookie, `{"json":{"botId":"`+bot+`"}}`, headers)
	if response.StatusCode != 200 {
		t.Fatalf("head = %d %s", response.StatusCode, body)
	}
	if rest := collect(300 * time.Millisecond); len(rest) != 0 {
		t.Fatalf("extra signals = %q", rest)
	}
}
