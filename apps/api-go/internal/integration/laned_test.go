package integration

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/agentskills"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/bots"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/groups"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/shared"
)

func addBotRow(t *testing.T, database *db.DB, id, spaceID, userID, name string, archivedAt *time.Time, computerID *string) {
	t.Helper()
	exec(t, database, `INSERT INTO bots (id, "spaceId", "userId", name, color, "archivedAt", "computerId", "createdAt", "updatedAt")
		VALUES ($1, $2, $3, $4, 'blue', $5, $6, now(), now())`, id, spaceID, userID, name, archivedAt, computerID)
}

func addComputerRow(t *testing.T, database *db.DB, id, spaceID, userID string) {
	t.Helper()
	exec(t, database, `INSERT INTO computers (id, "spaceId", "userId", scope, "scopeKey", "homeKey", kind, "createdAt", "updatedAt")
		VALUES ($1, $2, $3, 'team', $4, $5, 'linux', now(), now())`, id, spaceID, userID, "scope-"+id, "home-"+id)
}

func addGroupRow(t *testing.T, database *db.DB, id, spaceID, userID, name string, archivedAt *time.Time) {
	t.Helper()
	exec(t, database, `INSERT INTO chat_groups (id, "spaceId", "userId", name, "archivedAt", "createdAt", "updatedAt")
		VALUES ($1, $2, $3, $4, $5, now(), now())`, id, spaceID, userID, name, archivedAt)
}

func addGroupMemberRow(t *testing.T, database *db.DB, id, groupID, botID string, createdAt time.Time) {
	t.Helper()
	exec(t, database, `INSERT INTO chat_group_members (id, "groupId", "botId", "createdAt") VALUES ($1, $2, $3, $4)`,
		id, groupID, botID, createdAt)
}

func archivedAt(t *testing.T) *time.Time {
	t.Helper()
	value := time.Now().Add(-time.Hour).UTC()
	return &value
}

// A restore takes the per-user computer quota lock: with one slot left, two restores on
// distinct computers leave exactly one bot live and tell the other caller the limit.
func TestRestoreBotUnderComputerQuotaSerializes(t *testing.T) {
	database := openTestDB(t)
	s := seed(t, database)
	actor := db.Actor{UserID: s.UserID, SpaceID: s.Space1}
	deployment := shared.Deployment{MaxComputersPerUser: "1"}
	ctx := context.Background()
	first, second := "b1-"+s.UserID, "b2-"+s.UserID
	addComputerRow(t, database, "c1-"+s.UserID, s.Space1, s.UserID)
	addComputerRow(t, database, "c2-"+s.UserID, s.Space1, s.UserID)
	computerOne, computerTwo := "c1-"+s.UserID, "c2-"+s.UserID
	addBotRow(t, database, first, s.Space1, s.UserID, "First", archivedAt(t), &computerOne)
	addBotRow(t, database, second, s.Space1, s.UserID, "Second", archivedAt(t), &computerTwo)

	codes := make([]string, 2)
	var wait sync.WaitGroup
	for index, botID := range []string{first, second} {
		wait.Add(1)
		go func(index int, botID string) {
			defer wait.Done()
			_, failure := bots.Restore(ctx, database, actor, deployment, raw(`{"botId":"`+botID+`"}`))
			if failure != nil {
				codes[index] = failure.Code + ": " + failure.Message
			}
		}(index, botID)
	}
	wait.Wait()
	succeeded := 0
	for _, code := range codes {
		switch code {
		case "":
			succeeded++
		case "BAD_REQUEST: User computer limit (1) reached":
		default:
			t.Fatalf("unexpected result %q", code)
		}
	}
	if succeeded != 1 {
		t.Fatalf("results = %q, want exactly one success", codes)
	}
	live := systemScalar[int](t, database, `SELECT count(*) FROM bots WHERE id = ANY($1) AND "archivedAt" IS NULL`, []string{first, second})
	if live != 1 {
		t.Fatalf("live bots = %d, want 1", live)
	}
}

