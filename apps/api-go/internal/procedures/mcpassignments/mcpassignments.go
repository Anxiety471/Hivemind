// Package mcpassignments ports mcp.assignments.list and mcp.assignments.all
// (routes/mcp.ts). Assignments say which of the member's MCP servers a bot may use; the
// servers' own rows (endpoint, env, headers, secret) are only ever filtered on.
package mcpassignments

import (
	"context"
	"errors"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/orpc"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/shared"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/validate"
)

// Assignment is the wire shape of BotMcpServerSchema.
type Assignment struct {
	ID            string   `json:"id"`
	BotID         string   `json:"botId"`
	ServerID      string   `json:"serverId"`
	AllowAllTools bool     `json:"allowAllTools"`
	AllowedTools  []string `json:"allowedTools"`
	CreatedAt     string   `json:"createdAt"`
	UpdatedAt     string   `json:"updatedAt"`
}

// available is availableInSpace on the server of an assignment: the member's own server
// added in this Space, available in every Space, or shared with it.
const available = `EXISTS (SELECT 1 FROM mcp_servers s WHERE s.id = a."serverId" AND s."userId" = $2
	AND (s."spaceId" = $1 OR s."allSpaces" = true
		OR EXISTS (SELECT 1 FROM mcp_server_spaces x WHERE x."serverId" = s.id AND x."spaceId" = $1)))`

const columns = `a.id, a."botId", a."serverId", a."allowAllTools", a."allowedTools", a."createdAt", a."updatedAt"`

// mcpAssignmentDto reads allowedTools as a list of strings; anything else in it is dropped.
func scan(rows pgx.Rows) (Assignment, error) {
	var assignment Assignment
	var tools []byte
	var createdAt, updatedAt time.Time
	if err := rows.Scan(&assignment.ID, &assignment.BotID, &assignment.ServerID, &assignment.AllowAllTools, &tools, &createdAt, &updatedAt); err != nil {
		return Assignment{}, err
	}
	assignment.AllowedTools = []string{}
	if value, err := validate.DecodeAny(tools); err == nil {
		if items, ok := value.([]any); ok {
			for _, item := range items {
				if text, ok := item.(string); ok {
					// The router validates the output: each tool name is 1..200 characters.
					if length := utf8.RuneCountInString(text); length < 1 || length > 200 {
						return Assignment{}, shared.OutputInvalid()
					}
					assignment.AllowedTools = append(assignment.AllowedTools, text)
				}
			}
		}
	}
	assignment.CreatedAt, assignment.UpdatedAt = shared.ISO(createdAt), shared.ISO(updatedAt)
	return assignment, nil
}

func collect(rows pgx.Rows) ([]Assignment, error) {
	defer rows.Close()
	found := []Assignment{}
	for rows.Next() {
		assignment, err := scan(rows)
		if err != nil {
			return nil, err
		}
		found = append(found, assignment)
	}
	return found, rows.Err()
}

// All implements mcp.assignments.all: every assignment of the member's live bots in this
// Space whose server is available here, oldest first.
func All(ctx context.Context, database *db.DB, actor db.Actor) ([]Assignment, *orpc.Error) {
	var found []Assignment
	err := database.Tenant(ctx, actor, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `SELECT `+columns+` FROM bot_mcp_servers a
			WHERE a."spaceId" = $1 AND a."userId" = $2
				AND EXISTS (SELECT 1 FROM bots b WHERE b.id = a."botId" AND b."archivedAt" IS NULL)
				AND `+available+` ORDER BY a."createdAt" ASC, a.ctid`, actor.SpaceID, actor.UserID)
		if err != nil {
			return err
		}
		found, err = collect(rows)
		return err
	})
	if err != nil {
		return nil, shared.Failure(err)
	}
	return found, nil
}

// List implements mcp.assignments.list: one bot of the Space (archived or not).
func List(ctx context.Context, database *db.DB, actor db.Actor, raw orpc.Input) ([]Assignment, *orpc.Error) {
	object, issues := validate.Decode(raw.Raw, nil)
	if issues != nil {
		return nil, validate.Fail(issues)
	}
	botID, issues := validate.String(validate.Path{"botId"}, object.Field("botId"), validate.StringRules{Min: 1})
	if issues != nil {
		return nil, validate.Fail(issues)
	}
	var found []Assignment
	err := database.Tenant(ctx, actor, func(tx pgx.Tx) error {
		var id string
		err := tx.QueryRow(ctx, `SELECT id FROM bots WHERE id = $1 AND "spaceId" = $2`, botID, actor.SpaceID).Scan(&id)
		if errors.Is(err, pgx.ErrNoRows) {
			return shared.NotFound
		}
		if err != nil {
			return err
		}
		rows, err := tx.Query(ctx, `SELECT `+columns+` FROM bot_mcp_servers a
			WHERE a."botId" = $3 AND a."spaceId" = $1 AND a."userId" = $2 AND `+available+` ORDER BY a."createdAt" ASC, a.ctid`,
			actor.SpaceID, actor.UserID, id)
		if err != nil {
			return err
		}
		found, err = collect(rows)
		return err
	})
	if err != nil {
		return nil, shared.Failure(err)
	}
	return found, nil
}
