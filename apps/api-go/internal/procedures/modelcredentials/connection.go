package modelcredentials

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/shared"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/spacesettings"
)

// MainConnection is one live main-model choice as the roamer can call it: the
// same provider, model, endpoint and key the member's own chats use. It
// deliberately carries no refresh token; a provider that only supports OAuth
// (and not a stored API key) is skipped instead of being half-configured.
type MainConnection struct {
	Provider string
	ModelID  string
	Style    string
	BaseURL  string
	APIKey   string
	Headers  map[string]string
}

type mainRole struct {
	provider           string
	modelID            string
	credentialID       *string
	credentialProvider string
	secretID           string
}

// ResolveMainConnections loads every main-model role choice in order, newest
// preference first, and opens each credential with the deployment vault. The
// roamer tries them in that order, so an exhausted first connection falls back
// to the same backup the member's chats would use.
func ResolveMainConnections(
	ctx context.Context,
	database *db.DB,
	deployment shared.Deployment,
	actor db.Actor,
) ([]MainConnection, error) {
	if deployment.Vault == nil {
		return nil, errors.New("model credential vault is not configured")
	}
	var rows []mainRole
	var ciphertexts map[string]string
	var loadErr error
	err := database.Tenant(ctx, actor, func(tx pgx.Tx) error {
		target, err := spacesettings.Target(ctx, tx, actor, "models", "")
		if err != nil {
			return err
		}
		query := `SELECT provider, "modelId", "credentialId" FROM user_model_role_choices
			WHERE "userId" = $1 AND role = 'main' ORDER BY position`
		args := []any{actor.UserID}
		if target == "space" {
			query = `SELECT provider, "modelId", "credentialId" FROM space_model_role_choices
				WHERE "userId" = $1 AND "spaceId" = $2 AND role = 'main' ORDER BY position`
			args = append(args, actor.SpaceID)
		}
		result, err := tx.Query(ctx, query, args...)
		if err != nil {
			return err
		}
		defer result.Close()
		for result.Next() {
			var row mainRole
			if err := result.Scan(&row.provider, &row.modelID, &row.credentialID); err != nil {
				return err
			}
			rows = append(rows, row)
		}
		if err := result.Err(); err != nil {
			return err
		}
		if len(rows) == 0 {
			return errors.New("no main model is configured")
		}
		credentials := make([]credentialRow, 0, len(rows))
		for index := range rows {
			chosen, err := connectedCredential(ctx, tx, deployment.Vault, actor,
				rows[index].provider, rows[index].modelID, rows[index].credentialID)
			if err != nil {
				loadErr = err
				continue
			}
			if chosen == nil || chosen.secretID == "" {
				continue
			}
			rows[index].credentialID = &chosen.id
			rows[index].credentialProvider = chosen.provider
			rows[index].secretID = chosen.secretID
			credentials = append(credentials, *chosen)
		}
		if len(credentials) == 0 {
			if loadErr != nil {
				return loadErr
			}
			return errors.New("the main model has no saved credential")
		}
		ciphertexts, err = secretCiphertexts(ctx, tx, actor.UserID, credentials)
		return err
	})
	if err != nil {
		return nil, err
	}

	var connections []MainConnection
	for _, row := range rows {
		if row.credentialID == nil || row.secretID == "" {
			continue
		}
		ciphertext, ok := ciphertexts[row.secretID]
		if !ok {
			continue
		}
		plaintext, err := deployment.Vault.Writer.Load(ctx, ciphertext, row.secretID)
		if err != nil {
			continue
		}
		parsed, err := parseModelSecret(plaintext)
		if err != nil {
			continue
		}
		provider := row.credentialProvider
		if provider == "" {
			provider = row.provider
		}
		connection, err := connectionForSecret(provider, row.modelID, parsed)
		if err == nil {
			connections = append(connections, *connection)
		}
	}
	if len(connections) == 0 {
		return nil, errors.New("none of the main model connections can be called by the roamer")
	}
	return connections, nil
}

// sessionID gives the OpenCode Go endpoint a routing key for one roamer pass.
func sessionID() string {
	var value [16]byte
	if _, err := rand.Read(value[:]); err != nil {
		return "memory-roamer"
	}
	return hex.EncodeToString(value[:])
}

func connectionForSecret(provider, modelID string, parsed secret) (*MainConnection, error) {
	modelID = strings.TrimSpace(modelID)
	if modelID == "" && len(parsed.EnabledModelIDs) > 0 {
		modelID = parsed.EnabledModelIDs[0]
	}
	if modelID == "" {
		return nil, errors.New("the main model has no model id")
	}
	switch parsed.Kind {
	case "openai_compatible":
		style := "openai"
		if parsed.APIProtocol != nil {
			switch *parsed.APIProtocol {
			case "anthropic-messages":
				style = "anthropic"
			case "responses":
				return nil, errors.New("the main model uses the Responses API, which the roamer does not speak")
			}
		}
		key := ""
		if parsed.APIKey != nil {
			key = *parsed.APIKey
		}
		return &MainConnection{
			Provider: provider, ModelID: modelID, Style: style,
			BaseURL: parsed.BaseURL, APIKey: key, Headers: parsed.Headers,
		}, nil
	case "api_key":
		style := "openai"
		baseURL := ""
		switch provider {
		case "anthropic":
			style = "anthropic"
			baseURL = "https://api.anthropic.com"
		case "openai":
			baseURL = "https://api.openai.com/v1"
		case "opencode-go":
			baseURL = "https://opencode.ai/inference/go/v1"
			return &MainConnection{
				Provider: provider, ModelID: modelID, Style: style,
				BaseURL: baseURL, APIKey: parsed.Key,
				Headers: map[string]string{"x-opencode-session": sessionID()},
			}, nil
		default:
			return nil, fmt.Errorf("the main model provider %q has no endpoint the roamer knows", provider)
		}
		return &MainConnection{
			Provider: provider, ModelID: modelID, Style: style,
			BaseURL: baseURL, APIKey: parsed.Key,
		}, nil
	default:
		return nil, fmt.Errorf("the main model credential kind %q is not usable", parsed.Kind)
	}
}
