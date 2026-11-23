// Package objectserver is a small S3-compatible object server backed by a
// local directory. It implements exactly the operations the deployment's own
// clients use (filestore.S3Backend and the TypeScript S3 adapter): path-style
// PutObject, GetObject with ranges, HeadObject, DeleteObject(s), multipart
// upload and ListObjectsV2, authenticated with one SigV4 access key.
package objectserver

import (
	"crypto/md5"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"hash"
	"io"
	"io/fs"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

const (
	maxKeyBytes     = 1024
	maxListKeys     = 1000
	maxDeleteKeys   = 1000
	maxXMLBodyBytes = 4 << 20
)

// Config configures a Server.
type Config struct {
	// Dir holds every object, upload and temp file; it must be on one filesystem.
	Dir             string
	Bucket          string
	Region          string
	AccessKeyID     string
	SecretAccessKey string
	Logger          *slog.Logger
	Now             func() time.Time
}

// Server serves one bucket.
type Server struct {
	cfg Config
	log *slog.Logger
	now func() time.Time
}

// New validates cfg, creates the storage directories and returns a Server.
func New(cfg Config) (*Server, error) {
	if cfg.Dir == "" || cfg.Bucket == "" || cfg.AccessKeyID == "" || cfg.SecretAccessKey == "" {
		return nil, errors.New("object server needs a directory, bucket and credentials")
	}
	if cfg.Region == "" {
		cfg.Region = "us-east-1"
	}
	if cfg.Logger == nil {
		cfg.Logger = slog.Default()
	}
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	for _, sub := range []string{"objects", "uploads", "tmp"} {
		if err := os.MkdirAll(filepath.Join(cfg.Dir, sub), 0o700); err != nil {
			return nil, err
		}
	}
	s := &Server{cfg: cfg, log: cfg.Logger, now: cfg.Now}
	s.sweepTemp()
	return s, nil
}

// sweepTemp drops partial writes left by a crash. Objects only become visible
// by an atomic rename out of tmp, so nothing here was ever readable.
func (s *Server) sweepTemp() {
	entries, err := os.ReadDir(filepath.Join(s.cfg.Dir, "tmp"))
	if err != nil {
		return
	}
	for _, e := range entries {
		_ = os.RemoveAll(filepath.Join(s.cfg.Dir, "tmp", e.Name()))
	}
}

type objectMeta struct {
	Key      string    `json:"key"`
	Size     int64     `json:"size"`
	ETag     string    `json:"etag"`
	Modified time.Time `json:"modified"`
}

func (s *Server) objectPaths(key string) (data, meta string) {
	sum := sha256.Sum256([]byte(key))
	name := hex.EncodeToString(sum[:])
	dir := filepath.Join(s.cfg.Dir, "objects", name[:2])
	return filepath.Join(dir, name), filepath.Join(dir, name+".json")
}

func (s *Server) readMeta(key string) (objectMeta, string, error) {
	data, metaPath := s.objectPaths(key)
	raw, err := os.ReadFile(metaPath)
	if err != nil {
		return objectMeta{}, "", err
	}
	var meta objectMeta
	if err := json.Unmarshal(raw, &meta); err != nil {
		return objectMeta{}, "", err
	}
	return meta, data, nil
}

// commit publishes a finished temp file as key. The object exists once its
// metadata file does, so data moves first and metadata last.
func (s *Server) commit(key, tmpData string, size int64, etag string) error {
	dataPath, metaPath := s.objectPaths(key)
	if err := os.MkdirAll(filepath.Dir(dataPath), 0o700); err != nil {
		return err
	}
	raw, err := json.Marshal(objectMeta{Key: key, Size: size, ETag: etag, Modified: s.now().UTC()})
	if err != nil {
		return err
	}
	tmpMeta, err := s.tempFile()
	if err != nil {
		return err
	}
	defer func() { _ = os.Remove(tmpMeta.Name()) }()
	if _, err := tmpMeta.Write(raw); err != nil {
		_ = tmpMeta.Close()
		return err
	}
	if err := tmpMeta.Sync(); err != nil {
		_ = tmpMeta.Close()
		return err
	}
	if err := tmpMeta.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmpData, dataPath); err != nil {
		return err
	}
	if err := os.Rename(tmpMeta.Name(), metaPath); err != nil {
		return err
	}
	return syncDir(filepath.Dir(dataPath))
}

