package integration

import (
	"context"
	"encoding/json"
	"net/http"
	"regexp"
	"testing"
	"time"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/local"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/messaging"
)

func addIdentity(t *testing.T, database *db.DB, id, userID, spaceID, botID, address string, installation *string) {
	t.Helper()
	exec(t, database, `INSERT INTO messaging_identities (id, provider, address, "userId", "spaceId", "botId", "installationId", "updatedAt")
		VALUES ($1, 'telegram', $2, $3, $4, $5, $6, now())`, id, address+"-"+id, userID, spaceID, botID, installation)
}

func TestMessagingLinkAndIdentities(t *testing.T) {
	database := openTestDB(t)
	s := seed(t, database)
	actor := db.Actor{UserID: s.UserID, SpaceID: s.Space1}
	ctx := context.Background()
	botA, botB, botX := "ba-"+s.UserID, "bb-"+s.UserID, "bx-"+s.UserID
	addBot(t, database, botA, s.Space1, s.UserID, "Bot A")
	addBot(t, database, botB, s.Space1, s.UserID, "Bot B")
	addBot(t, database, botX, s.Space2, s.UserID, "Bot X")

	started, failure := messaging.LinkStart(ctx, database, actor, raw(`{"botId":"`+botA+`"}`))
	if failure != nil {
		t.Fatalf("link start: %v", failure)
	}
	body, _ := json.Marshal(started)
	if !regexp.MustCompile(`^\{"code":"[A-HJKMNP-TV-Z2-9]{4}-[A-HJKMNP-TV-Z2-9]{4}","expiresAt":"[^"]+"(,"shared":true)?\}$`).Match(body) {
		t.Fatalf("link start = %s", body)
	}
	// A fresh request supersedes the previous code; a bot in a shared space is flagged.
	if _, failure := messaging.LinkStart(ctx, database, actor, raw(`{"botId":"`+botX+`"}`)); failure != nil {
		t.Fatal(failure)
	}
	if n := systemScalar[int](t, database, `SELECT count(*)::int FROM messaging_link_codes WHERE "userId" = $1`, s.UserID); n != 1 {
		t.Fatalf("active codes = %d", n)
	}
	if _, failure := messaging.LinkStart(ctx, database, actor, raw(`{"botId":"nope"}`)); failureCode(failure) != "NOT_FOUND" {
		t.Fatalf("unknown bot = %v", failure)
	}

	addIdentity(t, database, "id1-"+s.UserID, s.UserID, s.Space1, botA, "addr1", nil)
	if _, failure := messaging.LinkStart(ctx, database, actor, raw(`{"botId":"`+botA+`"}`)); failureCode(failure) != "BAD_REQUEST" || failure.Message != "That bot is already linked to a chat app; unlink it first." {
		t.Fatalf("already linked = %v", failure)
	}

	moved, failure := messaging.SetBot(ctx, database, actor, raw(`{"identityId":"id1-`+s.UserID+`","botId":"`+botB+`"}`))
	identity := moved.(messaging.Identity)
	if failure != nil || identity.BotID != botB || identity.BotName != "Bot B" || identity.Provider != "telegram" {
		t.Fatalf("setBot = %+v %v", moved, failure)
	}
	addIdentity(t, database, "id2-"+s.UserID, s.UserID, s.Space1, botA, "addr2", nil)
	if _, failure := messaging.SetBot(ctx, database, actor, raw(`{"identityId":"id2-`+s.UserID+`","botId":"`+botB+`"}`)); failureCode(failure) != "BAD_REQUEST" || failure.Message != "That bot is already linked to a chat app." {
		t.Fatalf("unique botId = %v", failure)
	}
	// The failed move changed nothing and the transaction is intact.
	if got := systemScalar[string](t, database, `SELECT "botId" FROM messaging_identities WHERE id = $1`, "id2-"+s.UserID); got != botA {
		t.Fatalf("identity 2 moved: %s", got)
	}
	if _, failure := messaging.SetBot(ctx, database, db.Actor{UserID: s.UserID, SpaceID: s.Space2}, raw(`{"identityId":"id1-`+s.UserID+`","botId":"`+botX+`"}`)); failure != nil {
		t.Fatalf("moving to another space: %v", failure)
	}
	if got := systemScalar[string](t, database, `SELECT "spaceId" FROM messaging_identities WHERE id = $1`, "id1-"+s.UserID); got != s.Space2 {
		t.Fatalf("identity space = %s", got)
	}

	if _, failure := messaging.Unlink(ctx, database, actor, raw(`{"identityId":"id1-`+s.UserID+`"}`)); failure != nil {
		t.Fatalf("unlink: %v", failure)
	}
	if _, failure := messaging.Unlink(ctx, database, actor, raw(`{"identityId":"id1-`+s.UserID+`"}`)); failureCode(failure) != "NOT_FOUND" {
		t.Fatalf("unlink again = %v", failure)
	}
}

