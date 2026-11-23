package integration

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/contentcrypto"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/orpc"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/mcpassignments"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/routines"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/shared"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/skills"
)

// run1Input marshals a procedure input object into the oRPC envelope value.
func run1Input(t *testing.T, value map[string]any) orpc.Input {
	t.Helper()
	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("marshal input: %v", err)
	}
	return orpc.Input{Raw: json.RawMessage(raw)}
}

// run1AddChat seeds one bot of the Space with its direct chat.
func run1AddChat(t *testing.T, database *db.DB, tag, spaceID, userID string) (string, string) {
	t.Helper()
	botID, threadID := "b-"+tag+"-"+userID, "t-"+tag+"-"+userID
	addBot(t, database, botID, spaceID, userID, "Run1 "+tag+" bot")
	exec(t, database, `INSERT INTO threads (id, "spaceId", "userId", "botId", "nextMessageSeq", "nextEventSeq", "createdAt")
		VALUES ($1, $2, $3, $4, 1, 1, now())`, threadID, spaceID, userID, botID)
	return botID, threadID
}

// run1SealCard seals one approval card the way the Prisma write hook stores a message.
func run1SealCard(t *testing.T, ring *contentcrypto.KeyRing, messageID, threadID, serverID, name, status string) (string, []int32) {
	t.Helper()
	block := map[string]any{
		"kind": "mcp_approval", "name": name, "serverId": serverID,
		"transport": "stdio", "endpoint": nil, "needsOAuth": false, "status": status,
	}
	sealed, err := ring.SealRow(context.Background(), "Message", map[string]any{
		"id": messageID, "threadId": threadID, "blocks": []any{block},
	})
	if err != nil {
		t.Fatalf("seal approval card: %v", err)
	}
	body, err := json.Marshal(sealed["blocks"])
	if err != nil {
		t.Fatalf("encode sealed blocks: %v", err)
	}
	tokens, _ := sealed["searchTokens"].([]int32)
	return string(body), tokens
}

// run1AddCardMessage inserts one bot message holding a single approval card and returns the
// stored blocks text as jsonb writes it back.
func run1AddCardMessage(t *testing.T, database *db.DB, ring *contentcrypto.KeyRing,
	messageID, threadID, botID, serverID, status string, seq int) string {
	t.Helper()
	body, tokens := run1SealCard(t, ring, messageID, threadID, serverID, "Alpha server", status)
	exec(t, database, `INSERT INTO messages (id, "threadId", "botId", seq, role, blocks, "searchTokens")
		VALUES ($1, $2, $3, $4, 'bot', $5::jsonb, $6::integer[])`,
		messageID, threadID, botID, seq, body, tokens)
	return run1BlocksText(t, database, messageID)
}

func run1BlocksText(t *testing.T, database *db.DB, messageID string) string {
	t.Helper()
	return systemScalar[string](t, database, `SELECT blocks::text FROM messages WHERE id = $1`, messageID)
}

// run1CardStatuses reads the status of every stored approval card in the blocks text.
func run1CardStatuses(t *testing.T, raw string) []string {
	t.Helper()
	var blocks []map[string]any
	if err := json.Unmarshal([]byte(raw), &blocks); err != nil {
		t.Fatalf("stored blocks = %s: %v", raw, err)
	}
	statuses := make([]string, 0, len(blocks))
	for _, block := range blocks {
		status, _ := block["status"].(string)
		statuses = append(statuses, status)
	}
	return statuses
}

// run1Row reads one row into a field-name map.
func run1Row(t *testing.T, database *db.DB, query string, args ...any) map[string]any {
	t.Helper()
	var row map[string]any
	err := database.System(context.Background(), "run1 read", func(tx pgx.Tx) error {
		rows, err := tx.Query(context.Background(), query, args...)
		if err != nil {
			return err
		}
		defer rows.Close()
		fields := rows.FieldDescriptions()
		if !rows.Next() {
			return errors.New("run1: row not found")
		}
		values, err := rows.Values()
		if err != nil {
			return err
		}
		row = map[string]any{}
		for index, field := range fields {
			row[string(field.Name)] = values[index]
		}
		return rows.Err()
	})
	if err != nil {
		t.Fatalf("run1 read: %v", err)
	}
	return row
}