func syncDir(dir string) error {
	d, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer func() { _ = d.Close() }()
	return d.Sync()
}

func (s *Server) tempFile() (*os.File, error) {
	return os.CreateTemp(filepath.Join(s.cfg.Dir, "tmp"), "w-*")
}

// ServeHTTP authenticates and routes one request.
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if err := s.authenticate(r); err != nil {
		var ae *apiError
		if !errors.As(err, &ae) {
			ae = errAccessDenied
		}
		writeError(w, r, ae)
		return
	}
	bucket, key, ok := splitPath(r.URL.EscapedPath())
	if !ok || bucket != s.cfg.Bucket {
		writeError(w, r, errNoSuchBucket)
		return
	}
	q := r.URL.Query()
	if key == "" {
		s.serveBucket(w, r, q)
		return
	}
	if len(key) > maxKeyBytes {
		writeError(w, r, errKeyTooLong)
		return
	}
	switch r.Method {
	case http.MethodPut:
		if q.Has("partNumber") || q.Has("uploadId") {
			s.uploadPart(w, r, key, q)
			return
		}
		s.putObject(w, r, key)
	case http.MethodPost:
		switch {
		case q.Has("uploads"):
			s.createUpload(w, r, key)
		case q.Has("uploadId"):
			s.completeUpload(w, r, key, q.Get("uploadId"))
		default:
			writeError(w, r, errNotImplemented)
		}
	case http.MethodGet, http.MethodHead:
		s.getObject(w, r, key)
	case http.MethodDelete:
		if q.Has("uploadId") {
			s.abortUpload(w, r, key, q.Get("uploadId"))
			return
		}
		s.deleteObject(w, r, key)
	default:
		writeError(w, r, errMethodNotAllowed)
	}
}

// splitPath turns "/bucket/some/key" into its bucket and decoded key.
func splitPath(escaped string) (bucket, key string, ok bool) {
	trimmed := strings.TrimPrefix(escaped, "/")
	bucketEsc, keyEsc, _ := strings.Cut(trimmed, "/")
	bucket, err := url.PathUnescape(bucketEsc)
	if err != nil || bucket == "" {
		return "", "", false
	}
	key, err = url.PathUnescape(keyEsc)
	if err != nil {
		return "", "", false
	}
	return bucket, key, true
}

func (s *Server) serveBucket(w http.ResponseWriter, r *http.Request, q map[string][]string) {
	switch {
	case r.Method == http.MethodHead:
		w.WriteHeader(http.StatusOK)
	case r.Method == http.MethodGet && first(q, "list-type") == "2":
		s.listObjects(w, r, q)
	case r.Method == http.MethodPost && q["delete"] != nil:
		s.serveDeleteObjects(w, r)
	default:
		writeError(w, r, errNotImplemented)
	}
}

func first(q map[string][]string, name string) string {
	if v := q[name]; len(v) > 0 {
		return v[0]
	}
	return ""
}

// bodyReader returns the request body, verified against the signed payload
// hash when the client signed one.
type bodyReader struct {
	src     io.Reader
	md5     hash.Hash
	sha     hash.Hash
	wantSHA string
	size    int64
}

func newBody(r *http.Request) *bodyReader {
	b := &bodyReader{md5: md5.New(), src: r.Body}
	declared := r.Header.Get("X-Amz-Content-Sha256")
	if len(declared) == 64 {
		b.sha = sha256.New()
		b.wantSHA = strings.ToLower(declared)
	}
	return b
}

func (b *bodyReader) Read(p []byte) (int, error) {
	n, err := b.src.Read(p)
	if n > 0 {
		b.size += int64(n)
		b.md5.Write(p[:n])
		if b.sha != nil {
			b.sha.Write(p[:n])
		}
	}
	return n, err
}

