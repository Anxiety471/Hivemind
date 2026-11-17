// Package availability ports the account-item availability procedures:
// availability.items, availability.set and availability.chooseForSpace.
package availability

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/orpc"
)

// SpaceAvailability is the wire shape.
type SpaceAvailability struct {
	AllSpaces bool     `json:"allSpaces"`
	SpaceIDs  []string `json:"spaceIds"`
}

// AccountItem is one row of availability.items.
type AccountItem struct {
	Kind         string            `json:"kind"`
	ID           string            `json:"id"`
	Name         string            `json:"name"`
	Availability SpaceAvailability `json:"availability"`
}

// SetInput is availability.set's input.
type SetInput struct {
	Kind      string    `json:"kind"`
	ID        string    `json:"id"`
	AllSpaces *bool     `json:"allSpaces"`
	SpaceIDs  *[]string `json:"spaceIds"`
}

// ChooseItem names one item to make available.
type ChooseItem struct {
	Kind string `json:"kind"`
	ID   string `json:"id"`
}

// ChooseInput is availability.chooseForSpace's input.
type ChooseInput struct {
	SpaceID string       `json:"spaceId"`
	Items   []ChooseItem `json:"items"`
}

// OwnedItem is an account item plus the row place() needs.
type OwnedItem struct {
	AccountItem
	Row row
}

type row struct {
	ID        string
	SpaceID   string
	Name      string
	Slug      string
	AllSpaces bool
	SecretID  *string
}

const (
	kindSkill     = "skill"
	kindMcpServer = "mcpServer"
	kindInstall   = "install"
)

// Items implements availability.items.
func Items(ctx context.Context, database *db.DB, actor db.Actor) ([]AccountItem, *orpc.Error) {
	var items []AccountItem
	err := database.Tenant(ctx, actor, func(tx pgx.Tx) error {
		owned, err := ownItems(ctx, database, tx, actor)
		if err != nil {
			return err
		}
		items = make([]AccountItem, 0, len(owned))
		for _, item := range owned {
			items = append(items, item.AccountItem)
		}
		return nil
	})
	if err != nil {
		return nil, failure(err)
	}
	return items, nil
}

// Set implements availability.set.
func Set(ctx context.Context, database *db.DB, actor db.Actor, input SetInput) (SpaceAvailability, *orpc.Error) {
	spaceIDs := *input.SpaceIDs
	requested := SpaceAvailability{AllSpaces: *input.AllSpaces, SpaceIDs: spaceIDs}
	var result SpaceAvailability
	err := database.Tenant(ctx, actor, func(tx pgx.Tx) error {
		if input.Kind == kindInstall {
			if err := lock(ctx, tx, "plugin:"+actor.UserID); err != nil {
				return err
			}
		}
		if err := assertOwnSpaces(ctx, tx, actor.UserID, spaceIDs); err != nil {
			return err
		}
		item, err := visibleItem(ctx, tx, actor, input.Kind, input.ID)
		if err != nil {
			return err
		}
		if item == nil {
			return orpc.NotFound("Not Found")
		}
		result, err = place(ctx, database, tx, actor, input.Kind, *item, requested)
		return err
	})
	if err != nil {
		if failure, ok := err.(*orpc.Error); ok {
			return SpaceAvailability{}, failure
		}
		return SpaceAvailability{}, failure(err)
	}
	return result, nil
}

