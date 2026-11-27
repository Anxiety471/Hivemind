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

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/auth"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/local"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/routes"
)

// Options configures a Gateway.
type Options struct {
	Upstream *url.URL
	Routes   *routes.Store
	Logger   *slog.Logger
	// Local serves the procedures this build implements. Nil keeps every entry
	// that asks for one failing closed instead of silently proxying it.
	Local *local.Server
	// TaskDetector serves the internal task-detection and Kanban sync endpoints.
	TaskDetector TaskDetector
	// TaskQueue serves the internal Redis-backed ticket wake & bump queue endpoints.
	TaskQueue TaskQueue
	// Drive serves /api/v1/files and /api/v1/files/:id/content directly in Go.
	Drive http.Handler
}

// Gateway routes /rpc requests either to the configured procedures' Go handlers
// or to the TypeScript API, answers /healthz locally, and answers this host's
// model-retry and task-detection questions.
type Gateway struct {
	upstream   *url.URL
	routes     *routes.Store
	logger     *slog.Logger
	proxy      *httputil.ReverseProxy
	transport  *http.Transport
	local      *local.Server
	taskDetect TaskDetector
	taskQueue  TaskQueue
	drive      http.Handler
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
		upstream:   options.Upstream,
		routes:     options.Routes,
		logger:     options.Logger,
		transport:  transport,
		local:      options.Local,
		taskDetect: options.TaskDetector,
		taskQueue:  options.TaskQueue,
		drive:      options.Drive,
	}
	gateway.proxy = &httputil.ReverseProxy{
		Rewrite: gateway.rewrite,
		// A negative interval flushes after every write, which is what event
		// streams need; ordinary JSON bodies are unaffected.
		FlushInterval:  -1,
		Transport:      transport,
		ErrorHandler:   gateway.upstreamFailed,
		ErrorLog:       slog.NewLogLogger(options.Logger.Handler(), slog.LevelWarn),
		ModifyResponse: func(response *http.Response) error {
			// A reverse proxy in front of this gateway buffers a stream unless it is
			// told not to; the API sets the same header, so this only fills a gap.
			if strings.Contains(response.Header.Get("Content-Type"), "text/event-stream") &&
				response.Header.Get("X-Accel-Buffering") == "" {
				response.Header.Set("X-Accel-Buffering", "no")
			}
			return nil
		},
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
	case r.URL.Path == ModelRetryPath:
		g.modelRetry(status, r)
	case r.URL.Path == TaskDetectContextPath:
		g.taskDetectContext(status, r)
	case r.URL.Path == TaskDetectPreparePath:
		g.taskDetectPrepare(status, r)
	case r.URL.Path == TaskDetectApplyPath:
		g.taskDetectApply(status, r)
	case r.URL.Path == TaskQueueDispatchPath:
		g.taskQueueDispatch(status, r)
	case r.URL.Path == TaskQueueBumpPath:
		g.taskQueueBump(status, r)
	case r.URL.Path == TaskQueueRerunAllPath:
		g.taskQueueRerunAll(status, r)
	case r.URL.Path == TaskQueueHealthPath:
		g.taskQueueHealth(status, r)
	case r.URL.Path == "/api/v1/files" || strings.HasPrefix(r.URL.Path, "/api/v1/files/"):
		if g.drive != nil {
			g.drive.ServeHTTP(status, r)
		} else {
			g.proxy.ServeHTTP(status, r)
		}
	case r.URL.Path == auth.DriveOpenPath && g.drive != nil:
		g.drive.ServeHTTP(status, r)
	case r.URL.Path == "/rpc" || strings.HasPrefix(r.URL.Path, "/rpc/"):
		mode, readOnly, explicit := g.routes.LookupExplicit(r.URL.Path)
		// Space Drive files.* run natively in Go by default when initialized unless
		// routes.json explicitly sets a different mode (e.g. proxy rollback).
		if mode == routes.Proxy && !explicit && strings.HasPrefix(procedure, "files.") && g.local != nil && g.local.Has(procedure) {
			mode = routes.Go
		}
		switch mode {
		case routes.Proxy:
			g.proxy.ServeHTTP(status, r)
		case routes.Go:
			if g.local != nil && g.local.Has(procedure) {
				if g.local.MayDecline(procedure) {
					g.serveOrDecline(status, r, procedure)
				} else {
					g.local.ServeHTTP(status, r, procedure)
				}
			} else {
				g.logger.Error("procedure mode is not implemented by this build",
					"procedure", procedure, "mode", string(mode))
				writeEnvelope(status, http.StatusNotImplemented, "NOT_IMPLEMENTED", "Not Implemented")
			}
		case routes.Shadow:
			if g.local == nil || !g.local.Has(procedure) {
				g.logger.Error("procedure shadow has no Go implementation",
					"procedure", procedure)
				writeEnvelope(status, http.StatusNotImplemented, "NOT_IMPLEMENTED", "Not Implemented")
			} else if g.local.Streams(procedure) {
				// A comparison waits for the whole body, and a stream has none.
				g.logger.Error("refusing to shadow a stream procedure", "procedure", procedure)
				g.proxy.ServeHTTP(status, r)
			} else if g.local.SelfAudited(procedure) {
				// The Go handler records its own security event; the shadow would record it a
				// second time while the TypeScript answer is served, so answer from TypeScript.
				g.logger.Error("refusing to shadow a self-audited procedure", "procedure", procedure)
				g.proxy.ServeHTTP(status, r)
			} else if !readOnly {
				// Shadowing a write would duplicate it.
				g.logger.Error("refusing to shadow a write procedure", "procedure", procedure)
				writeEnvelope(status, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Internal server error")
			} else {
				g.shadow(status, r, procedure)
			}
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
	// 1xx are informational (a 100 Continue from an upload); the log wants the
	// response the client ends with.
	if w.status == 0 && (status >= 200 || status == http.StatusSwitchingProtocols) {
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
