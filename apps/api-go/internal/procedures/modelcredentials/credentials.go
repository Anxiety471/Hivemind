package modelcredentials

import (
	"context"
	"errors"
	"net/url"
	"os"
	"sort"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/orpc"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/shared"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/spacesettings"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/secretstore"
)

const openAICompatibleProvider = "openai-compatible"

// Credential is ModelCredentialSchema (packages/contracts/src/models/model-connections.ts:115-153).
type Credential struct {
	PreferenceRank     *int                      `json:"preferenceRank,omitempty"`
	CacheCapabilities  map[string]any            `json:"cacheCapabilities,omitempty"`
	ContextWindow      *int64                    `json:"contextWindow,omitempty"`
	ID                 string                    `json:"id"`
	Provider           string                    `json:"provider"`
	Label              string                    `json:"label"`
	HasKey             bool                      `json:"hasKey"`
	IsDefault          bool                      `json:"isDefault"`
	HeaderNames        *[]string                 `json:"headerNames,omitempty"`
	BaseURL            string                    `json:"baseUrl,omitempty"`
	EndpointName       string                    `json:"endpointName,omitempty"`
	APIProtocol        *string                   `json:"apiProtocol,omitempty"`
	AccountID          *string                   `json:"accountId,omitempty"`
	GatewayID          *string                   `json:"gatewayId,omitempty"`
	ProjectID          *string                   `json:"projectId,omitempty"`
	Region             *string                   `json:"region,omitempty"`
	ModelID            *string                   `json:"modelId,omitempty"`
	Reasoning          *bool                     `json:"reasoning,omitempty"`
	ThinkingLevel      *string                   `json:"thinkingLevel,omitempty"`
	MaxTokens          *int64                    `json:"maxTokens,omitempty"`
	SupportsImages     *bool                     `json:"supportsImages,omitempty"`
	MaxImagesPerPrompt *int64                    `json:"maxImagesPerPrompt,omitempty"`
	ThinkingLevels     []string                  `json:"thinkingLevels,omitempty"`
	EnabledModelIDs    *[]string                 `json:"enabledModelIds,omitempty"`
	VisionModelIDs     *[]string                 `json:"visionModelIds,omitempty"`
	ModelSettings      map[string]map[string]any `json:"modelSettings,omitempty"`
	AuthKind           string                    `json:"authKind,omitempty"`
	ReconnectRequired  bool                      `json:"reconnectRequired,omitempty"`
}

// credentialRow is one user_model_credentials row plus the preference view a call overlays.
type credentialRow struct {
	id             string
	provider       string
	label          string
	secretID       string
	supportsImages *bool
	createdAt      time.Time
	updatedAt      time.Time

	// Overlaid from the preference (or the main model when it runs on this row).
	isDefault     bool
	modelID       *string
	thinkingLevel *string
}

type preferenceRow struct {
	credentialID  string
	modelID       *string
	thinkingLevel *string
	updatedAt     time.Time
	credential    credentialRow
}