func (b *bodyReader) verify() error {
	if b.sha != nil && hex.EncodeToString(b.sha.Sum(nil)) != b.wantSHA {
		return errContentSHA
	}
	return nil
}

func (b *bodyReader) etag() string { return hex.EncodeToString(b.md5.Sum(nil)) }

// spool copies the request body into a temp file, returning it closed.
func (s *Server) spool(r *http.Request) (path string, body *bodyReader, err error) {
	if err := rejectStreamingPayload(r); err != nil {
		return "", nil, err
	}
	f, err := s.tempFile()
	if err != nil {
		return "", nil, err
	}
	body = newBody(r)
	_, copyErr := io.Copy(f, body)
	if copyErr == nil {
		copyErr = f.Sync()
	}
	if closeErr := f.Close(); copyErr == nil {
		copyErr = closeErr
	}
	if copyErr == nil {
		copyErr = body.verify()
	}
	if copyErr != nil {
		_ = os.Remove(f.Name())
		return "", nil, copyErr
	}
	return f.Name(), body, nil
}

func rejectStreamingPayload(r *http.Request) error {
	if strings.HasPrefix(r.Header.Get("X-Amz-Content-Sha256"), "STREAMING-") {
		return errNotImplemented
	}
	return nil
}

func (s *Server) putObject(w http.ResponseWriter, r *http.Request, key string) {
	tmp, body, err := s.spool(r)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	etag := body.etag()
	if err := s.commit(key, tmp, body.size, etag); err != nil {
		_ = os.Remove(tmp)
		s.fail(w, r, err)
		return
	}
	w.Header().Set("ETag", `"`+etag+`"`)
	w.WriteHeader(http.StatusOK)
}

func (s *Server) getObject(w http.ResponseWriter, r *http.Request, key string) {
	meta, dataPath, err := s.readMeta(key)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			writeError(w, r, errNoSuchKey)
			return
		}
		s.fail(w, r, err)
		return
	}
	f, err := os.Open(dataPath)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	defer func() { _ = f.Close() }()
	w.Header().Set("ETag", `"`+meta.ETag+`"`)
	w.Header().Set("Content-Type", "application/octet-stream")
	http.ServeContent(w, r, "", meta.Modified, f)
}

