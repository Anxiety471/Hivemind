package integration

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	artifacts "github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/artifactlist"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/models"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/pages"
)

// pages.rename folds the title to one line, moves the update time and nothing else, and
// refuses another member's or another Space's page like a missing one.
func TestPagesRename(t *testing.T) {
	database := openTestDB(t)
	s := seed(t, database)
	actor := db.Actor{UserID: s.UserID, SpaceID: s.Space1}
	ctx := context.Background()
	old := time.Date(2026, 5, 1, 12, 0, 0, 0, time.UTC)
	addPage(t, database, "p1-"+s.UserID, s.Space1, s.UserID, "Old title", nil, nil, old)
	addPage(t, database, "p2-"+s.UserID, s.Space1, s.UserID, "Untouched", nil, nil, old)
	addPage(t, database, "po-"+s.UserID, s.Space1, s.User2ID, "Other user", nil, nil, old)
	addPage(t, database, "px-"+s.UserID, s.Space2, s.UserID, "Other space", nil, nil, old)

	output, failure := pages.Rename(ctx, database, actor, raw(`{"pageId":"p1-`+s.UserID+`","title":" \t a\u0000\n b\u2028\u00a0c \u0085 "}`))
	if failure != nil {
		t.Fatal(failure)
	}
	renamed := output.(pages.Summary)
	if renamed.Title != "a b c" || renamed.UpdatedAt == "2026-05-01T12:00:00.000Z" || renamed.CreatedAt != "2026-05-01T12:00:00.000Z" || renamed.Pinned {
		t.Fatalf("renamed = %+v", renamed)
	}
	if got := systemScalar[string](t, database, `SELECT title FROM pages WHERE id = $1`, "p1-"+s.UserID); got != "a b c" {
		t.Fatalf("stored title = %q", got)
	}
	if got := systemScalar[string](t, database, `SELECT title FROM pages WHERE id = $1`, "p2-"+s.UserID); got != "Untouched" {
		t.Fatalf("sibling = %q", got)
	}
	// A lone surrogate escape decodes to U+FFFD, which is what the sanitizing client stores.
	if output, failure := pages.Rename(ctx, database, actor, raw(`{"pageId":"p1-`+s.UserID+`","title":"x\ud800y"}`)); failure != nil || output.(pages.Summary).Title != "x\uFFFDy" {
		t.Fatalf("surrogate = %v %v", output, failure)
	}
	for _, id := range []string{"po-", "px-", "missing-"} {
		if _, failure := pages.Rename(ctx, database, actor, raw(`{"pageId":"`+id+s.UserID+`","title":"Nope"}`)); failure == nil || failure.Code != "NOT_FOUND" || failure.Message != "Resource not found" {
			t.Errorf("%s: %v", id, failure)
		}
	}
	for id, title := range map[string]string{"po-": "Other user", "px-": "Other space"} {
		if got := systemScalar[string](t, database, `SELECT title FROM pages WHERE id = $1`, id+s.UserID); got != title {
			t.Errorf("%s title = %q, want %q", id, got, title)
		}
	}
	// A title that folds to nothing, or past 200 characters once folded, fails the input check.
	for name, input := range map[string]string{
		"blank":    `{"pageId":"p1","title":" \u0000\t "}`,
		"too long": `{"pageId":"p1","title":"` + strings.Repeat("x", 201) + `"}`,
	} {
		if _, failure := pages.Rename(ctx, database, actor, raw(input)); failure == nil || failure.Message != "Input validation failed" {
			t.Errorf("%s: %v", name, failure)
		}
	}
	// 200 characters of four bytes each is within the limit: it counts code points.
	if _, failure := pages.Rename(ctx, database, actor, raw(`{"pageId":"p1-`+s.UserID+`","title":"`+strings.Repeat("😀", 200)+`"}`)); failure != nil {
		t.Errorf("200 code points: %v", failure)
	}
}

