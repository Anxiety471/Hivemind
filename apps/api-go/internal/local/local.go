// Package local serves the ported procedures with the middleware the TypeScript
// API applies to /rpc: CORS, request ids, the client-build gate, no-store, the
// signed-in body limit and the ORPC envelopes.
package local

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/auth"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/effects"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/orpc"
)

// Procedure is one ported procedure. It runs inside the caller's tenant
// transaction only if it opens one itself, so it receives the actor and DB.
type Procedure struct {
	Name     string
	ReadOnly bool
	// SelfAudited marks a procedure that records its own security event inside the handler (the
	// hand-recorded events such as credential.revealed). It is never shadowed: the shadow's Go
	// snapshot runs the handler, so the event would be recorded a second time while the
	// TypeScript answer is served. The audited middleware's own events are not affected.
	SelfAudited bool
	Serve       func(ctx context.Context, actor db.Actor, input orpc.Input) (any, *orpc.Error)
	// Stream, when set, replaces Serve: the procedure answers with an event stream. It is never
	// shadowed (a comparison would wait for a stream that does not end).
	Stream *Stream
}

// Stream is a procedure that answers with an oRPC event iterator over server-sent events.
// The server owns the framing, the keepalive comments, the heartbeat and the periodic
// re-check that the session is still the one that opened the stream.
type Stream struct {
	// Follow runs the procedure's own checks and starts listening. A failure is answered as an
	// ordinary error before any stream starts. Each payload read from signals becomes a Frame;
	// stop ends the listening.
	Follow func(ctx context.Context, actor db.Actor, input orpc.Input) (signals <-chan string, stop func(), failure *orpc.Error)
	// Frame is the event a signal's payload stands for. An empty payload is the heartbeat the
	// server sends after a quiet spell: any frame tells the client the stream is alive, and
	// makes it read again if a signal was missed.
	Frame func(actor db.Actor, payload string) any
}

// StreamTiming sets how a stream paces itself; zero fields take the defaults the TypeScript
// API uses.
type StreamTiming struct {
	// Keepalive is how often an empty comment goes out (oRPC's event-stream default).
	Keepalive time.Duration
	// Heartbeat is the silence after which a stream sends a frame of its own (HEARTBEAT_MS).
	Heartbeat time.Duration
	// Recheck is how often the session is looked up again before a frame goes out
	// (SESSION_RECHECK_MS).
	Recheck time.Duration
}

func (t StreamTiming) withDefaults() StreamTiming {
	if t.Keepalive <= 0 {
		t.Keepalive = 5 * time.Second
	}
	if t.Heartbeat <= 0 {
		t.Heartbeat = 20 * time.Second
	}
	if t.Recheck <= 0 {
		t.Recheck = 10 * time.Second
	}
	return t
}

// Config is the per-deployment middleware configuration.
type Config struct {
	BuildID        string
	Minimums       map[string]string
	MaxUploadBytes int64
	WebOrigin      string
	TrustedOrigins []string
	Logger         *slog.Logger
	// ClientIP resolves the caller's address for security events; nil trusts
	// loopback (or the container's networks), as an unset TRUSTED_PROXIES does.
	ClientIP       *effects.ClientIPResolver
	ClientIPHeader string
	// Effects runs the middleware's own effects and owns the audit recorder and realtime
	// notifier the procedures publish through. nil builds its own, which no procedure can
	// reach: a procedure that publishes signals needs the runner handed in.
	Effects *effects.Runner
	// Stream paces the procedures that answer with an event stream.
	Stream StreamTiming
}

// Server handles /rpc requests for procedures this build implements.
type Server struct {
	db       *db.DB
	auth     *auth.Service
	procs    map[string]Procedure
	config   Config
	maxBody  int64
	maxLabel string

	clientIP       *effects.ClientIPResolver
	clientIPHeader string
	effects        *effects.Runner
}

// New builds the local server.
func New(database *db.DB, sessions *auth.Service, procedures []Procedure, config Config) *Server {
	registry := make(map[string]Procedure, len(procedures))
	for _, procedure := range procedures {
		registry[procedure.Name] = procedure
	}
	if config.Logger == nil {
		config.Logger = slog.New(slog.NewJSONHandler(io.Discard, nil))
	}
	label := "10 MB"
	if config.MaxUploadBytes > 0 {
		label = fmt.Sprintf("%d MB", config.MaxUploadBytes/(1024*1024))
	}
	resolver := config.ClientIP
	if resolver == nil {
		resolver, _ = effects.NewClientIPResolver(effects.DefaultTrustedProxies())
	}
	header := strings.ToLower(config.ClientIPHeader)
	if header == "" {
		header = "x-forwarded-for"
	}
	runner := config.Effects
	if runner == nil {
		runner = effects.NewRunner(database, config.Logger)
	}
	return &Server{
		db:             database,
		auth:           sessions,
		procs:          registry,
		config:         config,
		maxBody:        RequestMaxBytes(config.MaxUploadBytes),
		maxLabel:       label,
		clientIP:       resolver,
		clientIPHeader: header,
		effects:        runner,
	}
}

