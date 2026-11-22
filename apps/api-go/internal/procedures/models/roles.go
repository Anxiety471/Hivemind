package models

import (
	"context"
	"encoding/json"
	"errors"
	"strconv"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/effects"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/orpc"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/modelcredentials"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/shared"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/spacesettings"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/validate"
)

// Roles is ModelRoleSchema.options.
var Roles = []string{"main", "approval", "computer"}

// thinkingLevels is ThinkingLevelSchema.options.
var thinkingLevels = []string{"off", "minimal", "low", "medium", "high", "xhigh", "max"}

const (
	maxBackups          = 10
	maxProvider         = 128
	maxModelID          = 512
	maxTransactionTries = 3
)

// RoleChoice is ModelRoleChoiceSchema on the wire: thinkingLevel and credentialId are
// present only when stored (and a valid enum for the former).
type RoleChoice struct {
	Provider      string  `json:"provider"`
	ModelID       string  `json:"modelId"`
	ThinkingLevel *string `json:"thinkingLevel,omitempty"`
	CredentialID  *string `json:"credentialId,omitempty"`
}

// RoleView is ModelRoleViewSchema: deploymentPrimary is always present, seesImages only
// when the main model's image input could be read.
type RoleView struct {
	Primary           *RoleChoice  `json:"primary"`
	Backups           []RoleChoice `json:"backups"`
	DeploymentPrimary *RoleChoice  `json:"deploymentPrimary"`
	SeesImages        *bool        `json:"seesImages,omitempty"`
}

type roleInput struct {
	Role     string
	Expected string
	Scope    string
}

func parseRole(raw orpc.Input) (roleInput, *orpc.Error) {
	var input roleInput
	object, issues := validate.Decode(raw.Raw, nil)
	if issues != nil {
		return input, validate.Fail(issues)
	}
	var found []validate.Issue
	role, roleIssues := validate.Enum(validate.Path{"role"}, object.Field("role"), Roles...)
	found = append(found, roleIssues...)
	input.Role = role
	expected, expectedIssues := optionalString(validate.Path{"expectedUserId"}, object.Field("expectedUserId"))
	found = append(found, expectedIssues...)
	input.Expected = expected
	scope, problems := spacesettings.ParseScope(object)
	found = append(found, problems...)
	if found != nil {
		return roleInput{}, validate.Fail(found)
	}
	input.Scope = scope
	return input, nil
}

// writeChoice is a parsed ModelRoleChoiceSchema; ThinkingSet distinguishes an absent
// level (keep the saved one) from an explicit null (clear it).
type writeChoice struct {
	Provider      string
	ModelID       string
	ThinkingSet   bool
	ThinkingLevel *string
	CredentialID  *string
}

type setRoleInput struct {
	roleInput
	PrimarySet bool
	Primary    *writeChoice
	BackupsSet bool
	Backups    []writeChoice
}

