// Package memorycfg ports memory.providerConfig and memory.setDefaultScope
// (apps/api/src/routes/memory.ts:122-157 over apps/api/src/memory-provider-config.ts:262-341).
//
// The rest of the group stays on TypeScript: memory.remove/update/list and
// exportMarkdown read or write the rkz1-sealed MemoryDocument and MemoryRevision
// content, connectProvider/updateProvider/disconnectProvider put, load and delete the
// provider's credentials through the SecretStore (and delete Secret rows, which the
// secret-persistence hook backs up), and budget/scratchpad/skills run adapters.
package memorycfg

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/orpc"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/shared"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/validate"
)

var (
	errNotFound      = orpc.NotFound("Not Found")
	errOwnerRequired = orpc.Forbidden("Only the space owner can do that")
)

func now() time.Time { return time.Now().UTC().Truncate(time.Millisecond) }

// Config is SpaceMemoryConfigSchema's wire shape (packages/contracts/src/domain.ts:1407).
type Config struct {
	Provider           string            `json:"provider"`
	Settings           map[string]string `json:"settings"`
	DefaultMemoryScope string            `json:"defaultMemoryScope"`
	UpdatedAt          string            `json:"updatedAt"`
	ConnectionLabel    *string           `json:"connectionLabel,omitempty"`
}

// toStringRecord is toStringRecord (packages/adapters/src/memory-provider-factory.ts:143):
// only a stored object's string values survive.
func toStringRecord(value any) map[string]string {
	record := map[string]string{}
	object, ok := value.(map[string]any)
	if !ok {
		return record
	}
	for key, item := range object {
		if text, ok := item.(string); ok {
			record[key] = text
		}
	}
	return record
}

// selfHostedLabel is selfHostedLabel (packages/adapters/src/memory-provider-descriptor.ts:67).
func selfHostedLabel(settings map[string]string) string {
	baseURL, ok := settings["baseUrl"]
	if !ok {
		baseURL = "undefined"
	}
	return "Self-hosted (" + baseURL + ")"
}

// connectionLabel is memoryProviderConnectionLabel (memory-provider-factory.ts:57): one
// line naming a saved connection, or nothing for a provider this build does not have.
func connectionLabel(provider string, settings map[string]string) *string {
	label := func(text string) *string { return &text }
	switch provider {
	case "supermemory":
		if settings["mode"] == "cloud" {
			return label("Supermemory Cloud")
		}
		return label(selfHostedLabel(settings))
	case "serenity":
		name := validate.JSTrim(settings["brainLabel"])
		endpoint, ok := settings["endpoint"]
		if !ok {
			endpoint = "Serenity"
		}
		mode := "recall only"
		if settings["allowWrites"] == "true" {
			mode = "read/write"
		}
		if name == "" {
			name = endpoint
		}
		return label(name + ", " + mode)
	case "honcho":
		workspaceID := settings["workspaceId"]
		if settings["mode"] == "local" {
			parts := []string{selfHostedLabel(settings)}
			if workspaceID != "" {
				parts = append(parts, workspaceID)
			}
			return label(strings.Join(parts, ", "))
		}
		if workspaceID != "" {
			return label("Honcho Cloud (" + workspaceID + ")")
		}
		return label("Honcho Cloud")
	case "hindsight":
		if settings["mode"] == "local" {
			return label(selfHostedLabel(settings))
		}
		return label("Hindsight Cloud")
	}
	return nil
}

// serialize is serializeSpaceMemoryConfig (memory-provider-config.ts:262), then the
// router's output parse: defaultMemoryScope is an enum, so another stored value fails
// the call instead of being returned as is.
func serialize(provider string, storedSettings any, defaultMemoryScope string, updatedAt time.Time) (Config, *orpc.Error) {
	if defaultMemoryScope != "isolated" && defaultMemoryScope != "shared" {
		return Config{}, shared.OutputInvalid()
	}
	settings := toStringRecord(storedSettings)
	return Config{
		Provider:           provider,
		Settings:           settings,
		DefaultMemoryScope: defaultMemoryScope,
		UpdatedAt:          shared.ISO(updatedAt),
		ConnectionLabel:    connectionLabel(provider, settings),
	}, nil
}

