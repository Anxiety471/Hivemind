package modelcredentials

import (
	"context"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/orpc"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/shared"
)

// The messages model-selection.ts returns for a choice that cannot run.
const (
	ProviderNotConnected = "Connect that model provider first"
	UnknownProviderModel = "Unknown model for that provider"
)

// RoleChoice is one model-role row as the save takes it.
type RoleChoice struct {
	Provider      string
	ModelID       string
	ThinkingLevel *string
	CredentialID  *string
}

// ValidateRoleChoice is validateRoleChoices for one row: the model must be listed, the
// connection able to run it, a computer model must read images, and a saved thinking
// level must be one the model accepts.
func ValidateRoleChoice(
	ctx context.Context,
	tx pgx.Tx,
	vault *shared.SecretVault,
	actor db.Actor,
	role string,
	choice RoleChoice,
) *orpc.Error {
	canonical := canonicalProvider(choice.Provider)
	_, known := DeclaredModel(canonical, choice.ModelID)
	credential, preference, err := connectedCredentialWithPreference(
		ctx, tx, vault, actor, choice.Provider, choice.ModelID, choice.CredentialID,
	)
	if err != nil {
		return shared.Failure(err)
	}
	// A role row runs on the member's own connection. A hosted deployment's managed
	// models (model credits) are not served here, so they are not an exception.
	if credential == nil {
		return orpc.BadRequest(ProviderNotConnected)
	}
	if role == "computer" {
		sees, err := choiceSeesImages(ctx, tx, vault, actor, choice)
		if err != nil {
			return shared.Failure(err)
		}
		if !sees {
			return orpc.BadRequest("Choose a model that can see images")
		}
	}
	if choice.ThinkingLevel != nil && *choice.ThinkingLevel != "" {
		allowed, err := allowedThinkingLevels(ctx, tx, vault, actor, choice)
		if err != nil {
			return shared.Failure(err)
		}
		if allowed != nil && !contains(allowed, *choice.ThinkingLevel) {
			return orpc.BadRequest("Thinking level must be one of: " + strings.Join(allowed, ", "))
		}
	}
	// A listed model of a native provider runs on the provider's connection; only a
	// compatible server's model needs the connection to enable that exact id.
	if known && canonical != openAICompatibleProvider {
		return nil
	}
	problem, err := connectedChoiceProblem(ctx, tx, vault, actor, choice, credential, preference)
	if err != nil {
		return shared.Failure(err)
	}
	if problem != "" {
		return orpc.BadRequest(problem)
	}
	return nil
}

// connectedChoiceProblem is validateConnectedModelChoice's openai-compatible branch: the
// model must be the connection's saved preference, a legacy connection with no list, or
// an id the connection enables.
func connectedChoiceProblem(
	ctx context.Context,
	tx pgx.Tx,
	vault *shared.SecretVault,
	actor db.Actor,
	choice RoleChoice,
	credential *credentialRow,
	preference *string,
) (string, error) {
	if credential == nil {
		return ProviderNotConnected, nil
	}
	if _, ok := usableModelID(choice.ModelID); !ok {
		return UnknownProviderModel, nil
	}
	var found string
	err := tx.QueryRow(ctx, `SELECT p."modelId" FROM user_model_preferences p
		JOIN user_model_credentials c ON c.id = p."credentialId"
		WHERE p."userId" = $1 AND p."modelId" = $2 AND c.provider = $3
		AND ($4 = '' OR p."credentialId" = $4) LIMIT 1`,
		actor.UserID, trimJS(choice.ModelID), choice.Provider, deref(choice.CredentialID)).Scan(&found)
	if err == nil {
		return "", nil
	}
	if err != pgx.ErrNoRows {
		return "", err
	}
	parsed := loadParsedSecret(ctx, tx, vault, actor.UserID, credential.secretID)
	// A connection saved before its model list existed serves anything.
	if parsed != nil && parsed.Kind == "openai_compatible" && parsed.EnabledModelIDs == nil {
		return "", nil
	}
	enabled := enabledIDs(parsed, deref(preference))
	if contains(enabled, trimJS(choice.ModelID)) {
		return "", nil
	}
	return UnknownProviderModel, nil
}

// choiceSeesImages is connectedModelSeesImages: the catalog says for a listed model,
// otherwise the compatible connection's own settings.
func choiceSeesImages(
	ctx context.Context,
	tx pgx.Tx,
	vault *shared.SecretVault,
	actor db.Actor,
	choice RoleChoice,
) (bool, error) {
	canonical := canonicalProvider(choice.Provider)
	if entry, known := DeclaredModel(canonical, choice.ModelID); known && canonical != openAICompatibleProvider {
		return entry.Images, nil
	}
	credential, _, err := connectedCredentialWithPreference(
		ctx, tx, vault, actor, choice.Provider, choice.ModelID, choice.CredentialID,
	)
	if err != nil {
		return false, err
	}
	parsed := loadParsedSecret(ctx, tx, vault, actor.UserID, secretIDOf(credential))
	if credential != nil && parsed != nil && modelSeesImages(parsed, *credential, trimJS(choice.ModelID)) {
		return true, nil
	}
	return operatorVisionModels()[trimJS(choice.ModelID)], nil
}

// RoleChoiceSeesImages is withImageInput's answer for the model the main role runs: the
// catalog's metadata, or the connection's own setting for a compatible server's model.
func RoleChoiceSeesImages(
	ctx context.Context,
	tx pgx.Tx,
	vault *shared.SecretVault,
	actor db.Actor,
	provider, modelID string,
	credentialID *string,
) (bool, error) {
	return choiceSeesImages(ctx, tx, vault, actor, RoleChoice{
		Provider: provider, ModelID: modelID, CredentialID: credentialID,
	})
}

