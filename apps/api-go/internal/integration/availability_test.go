package integration

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/availability"
)

func systemScalar[T any](t *testing.T, database *db.DB, query string, args ...any) T {
	t.Helper()
	var value T
	if err := database.System(context.Background(), "test read", func(tx pgx.Tx) error {
		return tx.QueryRow(context.Background(), query, args...).Scan(&value)
	}); err != nil {
		t.Fatalf("system read: %v", err)
	}
	return value
}

func TestItemsListsOwnedAvailability(t *testing.T) {
	database := openTestDB(t)
	seed := seed(t, database)
	items, failure := availability.Items(context.Background(), database, db.Actor{UserID: seed.UserID, SpaceID: seed.Space1})
	if failure != nil {
		t.Fatalf("items: %v", failure)
	}
	if len(items) != 3 {
		t.Fatalf("items = %d (%+v), want install, server, skill", len(items), items)
	}
	if items[0].Kind != "install" || items[0].ID != seed.InstallID || items[0].Name != "Alpha plugin" {
		t.Errorf("first item = %+v", items[0])
	}
	if items[1].Kind != "mcpServer" || items[1].ID != seed.ServerID || items[1].Name != "Alpha server" {
		t.Errorf("second item = %+v", items[1])
	}
	if items[2].Kind != "skill" || items[2].ID != seed.SkillID || items[2].Name != seed.SkillName {
		t.Errorf("third item = %+v", items[2])
	}
	for _, item := range items {
		if item.Availability.AllSpaces || len(item.Availability.SpaceIDs) != 1 || item.Availability.SpaceIDs[0] != seed.Space1 {
			t.Errorf("%s availability = %+v", item.Kind, item.Availability)
		}
	}
}

func TestSetMovesSkillAndKeepsHome(t *testing.T) {
	database := openTestDB(t)
	seed := seed(t, database)
	actor := db.Actor{UserID: seed.UserID, SpaceID: seed.Space1}
	result, failure := availability.Set(context.Background(), database, actor, availability.SetInput{
		Kind:      "skill",
		ID:        seed.SkillID,
		AllSpaces: new(false),
		SpaceIDs:  new([]string{seed.Space1, seed.Space2}),
	})
	if failure != nil {
		t.Fatalf("set: %v", failure)
	}
	if result.AllSpaces || len(result.SpaceIDs) != 2 || result.SpaceIDs[0] != seed.Space1 || result.SpaceIDs[1] != seed.Space2 {
		t.Fatalf("availability = %+v", result)
	}
	home := systemScalar[string](t, database, `SELECT "spaceId" FROM agent_skills WHERE id = $1`, seed.SkillID)
	if home != seed.Space1 {
		t.Errorf("home = %q, want %q", home, seed.Space1)
	}
	extra := systemScalar[int](t, database, `SELECT count(*) FROM agent_skill_spaces WHERE "skillId" = $1 AND "spaceId" = $2`, seed.SkillID, seed.Space2)
	if extra != 1 {
		t.Errorf("extra space rows = %d, want 1", extra)
	}
}

func TestSetAllSpaces(t *testing.T) {
	database := openTestDB(t)
	seed := seed(t, database)
	result, failure := availability.Set(context.Background(), database, db.Actor{UserID: seed.UserID, SpaceID: seed.Space1}, availability.SetInput{
		Kind:      "skill",
		ID:        seed.SkillID,
		AllSpaces: new(true),
		SpaceIDs:  new([]string{seed.Space2}),
	})
	if failure != nil {
		t.Fatalf("set: %v", failure)
	}
	// With allSpaces the item keeps its home Space first, even when that Space
	// was not named in the request.
	if !result.AllSpaces || len(result.SpaceIDs) != 2 || result.SpaceIDs[0] != seed.Space1 || result.SpaceIDs[1] != seed.Space2 {
		t.Fatalf("availability = %+v", result)
	}
	allSpaces := systemScalar[bool](t, database, `SELECT "allSpaces" FROM agent_skills WHERE id = $1`, seed.SkillID)
	home := systemScalar[string](t, database, `SELECT "spaceId" FROM agent_skills WHERE id = $1`, seed.SkillID)
	if !allSpaces || home != seed.Space1 {
		t.Errorf("row = home %q allSpaces %t", home, allSpaces)
	}
}

