package integration

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/local"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/orpc"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/pages"
)

func addPage(t *testing.T, database *db.DB, id, spaceID, userID, title string, botID *string, pinnedAt *time.Time, updatedAt time.Time) {
	t.Helper()
	exec(t, database, `INSERT INTO pages (id, "spaceId", "userId", title, "botId", "pinnedAt", "createdAt", "updatedAt") VALUES ($1, $2, $3, $4, $5, $6, $7, $7)`,
		id, spaceID, userID, title, botID, pinnedAt, updatedAt.UTC())
}

type listed struct {
	Items      []pages.Summary `json:"items"`
	NextCursor *string         `json:"nextCursor"`
}

func listPages(t *testing.T, database *db.DB, actor db.Actor, input string) (listed, *orpc.Error) {
	t.Helper()
	output, failure := pages.List(context.Background(), database, actor, orpc.Input{Raw: json.RawMessage(input)})
	if failure != nil {
		return listed{}, failure
	}
	body, _ := json.Marshal(output)
	var result listed
	if err := json.Unmarshal(body, &result); err != nil {
		t.Fatal(err)
	}
	return result, nil
}

func TestPagesListOrderPaginationAndScope(t *testing.T) {
	database := openTestDB(t)
	s := seed(t, database)
	actor := db.Actor{UserID: s.UserID, SpaceID: s.Space1}
	suffix := "-" + s.UserID
	base := time.Date(2026, 5, 1, 12, 0, 0, 0, time.UTC)
	pinA := base.Add(-time.Hour)
	pinB := base.Add(-2 * time.Hour)
	bot := "bot-" + s.UserID
	exec(t, database, `INSERT INTO bots (id, "spaceId", "userId", name, color, "updatedAt") VALUES ($1, $2, $3, 'B', 'blue', now())`, bot, s.Space1, s.UserID)

	addPage(t, database, "p-pinB"+suffix, s.Space1, s.UserID, "Pinned older", nil, &pinB, base.Add(-48*time.Hour))
	addPage(t, database, "p-pinA"+suffix, s.Space1, s.UserID, "Pinned newer", nil, &pinA, base.Add(-72*time.Hour))
	addPage(t, database, "p-u3"+suffix, s.Space1, s.UserID, "Same time 3", &bot, nil, base)
	addPage(t, database, "p-u2"+suffix, s.Space1, s.UserID, "Same time 2", nil, nil, base)
	addPage(t, database, "p-u1"+suffix, s.Space1, s.UserID, "Older", nil, nil, base.Add(-time.Hour))
	addPage(t, database, "x-space"+suffix, s.Space2, s.UserID, "Other space", nil, nil, base)
	addPage(t, database, "x-user"+suffix, s.Space1, s.User2ID, "Other user", nil, nil, base)

	want := []string{"p-pinA", "p-pinB", "p-u3", "p-u2", "p-u1"}
	ids := func(result listed) []string {
		var out []string
		for _, item := range result.Items {
			out = append(out, strings.TrimSuffix(item.ID, suffix))
		}
		return out
	}
	all, failure := listPages(t, database, actor, `{}`)
	if failure != nil || strings.Join(ids(all), ",") != strings.Join(want, ",") || all.NextCursor != nil {
		t.Fatalf("all = %v %v next=%v", ids(all), failure, all.NextCursor)
	}
	if all.Items[0].Pinned != true || all.Items[2].Pinned || all.Items[2].BotID == nil || all.Items[0].Visibility != "private" || all.Items[0].CurrentVersion != 1 {
		t.Errorf("items = %+v", all.Items)
	}

	// Walk the list two at a time: the cursor must neither skip nor repeat rows, including the updatedAt tie.
	var walked []string
	cursor := ""
	for round := 0; round < 10; round++ {
		input := `{"limit":2}`
		if cursor != "" {
			input = `{"limit":2,"cursor":"` + cursor + `"}`
		}
		result, failure := listPages(t, database, actor, input)
		if failure != nil {
			t.Fatalf("round %d: %v", round, failure)
		}
		walked = append(walked, ids(result)...)
		if result.NextCursor == nil {
			break
		}
		cursor = *result.NextCursor
	}
	if strings.Join(walked, ",") != strings.Join(want, ",") {
		t.Fatalf("walked = %v", walked)
	}

	if _, failure := listPages(t, database, actor, `{"cursor":"!!!"}`); failure == nil || failure.Code != "BAD_REQUEST" || failure.Message != "Invalid page list cursor" || failure.Data != nil {
		t.Fatalf("bad cursor = %+v", failure)
	}
	byBot, _ := listPages(t, database, actor, `{"botId":"`+bot+`"}`)
	if strings.Join(ids(byBot), ",") != "p-u3" {
		t.Fatalf("by bot = %v", ids(byBot))
	}
	titles, _ := listPages(t, database, actor, `{"query":"  SAME  "}`)
	if strings.Join(ids(titles), ",") != "p-u3,p-u2" {
		t.Fatalf("by query = %v", ids(titles))
	}
	none, _ := listPages(t, database, db.Actor{UserID: s.UserID, SpaceID: s.Space3}, `{}`)
	if none.Items == nil || len(none.Items) != 0 {
		t.Fatalf("empty space = %+v", none)
	}
}