// allowedThinkingLevels is prepareAllowedThinkingLevels: a native model's catalog levels,
// or the levels the compatible connection declares for that id.
func allowedThinkingLevels(
	ctx context.Context,
	tx pgx.Tx,
	vault *shared.SecretVault,
	actor db.Actor,
	choice RoleChoice,
) ([]string, error) {
	canonical := canonicalProvider(choice.Provider)
	if canonical != openAICompatibleProvider {
		if entry, known := DeclaredModel(canonical, choice.ModelID); known {
			return entry.ThinkingLevels, nil
		}
		return nil, nil
	}
	credential, preference, err := connectedCredentialWithPreference(
		ctx, tx, vault, actor, choice.Provider, choice.ModelID, choice.CredentialID,
	)
	if err != nil {
		return nil, err
	}
	if credential == nil {
		return []string{"off"}, nil
	}
	parsed := loadParsedSecret(ctx, tx, vault, actor.UserID, credential.secretID)
	if parsed == nil || parsed.Kind != "openai_compatible" {
		return []string{"off"}, nil
	}
	enabled := enabledIDs(parsed, deref(preference))
	if parsed.EnabledModelIDs != nil && !contains(enabled, trimJS(choice.ModelID)) {
		return []string{"off"}, nil
	}
	levels := thinkingLevelsFor(parsed, *credential, trimJS(choice.ModelID))
	if len(levels) == 0 {
		return []string{"off"}, nil
	}
	return levels, nil
}

// ReadyModelCredential is hasReadyModelCredential for an env-configured deployment model:
// a readable connection that does not need a new sign-in. The openai-compatible URL policy
// is the API's own network rule and is left to the TypeScript side; a deployment model on
// such a connection is treated as ready once its secret opens.
func ReadyModelCredential(
	ctx context.Context,
	tx pgx.Tx,
	vault *shared.SecretVault,
	actor db.Actor,
	provider, modelID string,
) (bool, error) {
	credential, _, err := connectedCredentialWithPreference(ctx, tx, vault, actor, provider, modelID, nil)
	if err != nil || credential == nil {
		return false, err
	}
	parsed := loadParsedSecret(ctx, tx, vault, actor.UserID, credential.secretID)
	if parsed == nil {
		return false, nil
	}
	if parsed.Kind == "oauth" && parsed.ReconnectRequired {
		return false, nil
	}
	return true, nil
}

// ConnectedModelCredential is findConnectedModelCredential's presence answer, which is all
// `me` asks: whether a connection would serve the model. TypeScript keeps the row even when
// its secret cannot be read (only its selection can fail), so no secret is loaded here.
func ConnectedModelCredential(
	ctx context.Context,
	tx pgx.Tx,
	vault *shared.SecretVault,
	actor db.Actor,
	provider, modelID string,
	credentialID *string,
) (bool, error) {
	credential, _, err := connectedCredentialWithPreference(ctx, tx, vault, actor, provider, modelID, credentialID)
	if err != nil || credential == nil {
		return false, err
	}
	return true, nil
}

// connectedCredentialWithPreference is findConnectedModelCredential: the connection that
// would run the model, and the model its preference selects.
func connectedCredentialWithPreference(
	ctx context.Context,
	tx pgx.Tx,
	vault *shared.SecretVault,
	actor db.Actor,
	provider, modelID string,
	credentialID *string,
) (*credentialRow, *string, error) {
	if credentialID != nil && *credentialID != "" {
		selected, err := findCredentialByID(ctx, tx, actor.UserID, *credentialID, provider)
		if err != nil || selected == nil {
			return selected, nil, err
		}
		preference := preferenceModelForCredential(ctx, tx, actor.UserID, selected.id)
		if preference != nil {
			selected.modelID = preference
		}
		return selected, preference, nil
	}
	selected, selectedPref, err := findCredential(ctx, tx, actor.UserID, provider, modelID)
	if err != nil || selected == nil {
		return nil, nil, err
	}
	var preference *string
	if selectedPref != nil {
		preference = selectedPref.modelID
		if preference != nil {
			selected.modelID = preference
		}
	}
	id, wantModel := usableModelID(modelID)
	if canonicalProvider(provider) != openAICompatibleProvider || !wantModel {
		return selected, preference, nil
	}
	if selected.modelID != nil && trimJS(*selected.modelID) == id {
		return selected, preference, nil
	}
	selectedSecret := loadParsedSecret(ctx, tx, vault, actor.UserID, selected.secretID)
	if contains(enabledIDs(selectedSecret, deref(selected.modelID)), id) {
		return selected, preference, nil
	}
	candidates, err := credentialsForProvider(ctx, tx, actor.UserID, provider)
	if err != nil {
		return nil, nil, err
	}
	for index := range candidates {
		candidate := &candidates[index]
		if candidate.id == selected.id {
			continue
		}
		candidateSecret := loadParsedSecret(ctx, tx, vault, actor.UserID, candidate.secretID)
		if contains(enabledIDs(candidateSecret, ""), id) {
			candidate.modelID = nil
			return candidate, nil, nil
		}
	}
	return selected, preference, nil
}

// preferenceModelForCredential is the model saved on one connection, if any.
func preferenceModelForCredential(ctx context.Context, tx pgx.Tx, userID, credentialID string) *string {
	var modelID *string
	err := tx.QueryRow(ctx, `SELECT "modelId" FROM user_model_preferences
		WHERE "userId" = $1 AND "credentialId" = $2`, userID, credentialID).Scan(&modelID)
	if err != nil {
		return nil
	}
	return modelID
}

func secretIDOf(credential *credentialRow) string {
	if credential == nil {
		return ""
	}
	return credential.secretID
}

func deref(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}
