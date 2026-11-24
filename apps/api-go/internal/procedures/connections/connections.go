// Package connections ports connections.list and connections.rename
// (routes/connections.ts). begin, complete, catalog, revoke and tools stay on the
// TypeScript API: they run connector adapters and touch the connection's secret.
package connections

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/orpc"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/shared"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/validate"
)

const labelMaxLength = 80 // CONNECTION_LABEL_MAX_LENGTH

// Connection is the wire shape of ConnectionSchema. The secret, provider reference
// and metadata columns are never selected.
type Connection struct {
	ID           string   `json:"id"`
	ConnectorID  string   `json:"connectorId"`
	Provider     string   `json:"provider"`
	DisplayName  string   `json:"displayName"`
	Status       string   `json:"status"`
	Capabilities []string `json:"capabilities"`
	CreatedAt    string   `json:"createdAt"`
}

const columns = `id, "connectorId", provider, "displayName", status, "createdAt"`

// checkStatus is the router's output parse: a status outside the schema's enum fails the
// call. rename runs it after its write has committed, as the router does.
func checkStatus(connection Connection) *orpc.Error {
	switch connection.Status {
	case "pending", "connected", "revoked", "error":
		return nil
	}
	return shared.OutputInvalid()
}

func scan(row pgx.Row) (Connection, error) {
	var connection Connection
	var createdAt time.Time
	if err := row.Scan(&connection.ID, &connection.ConnectorID, &connection.Provider, &connection.DisplayName, &connection.Status, &createdAt); err != nil {
		return Connection{}, err
	}
	connection.Capabilities = []string{}
	connection.CreatedAt = shared.ISO(createdAt)
	return connection, nil
}

// List implements connections.list: the member's connections in this Space, in the
// order the table returns them (Prisma sets no ordering either).
func List(ctx context.Context, database *db.DB, actor db.Actor) ([]Connection, *orpc.Error) {
	found := []Connection{}
	err := database.Tenant(ctx, actor, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `SELECT `+columns+` FROM connections WHERE "spaceId" = $1 AND "userId" = $2`, actor.SpaceID, actor.UserID)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			connection, err := scan(rows)
			if err != nil {
				return err
			}
			found = append(found, connection)
		}
		return rows.Err()
	})
	if err != nil {
		return nil, shared.Failure(err)
	}
	for _, connection := range found {
		if failure := checkStatus(connection); failure != nil {
			return nil, failure
		}
	}
	return found, nil
}

// parseRename mirrors z.object({ connectionId: Id, displayName: z.string().trim().min(1).max(80) }).
func parseRename(raw orpc.Input) (id, name string, failure *orpc.Error) {
	object, issues := validate.Decode(raw.Raw, nil)
	if issues != nil {
		return "", "", validate.Fail(issues)
	}
	var found []validate.Issue
	id, problems := validate.String(validate.Path{"connectionId"}, object.Field("connectionId"), validate.StringRules{Min: 1})
	found = append(found, problems...)
	name, problems = validate.String(validate.Path{"displayName"}, object.Field("displayName"), validate.StringRules{Trim: true, Min: 1, Max: labelMaxLength})
	found = append(found, problems...)
	if found != nil {
		return "", "", validate.Fail(found)
	}
	return id, name, nil
}

// Rename implements connections.rename: the member's own connection in this Space.
// The name is stored as the API's Prisma client stores text: NUL becomes U+FFFD.
func Rename(ctx context.Context, database *db.DB, actor db.Actor, raw orpc.Input) (any, *orpc.Error) {
	id, name, failure := parseRename(raw)
	if failure != nil {
		return nil, failure
	}
	var renamed Connection
	err := database.Tenant(ctx, actor, func(tx pgx.Tx) error {
		var existing string
		err := tx.QueryRow(ctx, `SELECT id FROM connections WHERE id = $1 AND "spaceId" = $2 AND "userId" = $3`, id, actor.SpaceID, actor.UserID).Scan(&existing)
		if errors.Is(err, pgx.ErrNoRows) {
			return shared.NotFound
		}
		if err != nil {
			return err
		}
		renamed, err = scan(tx.QueryRow(ctx, `UPDATE connections SET "displayName" = $1, "updatedAt" = $2 WHERE id = $3 RETURNING `+columns,
			append(db.Data(strings.ReplaceAll(name, "\x00", "\uFFFD"), time.Now().UTC().Truncate(time.Millisecond)), existing)...))
		return err
	})
	if err != nil {
		return nil, shared.Failure(err)
	}
	if failure := checkStatus(renamed); failure != nil {
		return nil, failure
	}
	return renamed, nil
}
