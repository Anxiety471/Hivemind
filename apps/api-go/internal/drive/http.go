package drive

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"mime"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/auth"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/effects"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/filepolicy"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/filestore"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/orpc"
)

type driveBackend interface {
	UploadStream(ctx context.Context, actor db.Actor, params UploadParams, src io.Reader) (DriveFile, *orpc.Error)
	StatContent(ctx context.Context, actor db.Actor, fileID string) (ContentMeta, *orpc.Error)
	OpenContent(ctx context.Context, actor db.Actor, fileID string, byteRange *filestore.ByteRange) (ContentMeta, io.ReadCloser, int64, *orpc.Error)
	MaxFileBytes() int64
}

type sessionAuthenticator interface {
	Authenticate(ctx context.Context, r *http.Request) (*auth.Session, *http.Cookie, *orpc.Error)
	Actor(ctx context.Context, session *auth.Session, requestedSpace string) (db.Actor, *orpc.Error)
}

// HTTPConfig configures the /api/v1/files HTTP handler.
type HTTPConfig struct {
	WebOrigin      string
	TrustedOrigins []string
	ClientIP       *effects.ClientIPResolver
	ClientIPHeader string
	Logger         *slog.Logger
}

// HTTPHandler serves /api/v1/files streaming uploads and /api/v1/files/:id/content Range playback.
type HTTPHandler struct {
	drive  driveBackend
	auth   sessionAuthenticator
	config HTTPConfig
}

// NewHTTPHandler constructs an HTTPHandler over Service and auth.Service.
func NewHTTPHandler(svc *Service, sessions *auth.Service, cfg HTTPConfig) *HTTPHandler {
	return newHTTPHandler(svc, sessions, cfg)
}

func newHTTPHandler(svc driveBackend, sessions sessionAuthenticator, cfg HTTPConfig) *HTTPHandler {
	if cfg.Logger == nil {
		cfg.Logger = slog.Default()
	}
	return &HTTPHandler{drive: svc, auth: sessions, config: cfg}
}

// ServeHTTP dispatches /api/v1/files and /api/v1/files/:id/content requests.
func (h *HTTPHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	reqID := correlationID(r.Header.Get("x-request-id"))
	w.Header().Set("X-Request-Id", reqID)
	h.applyCORS(w, r)

	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	if h.drive == nil || h.auth == nil {
		orpc.WriteError(w, orpc.Unavailable())
		return
	}

	ctx := effects.WithCaller(r.Context(), effects.Caller{
		IP:        h.clientIP(r),
		UserAgent: r.UserAgent(),
	})

	session, refreshCookie, failure := h.auth.Authenticate(ctx, r)
	if failure != nil {
		orpc.WriteError(w, failure)
		return
	}
	if refreshCookie != nil {
		http.SetCookie(w, refreshCookie)
	}

	requestedSpace := strings.TrimSpace(r.Header.Get("x-rakazo-space-id"))
	if requestedSpace == "" {
		requestedSpace = strings.TrimSpace(r.URL.Query().Get("spaceId"))
	}
	actor, failure := h.auth.Actor(ctx, session, requestedSpace)
	if failure != nil {
		orpc.WriteError(w, failure)
		return
	}

	switch {
	case r.URL.Path == "/api/v1/files":
		if r.Method != http.MethodPost {
			w.Header().Set("Allow", "POST, OPTIONS")
			orpc.WriteError(w, orpc.New("METHOD_NOT_ALLOWED", http.StatusMethodNotAllowed, "Method not allowed"))
			return
		}
		h.handleUpload(ctx, w, r, actor)
	case strings.HasPrefix(r.URL.Path, "/api/v1/files/"):
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.Header().Set("Allow", "GET, HEAD, OPTIONS")
			orpc.WriteError(w, orpc.New("METHOD_NOT_ALLOWED", http.StatusMethodNotAllowed, "Method not allowed"))
			return
		}
		fileID, ok := extractContentFileID(r.URL.Path)
		if !ok {
			orpc.WriteError(w, orpc.NotFound("Not found"))
			return
		}
		h.handleContent(ctx, w, r, actor, fileID)
	default:
		orpc.WriteError(w, orpc.NotFound("Not found"))
	}
}

