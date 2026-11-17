package integration

import (
	"context"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/local"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/botsections"
)

func addSection(t *testing.T, database *db.DB, id, spaceID, userID, name string, position int, createdAt time.Time) {
	t.Helper()
	exec(t, database, `INSERT INTO bot_sections (id, "spaceId", "userId", name, position, "createdAt", "updatedAt") VALUES ($1, $2, $3, $4, $5, $6, $6)`,
		id, spaceID, userID, name, position, createdAt.UTC())
}

func TestBotSectionsListIsSpaceScopedAndOrdered(t *testing.T) {
	database := openTestDB(t)
	s := seed(t, database)
	actor := db.Actor{UserID: s.UserID, SpaceID: s.Space2}
	ctx := context.Background()

	empty, failure := botsections.List(ctx, database, actor)
	if failure != nil || empty == nil || len(empty) != 0 {
		t.Fatalf("empty = %#v, %v", empty, failure)
	}

	base := time.Date(2026, 5, 1, 12, 0, 0, 456_000_000, time.UTC)
	addSection(t, database, "a-"+s.UserID, s.Space2, s.UserID, "Late", 2, base)
	addSection(t, database, "b-"+s.UserID, s.Space2, s.User2ID, "Second by time", 1, base.Add(time.Hour))
	addSection(t, database, "c-"+s.UserID, s.Space2, s.UserID, "First by time", 1, base)
	addSection(t, database, "d-"+s.UserID, s.Space1, s.UserID, "Other space", 0, base)

	got, failure := botsections.List(ctx, database, actor)
	if failure != nil {
		t.Fatalf("list: %v", failure)
	}
	var names []string
	for _, section := range got {
		names = append(names, section.Name)
	}
	// Another member's section in the Space is listed; another Space's is not.
	if strings.Join(names, "|") != "First by time|Second by time|Late" {
		t.Fatalf("names = %v", names)
	}
	if got[0].CreatedAt != "2026-05-01T12:00:00.456Z" || got[0].Position != 1 || got[0].ID != "c-"+s.UserID {
		t.Errorf("row = %+v", got[0])
	}
}

func TestHTTPBotSections(t *testing.T) {
	database := openTestDB(t)
	s := seed(t, database)
	server := testServer(t, database, local.Config{})
	cookie := "better-auth.session_token=" + signedCookie(testSecret, s.SessionToken)
	addSection(t, database, "a-"+s.UserID, s.Space1, s.UserID, "Mine", 0, time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC))

	response, body := do(t, http.MethodPost, server.URL+"/rpc/botSections/list", cookie, "", nil)
	want := `{"json":[{"id":"a-` + s.UserID + `","name":"Mine","position":0,"createdAt":"2026-01-02T03:04:05.000Z","updatedAt":"2026-01-02T03:04:05.000Z"}]}`
	if response.StatusCode != 200 || string(body) != want {
		t.Fatalf("list = %d %s", response.StatusCode, body)
	}
	response, body = do(t, http.MethodPost, server.URL+"/rpc/botSections/list", "", `{"json":{}}`, nil)
	if response.StatusCode != 401 || envelopeCode(t, body) != "UNAUTHORIZED" {
		t.Fatalf("anonymous = %d %s", response.StatusCode, body)
	}
}