// A group restore is all-or-nothing: a member bot that does not fit the quota leaves the
// earlier members and the group archived.
func TestGroupRestoreRollsBackWhenAQuotaFails(t *testing.T) {
	database := openTestDB(t)
	s := seed(t, database)
	actor := db.Actor{UserID: s.UserID, SpaceID: s.Space1}
	ctx := context.Background()
	deployment := shared.Deployment{MaxComputersPerUser: "1"}
	// Two computers already backed by live bots fill the quota.
	for index := range 2 {
		computer := "c-used" + string(rune('a'+index)) + "-" + s.UserID
		bot := "b-used" + string(rune('a'+index)) + "-" + s.UserID
		addComputerRow(t, database, computer, s.Space1, s.UserID)
		addBotRow(t, database, bot, s.Space1, s.UserID, "Used "+bot, nil, &computer)
	}
	// The group's first member has no computer; the second needs a third one.
	free := "b-free-" + s.UserID
	newComputer := "c-new-" + s.UserID
	addComputerRow(t, database, newComputer, s.Space1, s.UserID)
	addBotRow(t, database, free, s.Space1, s.UserID, "Free", archivedAt(t), nil)
	addBotRow(t, database, "b-late-"+s.UserID, s.Space1, s.UserID, "Late", archivedAt(t), &newComputer)
	group := "g-" + s.UserID
	addGroupRow(t, database, group, s.Space1, s.UserID, "Archived group", archivedAt(t))
	addGroupMemberRow(t, database, "gm1-"+s.UserID, group, free, time.Now().Add(-2*time.Hour))
	addGroupMemberRow(t, database, "gm2-"+s.UserID, group, "b-late-"+s.UserID, time.Now().Add(-time.Hour))

	_, failure := groups.Restore(ctx, database, actor, deployment, raw(`{"groupId":"`+group+`"}`))
	if failure == nil || failure.Code != "BAD_REQUEST" {
		t.Fatalf("failure = %+v", failure)
	}
	if archived := systemScalar[int](t, database, `SELECT count(*) FROM bots WHERE id = ANY($1) AND "archivedAt" IS NOT NULL`, []string{free, "b-late-" + s.UserID}); archived != 2 {
		t.Fatalf("archived member bots = %d, want the transaction rolled back", archived)
	}
	if stillArchived := systemScalar[bool](t, database, `SELECT "archivedAt" IS NOT NULL FROM chat_groups WHERE id = $1`, group); !stillArchived {
		t.Fatal("the group must stay archived")
	}
}

// Without a quota problem the group restore unarchives every archived member and the
// group itself.
func TestGroupRestoreUnarchivesMembers(t *testing.T) {
	database := openTestDB(t)
	s := seed(t, database)
	actor := db.Actor{UserID: s.UserID, SpaceID: s.Space1}
	ctx := context.Background()
	group := "g-" + s.UserID
	addGroupRow(t, database, group, s.Space1, s.UserID, "Archived group", archivedAt(t))
	for _, suffix := range []string{"a", "b"} {
		botID := "b-" + suffix + "-" + s.UserID
		addBotRow(t, database, botID, s.Space1, s.UserID, "Bot "+suffix, archivedAt(t), nil)
		addGroupMemberRow(t, database, "gm-"+suffix+"-"+s.UserID, group, botID, time.Now())
	}
	if _, failure := groups.Restore(ctx, database, actor, shared.Deployment{}, raw(`{"groupId":"`+group+`"}`)); failure != nil {
		t.Fatal(failure)
	}
	if archived := systemScalar[int](t, database, `SELECT count(*) FROM bots WHERE "id" = ANY($1) AND "archivedAt" IS NOT NULL`, []string{"b-a-" + s.UserID, "b-b-" + s.UserID}); archived != 0 {
		t.Fatalf("archived bots = %d", archived)
	}
	if stillArchived := systemScalar[bool](t, database, `SELECT "archivedAt" IS NOT NULL FROM chat_groups WHERE id = $1`, group); stillArchived {
		t.Fatal("the group must be live")
	}
}