func (s *Server) deleteObject(w http.ResponseWriter, r *http.Request, key string) {
	if err := s.remove(key); err != nil {
		s.fail(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// remove deletes metadata first so a crash never leaves a listed object
// without data.
func (s *Server) remove(key string) error {
	dataPath, metaPath := s.objectPaths(key)
	if err := os.Remove(metaPath); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	if err := os.Remove(dataPath); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	return nil
}

type deleteRequest struct {
	Quiet   bool `xml:"Quiet"`
	Objects []struct {
		Key string `xml:"Key"`
	} `xml:"Object"`
}

type deleteResult struct {
	XMLName xml.Name `xml:"DeleteResult"`
	Deleted []struct {
		Key string `xml:"Key"`
	} `xml:"Deleted"`
}

// serveDeleteObjects handles POST /bucket?delete.
func (s *Server) serveDeleteObjects(w http.ResponseWriter, r *http.Request) {
	var req deleteRequest
	if err := decodeXML(r, &req); err != nil {
		s.fail(w, r, err)
		return
	}
	if len(req.Objects) > maxDeleteKeys {
		writeError(w, r, errMalformedXML)
		return
	}
	var res deleteResult
	for _, o := range req.Objects {
		if err := s.remove(o.Key); err != nil {
			s.fail(w, r, err)
			return
		}
		if !req.Quiet {
			res.Deleted = append(res.Deleted, struct {
				Key string `xml:"Key"`
			}{o.Key})
		}
	}
	writeXML(w, http.StatusOK, res)
}

func decodeXML(r *http.Request, into any) error {
	if err := rejectStreamingPayload(r); err != nil {
		return err
	}
	body := newBody(r)
	raw, err := io.ReadAll(io.LimitReader(body, maxXMLBodyBytes+1))
	if err != nil {
		return err
	}
	if len(raw) > maxXMLBodyBytes {
		return errMalformedXML
	}
	if err := body.verify(); err != nil {
		return err
	}
	if err := xml.Unmarshal(raw, into); err != nil {
		return errMalformedXML
	}
	return nil
}

type listResult struct {
	XMLName               xml.Name     `xml:"ListBucketResult"`
	Name                  string       `xml:"Name"`
	Prefix                string       `xml:"Prefix"`
	KeyCount              int          `xml:"KeyCount"`
	MaxKeys               int          `xml:"MaxKeys"`
	IsTruncated           bool         `xml:"IsTruncated"`
	NextContinuationToken string       `xml:"NextContinuationToken,omitempty"`
	Contents              []listObject `xml:"Contents"`
}

type listObject struct {
	Key          string `xml:"Key"`
	LastModified string `xml:"LastModified"`
	ETag         string `xml:"ETag"`
	Size         int64  `xml:"Size"`
	StorageClass string `xml:"StorageClass"`
}

func (s *Server) listObjects(w http.ResponseWriter, r *http.Request, q map[string][]string) {
	prefix := first(q, "prefix")
	maxKeys := maxListKeys
	if raw := first(q, "max-keys"); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n < 0 {
			writeError(w, r, errInvalidArgument)
			return
		}
		maxKeys = min(n, maxListKeys)
	}
	after := first(q, "start-after")
	if token := first(q, "continuation-token"); token != "" {
		raw, err := base64.RawURLEncoding.DecodeString(token)
		if err != nil {
			writeError(w, r, errInvalidArgument)
			return
		}
		after = string(raw)
	}
	var metas []objectMeta
	err := filepath.WalkDir(filepath.Join(s.cfg.Dir, "objects"), func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || !strings.HasSuffix(path, ".json") {
			return err
		}
		raw, err := os.ReadFile(path)
		if err != nil {
			if errors.Is(err, fs.ErrNotExist) {
				return nil
			}
			return err
		}
		var m objectMeta
		if err := json.Unmarshal(raw, &m); err != nil {
			return err
		}
		if strings.HasPrefix(m.Key, prefix) && m.Key > after {
			metas = append(metas, m)
		}
		return nil
	})
	if err != nil {
		s.fail(w, r, err)
		return
	}
	sort.Slice(metas, func(i, j int) bool { return metas[i].Key < metas[j].Key })
	res := listResult{Name: s.cfg.Bucket, Prefix: prefix, MaxKeys: maxKeys}
	if len(metas) > maxKeys {
		metas = metas[:maxKeys]
		res.IsTruncated = true
		res.NextContinuationToken = base64.RawURLEncoding.EncodeToString([]byte(metas[len(metas)-1].Key))
	}
	for _, m := range metas {
		res.Contents = append(res.Contents, listObject{
			Key:          m.Key,
			LastModified: m.Modified.UTC().Format("2006-01-02T15:04:05.000Z"),
			ETag:         `"` + m.ETag + `"`,
			Size:         m.Size,
			StorageClass: "STANDARD",
		})
	}
	res.KeyCount = len(res.Contents)
	writeXML(w, http.StatusOK, res)
}

// ---- multipart ----

type uploadMeta struct {
	Key string `json:"key"`
}

var uploadIDPattern = regexp.MustCompile(`^[0-9a-f]{32}$`)

func (s *Server) uploadDir(id string) (string, error) {
	if !uploadIDPattern.MatchString(id) {
		return "", errNoSuchUpload
	}
	return filepath.Join(s.cfg.Dir, "uploads", id), nil
}

// openUpload returns the upload directory when id exists and belongs to key.
func (s *Server) openUpload(id, key string) (string, error) {
	dir, err := s.uploadDir(id)
	if err != nil {
		return "", err
	}
	raw, err := os.ReadFile(filepath.Join(dir, "meta.json"))
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return "", errNoSuchUpload
		}
		return "", err
	}
	var m uploadMeta
	if err := json.Unmarshal(raw, &m); err != nil || m.Key != key {
		return "", errNoSuchUpload
	}
	return dir, nil
}

