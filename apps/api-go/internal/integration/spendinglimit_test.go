package integration

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/local"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/spendinglimit"
)

func exec(t *testing.T, database *db.DB, query string, args ...any) {
	t.Helper()
	if err := database.System(context.Background(), "test write", func(tx pgx.Tx) error {
		_, err := tx.Exec(context.Background(), query, args...)
		return err
	}); err != nil {
		t.Fatalf("exec %q: %v", query, err)
	}
}

func addPayment(t *testing.T, database *db.DB, id, userID, botID, currency string, amount int, createdAt time.Time, released bool) {
	t.Helper()
	var releasedAt any
	if released {
		releasedAt = createdAt
	}
	exec(t, database, `INSERT INTO payments (id, "operationKey", "userId", "spaceId", "botId", "threadId", site, amount, currency, "releasedAt", "createdAt")
		VALUES ($1, $1, $2, 'sp', $3, 'th', 'shop.example', $4, $5, $6, $7)`,
		id, userID, botID, amount, currency, releasedAt, createdAt.UTC())
}

func addBot(t *testing.T, database *db.DB, id, spaceID, userID, name string) {
	t.Helper()
	exec(t, database, `INSERT INTO bots (id, "spaceId", "userId", name, color, "updatedAt") VALUES ($1, $2, $3, $4, 'blue', now())`, id, spaceID, userID, name)
}

func TestPaymentsListIsOrderedScopedAndNamesBotsInOwnSpacesOnly(t *testing.T) {
	database := openTestDB(t)
	s := seed(t, database)
	actor := db.Actor{UserID: s.UserID, SpaceID: s.Space1}
	ctx := context.Background()

	empty, failure := spendinglimit.Payments(ctx, database, actor)
	if failure != nil || empty == nil || len(empty) != 0 {
		t.Fatalf("empty = %#v, %v", empty, failure)
	}

	// A Space the user is not in, with its own bot.
	foreignOrg := "fo-" + s.UserID
	foreignSpace := "fs-" + s.UserID
	exec(t, database, `INSERT INTO organization (id, name, slug, "createdAt") VALUES ($1, 'Foreign', $1, now())`, foreignOrg)
	exec(t, database, `INSERT INTO spaces (id, "organizationId", name, "isDefault", "createdAt") VALUES ($1, $2, 'Foreign', true, now())`, foreignSpace, foreignOrg)
	addBot(t, database, "b-own-"+s.UserID, s.Space2, s.UserID, "Own bot")
	addBot(t, database, "b-foreign-"+s.UserID, foreignSpace, s.User2ID, "Foreign bot")

	base := time.Date(2026, 5, 1, 12, 0, 0, 123_000_000, time.UTC)
	addPayment(t, database, "p1-"+s.UserID, s.UserID, "b-own-"+s.UserID, "usd", 500, base, false)
	addPayment(t, database, "p2-"+s.UserID, s.UserID, "b-foreign-"+s.UserID, "eur", 700, base.Add(time.Hour), false)
	addPayment(t, database, "p3-"+s.UserID, s.UserID, "b-gone", "usd", 900, base.Add(2*time.Hour), false)
	addPayment(t, database, "p4-"+s.UserID, s.UserID, "b-own-"+s.UserID, "usd", 100, base.Add(3*time.Hour), true)
	addPayment(t, database, "p5-"+s.UserID, s.UserID, "b-own-"+s.UserID, "usd", 300, base.Add(time.Hour), false)
	addPayment(t, database, "px-"+s.User2ID, s.User2ID, "b-own-"+s.UserID, "usd", 111, base, false)

	got, failure := spendinglimit.Payments(ctx, database, actor)
	if failure != nil {
		t.Fatalf("payments: %v", failure)
	}
	var order []string
	for _, p := range got {
		order = append(order, strings.TrimSuffix(p.ID, "-"+s.UserID))
	}
	// newest first; equal createdAt breaks ties by id descending; released and other user's rows are gone.
	if strings.Join(order, ",") != "p3,p5,p2,p1" {
		t.Fatalf("order = %v", order)
	}
	if got[0].BotName != nil || got[2].BotName != nil {
		t.Errorf("unreachable bots must be null: %+v", got)
	}
	if got[1].BotName == nil || *got[1].BotName != "Own bot" || got[3].BotName == nil || *got[3].BotName != "Own bot" {
		t.Errorf("own bot names: %+v", got)
	}
	if got[3].CreatedAt != "2026-05-01T12:00:00.123Z" || got[3].Amount != 500 || got[3].Currency != "usd" || got[3].Site != "shop.example" {
		t.Errorf("row = %+v", got[3])
	}
}

func TestPaymentsListCapsAtFifty(t *testing.T) {
	database := openTestDB(t)
	s := seed(t, database)
	base := time.Date(2026, 5, 1, 0, 0, 0, 0, time.UTC)
	for i := 0; i < 55; i++ {
		addPayment(t, database, fmt.Sprintf("pp%02d-%s", i, s.UserID), s.UserID, "b", "usd", 1+i, base.Add(time.Duration(i)*time.Minute), false)
	}
	got, failure := spendinglimit.Payments(context.Background(), database, db.Actor{UserID: s.UserID, SpaceID: s.Space1})
	if failure != nil || len(got) != 50 || got[0].Amount != 55 || got[49].Amount != 6 {
		t.Fatalf("len=%d first=%v failure=%v", len(got), got[0], failure)
	}
}

