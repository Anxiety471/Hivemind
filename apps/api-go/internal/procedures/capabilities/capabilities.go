// Package capabilities ports capabilities.list (routes/capabilities.ts): the member's
// installs available in this Space. The install's secret is never read, only whether
// the row has one.
package capabilities

import (
	"context"
	"encoding/json"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/orpc"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/shared"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/validate"
)

// Availability is spaceAvailability's result.
type Availability struct {
	AllSpaces bool     `json:"allSpaces"`
	SpaceIDs  []string `json:"spaceIds"`
}

// Install is the wire shape of CapabilityInstallSchema.
type Install struct {
	ID               string          `json:"id"`
	Kind             string          `json:"kind"`
	Name             string          `json:"name"`
	Source           string          `json:"source"`
	Version          *string         `json:"version"`
	Digest           *string         `json:"digest"`
	SecretConfigured bool            `json:"secretConfigured"`
	Config           json.RawMessage `json:"config"`
	Availability     Availability    `json:"availability"`
	CreatedAt        string          `json:"createdAt"`
}

// List implements capabilities.list: installs owned by the member that are added in
// this Space, available in every Space, or shared with it, with each one's Spaces
// starting with the one it was added in.
func List(ctx context.Context, database *db.DB, actor db.Actor, logger *slog.Logger) ([]Install, *orpc.Error) {
	installs := []Install{}
	err := database.Tenant(ctx, actor, func(tx pgx.Tx) error {
		type home struct{ spaceID string }
		rows, err := tx.Query(ctx, `SELECT id, kind, name, source, version, digest, "secretId", config, "createdAt", "spaceId", "allSpaces"
			FROM capability_installs
			WHERE "userId" = $1 AND ("spaceId" = $2 OR "allSpaces" = true
				OR id IN (SELECT "installId" FROM capability_install_spaces WHERE "spaceId" = $2))`, actor.UserID, actor.SpaceID)
		if err != nil {
			return err
		}
		var homes []*home
		for rows.Next() {
			var install Install
			var secretID *string
			var config []byte
			var createdAt time.Time
			var spaceID string
			if err := rows.Scan(&install.ID, &install.Kind, &install.Name, &install.Source, &install.Version, &install.Digest,
				&secretID, &config, &createdAt, &spaceID, &install.Availability.AllSpaces); err != nil {
				rows.Close()
				return err
			}
			// The router validates the output: a kind outside the schema's enum fails the call.
			switch install.Kind {
			case "skill", "plugin", "mcp", "api", "graphql", "connection":
			default:
				rows.Close()
				return shared.OutputInvalid()
			}
			install.SecretConfigured = secretID != nil && *secretID != ""
			install.Config = installConfig(install.ID, config, logger)
			install.CreatedAt = shared.ISO(createdAt)
			install.Availability.SpaceIDs = []string{spaceID}
			installs = append(installs, install)
			homes = append(homes, &home{spaceID: spaceID})
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}
		if len(installs) == 0 {
			return nil
		}
		ids := make([]string, len(installs))
		index := map[string]int{}
		for position, install := range installs {
			ids[position] = install.ID
			index[install.ID] = position
		}
		joins, err := tx.Query(ctx, `SELECT "installId", "spaceId" FROM capability_install_spaces WHERE "installId" = ANY($1)`, ids)
		if err != nil {
			return err
		}
		defer joins.Close()
		for joins.Next() {
			var installID, spaceID string
			if err := joins.Scan(&installID, &spaceID); err != nil {
				return err
			}
			position := index[installID]
			if spaceID != homes[position].spaceID {
				installs[position].Availability.SpaceIDs = append(installs[position].Availability.SpaceIDs, spaceID)
			}
		}
		return joins.Err()
	})
	if err != nil {
		return nil, shared.Failure(err)
	}
	return installs, nil
}

// installConfig is installConfig in plugin-installs.ts: a stored object, as
// JSON.parse and JSON.stringify would pass it on; anything else reads as {} (with a
// warning, as readJsonColumn gives). The response then travels through oRPC's
// serializer, which assigns each key into a fresh object, so a "__proto__" key is
// swallowed by the prototype setter at every depth, objects inside arrays included.
func installConfig(id string, stored []byte, logger *slog.Logger) json.RawMessage {
	value, err := validate.DecodeAny(stored)
	if object, ok := value.(*validate.Object); ok && err == nil {
		return json.RawMessage(validate.Stringify(withoutProto(object)))
	}
	if logger != nil {
		logger.Warn("Stored JSON column does not match its schema; using the fallback",
			"table", "capability_installs", "column", "config", "row.id", id)
	}
	return json.RawMessage(`{}`)
}

// withoutProto copies a decoded JSON value, leaving out every "__proto__" key.
func withoutProto(value any) any {
	switch typed := value.(type) {
	case *validate.Object:
		copied := &validate.Object{Values: map[string]any{}}
		for _, key := range typed.Keys {
			if key != "__proto__" {
				copied.Keys = append(copied.Keys, key)
				copied.Values[key] = withoutProto(typed.Values[key])
			}
		}
		return copied
	case []any:
		items := make([]any, len(typed))
		for index, item := range typed {
			items[index] = withoutProto(item)
		}
		return items
	}
	return value
}
