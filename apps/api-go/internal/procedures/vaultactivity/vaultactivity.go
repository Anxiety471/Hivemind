// Package vaultactivity ports vault.activity: where and when a bot used one saved vault item
// (apps/api/src/routes/bots.ts:894-901 over packages/adapters/src/secrets/vault/vault-activity.ts:49-128).
//
// The item is resolved by its name inside the vault this Space uses, which proves the caller owns
// it before the uses are read across organizations under the system context. Uses are audit
// rows; no saved value is opened and nothing is written.
package vaultactivity

import (
	"context"
	"encoding/json"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/orpc"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/shared"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/validate"
)

// limit is VAULT_ACTIVITY_LIMIT (packages/contracts/src/bots/bot-secrets.ts:850).
const limit = 20

var errNotFound = orpc.NotFound("Credential not found")

// Use is VaultUse (packages/contracts/src/bots/bot-secrets.ts:852-857).
type Use struct {
	At      string  `json:"at"`
	BotName string  `json:"botName"`
	Site    *string `json:"site"`
	Chat    *Chat   `json:"chat"`
}

// Chat is the owner's own conversation a use happened in.
type Chat struct {
	Title string `json:"title"`
}

type input struct {
	name  string
	scope *string
}

// parse is settingsScopeInput.extend({ name: StoredBotSecretName }).
func parse(raw orpc.Input) (input, *orpc.Error) {
	var result input
	object, issues := validate.Decode(raw.Raw, nil)
	if issues != nil {
		return result, validate.Fail(issues)
	}
	var found []validate.Issue
	name, problems := validate.String(validate.Path{"name"}, object.Field("name"), validate.StringRules{Min: 1, Max: 256})
	found = append(found, problems...)
	if problems == nil {
		result.name = name
	}
	if value := object.Field("scope"); value != validate.Undefined {
		text, problems := validate.Enum(validate.Path{"scope"}, value, "account", "space")
		found = append(found, problems...)
		if problems == nil {
			result.scope = &text
		}
	}
	if found != nil {
		return result, validate.Fail(found)
	}
	return result, nil
}

// List implements vault.activity.
func List(ctx context.Context, database *db.DB, actor db.Actor, raw orpc.Input) (any, *orpc.Error) {
	parsed, failure := parse(raw)
	if failure != nil {
		return nil, failure
	}
	spaceID, err := vaultSpace(ctx, database, actor, parsed.scope)
	if err != nil {
		return nil, shared.Failure(err)
	}
	itemID, err := itemID(ctx, database, actor, spaceID, parsed.name)
	if err != nil {
		return nil, shared.Failure(err)
	}
	if itemID == "" {
		return nil, errNotFound
	}
	uses := []Use{}
	err = database.System(ctx, "read a vault item's uses for its owner", func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `SELECT "createdAt", "actorId", "actorLabel", "targetLabel",
			"runId", "threadId", metadata FROM audit_events
			WHERE "targetType" = 'vault_credential' AND "targetId" = $1 AND action = 'credential.used'
			ORDER BY "createdAt" DESC, id DESC LIMIT $2`, itemID, limit*2)
		if err != nil {
			return err
		}
		type useRow struct {
			at                  time.Time
			actorID, actorLabel *string
			targetLabel, runID  *string
			threadID            *string
			metadata            json.RawMessage
		}
		var found []useRow
		for rows.Next() {
			var row useRow
			if err := rows.Scan(&row.at, &row.actorID, &row.actorLabel, &row.targetLabel,
				&row.runID, &row.threadID, &row.metadata); err != nil {
				rows.Close()
				return err
			}
			found = append(found, row)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}
		full := func(row useRow) bool { return row.targetLabel != nil }
		key := func(row useRow) string {
			value := []any{row.at.UnixMilli(), row.actorID, row.runID, row.threadID}
			body, _ := json.Marshal(value)
			return string(body)
		}
		twins := map[string]int{}
		for _, row := range found {
			if full(row) {
				twins[key(row)]++
			}
		}
		kept := found[:0]
		for _, row := range found {
			if full(row) {
				kept = append(kept, row)
				continue
			}
			left := twins[key(row)]
			if left > 0 {
				twins[key(row)] = left - 1
			}
			if left == 0 {
				kept = append(kept, row)
			}
		}
		if len(kept) > limit {
			kept = kept[:limit]
		}
		threadIDs := []string{}
		seen := map[string]bool{}
		for _, row := range kept {
			if row.threadID != nil && !seen[*row.threadID] {
				seen[*row.threadID] = true
				threadIDs = append(threadIDs, *row.threadID)
			}
		}
		chats := map[string]string{}
		if len(threadIDs) > 0 {
			titles, err := tx.Query(ctx, `SELECT t.id, COALESCE(g.name, b.name) FROM threads t
				LEFT JOIN chat_groups g ON g.id = t."groupId"
				LEFT JOIN bots b ON b.id = t."botId"
				WHERE t.id = ANY($1) AND t."userId" = $2`, threadIDs, actor.UserID)
			if err != nil {
				return err
			}
			for titles.Next() {
				var id string
				var title *string
				if err := titles.Scan(&id, &title); err != nil {
					titles.Close()
					return err
				}
				if title != nil {
					chats[id] = *title
				}
			}
			titles.Close()
			if err := titles.Err(); err != nil {
				return err
			}
		}
		for _, row := range kept {
			use := Use{At: shared.ISO(row.at)}
			if row.actorLabel != nil {
				use.BotName = *row.actorLabel
			}
			var decoded any
			if len(row.metadata) > 0 {
				_ = json.Unmarshal(row.metadata, &decoded)
			}
			if metadata, ok := decoded.(map[string]any); ok {
				if site, ok := metadata["site"].(string); ok {
					value := site
					use.Site = &value
				}
			}
			if row.threadID != nil {
				if title, ok := chats[*row.threadID]; ok {
					use.Chat = &Chat{Title: title}
				}
			}
			uses = append(uses, use)
		}
		return nil
	})
	if err != nil {
		return nil, shared.Failure(err)
	}
	if !valid(uses) {
		return nil, shared.OutputInvalid()
	}
	return uses, nil
}