func parseSetRole(raw orpc.Input) (setRoleInput, *orpc.Error) {
	object, issues := validate.Decode(raw.Raw, nil)
	if issues != nil {
		return setRoleInput{}, validate.Fail(issues)
	}
	var input setRoleInput
	var found []validate.Issue
	role, roleIssues := validate.Enum(validate.Path{"role"}, object.Field("role"), Roles...)
	found = append(found, roleIssues...)
	input.Role = role
	expected, expectedIssues := optionalString(validate.Path{"expectedUserId"}, object.Field("expectedUserId"))
	found = append(found, expectedIssues...)
	input.Expected = expected
	scope, problems := spacesettings.ParseScope(object)
	found = append(found, problems...)
	input.Scope = scope
	switch primary := object.Field("primary"); primary {
	case validate.Undefined:
	default:
		input.PrimarySet = true
		if primary != nil {
			choice, choiceIssues := parseChoice(validate.Path{"primary"}, primary)
			found = append(found, choiceIssues...)
			if choiceIssues == nil {
				input.Primary = &choice
			}
		}
	}
	if backups := object.Field("backups"); backups != validate.Undefined {
		input.BackupsSet = true
		items, arrayIssues := validate.AsArray(validate.Path{"backups"}, backups)
		if arrayIssues != nil {
			found = append(found, arrayIssues...)
		} else {
			found = append(found, validate.ArrayBounds(validate.Path{"backups"}, len(items), 0, maxBackups)...)
			seen := map[string]bool{}
			for index, item := range items {
				path := validate.Path{"backups", index}
				object, itemIssues := validate.AsObject(item, path)
				if itemIssues != nil {
					found = append(found, itemIssues...)
					continue
				}
				choice, choiceIssues := parseChoice(path, object)
				found = append(found, choiceIssues...)
				if choiceIssues != nil {
					continue
				}
				key := rawChoiceKey(choice)
				if seen[key] {
					found = append(found, validate.Issue{
						"code": "custom", "message": "Backup models must be unique",
						"path": path.Raw(),
					})
					continue
				}
				seen[key] = true
				input.Backups = append(input.Backups, choice)
			}
		}
	}
	if found != nil {
		return setRoleInput{}, validate.Fail(found)
	}
	return input, nil
}

// parseChoice mirrors ModelRoleChoiceSchema: a plain object, provider and modelId trimmed
// and bounded, an optional nullable thinking level, and an optional connection id.
func parseChoice(path validate.Path, raw any) (writeChoice, []validate.Issue) {
	object, issues := validate.AsObject(raw, path)
	if issues != nil {
		return writeChoice{}, issues
	}
	var found []validate.Issue
	var choice writeChoice
	provider, providerIssues := validate.String(path.With("provider"), object.Field("provider"), validate.StringRules{Trim: true, Min: 1, Max: maxProvider})
	found = append(found, providerIssues...)
	choice.Provider = provider
	modelID, modelIssues := validate.String(path.With("modelId"), object.Field("modelId"), validate.StringRules{Trim: true, Min: 1, Max: maxModelID})
	found = append(found, modelIssues...)
	choice.ModelID = modelID
	switch level := object.Field("thinkingLevel"); level {
	case validate.Undefined:
	default:
		choice.ThinkingSet = true
		if level != nil {
			value, enumIssues := validate.Enum(path.With("thinkingLevel"), level, thinkingLevels...)
			found = append(found, enumIssues...)
			if enumIssues == nil {
				choice.ThinkingLevel = &value
			}
		}
	}
	if credential := object.Field("credentialId"); credential != validate.Undefined {
		value, stringIssues := validate.String(path.With("credentialId"), credential, validate.StringRules{Min: 1})
		found = append(found, stringIssues...)
		if stringIssues == nil {
			choice.CredentialID = &value
		}
	}
	return choice, found
}

func optionalString(path validate.Path, raw any) (string, []validate.Issue) {
	if raw == validate.Undefined {
		return "", nil
	}
	return validate.String(path, raw, validate.StringRules{Min: 1})
}

// Role implements models.role: the member's ordered models for a purpose as they apply in
// the Space (or the copy asked for), plus what runs when none is set and whether the main
// model reads images.
func Role(
	ctx context.Context,
	database *db.DB,
	deployment *shared.Deployment,
	actor db.Actor,
	raw orpc.Input,
) (any, *orpc.Error) {
	input, failure := parseRole(raw)
	if failure != nil {
		return nil, failure
	}
	if input.Expected != "" && input.Expected != actor.UserID {
		return nil, orpc.Forbidden("Forbidden")
	}
	var view RoleView
	err := database.Tenant(ctx, actor, func(tx pgx.Tx) error {
		target, err := spacesettings.Target(ctx, tx, actor, "models", input.Scope)
		if err != nil {
			return err
		}
		settings, err := readRole(ctx, tx, actor, target, input.Role)
		if err != nil {
			return err
		}
		view = RoleView{Primary: settings.Primary, Backups: settings.Backups}
		view.DeploymentPrimary, err = deploymentPrimary(ctx, tx, actor, input.Role, deployment)
		if err != nil {
			return err
		}
		// withImageInput: only the main role says whether its model reads images, and an
		// unreadable connection or catalog leaves the field out.
		if input.Role == "main" {
			choice := view.Primary
			if choice == nil {
				choice = view.DeploymentPrimary
			}
			if choice != nil {
				if vault, vaultErr := shared.VaultDeps(deployment.Vault); vaultErr == nil {
					sees, seesErr := modelcredentials.RoleChoiceSeesImages(
						ctx, tx, vault, actor, choice.Provider, choice.ModelID, choice.CredentialID,
					)
					if seesErr == nil {
						view.SeesImages = &sees
					}
				}
			}
		}
		return nil
	})
	if err != nil {
		return nil, spacesettings.Failure(err)
	}
	return view, nil
}

