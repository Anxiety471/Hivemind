package vaultstore

// The six vault writes (apps/api/src/routes/bots.ts:846-921):
//
//	agentSecrets.put     bots.ts:848-850   the Space owner's command variables
//	agentSecrets.remove  bots.ts:851-853   one of them, by item name
//	botSecrets.put       bots.ts:914-917   a credential of the vault this Space uses
//	botSecrets.remove    bots.ts:918-921   one of them, after the bot gate
//	vault.put            bots.ts:864-866   the owner's vault, account or Space
//	vault.remove         bots.ts:903-908   one item of it
//
// Every one of them records an AUDITED_PROCEDURES security event
// (security-audit.ts:36-55), and the metadata of botSecrets.*/vault.*/agentSecrets.remove
// carries a user-supplied name. The TypeScript redactor rewrites some of those
// (packages/logging/src/redaction.ts), so a request whose audited values the gate cannot prove
// unchanged is declined (local.ErrDecline) before anything is written: TypeScript serves it.

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/effects"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/local"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/orpc"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/agentsecrets"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/shared"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/spacesettings"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/vaultitems"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/secretstore"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/validate"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/wtf8"
)

// ownerRequired is SpaceOwnerRequiredError (packages/db/src/spaces/space-members.ts:43-48).
var ownerRequired = orpc.Forbidden("Only the space owner can do that")

// answered turns a refusal or any other error into the response the API gives.
func answered(err error) *orpc.Error {
	if refusal, ok := asRefusal(err); ok {
		return orpc.New(refusal.code, refusal.status, refusal.message)
	}
	return shared.Failure(err)
}

// audited records the procedure's AUDITED_PROCEDURES event after its write, as the API's
// middleware does (security-audit.ts:163-186); a failed audit write never fails the request.
func audited(ctx context.Context, deployment shared.Deployment, actor db.Actor, eventType, targetType string, metadata []effects.Meta) {
	if deployment.Audit == nil {
		return
	}
	_ = deployment.Audit.Record(ctx, effects.SecurityEvent{
		Type: eventType, UserID: actor.UserID, SpaceID: actor.SpaceID, Metadata: metadata,
	})
}

// gate declines the request when an audited metadata value is not provably unchanged by the
// TypeScript redactor. The values are exactly the AUDITED_PROCEDURES fields of this procedure.
func gate(values ...string) *orpc.Error {
	for _, value := range values {
		if !effects.AuditedMetadataServable(value) {
			return local.ErrDecline
		}
	}
	return nil
}

// newWriter builds the writer every entry point shares, or the failure a process without a
// credential store answers.
func newWriter(ctx context.Context, database *db.DB, deployment shared.Deployment, actor db.Actor, scope string) (*writer, *orpc.Error) {
	vault, err := shared.VaultDeps(deployment.Vault)
	if err != nil {
		return nil, shared.Failure(err)
	}
	// A nil ring means this build has no content keys: SealVaultValue then writes the legacy
	// form, as sealVaultValue does when its deployment has none.
	return &writer{database: database, vault: vault, ring: deployment.Content, actor: actor, scope: scope}, nil
}

// requireSpaceOwner is requireSpaceOwner (space-members.ts:104-113).
func requireSpaceOwner(ctx context.Context, database *db.DB, actor db.Actor) *orpc.Error {
	owner := false
	err := database.Tenant(ctx, actor, func(tx pgx.Tx) error {
		var role string
		err := tx.QueryRow(ctx, `SELECT role FROM space_members WHERE "spaceId" = $1 AND "userId" = $2`,
			actor.SpaceID, actor.UserID).Scan(&role)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		if err != nil {
			return err
		}
		owner = shared.IsOwnerRole(role)
		return nil
	})
	if err != nil {
		return shared.Failure(err)
	}
	if !owner {
		return ownerRequired
	}
	return nil
}

// ---- inputs ------------------------------------------------------------------------------

// scopeField is settingsScopeInput's optional enum, in schema order before anything else.
func scopeField(object *validate.Object) (scope string, hasScope bool, issues []validate.Issue) {
	raw, present := object.Get("scope")
	if !present {
		return "", false, nil
	}
	value, problems := validate.Enum(validate.Path{"scope"}, raw, "account", "space")
	if problems != nil {
		return "", false, problems
	}
	return value, true, nil
}