// valid is the rest of the router's VaultUse parse: the lengths the database does not enforce.
func valid(uses []Use) bool {
	for _, use := range uses {
		if utf16Len(use.BotName) > 200 {
			return false
		}
		if use.Site != nil && utf16Len(*use.Site) > 2048 {
			return false
		}
	}
	return true
}

func utf16Len(text string) int {
	count := 0
	for _, runeValue := range text {
		if runeValue > 0xffff {
			count += 2
		} else {
			count++
		}
	}
	return count
}

// vaultSpace is vaultFields' settingsTarget call: the vault the Space uses unless the caller
// named one, "space" when the credentials override is on.
func vaultSpace(ctx context.Context, database *db.DB, actor db.Actor, requested *string) (string, error) {
	var spaceID string
	err := database.Tenant(ctx, actor, func(tx pgx.Tx) error {
		if requested != nil {
			if *requested == "space" {
				spaceID = actor.SpaceID
			}
			return nil
		}
		var overridden bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM space_setting_overrides
			WHERE "spaceId" = $1 AND "userId" = $2 AND setting = 'credentials')`,
			actor.SpaceID, actor.UserID).Scan(&overridden); err != nil {
			return err
		}
		if overridden {
			spaceID = actor.SpaceID
		}
		return nil
	})
	return spaceID, err
}

// itemID is vaultItemId: the row of that name in the chosen vault, or "" when there is none.
func itemID(ctx context.Context, database *db.DB, actor db.Actor, spaceID, name string) (string, error) {
	var id string
	err := database.Tenant(ctx, actor, func(tx pgx.Tx) error {
		query := `SELECT id FROM vault_credentials WHERE "userId" = $1 AND "spaceId" IS NULL AND name = $2`
		args := []any{actor.UserID, name}
		if spaceID != "" {
			query = `SELECT id FROM vault_credentials WHERE "userId" = $1 AND "spaceId" = $2 AND name = $3`
			args = []any{actor.UserID, spaceID, name}
		}
		err := tx.QueryRow(ctx, query, args...).Scan(&id)
		if err == pgx.ErrNoRows {
			return nil
		}
		return err
	})
	return id, err
}
