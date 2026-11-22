package integration

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/auth"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/gateway"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/local"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/orpc"
)

// declineProcedure answers {"json":{"decline":false}} from Go and declines when the input says so.
func declineProcedure() local.Procedure {
	return local.Procedure{
		Name:       "decline.probe",
		ReadOnly:   true,
		MayDecline: true,
		Serve: func(_ context.Context, _ db.Actor, input orpc.Input) (any, *orpc.Error) {
			if strings.Contains(string(input.Raw), `"decline":true`) {
				return nil, local.ErrDecline
			}
			return map[string]any{"from": "go"}, nil
		},
	}
}

type recordedRequest struct {
	cookie, space, body string
}

func declineGateway(t *testing.T, database *db.DB, mode string) (*httptest.Server, *[]recordedRequest, *syncCounter) {
	t.Helper()
	var mu sync.Mutex
	seen := []recordedRequest{}
	hits := &syncCounter{}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		mu.Lock()
		seen = append(seen, recordedRequest{r.Header.Get("Cookie"), r.Header.Get("x-rakazo-space-id"), string(body)})
		mu.Unlock()
		hits.add()
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("X-Rakazo-Build", testBuildID)
		w.Header().Set("X-From", "typescript")
		_, _ = w.Write([]byte(`{"json":{"from":"typescript"}}`))
	}))
	t.Cleanup(upstream.Close)
	target, _ := url.Parse(upstream.URL)
	secret, authURL := testAuthConfig()
	sessions := auth.New(database, auth.Config{Secret: secret, AuthURL: authURL})
	localServer := local.New(database, sessions, []local.Procedure{declineProcedure()}, local.Config{
		BuildID: testBuildID, MaxUploadBytes: 10 * 1024 * 1024,
		WebOrigin: "https://app.example.test", TrustedOrigins: []string{"https://app.example.test"},
	})
	handler := gateway.New(gateway.Options{
		Upstream: target,
		Routes:   routesStore(t, `{"default":"proxy","routes":{"decline.probe":{"mode":"`+mode+`","readOnly":true}}}`),
		Logger:   quietLogger(),
		Local:    localServer,
	})
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	return server, &seen, hits
}

type syncCounter struct {
	mu sync.Mutex
	n  int
}

func (c *syncCounter) add() { c.mu.Lock(); c.n++; c.mu.Unlock() }
func (c *syncCounter) get() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.n
}

// In go mode a request the procedure answers never reaches TypeScript, and a declined one is
// proxied with the caller's own cookie, Space header and body, answering with TypeScript's
// headers alone (no Go cookie renewal, no Go CORS duplicates).
func TestDeclineGoMode(t *testing.T) {
	database := openTestDB(t)
	seed := seed(t, database)
	server, seen, hits := declineGateway(t, database, "go")
	cookie := "better-auth.session_token=" + signedCookie(testSecret, seed.SessionToken)

	response, body := do(t, http.MethodPost, server.URL+"/rpc/decline/probe", cookie, `{"json":{"decline":false}}`, nil)
	if response.StatusCode != 200 || !strings.Contains(string(body), `"from":"go"`) || hits.get() != 0 {
		t.Fatalf("answered request = %d %s upstream hits=%d", response.StatusCode, body, hits.get())
	}

	response, body = do(t, http.MethodPost, server.URL+"/rpc/decline/probe", cookie, `{"json":{"decline":true}}`, map[string]string{"x-rakazo-space-id": seed.Space2})
	if response.StatusCode != 200 || !strings.Contains(string(body), `"from":"typescript"`) {
		t.Fatalf("declined request = %d %s", response.StatusCode, body)
	}
	if response.Header.Get("X-From") != "typescript" || len(response.Header.Values("Set-Cookie")) != 0 {
		t.Fatalf("declined headers = %v, want TypeScript's alone", response.Header)
	}
	if hits.get() != 1 {
		t.Fatalf("upstream hits = %d, want 1", hits.get())
	}
	got := (*seen)[0]
	if got.cookie != cookie || got.space != seed.Space2 || !strings.Contains(got.body, `"decline":true`) {
		t.Fatalf("upstream saw %+v, want the caller's cookie, Space header and body", got)
	}

	// An unauthenticated caller never reaches the decision: Go answers 401 itself.
	response, _ = do(t, http.MethodPost, server.URL+"/rpc/decline/probe", "", `{"json":{"decline":true}}`, nil)
	if response.StatusCode != http.StatusUnauthorized || hits.get() != 1 {
		t.Fatalf("anonymous = %d hits=%d", response.StatusCode, hits.get())
	}
}

// Proxy mode never asks Go; shadow mode serves TypeScript and a declined comparison is quiet.
func TestDeclineProxyAndShadowModes(t *testing.T) {
	database := openTestDB(t)
	seed := seed(t, database)
	cookie := "better-auth.session_token=" + signedCookie(testSecret, seed.SessionToken)
	for _, mode := range []string{"proxy", "shadow"} {
		server, _, hits := declineGateway(t, database, mode)
		for _, input := range []string{`{"json":{"decline":true}}`, `{"json":{"decline":false}}`} {
			response, body := do(t, http.MethodPost, server.URL+"/rpc/decline/probe", cookie, input, nil)
			if response.StatusCode != 200 || !strings.Contains(string(body), `"from":"typescript"`) {
				t.Fatalf("%s %s = %d %s", mode, input, response.StatusCode, body)
			}
		}
		if hits.get() != 2 {
			t.Fatalf("%s upstream hits = %d, want 2", mode, hits.get())
		}
	}
}

// Snapshot (the shadow comparison) reports a decline instead of a response.
func TestSnapshotReportsDecline(t *testing.T) {
	database := openTestDB(t)
	seed := seed(t, database)
	secret, authURL := testAuthConfig()
	sessions := auth.New(database, auth.Config{Secret: secret, AuthURL: authURL})
	server := local.New(database, sessions, []local.Procedure{declineProcedure()}, local.Config{BuildID: testBuildID, WebOrigin: "https://app.example.test"})
	request := httptest.NewRequest(http.MethodPost, "/rpc/decline/probe", strings.NewReader(`{"json":{"decline":true}}`))
	request.Header.Set("Cookie", "better-auth.session_token="+signedCookie(testSecret, seed.SessionToken))
	request.Header.Set("Content-Type", "application/json")
	if snapshot := server.Snapshot(context.Background(), request, "decline.probe"); !snapshot.Declined {
		t.Fatalf("snapshot = %+v, want declined", snapshot)
	}
}