// run1EventPayload reads the newest thread.message.updated event for a message and opens its
// sealed payload with the same ring that wrote it.
func run1EventPayload(t *testing.T, database *db.DB, ring *contentcrypto.KeyRing, threadID, messageID string) map[string]any {
	t.Helper()
	ctx := context.Background()
	var row map[string]any
	err := database.System(ctx, "run1 read event", func(tx pgx.Tx) error {
		var id, spaceID, foundThread, payloadText string
		err := tx.QueryRow(ctx, `SELECT id, "spaceId", "threadId", payload::text FROM events
			WHERE "threadId" = $1 AND type = 'thread.message.updated' AND payload->>'messageId' = $2`,
			threadID, messageID).Scan(&id, &spaceID, &foundThread, &payloadText)
		if err != nil {
			return err
		}
		var payload map[string]any
		if err := json.Unmarshal([]byte(payloadText), &payload); err != nil {
			return err
		}
		row = map[string]any{"id": id, "spaceId": spaceID, "threadId": foundThread, "payload": payload}
		return nil
	})
	if err != nil {
		t.Fatalf("read approval event: %v", err)
	}
	if err := ring.OpenRows(ctx, "Event", []map[string]any{row}); err != nil {
		t.Fatalf("open approval event: %v", err)
	}
	payload, ok := row["payload"].(map[string]any)
	if !ok {
		t.Fatalf("opened payload = %#v", row["payload"])
	}
	return payload
}

func run1OutputRunID(t *testing.T, output any) string {
	t.Helper()
	body, err := json.Marshal(output)
	if err != nil {
		t.Fatalf("marshal output: %v", err)
	}
	var parsed map[string]any
	if err := json.Unmarshal(body, &parsed); err != nil {
		t.Fatalf("output = %s: %v", body, err)
	}
	runID, _ := parsed["runId"].(string)
	if runID == "" {
		t.Fatalf("output = %s has no runId", body)
	}
	return runID
}

func run1RequireMillis(t *testing.T, name string, at time.Time) {
	t.Helper()
	if at.Nanosecond()%int(time.Millisecond) != 0 {
		t.Fatalf("%s = %s is not millisecond-truncated", name, at.Format(time.RFC3339Nano))
	}
}

func run1TaskPrompt(t *testing.T, database *db.DB, runID string) string {
	t.Helper()
	return systemScalar[string](t, database, `SELECT t.prompt FROM tasks t
		JOIN runs r ON r."taskId" = t.id WHERE r.id = $1`, runID)
}