// RequestMaxBytes is the signed-in /rpc body limit: room for base64 expansion
// plus the JSON envelope, at least 16 MiB.
func RequestMaxBytes(maxUpload int64) int64 {
	limit := (maxUpload/3)*4 + 1024*1024
	if limit < 16*1024*1024 {
		limit = 16 * 1024 * 1024
	}
	return limit
}

// Has reports whether this build implements the procedure.
func (s *Server) Has(name string) bool {
	_, ok := s.procs[name]
	return ok
}

// Streams reports whether the procedure answers with an event stream.
func (s *Server) Streams(name string) bool {
	procedure, ok := s.procs[name]
	return ok && procedure.Stream != nil
}

// SelfAudited reports whether the procedure records its own security event, which makes it
// unsafe to shadow (the snapshot would record the event twice).
func (s *Server) SelfAudited(name string) bool {
	procedure, ok := s.procs[name]
	return ok && procedure.SelfAudited
}

// Wait blocks until the background realtime signals of served procedures have gone out.
func (s *Server) Wait() { s.effects.Wait() }

// Count is how many procedures this build serves locally.
func (s *Server) Count() int { return len(s.procs) }

// MaxBody is the largest request shadow mode can copy.
func (s *Server) MaxBody() int64 { return s.maxBody }

// ServeHTTP runs the middleware chain and the procedure.
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request, procedure string) {
	started := time.Now()
	status := &statusWriter{ResponseWriter: w}
	s.cors(status, r)
	s.correlation(status, r)

	if r.Method == http.MethodOptions {
		status.WriteHeader(http.StatusNoContent)
		s.log(r, procedure, status.Status(), started)
		return
	}
	status.Header().Set("Cache-Control", "no-store")

	if r.Method != http.MethodPost {
		orpc.WriteError(status, orpc.New("METHOD_NOT_SUPPORTED", http.StatusMethodNotAllowed, "Method Not Supported"))
		s.log(r, procedure, status.Status(), started)
		return
	}
	if s.updateRequired(r) {
		if s.config.BuildID != "" {
			status.Header().Set("x-rakazo-build", s.config.BuildID)
		}
		orpc.WriteError(status, orpc.New("CLIENT_UPDATE_REQUIRED", 426, "Update required"))
		s.log(r, procedure, status.Status(), started)
		return
	}
	if s.config.BuildID != "" {
		status.Header().Set("x-rakazo-build", s.config.BuildID)
	}

	session, renewal, failure := s.auth.Authenticate(r.Context(), r)
	if failure != nil {
		orpc.WriteError(status, failure)
		s.log(r, procedure, status.Status(), started)
		return
	}
	actor, failure := s.auth.Actor(r.Context(), session, r.Header.Get("x-rakazo-space-id"))
	if failure != nil {
		orpc.WriteError(status, failure)
		s.log(r, procedure, status.Status(), started)
		return
	}
	if session.ViaCookie && renewal != nil {
		status.Header().Add("Set-Cookie", renewal.String())
	}

	handler, ok := s.procs[procedure]
	if !ok {
		orpc.WriteError(status, orpc.New("NOT_IMPLEMENTED", http.StatusNotImplemented, "Not Implemented"))
		s.log(r, procedure, status.Status(), started)
		return
	}
	input, failure := orpc.DecodeInput(r, s.maxBody)
	if failure != nil {
		if failure.Status == 413 {
			orpc.WriteError(status, orpc.TooLarge(fmt.Sprintf("Request body is too large. Upload limit: %s per file.", s.maxLabel)))
		} else {
			orpc.WriteError(status, failure)
		}
		s.log(r, procedure, status.Status(), started)
		return
	}
	// The caller a security event records: the resolved client address and user agent.
	caller := effects.Caller{
		IP:        s.clientIP.Resolve(effects.PeerIP(r.RemoteAddr), strings.Join(r.Header.Values(s.clientIPHeader), ", ")),
		UserAgent: r.Header.Get("User-Agent"),
	}
	ctx := effects.WithCaller(r.Context(), caller)
	if handler.Stream != nil {
		s.serveStream(status, r, procedure, handler.Stream, actor, input, ctx)
		s.log(r, procedure, status.Status(), started)
		return
	}
	output, failure := handler.Serve(ctx, actor, input)
	if failure != nil {
		orpc.WriteError(status, failure)
		s.log(r, procedure, status.Status(), started)
		return
	}
	// What `authed` does once a procedure has returned: its security event is
	// written before the reply, roster and Space signals go out in the background.
	s.effects.After(context.WithoutCancel(ctx), procedure, actor, input.Raw, output)
	orpc.WriteJSON(status, http.StatusOK, output)
	s.log(r, procedure, status.Status(), started)
}

