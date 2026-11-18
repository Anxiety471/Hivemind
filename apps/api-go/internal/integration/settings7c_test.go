package integration

import (
	"context"
	"strings"
	"testing"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/capabilities"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/computer"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/connections"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/mcpassignments"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/models"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/usage"
)

func addConnection(t *testing.T, database *db.DB, id, spaceID, userID, status string, offset int) {
	t.Helper()
	exec(t, database, `INSERT INTO connections (id, "spaceId", "userId", provider, "displayName", status, "connectorId", "createdAt")
		VALUES ($1, $2, $3, 'github', $4, $5, 'managed', now() + ($6 || ' seconds')::interval)`,
		id, spaceID, userID, "Connection "+id, status, offset)
}

// connections.list returns the member's rows with the capabilities list empty, and rename
// rewrites the name (NUL replaced) and the change time, or 404s outside the Space.
func TestConnectionsListAndRename(t *testing.T) {
	database := openTestDB(t)
	s := seed(t, database)
	actor := db.Actor{UserID: s.UserID, SpaceID: s.Space1}
	addConnection(t, database, "c1-"+s.UserID, s.Space1, s.UserID, "connected", 0)
	addConnection(t, database, "c2-"+s.UserID, s.Space1, s.UserID, "pending", 1)
	addConnection(t, database, "co-"+s.UserID, s.Space1, s.User2ID, "connected", 2)
	addConnection(t, database, "cx-"+s.UserID, s.Space2, s.UserID, "connected", 3)
	list, failure := connections.List(context.Background(), database, actor)
	if failure != nil {
		t.Fatal(failure)
	}
	if len(list) != 2 || list[0].Capabilities == nil || list[0].Status != "connected" {
		t.Fatalf("list = %+v", list)
	}
	renamed, failure := connections.Rename(context.Background(), database, actor, raw(`{"connectionId":"c1-`+s.UserID+`","displayName":"  a\u0000b \t"}`))
	if failure != nil {
		t.Fatal(failure)
	}
	if renamed.(connections.Connection).DisplayName != "a\uFFFDb" {
		t.Fatalf("name = %q", renamed.(connections.Connection).DisplayName)
	}
	if moved := systemScalar[bool](t, database, `SELECT "updatedAt" > "createdAt" FROM connections WHERE id = $1`, "c1-"+s.UserID); !moved {
		t.Fatal("updatedAt did not move")
	}
	if _, failure := connections.Rename(context.Background(), database, actor, raw(`{"connectionId":"co-`+s.UserID+`","displayName":"x"}`)); failure == nil || failure.Code != "NOT_FOUND" {
		t.Fatalf("another member's connection = %v", failure)
	}
	// A stored status outside the schema's enum fails the call, as the router's output parse does.
	addConnection(t, database, "cz-"+s.UserID, s.Space1, s.UserID, "weird", 4)
	if _, failure := connections.List(context.Background(), database, actor); failure == nil || failure.Message != "Output validation failed" {
		t.Fatalf("odd status = %v", failure)
	}
}

// A stored config that is not an object reads as {}, and the secret is never read.
func TestCapabilitiesConfigFallbackAndAvailability(t *testing.T) {
	database := openTestDB(t)
	s := seed(t, database)
	actor := db.Actor{UserID: s.UserID, SpaceID: s.Space1}
	exec(t, database, `INSERT INTO capability_installs (id, "spaceId", "userId", kind, name, source, config, "createdAt")
		VALUES ($1, $2, $3, 'plugin', 'Odd config', 'https://x.test', $4::jsonb, now())`,
		"k1-"+s.UserID, s.Space2, s.UserID, `"[1, 2]"`)
	exec(t, database, `INSERT INTO capability_installs (id, "spaceId", "userId", kind, name, source, config, "secretId", "createdAt")
		VALUES ($1, $2, $3, 'mcp', 'With secret', 'https://y.test', '{}'::jsonb, 'secret-id', now())`,
		"k2-"+s.UserID, s.Space2, s.UserID)
	exec(t, database, `INSERT INTO capability_install_spaces ("installId", "spaceId", "userId") VALUES ($1, $2, $3)`,
		"k2-"+s.UserID, s.Space1, s.UserID)
	installs, failure := capabilities.List(context.Background(), database, actor, nil)
	if failure != nil {
		t.Fatal(failure)
	}
	if len(installs) != 1 {
		t.Fatalf("installs = %+v", installs)
	}
	found := installs[0]
	if string(found.Config) != "{}" || !found.SecretConfigured || found.Availability.AllSpaces ||
		found.Availability.SpaceIDs[0] != s.Space2 || len(found.Availability.SpaceIDs) != 2 {
		t.Fatalf("install = %+v", found)
	}
}

