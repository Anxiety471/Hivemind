package gateway

import (
	"bufio"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/routes"
)

func discardLogger() *slog.Logger {
	return slog.New(slog.NewJSONHandler(io.Discard, nil))
}

func testGateway(t *testing.T, upstream string, routesPath string) *httptest.Server {
	t.Helper()
	target, err := url.Parse(upstream)
	if err != nil {
		t.Fatalf("parse upstream: %v", err)
	}
	store := routes.NewStore(routesPath)
	if err := store.Load(); err != nil {
		t.Fatalf("load routes: %v", err)
	}
	server := httptest.NewServer(New(Options{Upstream: target, Routes: store, Logger: discardLogger()}))
	t.Cleanup(server.Close)
	return server
}

func TestProxyPreservesRequestAndResponse(t *testing.T) {
	type seen struct {
		method, requestURI, host, authorization, cookie, custom, forwardedFor, body string
	}
	requests := make(chan seen, 1)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		requests <- seen{
			method:        r.Method,
			requestURI:    r.URL.RequestURI(),
			host:          r.Host,
			authorization: r.Header.Get("Authorization"),
			cookie:        r.Header.Get("Cookie"),
			custom:        r.Header.Get("X-Custom"),
			forwardedFor:  r.Header.Get("X-Forwarded-For"),
			body:          string(body),
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("X-Upstream", "yes")
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(`{"json":{"ok":true}}`))
	}))
	t.Cleanup(upstream.Close)

	gatewayURL := testGateway(t, upstream.URL, "").URL
	request, err := http.NewRequest(http.MethodPost, gatewayURL+"/rpc/threads/send?x=1&y=a%2Fb", strings.NewReader("payload"))
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	request.Header.Set("Authorization", "Bearer device-token")
	request.Header.Set("Cookie", "session=abc")
	request.Header.Set("X-Custom", "kept")
	request.Header.Set("X-Forwarded-For", "203.0.113.9")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatalf("do request: %v", err)
	}
	defer response.Body.Close()

	got := <-requests
	if got.method != http.MethodPost {
		t.Errorf("method = %q, want POST", got.method)
	}
	if got.requestURI != "/rpc/threads/send?x=1&y=a%2Fb" {
		t.Errorf("request URI = %q", got.requestURI)
	}
	upstreamHost := strings.TrimPrefix(upstream.URL, "http://")
	if got.host != upstreamHost {
		t.Errorf("host = %q, want %q (changeOrigin)", got.host, upstreamHost)
	}
	if got.authorization != "Bearer device-token" || got.cookie != "session=abc" || got.custom != "kept" {
		t.Errorf("headers changed: %+v", got)
	}
	if got.body != "payload" {
		t.Errorf("body = %q", got.body)
	}
	if got.forwardedFor != "203.0.113.9, 127.0.0.1" {
		t.Errorf("x-forwarded-for = %q, want the prior chain plus this hop", got.forwardedFor)
	}
	if response.StatusCode != http.StatusCreated {
		t.Errorf("status = %d, want 201", response.StatusCode)
	}
	if response.Header.Get("X-Upstream") != "yes" {
		t.Errorf("response header not copied")
	}
	body, _ := io.ReadAll(response.Body)
	if string(body) != `{"json":{"ok":true}}` {
		t.Errorf("body = %q", body)
	}
}

func TestProxyPreservesForwardedChain(t *testing.T) {
	forwarded := make(chan string, 1)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		forwarded <- r.Header.Get("X-Forwarded-For")
	}))
	t.Cleanup(upstream.Close)

	gatewayURL := testGateway(t, upstream.URL, "").URL
	request, _ := http.NewRequest(http.MethodGet, gatewayURL+"/rpc/me", nil)
	request.Header.Set("X-Forwarded-For", "203.0.113.9, 198.51.100.7")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatalf("do request: %v", err)
	}
	response.Body.Close()
	if got := <-forwarded; got != "203.0.113.9, 198.51.100.7, 127.0.0.1" {
		t.Errorf("x-forwarded-for = %q", got)
	}
}

func TestProxySetsForwardedForWhenAbsent(t *testing.T) {
	forwarded := make(chan string, 1)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		forwarded <- r.Header.Get("X-Forwarded-For")
	}))
	t.Cleanup(upstream.Close)

	gatewayURL := testGateway(t, upstream.URL, "").URL
	response, err := http.Get(gatewayURL + "/rpc/health")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	response.Body.Close()
	if got := <-forwarded; got != "127.0.0.1" {
		t.Errorf("x-forwarded-for = %q, want the peer only", got)
	}
}

func TestProxyCopiesMultipleSetCookie(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Add("Set-Cookie", "a=1; Path=/; HttpOnly")
		w.Header().Add("Set-Cookie", "b=2; Path=/; SameSite=Lax")
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(upstream.Close)

	response, err := http.Get(testGateway(t, upstream.URL, "").URL + "/rpc/auth")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	response.Body.Close()
	raw := response.Header.Values("Set-Cookie")
	if len(raw) != 2 {
		t.Fatalf("set-cookie headers = %d (%v), want 2", len(raw), raw)
	}
	if !strings.HasPrefix(raw[0], "a=1;") || !strings.HasPrefix(raw[1], "b=2;") {
		t.Errorf("set-cookie order/values changed: %v", raw)
	}
}