// SetRole implements models.setRole: validate the whole list, then rewrite the copy that
// applies (or the one asked for) in one transaction, and record the approval-policy event.
func SetRole(
	ctx context.Context,
	database *db.DB,
	deployment *shared.Deployment,
	actor db.Actor,
	raw orpc.Input,
) (any, *orpc.Error) {
	input, failure := parseSetRole(raw)
	if failure != nil {
		return nil, failure
	}
	if input.Expected != "" && input.Expected != actor.UserID {
		return nil, orpc.Forbidden("Forbidden")
	}
	var view RoleView
	var err error
	for attempt := 1; ; attempt++ {
		err = database.Tenant(ctx, actor, func(tx pgx.Tx) error {
			return setRoleInTransaction(ctx, tx, deployment, actor, input, &view)
		})
		if err == nil || !conflict(err) || attempt >= maxTransactionTries {
			break
		}
	}
	if err != nil {
		var domain *orpc.Error
		if errors.As(err, &domain) {
			return nil, domain
		}
		return nil, spacesettings.Failure(err)
	}
	recordRoleAudit(ctx, deployment, actor, input)
	return view, nil
}

func setRoleInTransaction(
	ctx context.Context,
	tx pgx.Tx,
	deployment *shared.Deployment,
	actor db.Actor,
	input setRoleInput,
	view *RoleView,
) error {
	vault, err := shared.VaultDeps(deployment.Vault)
	if err != nil {
		return err
	}
	choices := make([]modelcredentials.RoleChoice, 0, len(input.Backups)+1)
	if input.Primary != nil {
		choices = append(choices, wireChoice(*input.Primary))
	}
	for _, backup := range input.Backups {
		choices = append(choices, wireChoice(backup))
	}
	for _, choice := range choices {
		if failure := modelcredentials.ValidateRoleChoice(ctx, tx, vault, actor, input.Role, choice); failure != nil {
			return failure
		}
	}
	if err := spacesettings.Lock(ctx, tx, actor); err != nil {
		return err
	}
	target, err := spacesettings.Target(ctx, tx, actor, "models", input.Scope)
	if err != nil {
		return err
	}
	// The account's list is shared by every Space, so its saves also queue on the user.
	if target == "account" {
		var locked string
		if err := tx.QueryRow(ctx, `SELECT id FROM "user" WHERE id = $1 FOR UPDATE`, actor.UserID).Scan(&locked); err != nil {
			return err
		}
	}
	settings, err := writeRole(ctx, tx, actor, target, input)
	if err != nil {
		return err
	}
	*view = RoleView{Primary: settings.Primary, Backups: settings.Backups}
	view.DeploymentPrimary, err = deploymentPrimary(ctx, tx, actor, input.Role, deployment)
	if err != nil {
		return err
	}
	choice := view.Primary
	if choice == nil {
		choice = view.DeploymentPrimary
	}
	if input.Role == "main" && choice != nil {
		sees, seesErr := modelcredentials.RoleChoiceSeesImages(
			ctx, tx, vault, actor, choice.Provider, choice.ModelID, choice.CredentialID,
		)
		if seesErr == nil {
			view.SeesImages = &sees
		}
	}
	return nil
}