func TestSetRejectsForeignItem(t *testing.T) {
	database := openTestDB(t)
	seed := seed(t, database)
	_, failure := availability.Set(context.Background(), database, db.Actor{UserID: seed.User2ID, SpaceID: seed.Space2}, availability.SetInput{
		Kind:      "skill",
		ID:        seed.SkillID,
		AllSpaces: new(false),
		SpaceIDs:  new([]string{seed.Space2}),
	})
	if failure == nil || failure.Status != 404 || failure.Code != "NOT_FOUND" {
		t.Fatalf("failure = %+v, want 404 NOT_FOUND", failure)
	}
}

func TestSetRejectsNameConflict(t *testing.T) {
	database := openTestDB(t)
	seed := seed(t, database)
	ctx := context.Background()
	if err := database.System(ctx, "insert duplicate name", func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `INSERT INTO agent_skills (id, "spaceId", "userId", name, description, content, source, "allSpaces", "createdAt", "updatedAt")
			VALUES ($1, $2, $3, $4, '', 'body', 'user', false, now(), now())`,
			seed.SkillID+"-dup", seed.Space2, seed.UserID, seed.SkillName)
		return err
	}); err != nil {
		t.Fatalf("insert duplicate name: %v", err)
	}
	_, failure := availability.Set(ctx, database, db.Actor{UserID: seed.UserID, SpaceID: seed.Space1}, availability.SetInput{
		Kind:      "skill",
		ID:        seed.SkillID,
		AllSpaces: new(false),
		SpaceIDs:  new([]string{seed.Space1, seed.Space2}),
	})
	if failure == nil || failure.Status != 409 || failure.Code != "CONFLICT" {
		t.Fatalf("failure = %+v, want 409 CONFLICT", failure)
	}
	if failure.Message != "A skill with that name already exists in one of these spaces." {
		t.Errorf("message = %q", failure.Message)
	}
}

func TestChooseForSpaceAddsAndRemoves(t *testing.T) {
	database := openTestDB(t)
	seed := seed(t, database)
	ctx := context.Background()
	actor := db.Actor{UserID: seed.UserID, SpaceID: seed.Space1}
	choose := availability.ChooseInput{SpaceID: seed.Space3, Items: []availability.ChooseItem{{Kind: "skill", ID: seed.SkillID}}}
	if failure := availability.ChooseForSpace(ctx, database, actor, choose); failure != nil {
		t.Fatalf("choose add: %v", failure)
	}
	extra := systemScalar[int](t, database, `SELECT count(*) FROM agent_skill_spaces WHERE "skillId" = $1 AND "spaceId" = $2`, seed.SkillID, seed.Space3)
	if extra != 1 {
		t.Fatalf("space rows after add = %d", extra)
	}

	remove := availability.ChooseInput{SpaceID: seed.Space3}
	if failure := availability.ChooseForSpace(ctx, database, actor, remove); failure != nil {
		t.Fatalf("choose remove: %v", failure)
	}
	extra = systemScalar[int](t, database, `SELECT count(*) FROM agent_skill_spaces WHERE "skillId" = $1 AND "spaceId" = $2`, seed.SkillID, seed.Space3)
	if extra != 0 {
		t.Errorf("space rows after remove = %d", extra)
	}
	home := systemScalar[string](t, database, `SELECT "spaceId" FROM agent_skills WHERE id = $1`, seed.SkillID)
	if home != seed.Space1 {
		t.Errorf("home = %q", home)
	}
}

func TestRowLevelSecurityScopesReads(t *testing.T) {
	database := openTestDB(t)
	seed := seed(t, database)
	ctx := context.Background()
	var visible int
	if err := database.Tenant(ctx, db.Actor{UserID: seed.User2ID, SpaceID: seed.Space2}, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT count(*) FROM agent_skills WHERE id = $1`, seed.SkillID).Scan(&visible)
	}); err != nil {
		t.Fatalf("tenant count: %v", err)
	}
	if visible != 0 {
		t.Errorf("other tenant saw %d skill rows, want 0", visible)
	}
	var systemCount int
	if err := database.System(ctx, "test bypass", func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT count(*) FROM agent_skills WHERE id = $1`, seed.SkillID).Scan(&systemCount)
	}); err != nil {
		t.Fatalf("system count: %v", err)
	}
	if systemCount != 1 {
		t.Errorf("system count = %d, want 1", systemCount)
	}
}

func TestInvalidInput(t *testing.T) {
	_, failure := availability.ParseSet(raw(`{"kind":"skill","id":"x","allSpaces":false,"spaceIds":[]}`))
	if failure == nil || failure.Status != 400 {
		t.Fatalf("failure = %+v, want 400", failure)
	}
}