// parseAgentPut is AgentSecretInputSchema (packages/contracts/src/bots/bot.ts:19-22): a name
// trimmed then matched against AGENT_SECRET_NAME_PATTERN, and a value of 1..16384 units.
func parseAgentPut(raw orpc.Input) (name, value string, issues []validate.Issue) {
	object, problems := validate.Decode(raw.Raw, nil)
	if problems != nil {
		return "", "", problems
	}
	name, found := validate.String(validate.Path{"name"}, object.Field("name"),
		validate.StringRules{Trim: true})
	if found == nil && !agentNamePatternRegex.MatchString(name) {
		found = []validate.Issue{regexIssue(validate.Path{"name"}, agentNameSource, regexMessage(agentNameSource))}
	}
	issues = append(issues, found...)
	value, found = validate.String(validate.Path{"value"}, object.Field("value"),
		validate.StringRules{Min: 1, Max: secretValueMax})
	issues = append(issues, found...)
	return name, value, issues
}

// parseAgentRemove is z.object({ id: Id }) (bots-rpc.ts:201).
func parseAgentRemove(raw orpc.Input) (string, *orpc.Error) {
	values, failure := shared.IDFields(raw, "id")
	if failure != nil {
		return "", failure
	}
	return values["id"], nil
}

// parseBotPut is BotSecretPutInput (bot-secrets.ts:735-739): botId, the structural destination,
// and a value of 1..16384 units.
func parseBotPut(raw orpc.Input) (botID string, destination Destination, value string, issues []validate.Issue) {
	object, problems := validate.Decode(raw.Raw, nil)
	if problems != nil {
		return "", Destination{}, "", problems
	}
	botID, found := validate.String(validate.Path{"botId"}, object.Field("botId"),
		validate.StringRules{Min: 1})
	issues = append(issues, found...)
	var destinationIssues []validate.Issue
	destination, _, destinationIssues = parseDestinationInput(object.Field("destination"),
		validate.Path{"destination"}, false)
	issues = append(issues, destinationIssues...)
	value, found = validate.String(validate.Path{"value"}, object.Field("value"),
		validate.StringRules{Min: 1, Max: secretValueMax})
	issues = append(issues, found...)
	return botID, destination, value, issues
}

// parseBotRemove is z.object({ botId: Id, name: StoredBotSecretName }) (bots-rpc.ts:919-921).
func parseBotRemove(raw orpc.Input) (botID, name string, issues []validate.Issue) {
	object, problems := validate.Decode(raw.Raw, nil)
	if problems != nil {
		return "", "", problems
	}
	botID, found := validate.String(validate.Path{"botId"}, object.Field("botId"),
		validate.StringRules{Min: 1})
	issues = append(issues, found...)
	name, found = validate.String(validate.Path{"name"}, object.Field("name"),
		validate.StringRules{Min: 1, Max: 256})
	issues = append(issues, found...)
	return botID, name, issues
}

// scopeAndName is settingsScopeInput.extend({ name: StoredBotSecretName }) (bots-rpc.ts:212-214).
func scopeAndName(raw orpc.Input) (scope string, hasScope bool, name string, issues []validate.Issue) {
	object, problems := validate.Decode(raw.Raw, nil)
	if problems != nil {
		return "", false, "", problems
	}
	scope, hasScope, found := scopeField(object)
	issues = append(issues, found...)
	name, found = validate.String(validate.Path{"name"}, object.Field("name"),
		validate.StringRules{Min: 1, Max: 256})
	issues = append(issues, found...)
	return scope, hasScope, name, issues
}

// vaultPutInput is VaultPutInput (bot-secrets.ts:818-846).
type vaultPutInput struct {
	destination Destination
	hasName     bool
	value       string
	hasValue    bool
	changes     custom
}

