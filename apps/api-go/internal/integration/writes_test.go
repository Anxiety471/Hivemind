package integration

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/local"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/orpc"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/botsections"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/spendinglimit"
)

func raw(text string) orpc.Input { return orpc.Input{Raw: json.RawMessage(text)} }

func failureCode(failure *orpc.Error) string {
	if failure == nil {
		return ""
	}
	return failure.Code
}

func TestBotSectionsCreateUpdateRemove(t *testing.T) {
	database := openTestDB(t)
	s := seed(t, database)
	actor := db.Actor{UserID: s.UserID, SpaceID: s.Space1}
	ctx := context.Background()
	bot := "bot-" + s.UserID
	other := "bot2-" + s.UserID
	group := "grp-" + s.UserID
	addBot(t, database, bot, s.Space1, s.UserID, "Bot")
	addBot(t, database, other, s.Space1, s.UserID, "Other bot")
	exec(t, database, `INSERT INTO chat_groups (id, "spaceId", "userId", name, "updatedAt") VALUES ($1, $2, $3, 'Group', now())`, group, s.Space1, s.UserID)

	// A first section takes position 0 and files the bot in it.
	created, failure := botsections.Create(ctx, database, actor, raw(`{"botId":"`+bot+`","name":"  Work  "}`))
	if failure != nil || created.Name != "Work" || created.Position != 0 {
		t.Fatalf("create = %+v %v", created, failure)
	}
	if got := systemScalar[string](t, database, `SELECT coalesce("sectionId", '') FROM bots WHERE id = $1`, bot); got != created.ID {
		t.Fatalf("bot section = %q", got)
	}
	// The same name from another member is the same section; a new name goes after it.
	reused, failure := botsections.Create(ctx, database, actor, raw(`{"botId":"`+other+`","name":"Work"}`))
	if failure != nil || reused.ID != created.ID {
		t.Fatalf("reuse = %+v %v", reused, failure)
	}
	second, failure := botsections.Create(ctx, database, actor, raw(`{"groupId":"`+group+`","name":"Play"}`))
	if failure != nil || second.Position != 1 {
		t.Fatalf("second = %+v %v", second, failure)
	}
	if got := systemScalar[string](t, database, `SELECT coalesce("sectionId", '') FROM chat_groups WHERE id = $1`, group); got != second.ID {
		t.Fatalf("group section = %q", got)
	}

	for name, tc := range map[string]struct {
		input string
		code  string
	}{
		"unknown bot":   {`{"botId":"nope","name":"x"}`, "NOT_FOUND"},
		"bot and group": {`{"botId":"` + bot + `","groupId":"` + group + `","name":"x"}`, "BAD_REQUEST"},
		"neither":       {`{"name":"x"}`, "BAD_REQUEST"},
		"blank name":    {`{"botId":"` + bot + `","name":"   "}`, "BAD_REQUEST"},
		"name too long": {`{"botId":"` + bot + `","name":"0123456789012345678901234567890123456789012345678901234567890"}`, "BAD_REQUEST"},
		"not an object": {`[]`, "BAD_REQUEST"},
	} {
		if _, failure := botsections.Create(ctx, database, actor, raw(tc.input)); failureCode(failure) != tc.code {
			t.Errorf("%s: %v", name, failure)
		}
	}
	exec(t, database, `UPDATE bots SET "archivedAt" = now() WHERE id = $1`, other)
	if _, failure := botsections.Create(ctx, database, actor, raw(`{"botId":"`+other+`","name":"x"}`)); failureCode(failure) != "NOT_FOUND" {
		t.Errorf("archived: %v", failure)
	}

	// Rename: unchanged is a no-op, a taken name conflicts, another Space's section is not found.
	if same, failure := botsections.Update(ctx, database, actor, raw(`{"sectionId":"`+created.ID+`","name":"Work"}`)); failure != nil || same.UpdatedAt != created.UpdatedAt {
		t.Fatalf("same name = %+v %v", same, failure)
	}
	if _, failure := botsections.Update(ctx, database, actor, raw(`{"sectionId":"`+created.ID+`","name":"Play"}`)); failureCode(failure) != "CONFLICT" || failure.Message != "Section name already used" {
		t.Fatalf("conflict = %v", failure)
	}
	renamed, failure := botsections.Update(ctx, database, actor, raw(`{"sectionId":"`+created.ID+`","name":" Office "}`))
	if failure != nil || renamed.Name != "Office" || renamed.Position != created.Position || renamed.CreatedAt != created.CreatedAt {
		t.Fatalf("rename = %+v %v", renamed, failure)
	}
	if _, failure := botsections.Update(ctx, database, db.Actor{UserID: s.UserID, SpaceID: s.Space2}, raw(`{"sectionId":"`+created.ID+`","name":"Z"}`)); failureCode(failure) != "NOT_FOUND" {
		t.Fatalf("foreign = %v", failure)
	}

	removed, failure := botsections.Remove(ctx, database, actor, raw(`{"sectionId":"`+created.ID+`"}`))
	if failure != nil || removed.ReleasedBots != 2 || removed.ReleasedGroups != 0 {
		t.Fatalf("remove = %+v %v", removed, failure)
	}
	if got := systemScalar[string](t, database, `SELECT coalesce("sectionId", 'none') FROM bots WHERE id = $1`, bot); got != "none" {
		t.Fatalf("bot still sectioned: %q", got)
	}
	if _, failure := botsections.Remove(ctx, database, actor, raw(`{"sectionId":"`+created.ID+`"}`)); failureCode(failure) != "NOT_FOUND" {
		t.Fatalf("remove again = %v", failure)
	}

	// A Space being deleted takes no new sections.
	exec(t, database, `UPDATE spaces SET "deletingAt" = now() WHERE id = $1`, s.Space1)
	if _, failure := botsections.Create(ctx, database, actor, raw(`{"botId":"`+bot+`","name":"Late"}`)); failureCode(failure) != "CONFLICT" || failure.Message != "Space deletion is already in progress" {
		t.Fatalf("deleting space = %v", failure)
	}
}