// pages.pin sets the pin time and leaves the update time alone; a page already in the asked
// state is returned as read.
func TestPagesPin(t *testing.T) {
	database := openTestDB(t)
	s := seed(t, database)
	actor := db.Actor{UserID: s.UserID, SpaceID: s.Space1}
	ctx := context.Background()
	old := time.Date(2026, 5, 1, 12, 0, 0, 0, time.UTC)
	pinnedAt := old.Add(-time.Hour)
	addPage(t, database, "p1-"+s.UserID, s.Space1, s.UserID, "Loose", nil, nil, old)
	addPage(t, database, "p2-"+s.UserID, s.Space1, s.UserID, "Pinned", nil, &pinnedAt, old)
	addPage(t, database, "po-"+s.UserID, s.Space1, s.User2ID, "Other user", nil, nil, old)

	pinned, failure := pages.Pin(ctx, database, actor, raw(`{"pageId":"p1-`+s.UserID+`","pinned":true}`))
	if failure != nil {
		t.Fatal(failure)
	}
	if summary := pinned.(pages.Summary); !summary.Pinned || summary.UpdatedAt != "2026-05-01T12:00:00.000Z" {
		t.Fatalf("pinned = %+v", summary)
	}
	if !systemScalar[bool](t, database, `SELECT "pinnedAt" IS NOT NULL AND "pinnedAt" > now() - interval '1 minute' FROM pages WHERE id = $1`, "p1-"+s.UserID) {
		t.Fatal("pin time not set")
	}
	// Already pinned: nothing is written, the pin time stays.
	if _, failure := pages.Pin(ctx, database, actor, raw(`{"pageId":"p2-`+s.UserID+`","pinned":true}`)); failure != nil {
		t.Fatal(failure)
	}
	if !systemScalar[bool](t, database, `SELECT "pinnedAt" = $2 FROM pages WHERE id = $1`, "p2-"+s.UserID, pinnedAt) {
		t.Fatal("pin time rewritten")
	}
	unpinned, failure := pages.Pin(ctx, database, actor, raw(`{"pageId":"p2-`+s.UserID+`","pinned":false}`))
	if failure != nil || unpinned.(pages.Summary).Pinned || !systemScalar[bool](t, database, `SELECT "pinnedAt" IS NULL FROM pages WHERE id = $1`, "p2-"+s.UserID) {
		t.Fatalf("unpin = %v %v", unpinned, failure)
	}
	if _, failure := pages.Pin(ctx, database, actor, raw(`{"pageId":"p1-`+s.UserID+`","pinned":false}`)); failure != nil {
		t.Fatal(failure)
	}
	for _, id := range []string{"po-", "missing-"} {
		if _, failure := pages.Pin(ctx, database, actor, raw(`{"pageId":"`+id+s.UserID+`","pinned":true}`)); failure == nil || failure.Code != "NOT_FOUND" {
			t.Errorf("%s: %v", id, failure)
		}
	}
	// A stored title past the bound fails the router's output parse, after the pin has committed.
	exec(t, database, `UPDATE pages SET title = $2 WHERE id = $1`, "p1-"+s.UserID, strings.Repeat("t", 201))
	if _, failure := pages.Pin(ctx, database, actor, raw(`{"pageId":"p1-`+s.UserID+`","pinned":true}`)); failure == nil || failure.Message != "Output validation failed" {
		t.Fatalf("long title = %v", failure)
	}
	if !systemScalar[bool](t, database, `SELECT "pinnedAt" IS NOT NULL FROM pages WHERE id = $1`, "p1-"+s.UserID) {
		t.Fatal("the failed output rolled the write back")
	}
}

// pages.list parses only the page it returns: a bad row past the page is not an error.
func TestPagesListChecksOnlyThePage(t *testing.T) {
	database := openTestDB(t)
	s := seed(t, database)
	actor := db.Actor{UserID: s.UserID, SpaceID: s.Space1}
	base := time.Date(2026, 5, 1, 12, 0, 0, 0, time.UTC)
	addPage(t, database, "a-"+s.UserID, s.Space1, s.UserID, "Fine", nil, nil, base)
	addPage(t, database, "b-"+s.UserID, s.Space1, s.UserID, strings.Repeat("t", 201), nil, nil, base.Add(-time.Hour))
	if result, failure := listPages(t, database, actor, `{"limit":1}`); failure != nil || len(result.Items) != 1 || result.NextCursor == nil {
		t.Fatalf("limit 1 = %+v %v", result, failure)
	}
	if _, failure := listPages(t, database, actor, `{"limit":2}`); failure == nil || failure.Message != "Output validation failed" {
		t.Fatalf("limit 2 = %v", failure)
	}
}

func addCredential(t *testing.T, database *db.DB, id, userID, label string) {
	t.Helper()
	exec(t, database, `INSERT INTO user_model_credentials (id, "userId", provider, label, "secretId", "createdAt", "updatedAt")
		VALUES ($1, $2, 'openai', $3, 'secret-'||$1, now() - interval '1 day', now() - interval '1 day')`, id, userID, label)
}

