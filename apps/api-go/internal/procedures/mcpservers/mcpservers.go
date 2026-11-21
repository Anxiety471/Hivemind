// Package mcpservers ports mcp.servers.list: the MCP servers available in the caller's Space,
// with their settings, health and the OAuth summary read from the sealed material.
//
// A credential that no longer opens is summarized as an empty material, as the shipped reader
// does: the list stays usable and the owner can fix or remove the server.
package mcpservers

import (
	"bytes"
	"context"
	"encoding/json"
	"net/url"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/orpc"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/shared"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/secretstore"
)

// oauthClientRequired is MCP_OAUTH_CLIENT_REQUIRED (packages/contracts/src/integrations/connector-errors.ts).
const oauthClientRequired = "MCP_OAUTH_CLIENT_REQUIRED"

// dynamicRegistrationUnsupported is the MCP SDK message that means the server needs a
// pre-registered client (mcp-server-health.ts:11-13).
const dynamicRegistrationUnsupported = "Incompatible auth server: does not support dynamic client registration"

// Health is McpServerHealthSchema (mcp.ts:264-272).
type Health struct {
	Status    string  `json:"status"`
	Message   *string `json:"message"`
	Code      *string `json:"code"`
	ToolCount *int32  `json:"toolCount"`
	CheckedAt *string `json:"checkedAt"`
}

// Availability is SpaceAvailabilitySchema.
type Availability struct {
	AllSpaces bool     `json:"allSpaces"`
	SpaceIDs  []string `json:"spaceIds"`
}

// Server is McpServerSchema (mcp.ts:275-305).
type Server struct {
	ID              string       `json:"id"`
	SpaceID         string       `json:"spaceId"`
	InstallID       *string      `json:"installId"`
	Slug            string       `json:"slug"`
	Name            string       `json:"name"`
	Description     string       `json:"description"`
	Transport       string       `json:"transport"`
	Endpoint        *string      `json:"endpoint"`
	Command         *string      `json:"command"`
	HasArgs         bool         `json:"hasArgs"`
	EnvKeys         []string     `json:"envKeys"`
	FileKeys        []string     `json:"fileKeys"`
	HeaderKeys      []string     `json:"headerKeys"`
	HasSecret       bool         `json:"hasSecret"`
	OAuthStatus     string       `json:"oauthStatus"`
	OAuthClientID   *string      `json:"oauthClientId"`
	Health          Health       `json:"health"`
	Enabled         bool         `json:"enabled"`
	VerbatimResults bool         `json:"verbatimResults"`
	Revision        int32        `json:"revision"`
	Availability    Availability `json:"availability"`
	AllBots         bool         `json:"allBots"`
	CreatedAt       string       `json:"createdAt"`
	UpdatedAt       string       `json:"updatedAt"`
}

type row struct {
	id, spaceID, slug, name, description, transport string
	endpoint, command                               *string
	args, env, files, headers                       []byte
	hasArgs                                         bool
	secretID, installID                             *string
	allSpaces, allBots, enabled                     bool
	verbatim                                        bool
	revision                                        int32
	healthStatus                                    string
	healthMessage                                   *string
	healthToolCount                                 *int32
	healthCheckedAt                                 *time.Time
	createdAt, updatedAt                            time.Time
}