func TestPagesListSearchEscapesWildcards(t *testing.T) {
	database := openTestDB(t)
	s := seed(t, database)
	actor := db.Actor{UserID: s.UserID, SpaceID: s.Space1}
	base := time.Date(2026, 5, 1, 12, 0, 0, 0, time.UTC)
	for index, title := range []string{"100% sure", "a_b", "axb", `back\slash`, "plain"} {
		addPage(t, database, "w"+string(rune('a'+index))+"-"+s.UserID, s.Space1, s.UserID, title, nil, nil, base.Add(time.Duration(index)*time.Minute))
	}
	for query, want := range map[string]int{"%": 1, "_": 1, `\`: 1, "A_B": 1, "100%": 1, "x": 1, "PLAIN": 1} {
		result, failure := listPages(t, database, actor, `{"query":`+quoteJSON(query)+`}`)
		if failure != nil || len(result.Items) != want {
			t.Errorf("query %q = %d rows (%v), want %d", query, len(result.Items), failure, want)
		}
	}
}

func quoteJSON(text string) string {
	body, _ := json.Marshal(text)
	return string(body)
}

func TestHTTPPagesList(t *testing.T) {
	database := openTestDB(t)
	s := seed(t, database)
	server := testServer(t, database, local.Config{})
	cookie := "better-auth.session_token=" + signedCookie(testSecret, s.SessionToken)
	addPage(t, database, "p-"+s.UserID, s.Space1, s.UserID, "Hello", nil, nil, time.Date(2026, 1, 2, 3, 4, 5, 6_000_000, time.UTC))

	response, body := do(t, http.MethodPost, server.URL+"/rpc/pages/list", cookie, `{"json":{}}`, nil)
	want := `{"json":{"items":[{"id":"p-` + s.UserID + `","title":"Hello","botId":null,"groupId":null,"visibility":"private","currentVersion":1,"pinned":false,"createdAt":"2026-01-02T03:04:05.006Z","updatedAt":"2026-01-02T03:04:05.006Z"}],"nextCursor":null}}`
	if response.StatusCode != 200 || string(body) != want {
		t.Fatalf("list = %d %s", response.StatusCode, body)
	}
	response, body = do(t, http.MethodPost, server.URL+"/rpc/pages/list", cookie, `{"json":{"cursor":"%%%"}}`, nil)
	if response.StatusCode != 400 || string(body) != `{"json":{"code":"BAD_REQUEST","defined":false,"message":"Invalid page list cursor","status":400}}` {
		t.Fatalf("bad cursor = %d %s", response.StatusCode, body)
	}
	response, body = do(t, http.MethodPost, server.URL+"/rpc/pages/list", cookie, `{"json":{"limit":0}}`, nil)
	if response.StatusCode != 400 || envelopeCode(t, body) != "BAD_REQUEST" {
		t.Fatalf("limit 0 = %d %s", response.StatusCode, body)
	}
	response, body = do(t, http.MethodPost, server.URL+"/rpc/pages/list", "", `{"json":{}}`, nil)
	if response.StatusCode != 401 || envelopeCode(t, body) != "UNAUTHORIZED" {
		t.Fatalf("anonymous = %d %s", response.StatusCode, body)
	}
}