type initiateResult struct {
	XMLName  xml.Name `xml:"InitiateMultipartUploadResult"`
	Bucket   string   `xml:"Bucket"`
	Key      string   `xml:"Key"`
	UploadID string   `xml:"UploadId"`
}

func (s *Server) createUpload(w http.ResponseWriter, r *http.Request, key string) {
	var idBytes [16]byte
	if _, err := rand.Read(idBytes[:]); err != nil {
		s.fail(w, r, err)
		return
	}
	id := hex.EncodeToString(idBytes[:])
	dir := filepath.Join(s.cfg.Dir, "uploads", id)
	if err := os.Mkdir(dir, 0o700); err != nil {
		s.fail(w, r, err)
		return
	}
	raw, _ := json.Marshal(uploadMeta{Key: key})
	if err := os.WriteFile(filepath.Join(dir, "meta.json"), raw, 0o600); err != nil {
		_ = os.RemoveAll(dir)
		s.fail(w, r, err)
		return
	}
	writeXML(w, http.StatusOK, initiateResult{Bucket: s.cfg.Bucket, Key: key, UploadID: id})
}

func (s *Server) uploadPart(w http.ResponseWriter, r *http.Request, key string, q map[string][]string) {
	dir, err := s.openUpload(first(q, "uploadId"), key)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	n, err := strconv.Atoi(first(q, "partNumber"))
	if err != nil || n < 1 || n > 10000 {
		writeError(w, r, errInvalidArgument)
		return
	}
	tmp, body, err := s.spool(r)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	if err := os.Rename(tmp, filepath.Join(dir, "part-"+strconv.Itoa(n))); err != nil {
		_ = os.Remove(tmp)
		s.fail(w, r, err)
		return
	}
	w.Header().Set("ETag", `"`+body.etag()+`"`)
	w.WriteHeader(http.StatusOK)
}

type completeRequest struct {
	Parts []struct {
		PartNumber int    `xml:"PartNumber"`
		ETag       string `xml:"ETag"`
	} `xml:"Part"`
}

type completeResult struct {
	XMLName xml.Name `xml:"CompleteMultipartUploadResult"`
	Bucket  string   `xml:"Bucket"`
	Key     string   `xml:"Key"`
	ETag    string   `xml:"ETag"`
}

func (s *Server) completeUpload(w http.ResponseWriter, r *http.Request, key, id string) {
	dir, err := s.openUpload(id, key)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	var req completeRequest
	if err := decodeXML(r, &req); err != nil {
		s.fail(w, r, err)
		return
	}
	if len(req.Parts) == 0 {
		writeError(w, r, errMalformedXML)
		return
	}
	out, err := s.tempFile()
	if err != nil {
		s.fail(w, r, err)
		return
	}
	cleanup := func() { _ = os.Remove(out.Name()) }
	var size int64
	etagSum := md5.New()
	prev := 0
	for _, p := range req.Parts {
		if p.PartNumber <= prev {
			_ = out.Close()
			cleanup()
			writeError(w, r, errInvalidPartOrder)
			return
		}
		prev = p.PartNumber
		partSize, partETag, err := appendPart(out, filepath.Join(dir, "part-"+strconv.Itoa(p.PartNumber)))
		if err != nil || partETag != strings.Trim(p.ETag, `"`) {
			_ = out.Close()
			cleanup()
			if err == nil || errors.Is(err, fs.ErrNotExist) {
				writeError(w, r, errInvalidPart)
				return
			}
			s.fail(w, r, err)
			return
		}
		size += partSize
		raw, _ := hex.DecodeString(partETag)
		etagSum.Write(raw)
	}
	if err := out.Sync(); err != nil {
		_ = out.Close()
		cleanup()
		s.fail(w, r, err)
		return
	}
	if err := out.Close(); err != nil {
		cleanup()
		s.fail(w, r, err)
		return
	}
	etag := fmt.Sprintf("%s-%d", hex.EncodeToString(etagSum.Sum(nil)), len(req.Parts))
	if err := s.commit(key, out.Name(), size, etag); err != nil {
		cleanup()
		s.fail(w, r, err)
		return
	}
	_ = os.RemoveAll(dir)
	writeXML(w, http.StatusOK, completeResult{Bucket: s.cfg.Bucket, Key: key, ETag: `"` + etag + `"`})
}