// models.rename changes the label of the member's own connection from any Space: trimmed, NUL
// replaced, the change time moved, the sealed key reference left alone.
func TestModelsRename(t *testing.T) {
	database := openTestDB(t)
	s := seed(t, database)
	ctx := context.Background()
	addCredential(t, database, "c1-"+s.UserID, s.UserID, "Old")
	addCredential(t, database, "c2-"+s.UserID, s.UserID, "Sibling")
	addCredential(t, database, "co-"+s.UserID, s.User2ID, "Other member")

	for _, space := range []string{s.Space1, s.Space2} {
		actor := db.Actor{UserID: s.UserID, SpaceID: space}
		output, failure := models.Rename(ctx, database, actor, raw(`{"credentialId":"c1-`+s.UserID+`","label":" \u00a0My\u0000 key\t "}`))
		if failure != nil || output.(map[string]any)["ok"] != true {
			t.Fatalf("%s: %v %v", space, output, failure)
		}
		if got := systemScalar[string](t, database, `SELECT label FROM user_model_credentials WHERE id = $1`, "c1-"+s.UserID); got != "My\uFFFD key" {
			t.Fatalf("label = %q", got)
		}
	}
	if !systemScalar[bool](t, database, `SELECT "updatedAt" > now() - interval '1 minute' AND "secretId" = 'secret-'||id FROM user_model_credentials WHERE id = $1`, "c1-"+s.UserID) {
		t.Fatal("updatedAt did not move or the secret reference changed")
	}
	if got := systemScalar[string](t, database, `SELECT label FROM user_model_credentials WHERE id = $1`, "c2-"+s.UserID); got != "Sibling" {
		t.Fatalf("sibling = %q", got)
	}
	actor := db.Actor{UserID: s.UserID, SpaceID: s.Space1}
	for _, id := range []string{"co-", "missing-"} {
		if _, failure := models.Rename(ctx, database, actor, raw(`{"credentialId":"`+id+s.UserID+`","label":"x"}`)); failure == nil || failure.Code != "NOT_FOUND" || failure.Message != "Connection not found" {
			t.Errorf("%s: %v", id, failure)
		}
	}
	if got := systemScalar[string](t, database, `SELECT label FROM user_model_credentials WHERE id = $1`, "co-"+s.UserID); got != "Other member" {
		t.Fatalf("other member's label = %q", got)
	}
	for name, input := range map[string]string{
		"blank":    `{"credentialId":"c1","label":" \t "}`,
		"too long": `{"credentialId":"c1","label":"` + strings.Repeat("x", 81) + `"}`,
		"no id":    `{"label":"x"}`,
	} {
		if _, failure := models.Rename(ctx, database, actor, raw(input)); failure == nil || failure.Message != "Input validation failed" {
			t.Errorf("%s: %v", name, failure)
		}
	}
}

type artifactSeed struct {
	id, spaceID, name, mime string
	botID, groupID, runID   *string
	rootID                  *string
	version                 int
	createdAt               time.Time
}

func addArtifact(t *testing.T, database *db.DB, userID string, a artifactSeed) {
	t.Helper()
	if a.mime == "" {
		a.mime = "text/plain"
	}
	exec(t, database, `INSERT INTO artifacts (id, "spaceId", "userId", "botId", "groupId", "runId", name, description, "mimeType", size, hash, "storageKey", "rootArtifactId", version, "createdAt")
		VALUES ($1, $2, $3, $4, $5, $6, $7, 'described', $8, 12, 'h', 'k', $9, $10, $11)`,
		a.id, a.spaceID, userID, a.botID, a.groupID, a.runID, a.name, a.mime, a.rootID, a.version, a.createdAt.UTC())
}

func spacePage(t *testing.T, database *db.DB, actor db.Actor, input string) (artifacts.SpacePage, any) {
	t.Helper()
	output, failure := artifacts.ListSpace(context.Background(), database, actor, raw(input))
	if failure != nil {
		return artifacts.SpacePage{}, failure
	}
	return output.(artifacts.SpacePage), nil
}