func TestApprovePaintsApprovalCardsInTheTransaction(t *testing.T) {
	database := openTestDB(t)
	s := seed(t, database)
	cleanupOwnedFixture(t, database, s)
	ring := keyedRing(t, database)
	ctx := context.Background()
	actor := db.Actor{UserID: s.UserID, SpaceID: s.Space1}
	// The server is the member's own and available in every Space, so both surfaces see it.
	exec(t, database, `UPDATE mcp_servers SET "allSpaces" = true, enabled = true WHERE id = $1`, s.ServerID)

	// The settings surface names no thread: every open or dismissed card of the bot's chats is
	// painted, the assignment is created, and no turn is queued.
	botID, threadID := run1AddChat(t, database, "settings", s.Space1, s.UserID)
	pendingID, connectedID := "m-settings-pending-"+s.UserID, "m-settings-connected-"+s.UserID
	if got := run1CardStatuses(t, run1AddCardMessage(t, database, ring, pendingID, threadID, botID, s.ServerID, "pending", 1)); len(got) != 1 || got[0] != "pending" {
		t.Fatalf("seeded pending card = %v", got)
	}
	connectedBefore := run1AddCardMessage(t, database, ring, connectedID, threadID, botID, s.ServerID, "connected", 2)

	result, failure := mcpassignments.Approve(ctx, database, shared.Deployment{Content: ring}, nil, actor,
		run1Input(t, map[string]any{"botId": botID, "serverId": s.ServerID}))
	if failure != nil {
		t.Fatalf("settings approve: %v", failure)
	}
	if result == nil {
		t.Fatal("settings approve returned no assignment")
	}
	assignment := run1Row(t, database, `SELECT "allowAllTools", "allowedTools"::text AS tools
		FROM bot_mcp_servers WHERE "botId" = $1 AND "serverId" = $2`, botID, s.ServerID)
	if allowed, _ := assignment["allowAllTools"].(bool); !allowed {
		t.Fatalf("allowAllTools = %#v", assignment["allowAllTools"])
	}
	if tools, _ := assignment["tools"].(string); tools != "[]" {
		t.Fatalf("allowedTools = %q, want []", tools)
	}
	if got := run1CardStatuses(t, run1BlocksText(t, database, pendingID)); len(got) != 1 || got[0] != "connected" {
		t.Fatalf("pending card after approve = %v, want connected", got)
	}
	if after := run1BlocksText(t, database, connectedID); after != connectedBefore {
		t.Fatalf("connected card changed:\nbefore %s\nafter  %s", connectedBefore, after)
	}
	payload := run1EventPayload(t, database, ring, threadID, pendingID)
	if payload["messageId"] != pendingID || payload["role"] != "bot" {
		t.Fatalf("event payload = %#v", payload)
	}
	blocks, ok := payload["blocks"].([]any)
	if !ok || len(blocks) != 1 {
		t.Fatalf("event blocks = %#v", payload["blocks"])
	}
	block, _ := blocks[0].(map[string]any)
	if block["status"] != "connected" || block["serverId"] != s.ServerID {
		t.Fatalf("event block = %#v", block)
	}
	if n := systemScalar[int](t, database, `SELECT count(*)::int FROM events
		WHERE "threadId" = $1 AND type = 'thread.message.updated'`, threadID); n != 1 {
		t.Fatalf("events = %d, want 1", n)
	}
	if n := systemScalar[int](t, database, `SELECT count(*)::int FROM tasks WHERE "threadId" = $1`, threadID); n != 0 {
		t.Fatalf("settings approve created %d tasks", n)
	}
	if n := systemScalar[int](t, database, `SELECT count(*)::int FROM runs WHERE "threadId" = $1`, threadID); n != 0 {
		t.Fatalf("settings approve created %d runs", n)
	}

	// A dismissal that already won the card refuses the chat-scoped approve with IsolationError
	// and writes neither the assignment nor an event.
	dismissedBot, dismissedThread := run1AddChat(t, database, "dismissed", s.Space1, s.UserID)
	dismissedID := "m-dismissed-" + s.UserID
	dismissedBefore := run1AddCardMessage(t, database, ring, dismissedID, dismissedThread, dismissedBot, s.ServerID, "dismissed", 1)
	_, failure = mcpassignments.Approve(ctx, database, shared.Deployment{Content: ring}, nil, actor,
		run1Input(t, map[string]any{"botId": dismissedBot, "serverId": s.ServerID, "threadId": dismissedThread}))
	if failure == nil || failure.Code != "NOT_FOUND" {
		t.Fatalf("dismissed approve = %v, want NOT_FOUND", failure)
	}
	if n := systemScalar[int](t, database, `SELECT count(*)::int FROM bot_mcp_servers
		WHERE "botId" = $1 AND "serverId" = $2`, dismissedBot, s.ServerID); n != 0 {
		t.Fatalf("dismissed approve created %d assignments", n)
	}
	if n := systemScalar[int](t, database, `SELECT count(*)::int FROM events WHERE "threadId" = $1`, dismissedThread); n != 0 {
		t.Fatalf("dismissed approve created %d events", n)
	}
	if after := run1BlocksText(t, database, dismissedID); after != dismissedBefore {
		t.Fatalf("dismissed card changed:\nbefore %s\nafter  %s", dismissedBefore, after)
	}
	if n := systemScalar[int](t, database, `SELECT count(*)::int FROM tasks WHERE "threadId" = $1`, dismissedThread); n != 0 {
		t.Fatalf("dismissed approve created %d tasks", n)
	}
	if n := systemScalar[int](t, database, `SELECT count(*)::int FROM runs WHERE "threadId" = $1`, dismissedThread); n != 0 {
		t.Fatalf("dismissed approve created %d runs", n)
	}

	// An open card answered in its own chat assigns the server and queues the hidden
	// continuation turn for that chat.
	chatBot, chatThread := run1AddChat(t, database, "chat", s.Space1, s.UserID)
	chatCardID := "m-chat-" + s.UserID
	run1AddCardMessage(t, database, ring, chatCardID, chatThread, chatBot, s.ServerID, "pending", 1)
	result, failure = mcpassignments.Approve(ctx, database, shared.Deployment{Content: ring}, nil, actor,
		run1Input(t, map[string]any{"botId": chatBot, "serverId": s.ServerID, "threadId": chatThread}))
	if failure != nil {
		t.Fatalf("chat approve: %v", failure)
	}
	if result == nil {
		t.Fatal("chat approve returned no assignment")
	}
	if n := systemScalar[int](t, database, `SELECT count(*)::int FROM bot_mcp_servers
		WHERE "botId" = $1 AND "serverId" = $2`, chatBot, s.ServerID); n != 1 {
		t.Fatalf("chat approve assignments = %d, want 1", n)
	}
	if got := run1CardStatuses(t, run1BlocksText(t, database, chatCardID)); len(got) != 1 || got[0] != "connected" {
		t.Fatalf("chat card after approve = %v, want connected", got)
	}
	run1EventPayload(t, database, ring, chatThread, chatCardID)
	if n := systemScalar[int](t, database, `SELECT count(*)::int FROM runs WHERE "threadId" = $1`, chatThread); n != 1 {
		t.Fatalf("chat approve runs = %d, want 1", n)
	}
	if n := systemScalar[int](t, database, `SELECT count(*)::int FROM tasks WHERE "threadId" = $1`, chatThread); n != 1 {
		t.Fatalf("chat approve tasks = %d, want 1", n)
	}
	run := run1Row(t, database, `SELECT id, status, trigger, "wakeAt", "createdAt", "updatedAt"
		FROM runs WHERE "threadId" = $1`, chatThread)
	if run["status"] != "queued" || run["trigger"] != "user" {
		t.Fatalf("queued run = status %#v trigger %#v", run["status"], run["trigger"])
	}
	wakeAt, ok := run["wakeAt"].(time.Time)
	if !ok {
		t.Fatalf("wakeAt = %#v, want a timestamp", run["wakeAt"])
	}
	run1RequireMillis(t, "run.wakeAt", wakeAt)
	run1RequireMillis(t, "run.createdAt", run["createdAt"].(time.Time))
	run1RequireMillis(t, "run.updatedAt", run["updatedAt"].(time.Time))
	runID, _ := run["id"].(string)
	if prompt := run1TaskPrompt(t, database, runID); !strings.Contains(prompt, "Alpha server") {
		t.Fatalf("continuation prompt = %q, want the server name", prompt)
	}
	task := run1Row(t, database, `SELECT status, prompt FROM tasks WHERE "threadId" = $1`, chatThread)
	if task["status"] != "queued" {
		t.Fatalf("task status = %#v", task["status"])
	}
}

