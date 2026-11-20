package integration

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/routines"
)

// routineOptions are the stored routine fields a case varies; the rest take column defaults.
type routineOptions struct {
	ThreadID        *string
	Name            string
	Crons           []string
	Active          bool
	InChat          bool
	WebhookEnabled  bool
	GithubEnabled   bool
	MessageProvider *string
	EmailSenders    *string
	ModelProvider   *string
	ModelID         *string
	ThinkingLevel   *string
	Watch           *string
	WatchState      *string
	LastRunAt       *time.Time
	NextRunAt       *time.Time
	CreatedAt       *time.Time
}

func addOwnedRoutine(t *testing.T, database *db.DB, id, spaceID, botID, userID string, options routineOptions) {
	t.Helper()
	name := options.Name
	if name == "" {
		name = "Routine " + id
	}
	crons := options.Crons
	if crons == nil {
		crons = []string{}
	}
	created := options.CreatedAt
	if created == nil {
		now := time.Now().UTC().Truncate(time.Millisecond)
		created = &now
	}
	exec(t, database, `INSERT INTO routines (id, "spaceId", "botId", "userId", "threadId", name, prompt, crons,
		timezone, active, notify, "inChat", "webhookEnabled", "githubEnabled", "messageProvider", "emailSenders",
		"modelProvider", "modelId", "thinkingLevel", watch, "watchState", "lastRunAt", "nextRunAt", "createdAt", "updatedAt")
		VALUES ($1, $2, $3, $4, $5, $6, 'prompt', $7, 'UTC', $8, true, $9, $10, $11, $12, $13, $14, $15, $16,
		$17::jsonb, $18::jsonb, $19, $20, $21, $21)`,
		id, spaceID, botID, userID, options.ThreadID, name, crons, options.Active, options.InChat,
		options.WebhookEnabled, options.GithubEnabled, options.MessageProvider, options.EmailSenders,
		options.ModelProvider, options.ModelID, options.ThinkingLevel, options.Watch, options.WatchState,
		options.LastRunAt, options.NextRunAt, created)
}

func addTaskRow(t *testing.T, database *db.DB, id, spaceID, botID, threadID, userID string) {
	t.Helper()
	exec(t, database, `INSERT INTO tasks (id, "spaceId", "botId", "threadId", "userId", prompt, status, "updatedAt")
		VALUES ($1, $2, $3, $4, $5, 'prompt', 'completed', now())`, id, spaceID, botID, threadID, userID)
}

type runOptions struct {
	Status      string
	Error       *string
	CreatedAt   time.Time
	StartedAt   *time.Time
	CompletedAt *time.Time
	LateSince   *time.Time
}

func addRunRow(t *testing.T, database *db.DB, id, spaceID, botID, threadID, routineID string, options runOptions) {
	t.Helper()
	status := options.Status
	if status == "" {
		status = "completed"
	}
	addTaskRow(t, database, "task-"+id, spaceID, botID, threadID, "u-task-"+id)
	exec(t, database, `INSERT INTO runs (id, "spaceId", "botId", "threadId", "taskId", "userId", status, trigger,
		error, "routineId", "startedAt", "completedAt", "lateSince", "createdAt", "updatedAt")
		VALUES ($1, $2, $3, $4, $5, $6, $7, 'routine', $8, $9, $10, $11, $12, $13, $13)`,
		id, spaceID, botID, threadID, "task-"+id, "u-task-"+id, status, options.Error, routineID,
		options.StartedAt, options.CompletedAt, options.LateSince, options.CreatedAt)
}