// parseVaultPut validates VaultPutInput in its schema order: scope, destination, value, title,
// note, policy, allBots, botIds, alsoOn.
func parseVaultPut(raw orpc.Input) (scope string, hasScope bool, input vaultPutInput, issues []validate.Issue) {
	object, problems := validate.Decode(raw.Raw, nil)
	if problems != nil {
		return "", false, vaultPutInput{}, problems
	}
	scope, hasScope, found := scopeField(object)
	issues = append(issues, found...)
	var destinationIssues []validate.Issue
	input.destination, input.hasName, destinationIssues = parseDestinationInput(
		object.Field("destination"), validate.Path{"destination"}, true)
	issues = append(issues, destinationIssues...)
	{
		if _, present := object.Get("value"); present {
			input.value, found = validate.String(validate.Path{"value"}, object.Field("value"),
				validate.StringRules{Min: 1, Max: secretValueMax})
			input.hasValue = true
			issues = append(issues, found...)
		}
	}
	{
		if _, present := object.Get("title"); present {
			title, problems := validate.String(validate.Path{"title"}, object.Field("title"),
				validate.StringRules{Trim: true, Max: 80})
			issues = append(issues, problems...)
			input.changes.title = &title
		}
		if _, present := object.Get("note"); present {
			note, problems := validate.String(validate.Path{"note"}, object.Field("note"),
				validate.StringRules{Trim: true, Max: 200})
			issues = append(issues, problems...)
			input.changes.note = &note
		}
		if _, present := object.Get("policy"); present {
			policy, problems := validate.Enum(validate.Path{"policy"}, object.Field("policy"),
				"allow", "off", "ask")
			issues = append(issues, problems...)
			input.changes.policy = &policy
		}
		bots := &botsInput{}
		changed := false
		if _, present := object.Get("allBots"); present {
			allBots, problems := validate.Boolean(validate.Path{"allBots"}, object.Field("allBots"))
			issues = append(issues, problems...)
			bots.allBots = &allBots
			changed = true
		}
		if _, present := object.Get("botIds"); present {
			botIDs, problems := stringArray(validate.Path{"botIds"}, object.Field("botIds"), 100, 1, 0)
			issues = append(issues, problems...)
			bots.botIDs, bots.hasIDs = botIDs, true
			changed = true
		}
		if changed {
			input.changes.bots = bots
		}
		if _, present := object.Get("alsoOn"); present {
			sites, problems := stringArray(validate.Path{"alsoOn"}, object.Field("alsoOn"), 10, 0, 2048)
			issues = append(issues, problems...)
			input.changes.alsoOn, input.changes.hasAlsoOn = sites, true
		}
	}
	return scope, hasScope, input, issues
}

// stringArray is z.array(z.string().max(elementMax)).max(maxItems) with the element min
// (Id's min(1)) applied when minElement is set.
func stringArray(path validate.Path, raw any, maxItems, minElement, elementMax int) ([]string, []validate.Issue) {
	items, ok := raw.([]any)
	if !ok {
		issues := []validate.Issue{validate.TypeIssue("array", validate.JSType(raw), path)}
		if length, origin, has := arrayLength(raw); has {
			if !(length <= float64(maxItems)) {
				issues = append(issues, validate.Issue{
					"origin": origin, "code": "too_big", "maximum": maxItems, "inclusive": true,
					"path":    path.Raw(),
					"message": "Too big: expected " + origin + " to have <=" + itoa(maxItems) + " characters",
				})
			}
		}
		return nil, issues
	}
	var issues []validate.Issue
	if len(items) > maxItems {
		issues = append(issues, validate.Issue{
			"origin": "array", "code": "too_big", "maximum": maxItems, "inclusive": true,
			"path":    path.Raw(),
			"message": "Too big: expected array to have <=" + itoa(maxItems) + " items",
		})
	}
	values := make([]string, 0, len(items))
	for index, item := range items {
		value, problems := validate.String(path.With(index), item,
			validate.StringRules{Min: minElement, Max: elementMax})
		issues = append(issues, problems...)
		if problems != nil {
			continue
		}
		values = append(values, value)
	}
	return values, issues
}

// arrayLength is `raw.length` for the too_big check zod runs on a non-array with a length.
func arrayLength(raw any) (float64, string, bool) {
	switch value := raw.(type) {
	case string:
		return float64(wtf8.Length(value)), "string", true
	case []any:
		return float64(len(value)), "array", true
	}
	return 0, "", false
}

// ---- procedures ---------------------------------------------------------------------------