// readRole is getModelRole: the primary at position 0, then the rest in position order.
func readRole(ctx context.Context, tx pgx.Tx, actor db.Actor, target, role string) (RoleView, error) {
	query := `SELECT provider, "modelId", "thinkingLevel", "credentialId", "position" FROM user_model_role_choices
		WHERE "userId" = $1 AND role = $2 ORDER BY "position" ASC`
	args := []any{actor.UserID, role}
	if target == "space" {
		query = `SELECT provider, "modelId", "thinkingLevel", "credentialId", "position" FROM space_model_role_choices
			WHERE "userId" = $1 AND "spaceId" = $2 AND role = $3 ORDER BY "position" ASC`
		args = []any{actor.UserID, actor.SpaceID, role}
	}
	rows, err := tx.Query(ctx, query, args...)
	if err != nil {
		return RoleView{}, err
	}
	defer rows.Close()
	view := RoleView{Backups: []RoleChoice{}}
	for rows.Next() {
		var provider, modelID string
		var thinkingLevel, credentialID *string
		var position int
		if err := rows.Scan(&provider, &modelID, &thinkingLevel, &credentialID, &position); err != nil {
			return RoleView{}, err
		}
		choice, failure := storedChoice(provider, modelID, thinkingLevel, credentialID)
		if failure != nil {
			return RoleView{}, failure
		}
		if position == 0 && view.Primary == nil {
			view.Primary = &choice
		} else {
			view.Backups = append(view.Backups, choice)
		}
	}
	return view, rows.Err()
}

// storedChoice is roleChoice: the values trimmed for the output schema, a level outside the
// enum left out, and (as the router's output check requires) a blank or oversized row
// answered with the output failure.
func storedChoice(provider, modelID string, thinkingLevel, credentialID *string) (RoleChoice, *orpc.Error) {
	provider, modelID = validate.JSTrim(provider), validate.JSTrim(modelID)
	if n := utf8.RuneCountInString(provider); n < 1 || n > maxProvider {
		return RoleChoice{}, shared.OutputInvalid()
	}
	if n := utf8.RuneCountInString(modelID); n < 1 || n > maxModelID {
		return RoleChoice{}, shared.OutputInvalid()
	}
	choice := RoleChoice{Provider: provider, ModelID: modelID}
	if thinkingLevel != nil && containsLevel(*thinkingLevel) {
		choice.ThinkingLevel = thinkingLevel
	}
	if credentialID != nil && *credentialID != "" {
		choice.CredentialID = credentialID
	}
	return choice, nil
}

func containsLevel(value string) bool {
	for _, level := range thinkingLevels {
		if level == value {
			return true
		}
	}
	return false
}

