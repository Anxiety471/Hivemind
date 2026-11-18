// Package spacesettings ports spaceSettings.overrides and spaceSettings.setOverride
// (packages/db/src/space-settings.ts), and the helpers every member-settings
// procedure shares: the membership lock and the choice of account or Space copy.
package spacesettings

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/effects"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/orpc"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/validate"
)

// Settings is SpaceSettingSchema.options, in enum order.
var Settings = []string{"models", "voice", "confirmations", "credentials"}

// Scopes is SettingsScopeSchema.options.
var Scopes = []string{"account", "space"}

const maxTransactionTries = 3

// Failure turns a database error into the response the API gives for it.
func Failure(err error) *orpc.Error {
	var failure *orpc.Error
	if errors.As(err, &failure) {
		return failure
	}
	if db.IsUnavailable(err) {
		return orpc.Unavailable()
	}
	return orpc.Internal()
}

// ParseScope reads the optional `scope` of settingsScopeInput: "" when omitted.
func ParseScope(object *validate.Object) (string, []validate.Issue) {
	raw := object.Field("scope")
	if raw == validate.Undefined {
		return "", nil
	}
	scope, issues := validate.Enum(validate.Path{"scope"}, raw, Scopes...)
	return scope, issues
}

// Lock is lockSpaceSettings: it holds the member's place in the Space for the rest
// of the transaction, so a settings write never lands in a copy an override change
// just replaced.
func Lock(ctx context.Context, tx pgx.Tx, actor db.Actor) error {
	rows, err := tx.Query(ctx, `SELECT 1 AS locked FROM space_members WHERE "spaceId" = $1 AND "userId" = $2 FOR UPDATE`, actor.SpaceID, actor.UserID)
	if err != nil {
		return err
	}
	count := 0
	for rows.Next() {
		count++
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	if count != 1 {
		return errors.New("Space membership not found")
	}
	return nil
}

// Target is settingsTarget: an explicit scope wins; otherwise the Space's copy when
// it has an override for the setting, else the account's.
func Target(ctx context.Context, tx pgx.Tx, actor db.Actor, setting, requested string) (string, error) {
	if requested != "" {
		return requested, nil
	}
	var found string
	err := tx.QueryRow(ctx, `SELECT setting FROM space_setting_overrides WHERE "spaceId" = $1 AND "userId" = $2 AND setting = $3`,
		actor.SpaceID, actor.UserID, setting).Scan(&found)
	if errors.Is(err, pgx.ErrNoRows) {
		return "account", nil
	}
	if err != nil {
		return "", err
	}
	return "space", nil
}

// overrides is spaceSettingOverrides: the settings this Space replaces, in enum order.
func overrides(ctx context.Context, tx pgx.Tx, actor db.Actor) ([]string, error) {
	rows, err := tx.Query(ctx, `SELECT setting FROM space_setting_overrides WHERE "spaceId" = $1 AND "userId" = $2`, actor.SpaceID, actor.UserID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	saved := map[string]bool{}
	for rows.Next() {
		var setting string
		if err := rows.Scan(&setting); err != nil {
			return nil, err
		}
		saved[setting] = true
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	found := []string{}
	for _, setting := range Settings {
		if saved[setting] {
			found = append(found, setting)
		}
	}
	return found, nil
}

// Overrides implements spaceSettings.overrides.
func Overrides(ctx context.Context, database *db.DB, actor db.Actor) ([]string, *orpc.Error) {
	var found []string
	err := database.Tenant(ctx, actor, func(tx pgx.Tx) error {
		var err error
		found, err = overrides(ctx, tx, actor)
		return err
	})
	if err != nil {
		return nil, Failure(err)
	}
	return found, nil
}

type setInput struct {
	Setting string
	Enabled bool
}

// parseSet mirrors z.object({ setting: SpaceSettingSchema, enabled: z.boolean() }).
func parseSet(raw orpc.Input) (setInput, *orpc.Error) {
	var input setInput
	object, issues := validate.Decode(raw.Raw, nil)
	if issues != nil {
		return input, validate.Fail(issues)
	}
	var found []validate.Issue
	setting, problems := validate.Enum(validate.Path{"setting"}, object.Field("setting"), Settings...)
	found = append(found, problems...)
	enabled, problems := validate.Boolean(validate.Path{"enabled"}, object.Field("enabled"))
	found = append(found, problems...)
	if found != nil {
		return setInput{}, validate.Fail(found)
	}
	return setInput{Setting: setting, Enabled: enabled}, nil
}

// SetOverride implements spaceSettings.setOverride: starting an override copies the
// account's settings into the Space, ending it drops the Space's copy. It runs
// serializable under the membership lock and is rerun on a conflict, as
// withTransactionRetry does.
func SetOverride(ctx context.Context, database *db.DB, actor db.Actor, raw orpc.Input) (any, *orpc.Error) {
	input, failure := parseSet(raw)
	if failure != nil {
		return nil, failure
	}
	var result []string
	var err error
	for attempt := 1; ; attempt++ {
		err = database.TenantSerializable(ctx, actor, func(tx pgx.Tx) error {
			var err error
			result, err = setOverride(ctx, tx, actor, input)
			return err
		})
		if err == nil || !conflict(err) || attempt >= maxTransactionTries {
			break
		}
	}
	if err != nil {
		return nil, Failure(err)
	}
	return result, nil
}

// conflict is a serialization failure or deadlock.
func conflict(err error) bool {
	var pgErr interface{ SQLState() string }
	if errors.As(err, &pgErr) {
		switch pgErr.SQLState() {
		case "40001", "40P01":
			return true
		}
	}
	return false
}

func now() time.Time { return time.Now().UTC().Truncate(time.Millisecond) }

func setOverride(ctx context.Context, tx pgx.Tx, actor db.Actor, input setInput) ([]string, error) {
	if err := Lock(ctx, tx, actor); err != nil {
		return nil, err
	}
	var present string
	err := tx.QueryRow(ctx, `SELECT setting FROM space_setting_overrides WHERE "spaceId" = $1 AND "userId" = $2 AND setting = $3`,
		actor.SpaceID, actor.UserID, input.Setting).Scan(&present)
	exists := err == nil
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return nil, err
	}
	if input.Enabled == exists {
		return overrides(ctx, tx, actor)
	}
	if err := clearSpaceCopy(ctx, tx, actor, input.Setting); err != nil {
		return nil, err
	}
	if input.Enabled {
		if err := copyAccountIntoSpace(ctx, tx, actor, input.Setting); err != nil {
			return nil, err
		}
		if _, err := tx.Exec(ctx, `INSERT INTO space_setting_overrides ("spaceId", "userId", setting, "createdAt") VALUES ($1, $2, $3, $4)`,
			actor.SpaceID, actor.UserID, input.Setting, now()); err != nil {
			return nil, err
		}
	} else if _, err := tx.Exec(ctx, `DELETE FROM space_setting_overrides WHERE "spaceId" = $1 AND "userId" = $2 AND setting = $3`,
		actor.SpaceID, actor.UserID, input.Setting); err != nil {
		return nil, err
	}
	return overrides(ctx, tx, actor)
}

// clearSpaceCopy deletes the Space's copy of a setting. Credentials are only
// deleted by their owner's Space scope; nothing in them is read.
func clearSpaceCopy(ctx context.Context, tx pgx.Tx, actor db.Actor, setting string) error {
	var statements []string
	switch setting {
	case "models":
		statements = []string{`DELETE FROM space_model_role_choices WHERE "spaceId" = $1 AND "userId" = $2`}
	case "voice":
		statements = []string{`DELETE FROM space_voice_preferences WHERE "spaceId" = $1 AND "userId" = $2`}
	case "credentials":
		statements = []string{`DELETE FROM vault_credentials WHERE "spaceId" = $1 AND "userId" = $2`}
	default:
		statements = []string{
			`DELETE FROM action_approval_rules WHERE "spaceId" = $1 AND "createdByUserId" = $2`,
			`DELETE FROM action_auto_review_preferences WHERE "spaceId" = $1 AND "userId" = $2`,
		}
	}
	for _, statement := range statements {
		if _, err := tx.Exec(ctx, statement, actor.SpaceID, actor.UserID); err != nil {
			return err
		}
	}
	return nil
}

// copyAccountIntoSpace starts the Space where the member already is. Credentials
// are the exception: a Space's own vault starts empty.
func copyAccountIntoSpace(ctx context.Context, tx pgx.Tx, actor db.Actor, setting string) error {
	at := now()
	switch setting {
	case "credentials":
		return nil
	case "models":
		_, err := tx.Exec(ctx, `INSERT INTO space_model_role_choices ("spaceId", "userId", role, "position", provider, "modelId", "thinkingLevel", "credentialId")
			SELECT $1, $2, role, "position", provider, "modelId", "thinkingLevel", "credentialId" FROM user_model_role_choices WHERE "userId" = $2`,
			actor.SpaceID, actor.UserID)
		return err
	case "voice":
		type preference struct {
			credentialID, voiceID string
			speechModel           *string
			isDefault             bool
		}
		rows, err := tx.Query(ctx, `SELECT "credentialId", "voiceId", "speechModel", "isDefault" FROM user_voice_preferences WHERE "userId" = $1`, actor.UserID)
		if err != nil {
			return err
		}
		var found []preference
		for rows.Next() {
			var row preference
			if err := rows.Scan(&row.credentialID, &row.voiceID, &row.speechModel, &row.isDefault); err != nil {
				rows.Close()
				return err
			}
			found = append(found, row)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}
		for _, row := range found {
			if _, err := tx.Exec(ctx, `INSERT INTO space_voice_preferences (id, "spaceId", "userId", "credentialId", "voiceId", "speechModel", "isDefault", "createdAt", "updatedAt")
				VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)`,
				effects.NewID(), actor.SpaceID, actor.UserID, row.credentialID, row.voiceID, row.speechModel, row.isDefault, at); err != nil {
				return err
			}
		}
		return nil
	}
	type rule struct{ effect, kind, value string }
	rows, err := tx.Query(ctx, `SELECT effect, "matchKind", "matchValue" FROM user_action_approval_rules WHERE "userId" = $1`, actor.UserID)
	if err != nil {
		return err
	}
	var rules []rule
	for rows.Next() {
		var row rule
		if err := rows.Scan(&row.effect, &row.kind, &row.value); err != nil {
			rows.Close()
			return err
		}
		rules = append(rules, row)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	var enabled, skip bool
	err = tx.QueryRow(ctx, `SELECT enabled, "skipApprovals" FROM user_action_auto_review_preferences WHERE "userId" = $1`, actor.UserID).Scan(&enabled, &skip)
	hasReview := err == nil
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	for _, row := range rules {
		if _, err := tx.Exec(ctx, `INSERT INTO action_approval_rules (id, "spaceId", "createdByUserId", effect, "matchKind", "matchValue", "createdAt")
			VALUES ($1, $2, $3, $4, $5, $6, $7)`, effects.NewID(), actor.SpaceID, actor.UserID, row.effect, row.kind, row.value, at); err != nil {
			return err
		}
	}
	if hasReview {
		if _, err := tx.Exec(ctx, `INSERT INTO action_auto_review_preferences (id, "spaceId", "userId", enabled, "skipApprovals", "createdAt", "updatedAt")
			VALUES ($1, $2, $3, $4, $5, $6, $6)`, effects.NewID(), actor.SpaceID, actor.UserID, enabled, skip, at); err != nil {
			return err
		}
	}
	return nil
}