func TestArtifactsListSpaceFamiliesPagingAndFilters(t *testing.T) {
	database := openTestDB(t)
	s := seed(t, database)
	actor := db.Actor{UserID: s.UserID, SpaceID: s.Space1}
	u := s.UserID
	bot1, bot2 := "b1-"+u, "b2-"+u
	addBot(t, database, bot1, s.Space1, u, "One")
	addBot(t, database, bot2, s.Space1, u, "Two")
	hour := func(n int) time.Time { return time.Date(2026, 5, 1, n, 0, 0, 0, time.UTC) }
	// Family R: three versions by bot1; S: one upload by bot2; T: a bot-made file; hidden and foreign rows.
	addArtifact(t, database, u, artifactSeed{id: "r1-" + u, spaceID: s.Space1, name: "report.md", botID: &bot1, version: 1, createdAt: hour(10)})
	addArtifact(t, database, u, artifactSeed{id: "r2-" + u, spaceID: s.Space1, name: "report.md", botID: &bot1, rootID: new("r1-" + u), version: 2, createdAt: hour(11)})
	addArtifact(t, database, u, artifactSeed{id: "r3-" + u, spaceID: s.Space1, name: "report.md", botID: &bot1, rootID: new("r1-" + u), version: 3, createdAt: hour(12), runID: new("run-1")})
	addArtifact(t, database, u, artifactSeed{id: "s1-" + u, spaceID: s.Space1, name: "notes.txt", botID: &bot2, version: 1, createdAt: hour(9)})
	addArtifact(t, database, u, artifactSeed{id: "t1-" + u, spaceID: s.Space1, name: "made.png", mime: "image/png", botID: &bot2, runID: new("run-2"), version: 1, createdAt: hour(8)})
	addArtifact(t, database, u, artifactSeed{id: "h1-" + u, spaceID: s.Space1, name: "app.html", mime: "text/html;profile=mcp-app", botID: &bot1, version: 1, createdAt: hour(13)})
	addArtifact(t, database, u, artifactSeed{id: "h2-" + u, spaceID: s.Space1, name: "shot.png", mime: "image/png;profile=step-screenshot", botID: &bot1, version: 1, createdAt: hour(14)})
	addArtifact(t, database, u, artifactSeed{id: "x1-" + u, spaceID: s.Space2, name: "elsewhere.txt", version: 1, createdAt: hour(15)})

	all, failure := spacePage(t, database, actor, `{}`)
	if failure != nil {
		t.Fatal(failure)
	}
	var ids []string
	for _, item := range all.Items {
		ids = append(ids, strings.TrimSuffix(item.ID, "-"+u))
	}
	if strings.Join(ids, ",") != "r1,s1,t1" || all.NextCursor != nil {
		t.Fatalf("items = %v next = %v", ids, all.NextCursor)
	}
	first := all.Items[0]
	// The family's stable id, the newest version's fields, and how many versions there are.
	if first.Version != 3 || first.VersionCount != 3 || first.CreatedAt != "2026-05-01T12:00:00.000Z" || first.RunID == nil || *first.RunID != "run-1" {
		t.Fatalf("family = %+v", first)
	}
	body, _ := json.Marshal(first)
	if want := `{"id":"r1-` + u + `","botId":"` + bot1 + `","groupId":null,"runId":"run-1","name":"report.md","description":"described","mimeType":"text/plain","size":12,"version":3,"createdAt":"2026-05-01T12:00:00.000Z","versionCount":3}`; string(body) != want {
		t.Fatalf("wire = %s", body)
	}

	// madeByBots keeps the families whose newest version carries a run.
	made, _ := spacePage(t, database, actor, `{"madeByBots":true}`)
	if len(made.Items) != 2 || made.Items[0].ID != "r1-"+u || made.Items[1].ID != "t1-"+u {
		t.Fatalf("made by bots = %+v", made.Items)
	}
	// A bot's scope counts only that bot's versions.
	one, _ := spacePage(t, database, actor, `{"botId":"`+bot2+`"}`)
	if len(one.Items) != 2 || one.Items[0].ID != "s1-"+u {
		t.Fatalf("bot two = %+v", one.Items)
	}

	// Walk the list one family at a time: the cursor neither skips nor repeats.
	var walked []string
	cursor := ""
	for round := 0; round < 6; round++ {
		input := `{"limit":1}`
		if cursor != "" {
			input = `{"limit":1,"cursor":"` + cursor + `"}`
		}
		page, failure := spacePage(t, database, actor, input)
		if failure != nil {
			t.Fatalf("round %d: %v", round, failure)
		}
		for _, item := range page.Items {
			walked = append(walked, strings.TrimSuffix(item.ID, "-"+u))
		}
		if page.NextCursor == nil {
			break
		}
		cursor = *page.NextCursor
	}
	if strings.Join(walked, ",") != "r1,s1,t1" {
		t.Fatalf("walked = %v", walked)
	}
	// The cursor is "v1." + base64url of the position, scope and start time, in that key order.
	page, _ := spacePage(t, database, actor, `{"limit":1,"botId":"`+bot1+`","madeByBots":true}`)
	if page.NextCursor != nil {
		t.Fatalf("one family fits: %v", page.NextCursor)
	}
	page, _ = spacePage(t, database, actor, `{"limit":1}`)
	if page.NextCursor == nil || !strings.HasPrefix(*page.NextCursor, "v1.") {
		t.Fatalf("cursor = %v", page.NextCursor)
	}
	decoded, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(*page.NextCursor, "v1."))
	if err != nil || !strings.HasPrefix(string(decoded), `{"createdAt":"2026-05-01T12:00:00.000Z","id":"r3-`+u+`","botId":null,"madeByBots":false,"asOf":"`) {
		t.Fatalf("cursor body = %s %v", decoded, err)
	}

	// asOf freezes the set: a cursor started at 11:00 does not see the 12:00 version, so the family
	// reads as it did then (two versions, the second newest).
	frozen := cursorOf(t, hour(11), "zzz", nil, false, hour(11))
	page, failure = spacePage(t, database, actor, `{"cursor":"`+frozen+`"}`)
	if failure != nil || len(page.Items) != 3 || page.Items[0].ID != "r1-"+u || page.Items[0].Version != 2 || page.Items[0].VersionCount != 2 {
		t.Fatalf("frozen = %+v %v", page.Items, failure)
	}

	// Another Space sees only its own files.
	other, _ := spacePage(t, database, db.Actor{UserID: s.UserID, SpaceID: s.Space2}, `{}`)
	if len(other.Items) != 1 || other.Items[0].ID != "x1-"+u || other.Items[0].BotID != nil {
		t.Fatalf("space two = %+v", other.Items)
	}
}

