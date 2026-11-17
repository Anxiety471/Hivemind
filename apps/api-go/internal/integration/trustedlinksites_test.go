package integration

import (
	"context"
	"encoding/json"
	"net/http"
	"reflect"
	"testing"

	"github.com/jackc/pgx/v5"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/local"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/orpc"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/trustedlinksites"
)

func insertSite(t *testing.T, database *db.DB, id, userID, site string) {
	t.Helper()
	actor := db.Actor{UserID: userID}
	err := database.Tenant(context.Background(), actor, func(tx pgx.Tx) error {
		_, err := tx.Exec(context.Background(), `INSERT INTO trusted_link_sites (id, "userId", site) VALUES ($1, $2, $3)`, id, userID, site)
		return err
	})
	if err != nil {
		t.Fatalf("insert site: %v", err)
	}
}

func TestTrustedLinkSitesListAndRemoveAreScopedToTheUser(t *testing.T) {
	database := openTestDB(t)
	s := seed(t, database)
	insertSite(t, database, "tl1-"+s.UserID, s.UserID, "zeta.example")
	insertSite(t, database, "tl2-"+s.UserID, s.UserID, "alpha.example")
	insertSite(t, database, "tl3-"+s.User2ID, s.User2ID, "other.example")
	ctx := context.Background()
	actor := db.Actor{UserID: s.UserID, SpaceID: s.Space1}

	sites, failure := trustedlinksites.List(ctx, database, actor)
	if failure != nil || !reflect.DeepEqual(sites, []string{"alpha.example", "zeta.example"}) {
		t.Fatalf("list = %v, %v", sites, failure)
	}

	// Removing a site that is only the other user's changes nothing.
	result, failure := trustedlinksites.Remove(ctx, database, actor, orpc.Input{Raw: json.RawMessage(`{"site":"other.example"}`)})
	if failure != nil || result["ok"] != true {
		t.Fatalf("remove foreign = %v, %v", result, failure)
	}
	if n := systemScalar[int](t, database, `SELECT count(*)::int FROM trusted_link_sites WHERE "userId" = $1`, s.User2ID); n != 1 {
		t.Fatalf("other user's rows = %d, want 1", n)
	}

	if _, failure := trustedlinksites.Remove(ctx, database, actor, orpc.Input{Raw: json.RawMessage(`{"site":"alpha.example"}`)}); failure != nil {
		t.Fatalf("remove: %v", failure)
	}
	// Removing an absent site still succeeds.
	if _, failure := trustedlinksites.Remove(ctx, database, actor, orpc.Input{Raw: json.RawMessage(`{"site":"alpha.example"}`)}); failure != nil {
		t.Fatalf("remove absent: %v", failure)
	}
	sites, _ = trustedlinksites.List(ctx, database, actor)
	if !reflect.DeepEqual(sites, []string{"zeta.example"}) {
		t.Fatalf("after remove = %v", sites)
	}

	// No sites: an empty array, never null.
	empty, failure := trustedlinksites.List(ctx, database, db.Actor{UserID: "nobody-" + s.UserID, SpaceID: s.Space1})
	if failure != nil || empty == nil || len(empty) != 0 {
		t.Fatalf("empty list = %#v, %v", empty, failure)
	}
}

func TestHTTPTrustedLinkSites(t *testing.T) {
	database := openTestDB(t)
	s := seed(t, database)
	insertSite(t, database, "tl1-"+s.UserID, s.UserID, "example.com")
	server := testServer(t, database, local.Config{})
	cookie := "better-auth.session_token=" + signedCookie(testSecret, s.SessionToken)

	response, body := do(t, http.MethodPost, server.URL+"/rpc/trustedLinkSites/list", cookie, "", nil)
	if response.StatusCode != 200 || string(body) != `{"json":["example.com"]}` {
		t.Fatalf("list = %d %s", response.StatusCode, body)
	}
	response, body = do(t, http.MethodPost, server.URL+"/rpc/trustedLinkSites/remove", cookie, `{"json":{"site":"example.com"}}`, nil)
	if response.StatusCode != 200 || string(body) != `{"json":{"ok":true}}` {
		t.Fatalf("remove = %d %s", response.StatusCode, body)
	}
	response, body = do(t, http.MethodPost, server.URL+"/rpc/trustedLinkSites/list", cookie, `{"json":null}`, nil)
	if string(body) != `{"json":[]}` {
		t.Fatalf("list after remove = %d %s", response.StatusCode, body)
	}
	response, body = do(t, http.MethodPost, server.URL+"/rpc/trustedLinkSites/remove", cookie, `{"json":{"site":""}}`, nil)
	if response.StatusCode != 400 || envelopeCode(t, body) != "BAD_REQUEST" {
		t.Fatalf("invalid remove = %d %s", response.StatusCode, body)
	}
	for _, path := range []string{"list", "remove"} {
		response, body = do(t, http.MethodPost, server.URL+"/rpc/trustedLinkSites/"+path, "", `{"json":{"site":"x"}}`, nil)
		if response.StatusCode != 401 || envelopeCode(t, body) != "UNAUTHORIZED" {
			t.Fatalf("%s unauthenticated = %d %s", path, response.StatusCode, body)
		}
	}
}