// ChooseForSpace implements availability.chooseForSpace.
func ChooseForSpace(ctx context.Context, database *db.DB, actor db.Actor, input ChooseInput) *orpc.Error {
	err := database.Tenant(ctx, actor, func(tx pgx.Tx) error {
		if err := assertOwnSpaces(ctx, tx, actor.UserID, []string{input.SpaceID}); err != nil {
			return err
		}
		others, err := otherSpaces(ctx, tx, actor.UserID, input.SpaceID)
		if err != nil {
			return err
		}
		owned, err := ownItems(ctx, database, tx, actor)
		if err != nil {
			return err
		}
		chosen := make(map[string]bool, len(input.Items))
		for _, item := range input.Items {
			chosen[item.Kind+":"+item.ID] = true
		}
		for _, item := range owned {
			here := item.Availability.AllSpaces || contains(item.Availability.SpaceIDs, input.SpaceID)
			want := chosen[item.Kind+":"+item.ID]
			if want == here {
				continue
			}
			var next SpaceAvailability
			if want {
				next = SpaceAvailability{AllSpaces: false, SpaceIDs: append(append([]string{}, item.Availability.SpaceIDs...), input.SpaceID)}
			} else if item.Availability.AllSpaces {
				next = SpaceAvailability{AllSpaces: false, SpaceIDs: others}
			} else {
				next = SpaceAvailability{AllSpaces: false, SpaceIDs: without(item.Availability.SpaceIDs, input.SpaceID)}
			}
			if len(next.SpaceIDs) == 0 {
				continue
			}
			if _, err := place(ctx, database, tx, actor, item.Kind, item.Row, next); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		if failure, ok := err.(*orpc.Error); ok {
			return failure
		}
		return failure(err)
	}
	return nil
}

// ownItems reads the owner's items across every Space, which only a system
// context may do. Order matches the TypeScript: installs, servers, skills.
func ownItems(ctx context.Context, database *db.DB, tx pgx.Tx, actor db.Actor) ([]OwnedItem, error) {
	var items []OwnedItem
	err := database.InSystem(ctx, tx, func() error {
		installs, err := queryItems(ctx, tx, `SELECT id, "spaceId", "allSpaces", name,
			coalesce((SELECT array_agg(s."spaceId" ORDER BY s."spaceId") FROM capability_install_spaces s WHERE s."installId" = capability_installs.id), '{}')
			FROM capability_installs
			WHERE "userId" = $1 AND kind IN ('plugin', 'mcp', 'api', 'graphql')
			ORDER BY name ASC`, actor.UserID, kindInstall)
		if err != nil {
			return err
		}
		servers, err := queryItems(ctx, tx, `SELECT id, "spaceId", "allSpaces", name,
			coalesce((SELECT array_agg(s."spaceId" ORDER BY s."spaceId") FROM mcp_server_spaces s WHERE s."serverId" = mcp_servers.id), '{}')
			FROM mcp_servers
			WHERE "userId" = $1 AND "installId" IS NULL
			ORDER BY name ASC`, actor.UserID, kindMcpServer)
		if err != nil {
			return err
		}
		skills, err := queryItems(ctx, tx, `SELECT id, "spaceId", "allSpaces", name,
			coalesce((SELECT array_agg(s."spaceId" ORDER BY s."spaceId") FROM agent_skill_spaces s WHERE s."skillId" = agent_skills.id), '{}')
			FROM agent_skills
			WHERE "userId" = $1 AND source = 'user'
			ORDER BY name ASC`, actor.UserID, kindSkill)
		if err != nil {
			return err
		}
		items = append(items, installs...)
		items = append(items, servers...)
		items = append(items, skills...)
		return nil
	})
	return items, err
}

func queryItems(ctx context.Context, tx pgx.Tx, query, userID, kind string) ([]OwnedItem, error) {
	rows, err := tx.Query(ctx, query, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var items []OwnedItem
	for rows.Next() {
		var item OwnedItem
		var extra []string
		if err := rows.Scan(&item.Row.ID, &item.Row.SpaceID, &item.Row.AllSpaces, &item.Row.Name, &extra); err != nil {
			return nil, err
		}
		item.Kind = kind
		item.ID = item.Row.ID
		item.Name = item.Row.Name
		item.Availability = SpaceAvailability{AllSpaces: item.Row.AllSpaces, SpaceIDs: append([]string{item.Row.SpaceID}, without(extra, item.Row.SpaceID)...)}
		items = append(items, item)
	}
	return items, rows.Err()
}

func visibleItem(ctx context.Context, tx pgx.Tx, actor db.Actor, kind, id string) (*row, error) {
	var item row
	var err error
	switch kind {
	case kindSkill:
		err = tx.QueryRow(ctx, `SELECT id, "spaceId", "allSpaces", name, coalesce("installId", '')
			FROM agent_skills
			WHERE id = $1 AND "userId" = $2 AND source = 'user'
				AND ("spaceId" = $3 OR "allSpaces" OR EXISTS (
					SELECT 1 FROM agent_skill_spaces s WHERE s."skillId" = agent_skills.id AND s."spaceId" = $3))`,
			id, actor.UserID, actor.SpaceID).Scan(&item.ID, &item.SpaceID, &item.AllSpaces, &item.Name, new(string))
	case kindMcpServer:
		err = tx.QueryRow(ctx, `SELECT id, "spaceId", "allSpaces", name, slug, "secretId"
			FROM mcp_servers
			WHERE id = $1 AND "userId" = $2 AND "installId" IS NULL
				AND ("spaceId" = $3 OR "allSpaces" OR EXISTS (
					SELECT 1 FROM mcp_server_spaces s WHERE s."serverId" = mcp_servers.id AND s."spaceId" = $3))`,
			id, actor.UserID, actor.SpaceID).Scan(&item.ID, &item.SpaceID, &item.AllSpaces, &item.Name, &item.Slug, &item.SecretID)
	default:
		err = tx.QueryRow(ctx, `SELECT id, "spaceId", "allSpaces", name, "secretId"
			FROM capability_installs
			WHERE id = $1 AND "userId" = $2
				AND ("spaceId" = $3 OR "allSpaces" OR EXISTS (
					SELECT 1 FROM capability_install_spaces s WHERE s."installId" = capability_installs.id AND s."spaceId" = $3))`,
			id, actor.UserID, actor.SpaceID).Scan(&item.ID, &item.SpaceID, &item.AllSpaces, &item.Name, &item.SecretID)
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &item, nil
}

func assertOwnSpaces(ctx context.Context, tx pgx.Tx, userID string, spaceIDs []string) error {
	unique := uniqueStrings(spaceIDs)
	var count int
	if err := tx.QueryRow(ctx, `SELECT count(*)
		FROM space_members sm JOIN spaces sp ON sp.id = sm."spaceId"
		WHERE sm."userId" = $1 AND sm."spaceId" = ANY($2) AND sp."deletingAt" IS NULL`,
		userID, unique).Scan(&count); err != nil {
		return err
	}
	if count != len(unique) {
		return orpc.NotFound("Not Found")
	}
	return nil
}

func otherSpaces(ctx context.Context, tx pgx.Tx, userID, except string) ([]string, error) {
	rows, err := tx.Query(ctx, `SELECT sm."spaceId"
		FROM space_members sm JOIN spaces sp ON sp.id = sm."spaceId"
		WHERE sm."userId" = $1 AND sp."deletingAt" IS NULL AND sm."spaceId" <> $2`, userID, except)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

func place(ctx context.Context, database *db.DB, tx pgx.Tx, actor db.Actor, kind string, item row, requested SpaceAvailability) (SpaceAvailability, error) {
	spaceIDs := uniqueStrings(requested.SpaceIDs)
	home := ""
	switch {
	case requested.AllSpaces:
		home = item.SpaceID
	case contains(spaceIDs, item.SpaceID):
		home = item.SpaceID
	case contains(spaceIDs, actor.SpaceID):
		home = actor.SpaceID
	default:
		home = spaceIDs[0]
	}
	availability := SpaceAvailability{AllSpaces: requested.AllSpaces, SpaceIDs: append([]string{home}, without(spaceIDs, home)...)}
	err := database.InSystem(ctx, tx, func() error {
		switch kind {
		case kindSkill:
			if err := assertNameFree(ctx, tx, actor.UserID, kindSkill, item.Name, availability, item.ID); err != nil {
				return err
			}
			return applySkill(ctx, tx, actor.UserID, item.ID, home, availability)
		case kindMcpServer:
			if err := assertNameFree(ctx, tx, actor.UserID, kindMcpServer, item.Slug, availability, item.ID); err != nil {
				return err
			}
			if err := applyServer(ctx, tx, actor.UserID, item.ID, home, availability); err != nil {
				return err
			}
			return settleSecret(ctx, tx, actor.UserID, item.SecretID, home, availability)
		default:
			skills, servers, err := installChildren(ctx, tx, actor.UserID, item.ID)
			if err != nil {
				return err
			}
			for _, skill := range skills {
				if err := assertNameFree(ctx, tx, actor.UserID, kindSkill, skill.Name, availability, skill.ID); err != nil {
					return err
				}
			}
			for _, server := range servers {
				if err := assertNameFree(ctx, tx, actor.UserID, kindMcpServer, server.Slug, availability, server.ID); err != nil {
					return err
				}
			}
			if _, err := tx.Exec(ctx, `UPDATE capability_installs SET "spaceId" = $2, "allSpaces" = $3 WHERE id = $1`, item.ID, home, availability.AllSpaces); err != nil {
				return err
			}
			if err := replaceSpaces(ctx, tx, "capability_install_spaces", "installId", item.ID, actor.UserID, home, availability); err != nil {
				return err
			}
			if err := settleSecret(ctx, tx, actor.UserID, item.SecretID, home, availability); err != nil {
				return err
			}
			for _, skill := range skills {
				if err := applySkill(ctx, tx, actor.UserID, skill.ID, home, availability); err != nil {
					return err
				}
			}
			for _, server := range servers {
				if err := applyServer(ctx, tx, actor.UserID, server.ID, home, availability); err != nil {
					return err
				}
				if err := settleSecret(ctx, tx, actor.UserID, server.SecretID, home, availability); err != nil {
					return err
				}
			}
			return nil
		}
	})
	return availability, err
}

// assertNameFree keeps a skill name (case-insensitive) or MCP slug unique
// wherever its owner can see the item.
func assertNameFree(ctx context.Context, tx pgx.Tx, userID, kind, name string, availability SpaceAvailability, excludeID string) error {
	if err := lock(ctx, tx, "names:"+kind+":"+userID); err != nil {
		return err
	}
	var query string
	args := []any{userID, name, excludeID}
	if kind == kindSkill {
		query = `SELECT id, "spaceId", "allSpaces",
			coalesce((SELECT array_agg(s."spaceId") FROM agent_skill_spaces s WHERE s."skillId" = agent_skills.id), '{}')
			FROM agent_skills WHERE "userId" = $1 AND lower(name) = lower($2) AND id <> $3`
	} else {
		query = `SELECT id, "spaceId", "allSpaces",
			coalesce((SELECT array_agg(s."spaceId") FROM mcp_server_spaces s WHERE s."serverId" = mcp_servers.id), '{}')
			FROM mcp_servers WHERE "userId" = $1 AND slug = $2 AND id <> $3`
	}
	rows, err := tx.Query(ctx, query, args...)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var id, spaceID string
		var allSpaces bool
		var spaces []string
		if err := rows.Scan(&id, &spaceID, &allSpaces, &spaces); err != nil {
			return err
		}
		if overlaps(SpaceAvailability{AllSpaces: allSpaces, SpaceIDs: append([]string{spaceID}, spaces...)}, availability) {
			if kind == kindSkill {
				return orpc.Conflict("A skill with that name already exists in one of these spaces.")
			}
			return orpc.Conflict("An MCP server with that name already exists in one of these spaces.")
		}
	}
	return rows.Err()
}

func overlaps(a, b SpaceAvailability) bool {
	if a.AllSpaces || b.AllSpaces {
		return true
	}
	for _, left := range a.SpaceIDs {
		if contains(b.SpaceIDs, left) {
			return true
		}
	}
	return false
}

func applySkill(ctx context.Context, tx pgx.Tx, userID, id, home string, availability SpaceAvailability) error {
	if _, err := tx.Exec(ctx, `UPDATE agent_skills SET "spaceId" = $2, "allSpaces" = $3, "updatedAt" = now() WHERE id = $1`,
		id, home, availability.AllSpaces); err != nil {
		return err
	}
	return replaceSpaces(ctx, tx, "agent_skill_spaces", "skillId", id, userID, home, availability)
}

func applyServer(ctx context.Context, tx pgx.Tx, userID, id, home string, availability SpaceAvailability) error {
	if _, err := tx.Exec(ctx, `UPDATE mcp_servers SET "spaceId" = $2, "allSpaces" = $3, "updatedAt" = now() WHERE id = $1`,
		id, home, availability.AllSpaces); err != nil {
		return err
	}
	return replaceSpaces(ctx, tx, "mcp_server_spaces", "serverId", id, userID, home, availability)
}

func replaceSpaces(ctx context.Context, tx pgx.Tx, table, column, id, userID, home string, availability SpaceAvailability) error {
	if _, err := tx.Exec(ctx, fmt.Sprintf(`DELETE FROM %s WHERE %s = $1`, table, quote(column)), id); err != nil {
		return err
	}
	for _, spaceID := range without(availability.SpaceIDs, home) {
		if _, err := tx.Exec(ctx, fmt.Sprintf(`INSERT INTO %s (%s, "spaceId", "userId") VALUES ($1, $2, $3)`, table, quote(column)), id, spaceID, userID); err != nil {
			return err
		}
	}
	return nil
}

func settleSecret(ctx context.Context, tx pgx.Tx, userID string, secretID *string, home string, availability SpaceAvailability) error {
	if secretID == nil {
		return nil
	}
	var newSpace *string
	if availability.AllSpaces || len(availability.SpaceIDs) > 1 {
		newSpace = nil
	} else {
		newSpace = &home
	}
	_, err := tx.Exec(ctx, `UPDATE secrets SET "spaceId" = $1 WHERE id = $2 AND "userId" = $3`, newSpace, *secretID, userID)
	return err
}

func installChildren(ctx context.Context, tx pgx.Tx, userID, installID string) ([]row, []row, error) {
	skillRows, err := tx.Query(ctx, `SELECT id, "spaceId", "allSpaces", name FROM agent_skills WHERE "installId" = $1 AND "userId" = $2`, installID, userID)
	if err != nil {
		return nil, nil, err
	}
	var skills []row
	for skillRows.Next() {
		var item row
		if err := skillRows.Scan(&item.ID, &item.SpaceID, &item.AllSpaces, &item.Name); err != nil {
			skillRows.Close()
			return nil, nil, err
		}
		skills = append(skills, item)
	}
	skillRows.Close()
	serverRows, err := tx.Query(ctx, `SELECT id, "spaceId", "allSpaces", name, slug, "secretId" FROM mcp_servers WHERE "installId" = $1 AND "userId" = $2`, installID, userID)
	if err != nil {
		return nil, nil, err
	}
	var servers []row
	for serverRows.Next() {
		var item row
		if err := serverRows.Scan(&item.ID, &item.SpaceID, &item.AllSpaces, &item.Name, &item.Slug, &item.SecretID); err != nil {
			serverRows.Close()
			return nil, nil, err
		}
		servers = append(servers, item)
	}
	serverRows.Close()
	return skills, servers, serverRows.Err()
}

func lock(ctx context.Context, tx pgx.Tx, key string) error {
	_, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, key)
	return err
}

func failure(err error) *orpc.Error {
	if db.IsUnavailable(err) {
		return orpc.Unavailable()
	}
	return orpc.Internal()
}

func uniqueStrings(values []string) []string {
	seen := make(map[string]bool, len(values))
	result := make([]string, 0, len(values))
	for _, value := range values {
		if seen[value] {
			continue
		}
		seen[value] = true
		result = append(result, value)
	}
	return result
}

func without(values []string, drop string) []string {
	result := make([]string, 0, len(values))
	for _, value := range values {
		if value != drop {
			result = append(result, value)
		}
	}
	return result
}

func contains(values []string, wanted string) bool {
	for _, value := range values {
		if value == wanted {
			return true
		}
	}
	return false
}

func quote(identifier string) string {
	return `"` + strings.ReplaceAll(identifier, `"`, `""`) + `"`
}
