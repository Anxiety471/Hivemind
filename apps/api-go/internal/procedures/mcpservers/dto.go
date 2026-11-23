package mcpservers

// The MCP server DTO and its OAuth summary, shared by every procedure that returns a server
// (mcp.servers.list, mcp.servers.agents) or reads the sealed material (mcp.oauth.disconnect).

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"strconv"
	"strings"
	"time"
	"unicode/utf16"

	"github.com/jackc/pgx/v5"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/orpc"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/shared"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/secretstore"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/validate"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/whatwgurl"
)

// Record is one mcp_servers row as the DTO reads it.
type Record struct {
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

// OAuthSummary is McpOAuthSummary (mcp-oauth.ts:1200-1206): what the settings UI may know about
// a server's OAuth setup; never a credential.
type OAuthSummary struct {
	Status     string
	ClientID   *string
	Credential bool
}

// ServerDTO is mcpServerDto (integrations/mcp-servers.ts:24-74) followed by the output-schema
// checks the router applies to every handler's result.
func ServerDTO(record Record, spaceIDs []string, summary OAuthSummary) (Server, *orpc.Error) {
	// The router parses this output: values a stored row can break are 500s, as in TS.
	switch record.transport {
	case "streamable_http", "sse", "stdio":
	default:
		return Server{}, shared.OutputInvalid()
	}
	if record.revision <= 0 {
		return Server{}, shared.OutputInvalid()
	}
	if record.id == "" || record.spaceID == "" {
		return Server{}, shared.OutputInvalid()
	}
	// endpoint is z.string().url() (contracts/integrations/mcp.ts:283): the WHATWG/zod matcher,
	// which accepts scheme-only URLs, refuses out-of-range ports and stores the trimmed value.
	endpoint := record.endpoint
	if endpoint != nil {
		value, ok := whatwgurl.ZodURLValue(*endpoint)
		if !ok {
			return Server{}, shared.OutputInvalid()
		}
		endpoint = &value
	}
	if record.healthToolCount != nil && *record.healthToolCount < 0 {
		return Server{}, shared.OutputInvalid()
	}
	// installId is Id.nullable().optional(): a stored empty string breaks it.
	if record.installID != nil && *record.installID == "" {
		return Server{}, shared.OutputInvalid()
	}
	return Server{
		ID:              record.id,
		SpaceID:         record.spaceID,
		InstallID:       record.installID,
		Slug:            record.slug,
		Name:            record.name,
		Description:     record.description,
		Transport:       record.transport,
		Endpoint:        endpoint,
		Command:         record.command,
		HasArgs:         record.hasArgs || len(legacyArgs(record.args)) > 0,
		EnvKeys:         objectKeys(record.env),
		FileKeys:        objectKeys(record.files),
		HeaderKeys:      objectKeys(record.headers),
		HasSecret:       record.secretID != nil && summary.Credential,
		OAuthStatus:     summary.Status,
		OAuthClientID:   summary.ClientID,
		Health:          healthDTO(record),
		Enabled:         record.enabled,
		VerbatimResults: record.verbatim,
		Revision:        record.revision,
		Availability:    Availability{AllSpaces: record.allSpaces, SpaceIDs: spaceIDs},
		AllBots:         record.allBots,
		CreatedAt:       record.createdAt.UTC().Format(shared.ISOMillis),
		UpdatedAt:       record.updatedAt.UTC().Format(shared.ISOMillis),
	}, nil
}

// SummarizeMaterial is McpOAuthBroker.summaryForCiphertext: JSON material, or an empty one when
// the value cannot be read. An unavailable store is rethrown (the shipped reader does the same):
// the local store has none except an `infisical:` ref, which this build cannot serve.
func SummarizeMaterial(vault *shared.SecretVault, ctx context.Context, ciphertext, recordID string) (OAuthSummary, error) {
	material, err := ReadMaterial(vault, ctx, ciphertext, recordID)
	if err != nil {
		return OAuthSummary{}, err
	}
	return Summarize(material)
}

// ReadMaterial is McpOAuthBroker.read (mcp-oauth.ts:1975-1985): the stored JSON, or an empty
// object when the value is not one. The decoded value keeps JavaScript's key order so a caller
// that writes it back reproduces JSON.stringify byte for byte; an array stays an array, which is
// what `typeof value === "object"` accepted in the shipped reader.
func ReadMaterial(vault *shared.SecretVault, ctx context.Context, ciphertext, recordID string) (any, error) {
	plaintext, err := vault.Writer.Load(ctx, ciphertext, recordID)
	if err != nil {
		if errors.Is(err, secretstore.ErrRemoteUnsupported) {
			return nil, err
		}
		return EmptyMaterial(), nil
	}
	value, err := validate.DecodeAny([]byte(plaintext))
	if err != nil || value == nil {
		return EmptyMaterial(), nil
	}
	switch value.(type) {
	case *validate.Object, []any:
		return value, nil
	}
	return EmptyMaterial(), nil
}

// EmptyMaterial is `{}`: a new material for a server with no readable secret.
func EmptyMaterial() any { return &validate.Object{Keys: []string{}, Values: map[string]any{}} }

// Summarize is McpOAuthBroker.summarize (mcp-oauth.ts:1208-1217).
func Summarize(material any) (OAuthSummary, error) {
	object, _ := material.(*validate.Object)
	summary := OAuthSummary{Status: "none"}
	if object != nil {
		// `material.oauth?.tokens ? "connected" : material.oauth ? "reconnect" : "none"`: a
		// non-object truthy oauth value still reads as reconnect (its .tokens is undefined).
		if oauth, present := object.Values["oauth"]; present && jsTruthy(oauth) {
			summary.Status = "reconnect"
			if tokens, ok := oauth.(*validate.Object); ok {
				if value, present := tokens.Values["tokens"]; present && jsTruthy(value) {
					summary.Status = "connected"
				}
			}
		}
	}
	if object != nil {
		if client, ok := object.Values["oauthClient"].(*validate.Object); ok && jsTruthy(client) {
			if id, present := client.Values["client_id"]; present && id != nil {
				text, ok := id.(string)
				if !ok {
					// oauthClientId is z.string().nullable(): a stored non-string is an output a
					// client cannot receive, so the router would answer 500.
					return OAuthSummary{}, shared.OutputInvalid()
				}
				summary.ClientID = &text
			}
		}
	}
	summary.Credential = hasCredential(material)
	return summary, nil
}

// hasCredential is hasCredential (mcp-oauth.ts:1200-1212): whether the material holds anything
// beyond OAuth bookkeeping. JavaScript truthiness and .length are what the shipped check uses.
func hasCredential(material any) bool {
	object, _ := material.(*validate.Object)
	if object == nil {
		return false
	}
	if jsTruthy(object.Values["secret"]) {
		return true
	}
	if jsLengthTruthy(object.Values["args"]) {
		return true
	}
	for _, key := range []string{"env", "files", "headers"} {
		value, present := object.Values[key]
		if !present || value == nil {
			value = &validate.Object{Keys: []string{}, Values: map[string]any{}}
		}
		if keys := jsKeys(value); len(keys) > 0 {
			return true
		}
	}
	return jsTruthy(object.Values["oauthClient"]) || jsTruthy(object.Values["oauth"])
}

// jsTruthy is Boolean(value) for a decoded JSON value.
func jsTruthy(value any) bool {
	switch typed := value.(type) {
	case nil:
		return false
	case bool:
		return typed
	case string:
		return typed != ""
	case json.Number:
		number, err := typed.Float64()
		return err == nil && number != 0 && !math.IsNaN(number)
	case []any, *validate.Object:
		return true
	}
	return false
}

// jsLengthTruthy is Boolean(value?.length) (mcp-oauth.ts:1208): a string's UTF-16 length, an
// array's length, or an object's own `length` value under JavaScript truthiness. `{"length":"x"}`
// and `{"length":-1}` count as a credential; 0, "", null and a missing length do not.
func jsLengthTruthy(value any) bool {
	switch typed := value.(type) {
	case string:
		return len(utf16.Encode([]rune(typed))) > 0
	case []any:
		return len(typed) > 0
	case *validate.Object:
		length, present := typed.Values["length"]
		return present && jsTruthy(length)
	}
	return false
}

// jsKeys is Object.keys(value): array-index keys ascending first (a string's code units, an
// array's indices), then insertion order, and none for a scalar.
func jsKeys(value any) []string {
	switch typed := value.(type) {
	case string:
		units := utf16.Encode([]rune(typed))
		keys := make([]string, len(units))
		for index := range units {
			keys[index] = itoa(index)
		}
		return keys
	case []any:
		keys := make([]string, len(typed))
		for index := range typed {
			keys[index] = itoa(index)
		}
		return keys
	case *validate.Object:
		return typed.Keys
	}
	return nil
}

func itoa(value int) string {
	if value == 0 {
		return "0"
	}
	digits := [20]byte{}
	position := len(digits)
	for value > 0 {
		position--
		digits[position] = byte('0' + value%10)
		value /= 10
	}
	return string(digits[position:])
}

// materialObject returns the record's material as an object for editing, or nil for an array
// (whose extra properties JSON.stringify never prints).
func materialObject(material any) *validate.Object {
	object, _ := material.(*validate.Object)
	return object
}

// deleteMaterialKey is `delete material.oauth`: the key leaves the object, keeping the order of
// every other key.
func deleteMaterialKey(material any, key string) {
	object := materialObject(material)
	if object == nil {
		return
	}
	if _, present := object.Values[key]; !present {
		return
	}
	delete(object.Values, key)
	keys := make([]string, 0, len(object.Keys))
	for _, existing := range object.Keys {
		if existing != key {
			keys = append(keys, existing)
		}
	}
	object.Keys = keys
}

// raiseGeneration is `nextMaterial.oauthGeneration = (nextMaterial.oauthGeneration ?? 0) + 1`:
// a new key goes last, an existing one keeps its place, and JavaScript's `+` decides the value.
func raiseGeneration(material any) {
	object := materialObject(material)
	if object == nil {
		return
	}
	current, present := object.Values["oauthGeneration"]
	next, _ := jsAddOne(current, present && current != nil)
	object.Values["oauthGeneration"] = next
	if !present {
		object.Keys = append(object.Keys, "oauthGeneration")
	}
}

// jsAddOne is `(value ?? 0) + 1` for a decoded JSON value.
func jsAddOne(value any, present bool) (any, bool) {
	if !present {
		return json.Number("1"), true
	}
	switch typed := value.(type) {
	case json.Number:
		number, err := typed.Float64()
		if err != nil {
			return json.Number("null"), true
		}
		return json.Number(jsNumber(number + 1)), true
	case bool:
		if typed {
			return json.Number("2"), true
		}
		return json.Number("1"), true
	case string:
		return typed + "1", true
	case []any:
		return jsArrayString(typed) + "1", true
	case *validate.Object:
		return "[object Object]1", true
	}
	return json.Number("1"), true
}

// jsArrayString is Array.prototype.toString: elements joined by "," with null and undefined empty.
func jsArrayString(items []any) string {
	parts := make([]string, len(items))
	for index, item := range items {
		switch typed := item.(type) {
		case nil:
			parts[index] = ""
		case string:
			parts[index] = typed
		case json.Number:
			parts[index] = typed.String()
		case bool:
			if typed {
				parts[index] = "true"
			} else {
				parts[index] = "false"
			}
		case []any:
			parts[index] = jsArrayString(typed)
		case *validate.Object:
			parts[index] = "[object Object]"
		}
	}
	joined := ""
	for index, part := range parts {
		if index > 0 {
			joined += ","
		}
		joined += part
	}
	return joined
}

// jsNumber prints a number as Number.prototype.toString does for the integers a generation can
// hold; anything larger keeps the decimal form JavaScript switches to at 1e21.
func jsNumber(value float64) string {
	if math.IsInf(value, 0) || math.IsNaN(value) {
		return "null"
	}
	if value == 0 {
		return "0"
	}
	if math.Abs(value) < 1e21 {
		return strconv.FormatFloat(value, 'f', -1, 64)
	}
	text := strconv.FormatFloat(value, 'e', -1, 64)
	return strings.Replace(text, "e+", "e", 1)
}

// serverColumns is every mcp_servers column the DTO reads, in scanRecord's order.
const serverColumns = `id, "spaceId", slug, name, description, transport,
	endpoint, command, args, "hasArgs", env, files, headers, "secretId", "installId",
	"allSpaces", "allBots", enabled, coalesce("verbatimResults", false), revision,
	"healthStatus", "healthMessage", "healthToolCount", "healthCheckedAt",
	"createdAt", "updatedAt"`

// serverAvailable is availableInSpace for a query on mcp_servers: $1 is the actor's Space and $2
// the actor. A server is visible when the member added it in this Space, made it available in
// every Space, or shared it with this one.
const serverAvailable = `"userId" = $2 AND ("spaceId" = $1 OR "allSpaces" = true
	OR EXISTS (SELECT 1 FROM mcp_server_spaces s
		WHERE s."serverId" = mcp_servers.id AND s."spaceId" = $1))`

// scanRecord reads one serverColumns row.
func scanRecord(rows pgx.Rows) (Record, error) {
	var record Record
	err := rows.Scan(&record.id, &record.spaceID, &record.slug, &record.name,
		&record.description, &record.transport, &record.endpoint, &record.command,
		&record.args, &record.hasArgs, &record.env, &record.files, &record.headers,
		&record.secretID, &record.installID, &record.allSpaces, &record.allBots,
		&record.enabled, &record.verbatim, &record.revision, &record.healthStatus,
		&record.healthMessage, &record.healthToolCount, &record.healthCheckedAt,
		&record.createdAt, &record.updatedAt)
	return record, err
}

// spaceIDsFor is spaceAvailability's list: the Space it was added in first, then every further
// Space it is shared with, in the order the join rows come back (as Prisma's include does).
func spaceIDsFor(ctx context.Context, tx pgx.Tx, record Record) ([]string, error) {
	rows, err := tx.Query(ctx, `SELECT "spaceId" FROM mcp_server_spaces WHERE "serverId" = $1`,
		record.id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	spaceIDs := []string{record.spaceID}
	for rows.Next() {
		var spaceID string
		if err := rows.Scan(&spaceID); err != nil {
			return nil, err
		}
		if spaceID != record.spaceID {
			spaceIDs = append(spaceIDs, spaceID)
		}
	}
	return spaceIDs, rows.Err()
}