// List implements mcp.servers.list (routes/mcp.ts:62-88).
func List(
	ctx context.Context,
	database *db.DB,
	deployment shared.Deployment,
	actor db.Actor,
	_ orpc.Input,
) (any, *orpc.Error) {
	vault, err := shared.VaultDeps(deployment.Vault)
	if err != nil {
		return nil, shared.Failure(err)
	}
	servers := []Server{}
	err = database.Tenant(ctx, actor, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `SELECT id, "spaceId", slug, name, description, transport,
			endpoint, command, args, "hasArgs", env, files, headers, "secretId", "installId",
			"allSpaces", "allBots", enabled, coalesce("verbatimResults", false), revision,
			"healthStatus", "healthMessage", "healthToolCount", "healthCheckedAt",
			"createdAt", "updatedAt"
			FROM mcp_servers WHERE "userId" = $1 AND ("spaceId" = $2 OR "allSpaces" = true
				OR EXISTS (SELECT 1 FROM mcp_server_spaces s
					WHERE s."serverId" = mcp_servers.id AND s."spaceId" = $2))
			ORDER BY name ASC, "createdAt" ASC`, actor.UserID, actor.SpaceID)
		if err != nil {
			return err
		}
		var found []row
		for rows.Next() {
			var record row
			if err := rows.Scan(&record.id, &record.spaceID, &record.slug, &record.name,
				&record.description, &record.transport, &record.endpoint, &record.command,
				&record.args, &record.hasArgs, &record.env, &record.files, &record.headers,
				&record.secretID, &record.installID, &record.allSpaces, &record.allBots,
				&record.enabled, &record.verbatim, &record.revision, &record.healthStatus,
				&record.healthMessage, &record.healthToolCount, &record.healthCheckedAt,
				&record.createdAt, &record.updatedAt); err != nil {
				rows.Close()
				return err
			}
			found = append(found, record)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}
		ids := make([]string, 0, len(found))
		secretIDs := make([]string, 0, len(found))
		for _, record := range found {
			ids = append(ids, record.id)
			if record.secretID != nil {
				secretIDs = append(secretIDs, *record.secretID)
			}
		}
		availableIn := map[string][]string{}
		if len(ids) > 0 {
			spaceRows, err := tx.Query(ctx, `SELECT "serverId", "spaceId" FROM mcp_server_spaces
				WHERE "serverId" = ANY($1)`, ids)
			if err != nil {
				return err
			}
			for spaceRows.Next() {
				var serverID, spaceID string
				if err := spaceRows.Scan(&serverID, &spaceID); err != nil {
					spaceRows.Close()
					return err
				}
				availableIn[serverID] = append(availableIn[serverID], spaceID)
			}
			spaceRows.Close()
			if err := spaceRows.Err(); err != nil {
				return err
			}
		}
		ciphertexts := map[string]string{}
		if len(secretIDs) > 0 {
			secretRows, err := tx.Query(ctx, `SELECT id, ciphertext FROM secrets
				WHERE id = ANY($1) AND "userId" = $2 AND ("spaceId" = $3 OR "spaceId" IS NULL)`,
				secretIDs, actor.UserID, actor.SpaceID)
			if err != nil {
				return err
			}
			for secretRows.Next() {
				var id, ciphertext string
				if err := secretRows.Scan(&id, &ciphertext); err != nil {
					secretRows.Close()
					return err
				}
				ciphertexts[id] = ciphertext
			}
			secretRows.Close()
			if err := secretRows.Err(); err != nil {
				return err
			}
		}
		for _, record := range found {
			summary := oauthSummary{status: "none"}
			if record.secretID != nil {
				if ciphertext, ok := ciphertexts[*record.secretID]; ok {
					summary = summarizeMaterial(vault, ctx, ciphertext, *record.secretID)
				}
			}
			spaceIDs := []string{record.spaceID}
			for _, spaceID := range availableIn[record.id] {
				if spaceID != record.spaceID {
					spaceIDs = append(spaceIDs, spaceID)
				}
			}
			// The router parses this output: values a stored row can break are 500s, as in TS.
			switch record.transport {
			case "streamable_http", "sse", "stdio":
			default:
				return shared.OutputInvalid()
			}
			if record.revision <= 0 {
				return shared.OutputInvalid()
			}
			if record.endpoint != nil {
				parsed, err := url.Parse(*record.endpoint)
				if err != nil || parsed.Scheme == "" || parsed.Host == "" {
					return shared.OutputInvalid()
				}
			}
			if record.healthToolCount != nil && *record.healthToolCount < 0 {
				return shared.OutputInvalid()
			}
			server := Server{
				ID:              record.id,
				SpaceID:         record.spaceID,
				InstallID:       record.installID,
				Slug:            record.slug,
				Name:            record.name,
				Description:     record.description,
				Transport:       record.transport,
				Endpoint:        record.endpoint,
				Command:         record.command,
				HasArgs:         record.hasArgs || len(legacyArgs(record.args)) > 0,
				EnvKeys:         objectKeys(record.env),
				FileKeys:        objectKeys(record.files),
				HeaderKeys:      objectKeys(record.headers),
				HasSecret:       record.secretID != nil && summary.credential,
				OAuthStatus:     summary.status,
				OAuthClientID:   summary.clientID,
				Health:          healthDTO(record),
				Enabled:         record.enabled,
				VerbatimResults: record.verbatim,
				Revision:        record.revision,
				Availability:    Availability{AllSpaces: record.allSpaces, SpaceIDs: spaceIDs},
				AllBots:         record.allBots,
				CreatedAt:       record.createdAt.UTC().Format(shared.ISOMillis),
				UpdatedAt:       record.updatedAt.UTC().Format(shared.ISOMillis),
			}
			servers = append(servers, server)
		}
		return nil
	})
	if err != nil {
		return nil, shared.Failure(err)
	}
	return servers, nil
}

