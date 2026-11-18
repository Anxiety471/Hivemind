package integration

import (
	"bytes"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"testing"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/auth"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/gateway"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/local"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/shared"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/routes"
)

func quietLogger() *slog.Logger {
	return slog.New(slog.NewJSONHandler(io.Discard, nil))
}

func testLocalServer(t *testing.T, database *db.DB) *local.Server {
	t.Helper()
	secret, authURL := testAuthConfig()
	sessions := auth.New(database, auth.Config{Secret: secret, AuthURL: authURL})
	return local.New(database, sessions, procedures.All(database, shared.Deployment{WebOrigin: "https://app.example.test"}), local.Config{
		BuildID:        testBuildID,
		MaxUploadBytes: 10 * 1024 * 1024,
		WebOrigin:      "https://app.example.test",
		TrustedOrigins: []string{"https://app.example.test"},
	})
}

func routesStore(t *testing.T, body string) *routes.Store {
	t.Helper()
	path := filepath.Join(t.TempDir(), "routes.json")
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatalf("write routes: %v", err)
	}
	store := routes.NewStore(path)
	if err := store.Load(); err != nil {
		t.Fatalf("load routes: %v", err)
	}
	return store
}

func TestGatewayGoModeUsesLocalProcedure(t *testing.T) {
	database := openTestDB(t)
	seed := seed(t, database)
	target, _ := url.Parse("http://127.0.0.1:9") // never used in go mode
	handler := gateway.New(gateway.Options{
		Upstream: target,
		Routes:   routesStore(t, `{"default":"proxy","routes":{"availability.items":{"mode":"go","readOnly":true}}}`),
		Logger:   quietLogger(),
		Local:    testLocalServer(t, database),
	})
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)

	cookie := "better-auth.session_token=" + signedCookie(testSecret, seed.SessionToken)
	response, body := do(t, http.MethodPost, server.URL+"/rpc/availability/items", cookie, `{"json":{}}`, nil)
	if response.StatusCode != 200 {
		t.Fatalf("go mode = %d %s", response.StatusCode, body)
	}
	for _, name := range []string{`"Alpha skill`, `"Alpha server`, `"Alpha plugin`} {
		if !bytes.Contains(body, []byte(name)) {
			t.Errorf("go mode body = %s, missing %s", body, name)
		}
	}
}

func TestGatewayShadowModeReturnsTypeScript(t *testing.T) {
	database := openTestDB(t)
	seed := seed(t, database)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Rakazo-Build", testBuildID)
		_, _ = w.Write([]byte(`{"json":[]}`))
	}))
	t.Cleanup(upstream.Close)
	target, _ := url.Parse(upstream.URL)
	handler := gateway.New(gateway.Options{
		Upstream: target,
		Routes:   routesStore(t, `{"default":"proxy","routes":{"availability.items":{"mode":"shadow","readOnly":true}}}`),
		Logger:   quietLogger(),
		Local:    testLocalServer(t, database),
	})
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)

	cookie := "better-auth.session_token=" + signedCookie(testSecret, seed.SessionToken)
	response, body := do(t, http.MethodPost, server.URL+"/rpc/availability/items", cookie, `{"json":{}}`, nil)
	if response.StatusCode != 200 || string(body) != `{"json":[]}` {
		t.Fatalf("shadow mode = %d %s (must return the TypeScript answer)", response.StatusCode, body)
	}
}

func TestGatewayRefusesToShadowWrite(t *testing.T) {
	database := openTestDB(t)
	seed := seed(t, database)
	upstream := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	t.Cleanup(upstream.Close)
	target, _ := url.Parse(upstream.URL)
	handler := gateway.New(gateway.Options{
		Upstream: target,
		Routes:   routesStore(t, `{"default":"proxy","routes":{"availability.set":{"mode":"shadow"}}}`),
		Logger:   quietLogger(),
		Local:    testLocalServer(t, database),
	})
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)

	cookie := "better-auth.session_token=" + signedCookie(testSecret, seed.SessionToken)
	input, _ := json.Marshal(map[string]any{"json": map[string]any{
		"kind": "skill", "id": seed.SkillID, "allSpaces": false, "spaceIds": []string{seed.Space2},
	}})
	response, body := do(t, http.MethodPost, server.URL+"/rpc/availability/set", cookie, string(input), nil)
	if response.StatusCode != http.StatusInternalServerError {
		t.Fatalf("shadow write = %d %s", response.StatusCode, body)
	}
	// The write must not have happened.
	spaces := systemScalar[int](t, database, `SELECT count(*) FROM agent_skill_spaces WHERE "skillId" = $1 AND "spaceId" = $2`, seed.SkillID, seed.Space2)
	if spaces != 0 {
		t.Errorf("refused shadow still wrote %d rows", spaces)
	}
}