func TestRoutineAndSkillTestRunsWriteTheExpectedRows(t *testing.T) {
	database := openTestDB(t)
	s := seed(t, database)
	cleanupOwnedFixture(t, database, s)
	ring := keyedRing(t, database)
	ctx := context.Background()
	actor := db.Actor{UserID: s.UserID, SpaceID: s.Space1}

	// routines.testRun pins the run to the routine's model and replays the same clientNonce.
	botID, threadID := run1AddChat(t, database, "routine", s.Space1, s.UserID)
	routineID := "ro-" + s.UserID
	exec(t, database, `INSERT INTO routines (id, "spaceId", "botId", "userId", name, prompt, crons,
		"modelProvider", "modelId", "thinkingLevel", "updatedAt")
		VALUES ($1, $2, $3, $4, 'Inbox routine', 'Summarize the inbox', '{}'::text[], $5, $6, $7, now())`,
		routineID, s.Space1, botID, s.UserID, "openai", "gpt-5.3", "high")
	nonce := "nonce-" + s.UserID
	raw := run1Input(t, map[string]any{"routineId": routineID, "clientNonce": nonce})
	output, failure := routines.TestRun(ctx, database, shared.Deployment{}, actor, raw)
	if failure != nil {
		t.Fatalf("routine test run: %v", failure)
	}
	runID := run1OutputRunID(t, output)
	if n := systemScalar[int](t, database, `SELECT count(*)::int FROM runs WHERE "threadId" = $1`, threadID); n != 1 {
		t.Fatalf("routine runs = %d, want 1", n)
	}
	if n := systemScalar[int](t, database, `SELECT count(*)::int FROM tasks WHERE "threadId" = $1`, threadID); n != 1 {
		t.Fatalf("routine tasks = %d, want 1", n)
	}
	run := run1Row(t, database, `SELECT id, "taskId", status, trigger, "routineId", "clientNonce",
		"modelProvider", "modelId", "thinkingLevel", "modelPinned", "wakeAt", "createdAt", "updatedAt"
		FROM runs WHERE id = $1`, runID)
	if run["status"] != "queued" || run["trigger"] != "routine" || run["routineId"] != routineID {
		t.Fatalf("routine run = status %#v trigger %#v routine %#v", run["status"], run["trigger"], run["routineId"])
	}
	if pinned, _ := run["modelPinned"].(bool); !pinned {
		t.Fatalf("modelPinned = %#v", run["modelPinned"])
	}
	if run["modelProvider"] != "openai" || run["modelId"] != "gpt-5.3" || run["thinkingLevel"] != "high" {
		t.Fatalf("model pin = %#v/%#v/%#v", run["modelProvider"], run["modelId"], run["thinkingLevel"])
	}
	wantNonce := "routine-run:" + s.UserID + ":" + nonce
	if run["clientNonce"] != wantNonce {
		t.Fatalf("clientNonce = %#v, want %q", run["clientNonce"], wantNonce)
	}
	wakeAt, ok := run["wakeAt"].(time.Time)
	if !ok {
		t.Fatalf("routine wakeAt = %#v, want a timestamp", run["wakeAt"])
	}
	run1RequireMillis(t, "routine run.wakeAt", wakeAt)
	run1RequireMillis(t, "routine run.createdAt", run["createdAt"].(time.Time))
	run1RequireMillis(t, "routine run.updatedAt", run["updatedAt"].(time.Time))
	if prompt := run1TaskPrompt(t, database, runID); prompt != "Summarize the inbox" {
		t.Fatalf("routine task prompt = %q", prompt)
	}
	// The same submission answers with the same run and writes nothing new.
	replay, failure := routines.TestRun(ctx, database, shared.Deployment{}, actor, raw)
	if failure != nil {
		t.Fatalf("routine replay: %v", failure)
	}
	if again := run1OutputRunID(t, replay); again != runID {
		t.Fatalf("routine replay runId = %q, want %q", again, runID)
	}
	if n := systemScalar[int](t, database, `SELECT count(*)::int FROM runs WHERE "threadId" = $1`, threadID); n != 1 {
		t.Fatalf("routine replay runs = %d, want 1", n)
	}
	if n := systemScalar[int](t, database, `SELECT count(*)::int FROM tasks WHERE "threadId" = $1`, threadID); n != 1 {
		t.Fatalf("routine replay tasks = %d, want 1", n)
	}

	// skills.testRun without a prompt renders the saved playbook as the safe test prompt; an
	// explicit empty string is the prompt itself.
	skillBot, skillThread := run1AddChat(t, database, "skill", s.Space1, s.UserID)
	skillID := "ts-" + s.UserID
	playbook := `{"whenToUse":"when mail piles up","inputs":["inbox"],"steps":["open inbox","archive"],` +
		`"howToCheck":"inbox empty","whatToReturn":"a summary","approvalBoundaries":"ask first",` +
		`"failureHandling":"report"}`
	exec(t, database, `INSERT INTO taught_skills (id, "spaceId", "botId", "userId", name, goal, status, playbook, "updatedAt")
		VALUES ($1, $2, $3, $4, 'Tidy inbox', 'Keep the inbox empty', 'saved', $5::jsonb, now())`,
		skillID, s.Space1, skillBot, s.UserID, playbook)
	output, failure = skills.TestRun(ctx, database, shared.Deployment{Content: ring}, nil, actor,
		run1Input(t, map[string]any{"skillId": skillID}))
	if failure != nil {
		t.Fatalf("skill test run: %v", failure)
	}
	firstRun := run1OutputRunID(t, output)
	expected := strings.Join([]string{
		"Run taught skill: Tidy inbox",
		"This is a safe test run. Do not send, spend, delete, or publish anything.",
		"When to use: when mail piles up",
		"Inputs: inbox",
		"Steps:",
		"1. open inbox",
		"2. archive",
		"How to check: inbox empty",
		"Return: a summary",
		"Approval boundaries: ask first",
		"Failure handling: report",
	}, "\n")
	if prompt := run1TaskPrompt(t, database, firstRun); prompt != expected {
		t.Fatalf("skill task prompt =\n%q\nwant\n%q", prompt, expected)
	}
	output, failure = skills.TestRun(ctx, database, shared.Deployment{Content: ring}, nil, actor,
		run1Input(t, map[string]any{"skillId": skillID, "prompt": ""}))
	if failure != nil {
		t.Fatalf("skill empty prompt run: %v", failure)
	}
	secondRun := run1OutputRunID(t, output)
	if secondRun == firstRun {
		t.Fatalf("empty prompt reused run %q", firstRun)
	}
	if prompt := run1TaskPrompt(t, database, secondRun); prompt != "" {
		t.Fatalf("skill empty prompt task prompt = %q, want \"\"", prompt)
	}
	if n := systemScalar[int](t, database, `SELECT count(*)::int FROM tasks WHERE "threadId" = $1`, skillThread); n != 2 {
		t.Fatalf("skill tasks = %d, want 2", n)
	}
	if n := systemScalar[int](t, database, `SELECT count(*)::int FROM runs
		WHERE "threadId" = $1 AND trigger = 'skill'`, skillThread); n != 2 {
		t.Fatalf("skill runs = %d, want 2", n)
	}
}
