package config

import "testing"

// env builds a getter over a fixed map, the way Load reads the process environment.
func env(values map[string]string) func(string) string {
	return func(key string) string { return values[key] }
}

func TestResolveModelDefaults(t *testing.T) {
	cases := []struct {
		name       string
		env        map[string]string
		provider   string
		model      string
		configured bool
		approval   string
		approvalOK bool
	}{
		{
			name:     "defaults to openrouter without a key",
			provider: "openrouter", model: "anthropic/claude-haiku-5.5",
			approval: "openrouter",
		},
		{
			name:     "openrouter key runs the default model",
			env:      map[string]string{"OPENROUTER_API_KEY": "key"},
			provider: "openrouter", model: "anthropic/claude-haiku-5.5", configured: true,
			approval: "openrouter", approvalOK: true,
		},
		{
			name:     "anthropic default model",
			env:      map[string]string{"PI_DEFAULT_PROVIDER": "anthropic", "ANTHROPIC_API_KEY": "key"},
			provider: "anthropic", model: "claude-sonnet-5", configured: true,
			approval: "anthropic", approvalOK: true,
		},
		{
			name:     "explicit model on a provider without a deployment key",
			env:      map[string]string{"PI_DEFAULT_PROVIDER": "google", "PI_DEFAULT_MODEL": "gemini-3-pro"},
			provider: "google", model: "gemini-3-pro",
			approval: "google", approvalOK: false,
		},
		{
			name: "local host credentials name a declared model",
			env: map[string]string{
				"PI_DEFAULT_PROVIDER": "local", "PI_DEFAULT_CREDENTIALS": "host",
				"PI_DEFAULT_MODEL": "llama3", "RAKAZO_LOCAL_MODELS": "llama3, qwen3",
			},
			provider: "local", model: "llama3", configured: true,
			approval: "local", approvalOK: true,
		},
		{
			name: "jev needs a TypeSafe key",
			env: map[string]string{
				"RAKAZO_AUTO_REVIEW_PROVIDER": "jev", "TYPESAFE_API_KEY": "key",
			},
			provider: "openrouter", model: "anthropic/claude-haiku-5.5",
			approval: "jev", approvalOK: true,
		},
		{
			name: "an explicit approval provider wins over the deployment model",
			env: map[string]string{
				"RAKAZO_AUTO_REVIEW_PROVIDER": "anthropic", "RAKAZO_AUTO_REVIEW_MODEL": "claude-sonnet-5",
				"ANTHROPIC_API_KEY": "key",
			},
			provider: "openrouter", model: "anthropic/claude-haiku-5.5",
			approval: "anthropic", approvalOK: true,
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			defaults := resolveModelDefaults(env(testCase.env))
			if defaults.provider != testCase.provider || defaults.model != testCase.model {
				t.Fatalf("model = %s/%s, want %s/%s", defaults.provider, defaults.model, testCase.provider, testCase.model)
			}
			if defaults.configured != testCase.configured {
				t.Fatalf("configured = %v, want %v", defaults.configured, testCase.configured)
			}
			if defaults.approvalProvider != testCase.approval {
				t.Fatalf("approval provider = %q, want %q", defaults.approvalProvider, testCase.approval)
			}
			if defaults.approvalConfigured != testCase.approvalOK {
				t.Fatalf("approval configured = %v, want %v", defaults.approvalConfigured, testCase.approvalOK)
			}
		})
	}
}
