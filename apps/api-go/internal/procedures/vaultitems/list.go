// Package vaultitems ports the vault list reads: vault.list and botSecrets.list. Both return the
// same metadata and previews; botSecrets.list first proves the bot is in the caller's Space.
//
// Previews open the saved value and decode it. A tampered or legacy value that no longer decodes
// is listed without a preview, exactly as itemPreview catches every error; neither call fails for
// one bad row.
package vaultitems

import (
	"context"
	"encoding/json"
	"os"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/contentcrypto"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/orpc"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/shared"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/spacesettings"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/secretstore"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/validate"
)

// Preview is VaultPreview (packages/contracts/src/bots/bot-secrets.ts:880-895).
type Preview struct {
	Username *string        `json:"username,omitempty"`
	OTP      bool           `json:"otp,omitempty"`
	Card     map[string]any `json:"card,omitempty"`
	Contact  map[string]any `json:"contact,omitempty"`
}

// Metadata is BotSecretMetadata: what the owner may see of a saved item, never its value.
type Metadata struct {
	Name      string    `json:"name"`
	Origin    string    `json:"origin"`
	Auth      any       `json:"auth"`
	Title     string    `json:"title"`
	Note      string    `json:"note"`
	Preview   *Preview  `json:"preview,omitempty"`
	Policy    string    `json:"policy"`
	AllBots   bool      `json:"allBots"`
	BotIDs    []string  `json:"botIds"`
	AlsoOn    *[]string `json:"alsoOn,omitempty"`
	CreatedAt string    `json:"createdAt"`
	UpdatedAt string    `json:"updatedAt"`
}

// List implements vault.list (routes/bots.ts:852-860 over bot-secrets.ts:1356-1405).
func List(
	ctx context.Context,
	database *db.DB,
	deployment shared.Deployment,
	actor db.Actor,
	raw orpc.Input,
) (any, *orpc.Error) {
	vault, err := shared.VaultDeps(deployment.Vault)
	if err != nil {
		return nil, shared.Failure(err)
	}
	scope, failure := parseScope(raw)
	if failure != nil {
		return nil, failure
	}
	items, err := list(ctx, database, vault, deployment.Content, actor, scope, "")
	if err != nil {
		return nil, shared.Failure(err)
	}
	return items, nil
}

// ListBotSecrets implements botSecrets.list (routes/bots.ts:909-913): the bot must be in this
// Space and not archived before the actor's default vault is listed.
func ListBotSecrets(
	ctx context.Context,
	database *db.DB,
	deployment shared.Deployment,
	actor db.Actor,
	raw orpc.Input,
) (any, *orpc.Error) {
	vault, err := shared.VaultDeps(deployment.Vault)
	if err != nil {
		return nil, shared.Failure(err)
	}
	object, issues := validate.Decode(raw.Raw, nil)
	if issues != nil {
		return nil, validate.Fail(issues)
	}
	botID, problems := validate.String(validate.Path{"botId"}, object.Field("botId"),
		validate.StringRules{Min: 1})
	if problems != nil {
		return nil, validate.Fail(problems)
	}
	err = database.Tenant(ctx, actor, func(tx pgx.Tx) error {
		return shared.RequireBot(ctx, tx, actor, botID)
	})
	if err != nil {
		return nil, shared.Failure(err)
	}
	items, err := list(ctx, database, vault, deployment.Content, actor, "", "")
	if err != nil {
		return nil, shared.Failure(err)
	}
	return items, nil
}

type row struct {
	id                   string
	name, origin         string
	auth                 []byte
	title, note, policy  string
	alsoOn               []string
	ciphertext           string
	createdAt, updatedAt time.Time
}