func cursorOf(t *testing.T, createdAt time.Time, id string, botID *string, madeByBots bool, asOf time.Time) string {
	t.Helper()
	body, err := json.Marshal(map[string]any{"createdAt": createdAt.UTC().Format("2006-01-02T15:04:05.000Z"), "id": id, "botId": botID, "madeByBots": madeByBots, "asOf": asOf.UTC().Format("2006-01-02T15:04:05.000Z")})
	if err != nil {
		t.Fatal(err)
	}
	return "v1." + base64.RawURLEncoding.EncodeToString(body)
}

func TestArtifactsListSpaceRejectsBadCursorsAndInput(t *testing.T) {
	database := openTestDB(t)
	s := seed(t, database)
	actor := db.Actor{UserID: s.UserID, SpaceID: s.Space1}
	ctx := context.Background()
	at := time.Date(2026, 5, 1, 12, 0, 0, 0, time.UTC)
	encode := func(text string) string { return "v1." + base64.RawURLEncoding.EncodeToString([]byte(text)) }
	bot := "b-" + s.UserID
	addBot(t, database, bot, s.Space1, s.UserID, "Bot")
	for name, cursor := range map[string]string{
		"no prefix":         strings.TrimPrefix(cursorOf(t, at, "a", nil, false, at), "v1."),
		"not json":          encode("nope"),
		"null":              encode("null"),
		"array":             encode("[]"),
		"no id":             encode(`{"createdAt":"2026-05-01T12:00:00.000Z","botId":null,"asOf":"2026-05-01T12:00:00.000Z"}`),
		"empty id":          encode(`{"createdAt":"2026-05-01T12:00:00.000Z","id":"","botId":null,"asOf":"2026-05-01T12:00:00.000Z"}`),
		"null id":           encode(`{"createdAt":"2026-05-01T12:00:00.000Z","id":null,"botId":null,"asOf":"2026-05-01T12:00:00.000Z"}`),
		"null createdAt":    encode(`{"createdAt":null,"id":"a","botId":null,"asOf":"2026-05-01T12:00:00.000Z"}`),
		"missing botId":     encode(`{"createdAt":"2026-05-01T12:00:00.000Z","id":"a","asOf":"2026-05-01T12:00:00.000Z"}`),
		"numeric botId":     encode(`{"createdAt":"2026-05-01T12:00:00.000Z","id":"a","botId":5,"asOf":"2026-05-01T12:00:00.000Z"}`),
		"string madeByBots": encode(`{"createdAt":"2026-05-01T12:00:00.000Z","id":"a","botId":null,"madeByBots":"yes","asOf":"2026-05-01T12:00:00.000Z"}`),
		"bad createdAt":     encode(`{"createdAt":"yesterday","id":"a","botId":null,"asOf":"2026-05-01T12:00:00.000Z"}`),
		"bad asOf":          encode(`{"createdAt":"2026-05-01T12:00:00.000Z","id":"a","botId":null,"asOf":"soon"}`),
		"other casing":      encode(`{"CreatedAt":"2026-05-01T12:00:00.000Z","ID":"a","botId":null,"asOf":"2026-05-01T12:00:00.000Z"}`),
		"scope botId":       cursorOf(t, at, "a", new(bot), false, at),
		"scope madeByBots":  cursorOf(t, at, "a", nil, true, at),
	} {
		_, failure := artifacts.ListSpace(ctx, database, actor, raw(`{"cursor":`+quoteJSON(cursor)+`}`))
		if failure == nil || failure.Code != "BAD_REQUEST" || failure.Message != "Invalid artifact cursor" || failure.Data != nil {
			t.Errorf("%s: %v", name, failure)
		}
	}
	// Absent and null madeByBots in a cursor read as false.
	for name, cursor := range map[string]string{
		"absent": encode(`{"createdAt":"2026-05-01T12:00:00.000Z","id":"a","botId":null,"asOf":"2026-05-01T12:00:00.000Z"}`),
		"null":   encode(`{"createdAt":"2026-05-01T12:00:00.000Z","id":"a","botId":null,"madeByBots":null,"asOf":"2026-05-01"}`),
		"empty":  "",
	} {
		if _, failure := artifacts.ListSpace(ctx, database, actor, raw(`{"cursor":`+quoteJSON(cursor)+`}`)); failure != nil {
			t.Errorf("%s: %v", name, failure)
		}
	}
	// An unknown bot is refused before the cursor is read; an archived one too.
	if _, failure := artifacts.ListSpace(ctx, database, actor, raw(`{"botId":"nope","cursor":"junk"}`)); failure == nil || failure.Code != "NOT_FOUND" {
		t.Errorf("unknown bot = %v", failure)
	}
	exec(t, database, `UPDATE bots SET "archivedAt" = now() WHERE id = $1`, bot)
	if _, failure := artifacts.ListSpace(ctx, database, actor, raw(`{"botId":"`+bot+`"}`)); failure == nil || failure.Code != "NOT_FOUND" {
		t.Errorf("archived bot = %v", failure)
	}
	for name, input := range map[string]string{
		"limit 0":  `{"limit":0}`,
		"limit 61": `{"limit":61}`,
		"empty id": `{"botId":""}`,
		"flag":     `{"madeByBots":"yes"}`,
		"cursor":   `{"cursor":5}`,
		"null":     `{"cursor":null}`,
	} {
		if _, failure := artifacts.ListSpace(ctx, database, actor, raw(input)); failure == nil || failure.Message != "Input validation failed" {
			t.Errorf("%s: %v", name, failure)
		}
	}
}