// AgentPut implements agentSecrets.put (apps/api/src/bots/agent-secrets.ts:52-84).
func AgentPut(ctx context.Context, database *db.DB, deployment shared.Deployment, actor db.Actor, raw orpc.Input) (any, *orpc.Error) {
	name, value, issues := parseAgentPut(raw)
	if issues != nil {
		return nil, validate.Fail(issues)
	}
	if failure := requireSpaceOwner(ctx, database, actor); failure != nil {
		return nil, failure
	}
	w, failure := newWriter(ctx, database, deployment, actor, "")
	if failure != nil {
		return nil, failure
	}
	existing, err := w.commandItemNamed(ctx, name)
	if err != nil {
		return nil, answered(err)
	}
	itemName := casesLower(name)
	if existing != "" {
		itemName = existing
	}
	if !botSecretName.MatchString(itemName) {
		return nil, orpc.BadRequest("Variable names must start with a letter")
	}
	record, err := w.storeBotSecret(ctx, Destination{Name: itemName, Auth: Auth{Type: "command"}},
		value, false, custom{})
	if err != nil {
		return nil, answered(err)
	}
	if record == nil {
		return nil, orpc.Conflict("Variable was not saved")
	}
	audited(ctx, deployment, actor, "credential.changed", "agent_secret", []effects.Meta{
		{Key: "procedure", Value: "agentSecrets.put"}, {Key: "kind", Value: "agent_secret"},
	})
	return agentSecretDTO(record), nil
}

// commandItemNamed is putAgentSecret's lookup (agent-secrets.ts:64-70): the saved command
// variable this name exports, if any.
func (w *writer) commandItemNamed(ctx context.Context, variable string) (string, error) {
	found := ""
	err := w.database.Tenant(ctx, w.actor, func(tx pgx.Tx) error {
		fields, err := w.fieldsFor(ctx, tx)
		if err != nil {
			return err
		}
		rows, err := tx.Query(ctx, `SELECT name, auth FROM vault_credentials
			WHERE "userId" = $1 AND "spaceId" IS NOT DISTINCT FROM $2::text
			ORDER BY name ASC`, fields.userID, fields.spaceID)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var name string
			var auth []byte
			if err := rows.Scan(&name, &auth); err != nil {
				return err
			}
			stored, ok := authFromJSON(auth)
			if !ok || stored.Type != "command" {
				continue
			}
			if agentsecrets.CommandVariableName(name) != variable {
				continue
			}
			found = name
			return nil
		}
		return rows.Err()
	})
	return found, err
}

// agentSecretDTO is agentSecretDto (agent-secrets.ts:34-42).
func agentSecretDTO(record *row) map[string]any {
	return map[string]any{
		"id":        record.name,
		"name":      agentsecrets.CommandVariableName(record.name),
		"createdAt": shared.ISO(record.createdAt),
		"updatedAt": shared.ISO(record.updatedAt),
	}
}

// AgentRemove implements agentSecrets.remove (agent-secrets.ts:86-99).
func AgentRemove(ctx context.Context, database *db.DB, deployment shared.Deployment, actor db.Actor, raw orpc.Input) (any, *orpc.Error) {
	id, failure := parseAgentRemove(raw)
	if failure != nil {
		return nil, failure
	}
	if failure := gate(id); failure != nil {
		return nil, failure
	}
	if failure := requireSpaceOwner(ctx, database, actor); failure != nil {
		return nil, failure
	}
	w, failure := newWriter(ctx, database, deployment, actor, "")
	if failure != nil {
		return nil, failure
	}
	record, err := w.metadataNamed(ctx, id)
	if err != nil {
		return nil, answered(err)
	}
	if record == nil {
		return nil, orpc.NotFound("Not Found")
	}
	if stored, ok := authFromJSON(record.auth); !ok || stored.Type != "command" {
		return nil, orpc.NotFound("Not Found")
	}
	if err := w.forget(ctx, id); err != nil {
		return nil, answered(err)
	}
	audited(ctx, deployment, actor, "credential.deleted", "agent_secret", []effects.Meta{
		{Key: "procedure", Value: "agentSecrets.remove"}, {Key: "kind", Value: "agent_secret"},
		{Key: "id", Value: id},
	})
	return map[string]any{"ok": true}, nil
}