// List implements models.credentials (routes/models.ts:150-219).
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
	result := []Credential{}
	err = database.Tenant(ctx, actor, func(tx pgx.Tx) error {
		rows, err := listCredentialRows(ctx, tx, actor.UserID)
		if err != nil {
			return err
		}
		preferences, err := listPreferenceRows(ctx, tx, actor.UserID)
		if err != nil {
			return err
		}
		main, err := resolveMain(ctx, tx, vault, actor)
		if err != nil {
			return err
		}
		ciphertexts, err := secretCiphertexts(ctx, tx, actor.UserID, rows)
		if err != nil {
			return err
		}
		byCredential := map[string]preferenceRow{}
		for _, preference := range preferences {
			byCredential[preference.credentialID] = preference
		}
		ranked := append([]preferenceRow(nil), preferences...)
		sort.SliceStable(ranked, func(left, right int) bool {
			if !ranked[left].updatedAt.Equal(ranked[right].updatedAt) {
				return ranked[left].updatedAt.After(ranked[right].updatedAt)
			}
			return ranked[left].credentialID > ranked[right].credentialID
		})
		ranks := map[string]int{}
		for index, preference := range ranked {
			ranks[preference.credentialID] = index
		}
		for _, row := range rows {
			preference, hasPreference := byCredential[row.id]
			own := row
			if hasPreference {
				own.modelID = preference.modelID
				own.thinkingLevel = preference.thinkingLevel
			}
			runsMain := main != nil && main.credential.id == row.id
			shown := own
			if runsMain {
				shown.isDefault = true
				shown.modelID = main.modelID
				shown.thinkingLevel = main.thinkingLevel
			}
			var plaintext *string
			if ciphertext, ok := ciphertexts[row.secretID]; ok {
				value, loadErr := vault.Writer.Load(ctx, ciphertext, row.secretID)
				if loadErr != nil {
					if errors.Is(loadErr, secretstore.ErrRemoteUnsupported) {
						return loadErr
					}
				} else {
					plaintext = &value
				}
			}
			listed := credentialDTO(own, plaintext)
			final := listed
			if runsMain {
				final = credentialDTO(shown, plaintext)
				if final.EnabledModelIDs != nil && listed.EnabledModelIDs != nil {
					seen := map[string]bool{}
					union := []string{}
					for _, id := range append(*final.EnabledModelIDs, *listed.EnabledModelIDs...) {
						if !seen[id] {
							seen[id] = true
							union = append(union, id)
						}
					}
					final.EnabledModelIDs = &union
				}
			}
			if hasPreference {
				rank := ranks[preference.credentialID]
				final.PreferenceRank = &rank
			}
			result = append(result, final)
		}
		return nil
	})
	if err != nil {
		if errors.Is(err, secretstore.ErrRemoteUnsupported) {
			return nil, orpc.Unavailable()
		}
		return nil, shared.Failure(err)
	}
	return result, nil
}