type oauthSummary struct {
	status     string
	clientID   *string
	credential bool
}

// summarizeMaterial is McpOAuthBroker.summaryForCiphertext: JSON material, or an empty one when
// the value cannot be read; the shipped reader rethrows only an unavailable store, which the
// local store does not have.
func summarizeMaterial(vault *shared.SecretVault, ctx context.Context, ciphertext, recordID string) oauthSummary {
	plaintext, err := vault.Writer.Load(ctx, ciphertext, recordID)
	if err != nil {
		if err == secretstore.ErrRemoteUnsupported {
			return oauthSummary{status: "none"}
		}
		return oauthSummary{status: "none"}
	}
	var material map[string]any
	if err := json.Unmarshal([]byte(plaintext), &material); err != nil || material == nil {
		material = map[string]any{}
	}
	summary := oauthSummary{status: "none"}
	if oauth, ok := material["oauth"].(map[string]any); ok {
		if tokens, present := oauth["tokens"]; present && tokens != nil {
			summary.status = "connected"
		} else {
			summary.status = "reconnect"
		}
	}
	if client, ok := material["oauthClient"].(map[string]any); ok {
		if id, ok := client["client_id"].(string); ok {
			summary.clientID = &id
		}
	}
	secret, _ := material["secret"].(string)
	summary.credential = secret != "" ||
		arrayLength(material["args"]) > 0 ||
		len(objectKeysRaw(material["env"])) > 0 ||
		len(objectKeysRaw(material["files"])) > 0 ||
		len(objectKeysRaw(material["headers"])) > 0 ||
		material["oauthClient"] != nil ||
		material["oauth"] != nil
	return summary
}

func arrayLength(value any) int {
	if items, ok := value.([]any); ok {
		return len(items)
	}
	return 0
}

func objectKeys(raw []byte) []string {
	// Object.keys preserves the JSON document's key order; a Go map would not.
	decoder := json.NewDecoder(bytes.NewReader(raw))
	token, err := decoder.Token()
	if err != nil {
		return []string{}
	}
	if delimiter, ok := token.(json.Delim); !ok || delimiter != '{' {
		return []string{}
	}
	keys := []string{}
	for decoder.More() {
		token, err := decoder.Token()
		if err != nil {
			return []string{}
		}
		key, ok := token.(string)
		if !ok {
			return []string{}
		}
		var skip json.RawMessage
		if err := decoder.Decode(&skip); err != nil {
			return []string{}
		}
		keys = append(keys, key)
	}
	return keys
}

func objectKeysRaw(value any) []string {
	object, ok := value.(map[string]any)
	if !ok {
		return []string{}
	}
	keys := make([]string, 0, len(object))
	for key := range object {
		keys = append(keys, key)
	}
	return keys
}

func legacyArgs(raw []byte) []string {
	var value any
	if len(raw) == 0 || json.Unmarshal(raw, &value) != nil {
		return nil
	}
	items, ok := value.([]any)
	if !ok {
		return nil
	}
	args := make([]string, 0, len(items))
	for _, item := range items {
		if text, ok := item.(string); ok {
			args = append(args, text)
		}
	}
	return args
}

func healthDTO(record row) Health {
	status := record.healthStatus
	switch status {
	case "unknown", "installing", "ok", "error":
	default:
		status = "unknown"
	}
	health := Health{
		Status:    status,
		Message:   record.healthMessage,
		ToolCount: record.healthToolCount,
	}
	if status == "error" && record.healthMessage != nil &&
		strings.Contains(*record.healthMessage, dynamicRegistrationUnsupported) {
		code := oauthClientRequired
		health.Code = &code
	}
	if record.healthCheckedAt != nil {
		checked := record.healthCheckedAt.UTC().Format(shared.ISOMillis)
		health.CheckedAt = &checked
	}
	return health
}