// usage.summary: a total is null when any counted call lacks the figure, a subagent's run
// counts as its parent's, and rows of other members or Spaces are not counted.
func TestUsageSummaryTotalsAndRuns(t *testing.T) {
	database := openTestDB(t)
	s := seed(t, database)
	actor := db.Actor{UserID: s.UserID, SpaceID: s.Space1}
	record := func(id, spaceID, userID string, tokens *int32, cost *float64, runID, parentRunID *string) {
		t.Helper()
		exec(t, database, `INSERT INTO usage_records (id, "spaceId", "userId", provider, model, "inputTokens", "totalTokens", "costUsd", "runId", "parentRunId")
			VALUES ($1, $2, $3, 'openai', 'gpt-a', $4, $5, $6, $7, $8)`,
			id, spaceID, userID, tokens, tokens, cost, runID, parentRunID)
	}
	record("u1-"+s.UserID, s.Space1, s.UserID, new(int32(10)), new(0.25), new("r1-"+s.UserID), nil)
	record("u2-"+s.UserID, s.Space1, s.UserID, new(int32(20)), nil, new("r2-"+s.UserID), nil)
	record("u3-"+s.UserID, s.Space1, s.UserID, nil, nil, new("r3-"+s.UserID), new("r1-"+s.UserID))
	record("u4-"+s.UserID, s.Space1, s.User2ID, new(int32(999)), nil, new("r4-"+s.UserID), nil)
	record("u5-"+s.UserID, s.Space2, s.UserID, new(int32(888)), nil, new("r5-"+s.UserID), nil)
	summary, failure := usage.SummaryOf(context.Background(), database, actor)
	if failure != nil {
		t.Fatal(failure)
	}
	result := summary.(usage.Summary)
	// totalTokens is null (u3 lacks it); the input figure is complete over three rows.
	if result.TotalTokens != nil {
		t.Fatalf("totalTokens = %v", result.TotalTokens)
	}
	if result.InputTokens == nil || *result.InputTokens != 30 || result.CostUSD == nil || *result.CostUSD != 0.25 {
		t.Fatalf("totals = %+v", result.Totals)
	}
	if result.ModelCalls != 3 || result.Runs != 2 { // r1 (with r3 folded in) and r2
		t.Fatalf("calls = %d runs = %d", result.ModelCalls, result.Runs)
	}
	if len(result.Models) != 1 || result.Models[0].ModelCalls != 3 {
		t.Fatalf("models = %+v", result.Models)
	}
}

// A computer update whose stored action or stage the schema refuses fails the call.
func TestComputerUpdatesRejectASchemaBreakingRow(t *testing.T) {
	database := openTestDB(t)
	s := seed(t, database)
	actor := db.Actor{UserID: s.UserID, SpaceID: s.Space1}
	exec(t, database, `INSERT INTO computers (id, "spaceId", "userId", kind, scope, "scopeKey", "homeKey") VALUES ($1, $2, $3, 'local', 'team', $4, $5)`,
		"cp-"+s.UserID, s.Space1, s.UserID, "sk-"+s.UserID, "hk-"+s.UserID)
	addBot(t, database, "cb-"+s.UserID, s.Space1, s.UserID, "Bot")
	exec(t, database, `UPDATE bots SET "computerId" = $1 WHERE id = $2`, "cp-"+s.UserID, "cb-"+s.UserID)
	update := func(id, action, status, stage string) {
		t.Helper()
		exec(t, database, `INSERT INTO computer_updates (id, "computerId", "botId", action, status, stage) VALUES ($1, $2, $3, $4, $5, $6)`,
			id, "cp-"+s.UserID, "cb-"+s.UserID, action, status, stage)
	}
	update("up1-"+s.UserID, "update", "queued", "preparing")
	updates, failure := computer.Updates(context.Background(), database, actor)
	if failure != nil || len(updates) != 1 || updates[0].Name != "Bot" || updates[0].Mode != "team" {
		t.Fatalf("updates = %+v %v", updates, failure)
	}
	update("up2-"+s.UserID, "reinstall", "queued", "preparing")
	if _, failure := computer.Updates(context.Background(), database, actor); failure == nil || failure.Message != "Output validation failed" {
		t.Fatalf("bad action = %v", failure)
	}
}