func TestSpendingStatus(t *testing.T) {
	database := openTestDB(t)
	s := seed(t, database)
	actor := db.Actor{UserID: s.UserID, SpaceID: s.Space1}
	ctx := context.Background()
	status := func() spendinglimit.Status {
		t.Helper()
		got, failure := spendinglimit.Get(ctx, database, actor, nil)
		if failure != nil {
			t.Fatalf("get: %v", failure)
		}
		return got
	}

	if got := status(); got.Limit != nil || got.Spent != 0 || got.Shown {
		t.Fatalf("nothing set = %+v", got)
	}
	// A card in another Space's vault is not visible from this one (vault_credentials_tenant).
	exec(t, database, `INSERT INTO vault_credentials (id, "userId", "spaceId", name, origin, auth, ciphertext, "updatedAt")
		VALUES ($1, $2, $3, 'card', 'https://x.example', '{"type":"card"}', 'sealed', now())`, "vc-other-"+s.UserID, s.UserID, s.Space2)
	if got := status(); got.Shown {
		t.Fatalf("card in another Space shown: %+v", got)
	}
	exec(t, database, `INSERT INTO vault_credentials (id, "userId", "spaceId", name, origin, auth, ciphertext, "updatedAt")
		VALUES ($1, $2, NULL, 'login', 'https://x.example', '{"type":"login"}', 'sealed', now())`, "vc-login-"+s.UserID, s.UserID)
	if got := status(); got.Shown {
		t.Fatalf("login credential shown: %+v", got)
	}
	exec(t, database, `INSERT INTO vault_credentials (id, "userId", "spaceId", name, origin, auth, ciphertext, "updatedAt")
		VALUES ($1, $2, NULL, 'card2', 'https://x.example', '{"type":"card"}', 'sealed', now())`, "vc-card-"+s.UserID, s.UserID)
	if got := status(); !got.Shown || got.Limit != nil || got.Spent != 0 {
		t.Fatalf("account card = %+v", got)
	}
	exec(t, database, `DELETE FROM vault_credentials WHERE "userId" = $1`, s.UserID)

	exec(t, database, `INSERT INTO payment_wallets (id, "userId", provider, status, ciphertext, "updatedAt") VALUES ($1, $2, 'p', 'pending', 'x', now())`, "w-"+s.UserID, s.UserID)
	if got := status(); got.Shown {
		t.Fatalf("pending wallet shown: %+v", got)
	}
	exec(t, database, `UPDATE payment_wallets SET status = 'connected' WHERE "userId" = $1`, s.UserID)
	if got := status(); !got.Shown {
		t.Fatalf("connected wallet hidden: %+v", got)
	}
	exec(t, database, `DELETE FROM payment_wallets WHERE "userId" = $1`, s.UserID)

	now := time.Now().UTC()
	addPayment(t, database, "g1-"+s.UserID, s.UserID, "b", "usd", 250, now.Add(-time.Second), false)
	if got := status(); !got.Shown || got.Limit != nil || got.Spent != 0 {
		t.Fatalf("paid without a limit = %+v", got)
	}

	// A day limit counts same-currency, unreleased payments since local midnight.
	exec(t, database, `INSERT INTO spending_limits ("userId", amount, currency, period, "updatedAt") VALUES ($1, 1000, 'usd', 'day', now())`, s.UserID)
	addPayment(t, database, "g2-"+s.UserID, s.UserID, "b", "usd", 40, now.Add(-time.Second), true)
	addPayment(t, database, "g3-"+s.UserID, s.UserID, "b", "eur", 70, now.Add(-time.Second), false)
	addPayment(t, database, "g4-"+s.UserID, s.UserID, "b", "usd", 5, now.Add(-72*time.Hour), false)
	addPayment(t, database, "gx-"+s.User2ID, s.User2ID, "b", "usd", 9, now.Add(-time.Second), false)
	got := status()
	if got.Limit == nil || *got.Limit != (spendinglimit.Limit{Amount: 1000, Currency: "usd", Period: "day"}) || got.Spent != 250 || !got.Shown {
		t.Fatalf("day limit = %+v / %+v", got, got.Limit)
	}

	// "none" counts from startsAt.
	exec(t, database, `UPDATE spending_limits SET period = 'none', "startsAt" = $2 WHERE "userId" = $1`, s.UserID, now.Add(-96*time.Hour))
	if got := status(); got.Spent != 255 {
		t.Fatalf("none = %+v", got)
	}

	// An unreadable stored limit still limits, at the strictest reading.
	exec(t, database, `UPDATE spending_limits SET amount = 0, currency = 'jpy', period = 'hourly' WHERE "userId" = $1`, s.UserID)
	got = status()
	if got.Limit == nil || *got.Limit != (spendinglimit.Limit{Amount: 1, Currency: "usd", Period: "none"}) || got.Spent != 255 {
		t.Fatalf("strict reading = %+v / %+v", got, got.Limit)
	}
}

func TestHTTPSpendingLimit(t *testing.T) {
	database := openTestDB(t)
	s := seed(t, database)
	server := testServer(t, database, local.Config{})
	cookie := "better-auth.session_token=" + signedCookie(testSecret, s.SessionToken)

	for path, want := range map[string]string{
		"payments": `{"json":[]}`,
		"get":      `{"json":{"limit":null,"spent":0,"shown":false}}`,
	} {
		response, body := do(t, http.MethodPost, server.URL+"/rpc/spendingLimit/"+path, cookie, "", nil)
		if response.StatusCode != 200 || string(body) != want {
			t.Fatalf("%s = %d %s", path, response.StatusCode, body)
		}
		response, body = do(t, http.MethodPost, server.URL+"/rpc/spendingLimit/"+path, "", `{"json":{}}`, nil)
		if response.StatusCode != 401 || envelopeCode(t, body) != "UNAUTHORIZED" {
			t.Fatalf("%s anonymous = %d %s", path, response.StatusCode, body)
		}
	}
}