// Two claims racing for one bot leave exactly one address and tell the other caller the
// bot already has one.
func TestClaimEmailAddressRace(t *testing.T) {
	database := openTestDB(t)
	s := seed(t, database)
	actor := db.Actor{UserID: s.UserID, SpaceID: s.Space1}
	ctx := context.Background()
	deployment := shared.Deployment{InboundEmailDomain: "bots.example.test"}
	botID := "b-" + s.UserID
	addBotRow(t, database, botID, s.Space1, s.UserID, "Mail bot", nil, nil)
	names := []string{"first-" + s.UserID, "second-" + s.UserID}
	codes := make([]string, len(names))
	var wait sync.WaitGroup
	for index, name := range names {
		wait.Add(1)
		go func(index int, name string) {
			defer wait.Done()
			_, failure := bots.ClaimEmailAddress(ctx, database, actor, deployment, raw(`{"botId":"`+botID+`","name":"`+name+`"}`))
			if failure != nil {
				codes[index] = failure.Code + ": " + failure.Message
			}
		}(index, name)
	}
	wait.Wait()
	claimed := 0
	for _, code := range codes {
		switch code {
		case "":
			claimed++
		case "CONFLICT: This bot already has an address.":
		default:
			t.Fatalf("unexpected result %q", code)
		}
	}
	if claimed != 1 {
		t.Fatalf("results = %q, want exactly one claim", codes)
	}
	rows := systemScalar[int](t, database, `SELECT count(*) FROM bot_email_addresses WHERE "botId" = $1`, botID)
	if rows != 1 {
		t.Fatalf("addresses = %d, want 1", rows)
	}
}

// Two bots racing for one name leave the name with one of them.
func TestClaimEmailNameRace(t *testing.T) {
	database := openTestDB(t)
	s := seed(t, database)
	actor := db.Actor{UserID: s.UserID, SpaceID: s.Space1}
	ctx := context.Background()
	deployment := shared.Deployment{InboundEmailDomain: "bots.example.test"}
	botsIDs := []string{"b1-" + s.UserID, "b2-" + s.UserID}
	for _, botID := range botsIDs {
		addBotRow(t, database, botID, s.Space1, s.UserID, "Mail "+botID, nil, nil)
	}
	contested := "contested-" + s.UserID
	codes := make([]string, len(botsIDs))
	var wait sync.WaitGroup
	for index, botID := range botsIDs {
		wait.Add(1)
		go func(index int, botID string) {
			defer wait.Done()
			_, failure := bots.ClaimEmailAddress(ctx, database, actor, deployment, raw(`{"botId":"`+botID+`","name":"`+contested+`"}`))
			if failure != nil {
				codes[index] = failure.Code + ": " + failure.Message
			}
		}(index, botID)
	}
	wait.Wait()
	claimed := 0
	for _, code := range codes {
		switch code {
		case "":
			claimed++
		case "CONFLICT: That address isn't available":
		default:
			t.Fatalf("unexpected result %q", code)
		}
	}
	if claimed != 1 {
		t.Fatalf("results = %q, want exactly one claim", codes)
	}
	rows := systemScalar[int](t, database, `SELECT count(*) FROM bot_email_addresses WHERE name = $1`, contested)
	if rows != 1 {
		t.Fatalf("addresses = %d, want 1", rows)
	}
}

// Removing a skill deletes its Space rows with it.
func TestAgentSkillRemoveCascadesAvailability(t *testing.T) {
	database := openTestDB(t)
	s := seed(t, database)
	actor := db.Actor{UserID: s.UserID, SpaceID: s.Space1}
	ctx := context.Background()
	exec(t, database, `INSERT INTO agent_skill_spaces ("skillId", "spaceId", "userId") VALUES ($1, $2, $3)`,
		s.SkillID, s.Space2, s.UserID)
	if _, failure := agentskills.Remove(ctx, database, actor, raw(`{"skillId":"`+s.SkillID+`"}`)); failure != nil {
		t.Fatal(failure)
	}
	if rows := systemScalar[int](t, database, `SELECT count(*) FROM agent_skill_spaces WHERE "skillId" = $1`, s.SkillID); rows != 0 {
		t.Fatalf("space rows = %d", rows)
	}
	if _, failure := agentskills.Get(ctx, database, actor, raw(`{"skillId":"`+s.SkillID+`"}`)); failure == nil || failure.Code != "NOT_FOUND" {
		t.Fatalf("get after remove = %+v", failure)
	}
}