func addMessageRow(t *testing.T, database *db.DB, id, threadID, botID, role string, seq int, blocks string) {
	t.Helper()
	exec(t, database, `INSERT INTO messages (id, "threadId", "botId", seq, role, blocks) VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
		id, threadID, botID, seq, role, blocks)
}

func routinesJSON(t *testing.T, output any) []map[string]any {
	t.Helper()
	body, err := json.Marshal(output)
	if err != nil {
		t.Fatal(err)
	}
	var parsed []map[string]any
	if err := json.Unmarshal(body, &parsed); err != nil {
		t.Fatalf("output = %s: %v", body, err)
	}
	return parsed
}

func TestRoutinesListMapsStoredRows(t *testing.T) {
	database := openTestDB(t)
	s := seed(t, database)
	cleanupOwnedFixture(t, database, s)
	actor := db.Actor{UserID: s.UserID, SpaceID: s.Space1}
	ctx := context.Background()
	bot := "b-" + s.UserID
	other := "b2-" + s.UserID
	archived := "barch-" + s.UserID
	addBot(t, database, bot, s.Space1, s.UserID, "Bot")
	addBot(t, database, other, s.Space1, s.UserID, "Other")
	addBotRow(t, database, archived, s.Space1, s.UserID, "Archived", new(time.Now().UTC()), nil)

	next := time.Now().UTC().Add(time.Hour).Truncate(time.Millisecond)
	last := time.Date(2026, 4, 1, 9, 30, 0, 0, time.UTC)
	created := time.Date(2026, 4, 1, 8, 0, 0, 0, time.UTC)
	addOwnedRoutine(t, database, "r-"+s.UserID, s.Space1, bot, s.UserID, routineOptions{
		Name:            "Morning brief",
		Crons:           []string{"0 9 * * *"},
		Active:          true,
		MessageProvider: new("telegram"),
		EmailSenders:    new("owner"),
		ModelProvider:   new("azure-openai-responses"),
		ModelID:         new("gpt-5"),
		ThinkingLevel:   new("high"),
		Watch:           new(`{"kind":"command","command":"  df -h  ","unknown":true}`),
		WatchState:      new(`{"checkedAt":"2026-04-01T09:00:00.000Z","outcome":"unchanged","fingerprint":"x","detail":null}`),
		LastRunAt:       &last,
		NextRunAt:       &next,
		CreatedAt:       &created,
	})
	// An invalid watch, an unknown email sender, and an azure alias that is canonicalised.
	addOwnedRoutine(t, database, "r2-"+s.UserID, s.Space1, bot, s.UserID, routineOptions{
		Watch:        new(`{"kind":"http","url":"http://example.com"}`),
		EmailSenders: new("boss"),
	})
	addOwnedRoutine(t, database, "r3-"+s.UserID, s.Space1, other, s.UserID, routineOptions{})
	addOwnedRoutine(t, database, "r4-"+s.UserID, s.Space1, archived, s.UserID, routineOptions{})

	output, failure := routines.List(ctx, database, actor, raw(`{"botId":"`+bot+`"}`))
	if failure != nil {
		t.Fatal(failure)
	}
	list := routinesJSON(t, output)
	if len(list) != 2 {
		t.Fatalf("list = %+v", list)
	}
	byID := map[string]map[string]any{}
	for _, item := range list {
		byID[item["id"].(string)] = item
	}
	first := byID["r-"+s.UserID]
	if first["emailSenders"] != "owner" || first["modelProvider"] != "azure" || first["modelId"] != "gpt-5" ||
		first["thinkingLevel"] != "high" || first["lastRunAt"] != "2026-04-01T09:30:00.000Z" ||
		first["createdAt"] != "2026-04-01T08:00:00.000Z" || first["scheduleDelayed"] != false {
		t.Fatalf("first = %+v", first)
	}
	watch, _ := first["watch"].(map[string]any)
	if watch == nil || watch["kind"] != "command" || watch["command"] != "df -h" ||
		watch["everyMinutes"] != float64(15) || watch["loud"] != false || watch["unknown"] != nil {
		t.Fatalf("watch = %+v", first["watch"])
	}
	state, _ := first["watchState"].(map[string]any)
	if state == nil || state["outcome"] != "unchanged" || state["fingerprint"] != "x" {
		t.Fatalf("watchState = %+v", first["watchState"])
	}
	second := byID["r2-"+s.UserID]
	if second["watch"] != nil || second["emailSenders"] != nil {
		t.Fatalf("second = %+v", second)
	}
	if crons, ok := second["crons"].([]any); !ok || len(crons) != 0 {
		t.Fatalf("crons = %+v", second["crons"])
	}

	if _, failure := routines.List(ctx, database, actor, raw(`{"botId":"`+archived+`"}`)); failureCode(failure) != "NOT_FOUND" || failure.Message != "Resource not found" {
		t.Fatalf("archived bot = %v", failure)
	}
	if _, failure := routines.List(ctx, database, actor, raw(`{"botId":"nope"}`)); failureCode(failure) != "NOT_FOUND" {
		t.Fatalf("unknown bot = %v", failure)
	}
	if _, failure := routines.List(ctx, database, db.Actor{UserID: s.UserID, SpaceID: s.Space2}, raw(`{"botId":"`+bot+`"}`)); failureCode(failure) != "NOT_FOUND" {
		t.Fatalf("other space = %v", failure)
	}
	if _, failure := routines.List(ctx, database, actor, raw(`{"botId":""}`)); failureCode(failure) != "BAD_REQUEST" {
		t.Fatalf("empty id = %v", failure)
	}

	// An invalid thinking level is a value the output schema refuses.
	addOwnedRoutine(t, database, "bad-"+s.UserID, s.Space1, other, s.UserID, routineOptions{ThinkingLevel: new("turbo")})
	if _, failure := routines.List(ctx, database, actor, raw(`{"botId":"`+other+`"}`)); failureCode(failure) != "INTERNAL_SERVER_ERROR" || failure.Message != "Output validation failed" {
		t.Fatalf("bad thinking level = %v", failure)
	}
	exec(t, database, `UPDATE routines SET "thinkingLevel" = NULL WHERE id = $1`, "bad-"+s.UserID)
	addOwnedRoutine(t, database, "badmp-"+s.UserID, s.Space1, other, s.UserID, routineOptions{MessageProvider: new("Not A Provider")})
	if _, failure := routines.List(ctx, database, actor, raw(`{"botId":"`+other+`"}`)); failureCode(failure) != "INTERNAL_SERVER_ERROR" {
		t.Fatalf("bad message provider = %v", failure)
	}
	exec(t, database, `UPDATE routines SET "messageProvider" = NULL WHERE id = $1`, "badmp-"+s.UserID)
}

func TestRoutinesListForMentionsGroupsLiveBots(t *testing.T) {
	database := openTestDB(t)
	s := seed(t, database)
	cleanupOwnedFixture(t, database, s)
	actor := db.Actor{UserID: s.UserID, SpaceID: s.Space1}
	ctx := context.Background()
	first, second := "m1-"+s.UserID, "m2-"+s.UserID
	archived, elsewhere := "march-"+s.UserID, "mx-"+s.UserID
	addBot(t, database, first, s.Space1, s.UserID, "First")
	addBot(t, database, second, s.Space1, s.UserID, "Second")
	addBotRow(t, database, archived, s.Space1, s.UserID, "Archived", new(time.Now().UTC()), nil)
	addBot(t, database, elsewhere, s.Space2, s.UserID, "Elsewhere")
	addOwnedRoutine(t, database, "mr1-"+s.UserID, s.Space1, first, s.UserID, routineOptions{})
	addOwnedRoutine(t, database, "mr2-"+s.UserID, s.Space1, first, s.UserID, routineOptions{})
	addOwnedRoutine(t, database, "mr3-"+s.UserID, s.Space1, second, s.UserID, routineOptions{})
	addOwnedRoutine(t, database, "mr4-"+s.UserID, s.Space1, archived, s.UserID, routineOptions{})
	addOwnedRoutine(t, database, "mr5-"+s.UserID, s.Space2, elsewhere, s.UserID, routineOptions{})

	output, failure := routines.ListForMentions(ctx, database, actor, raw(`{"botIds":["`+first+`","`+second+`","`+archived+`","`+elsewhere+`"]}`))
	if failure != nil {
		t.Fatal(failure)
	}
	body, _ := json.Marshal(output)
	var groups []struct {
		BotID    string `json:"botId"`
		Routines []struct {
			ID string `json:"id"`
		} `json:"routines"`
	}
	if err := json.Unmarshal(body, &groups); err != nil {
		t.Fatalf("output = %s: %v", body, err)
	}
	if len(groups) != 2 {
		t.Fatalf("groups = %s", body)
	}
	counts := map[string]int{}
	for _, group := range groups {
		counts[group.BotID] = len(group.Routines)
	}
	if counts[first] != 2 || counts[second] != 1 {
		t.Fatalf("counts = %+v", counts)
	}
	// The archived bot and the other Space's bot are not in the batch, so nothing is theirs.
	for _, group := range groups {
		if group.BotID == archived || group.BotID == elsewhere {
			t.Fatalf("leaked bot %s", group.BotID)
		}
	}

	output, failure = routines.ListForMentions(ctx, database, actor, raw(`{"botIds":["`+archived+`"]}`))
	body, _ = json.Marshal(output)
	if failure != nil || string(body) != `[]` {
		t.Fatalf("archived batch = %s %v", body, failure)
	}
	if _, failure := routines.ListForMentions(ctx, database, actor, raw(`{"botIds":[]}`)); failureCode(failure) != "BAD_REQUEST" {
		t.Fatalf("empty batch = %v", failure)
	}
}

func TestRoutinesHistoryPagesCursorRepliesAndErrors(t *testing.T) {
	database := openTestDB(t)
	s := seed(t, database)
	cleanupOwnedFixture(t, database, s)
	actor := db.Actor{UserID: s.UserID, SpaceID: s.Space1}
	ctx := context.Background()
	bot := "hb-" + s.UserID
	thread := "ht-" + s.UserID
	group := "hg-" + s.UserID
	groupThread := "hgt-" + s.UserID
	addBot(t, database, bot, s.Space1, s.UserID, "Bot")
	addThread(t, database, thread, s.Space1, s.UserID, &bot, nil, 50)
	exec(t, database, `INSERT INTO chat_groups (id, "spaceId", "userId", name, "updatedAt") VALUES ($1, $2, $3, 'G', now())`,
		group, s.Space1, s.UserID)
	addThread(t, database, groupThread, s.Space1, s.UserID, nil, &group, 0)
	addOwnedRoutine(t, database, "hr-"+s.UserID, s.Space1, bot, s.UserID, routineOptions{})

	base := time.Date(2026, 4, 1, 12, 0, 0, 0, time.UTC)
	runID := func(index int) string { return "run-" + s.UserID + "-" + pad2(index) }
	// 22 runs, one a minute apart, newest last so the descending order reverses insertion.
	for index := range 22 {
		id := runID(index)
		created := base.Add(time.Duration(index) * time.Minute)
		options := runOptions{CreatedAt: created, CompletedAt: new(created.Add(30 * time.Second)), StartedAt: new(created)}
		switch index {
		case 21: // the newest run: a failed one with a long diagnostic
			options.Status = "failed"
			options.Error = new(strings.Repeat("x", 320))
			options.CompletedAt = nil
			options.StartedAt = nil
		case 20: // a completed run that kept an error anyway: not shown
			options.Status = "completed"
			options.Error = new("noise")
		case 19: // a group chat run
			addRunRow(t, database, id, s.Space1, bot, groupThread, "hr-"+s.UserID, options)
			continue
		case 18:
			options.Status = "cancelled"
			options.LateSince = new(created.Add(time.Minute))
		}
		addRunRow(t, database, id, s.Space1, bot, thread, "hr-"+s.UserID, options)
	}
	// The newest run's first bot message is its chat link; an earlier user message is not one.
	addMessageRow(t, database, "msg-user-"+s.UserID, thread, bot, "user", 1, `[{"kind":"text","text":"hi"}]`)
	addMessageRow(t, database, "msg-bot1-"+s.UserID, thread, bot, "bot", 2, `[{"kind":"text","text":"first"}]`)
	addMessageRow(t, database, "msg-bot2-"+s.UserID, thread, bot, "bot", 3, `[{"kind":"text","text":"second"}]`)
	exec(t, database, `UPDATE messages SET "runId" = $2 WHERE id LIKE 'msg-bot%' AND "threadId" = $1`, thread, runID(21))

	output, failure := routines.History(ctx, database, actor, raw(`{"routineId":"hr-`+s.UserID+`"}`))
	if failure != nil {
		t.Fatal(failure)
	}
	var history struct {
		Runs []struct {
			ID          string  `json:"id"`
			BotID       string  `json:"botId"`
			GroupID     *string `json:"groupId"`
			Status      string  `json:"status"`
			Error       *string `json:"error"`
			CreatedAt   string  `json:"createdAt"`
			StartedAt   *string `json:"startedAt"`
			LateSince   *string `json:"lateSince"`
			CompletedAt *string `json:"completedAt"`
			MessageID   *string `json:"messageId"`
		} `json:"runs"`
		NextCursor *struct {
			ID        string `json:"id"`
			CreatedAt string `json:"createdAt"`
		} `json:"nextCursor"`
	}
	body, _ := json.Marshal(output)
	if err := json.Unmarshal(body, &history); err != nil {
		t.Fatalf("output = %s: %v", body, err)
	}
	if len(history.Runs) != 20 || history.NextCursor == nil {
		t.Fatalf("page = %s", body)
	}
	newest := history.Runs[0]
	if newest.ID != runID(21) || newest.Status != "failed" || newest.Error == nil ||
		*newest.Error != strings.Repeat("x", 300)+"…" || newest.MessageID == nil ||
		*newest.MessageID != "msg-bot1-"+s.UserID || newest.StartedAt != nil || newest.CompletedAt != nil {
		t.Fatalf("newest = %+v", newest)
	}
	if history.Runs[1].ID != runID(20) || history.Runs[1].Error != nil {
		t.Fatalf("completed with an error = %+v", history.Runs[1])
	}
	if history.Runs[2].ID != runID(19) || history.Runs[2].GroupID == nil || *history.Runs[2].GroupID != group {
		t.Fatalf("group run = %+v", history.Runs[2])
	}
	if history.Runs[3].ID != runID(18) || history.Runs[3].LateSince == nil || history.Runs[3].Status != "cancelled" {
		t.Fatalf("late run = %+v", history.Runs[3])
	}
	if history.NextCursor.ID != history.Runs[19].ID || history.NextCursor.CreatedAt != history.Runs[19].CreatedAt {
		t.Fatalf("cursor = %+v last %+v", history.NextCursor, history.Runs[19])
	}

	// The next page continues exactly where the cursor left off and has no further page.
	cursor := `{"routineId":"hr-` + s.UserID + `","before":{"id":"` + history.NextCursor.ID + `","createdAt":"` + history.NextCursor.CreatedAt + `"}}`
	output, failure = routines.History(ctx, database, actor, raw(cursor))
	if failure != nil {
		t.Fatal(failure)
	}
	body, _ = json.Marshal(output)
	var second struct {
		Runs       []struct{ ID string } `json:"runs"`
		NextCursor *struct{ ID string }  `json:"nextCursor"`
	}
	_ = json.Unmarshal(body, &second)
	if len(second.Runs) != 2 || second.Runs[0].ID != runID(1) || second.Runs[1].ID != runID(0) || second.NextCursor != nil {
		t.Fatalf("second page = %s", body)
	}

	// limit 1 takes the newest run and still reports a cursor.
	output, failure = routines.History(ctx, database, actor, raw(`{"routineId":"hr-`+s.UserID+`","limit":1}`))
	if failure != nil {
		t.Fatal(failure)
	}
	body, _ = json.Marshal(output)
	if !strings.Contains(string(body), `"nextCursor":{"id":"`+runID(21)+`"`) || !strings.Contains(string(body), `"id":"`+runID(21)+`"`) {
		t.Fatalf("limit 1 = %s", body)
	}

	// Isolation, an archived bot's routine, and an unknown routine are NOT_FOUND "Not Found".
	archived := "harch-" + s.UserID
	addBotRow(t, database, archived, s.Space1, s.UserID, "Archived", new(time.Now().UTC()), nil)
	addOwnedRoutine(t, database, "harchr-"+s.UserID, s.Space1, archived, s.UserID, routineOptions{})
	for _, id := range []string{"harchr-" + s.UserID, "missing"} {
		if _, failure := routines.History(ctx, database, actor, raw(`{"routineId":"`+id+`"}`)); failureCode(failure) != "NOT_FOUND" || failure.Message != "Not Found" {
			t.Fatalf("%s = %v", id, failure)
		}
	}
	if _, failure := routines.History(ctx, database, db.Actor{UserID: s.UserID, SpaceID: s.Space2}, raw(`{"routineId":"hr-`+s.UserID+`"}`)); failureCode(failure) != "NOT_FOUND" {
		t.Fatalf("other space = %v", failure)
	}
	if _, failure := routines.History(ctx, database, actor, raw(`{"routineId":"hr-`+s.UserID+`","limit":0}`)); failureCode(failure) != "BAD_REQUEST" {
		t.Fatalf("limit 0 = %v", failure)
	}
}

func pad2(value int) string { return fmt.Sprintf("%02d", value) }

// cleanupOwnedFixture removes the Space, bots and chat rows a routines test seeds. The
// fixture database is shared with other suites, so only this case's own ids go.
func cleanupOwnedFixture(t *testing.T, database *db.DB, s seeded) {
	t.Helper()
	t.Cleanup(func() {
		exec(t, database, `DELETE FROM organization WHERE id = $1`, s.OrgID)
		exec(t, database, `DELETE FROM "user" WHERE id = $1`, s.UserID)
	})
}