// writeRole is writeModelRole: keep each row's saved effort (and the connection its model
// already ran on when only one did), drop a fallback equal to the primary, and rewrite the
// list at positions 0..n.
func writeRole(ctx context.Context, tx pgx.Tx, actor db.Actor, target string, input setRoleInput) (RoleView, error) {
	current, err := readRole(ctx, tx, actor, target, input.Role)
	if err != nil {
		return RoleView{}, err
	}
	saved := []RoleChoice{}
	if current.Primary != nil {
		saved = append(saved, *current.Primary)
	}
	saved = append(saved, current.Backups...)
	savedThinking := func(choice writeChoice) *string {
		key := roleChoiceKey(choice.Provider, choice.ModelID, choice.CredentialID)
		for _, item := range saved {
			if roleChoiceKey(item.Provider, item.ModelID, item.CredentialID) == key {
				return item.ThinkingLevel
			}
		}
		backup := backupChoiceKey(choice.Provider, choice.ModelID)
		for _, item := range saved {
			if backupChoiceKey(item.Provider, item.ModelID) == backup {
				return item.ThinkingLevel
			}
		}
		return nil
	}
	savedConnection := func(choice writeChoice) *string {
		owners := []RoleChoice{}
		backup := backupChoiceKey(choice.Provider, choice.ModelID)
		for _, item := range saved {
			if backupChoiceKey(item.Provider, item.ModelID) == backup {
				owners = append(owners, item)
			}
		}
		if len(owners) == 1 {
			return owners[0].CredentialID
		}
		return nil
	}
	withThinking := func(choice writeChoice) RoleChoice {
		credentialID := choice.CredentialID
		if credentialID == nil {
			credentialID = savedConnection(choice)
		}
		thinking := choice.ThinkingLevel
		if !choice.ThinkingSet {
			thinking = savedThinking(choice)
		}
		return RoleChoice{
			Provider:      canonical(choice.Provider),
			ModelID:       choice.ModelID,
			ThinkingLevel: thinking,
			CredentialID:  credentialID,
		}
	}
	var primary *RoleChoice
	if input.PrimarySet {
		if input.Primary != nil {
			value := withThinking(*input.Primary)
			primary = &value
		}
	} else {
		primary = current.Primary
	}
	backups := current.Backups
	if input.BackupsSet {
		backups = make([]RoleChoice, 0, len(input.Backups))
		for _, backup := range input.Backups {
			backups = append(backups, withThinking(backup))
		}
	}
	filtered := make([]RoleChoice, 0, len(backups))
	seen := map[string]bool{}
	for _, backup := range backups {
		key := roleChoiceKey(backup.Provider, backup.ModelID, backup.CredentialID)
		if primary != nil && key == roleChoiceKey(primary.Provider, primary.ModelID, primary.CredentialID) {
			continue
		}
		if seen[key] {
			continue
		}
		seen[key] = true
		filtered = append(filtered, backup)
	}
	if err := deleteRoleRows(ctx, tx, actor, target, input.Role); err != nil {
		return RoleView{}, err
	}
	position := 0
	if primary != nil {
		if err := insertRoleRow(ctx, tx, actor, target, input.Role, position, *primary); err != nil {
			return RoleView{}, err
		}
		position++
	}
	for _, backup := range filtered {
		if err := insertRoleRow(ctx, tx, actor, target, input.Role, position, backup); err != nil {
			return RoleView{}, err
		}
		position++
	}
	return readRole(ctx, tx, actor, target, input.Role)
}

func deleteRoleRows(ctx context.Context, tx pgx.Tx, actor db.Actor, target, role string) error {
	if target == "space" {
		_, err := tx.Exec(ctx, `DELETE FROM space_model_role_choices WHERE "userId" = $1 AND "spaceId" = $2 AND role = $3`,
			actor.UserID, actor.SpaceID, role)
		return err
	}
	_, err := tx.Exec(ctx, `DELETE FROM user_model_role_choices WHERE "userId" = $1 AND role = $2`, actor.UserID, role)
	return err
}