func listCredentialRows(ctx context.Context, tx pgx.Tx, userID string) ([]credentialRow, error) {
	rows, err := tx.Query(ctx, `SELECT id, provider, label, "secretId", "supportsImages",
		"createdAt", "updatedAt" FROM user_model_credentials WHERE "userId" = $1
		ORDER BY "updatedAt" DESC, "createdAt" DESC, id DESC`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var found []credentialRow
	for rows.Next() {
		var row credentialRow
		if err := rows.Scan(&row.id, &row.provider, &row.label, &row.secretID,
			&row.supportsImages, &row.createdAt, &row.updatedAt); err != nil {
			return nil, err
		}
		found = append(found, row)
	}
	return found, rows.Err()
}

func listPreferenceRows(ctx context.Context, tx pgx.Tx, userID string) ([]preferenceRow, error) {
	rows, err := tx.Query(ctx, `SELECT p."credentialId", p."modelId", p."thinkingLevel", p."updatedAt",
		c.id, c.provider, c.label, c."secretId", c."supportsImages", c."createdAt", c."updatedAt"
		FROM user_model_preferences p JOIN user_model_credentials c ON c.id = p."credentialId"
		WHERE p."userId" = $1`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var found []preferenceRow
	for rows.Next() {
		var row preferenceRow
		var credential credentialRow
		if err := rows.Scan(&row.credentialID, &row.modelID, &row.thinkingLevel, &row.updatedAt,
			&credential.id, &credential.provider, &credential.label, &credential.secretID,
			&credential.supportsImages, &credential.createdAt, &credential.updatedAt); err != nil {
			return nil, err
		}
		row.credential = credential
		found = append(found, row)
	}
	return found, rows.Err()
}

func secretCiphertexts(ctx context.Context, tx pgx.Tx, userID string, rows []credentialRow) (map[string]string, error) {
	ids := make([]string, 0, len(rows))
	for _, row := range rows {
		if row.secretID != "" {
			ids = append(ids, row.secretID)
		}
	}
	out := map[string]string{}
	if len(ids) == 0 {
		return out, nil
	}
	secretRows, err := tx.Query(ctx, `SELECT id, ciphertext FROM secrets
		WHERE id = ANY($1) AND "userId" = $2 AND "spaceId" IS NULL`, ids, userID)
	if err != nil {
		return nil, err
	}
	defer secretRows.Close()
	for secretRows.Next() {
		var id, ciphertext string
		if err := secretRows.Scan(&id, &ciphertext); err != nil {
			return nil, err
		}
		out[id] = ciphertext
	}
	return out, secretRows.Err()
}

type mainModel struct {
	credential    credentialRow
	modelID       *string
	thinkingLevel *string
}

// resolveMain is resolveMemberMainModel (model-roles.ts:76-91); the role row's model and effort
// are what the DTO shows for the connection running the main model.
func resolveMain(ctx context.Context, tx pgx.Tx, vault *shared.SecretVault, actor db.Actor) (*mainModel, error) {
	target, err := spacesettings.Target(ctx, tx, actor, "models", "")
	if err != nil {
		return nil, err
	}
	query := `SELECT provider, "modelId", "thinkingLevel", "credentialId" FROM user_model_role_choices
		WHERE "userId" = $1 AND role = 'main' AND position = 0`
	args := []any{actor.UserID}
	if target == "space" {
		query = `SELECT provider, "modelId", "thinkingLevel", "credentialId" FROM space_model_role_choices
			WHERE "userId" = $1 AND "spaceId" = $2 AND role = 'main' AND position = 0`
		args = append(args, actor.SpaceID)
	}
	var provider, modelID string
	var thinkingLevel, credentialID *string
	err = tx.QueryRow(ctx, query, args...).Scan(&provider, &modelID, &thinkingLevel, &credentialID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	chosen, err := connectedCredential(ctx, tx, vault, actor, provider, modelID, credentialID)
	if err != nil || chosen == nil {
		return nil, err
	}
	main := &mainModel{credential: *chosen}
	if modelID != "" {
		main.modelID = &modelID
	}
	if thinkingLevel != nil && contains(thinkingLevels, *thinkingLevel) {
		main.thinkingLevel = thinkingLevel
	}
	return main, nil
}

// connectedCredential is findConnectedModelCredential without the save-preview inputs.
func connectedCredential(
	ctx context.Context,
	tx pgx.Tx,
	vault *shared.SecretVault,
	actor db.Actor,
	provider, modelID string,
	credentialID *string,
) (*credentialRow, error) {
	if credentialID != nil && *credentialID != "" {
		return findCredentialByID(ctx, tx, actor.UserID, *credentialID, provider)
	}
	selected, selectedPref, err := findCredential(ctx, tx, actor.UserID, provider, modelID)
	if err != nil || selected == nil {
		return nil, err
	}
	id, wantModel := usableModelID(modelID)
	if canonicalProvider(provider) != openAICompatibleProvider || !wantModel {
		return selected, nil
	}
	selectedModel := ""
	if selectedPref != nil && selectedPref.modelID != nil {
		selectedModel = *selectedPref.modelID
	}
	if selectedModel == id {
		return selected, nil
	}
	selectedSecret := loadParsedSecret(ctx, tx, vault, actor.UserID, selected.secretID)
	if contains(enabledIDs(selectedSecret, selectedModel), id) {
		return selected, nil
	}
	candidates, err := credentialsForProvider(ctx, tx, actor.UserID, provider)
	if err != nil {
		return nil, err
	}
	for index := range candidates {
		candidate := &candidates[index]
		if candidate.id == selected.id {
			continue
		}
		candidateSecret := loadParsedSecret(ctx, tx, vault, actor.UserID, candidate.secretID)
		if contains(enabledIDs(candidateSecret, ""), id) {
			return candidate, nil
		}
	}
	if selectedSecret == nil || selectedSecret.EnabledModelIDs == nil {
		return selected, nil
	}
	return selected, nil
}

func findCredentialByID(ctx context.Context, tx pgx.Tx, userID, id, provider string) (*credentialRow, error) {
	rows, err := tx.Query(ctx, `SELECT id, provider, label, "secretId", "supportsImages",
		"createdAt", "updatedAt" FROM user_model_credentials
		WHERE id = $1 AND "userId" = $2 AND provider = ANY($3)`, id, userID, storedProviderIDs(provider))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	if !rows.Next() {
		return nil, rows.Err()
	}
	var row credentialRow
	if err := rows.Scan(&row.id, &row.provider, &row.label, &row.secretID,
		&row.supportsImages, &row.createdAt, &row.updatedAt); err != nil {
		return nil, err
	}
	return &row, rows.Err()
}

// findCredential is findModelCredential: a preference whose model matches, then the provider's
// latest preference, then the newest credential.
func findCredential(
	ctx context.Context,
	tx pgx.Tx,
	userID, provider, modelID string,
) (*credentialRow, *preferenceRow, error) {
	preferences, err := listPreferenceRows(ctx, tx, userID)
	if err != nil {
		return nil, nil, err
	}
	filtered := []preferenceRow{}
	for _, preference := range preferences {
		if canonicalProvider(preference.credential.provider) == canonicalProvider(provider) {
			filtered = append(filtered, preference)
		}
	}
	sort.SliceStable(filtered, func(left, right int) bool {
		if !filtered[left].updatedAt.Equal(filtered[right].updatedAt) {
			return filtered[left].updatedAt.After(filtered[right].updatedAt)
		}
		return filtered[left].credentialID > filtered[right].credentialID
	})
	if id, ok := usableModelID(modelID); ok {
		for index := range filtered {
			if filtered[index].modelID != nil {
				if value, valid := usableModelID(*filtered[index].modelID); valid && value == id {
					return &filtered[index].credential, &filtered[index], nil
				}
			}
		}
	}
	if len(filtered) > 0 {
		return &filtered[0].credential, &filtered[0], nil
	}
	credentials, err := credentialsForProvider(ctx, tx, userID, provider)
	if err != nil || len(credentials) == 0 {
		return nil, nil, err
	}
	return &credentials[0], nil, nil
}

func credentialsForProvider(ctx context.Context, tx pgx.Tx, userID, provider string) ([]credentialRow, error) {
	rows, err := tx.Query(ctx, `SELECT id, provider, label, "secretId", "supportsImages",
		"createdAt", "updatedAt" FROM user_model_credentials
		WHERE "userId" = $1 AND provider = ANY($2)
		ORDER BY "updatedAt" DESC, "createdAt" DESC, id DESC`, userID, storedProviderIDs(provider))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var found []credentialRow
	for rows.Next() {
		var row credentialRow
		if err := rows.Scan(&row.id, &row.provider, &row.label, &row.secretID,
			&row.supportsImages, &row.createdAt, &row.updatedAt); err != nil {
			return nil, err
		}
		found = append(found, row)
	}
	return found, rows.Err()
}

func loadParsedSecret(ctx context.Context, tx pgx.Tx, vault *shared.SecretVault, userID, secretID string) *secret {
	if secretID == "" {
		return nil
	}
	var ciphertext string
	err := tx.QueryRow(ctx, `SELECT ciphertext FROM secrets
		WHERE id = $1 AND "userId" = $2 AND "spaceId" IS NULL`, secretID, userID).Scan(&ciphertext)
	if err != nil {
		return nil
	}
	plaintext, err := vault.Writer.Load(ctx, ciphertext, secretID)
	if err != nil {
		return nil
	}
	parsed, err := parseModelSecret(plaintext)
	if err != nil {
		return nil
	}
	return &parsed
}

func enabledIDs(parsed *secret, defaultModel string) []string {
	listed := []string{}
	if parsed != nil && parsed.Kind == "openai_compatible" {
		listed = parsed.EnabledModelIDs
	}
	ids := []string{}
	seen := map[string]bool{}
	add := func(value string) {
		if id, ok := usableModelID(value); ok && !seen[id] {
			seen[id] = true
			ids = append(ids, id)
		}
	}
	add(defaultModel)
	for _, id := range listed {
		add(id)
	}
	return ids
}

func canonicalProvider(provider string) string {
	if provider == "azure-openai-responses" {
		return "azure"
	}
	return provider
}

func storedProviderIDs(provider string) []string {
	if canonicalProvider(provider) == "azure" {
		return []string{"azure", "azure-openai-responses"}
	}
	return []string{provider}
}

// credentialDTO is modelCredentialDto (model-connect.ts:333-420).
func credentialDTO(row credentialRow, plaintext *string) Credential {
	credential := Credential{
		ID:        row.id,
		Provider:  canonicalProvider(row.provider),
		Label:     row.label,
		HasKey:    storedModelSecretHasAPIKey(plaintext),
		IsDefault: row.isDefault,
	}
	if row.modelID != nil && *row.modelID != "" {
		credential.ModelID = row.modelID
	}
	if row.thinkingLevel != nil && *row.thinkingLevel != "" {
		credential.ThinkingLevel = row.thinkingLevel
	}
	if row.provider != openAICompatibleProvider {
		if plaintext == nil {
			return credential
		}
		parsed, err := parseModelSecret(*plaintext)
		if err != nil {
			return credential
		}
		credential.AuthKind = authKind(parsed)
		if parsed.Kind == "oauth" && parsed.ReconnectRequired {
			credential.ReconnectRequired = true
		}
		if parsed.MaxTokens != nil {
			credential.MaxTokens = parsed.MaxTokens
		}
		if parsed.Kind != "oauth" {
			credential.CacheCapabilities = cacheJSON(parsed.Cache)
			credential.ContextWindow = parsed.ContextWindow
		}
		if parsed.Kind == "api_key" {
			credential.AccountID = parsed.AccountID
			credential.GatewayID = parsed.GatewayID
			credential.ProjectID = parsed.ProjectID
			credential.Region = parsed.Region
		}
		credential.ModelSettings = modelSettingsJSON(parsed.Models)
		return credential
	}
	supportsImages := row.supportsImages != nil && *row.supportsImages
	credential.SupportsImages = new(supportsImages)
	if plaintext == nil {
		return credential
	}
	parsed, err := parseModelSecret(*plaintext)
	if err != nil {
		return credential
	}
	if parsed.Kind != "openai_compatible" {
		credential.AuthKind = authKind(parsed)
		return credential
	}
	credential.AuthKind = "openai_compatible"
	modelID := ""
	if row.modelID != nil {
		modelID = *row.modelID
	}
	if parsed.VisionModelIDs != nil {
		credential.SupportsImages = new(modelIDSupportsImages(parsed.VisionModelIDs, row.modelID))
	}
	credential.BaseURL = parsed.BaseURL
	if preset := endpointName(parsed.BaseURL); preset != "" {
		credential.EndpointName = preset
	}
	credential.APIProtocol = parsed.APIProtocol
	if parsed.HeaderNames != nil {
		names := parsed.HeaderNames
		credential.HeaderNames = &names
	}
	if parsed.Reasoning != nil {
		credential.Reasoning = parsed.Reasoning
	} else {
		credential.Reasoning = new(false)
	}
	if parsed.MaxTokens != nil {
		credential.MaxTokens = parsed.MaxTokens
	}
	if parsed.ContextWindow != nil {
		credential.ContextWindow = parsed.ContextWindow
	}
	credential.CacheCapabilities = cacheJSON(parsed.Cache)
	if parsed.MaxImagesPerPrompt != nil {
		credential.MaxImagesPerPrompt = parsed.MaxImagesPerPrompt
	}
	enabled := enabledIDs(&parsed, modelID)
	if parsed.EnabledModelIDs != nil {
		credential.EnabledModelIDs = &enabled
	}
	operatorVision := operatorVisionModels()
	vision := []string{}
	for _, id := range enabled {
		if modelSeesImages(&parsed, row, id) || operatorVision[id] {
			vision = append(vision, id)
		}
	}
	credential.VisionModelIDs = &vision
	credential.ModelSettings = modelSettingsJSON(parsed.Models)
	credential.ThinkingLevels = thinkingLevelsFor(&parsed, row, modelID)
	if modelID != "" {
		credential.ModelID = &modelID
	}
	return credential
}

func storedModelSecretHasAPIKey(plaintext *string) bool {
	if plaintext == nil {
		return false
	}
	parsed, err := parseModelSecret(*plaintext)
	if err != nil {
		return false
	}
	switch parsed.Kind {
	case "api_key":
		return trimJS(parsed.Key) != ""
	case "openai_compatible":
		return parsed.APIKey != nil && trimJS(*parsed.APIKey) != ""
	}
	return false
}

func authKind(parsed secret) string {
	switch parsed.Kind {
	case "oauth":
		return "oauth"
	case "openai_compatible":
		return "openai_compatible"
	}
	return "api_key"
}

func cacheJSON(cache *cacheCapabilities) map[string]any {
	if cache == nil {
		return nil
	}
	out := map[string]any{"scope": cache.Scope}
	if cache.RetentionMs != nil {
		out["retentionMs"] = *cache.RetentionMs
	}
	if cache.MinimumTokens != nil {
		out["minimumTokens"] = *cache.MinimumTokens
	}
	if cache.RetentionMode != nil {
		out["retentionMode"] = *cache.RetentionMode
	}
	if cache.InputCostPerMillion != nil {
		out["inputCostPerMillion"] = *cache.InputCostPerMillion
	}
	if cache.ReadCostPerMillion != nil {
		out["readCostPerMillion"] = *cache.ReadCostPerMillion
	}
	if cache.WriteCostPerMillion != nil {
		out["writeCostPerMillion"] = *cache.WriteCostPerMillion
	}
	return out
}

func modelSettingsJSON(models map[string]modelSettings) map[string]map[string]any {
	if models == nil {
		return nil
	}
	out := map[string]map[string]any{}
	for id, settings := range models {
		entry := map[string]any{}
		if settings.ContextWindow != nil {
			entry["contextWindow"] = *settings.ContextWindow
		}
		if settings.MaxTokens != nil {
			entry["maxTokens"] = *settings.MaxTokens
		}
		if settings.Images != nil {
			entry["images"] = *settings.Images
		}
		if settings.MaxImagesPerPrompt != nil {
			entry["maxImagesPerPrompt"] = *settings.MaxImagesPerPrompt
		}
		if settings.Reasoning != nil {
			entry["reasoning"] = *settings.Reasoning
		}
		out[id] = entry
	}
	return out
}

func modelIDSupportsImages(modelIDs []string, modelID *string) bool {
	if modelID == nil {
		return false
	}
	trimmed := trimJS(*modelID)
	if trimmed == "" {
		return false
	}
	for _, candidate := range modelIDs {
		if trimJS(candidate) == trimmed {
			return true
		}
	}
	return false
}

// modelSeesImages is connectionModelSettings(...).images for one model.
func modelSeesImages(parsed *secret, row credentialRow, modelID string) bool {
	if settings, ok := parsed.Models[modelID]; ok && settings.Images != nil {
		return *settings.Images
	}
	if parsed.VisionModelIDs == nil && row.supportsImages != nil && *row.supportsImages {
		return row.modelID != nil && trimJS(*row.modelID) == trimJS(modelID)
	}
	return modelIDSupportsImages(parsed.VisionModelIDs, &modelID)
}

// thinkingLevelsFor is compatibleModelThinkingLevels through getSupportedThinkingLevels.
func thinkingLevelsFor(parsed *secret, row credentialRow, modelID string) []string {
	lookup := modelID
	if lookup == "" {
		lookup = "custom"
	}
	reasoning := false
	if settings, ok := parsed.Models[lookup]; ok && settings.Reasoning != nil {
		reasoning = *settings.Reasoning
	} else if parsed.Reasoning != nil {
		reasoning = *parsed.Reasoning
	}
	if !reasoning {
		return []string{"off"}
	}
	levels := []string{"off", "minimal", "low", "medium", "high"}
	if parsed.APIProtocol == nil || *parsed.APIProtocol != "anthropic-messages" {
		levels = append(levels, "xhigh", "max")
	}
	return levels
}

// endpointName is compatibleEndpointPreset's match over the built-in hosted services.
func endpointName(baseURL string) string {
	normalized, ok := normalizeBaseURL(baseURL)
	if !ok {
		return ""
	}
	for _, preset := range []struct{ name, url string }{
		{"Ollama Cloud", "https://ollama.com/v1"},
		{"LongCat", "https://api.longcat.chat/openai"},
		{"Alibaba Cloud Token Plan (Singapore)", "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1"},
		{"Alibaba Cloud (Qwen, Singapore)", "https://dashscope-intl.aliyuncs.com/compatible-mode/v1"},
	} {
		if preset.url == normalized {
			return preset.name
		}
	}
	return ""
}

func normalizeBaseURL(raw string) (string, bool) {
	trimmed := trimJS(raw)
	parsed, err := url.Parse(trimmed)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.User != nil {
		return "", false
	}
	path := strings.TrimRight(parsed.Path, "/")
	if !hasVersionSegment(path) {
		if path == "" {
			path = "/v1"
		} else {
			path += "/v1"
		}
	}
	return parsed.Scheme + "://" + parsed.Host + path, true
}

// hasVersionSegment is /^v\d+[a-z]*$/ over path segments.
func hasVersionSegment(path string) bool {
	for _, segment := range strings.Split(path, "/") {
		if len(segment) < 2 || segment[0] != 'v' {
			continue
		}
		digits := 0
		for digits+1 < len(segment) && segment[1+digits] >= '0' && segment[1+digits] <= '9' {
			digits++
		}
		if digits == 0 {
			continue
		}
		rest := segment[1+digits:]
		letters := true
		for _, character := range rest {
			if character < 'a' || character > 'z' {
				letters = false
				break
			}
		}
		if letters {
			return true
		}
	}
	return false
}

// operatorVisionModels is openAiCompatibleVisionModelIds.
func operatorVisionModels() map[string]bool {
	declared := map[string]bool{}
	for _, entry := range strings.Split(os.Getenv("RAKAZO_OPENAI_COMPATIBLE_VISION_MODELS"), ",") {
		if trimmed := trimJS(entry); trimmed != "" {
			declared[trimmed] = true
		}
	}
	return declared
}
