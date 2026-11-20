package gateway

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/routes"
)

func modelRetryGateway(t *testing.T) *Gateway {
	t.Helper()
	target, err := url.Parse("http://127.0.0.1:1")
	if err != nil {
		t.Fatalf("parse upstream: %v", err)
	}
	store := routes.NewStore("")
	if err := store.Load(); err != nil {
		t.Fatalf("load routes: %v", err)
	}
	return New(Options{Upstream: target, Routes: store, Logger: discardLogger()})
}

func askModelRetry(t *testing.T, gateway *Gateway, remote string, body string, header http.Header) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(http.MethodPost, ModelRetryPath, strings.NewReader(body))
	request.RemoteAddr = remote
	for name, values := range header {
		request.Header[name] = values
	}
	recorder := httptest.NewRecorder()
	gateway.ServeHTTP(recorder, request)
	return recorder
}

func TestModelRetryAnswersFromTheGoRules(t *testing.T) {
	t.Parallel()
	gateway := modelRetryGateway(t)
	cases := []struct {
		name    string
		message string
		want    string
	}{
		{
			name:    "content filter moves to a backup without a repeat",
			message: `400 data: {"error":{"code":"data_inspection_failed","message":"Input text data may contain inappropriate content."}}`,
			want:    `{"switchToBackup":true,"retrySameModel":false,"unrecognized":null}`,
		},
		{
			name:    "transient failure moves and retries",
			message: "HTTP 503 unavailable",
			want:    `{"switchToBackup":true,"retrySameModel":true,"unrecognized":null}`,
		},
		{
			name:    "unexplained failure without a status retries",
			message: "Cannot read properties of undefined (reading 'choices')",
			want:    `{"switchToBackup":true,"retrySameModel":true,"unrecognized":{"status":null}}`,
		},
		{
			name:    "unexplained failure with a status only moves",
			message: `400 {"error":{"message":"Upstream returned an unexpected reply."}}`,
			want:    `{"switchToBackup":true,"retrySameModel":false,"unrecognized":{"status":400}}`,
		},
		{
			name:    "a refused request neither moves nor retries",
			message: "permission denied; terminated",
			want:    `{"switchToBackup":false,"retrySameModel":false,"unrecognized":null}`,
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			t.Parallel()
			body, err := json.Marshal(modelRetryRequest{Message: testCase.message, Provider: "provider-a"})
			if err != nil {
				t.Fatalf("marshal: %v", err)
			}
			response := askModelRetry(t, gateway, "127.0.0.1:41000", string(body), nil)
			if response.Code != http.StatusOK {
				t.Fatalf("status = %d, want 200", response.Code)
			}
			if got := strings.TrimSpace(response.Body.String()); got != testCase.want {
				t.Fatalf("body = %s, want %s", got, testCase.want)
			}
			if got := response.Header().Get("Cache-Control"); got != "no-store" {
				t.Fatalf("Cache-Control = %q, want no-store", got)
			}
		})
	}
}

func TestModelRetryPassesTheRequestLimitFlag(t *testing.T) {
	t.Parallel()
	response := askModelRetry(t, modelRetryGateway(t), "[::1]:41000",
		`{"message":"permission denied","provider":"provider-a","requestLimitTooSmall":true}`, nil)
	if got := strings.TrimSpace(response.Body.String()); got != `{"switchToBackup":true,"retrySameModel":false,"unrecognized":null}` {
		t.Fatalf("body = %s", got)
	}
}

func TestModelRetryIsOnlyForThisHost(t *testing.T) {
	t.Parallel()
	gateway := modelRetryGateway(t)
	body := `{"message":"HTTP 503 unavailable","provider":"provider-a"}`
	if response := askModelRetry(t, gateway, "203.0.113.7:41000", body, nil); response.Code != http.StatusNotFound {
		t.Fatalf("remote caller status = %d, want 404", response.Code)
	}
	forwarded := http.Header{"X-Forwarded-For": {"203.0.113.7"}}
	if response := askModelRetry(t, gateway, "127.0.0.1:41000", body, forwarded); response.Code != http.StatusNotFound {
		t.Fatalf("forwarded caller status = %d, want 404", response.Code)
	}
}

func TestModelRetryRefusesMalformedRequests(t *testing.T) {
	t.Parallel()
	gateway := modelRetryGateway(t)
	get := httptest.NewRequest(http.MethodGet, ModelRetryPath, nil)
	get.RemoteAddr = "127.0.0.1:41000"
	recorder := httptest.NewRecorder()
	gateway.ServeHTTP(recorder, get)
	if recorder.Code != http.StatusMethodNotAllowed || recorder.Header().Get("Allow") != http.MethodPost {
		t.Fatalf("GET status = %d Allow = %q", recorder.Code, recorder.Header().Get("Allow"))
	}
	if response := askModelRetry(t, gateway, "127.0.0.1:41000", "{", nil); response.Code != http.StatusBadRequest {
		t.Fatalf("bad JSON status = %d, want 400", response.Code)
	}
	huge := `{"message":"` + strings.Repeat("a", maxModelRetryBody) + `"}`
	if response := askModelRetry(t, gateway, "127.0.0.1:41000", huge, nil); response.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversized status = %d, want 413", response.Code)
	}
}