func TestArtifactsListAndVersions(t *testing.T) {
	database := openTestDB(t)
	s := seed(t, database)
	actor := db.Actor{UserID: s.UserID, SpaceID: s.Space1}
	ctx := context.Background()
	u := s.UserID
	bot, other, archived := "b1-"+u, "b2-"+u, "b3-"+u
	addBot(t, database, bot, s.Space1, u, "One")
	addBot(t, database, other, s.Space2, u, "Two")
	addBot(t, database, archived, s.Space1, u, "Gone")
	exec(t, database, `UPDATE bots SET "archivedAt" = now() WHERE id = $1`, archived)
	group := "g-" + u
	exec(t, database, `INSERT INTO chat_groups (id, "spaceId", "userId", name, "updatedAt") VALUES ($1, $2, $3, 'G', now())`, group, s.Space1, u)
	hour := func(n int) time.Time { return time.Date(2026, 5, 1, n, 0, 0, 0, time.UTC) }
	addArtifact(t, database, u, artifactSeed{id: "a1-" + u, spaceID: s.Space1, name: "a.txt", botID: &bot, version: 1, createdAt: hour(1)})
	addArtifact(t, database, u, artifactSeed{id: "a2-" + u, spaceID: s.Space1, name: "a.txt", botID: &bot, rootID: new("a1-" + u), version: 2, createdAt: hour(2)})
	addArtifact(t, database, u, artifactSeed{id: "g1-" + u, spaceID: s.Space1, name: "group.txt", botID: &bot, groupID: &group, version: 1, createdAt: hour(3)})
	addArtifact(t, database, u, artifactSeed{id: "m1-" + u, spaceID: s.Space1, name: "app", mime: "text/html;profile=mcp-app", botID: &bot, version: 1, createdAt: hour(4)})
	addArtifact(t, database, u, artifactSeed{id: "ss-" + u, spaceID: s.Space1, name: "shot", mime: "image/webp;profile=step-screenshot", botID: &bot, version: 1, createdAt: hour(5)})
	addArtifact(t, database, u, artifactSeed{id: "ar-" + u, spaceID: s.Space1, name: "gone.txt", botID: &archived, version: 1, createdAt: hour(6)})
	addArtifact(t, database, u, artifactSeed{id: "ox-" + u, spaceID: s.Space2, name: "other.txt", botID: &other, version: 1, createdAt: hour(7)})

	output, failure := artifacts.List(ctx, database, actor, raw(`{"botId":"`+bot+`","extra":1}`))
	if failure != nil {
		t.Fatal(failure)
	}
	listed := output.([]artifacts.Artifact)
	got := map[string]bool{}
	for _, item := range listed {
		got[strings.TrimSuffix(item.ID, "-"+u)] = true
	}
	// Every version (not families), no group file, no hidden type, none of another bot.
	if len(listed) != 2 || !got["a1"] || !got["a2"] {
		t.Fatalf("list = %+v", listed)
	}
	for _, id := range []string{archived, other, "nope"} {
		if _, failure := artifacts.List(ctx, database, actor, raw(`{"botId":"`+id+`"}`)); failure == nil || failure.Code != "NOT_FOUND" {
			t.Errorf("%s: %v", id, failure)
		}
	}
	empty, _ := artifacts.List(ctx, database, db.Actor{UserID: s.UserID, SpaceID: s.Space1}, raw(`{"botId":"`+bot+`"}`))
	if empty == nil {
		t.Fatal("nil list")
	}
	// A stored empty run id is not an Id: the router's output parse fails the call.
	addArtifact(t, database, u, artifactSeed{id: "e1-" + u, spaceID: s.Space1, name: "e.txt", botID: &bot, runID: new(""), version: 1, createdAt: hour(8)})
	if _, failure := artifacts.List(ctx, database, actor, raw(`{"botId":"`+bot+`"}`)); failure == nil || failure.Message != "Output validation failed" {
		t.Errorf("empty run id = %v", failure)
	}

	// listVersions: any member id names the family; newest first; the app HTML anchors, the screenshot does not.
	for _, anchor := range []string{"a1-", "a2-"} {
		output, failure := artifacts.ListVersions(ctx, database, actor, raw(`{"familyId":"`+anchor+u+`"}`))
		if failure != nil {
			t.Fatalf("%s: %v", anchor, failure)
		}
		versions := output.([]artifacts.Version)
		if len(versions) != 2 || versions[0].Version != 2 || versions[0].ID != "a2-"+u || versions[1].ID != "a1-"+u || versions[0].CreatedAt != "2026-05-01T02:00:00.000Z" {
			t.Fatalf("%s: %+v", anchor, versions)
		}
	}
	if output, failure := artifacts.ListVersions(ctx, database, actor, raw(`{"familyId":"m1-`+u+`"}`)); failure != nil || len(output.([]artifacts.Version)) != 1 {
		t.Fatalf("app html = %v %v", output, failure)
	}
	for _, id := range []string{"ss-", "ox-", "missing-"} {
		if _, failure := artifacts.ListVersions(ctx, database, actor, raw(`{"familyId":"`+id+u+`"}`)); failure == nil || failure.Code != "NOT_FOUND" || failure.Message != "Resource not found" {
			t.Errorf("%s: %v", id, failure)
		}
	}
	if _, failure := artifacts.ListVersions(ctx, database, actor, raw(`{"familyId":""}`)); failure == nil || failure.Message != "Input validation failed" {
		t.Errorf("empty family id = %v", failure)
	}
}
