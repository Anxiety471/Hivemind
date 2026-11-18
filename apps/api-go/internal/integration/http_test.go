package integration

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/auth"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/local"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/availability"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/shared"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/routes"
)

const testBuildID = "20261117113741"

func testServer(t *testing.T, database *db.DB, config local.Config) *httptest.Server {
	t.Helper()
	return testServerWithAllowlist(t, database, config, nil)
}

func testServerWithAllowlist(t *testing.T, database *db.DB, config local.Config, allowlist []string) *httptest.Server {
	t.Helper()
	return testServerDeployed(t, database, config, allowlist, shared.Deployment{})
}

// testServerDeployed is testServer with the deployment settings some procedures read; an
// empty WebOrigin is the test origin.
func testServerDeployed(t *testing.T, database *db.DB, config local.Config, allowlist []string, deployment shared.Deployment) *httptest.Server {
	t.Helper()
	secret, authURL := testAuthConfig()
	sessions := auth.New(database, auth.Config{Secret: secret, AuthURL: authURL, SignupAllowlist: allowlist})
	if config.WebOrigin == "" {
		config.WebOrigin = "https://app.example.test"
	}
	if config.TrustedOrigins == nil {
		config.TrustedOrigins = []string{config.WebOrigin}
	}
	if config.BuildID == "" {
		config.BuildID = testBuildID
	}
	if config.MaxUploadBytes == 0 {
		config.MaxUploadBytes = 10 * 1024 * 1024
	}
	if deployment.WebOrigin == "" {
		deployment.WebOrigin = config.WebOrigin
	}
	server := local.New(database, sessions, procedures.All(database, deployment), config)
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		server.ServeHTTP(w, r, routes.ProcedureKey(r.URL.Path))
	})
	httpServer := httptest.NewServer(handler)
	t.Cleanup(httpServer.Close)
	return httpServer
}

func do(t *testing.T, method, url, cookie, body string, headers map[string]string) (*http.Response, []byte) {
	t.Helper()
	request, err := http.NewRequest(method, url, strings.NewReader(body))
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	request.Header.Set("content-type", "application/json")
	request.Header.Set("origin", "https://app.example.test")
	if cookie != "" {
		request.Header.Set("cookie", cookie)
	}
	for key, value := range headers {
		request.Header.Set(key, value)
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatalf("do: %v", err)
	}
	payload, _ := io.ReadAll(response.Body)
	response.Body.Close()
	return response, payload
}

func envelopeCode(t *testing.T, body []byte) string {
	t.Helper()
	var envelope struct {
		JSON struct {
			Code string `json:"code"`
		} `json:"json"`
	}
	if err := json.Unmarshal(body, &envelope); err != nil {
		t.Fatalf("decode envelope %q: %v", body, err)
	}
	return envelope.JSON.Code
}

func TestHTTPItemsAndMiddleware(t *testing.T) {
	database := openTestDB(t)
	seed := seed(t, database)
	server := testServer(t, database, local.Config{})
	cookie := "better-auth.session_token=" + signedCookie(testSecret, seed.SessionToken)

	response, body := do(t, http.MethodPost, server.URL+"/rpc/availability/items", cookie, `{"json":{}}`, nil)
	if response.StatusCode != 200 {
		t.Fatalf("status = %d body=%s", response.StatusCode, body)
	}
	var envelope struct {
		JSON []availability.AccountItem `json:"json"`
	}
	if err := json.Unmarshal(body, &envelope); err != nil {
		t.Fatalf("decode items: %v", err)
	}
	if len(envelope.JSON) != 3 {
		t.Fatalf("items = %d", len(envelope.JSON))
	}
	for _, name := range []string{"Content-Type", "Cache-Control", "X-Rakazo-Build", "Access-Control-Allow-Origin", "Vary"} {
		if response.Header.Get(name) == "" {
			t.Errorf("missing header %s", name)
		}
	}
	if response.Header.Get("Cache-Control") != "no-store" || response.Header.Get("X-Rakazo-Build") != testBuildID {
		t.Errorf("headers = %v", response.Header)
	}
	if response.Header.Get("Access-Control-Allow-Origin") != "https://app.example.test" {
		t.Errorf("allow-origin = %q", response.Header.Get("Access-Control-Allow-Origin"))
	}
	if response.Header.Get("x-request-id") == "" || response.Header.Get("traceparent") == "" {
		t.Errorf("correlation headers missing")
	}
}