// metadataNamed is getBotSecretMetadata (bot-secrets.ts:1509-1522).
func (w *writer) metadataNamed(ctx context.Context, name string) (*row, error) {
	var found *row
	err := w.database.Tenant(ctx, w.actor, func(tx pgx.Tx) error {
		fields, err := w.fieldsFor(ctx, tx)
		if err != nil {
			return err
		}
		found, err = findRow(ctx, tx, fields, name, false)
		return err
	})
	return found, err
}

// forget is forgetBotSecret (bot-secrets.ts:1541-1553): the row goes under the vault lock, and
// the hook captures and cleans the reference it held.
func (w *writer) forget(ctx context.Context, name string) error {
	state := w.vault.Persistence.NewState()
	err := w.database.Tenant(ctx, w.actor, func(tx pgx.Tx) error {
		if err := lockVault(ctx, tx, w.actor); err != nil {
			return err
		}
		fields, err := w.fieldsFor(ctx, tx)
		if err != nil {
			return err
		}
		if err := w.vault.Persistence.CaptureDropped(ctx, tx, state, secretstore.VaultCredential,
			`SELECT id FROM vault_credentials
			 WHERE "userId" = $1 AND "spaceId" IS NOT DISTINCT FROM $2::text AND name = $3`,
			fields.userID, fields.spaceID, name); err != nil {
			return err
		}
		_, err = tx.Exec(ctx, `DELETE FROM vault_credentials
			WHERE "userId" = $1 AND "spaceId" IS NOT DISTINCT FROM $2::text AND name = $3`,
			fields.userID, fields.spaceID, name)
		return err
	})
	w.vault.Persistence.Finish(ctx, state, err)
	return err
}

// BotPut implements botSecrets.put (apps/api/src/routes/bots.ts:914-917): the bot must be in
// this Space, then the credential goes to the vault this Space uses.
func BotPut(ctx context.Context, database *db.DB, deployment shared.Deployment, actor db.Actor, raw orpc.Input) (any, *orpc.Error) {
	botID, destination, value, issues := parseBotPut(raw)
	if issues != nil {
		return nil, validate.Fail(issues)
	}
	if failure := gate(botID, destination.Name); failure != nil {
		return nil, failure
	}
	if failure := requireBot(ctx, database, actor, botID); failure != nil {
		return nil, failure
	}
	w, failure := newWriter(ctx, database, deployment, actor, "")
	if failure != nil {
		return nil, failure
	}
	answer, failure := saveVaultCredential(ctx, database, w, destination, value)
	if failure != nil {
		return nil, failure
	}
	audited(ctx, deployment, actor, "credential.changed", "bot_secret", []effects.Meta{
		{Key: "procedure", Value: "botSecrets.put"}, {Key: "kind", Value: "bot_secret"},
		{Key: "botId", Value: botID}, {Key: "name", Value: destination.Name},
	})
	return answer, nil
}

// requireBot is repos.getBot's gate: a bot of this Space that is not archived.
func requireBot(ctx context.Context, database *db.DB, actor db.Actor, botID string) *orpc.Error {
	err := database.Tenant(ctx, actor, func(tx pgx.Tx) error {
		return shared.RequireBot(ctx, tx, actor, botID)
	})
	if err != nil {
		return shared.Failure(err)
	}
	return nil
}

// BotRemove implements botSecrets.remove (bots.ts:918-921).
func BotRemove(ctx context.Context, database *db.DB, deployment shared.Deployment, actor db.Actor, raw orpc.Input) (any, *orpc.Error) {
	botID, name, issues := parseBotRemove(raw)
	if issues != nil {
		return nil, validate.Fail(issues)
	}
	if failure := gate(botID, name); failure != nil {
		return nil, failure
	}
	if failure := requireBot(ctx, database, actor, botID); failure != nil {
		return nil, failure
	}
	w, failure := newWriter(ctx, database, deployment, actor, "")
	if failure != nil {
		return nil, failure
	}
	if err := w.forget(ctx, name); err != nil {
		return nil, answered(err)
	}
	audited(ctx, deployment, actor, "credential.deleted", "bot_secret", []effects.Meta{
		{Key: "procedure", Value: "botSecrets.remove"}, {Key: "kind", Value: "bot_secret"},
		{Key: "botId", Value: botID}, {Key: "name", Value: name},
	})
	return map[string]any{"ok": true}, nil
}