// Snapshot runs the same pipeline into a recorder, for shadow comparison.
func (s *Server) Snapshot(ctx context.Context, r *http.Request, procedure string) Snapshot {
	recorder := httptest.NewRecorder()
	clone := r.Clone(ctx)
	s.ServeHTTP(recorder, clone, procedure)
	result := recorder.Result()
	defer result.Body.Close()
	body, _ := io.ReadAll(result.Body)
	return Snapshot{Status: result.StatusCode, Header: result.Header, Body: body}
}

// Snapshot is one captured response.
type Snapshot struct {
	Status int
	Header http.Header
	Body   []byte
}

func (s *Server) cors(w http.ResponseWriter, r *http.Request) {
	origin := r.Header.Get("Origin")
	w.Header().Add("Vary", "Origin")
	w.Header().Set("Access-Control-Allow-Credentials", "true")
	w.Header().Set("Access-Control-Expose-Headers", "x-rakazo-build,x-voice-id")
	if origin == "" {
		w.Header().Set("Access-Control-Allow-Origin", s.config.WebOrigin)
	} else if s.trustedOrigin(origin) {
		w.Header().Set("Access-Control-Allow-Origin", origin)
	}
	if r.Method == http.MethodOptions {
		w.Header().Set("Access-Control-Allow-Methods", "GET,HEAD,PUT,POST,DELETE,PATCH,QUERY")
	}
}

func (s *Server) trustedOrigin(origin string) bool {
	if strings.HasPrefix(origin, "rakazo://") {
		return true
	}
	for _, candidate := range s.config.TrustedOrigins {
		if candidate == "" {
			continue
		}
		if origin == candidate {
			return true
		}
		if twin := loopbackTwin(candidate); twin != "" && origin == twin {
			return true
		}
	}
	return false
}

// loopbackTwin mirrors buildTrustedOrigins: localhost and 127.0.0.1 are the
// same host for a browser, so both spellings are trusted.
func loopbackTwin(origin string) string {
	switch {
	case strings.Contains(origin, "://localhost"):
		return strings.Replace(origin, "://localhost", "://127.0.0.1", 1)
	case strings.Contains(origin, "://127.0.0.1"):
		return strings.Replace(origin, "://127.0.0.1", "://localhost", 1)
	}
	return ""
}

func (s *Server) updateRequired(r *http.Request) bool {
	kind, build, ok := parseClientBuild(r.Header.Get("x-rakazo-client-build"))
	if !ok {
		return false
	}
	minimum, ok := s.config.Minimums[kind]
	if !ok {
		return false
	}
	return build < minimum
}

var requestIDPattern = regexp.MustCompile(`^[\w.:-]{1,128}$`)
var traceparentPattern = regexp.MustCompile(`^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$`)

func (s *Server) correlation(w http.ResponseWriter, r *http.Request) {
	requestID := r.Header.Get("x-request-id")
	if !requestIDPattern.MatchString(requestID) {
		requestID = newUUID()
	}
	traceID := randomHex(16)
	parentSpan := ""
	if match := traceparentPattern.FindStringSubmatch(strings.TrimSpace(r.Header.Get("traceparent"))); match != nil {
		if !isZero(match[1]) && !isZero(match[2]) {
			traceID = match[1]
			parentSpan = match[2]
		}
	}
	spanID := randomHex(8)
	w.Header().Set("x-request-id", requestID)
	w.Header().Set("traceparent", "00-"+traceID+"-"+spanID+"-01")
	_ = parentSpan
}

func isZero(value string) bool {
	return strings.Trim(value, "0") == ""
}