// allowedTools keeps only strings, and one outside the schema's bounds fails the call.
func TestMcpAssignmentsReadAllowedTools(t *testing.T) {
	database := openTestDB(t)
	s := seed(t, database)
	actor := db.Actor{UserID: s.UserID, SpaceID: s.Space1}
	exec(t, database, `INSERT INTO mcp_servers (id, "spaceId", "userId", slug, name, transport, command) VALUES ($1, $2, $3, 'm', 'Server', 'stdio', 'true')`,
		"m1-"+s.UserID, s.Space1, s.UserID)
	addBot(t, database, "mb-"+s.UserID, s.Space1, s.UserID, "Bot")
	assign := func(id, tools string) {
		t.Helper()
		exec(t, database, `INSERT INTO bot_mcp_servers (id, "spaceId", "userId", "botId", "serverId", "allowAllTools", "allowedTools") VALUES ($1, $2, $3, $4, $5, false, $6::jsonb)`,
			id, s.Space1, s.UserID, "mb-"+s.UserID, "m1-"+s.UserID, tools)
	}
	assign("a1-"+s.UserID, `["read", 1, null, {"x":1}]`)
	found, failure := mcpassignments.List(context.Background(), database, actor, raw(`{"botId":"mb-`+s.UserID+`"}`))
	if failure != nil || len(found) != 1 || strings.Join(found[0].AllowedTools, ",") != "read" {
		t.Fatalf("assignments = %+v %v", found, failure)
	}
	assign("a2-"+s.UserID, `["ok", "x"]`)
	if _, failure := mcpassignments.List(context.Background(), database, actor, raw(`{"botId":"mb-`+s.UserID+`"}`)); failure == nil || failure.Message != "Output validation failed" {
		t.Fatalf("short tool name = %v", failure)
	}
	if _, failure := mcpassignments.List(context.Background(), database, actor, raw(`{"botId":"nope"}`)); failure == nil || failure.Code != "NOT_FOUND" {
		t.Fatalf("unknown bot = %v", failure)
	}
}

// models.backups returns the account's fallback models trimmed; a blank one fails the call.
func TestModelBackupsAreTrimmedAndValidated(t *testing.T) {
	database := openTestDB(t)
	s := seed(t, database)
	actor := db.Actor{UserID: s.UserID, SpaceID: s.Space1}
	choice := func(position int, provider, model string) {
		t.Helper()
		exec(t, database, `INSERT INTO user_model_role_choices ("userId", role, "position", provider, "modelId") VALUES ($1, 'main', $2, $3, $4)`,
			s.UserID, position, provider, model)
	}
	choice(0, "openai", "gpt-a")
	choice(1, " openai\t", " gpt-b ")
	backups, failure := models.Backups(context.Background(), database, actor)
	if failure != nil {
		t.Fatal(failure)
	}
	if len(backups) != 1 || backups[0].Provider != "openai" || backups[0].ModelID != "gpt-b" {
		t.Fatalf("backups = %+v", backups)
	}
	choice(2, "  ", "m")
	if _, failure := models.Backups(context.Background(), database, actor); failure == nil || failure.Message != "Output validation failed" {
		t.Fatalf("blank provider = %v", failure)
	}
}