// VaultRemove implements vault.remove (bots.ts:903-908).
func VaultRemove(ctx context.Context, database *db.DB, deployment shared.Deployment, actor db.Actor, raw orpc.Input) (any, *orpc.Error) {
	scope, hasScope, name, issues := scopeAndName(raw)
	if issues != nil {
		return nil, validate.Fail(issues)
	}
	gated := []string{name}
	if hasScope {
		gated = append(gated, scope)
	}
	if failure := gate(gated...); failure != nil {
		return nil, failure
	}
	w, failure := newWriter(ctx, database, deployment, actor, scope)
	if failure != nil {
		return nil, failure
	}
	if err := w.forget(ctx, name); err != nil {
		return nil, answered(err)
	}
	metadata := []effects.Meta{
		{Key: "procedure", Value: "vault.remove"}, {Key: "kind", Value: "vault_credential"},
	}
	if hasScope {
		metadata = append(metadata, effects.Meta{Key: "scope", Value: scope})
	}
	metadata = append(metadata, effects.Meta{Key: "name", Value: name})
	audited(ctx, deployment, actor, "credential.deleted", "vault_credential", metadata)
	return map[string]any{"ok": true}, nil
}

// VaultPut implements vault.put (bots.ts:864-866 over saveVaultCredential, bots.ts:88-142).
func VaultPut(ctx context.Context, database *db.DB, deployment shared.Deployment, actor db.Actor, raw orpc.Input) (any, *orpc.Error) {
	scope, hasScope, input, issues := parseVaultPut(raw)
	if issues != nil {
		return nil, validate.Fail(issues)
	}
	gated := []string{}
	if hasScope {
		gated = append(gated, scope)
	}
	if input.hasName {
		gated = append(gated, input.destination.Name)
	}
	if failure := gate(gated...); failure != nil {
		return nil, failure
	}
	w, failure := newWriter(ctx, database, deployment, actor, scope)
	if failure != nil {
		return nil, failure
	}
	if !input.hasValue {
		answer, failure := relabel(ctx, database, w, input)
		if failure != nil {
			return nil, failure
		}
		vaultPutAudited(ctx, deployment, actor, scope, hasScope, input)
		return answer, nil
	}
	// A pasted page URL is saved under its site; one that carries userinfo is left as typed so
	// the origin rule turns it down.
	if site, ok := pageURLOrigin(input.destination.Origin, false, 2048); ok {
		input.destination.Origin = site
	}
	if input.hasName {
		if _, err := w.storeBotSecret(ctx, input.destination, input.value, false, input.changes); err != nil {
			return nil, answered(err)
		}
		answer, failure := itemDTO(ctx, database, w, input.destination.Name)
		if failure != nil {
			return nil, failure
		}
		vaultPutAudited(ctx, deployment, actor, scope, hasScope, input)
		return answer, nil
	}
	base := ""
	if input.changes.title != nil {
		base = *input.changes.title
	}
	if base == "" {
		base = defaultTitle(input.destination, input.value)
	}
	kind := input.destination.Auth.Type
	for attempt := 0; ; attempt++ {
		fresh, err := w.newVaultItemName(ctx, base, kind)
		if err != nil {
			return nil, answered(err)
		}
		destination := input.destination
		destination.Name = fresh
		_, err = w.storeBotSecret(ctx, destination, input.value, true, input.changes)
		if err == nil {
			answer, failure := itemDTO(ctx, database, w, fresh)
			if failure != nil {
				return nil, failure
			}
			vaultPutAudited(ctx, deployment, actor, scope, hasScope, input)
			return answer, nil
		}
		if attempt >= 2 || !isSecretAlreadySaved(err) {
			return nil, answered(err)
		}
	}
}