// ProviderConfig implements memory.providerConfig: the Space's configured provider, or
// null when none is connected.
func ProviderConfig(ctx context.Context, database *db.DB, actor db.Actor) (any, *orpc.Error) {
	var config *Config
	err := database.Tenant(ctx, actor, func(tx pgx.Tx) error {
		var provider, defaultMemoryScope string
		var stored []byte
		var updatedAt time.Time
		err := tx.QueryRow(ctx, `SELECT provider, settings, "defaultMemoryScope", "updatedAt"
			FROM space_memory_configs WHERE "spaceId" = $1`, actor.SpaceID).
			Scan(&provider, &stored, &defaultMemoryScope, &updatedAt)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		if err != nil {
			return err
		}
		var value any
		if json.Unmarshal(stored, &value) != nil {
			value = nil
		}
		serialized, failure := serialize(provider, value, defaultMemoryScope, updatedAt)
		if failure != nil {
			return failure
		}
		config = &serialized
		return nil
	})
	if err != nil {
		return nil, shared.Failure(err)
	}
	if config == nil {
		return nil, nil
	}
	return config, nil
}

// DefaultScopeInput is memory.setDefaultScope's input.
type DefaultScopeInput struct {
	DefaultMemoryScope string
}

// ParseDefaultScope mirrors z.object({ defaultMemoryScope: MemoryScopeSchema }).
func ParseDefaultScope(raw orpc.Input) (DefaultScopeInput, *orpc.Error) {
	object, issues := validate.Decode(raw.Raw, nil)
	if issues != nil {
		return DefaultScopeInput{}, validate.Fail(issues)
	}
	scope, problems := validate.Enum(validate.Path{"defaultMemoryScope"}, object.Field("defaultMemoryScope"), "isolated", "shared")
	if problems != nil {
		return DefaultScopeInput{}, validate.Fail(problems)
	}
	return DefaultScopeInput{DefaultMemoryScope: scope}, nil
}

// requireOwner is requireSpaceOwner (packages/db/src/space-members.ts:104).
func requireOwner(ctx context.Context, tx pgx.Tx, actor db.Actor) error {
	var role string
	err := tx.QueryRow(ctx, `SELECT role FROM space_members WHERE "spaceId" = $1 AND "userId" = $2`,
		actor.SpaceID, actor.UserID).Scan(&role)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && !shared.IsOwnerRole(role)) {
		return errOwnerRequired
	}
	return err
}

// SetDefaultScope implements memory.setDefaultScope: the owner changes how the
// connected provider scopes new memory. The provider's credentials are untouched, so
// the secret-persistence hook has nothing to do.
func SetDefaultScope(ctx context.Context, database *db.DB, actor db.Actor, raw orpc.Input) (any, *orpc.Error) {
	input, failure := ParseDefaultScope(raw)
	if failure != nil {
		return nil, failure
	}
	var config Config
	err := database.Tenant(ctx, actor, func(tx pgx.Tx) error {
		if err := requireOwner(ctx, tx, actor); err != nil {
			return err
		}
		var id string
		err := tx.QueryRow(ctx, `SELECT id FROM space_memory_configs WHERE "spaceId" = $1`, actor.SpaceID).Scan(&id)
		if errors.Is(err, pgx.ErrNoRows) {
			return errNotFound
		}
		if err != nil {
			return err
		}
		var provider, scope string
		var stored []byte
		var updatedAt time.Time
		err = tx.QueryRow(ctx, `UPDATE space_memory_configs SET "defaultMemoryScope" = $1, "updatedAt" = $2
			WHERE id = $3
			RETURNING provider, settings, "defaultMemoryScope", "updatedAt"`,
			append(db.Data(input.DefaultMemoryScope, now()), id)...).Scan(&provider, &stored, &scope, &updatedAt)
		if err != nil {
			return err
		}
		var value any
		if json.Unmarshal(stored, &value) != nil {
			value = nil
		}
		serialized, failure := serialize(provider, value, scope, updatedAt)
		if failure != nil {
			return failure
		}
		config = serialized
		return nil
	})
	if err != nil {
		return nil, shared.Failure(err)
	}
	return config, nil
}