func TestMessagingChannelsAndConnections(t *testing.T) {
	database := openTestDB(t)
	s := seed(t, database)
	actor := db.Actor{UserID: s.UserID, SpaceID: s.Space1}
	ctx := context.Background()
	mine, theirs := "bm-"+s.UserID, "bt-"+s.UserID
	addBot(t, database, mine, s.Space1, s.UserID, "My bot")
	addBot(t, database, theirs, s.Space2, s.User2ID, "Their bot")
	addIdentity(t, database, "idm-"+s.UserID, s.UserID, s.Space1, mine, "a1", nil)
	addIdentity(t, database, "idt-"+s.UserID, s.User2ID, s.Space2, theirs, "a2", nil)

	empty, failure := messaging.ChannelsList(ctx, database, db.Actor{UserID: s.User2ID, SpaceID: s.Space2}, raw(``))
	if failure != nil || len(empty.([]messaging.Membership)) != 0 {
		t.Fatalf("no identities = %v %v", empty, failure)
	}
	exec(t, database, `INSERT INTO messaging_channels (id, "threadId", name, provider, "updatedAt") VALUES ($1, 'th-'||$1, 'Team', 'telegram', now())`, "ch-"+s.UserID)
	exec(t, database, `INSERT INTO messaging_channel_members (id, "channelId", address, "identityId", status, "updatedAt") VALUES
		($1, $2, 'a1', $3, 'invited', now()), ($4, $2, 'z', NULL, 'approved', now()), ($5, $2, 'y', NULL, 'left', now())`,
		"m1-"+s.UserID, "ch-"+s.UserID, "idm-"+s.UserID, "m2-"+s.UserID, "m3-"+s.UserID)
	list, failure := messaging.ChannelsList(ctx, database, actor, raw(``))
	memberships := list.([]messaging.Membership)
	if failure != nil || len(memberships) != 1 || memberships[0].MemberCount != 2 || memberships[0].Status != "invited" || memberships[0].Name == nil || *memberships[0].Name != "Team" {
		t.Fatalf("channels = %+v %v", memberships, failure)
	}
	accepted, failure := messaging.ChannelsRespond(ctx, database, actor, raw(`{"membershipId":"m1-`+s.UserID+`","accept":true}`))
	if failure != nil || accepted.(messaging.Membership).Status != "approved" {
		t.Fatalf("respond = %+v %v", accepted, failure)
	}
	if _, failure := messaging.ChannelsRespond(ctx, database, actor, raw(`{"membershipId":"m1-`+s.UserID+`","accept":false}`)); failureCode(failure) != "NOT_FOUND" {
		t.Fatalf("respond twice = %v", failure)
	}
	if _, failure := messaging.ChannelsLeave(ctx, database, actor, raw(`{"membershipId":"m1-`+s.UserID+`"}`)); failure != nil {
		t.Fatal(failure)
	}
	if got := systemScalar[string](t, database, `SELECT status FROM messaging_channel_members WHERE id = $1`, "m1-"+s.UserID); got != "left" {
		t.Fatalf("status = %s", got)
	}

	// Connections: an unapproved outgoing request hides the peer; an incoming one shows it.
	exec(t, database, `INSERT INTO agent_connections (id, "requesterBotId", "targetBotId", status, "updatedAt") VALUES ($1, $2, $3, 'pending', now()), ($4, $3, $2, 'pending', now() - interval '1 minute')`,
		"c1-"+s.UserID, mine, theirs, "c2-"+s.UserID)
	exec(t, database, `UPDATE "user" SET name = 'Jane Quinn' WHERE id = $1`, s.User2ID)
	conns, failure := messaging.ConnectionsList(ctx, database, actor, raw(``))
	list2 := conns.([]messaging.Connection)
	if failure != nil || len(list2) != 2 {
		t.Fatalf("connections = %+v %v", list2, failure)
	}
	if list2[0].PeerBotName != "agent" || list2[0].PeerOwnerLabel != "owner" || list2[0].Incoming {
		t.Errorf("outgoing = %+v", list2[0])
	}
	if list2[1].PeerBotName != "Their bot" || list2[1].PeerOwnerLabel != "Jane" || !list2[1].Incoming {
		t.Errorf("incoming = %+v", list2[1])
	}
	// The invite is undelivered (sent without a provider handle), another key is untouched.
	exec(t, database, `INSERT INTO messaging_outbound (id, "idempotencyKey", kind, body, status, "updatedAt") VALUES
		('o1-'||$2::text, $1, 'dm', 'x', 'sent', now()), ('o3-'||$2::text, 'connect:other:'||$2::text, 'dm', 'x', 'pending', now())`,
		"connect:"+mine+":"+theirs, s.UserID)
	if _, failure := messaging.ConnectionsRevoke(ctx, database, actor, raw(`{"connectionId":"c1-`+s.UserID+`"}`)); failure != nil {
		t.Fatalf("revoke: %v", failure)
	}
	if n := systemScalar[int](t, database, `SELECT count(*)::int FROM messaging_outbound WHERE id IN ($1, $2)`, "o1-"+s.UserID, "o3-"+s.UserID); n != 1 {
		t.Fatalf("outbound rows left = %d, want only the unrelated one", n)
	}
	if _, failure := messaging.ConnectionsRevoke(ctx, database, db.Actor{UserID: s.User2ID, SpaceID: s.Space2}, raw(`{"connectionId":"c1-`+s.UserID+`"}`)); failure != nil {
		// The other party may revoke too: their bot is the target.
		t.Fatalf("peer revoke: %v", failure)
	}
	if _, failure := messaging.ConnectionsRevoke(ctx, database, actor, raw(`{"connectionId":"nope"}`)); failureCode(failure) != "NOT_FOUND" {
		t.Fatalf("unknown = %v", failure)
	}
}