func newUUID() string {
	bytes := make([]byte, 16)
	_, _ = rand.Read(bytes)
	bytes[6] = (bytes[6] & 0x0f) | 0x40
	bytes[8] = (bytes[8] & 0x3f) | 0x80
	encoded := hex.EncodeToString(bytes)
	return encoded[0:8] + "-" + encoded[8:12] + "-" + encoded[12:16] + "-" + encoded[16:20] + "-" + encoded[20:32]
}

func randomHex(bytes int) string {
	buffer := make([]byte, bytes)
	_, _ = rand.Read(buffer)
	return hex.EncodeToString(buffer)
}

var buildPattern = regexp.MustCompile(`^(web|mobile)/(\d{14})$`)

func parseClientBuild(header string) (kind, build string, ok bool) {
	match := buildPattern.FindStringSubmatch(strings.TrimSpace(header))
	if match == nil {
		return "", "", false
	}
	return match[1], match[2], true
}

// ParseMinimums parses RAKAZO_MIN_CLIENT_BUILD (`web=...,mobile=...`).
func ParseMinimums(raw string) (map[string]string, error) {
	minimums := map[string]string{}
	for _, entry := range strings.Split(raw, ",") {
		entry = strings.TrimSpace(entry)
		if entry == "" {
			continue
		}
		kind, build, ok := strings.Cut(entry, "=")
		if !ok || (kind != "web" && kind != "mobile") || len(build) != 14 || !digits(build) {
			return nil, fmt.Errorf("invalid RAKAZO_MIN_CLIENT_BUILD entry %q: use web=YYYYMMDDHHMMSS or mobile=YYYYMMDDHHMMSS", entry)
		}
		minimums[kind] = build
	}
	return minimums, nil
}

func digits(value string) bool {
	for _, char := range value {
		if char < '0' || char > '9' {
			return false
		}
	}
	return true
}

func (s *Server) log(r *http.Request, procedure string, status int, started time.Time) {
	s.config.Logger.Info("http.request.completed",
		"http.method", r.Method,
		"http.path", r.URL.Path,
		"http.status", status,
		"http.duration_ms", time.Since(started).Milliseconds(),
		"procedure", procedure,
		"served_by", "go",
	)
}

// Compare reports whether two responses are wire-equivalent. Volatile headers
// (request id, traceparent, date, set-cookie) are ignored; the JSON body is
// compared structurally.
func Compare(ts, goResp Snapshot) (bool, string) {
	if ts.Status != goResp.Status {
		return false, fmt.Sprintf("status %d != %d", ts.Status, goResp.Status)
	}
	for _, name := range []string{"Content-Type", "Cache-Control", "X-Rakazo-Build", "Access-Control-Allow-Origin", "Access-Control-Allow-Credentials", "Access-Control-Expose-Headers", "Vary"} {
		if ts.Header.Get(name) != goResp.Header.Get(name) {
			return false, fmt.Sprintf("header %s differs", name)
		}
	}
	var left, right any
	if err := json.Unmarshal(ts.Body, &left); err != nil {
		return false, "typescript body is not JSON"
	}
	if err := json.Unmarshal(goResp.Body, &right); err != nil {
		return false, "go body is not JSON"
	}
	if path := firstDifference(left, right, "json"); path != "" {
		return false, "body differs at " + path
	}
	return true, ""
}

func firstDifference(left, right any, path string) string {
	switch leftValue := left.(type) {
	case map[string]any:
		rightValue, ok := right.(map[string]any)
		if !ok {
			return path
		}
		if len(leftValue) != len(rightValue) {
			return path + " (key count)"
		}
		for key, value := range leftValue {
			other, ok := rightValue[key]
			if !ok {
				return path + "." + key + " (missing)"
			}
			if difference := firstDifference(value, other, path+"."+key); difference != "" {
				return difference
			}
		}
		return ""
	case []any:
		rightValue, ok := right.([]any)
		if !ok {
			return path
		}
		if len(leftValue) != len(rightValue) {
			return path + " (length)"
		}
		for index := range leftValue {
			if difference := firstDifference(leftValue[index], rightValue[index], path+"["+strconv.Itoa(index)+"]"); difference != "" {
				return difference
			}
		}
		return ""
	default:
		if left != right {
			return path
		}
		return ""
	}
}

// statusWriter keeps the streaming capabilities while recording the status.
type statusWriter struct {
	http.ResponseWriter
	status int
}

func (w *statusWriter) WriteHeader(status int) {
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
	if flusher, ok := w.ResponseWriter.(http.Flusher); ok {
		flusher.Flush()
	}
}

func (w *statusWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }

func (w *statusWriter) Status() int {
	if w.status == 0 {
		return http.StatusOK
	}
	return w.status
}