func TestHTTPUnauthenticatedAndMethods(t *testing.T) {
	database := openTestDB(t)
	_ = seed(t, database)
	server := testServer(t, database, local.Config{})

	response, body := do(t, http.MethodPost, server.URL+"/rpc/availability/items", "", `{"json":{}}`, nil)
	if response.StatusCode != 401 || envelopeCode(t, body) != "UNAUTHORIZED" {
		t.Fatalf("no cookie = %d %s", response.StatusCode, body)
	}
	response, body = do(t, http.MethodGet, server.URL+"/rpc/availability/items", "", "", nil)
	if response.StatusCode != 405 || envelopeCode(t, body) != "METHOD_NOT_SUPPORTED" {
		t.Fatalf("GET = %d %s", response.StatusCode, body)
	}
	response, body = do(t, http.MethodPost, server.URL+"/rpc/availability/items", "better-auth.session_token=abc.def", `{"json":{}}`, nil)
	if response.StatusCode != 401 {
		t.Fatalf("tampered = %d %s", response.StatusCode, body)
	}
	response, _ = do(t, http.MethodOptions, server.URL+"/rpc/availability/items", "", "", nil)
	if response.StatusCode != 204 || response.Header.Get("Access-Control-Allow-Origin") != "https://app.example.test" {
		t.Fatalf("preflight = %d %v", response.StatusCode, response.Header)
	}
}

func TestHTTPRenewalAndBearer(t *testing.T) {
	database := openTestDB(t)
	seed := seed(t, database)
	server := testServer(t, database, local.Config{})
	cookie := "better-auth.session_token=" + signedCookie(testSecret, seed.SessionToken)

	if _, err := database.Pool.Exec(context.Background(), `UPDATE session SET "expiresAt" = now() + interval '5 days' WHERE id = $1`, seed.SessionID); err != nil {
		t.Fatalf("age session: %v", err)
	}
	before := expiresIn(t, database, seed.SessionID)
	response, body := do(t, http.MethodPost, server.URL+"/rpc/availability/items", cookie, `{"json":{}}`, nil)
	if response.StatusCode != 200 {
		t.Fatalf("renew request = %d %s", response.StatusCode, body)
	}
	cookies := response.Header.Values("Set-Cookie")
	if len(cookies) != 1 || !strings.Contains(cookies[0], "better-auth.session_token=") || !strings.Contains(cookies[0], "Max-Age=604800") {
		t.Fatalf("set-cookie = %v", cookies)
	}
	after := expiresIn(t, database, seed.SessionID)
	if !after.After(before.Add(24 * time.Hour)) {
		t.Errorf("expiry did not slide: %v -> %v", before, after)
	}

	if _, err := database.Pool.Exec(context.Background(), `UPDATE session SET "expiresAt" = now() + interval '5 days' WHERE id = $1`, seed.SessionID); err != nil {
		t.Fatalf("age session: %v", err)
	}
	// The cookie helper percent-encodes; a bearer carries the signed value as-is.
	bearer := "Bearer " + signedRaw(testSecret, seed.SessionToken)
	response, body = do(t, http.MethodPost, server.URL+"/rpc/availability/items", "", `{"json":{}}`, map[string]string{"authorization": bearer})
	if response.StatusCode != 200 {
		t.Fatalf("bearer = %d %s", response.StatusCode, body)
	}
	if len(response.Header.Values("Set-Cookie")) != 0 {
		t.Errorf("bearer emitted set-cookie: %v", response.Header.Values("Set-Cookie"))
	}
}