func TestHTTPMessaging(t *testing.T) {
	database := openTestDB(t)
	s := seed(t, database)
	server := testServer(t, database, local.Config{})
	cookie := "better-auth.session_token=" + signedCookie(testSecret, s.SessionToken)
	collect := listen(t, database)
	response, body := do(t, http.MethodPost, server.URL+"/rpc/messaging/channels/list", cookie, "", nil)
	if response.StatusCode != 200 || string(body) != `{"json":[]}` {
		t.Fatalf("list = %d %s", response.StatusCode, body)
	}
	response, body = do(t, http.MethodPost, server.URL+"/rpc/messaging/identities/unlink", cookie, `{"json":{"identityId":""}}`, nil)
	if response.StatusCode != 400 || envelopeCode(t, body) != "BAD_REQUEST" {
		t.Fatalf("invalid = %d %s", response.StatusCode, body)
	}
	response, body = do(t, http.MethodPost, server.URL+"/rpc/messaging/identities/unlink", cookie, `{"json":{"identityId":"nope"}}`, nil)
	if response.StatusCode != 404 || string(body) != `{"json":{"code":"NOT_FOUND","defined":false,"message":"Not Found","status":404}}` {
		t.Fatalf("missing = %d %s", response.StatusCode, body)
	}
	// These procedures publish no signals and record no events.
	if got := collect(300 * time.Millisecond); len(got) != 0 {
		t.Fatalf("signals = %q", got)
	}
}
