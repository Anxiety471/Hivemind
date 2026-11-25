package memoryroam

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// ModelConfig is the roamer's own model client. It is deliberately separate
// from the bots' model path: a run here never waits on, or takes a slot from, a
// bot's own model call.
type ModelConfig struct {
	Style     string
	BaseURL   string
	Model     string
	APIKey    string
	Headers   map[string]string
	MaxTokens int
	Timeout   time.Duration
}

// Client calls one chat-completions endpoint at a time.
type Client struct {
	config ModelConfig
	http   *http.Client
}

func NewClient(config ModelConfig) (*Client, error) {
	if config.Style != "openai" && config.Style != "anthropic" {
		return nil, fmt.Errorf("model style must be openai or anthropic")
	}
	if strings.TrimSpace(config.BaseURL) == "" {
		return nil, fmt.Errorf("MEMORY_ROAMER_BASE_URL is required")
	}
	if strings.TrimSpace(config.Model) == "" {
		return nil, fmt.Errorf("MEMORY_ROAMER_MODEL is required")
	}
	if strings.TrimSpace(config.APIKey) == "" && len(config.Headers) == 0 {
		return nil, fmt.Errorf("a model key or an authenticated header is required")
	}
	if config.MaxTokens <= 0 {
		return nil, fmt.Errorf("MEMORY_ROAMER_MAX_TOKENS must be positive")
	}
	if config.Timeout <= 0 {
		return nil, fmt.Errorf("MEMORY_ROAMER_TIMEOUT_MS must be positive")
	}
	return &Client{
		config: ModelConfig{
			Style:     config.Style,
			BaseURL:   strings.TrimRight(config.BaseURL, "/"),
			Model:     config.Model,
			APIKey:    config.APIKey,
			Headers:   config.Headers,
			MaxTokens: config.MaxTokens,
			Timeout:   config.Timeout,
		},
		http: &http.Client{Timeout: config.Timeout},
	}, nil
}

type openAIChatRequest struct {
	Model       string              `json:"model"`
	MaxTokens   int                 `json:"max_tokens"`
	Temperature int                 `json:"temperature"`
	Messages    []openAIChatMessage `json:"messages"`
}

type openAIChatMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type openAIChatResponse struct {
	Choices []struct {
		FinishReason string `json:"finish_reason"`
		Message      struct {
			Content json.RawMessage `json:"content"`
		} `json:"message"`
	} `json:"choices"`
	Usage json.RawMessage `json:"usage"`
}

type anthropicRequest struct {
	Model       string             `json:"model"`
	MaxTokens   int                `json:"max_tokens"`
	Temperature int                `json:"temperature"`
	System      string             `json:"system"`
	Messages    []anthropicMessage `json:"messages"`
}

type anthropicMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type anthropicResponse struct {
	Content []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	} `json:"content"`
	Usage json.RawMessage `json:"usage"`
}

type providerError struct {
	Error struct {
		Message string `json:"message"`
	} `json:"error"`
}

func (c *Client) Complete(ctx context.Context, system, prompt string) (string, json.RawMessage, error) {
	url := c.config.BaseURL + "/chat/completions"
	headers := make(http.Header, len(c.config.Headers)+2)
	for name, value := range c.config.Headers {
		headers.Set(name, value)
	}
	headers.Set("content-type", "application/json")
	if headers.Get("authorization") == "" && c.config.APIKey != "" {
		headers.Set("authorization", "Bearer "+c.config.APIKey)
	}
	var body any = openAIChatRequest{
		Model:       c.config.Model,
		MaxTokens:   c.config.MaxTokens,
		Temperature: 0,
		Messages: []openAIChatMessage{
			{Role: "system", Content: system},
			{Role: "user", Content: prompt},
		},
	}
	if c.config.Style == "anthropic" {
		url = c.config.BaseURL + "/v1/messages"
		if headers.Get("x-api-key") == "" && c.config.APIKey != "" {
			headers.Set("x-api-key", c.config.APIKey)
		}
		if headers.Get("anthropic-version") == "" {
			headers.Set("anthropic-version", "2023-06-01")
		}
		body = anthropicRequest{
			Model:       c.config.Model,
			MaxTokens:   c.config.MaxTokens,
			Temperature: 0,
			System:      system,
			Messages:    []anthropicMessage{{Role: "user", Content: prompt}},
		}
	}
	payload, err := json.Marshal(body)
	if err != nil {
		return "", nil, err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(payload))
	if err != nil {
		return "", nil, err
	}
	request.Header = headers
	response, err := c.http.Do(request)
	if err != nil {
		return "", nil, fmt.Errorf("model request: %w", err)
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(response.Body, 2<<20))
	if err != nil {
		return "", nil, fmt.Errorf("read model response: %w", err)
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		message := ""
		var provider providerError
		if json.Unmarshal(raw, &provider) == nil {
			message = strings.TrimSpace(provider.Error.Message)
		}
		if len(message) > 160 {
			message = message[:160]
		}
		return "", nil, fmt.Errorf("model HTTP %d%s", response.StatusCode, suffix(message))
	}
	if c.config.Style == "anthropic" {
		var parsed anthropicResponse
		if err := json.Unmarshal(raw, &parsed); err != nil {
			return "", nil, fmt.Errorf("decode model response: %w", err)
		}
		var text strings.Builder
		for _, part := range parsed.Content {
			if part.Type == "text" {
				text.WriteString(part.Text)
			}
		}
		if text.Len() == 0 {
			return "", parsed.Usage, errors.New("model returned no text")
		}
		return text.String(), parsed.Usage, nil
	}
	var parsed openAIChatResponse
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return "", nil, fmt.Errorf("decode model response: %w", err)
	}
	if len(parsed.Choices) == 0 {
		return "", parsed.Usage, errors.New("model returned no choices")
	}
	content := parsed.Choices[0].Message.Content
	finishReason := strings.TrimSpace(parsed.Choices[0].FinishReason)
	var text string
	if json.Unmarshal(content, &text) == nil {
		if text == "" {
			return "", parsed.Usage, fmt.Errorf("model returned empty text (finish_reason=%s, usage=%s)", finishReason, strings.TrimSpace(string(parsed.Usage)))
		}
		return text, parsed.Usage, nil
	}
	var parts []struct {
		Text string `json:"text"`
	}
	if err := json.Unmarshal(content, &parts); err == nil {
		var joined strings.Builder
		for _, part := range parts {
			joined.WriteString(part.Text)
		}
		if joined.Len() > 0 {
			return joined.String(), parsed.Usage, nil
		}
	}
	return "", parsed.Usage, fmt.Errorf("model returned no text (finish_reason=%s, usage=%s)", finishReason, strings.TrimSpace(string(parsed.Usage)))
}

func (c *Client) Model() string { return c.config.Model }

func suffix(message string) string {
	if message == "" {
		return ""
	}
	return ": " + message
}