func insertRoleRow(ctx context.Context, tx pgx.Tx, actor db.Actor, target, role string, position int, choice RoleChoice) error {
	if target == "space" {
		_, err := tx.Exec(ctx, `INSERT INTO space_model_role_choices ("userId", "spaceId", role, "position", provider, "modelId", "thinkingLevel", "credentialId")
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
			actor.UserID, actor.SpaceID, role, position, choice.Provider, choice.ModelID, choice.ThinkingLevel, choice.CredentialID)
		return err
	}
	_, err := tx.Exec(ctx, `INSERT INTO user_model_role_choices ("userId", role, "position", provider, "modelId", "thinkingLevel", "credentialId")
		VALUES ($1, $2, $3, $4, $5, $6, $7)`,
		actor.UserID, role, position, choice.Provider, choice.ModelID, choice.ThinkingLevel, choice.CredentialID)
	return err
}

// deploymentPrimary is deploymentModelRole over the deployment's settings and environment:
// the model shown where the member chose none.
func deploymentPrimary(
	ctx context.Context,
	tx pgx.Tx,
	actor db.Actor,
	role string,
	deployment *shared.Deployment,
) (*RoleChoice, error) {
	if role == "computer" {
		return nil, nil
	}
	if role == "approval" {
		if deployment.ApprovalModel == nil {
			return nil, nil
		}
		choice := &RoleChoice{
			Provider: deployment.ApprovalModel.Provider,
			ModelID:  deployment.ApprovalModel.ModelID,
		}
		if deployment.ApprovalModelConfigured {
			return choice, nil
		}
		vault, err := shared.VaultDeps(deployment.Vault)
		if err != nil {
			return nil, nil
		}
		ready, err := modelcredentials.ReadyModelCredential(
			ctx, tx, vault, actor, choice.Provider, choice.ModelID,
		)
		if err != nil || !ready {
			return nil, nil
		}
		return choice, nil
	}
	var provider, modelID *string
	err := tx.QueryRow(ctx, `SELECT "defaultModelProvider", "defaultModelId" FROM deployment_settings WHERE id = 'default'`).
		Scan(&provider, &modelID)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return nil, err
	}
	if provider == nil && deployment.DefaultModel != nil {
		provider = &deployment.DefaultModel.Provider
	}
	if usable := usableModelID(modelID); usable == "" && deployment.DefaultModel != nil {
		modelID = &deployment.DefaultModel.ModelID
	}
	if provider == nil || *provider == "" || modelID == nil {
		return nil, nil
	}
	return &RoleChoice{Provider: *provider, ModelID: *modelID}, nil
}

// recordRoleAudit is procedureSecurityEvent for models.setRole: one approval-policy event
// naming the role and, when it was sent, the copy.
func recordRoleAudit(ctx context.Context, deployment *shared.Deployment, actor db.Actor, input setRoleInput) {
	if deployment.Audit == nil {
		return
	}
	metadata := []effects.Meta{
		{Key: "procedure", Value: "models.setRole"},
		{Key: "role", Value: input.Role},
	}
	if input.Scope != "" {
		metadata = append(metadata, effects.Meta{Key: "scope", Value: input.Scope})
	}
	_ = deployment.Audit.Record(ctx, effects.SecurityEvent{
		Type: "approval.policy.changed", UserID: actor.UserID, SpaceID: actor.SpaceID,
		Metadata: metadata,
	})
}

func wireChoice(choice writeChoice) modelcredentials.RoleChoice {
	return modelcredentials.RoleChoice{
		Provider: choice.Provider, ModelID: choice.ModelID, ThinkingLevel: choice.ThinkingLevel,
		CredentialID: choice.CredentialID,
	}
}

// rawChoiceKey is modelChoiceListSchema's uniqueness key: the provider as sent, not
// canonicalized.
func rawChoiceKey(choice writeChoice) string {
	return choiceKey(choice.Provider, choice.ModelID, choice.CredentialID)
}

// roleChoiceKey is modelRoleChoiceKey: the canonical provider, model and connection.
func roleChoiceKey(provider, modelID string, credentialID *string) string {
	return choiceKey(canonical(provider), modelID, credentialID)
}

func backupChoiceKey(provider, modelID string) string {
	return choiceKey(canonical(provider), modelID, nil)
}

func choiceKey(provider, modelID string, credentialID *string) string {
	credential := "null"
	if credentialID != nil {
		credential = strconv.Quote(*credentialID)
	}
	encoded, _ := json.Marshal([]string{provider, modelID})
	return string(encoded) + "\x00" + credential
}

func canonical(provider string) string {
	if provider == "azure-openai-responses" {
		return "azure"
	}
	return provider
}

func usableModelID(value *string) string {
	if value == nil {
		return ""
	}
	trimmed := validate.JSTrim(*value)
	if trimmed == "" || trimmed == "null" || trimmed == "undefined" {
		return ""
	}
	return trimmed
}

// conflict is withTransactionRetry's condition: a deadlock or serialization failure the
// whole save can be tried again.
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
