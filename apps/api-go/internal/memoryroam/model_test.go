package memoryroam

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func testClient(t *testing.T, style, body string, status int, check func(*http.Request, []byte)) *Client {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		raw, _ := io.ReadAll(request.Body)
		if check != nil {
			check(request, raw)
		}
		writer.Header().Set("content-type", "application/json")
		writer.WriteHeader(status)
		_, _ = writer.Write([]byte(body))
	}))
	t.Cleanup(server.Close)
	client, err := NewClient(ModelConfig{
		Style: style, BaseURL: server.URL, Model: "test-model", APIKey: "test-key",
		MaxTokens: 128, Timeout: 5 * time.Second,
	})
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	return client
}

func TestCompleteOpenAI(t *testing.T) {
	client := testClient(t, "openai", `{"choices":[{"message":{"content":"{\"documents\":[]}"}}],"usage":{"total_tokens":3}}`, 200,
		func(request *http.Request, raw []byte) {
			if request.URL.Path != "/chat/completions" {
				t.Errorf("path = %s", request.URL.Path)
			}
			if request.Header.Get("authorization") != "Bearer test-key" {
				t.Errorf("authorization = %q", request.Header.Get("authorization"))
			}
			var body openAIChatRequest
			if err := json.Unmarshal(raw, &body); err != nil {
				t.Errorf("body: %v", err)
			}
			if body.Model != "test-model" || len(body.Messages) != 2 {
				t.Errorf("body = %+v", body)
			}
		})
	text, usage, err := client.Complete(context.Background(), "system", "hello")
	if err != nil {
		t.Fatalf("Complete: %v", err)
	}
	if text != `{"documents":[]}` || !strings.Contains(string(usage), "total_tokens") {
		t.Fatalf("text=%q usage=%s", text, usage)
	}
}

func TestCompleteAnthropic(t *testing.T) {
	client := testClient(t, "anthropic", `{"content":[{"type":"text","text":"{\"documents\":[]}"}],"usage":{"input_tokens":1}}`, 200,
		func(request *http.Request, raw []byte) {
			if request.URL.Path != "/v1/messages" {
				t.Errorf("path = %s", request.URL.Path)
			}
			if request.Header.Get("x-api-key") != "test-key" {
				t.Errorf("x-api-key = %q", request.Header.Get("x-api-key"))
			}
			if request.Header.Get("anthropic-version") != "2023-06-01" {
				t.Errorf("anthropic-version = %q", request.Header.Get("anthropic-version"))
			}
		})
	text, _, err := client.Complete(context.Background(), "system", "hello")
	if err != nil {
		t.Fatalf("Complete: %v", err)
	}
	if text != `{"documents":[]}` {
		t.Fatalf("text = %q", text)
	}
}

func TestCompleteReportsProviderErrorsWithoutBody(t *testing.T) {
	client := testClient(t, "openai", `{"error":{"message":"rate limited"}}`, http.StatusTooManyRequests, nil)
	_, _, err := client.Complete(context.Background(), "system", "hello")
	if err == nil || !strings.Contains(err.Error(), "429") || !strings.Contains(err.Error(), "rate limited") {
		t.Fatalf("err = %v", err)
	}
}

func TestNewClientRejectsMissingConfiguration(t *testing.T) {
	if _, err := NewClient(ModelConfig{Style: "openai", BaseURL: "http://x", Model: "m", MaxTokens: 1, Timeout: time.Second}); err == nil {
		t.Fatal("expected a missing-key error")
	}
	if _, err := NewClient(ModelConfig{Style: "other", BaseURL: "http://x", Model: "m", APIKey: "k", MaxTokens: 1, Timeout: time.Second}); err == nil {
		t.Fatal("expected a style error")
	}
}