func list(
	ctx context.Context,
	database *db.DB,
	vault *shared.SecretVault,
	ring *contentcrypto.KeyRing,
	actor db.Actor,
	requestedScope string,
	name string,
) ([]Metadata, error) {
	items := []Metadata{}
	err := database.Tenant(ctx, actor, func(tx pgx.Tx) error {
		spaceID, err := spaceID(ctx, tx, actor, requestedScope)
		if err != nil {
			return err
		}
		rows, err := tx.Query(ctx, `SELECT id, name, origin, auth, title, note, policy, "alsoOn",
			ciphertext, "createdAt", "updatedAt" FROM vault_credentials
			WHERE "userId" = $1 AND "spaceId" IS NOT DISTINCT FROM $2::text
				AND ($3::text IS NULL OR name = $3)
			ORDER BY name ASC`, actor.UserID, spaceID, nameArg(name))
		if err != nil {
			return err
		}
		var found []row
		for rows.Next() {
			var record row
			if err := rows.Scan(&record.id, &record.name, &record.origin, &record.auth, &record.title,
				&record.note, &record.policy, &record.alsoOn, &record.ciphertext,
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
		ids := make([]string, len(found))
		for index, record := range found {
			ids[index] = record.id
		}
		limited := map[string]bool{}
		chosen := map[string][]string{}
		if len(ids) > 0 {
			limitRows, err := tx.Query(ctx, `SELECT "credentialId" FROM vault_credential_limits
				WHERE "userId" = $1 AND "spaceId" = $2 AND "credentialId" = ANY($3)`,
				actor.UserID, actor.SpaceID, ids)
			if err != nil {
				return err
			}
			for limitRows.Next() {
				var id string
				if err := limitRows.Scan(&id); err != nil {
					limitRows.Close()
					return err
				}
				limited[id] = true
			}
			limitRows.Close()
			if err := limitRows.Err(); err != nil {
				return err
			}
			botRows, err := tx.Query(ctx, `SELECT "credentialId", "botId" FROM vault_credential_bots
				WHERE "userId" = $1 AND "spaceId" = $2 AND "credentialId" = ANY($3)`,
				actor.UserID, actor.SpaceID, ids)
			if err != nil {
				return err
			}
			for botRows.Next() {
				var credentialID, botID string
				if err := botRows.Scan(&credentialID, &botID); err != nil {
					botRows.Close()
					return err
				}
				chosen[credentialID] = append(chosen[credentialID], botID)
			}
			botRows.Close()
			if err := botRows.Err(); err != nil {
				return err
			}
		}
		// Decoding a preview opens the value; do it inside the read so one connection serves it.
		for _, record := range found {
			auth, authOK := authValue(decodeJSON(record.auth))
			var outputAuth any
			if authOK && destinationValid(record.name, record.origin, auth) {
				outputAuth = auth
			}
			preview := previewFor(auth, record.ciphertext, record.id, func() (string, error) {
				row := sharedVaultRow(record.id, actor.UserID, spaceID)
				return secretstore.OpenVaultValue(ctx, ring, vault.Writer, row, record.ciphertext)
			})
			meta := Metadata{
				Name:      record.name,
				Origin:    record.origin,
				Auth:      outputAuth,
				Title:     titleFor(record.title, record.origin, record.name, preview),
				Note:      record.note,
				Preview:   preview,
				Policy:    policy(record.policy),
				AllBots:   !limited[record.id],
				BotIDs:    []string{},
				CreatedAt: record.createdAt.UTC().Format(shared.ISOMillis),
				UpdatedAt: record.updatedAt.UTC().Format(shared.ISOMillis),
			}
			if meta.AllBots {
				meta.BotIDs = []string{}
			} else {
				meta.BotIDs = append(meta.BotIDs, chosen[record.id]...)
			}
			if outputAuth != nil {
				if kind, _ := outputAuth.(map[string]any)["type"].(string); kind == "login" {
					alsoOn := record.alsoOn
					if alsoOn == nil {
						alsoOn = []string{}
					}
					meta.AlsoOn = &alsoOn
				}
			}
			items = append(items, meta)
		}
		return nil
	})
	return items, err
}

// nameArg passes an absent name as SQL NULL.
func nameArg(name string) any {
	if name == "" {
		return nil
	}
	return name
}

// One is the answer vault.put returns: listVaultItems(scope, name) and its DTO
// (routes/bots.ts:239-243). found is false when no row of that name exists.
func One(
	ctx context.Context,
	database *db.DB,
	vault *shared.SecretVault,
	ring *contentcrypto.KeyRing,
	actor db.Actor,
	requestedScope string,
	name string,
) (Metadata, bool, error) {
	items, err := list(ctx, database, vault, ring, actor, requestedScope, name)
	if err != nil {
		return Metadata{}, false, err
	}
	if len(items) == 0 {
		return Metadata{}, false, nil
	}
	return items[0], true, nil
}

// sharedVaultRow builds the identity a value is bound to. The vault key scope is the vault's
// (account or Space), matching vaultFields' spaceId rather than the row's own column.
func sharedVaultRow(id, userID string, vaultSpaceID *string) secretstore.VaultRow {
	return secretstore.VaultRow{ID: id, UserID: userID, SpaceID: vaultSpaceID}
}

// spaceID is vaultFields (bot-secrets.ts:168-173): the requested copy, else this Space's
// override, else the account vault.
func spaceID(ctx context.Context, tx pgx.Tx, actor db.Actor, requested string) (*string, error) {
	target, err := spacesettings.Target(ctx, tx, actor, "credentials", requested)
	if err != nil {
		return nil, err
	}
	if target == "space" {
		id := actor.SpaceID
		return &id, nil
	}
	return nil, nil
}

func policy(raw string) string {
	switch raw {
	case "allow", "off", "ask":
		return raw
	}
	return "allow"
}

func decodeJSON(raw []byte) any {
	if len(raw) == 0 {
		return nil
	}
	var value any
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil
	}
	return value
}

// parseScope is settingsScopeInput.optional(): absent input, or an object with an optional enum.
func parseScope(raw orpc.Input) (string, *orpc.Error) {
	if len(raw.Raw) == 0 || string(raw.Raw) == "null" {
		return "", nil
	}
	object, issues := validate.Decode(raw.Raw, nil)
	if issues != nil {
		return "", validate.Fail(issues)
	}
	if value := object.Field("scope"); value != validate.Undefined {
		scope, problems := validate.Enum(validate.Path{"scope"}, value, "account", "space")
		if problems != nil {
			return "", validate.Fail(problems)
		}
		return scope, nil
	}
	return "", nil
}

func envValue(key string) string { return os.Getenv(key) }