func appendPart(dst *os.File, path string) (int64, string, error) {
	f, err := os.Open(path)
	if err != nil {
		return 0, "", err
	}
	defer func() { _ = f.Close() }()
	h := md5.New()
	n, err := io.Copy(io.MultiWriter(dst, h), f)
	return n, hex.EncodeToString(h.Sum(nil)), err
}

func (s *Server) abortUpload(w http.ResponseWriter, r *http.Request, key, id string) {
	dir, err := s.openUpload(id, key)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	if err := os.RemoveAll(dir); err != nil {
		s.fail(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ---- responses ----

type apiError struct {
	Status  int
	Code    string
	Message string
}

func (e *apiError) Error() string { return e.Code }

var (
	errAccessDenied     = &apiError{http.StatusForbidden, "AccessDenied", "Access Denied"}
	errSignature        = &apiError{http.StatusForbidden, "SignatureDoesNotMatch", "The request signature does not match"}
	errInvalidKey       = &apiError{http.StatusForbidden, "InvalidAccessKeyId", "The access key ID is unknown"}
	errSkew             = &apiError{http.StatusForbidden, "RequestTimeTooSkewed", "The request time is too far from the server time"}
	errNoSuchBucket     = &apiError{http.StatusNotFound, "NoSuchBucket", "The specified bucket does not exist"}
	errNoSuchKey        = &apiError{http.StatusNotFound, "NoSuchKey", "The specified key does not exist"}
	errNoSuchUpload     = &apiError{http.StatusNotFound, "NoSuchUpload", "The specified upload does not exist"}
	errKeyTooLong       = &apiError{http.StatusBadRequest, "KeyTooLongError", "Your key is too long"}
	errInvalidArgument  = &apiError{http.StatusBadRequest, "InvalidArgument", "Invalid argument"}
	errMalformedXML     = &apiError{http.StatusBadRequest, "MalformedXML", "The XML you provided was not well-formed"}
	errContentSHA       = &apiError{http.StatusBadRequest, "XAmzContentSHA256Mismatch", "The provided x-amz-content-sha256 header does not match the body"}
	errInvalidPart      = &apiError{http.StatusBadRequest, "InvalidPart", "One or more of the specified parts could not be found or its ETag does not match"}
	errInvalidPartOrder = &apiError{http.StatusBadRequest, "InvalidPartOrder", "The list of parts was not in ascending order"}
	errMethodNotAllowed = &apiError{http.StatusMethodNotAllowed, "MethodNotAllowed", "The specified method is not allowed against this resource"}
	errNotImplemented   = &apiError{http.StatusNotImplemented, "NotImplemented", "A header or request you provided implies functionality that is not implemented"}
)

func (s *Server) fail(w http.ResponseWriter, r *http.Request, err error) {
	var ae *apiError
	if errors.As(err, &ae) {
		writeError(w, r, ae)
		return
	}
	s.log.Error("object server request failed", "method", r.Method, "error", err.Error())
	writeError(w, r, &apiError{http.StatusInternalServerError, "InternalError", "We encountered an internal error"})
}

type errorBody struct {
	XMLName xml.Name `xml:"Error"`
	Code    string   `xml:"Code"`
	Message string   `xml:"Message"`
}

func writeError(w http.ResponseWriter, r *http.Request, e *apiError) {
	if r.Method == http.MethodHead {
		w.WriteHeader(e.Status)
		return
	}
	writeXML(w, e.Status, errorBody{Code: e.Code, Message: e.Message})
}

func writeXML(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/xml")
	w.WriteHeader(status)
	_, _ = io.WriteString(w, xml.Header)
	_ = xml.NewEncoder(w).Encode(v)
}