func TestSpendingLimitSet(t *testing.T) {
	database := openTestDB(t)
	s := seed(t, database)
	actor := db.Actor{UserID: s.UserID, SpaceID: s.Space1}
	ctx := context.Background()

	status, failure := spendinglimit.Set(ctx, database, actor, raw(`{"limit":{"amount":1500,"currency":"eur","period":"week"}}`), nil)
	if failure != nil || status.Limit == nil || status.Limit.Amount != 1500 || status.Limit.Currency != "eur" || !status.Shown || status.Spent != 0 {
		t.Fatalf("set = %+v %v", status, failure)
	}
	first := systemScalar[time.Time](t, database, `SELECT "startsAt" FROM spending_limits WHERE "userId" = $1`, s.UserID)

	// Changing the amount keeps startsAt; switching to "none" from a resetting period restarts it.
	time.Sleep(5 * time.Millisecond)
	if _, failure := spendinglimit.Set(ctx, database, actor, raw(`{"limit":{"amount":10,"currency":"usd","period":"day"}}`), nil); failure != nil {
		t.Fatal(failure)
	}
	if got := systemScalar[time.Time](t, database, `SELECT "startsAt" FROM spending_limits WHERE "userId" = $1`, s.UserID); !got.Equal(first) {
		t.Fatalf("startsAt moved: %v -> %v", first, got)
	}
	if _, failure := spendinglimit.Set(ctx, database, actor, raw(`{"limit":{"amount":10,"currency":"usd","period":"none"}}`), nil); failure != nil {
		t.Fatal(failure)
	}
	restarted := systemScalar[time.Time](t, database, `SELECT "startsAt" FROM spending_limits WHERE "userId" = $1`, s.UserID)
	if !restarted.After(first) {
		t.Fatalf("startsAt did not restart: %v -> %v", first, restarted)
	}
	time.Sleep(5 * time.Millisecond)
	if _, failure := spendinglimit.Set(ctx, database, actor, raw(`{"limit":{"amount":20,"currency":"usd","period":"none"}}`), nil); failure != nil {
		t.Fatal(failure)
	}
	if got := systemScalar[time.Time](t, database, `SELECT "startsAt" FROM spending_limits WHERE "userId" = $1`, s.UserID); !got.Equal(restarted) {
		t.Fatalf("none -> none must keep startsAt: %v -> %v", restarted, got)
	}

	status, failure = spendinglimit.Set(ctx, database, actor, raw(`{"limit":null}`), nil)
	if failure != nil || status.Limit != nil {
		t.Fatalf("remove = %+v %v", status, failure)
	}
	if n := systemScalar[int](t, database, `SELECT count(*)::int FROM spending_limits WHERE "userId" = $1`, s.UserID); n != 0 {
		t.Fatalf("rows left = %d", n)
	}
	for _, bad := range []string{``, `null`, `{}`, `{"limit":{}}`, `{"limit":{"amount":0,"currency":"usd","period":"day"}}`,
		`{"limit":{"amount":1,"currency":"jpy","period":"day"}}`, `{"limit":{"amount":1,"currency":"usd","period":"day","x":1}}`, `{"limit":null,"y":1}`} {
		if _, failure := spendinglimit.Set(ctx, database, actor, raw(bad), nil); failureCode(failure) != "BAD_REQUEST" {
			t.Errorf("%q: %v", bad, failure)
		}
	}
}