func TestProxyStreamsEventsImmediately(t *testing.T) {
	release := make(chan struct{})
	var releaseOnce sync.Once
	releaseNow := func() { releaseOnce.Do(func() { close(release) }) }
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(w, "data: first\n\n")
		w.(http.Flusher).Flush()
		<-release
		_, _ = io.WriteString(w, "data: second\n\n")
		w.(http.Flusher).Flush()
	}))
	t.Cleanup(upstream.Close)
	t.Cleanup(releaseNow)

	response, err := http.Get(testGateway(t, upstream.URL, "").URL + "/rpc/threads/subscribe")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	defer response.Body.Close()
	if got := response.Header.Get("Content-Type"); got != "text/event-stream" {
		t.Fatalf("content-type = %q", got)
	}

	lines := make(chan string, 2)
	go func() {
		reader := bufio.NewReader(response.Body)
		line, err := reader.ReadString('\n')
		if err != nil {
			lines <- "error: " + err.Error()
			return
		}
		lines <- line
	}()
	select {
	case line := <-lines:
		if strings.HasPrefix(line, "error: ") || line != "data: first\n" {
			t.Fatalf("first event = %q", line)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("first event was buffered until the upstream finished")
	}
	releaseNow()
}

func TestUpstreamFailureIsServiceUnavailable(t *testing.T) {
	dead := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	deadURL := dead.URL
	dead.Close()

	response, err := http.Post(testGateway(t, deadURL, "").URL+"/rpc/me", "application/json", strings.NewReader(`{"json":{}}`))
	if err != nil {
		t.Fatalf("post: %v", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", response.StatusCode)
	}
	if response.Header.Get("Retry-After") != "5" {
		t.Errorf("retry-after = %q", response.Header.Get("Retry-After"))
	}
	var envelope struct {
		JSON struct {
			Code   string `json:"code"`
			Status int    `json:"status"`
		} `json:"json"`
	}
	if err := json.NewDecoder(response.Body).Decode(&envelope); err != nil {
		t.Fatalf("decode envelope: %v", err)
	}
	if envelope.JSON.Code != "SERVICE_UNAVAILABLE" || envelope.JSON.Status != http.StatusServiceUnavailable {
		t.Errorf("envelope = %+v", envelope.JSON)
	}
}

func TestHealthz(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	t.Cleanup(upstream.Close)
	base := testGateway(t, upstream.URL, "").URL

	response, err := http.Get(base + "/healthz")
	if err != nil {
		t.Fatalf("get healthz: %v", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK || response.Header.Get("Cache-Control") != "no-store" {
		t.Fatalf("healthz = %d cache-control=%q", response.StatusCode, response.Header.Get("Cache-Control"))
	}
	var body map[string]any
	if err := json.NewDecoder(response.Body).Decode(&body); err != nil || body["ok"] != true {
		t.Fatalf("healthz body = %v err=%v", body, err)
	}
	response, err = http.Post(base+"/healthz", "text/plain", nil)
	if err != nil {
		t.Fatalf("post healthz: %v", err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusMethodNotAllowed {
		t.Errorf("post healthz status = %d, want 405", response.StatusCode)
	}
}

func TestUnknownPathIsNotFound(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	t.Cleanup(upstream.Close)
	response, err := http.Get(testGateway(t, upstream.URL, "").URL + "/api/auth/capabilities")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusNotFound {
		t.Errorf("status = %d, want 404", response.StatusCode)
	}
}

func TestUnimplementedModeFailsClosed(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(upstream.Close)

	path := filepath.Join(t.TempDir(), "routes.json")
	if err := os.WriteFile(path, []byte(`{"default":"proxy","routes":{"me":{"mode":"go","readOnly":true}}}`), 0o600); err != nil {
		t.Fatalf("write routes: %v", err)
	}
	base := testGateway(t, upstream.URL, path).URL

	response, err := http.Post(base+"/rpc/me", "application/json", strings.NewReader(`{"json":{}}`))
	if err != nil {
		t.Fatalf("post: %v", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusNotImplemented {
		t.Fatalf("status = %d, want 501", response.StatusCode)
	}
	var envelope struct {
		JSON struct {
			Code string `json:"code"`
		} `json:"json"`
	}
	if err := json.NewDecoder(response.Body).Decode(&envelope); err != nil || envelope.JSON.Code != "NOT_IMPLEMENTED" {
		t.Errorf("envelope = %+v err=%v", envelope.JSON, err)
	}

	// A procedure without an entry still proxies.
	response, err = http.Get(base + "/rpc/health")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Errorf("proxied status = %d, want 200", response.StatusCode)
	}
}

func TestStatusWriterRecordsFinalStatus(t *testing.T) {
	recorder := httptest.NewRecorder()
	writer := &statusWriter{ResponseWriter: recorder}
	writer.WriteHeader(http.StatusContinue)
	writer.WriteHeader(http.StatusUnauthorized)
	if got := writer.Status(); got != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", got)
	}
}