// vaultPutAudited records vault.put's event, whose fields are the input's scope and name.
func vaultPutAudited(ctx context.Context, deployment shared.Deployment, actor db.Actor, scope string, hasScope bool, input vaultPutInput) {
	metadata := []effects.Meta{
		{Key: "procedure", Value: "vault.put"}, {Key: "kind", Value: "vault_credential"},
	}
	if hasScope {
		metadata = append(metadata, effects.Meta{Key: "scope", Value: scope})
	}
	if input.hasName {
		metadata = append(metadata, effects.Meta{Key: "name", Value: input.destination.Name})
	}
	audited(ctx, deployment, actor, "credential.changed", "vault_credential", metadata)
}

// relabel is relabelVaultItem (bot-secrets.ts:1462-1499) for a save with no value: only the
// labels change, never the value or the destination.
func relabel(ctx context.Context, database *db.DB, w *writer, input vaultPutInput) (any, *orpc.Error) {
	if !input.hasName {
		return nil, orpc.BadRequest("A new item needs its value")
	}
	err := w.database.Tenant(ctx, w.actor, func(tx pgx.Tx) error {
		if err := w.assertVaultInUse(ctx, tx); err != nil {
			return err
		}
		if err := lockVault(ctx, tx, w.actor); err != nil {
			return err
		}
		if err := w.assertVaultInUse(ctx, tx); err != nil {
			return err
		}
		fields, err := w.fieldsFor(ctx, tx)
		if err != nil {
			return err
		}
		current, err := findRow(ctx, tx, fields, input.destination.Name, false)
		if err != nil {
			return err
		}
		if current == nil {
			return orpc.NotFound("Credential not found")
		}
		// A row whose auth no longer parses keeps its labels and bots: relabelVaultItem only asks
		// safeParse for the type, and undefined answers for a damaged row (bot-secrets.ts:1428-1440).
		stored, ok := authFromJSON(current.auth)
		if !ok {
			stored = Auth{}
		}
		if input.changes.policy != nil {
			if err := policyField(stored, input.changes.policy); err != nil {
				return err
			}
		}
		sites, err := alsoOnField(stored, current.origin, input.changes.alsoOn, input.changes.hasAlsoOn)
		if err != nil {
			return err
		}
		assignments := []string{}
		args := []any{}
		if input.changes.title != nil {
			args = append(args, *input.changes.title)
			assignments = append(assignments, "title = $"+itoa(len(args)))
		}
		if input.changes.note != nil {
			args = append(args, *input.changes.note)
			assignments = append(assignments, "note = $"+itoa(len(args)))
		}
		if input.changes.policy != nil {
			args = append(args, *input.changes.policy)
			assignments = append(assignments, "policy = $"+itoa(len(args)))
		}
		if input.changes.hasAlsoOn {
			args = append(args, sites)
			assignments = append(assignments, `"alsoOn" = $`+itoa(len(args)))
		}
		if len(assignments) > 0 {
			args = append(args, time.Now().UTC().Truncate(time.Millisecond))
			dataCount := len(args)
			assignments = append(assignments, `"updatedAt" = $`+itoa(dataCount))
			args = append(args, current.id)
			arguments := append(db.Data(args[:dataCount]...), args[dataCount:]...)
			//writeaudit:dynamic the SET list is built from optional fields; args[:dataCount] is wrapped with db.Data and the suffix holds only the id filter
			if _, err := tx.Exec(ctx, `UPDATE vault_credentials SET `+strings.Join(assignments, ", ")+
				` WHERE id = $`+itoa(len(args)), arguments...); err != nil {
				return err
			}
		}
		return w.saveItemBots(ctx, tx, fields, current.id, input.changes.bots)
	})
	if err != nil {
		return nil, answered(err)
	}
	return itemDTO(ctx, database, w, input.destination.Name)
}

// saveVaultCredential is saveVaultCredential's named-put branch (routes/bots.ts:88-142).
func saveVaultCredential(ctx context.Context, database *db.DB, w *writer, destination Destination, value string) (any, *orpc.Error) {
	if _, err := w.storeBotSecret(ctx, destination, value, false, custom{}); err != nil {
		return nil, answered(err)
	}
	return itemDTO(ctx, database, w, destination.Name)
}