func TestHTTPWritesRunTheirEffects(t *testing.T) {
	database := openTestDB(t)
	s := seed(t, database)
	server := testServer(t, database, local.Config{})
	cookie := "better-auth.session_token=" + signedCookie(testSecret, s.SessionToken)
	collect := listen(t, database)
	addBot(t, database, "bot-"+s.UserID, s.Space1, s.UserID, "Bot")
	headers := map[string]string{"x-rakazo-space-id": s.Space1, "user-agent": "http-test/2", "x-forwarded-for": "198.51.100.77"}

	response, body := do(t, http.MethodPost, server.URL+"/rpc/botSections/create", cookie, `{"json":{"botId":"bot-`+s.UserID+`","name":"Inbox"}}`, headers)
	if response.StatusCode != 200 {
		t.Fatalf("create = %d %s", response.StatusCode, body)
	}
	response, body = do(t, http.MethodPost, server.URL+"/rpc/spendingLimit/set", cookie, `{"json":{"limit":{"amount":300,"currency":"gbp","period":"day"}}}`, headers)
	if response.StatusCode != 200 {
		t.Fatalf("set = %d %s", response.StatusCode, body)
	}
	got := collect(500 * time.Millisecond)
	if len(got) != 1 || got[0] != `{"topic":"roster-space:`+s.Space1+`","payload":""}` {
		t.Fatalf("notifications = %q", got)
	}
	// The security event rides the reply: it exists once the response is back, with the caller resolved
	// from the trusted loopback hop's forwarded header.
	if n := systemScalar[int](t, database, `SELECT count(*)::int FROM security_events WHERE "userId" = $1 AND type = 'approval.policy.changed'
		AND ip = '198.51.100.77' AND "userAgent" = 'http-test/2' AND metadata = '{"kind":"spending_limit","period":"day","currency":"gbp","procedure":"spendingLimit.set"}'::jsonb`, s.UserID); n != 1 {
		t.Fatalf("security events = %d", n)
	}
	// A failed call has no effects.
	do(t, http.MethodPost, server.URL+"/rpc/botSections/create", cookie, `{"json":{"botId":"nope","name":"x"}}`, headers)
	do(t, http.MethodPost, server.URL+"/rpc/spendingLimit/set", cookie, `{"json":{"limit":{"amount":0,"currency":"gbp","period":"day"}}}`, headers)
	if rest := collect(300 * time.Millisecond); len(rest) != 0 {
		t.Fatalf("notifications after failures = %q", rest)
	}
	if n := systemScalar[int](t, database, `SELECT count(*)::int FROM security_events WHERE "userId" = $1`, s.UserID); n != 1 {
		t.Fatalf("security events after failures = %d", n)
	}
}