func extractContentFileID(rawPath string) (string, bool) {
	rest, ok := strings.CutPrefix(rawPath, "/api/v1/files/")
	if !ok {
		return "", false
	}
	rawID, ok := strings.CutSuffix(rest, "/content")
	if !ok || rawID == "" || strings.Contains(rawID, "/") {
		return "", false
	}
	decoded, err := url.PathUnescape(rawID)
	if err != nil || decoded == "" || strings.ContainsAny(decoded, `/\`) {
		return "", false
	}
	return decoded, true
}

func (h *HTTPHandler) handleUpload(ctx context.Context, w http.ResponseWriter, r *http.Request, actor db.Actor) {
	w.Header().Set("Cache-Control", "no-store")
	params := UploadParams{
		FolderID:    optQueryOrHeader(r, "folderId", "X-File-Folder-Id"),
		BotID:       optQueryOrHeader(r, "botId", "X-File-Bot-Id"),
		GroupID:     optQueryOrHeader(r, "groupId", "X-File-Group-Id"),
		RunID:       optQueryOrHeader(r, "runId", "X-File-Run-Id"),
		Source:      firstNonEmpty(r.URL.Query().Get("source"), r.Header.Get("X-File-Source"), "upload"),
		Name:        firstNonEmpty(r.Header.Get("X-File-Name"), r.URL.Query().Get("name")),
		Description: optQueryOrHeader(r, "description", "X-File-Description"),
		MimeType:    firstNonEmpty(r.Header.Get("X-File-Mime-Type"), r.URL.Query().Get("mimeType")),
		ClientNonce: optQueryOrHeader(r, "clientNonce", "X-File-Nonce"),
	}

	mediaType, _, _ := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if strings.HasPrefix(mediaType, "multipart/") {
		mr, err := r.MultipartReader()
		if err != nil {
			orpc.WriteError(w, orpc.BadRequest("Invalid multipart upload payload"))
			return
		}
		var fileFound bool
		var result DriveFile
		for {
			part, err := mr.NextPart()
			if errors.Is(err, io.EOF) {
				break
			}
			if err != nil {
				orpc.WriteError(w, orpc.BadRequest("Invalid multipart stream"))
				return
			}
			field := part.FormName()
			if field == "file" {
				fileFound = true
				if params.Name == "" && part.FileName() != "" {
					params.Name = part.FileName()
				}
				if params.MimeType == "" {
					params.MimeType = part.Header.Get("Content-Type")
				}
				uploaded, failure := h.drive.UploadStream(ctx, actor, params, part)
				_ = part.Close()
				if failure != nil {
					orpc.WriteError(w, failure)
					return
				}
				result = uploaded
				break
			}
			valBytes, readErr := io.ReadAll(io.LimitReader(part, 8*1024))
			_ = part.Close()
			if readErr != nil {
				orpc.WriteError(w, orpc.BadRequest("Invalid form field"))
				return
			}
			val := strings.TrimSpace(string(valBytes))
			switch field {
			case "folderId":
				params.FolderID = strPtrIfNonEmpty(val)
			case "botId":
				params.BotID = strPtrIfNonEmpty(val)
			case "groupId":
				params.GroupID = strPtrIfNonEmpty(val)
			case "runId":
				params.RunID = strPtrIfNonEmpty(val)
			case "source":
				if val != "" {
					params.Source = val
				}
			case "name":
				if val != "" {
					params.Name = val
				}
			case "description":
				params.Description = strPtrIfNonEmpty(val)
			case "mimeType":
				if val != "" {
					params.MimeType = val
				}
			case "clientNonce":
				params.ClientNonce = strPtrIfNonEmpty(val)
			}
		}
		if !fileFound {
			orpc.WriteError(w, orpc.BadRequest("Missing file form part"))
			return
		}
		writePlainJSON(w, http.StatusCreated, result)
		return
	}

	if params.MimeType == "" && mediaType != "" {
		params.MimeType = mediaType
	}
	if params.Name == "" {
		params.Name = "upload"
	}
	uploaded, failure := h.drive.UploadStream(ctx, actor, params, r.Body)
	if failure != nil {
		orpc.WriteError(w, failure)
		return
	}
	writePlainJSON(w, http.StatusCreated, uploaded)
}

func writePlainJSON(w http.ResponseWriter, status int, value any) {
	body, err := orpc.Marshal(value)
	if err != nil {
		orpc.WriteError(w, orpc.Internal())
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write(body)
}

func (h *HTTPHandler) handleContent(ctx context.Context, w http.ResponseWriter, r *http.Request, actor db.Actor, fileID string) {
	meta, failure := h.drive.StatContent(ctx, actor, fileID)
	if failure != nil {
		orpc.WriteError(w, failure)
		return
	}

	etag := `"` + meta.Hash + `"`
	if meta.Hash != "" {
		w.Header().Set("ETag", etag)
	}
	w.Header().Set("Accept-Ranges", "bytes")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cache-Control", "private, max-age=3600, stale-while-revalidate=86400")

	if meta.Hash != "" && matchesIfNoneMatch(r.Header.Get("If-None-Match"), etag) {
		w.WriteHeader(http.StatusNotModified)
		return
	}

	download := r.URL.Query().Get("download") == "1"
	inline := !download && filepolicy.IsSafeInlineMedia(meta.MimeType)
	w.Header().Set("Content-Type", meta.MimeType)
	w.Header().Set("Content-Disposition", filepolicy.FormatContentDisposition(inline, meta.Name))

	rangeHdr := strings.TrimSpace(r.Header.Get("Range"))
	byteRange, unsatisfiable := parseSingleByteRange(rangeHdr, meta.Size)
	if unsatisfiable {
		w.Header().Set("Content-Range", fmt.Sprintf("bytes */%d", meta.Size))
		w.WriteHeader(http.StatusRequestedRangeNotSatisfiable)
		return
	}

	if r.Method == http.MethodHead {
		if byteRange != nil {
			length := byteRange.EndInclusive - byteRange.Start + 1
			w.Header().Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", byteRange.Start, byteRange.EndInclusive, meta.Size))
			w.Header().Set("Content-Length", strconv.FormatInt(length, 10))
			w.WriteHeader(http.StatusPartialContent)
			return
		}
		w.Header().Set("Content-Length", strconv.FormatInt(meta.Size, 10))
		w.WriteHeader(http.StatusOK)
		return
	}

	_, rc, totalSize, failure := h.drive.OpenContent(ctx, actor, fileID, byteRange)
	if failure != nil {
		if failure.Status == http.StatusRequestedRangeNotSatisfiable {
			w.Header().Set("Content-Range", fmt.Sprintf("bytes */%d", totalSize))
			w.WriteHeader(http.StatusRequestedRangeNotSatisfiable)
			return
		}
		orpc.WriteError(w, failure)
		return
	}
	defer func() { _ = rc.Close() }()

	if byteRange != nil {
		length := byteRange.EndInclusive - byteRange.Start + 1
		w.Header().Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", byteRange.Start, byteRange.EndInclusive, totalSize))
		w.Header().Set("Content-Length", strconv.FormatInt(length, 10))
		w.WriteHeader(http.StatusPartialContent)
	} else {
		w.Header().Set("Content-Length", strconv.FormatInt(totalSize, 10))
		w.WriteHeader(http.StatusOK)
	}
	_, _ = io.Copy(w, rc)
}

// parseSingleByteRange parses an RFC 9110 single-range `bytes=` header.
// Multi-range requests are treated as full-body reads (nil, false).
func parseSingleByteRange(header string, size int64) (*filestore.ByteRange, bool) {
	if header == "" {
		return nil, false
	}
	if !strings.HasPrefix(strings.ToLower(header), "bytes=") {
		return nil, false
	}
	spec := strings.TrimSpace(header[6:])
	if spec == "" || strings.Contains(spec, ",") {
		return nil, false
	}
	dash := strings.IndexByte(spec, '-')
	if dash < 0 {
		return nil, true
	}
	startStr := strings.TrimSpace(spec[:dash])
	endStr := strings.TrimSpace(spec[dash+1:])
	if startStr == "" && endStr == "" {
		return nil, true
	}
	if size <= 0 {
		return nil, true
	}
	if startStr == "" {
		// Suffix byte range: `-N`.
		suffix, err := strconv.ParseInt(endStr, 10, 64)
		if err != nil || suffix <= 0 {
			return nil, true
		}
		if suffix >= size {
			return &filestore.ByteRange{Start: 0, EndInclusive: size - 1}, false
		}
		return &filestore.ByteRange{Start: size - suffix, EndInclusive: size - 1}, false
	}
	start, err := strconv.ParseInt(startStr, 10, 64)
	if err != nil || start < 0 || start >= size {
		return nil, true
	}
	if endStr == "" {
		return &filestore.ByteRange{Start: start, EndInclusive: size - 1}, false
	}
	end, err := strconv.ParseInt(endStr, 10, 64)
	if err != nil || end < start {
		return nil, true
	}
	if end >= size {
		end = size - 1
	}
	return &filestore.ByteRange{Start: start, EndInclusive: end}, false
}

func matchesIfNoneMatch(header, etag string) bool {
	if header == "" {
		return false
	}
	if strings.TrimSpace(header) == "*" {
		return true
	}
	for _, candidate := range strings.Split(header, ",") {
		c := strings.TrimSpace(candidate)
		c = strings.TrimPrefix(c, "W/")
		if c == etag {
			return true
		}
	}
	return false
}

func (h *HTTPHandler) applyCORS(w http.ResponseWriter, r *http.Request) {
	origin := r.Header.Get("Origin")
	w.Header().Add("Vary", "Origin")
	w.Header().Add("Vary", "Cookie")
	w.Header().Add("Vary", "Authorization")
	switch {
	case origin != "" && h.trustedOrigin(origin):
		w.Header().Set("Access-Control-Allow-Origin", origin)
	case h.config.WebOrigin != "":
		w.Header().Set("Access-Control-Allow-Origin", h.config.WebOrigin)
	}
	w.Header().Set("Access-Control-Allow-Credentials", "true")
	w.Header().Set("Access-Control-Allow-Methods", "GET, HEAD, POST, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Rakazo-Space-Id, Range, X-File-Name, X-File-Folder-Id, X-File-Bot-Id, X-File-Group-Id, X-File-Source, X-File-Description, X-File-Mime-Type, X-File-Nonce")
	w.Header().Set("Access-Control-Expose-Headers", "Content-Range, Accept-Ranges, Content-Length, ETag, Content-Disposition")
}

func (h *HTTPHandler) trustedOrigin(origin string) bool {
	if origin == h.config.WebOrigin {
		return true
	}
	for _, candidate := range h.config.TrustedOrigins {
		if origin == candidate {
			return true
		}
	}
	return loopbackTwin(origin, h.config.WebOrigin)
}

func loopbackTwin(origin, webOrigin string) bool {
	u, err1 := url.Parse(origin)
	w, err2 := url.Parse(webOrigin)
	if err1 != nil || err2 != nil || u.Scheme != w.Scheme || u.Port() != w.Port() {
		return false
	}
	return isLoopbackHost(u.Hostname()) && isLoopbackHost(w.Hostname())
}

func isLoopbackHost(host string) bool {
	return host == "localhost" || host == "127.0.0.1"
}

func (h *HTTPHandler) clientIP(r *http.Request) string {
	peer := effects.PeerIP(r.RemoteAddr)
	if h.config.ClientIP != nil {
		header := strings.TrimSpace(h.config.ClientIPHeader)
		if header == "" {
			header = "x-forwarded-for"
		}
		return h.config.ClientIP.Resolve(peer, r.Header.Get(header))
	}
	return peer
}

func correlationID(header string) string {
	trimmed := strings.TrimSpace(header)
	if trimmed != "" && len(trimmed) <= 128 {
		return trimmed
	}
	return effects.NewUUID()
}

func optQueryOrHeader(r *http.Request, queryKey, headerKey string) *string {
	if v := strings.TrimSpace(r.Header.Get(headerKey)); v != "" {
		return &v
	}
	if v := strings.TrimSpace(r.URL.Query().Get(queryKey)); v != "" {
		return &v
	}
	return nil
}

func strPtrIfNonEmpty(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if trimmed := strings.TrimSpace(v); trimmed != "" {
			return trimmed
		}
	}
	return ""
}
