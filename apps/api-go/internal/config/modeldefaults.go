package config

import "strings"

// deploymentKeyEnv is modelProviderDefinition(...).deployment.keyEnv: the providers whose
// deployment-wide model runs on a key from the environment.
var deploymentKeyEnv = map[string]string{
	"openrouter": "OPENROUTER_API_KEY",
	"anthropic":  "ANTHROPIC_API_KEY",
	"deepseek":   "DEEPSEEK_API_KEY",
}

// deploymentDefaultModel is modelProviderDefinition(...).deployment.defaultModel.
var deploymentDefaultModel = map[string]string{
	"openrouter": "anthropic/claude-haiku-5.5",
	"anthropic":  "claude-sonnet-5",
	"deepseek":   "deepseek-flash",
}

// openRouterDefaultModel is DEFAULT_OPENROUTER_MODEL_ID, used when the provider has no
// deployment entry of its own.
const openRouterDefaultModel = "anthropic/claude-haiku-5.5"

// modelDefaults is resolveDeploymentModel plus resolveAutoReviewChecker and
// isAutoReviewCheckerConfigured({}), the model views need and no runtime does.
type modelDefaults struct {
	provider   string
	model      string
	configured bool

	approvalProvider   string
	approvalModel      string
	approvalConfigured bool
}

func resolveModelDefaults(getenv func(string) string) modelDefaults {
	provider := strings.TrimSpace(getenv("PI_DEFAULT_PROVIDER"))
	if provider == "" {
		provider = "openrouter"
	}
	explicitModel := strings.TrimSpace(getenv("PI_DEFAULT_MODEL"))
	keyEnv := deploymentKeyEnv[provider]
	key := ""
	if keyEnv != "" {
		key = strings.TrimSpace(getenv(keyEnv))
	}
	model := explicitModel
	if model == "" {
		model = deploymentDefaultModel[provider]
	}
	if model == "" {
		model = openRouterDefaultModel
	}
	hostCredentials := false
	if key == "" && explicitModel != "" && strings.TrimSpace(getenv("PI_DEFAULT_CREDENTIALS")) == "host" {
		hostCredentials = hostCredentialsResolve(provider, explicitModel, getenv)
	}
	defaults := modelDefaults{
		provider:   provider,
		model:      model,
		configured: key != "" || hostCredentials,
	}
	defaults.approvalProvider, defaults.approvalModel = resolveAutoReviewChecker(getenv)
	defaults.approvalConfigured = autoReviewCheckerConfigured(defaults, getenv)
	return defaults
}

// hostCredentialsResolve is the host-credentials branch of resolveDeploymentModel: a local
// server's declared model, a provider that resolves credentials per request, or one whose
// environment reports host credentials.
func hostCredentialsResolve(provider, model string, getenv func(string) string) bool {
	if provider == "local" {
		return containsValue(splitList(getenv("RAKAZO_LOCAL_MODELS")), model)
	}
	switch provider {
	case "amazon-bedrock", "claude-code":
		return true
	}
	return false
}

// resolveAutoReviewChecker is resolveAutoReviewChecker (auto-review.ts:96-124).
func resolveAutoReviewChecker(getenv func(string) string) (string, string) {
	requested := strings.ToLower(strings.TrimSpace(getenv("RAKAZO_AUTO_REVIEW_PROVIDER")))
	kind := "llm"
	if requested == "jev" && strings.TrimSpace(getenv("TYPESAFE_API_KEY")) != "" {
		kind = "jev"
	}
	if requested == "scripted" && getenv("AGENT_RUNTIME") == "scripted" {
		kind = "scripted"
	}
	switch kind {
	case "jev":
		model := strings.TrimSpace(getenv("RAKAZO_AUTO_REVIEW_MODEL"))
		if model == "" {
			model = "jev-latest"
		}
		return "jev", model
	case "scripted":
		return "scripted", "scripted"
	}
	overrideProvider := strings.TrimSpace(getenv("RAKAZO_AUTO_REVIEW_PROVIDER"))
	overrideModel := strings.TrimSpace(getenv("RAKAZO_AUTO_REVIEW_MODEL"))
	if overrideProvider != "" && overrideModel != "" && !isVerifierKind(overrideProvider) {
		return overrideProvider, overrideModel
	}
	if local := splitList(getenv("RAKAZO_LOCAL_MODELS")); len(local) > 0 {
		return "local", local[0]
	}
	// The deployment's own model is the last resort; resolveDeploymentModel always names one.
	provider := strings.TrimSpace(getenv("PI_DEFAULT_PROVIDER"))
	if provider == "" {
		provider = "openrouter"
	}
	model := strings.TrimSpace(getenv("PI_DEFAULT_MODEL"))
	if model == "" {
		model = deploymentDefaultModel[provider]
	}
	if model == "" {
		model = openRouterDefaultModel
	}
	return provider, model
}

func isVerifierKind(value string) bool {
	normalized := strings.ToLower(strings.TrimSpace(value))
	return normalized == "jev" || normalized == "scripted"
}

// autoReviewCheckerConfigured is isAutoReviewCheckerConfigured({}) (auto-review.ts:130-146).
func autoReviewCheckerConfigured(defaults modelDefaults, getenv func(string) string) bool {
	switch defaults.approvalProvider {
	case "jev":
		return strings.TrimSpace(getenv("TYPESAFE_API_KEY")) != ""
	case "scripted":
		return true
	case "local":
		return len(splitList(getenv("RAKAZO_LOCAL_MODELS"))) > 0
	}
	if defaults.approvalProvider == defaults.provider && defaults.configured {
		return true
	}
	if defaults.approvalProvider == "openrouter" && strings.TrimSpace(getenv("OPENROUTER_API_KEY")) != "" {
		return true
	}
	if defaults.approvalProvider == "anthropic" && strings.TrimSpace(getenv("ANTHROPIC_API_KEY")) != "" {
		return true
	}
	return false
}

func containsValue(values []string, value string) bool {
	for _, candidate := range values {
		if candidate == value {
			return true
		}
	}
	return false
}
