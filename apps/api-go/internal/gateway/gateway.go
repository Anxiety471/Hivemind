// Package gateway is the pass-through HTTP gateway that fronts the TypeScript
// API's /rpc surface.
//
// Slice 0 forwards every procedure unchanged. The request path, query, method,
// body and headers are preserved, the client's address stays at the end of the
// X-Forwarded-For chain, and the response is copied verbatim — including several
// Set-Cookie headers and unbuffered event streams.
package gateway

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
	"time"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/routes"
)

// Options configures a Gateway.
type Options struct {
	Upstream *url.URL
	Routes   *routes.Store
	Logger   *slog.Logger
}

// Gateway routes /rpc requests either to the configured procedures' Go handlers
// (not implemented yet) or to the TypeScript API, and answers /healthz locally.
type Gateway struct {
	upstream  *url.URL
	routes    *routes.Store
	logger    *slog.Logger
	proxy     *httputil.ReverseProxy
	transport *http.Transport
}

// New builds the gateway handler.
func New(options Options) *Gateway {
	transport := &http.Transport{
		// Honour no proxy environment: the upstream is loopback by design.
		Proxy:                 nil,
		DialContext:           (&net.Dialer{Timeout: 5 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
		MaxIdleConns:          100,
		MaxIdleConnsPerHost:   100,
		IdleConnTimeout:       90 * time.Second,
		ExpectContinueTimeout: time.Second,
		// Never add Accept-Encoding on the caller's behalf: the API must see the
		// same request headers it saw when the web proxy spoke to it directly.
		DisableCompression: true,
		ForceAttemptHTTP2:  false,
	}
	gateway := &Gateway{
		upstream:  options.Upstream,
		routes:    options.Routes,
		logger:    options.Logger,
		transport: transport,
	}
	gateway.proxy = &httputil.ReverseProxy{
		Rewrite: gateway.rewrite,
		// A negative interval flushes after every write, which is what event
		// streams need; ordinary JSON bodies are unaffected.
		FlushInterval: -1,
		Transport:     transport,
		ErrorHandler:  gateway.upstreamFailed,
		ErrorLog:      slog.NewLogLogger(options.Logger.Handler(), slog.LevelWarn),
	}
	return gateway
}

// ServeHTTP routes one request.
func (g *Gateway) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	start := time.Now()
	status := &statusWriter{ResponseWriter: w}
	procedure := routes.ProcedureKey(r.URL.Path)

	switch {
	case r.URL.Path == "/healthz":
		g.healthz(status, r)
	case r.URL.Path == "/rpc" || strings.HasPrefix(r.URL.Path, "/rpc/"):
		switch g.routes.ModeFor(r.URL.Path) {
		case routes.Proxy:
			g.proxy.ServeHTTP(status, r)
		case routes.Shadow, routes.Go:
			// Fail closed and visibly: a table entry for a mode this build does
			// not implement must not silently change behaviour.
			g.logger.Error("procedure mode is not implemented by this build",
				"procedure", procedure, "mode", string(g.routes.ModeFor(r.URL.Path)))
			writeEnvelope(status, http.StatusNotImplemented, "NOT_IMPLEMENTED", "Not Implemented")
		default:
			writeEnvelope(status, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Internal server error")
		}
	default:
		http.NotFound(status, r)
	}

	g.logger.Info("http.request.completed",
		"http.method", r.Method,
		"http.path", r.URL.Path,
		"http.status", status.Status(),
		"http.duration_ms", time.Since(start).Milliseconds(),
		"client.ip", peerIP(r.RemoteAddr),
		"request.id", r.Header.Get("x-request-id"),
		"procedure", procedure,
	)
}

// rewrite keeps the request intact and appends this gateway's hop to the
// forwarded chain, exactly as the web proxy does (`appendForwardedFor`).
func (g *Gateway) rewrite(request *httputil.ProxyRequest) {
	request.Out.URL.Scheme = g.upstream.Scheme
	request.Out.URL.Host = g.upstream.Host
	// The web proxy uses changeOrigin, so the API has always seen the target
	// host; keep that true.
	request.Out.Host = g.upstream.Host

	client := peerIP(request.In.RemoteAddr)
	prior := request.In.Header.Values("X-Forwarded-For")
	switch {
	case len(prior) == 0:
		request.Out.Header.Set("X-Forwarded-For", client)
	case strings.Join(prior, ", ") == "":
		request.Out.Header.Set("X-Forwarded-For", client)
	default:
		request.Out.Header.Set("X-Forwarded-For", strings.Join(prior, ", ")+", "+client)
	}
}

// upstreamFailed answers a request that never reached the API.
func (g *Gateway) upstreamFailed(w http.ResponseWriter, r *http.Request, err error) {
	g.logger.Warn("upstream request failed",
		"http.method", r.Method,
		"http.path", r.URL.Path,
		"error", err,
	)
	writeEnvelope(w, http.StatusServiceUnavailable, "SERVICE_UNAVAILABLE", "Service Unavailable")
}

func (g *Gateway) healthz(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		http.Error(w, "Method Not Allowed", http.StatusMethodNotAllowed)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	body, _ := json.Marshal(map[string]any{
		"ok":       true,
		"upstream": g.upstream.Redacted(),
		"routes":   g.routes.Len(),
	})
	if r.Method == http.MethodHead {
		w.WriteHeader(http.StatusOK)
		return
	}
	_, _ = w.Write(append(body, '\n'))
}

// writeEnvelope writes the oRPC error envelope, which is what the web client
// already knows how to read.
func writeEnvelope(w http.ResponseWriter, status int, code, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	if status == http.StatusServiceUnavailable {
		w.Header().Set("Retry-After", "5")
	}
	w.WriteHeader(status)
	envelope := map[string]map[string]any{
		"json": {
			"defined": false,
			"code":    code,
			"status":  status,
			"message": message,
		},
	}
	_ = json.NewEncoder(w).Encode(envelope)
}

func peerIP(remoteAddr string) string {
	host, _, err := net.SplitHostPort(remoteAddr)
	if err == nil {
		return host
	}
	return remoteAddr
}

// statusWriter records the status while keeping the streaming capabilities the
// reverse proxy needs.
type statusWriter struct {
	http.ResponseWriter
	status int
}

func (w *statusWriter) WriteHeader(status int) {
	if w.status == 0 {
		w.status = status
	}
	w.ResponseWriter.WriteHeader(status)
}

func (w *statusWriter) Write(body []byte) (int, error) {
	if w.status == 0 {
		w.status = http.StatusOK
	}
	return w.ResponseWriter.Write(body)
}

func (w *statusWriter) Flush() {
	if w.status == 0 {
		w.status = http.StatusOK
	}
	if flusher, ok := w.ResponseWriter.(http.Flusher); ok {
		flusher.Flush()
	}
}

func (w *statusWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	hijacker, ok := w.ResponseWriter.(http.Hijacker)
	if !ok {
		return nil, nil, fmt.Errorf("hijack: %w", errors.ErrUnsupported)
	}
	return hijacker.Hijack()
}

// Unwrap lets http.ResponseController reach the underlying writer.
func (w *statusWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }

// Status is the status the client saw; a handler that never wrote is a 200.
func (w *statusWriter) Status() int {
	if w.status == 0 {
		return http.StatusOK
	}
	return w.status
}

var _ http.Flusher = (*statusWriter)(nil)
var _ http.Hijacker = (*statusWriter)(nil)
var _ io.StringWriter = (*statusWriter)(nil)

func (w *statusWriter) WriteString(s string) (int, error) {
	if w.status == 0 {
		w.status = http.StatusOK
	}
	return io.WriteString(w.ResponseWriter, s)
}