// itemDTO is vaultItemDto (routes/bots.ts:239-243): the item's list metadata after the write.
func itemDTO(ctx context.Context, database *db.DB, w *writer, name string) (any, *orpc.Error) {
	item, found, err := vaultitems.One(ctx, database, w.vault, w.ring, w.actor, w.scope, name)
	if err != nil {
		return nil, answered(err)
	}
	if !found {
		return nil, orpc.Conflict("Credential was not saved")
	}
	return item, nil
}

// VaultReveal implements vault.reveal (bots.ts:867-890): a recent identity confirmation, the
// item's vault resolved, the value opened, and the reveal recorded as a security event before
// the reply. It records its own event, so the gateway never shadows it.
func VaultReveal(ctx context.Context, database *db.DB, deployment shared.Deployment, actor db.Actor, raw orpc.Input) (any, *orpc.Error) {
	scope, hasScope, name, issues := scopeAndName(raw)
	if issues != nil {
		return nil, validate.Fail(issues)
	}
	gated := []string{name}
	if hasScope {
		gated = append(gated, scope)
	}
	if failure := gate(gated...); failure != nil {
		return nil, failure
	}
	if failure := shared.RequireIdentityConfirmation(ctx, database, actor); failure != nil {
		return nil, failure
	}
	w, failure := newWriter(ctx, database, deployment, actor, scope)
	if failure != nil {
		return nil, failure
	}
	resolved := ""
	record, err := func() (*row, error) {
		var found *row
		err := w.database.Tenant(ctx, w.actor, func(tx pgx.Tx) error {
			target, err := w.settingsTarget(ctx, tx)
			if err != nil {
				return err
			}
			resolved = target
			fields, err := w.fieldsForResolved(ctx, tx, target)
			if err != nil {
				return err
			}
			found, err = findRow(ctx, tx, fields, name, false)
			return err
		})
		return found, err
	}()
	if err != nil {
		return nil, answered(err)
	}
	if record == nil {
		return nil, orpc.NotFound("Credential not found")
	}
	identity := secretstore.VaultRow{ID: record.id, UserID: record.userID, SpaceID: record.spaceID}
	plaintext, err := secretstore.OpenVaultValue(ctx, w.ring, w.vault.Writer, identity, record.ciphertext)
	if err != nil {
		return nil, answered(err)
	}
	revealed, err := revealedValue(record, plaintext)
	if err != nil {
		return nil, answered(err)
	}
	if deployment.Audit != nil {
		if err := deployment.Audit.Record(ctx, effects.SecurityEvent{
			Type: "credential.revealed", UserID: actor.UserID, SpaceID: actor.SpaceID,
			Metadata: []effects.Meta{
				{Key: "procedure", Value: "vault.reveal"},
				{Key: "kind", Value: "vault_credential"},
				{Key: "scope", Value: resolved},
				{Key: "name", Value: name},
			},
		}); err != nil {
			return nil, answered(err)
		}
	}
	return revealed, nil
}

// settingsTarget is settingsTarget for the credentials setting.
func (w *writer) settingsTarget(ctx context.Context, tx pgx.Tx) (string, error) {
	return spacesettings.Target(ctx, tx, w.actor, "credentials", w.scope)
}

// fieldsForResolved is vaultFields with the target already resolved.
func (w *writer) fieldsForResolved(ctx context.Context, tx pgx.Tx, target string) (vaultFields, error) {
	if target == "space" {
		id := w.actor.SpaceID
		return vaultFields{userID: w.actor.UserID, spaceID: &id}, nil
	}
	return vaultFields{userID: w.actor.UserID}, nil
}

// revealedValue is revealBotSecret's decode (bot-secrets.ts:1524-1539): a login's fields, a
// card's summary, or the value itself.
func revealedValue(record *row, plaintext string) (any, error) {
	stored, ok := authFromJSON(record.auth)
	if !ok {
		return map[string]any{"value": plaintext}, nil
	}
	switch stored.Type {
	case "login":
		login, err := decodeLogin(plaintext)
		if err != nil {
			// decodeLoginSecret throws a ZodError here, which the API answers as a 500.
			return nil, errors.New("stored login does not parse")
		}
		return login, nil
	case "card":
		card, err := decodeCard(plaintext)
		if err != nil {
			return nil, errors.New("stored card does not parse")
		}
		return map[string]any{"card": card}, nil
	}
	return map[string]any{"value": plaintext}, nil
}