func TestHTTPActorWithoutSpaceHeader(t *testing.T) {
	database := openTestDB(t)
	seed := seed(t, database)
	server := testServer(t, database, local.Config{})
	cookie := "better-auth.session_token=" + signedCookie(testSecret, seed.SessionToken)

	response, body := do(t, http.MethodPost, server.URL+"/rpc/availability/items", cookie, `{"json":{}}`, map[string]string{"x-rakazo-space-id": ""})
	if response.StatusCode != 200 {
		t.Fatalf("no space header = %d %s", response.StatusCode, body)
	}
	response, body = do(t, http.MethodPost, server.URL+"/rpc/availability/items", cookie, `{"json":{}}`, map[string]string{"x-rakazo-space-id": "some-other-space"})
	if response.StatusCode != 401 {
		t.Fatalf("foreign space = %d %s", response.StatusCode, body)
	}
}

func TestHTTPLookupAuthorization(t *testing.T) {
	database := openTestDB(t)
	seed := seed(t, database)
	cookie := "better-auth.session_token=" + signedCookie(testSecret, seed.SessionToken)

	if _, err := database.Pool.Exec(context.Background(), `UPDATE "user" SET "deactivatedAt" = now() WHERE id = $1`, seed.UserID); err != nil {
		t.Fatalf("deactivate: %v", err)
	}
	server := testServer(t, database, local.Config{})
	response, body := do(t, http.MethodPost, server.URL+"/rpc/availability/items", cookie, `{"json":{}}`, nil)
	if response.StatusCode != 401 {
		t.Fatalf("deactivated = %d %s", response.StatusCode, body)
	}
	if _, err := database.Pool.Exec(context.Background(), `UPDATE "user" SET "deactivatedAt" = NULL, "emailVerified" = false WHERE id = $1`, seed.UserID); err != nil {
		t.Fatalf("reset user: %v", err)
	}
	server = testServer(t, database, local.Config{})
	response, _ = do(t, http.MethodPost, server.URL+"/rpc/availability/items", cookie, `{"json":{}}`, nil)
	if response.StatusCode != 200 {
		t.Fatalf("unverified with empty allowlist = %d", response.StatusCode)
	}
	server = testServerWithAllowlist(t, database, local.Config{}, []string{"only@example.test"})
	response, body = do(t, http.MethodPost, server.URL+"/rpc/availability/items", cookie, `{"json":{}}`, nil)
	if response.StatusCode != 401 {
		t.Fatalf("unverified with allowlist = %d %s", response.StatusCode, body)
	}
}

func TestHTTPClientBuildGateAndSet(t *testing.T) {
	database := openTestDB(t)
	seed := seed(t, database)
	server := testServer(t, database, local.Config{Minimums: map[string]string{"web": "20300101000000"}})
	cookie := "better-auth.session_token=" + signedCookie(testSecret, seed.SessionToken)

	response, body := do(t, http.MethodPost, server.URL+"/rpc/availability/items", cookie, `{"json":{}}`, map[string]string{"x-rakazo-client-build": "web/20200101000000"})
	if response.StatusCode != 426 || envelopeCode(t, body) != "CLIENT_UPDATE_REQUIRED" {
		t.Fatalf("old client = %d %s", response.StatusCode, body)
	}
	if response.Header.Get("x-rakazo-build") != testBuildID {
		t.Errorf("build header = %q", response.Header.Get("x-rakazo-build"))
	}

	input, _ := json.Marshal(map[string]any{"json": map[string]any{
		"kind": "skill", "id": seed.SkillID, "allSpaces": false, "spaceIds": []string{seed.Space2},
	}})
	response, body = do(t, http.MethodPost, server.URL+"/rpc/availability/set", cookie, string(input), nil)
	if response.StatusCode != 200 {
		t.Fatalf("set = %d %s", response.StatusCode, body)
	}
	var envelope struct {
		JSON availability.SpaceAvailability `json:"json"`
	}
	if err := json.Unmarshal(body, &envelope); err != nil {
		t.Fatalf("decode set: %v", err)
	}
	if envelope.JSON.AllSpaces || len(envelope.JSON.SpaceIDs) != 1 || envelope.JSON.SpaceIDs[0] != seed.Space2 {
		t.Fatalf("set availability = %+v", envelope.JSON)
	}
}
