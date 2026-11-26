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
	"sort"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/orpc"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/shared"
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
	ID                 string       `json:"id"`
	SpaceID            string       `json:"spaceId"`
	InstallID          *string      `json:"installId"`
	Slug               string       `json:"slug"`
	Name               string       `json:"name"`
	Description        string       `json:"description"`
	Transport          string       `json:"transport"`
	Endpoint           *string      `json:"endpoint"`
	Command            *string      `json:"command"`
	HasArgs            bool         `json:"hasArgs"`
	EnvKeys            []string     `json:"envKeys"`
	FileKeys           []string     `json:"fileKeys"`
	HeaderKeys         []string     `json:"headerKeys"`
	HasSecret          bool         `json:"hasSecret"`
	OAuthStatus        string       `json:"oauthStatus"`
	OAuthClientID      *string      `json:"oauthClientId"`
	Health             Health       `json:"health"`
	Enabled            bool         `json:"enabled"`
	VerbatimResults    bool         `json:"verbatimResults"`
	SendCallerIdentity bool         `json:"sendCallerIdentity"`
	Revision           int32        `json:"revision"`
	Availability       Availability `json:"availability"`
	AllBots            bool         `json:"allBots"`
	CreatedAt          string       `json:"createdAt"`
	UpdatedAt          string       `json:"updatedAt"`
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
		//writeaudit:dynamic read: the column list and predicate are the fixed serverColumns/serverAvailable consts
		rows, err := tx.Query(ctx, `SELECT `+serverColumns+` FROM mcp_servers
			WHERE `+serverAvailable+`
			ORDER BY name ASC, "createdAt" ASC`, actor.SpaceID, actor.UserID)
		if err != nil {
			return err
		}
		var found []Record
		for rows.Next() {
			record, err := scanRecord(rows)
			if err != nil {
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
			summary := OAuthSummary{Status: "none"}
			if record.secretID != nil {
				if ciphertext, ok := ciphertexts[*record.secretID]; ok {
					value, err := SummarizeMaterial(vault, ctx, ciphertext, *record.secretID)
					if err != nil {
						// A reference the store cannot serve fails the whole list, as the shipped
						// reader rethrows SecretStoreUnavailable instead of hiding it.
						return err
					}
					summary = value
				}
			}
			spaceIDs := []string{record.spaceID}
			for _, spaceID := range availableIn[record.id] {
				if spaceID != record.spaceID {
					spaceIDs = append(spaceIDs, spaceID)
				}
			}
			server, failure := ServerDTO(record, spaceIDs, summary)
			if failure != nil {
				return failure
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
	return jsPropertyOrder(keys)
}

// jsPropertyOrder is Object.keys' order: array-index keys ascending first, then the rest in
// insertion (document) order.
func jsPropertyOrder(keys []string) []string {
	indices := []string{}
	others := []string{}
	for _, key := range keys {
		if isArrayIndex(key) {
			indices = append(indices, key)
		} else {
			others = append(others, key)
		}
	}
	sort.SliceStable(indices, func(left, right int) bool {
		a, _ := strconv.ParseUint(indices[left], 10, 64)
		b, _ := strconv.ParseUint(indices[right], 10, 64)
		return a < b
	})
	return append(indices, others...)
}

func isArrayIndex(key string) bool {
	if key == "" || (len(key) > 1 && key[0] == '0') {
		return false
	}
	value, err := strconv.ParseUint(key, 10, 64)
	if err != nil || value > 4294967294 {
		return false
	}
	return strconv.FormatUint(value, 10) == key
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

func healthDTO(record Record) Health {
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
