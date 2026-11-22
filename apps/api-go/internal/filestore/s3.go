package filestore

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/contentcrypto"
)

const (
	defaultS3PartBytes = 16 * 1024 * 1024
	objectPrefixID     = "object:"
)

// ErrObjectStorageMissing is returned when reading an `object:` artifact without S3 configured.
var ErrObjectStorageMissing = errors.New("this artifact requires the configured object storage")

// S3Config configures S3Backend.
type S3Config struct {
	Bucket          string
	Endpoint        string
	Region          string
	AccessKeyID     string
	SecretAccessKey string
	Prefix          string
	PathStyle       bool
	Client          *http.Client
	Now             func() time.Time
	partBytes       int
}

// S3Backend is a lightweight, zero-dependency AWS SigV4 S3 object client
// supporting single PUT, streaming 16 MiB multipart uploads, HEAD, Range GET, and DELETE.
type S3Backend struct {
	cfg       S3Config
	client    *http.Client
	now       func() time.Time
	partBytes int
}

// NewS3Backend validates cfg and constructs an S3Backend.
func NewS3Backend(cfg S3Config) (*S3Backend, error) {
	if strings.TrimSpace(cfg.Bucket) == "" || strings.TrimSpace(cfg.AccessKeyID) == "" || strings.TrimSpace(cfg.SecretAccessKey) == "" {
		return nil, errors.New("s3 bucket and credentials are required")
	}
	if strings.TrimSpace(cfg.Region) == "" {
		cfg.Region = "us-east-1"
	}
	cfg.Prefix = strings.Trim(strings.TrimSpace(cfg.Prefix), "/")
	client := cfg.Client
	if client == nil {
		client = &http.Client{Timeout: 0}
	}
	nowFn := cfg.Now
	if nowFn == nil {
		nowFn = time.Now
	}
	partBytes := cfg.partBytes
	if partBytes <= 0 {
		partBytes = defaultS3PartBytes
	}
	return &S3Backend{
		cfg:       cfg,
		client:    client,
		now:       nowFn,
		partBytes: partBytes,
	}, nil
}

func (b *S3Backend) fullKey(key string) string {
	cleaned := strings.TrimLeft(key, "/")
	if b.cfg.Prefix == "" {
		return cleaned
	}
	return b.cfg.Prefix + "/" + cleaned
}

func (b *S3Backend) buildURL(key string, query url.Values) (*url.URL, error) {
	objectKey := b.fullKey(key)
	var base string
	if b.cfg.Endpoint != "" {
		parsed, err := url.Parse(strings.TrimRight(b.cfg.Endpoint, "/"))
		if err != nil {
			return nil, err
		}
		if b.cfg.PathStyle {
			base = strings.TrimRight(parsed.String(), "/") + "/" + url.PathEscape(b.cfg.Bucket) + "/" + escapeS3Path(objectKey)
		} else {
			cloned := *parsed
			cloned.Host = b.cfg.Bucket + "." + parsed.Host
			base = strings.TrimRight(cloned.String(), "/") + "/" + escapeS3Path(objectKey)
		}
	} else if b.cfg.PathStyle {
		base = fmt.Sprintf("https://s3.%s.amazonaws.com/%s/%s", b.cfg.Region, url.PathEscape(b.cfg.Bucket), escapeS3Path(objectKey))
	} else {
		base = fmt.Sprintf("https://%s.s3.%s.amazonaws.com/%s", b.cfg.Bucket, b.cfg.Region, escapeS3Path(objectKey))
	}
	u, err := url.Parse(base)
	if err != nil {
		return nil, err
	}
	if len(query) > 0 {
		u.RawQuery = encodeSortedQuery(query)
	}
	return u, nil
}

func escapeS3Path(key string) string {
	parts := strings.Split(key, "/")
	for i, part := range parts {
		parts[i] = awsEncode(part)
	}
	return strings.Join(parts, "/")
}

func awsEncode(s string) string {
	var out strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		if (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-' || c == '_' || c == '.' || c == '~' {
			out.WriteByte(c)
		} else {
			fmt.Fprintf(&out, "%%%02X", c)
		}
	}
	return out.String()
}

func encodeSortedQuery(q url.Values) string {
	keys := make([]string, 0, len(q))
	for k := range q {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var parts []string
	for _, k := range keys {
		vals := append([]string(nil), q[k]...)
		sort.Strings(vals)
		ek := awsEncode(k)
		for _, v := range vals {
			parts = append(parts, ek+"="+awsEncode(v))
		}
	}
	return strings.Join(parts, "&")
}

func (b *S3Backend) doSigned(ctx context.Context, method string, key string, query url.Values, body []byte, extraHeaders http.Header) (*http.Response, error) {
	u, err := b.buildURL(key, query)
	if err != nil {
		return nil, err
	}
	var bodyReader io.Reader
	if body != nil {
		bodyReader = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, u.String(), bodyReader)
	if err != nil {
		return nil, err
	}
	if body != nil {
		req.ContentLength = int64(len(body))
	}
	for k, vals := range extraHeaders {
		for _, v := range vals {
			req.Header.Add(k, v)
		}
	}

	now := b.now().UTC()
	amzDate := now.Format("20060102T150405Z")
	shortDate := now.Format("20060102")
	sum := sha256.Sum256(body)
	payloadHash := hex.EncodeToString(sum[:])

	req.Host = u.Host
	req.Header.Set("Host", u.Host)
	req.Header.Set("x-amz-date", amzDate)
	req.Header.Set("x-amz-content-sha256", payloadHash)

	canonicalHeaders, signedHeaders := canonicalizeHeaders(req)
	canonicalURI := u.EscapedPath()
	if canonicalURI == "" {
		canonicalURI = "/"
	}
	canonicalReq := strings.Join([]string{
		method,
		canonicalURI,
		u.RawQuery,
		canonicalHeaders,
		signedHeaders,
		payloadHash,
	}, "\n")

	scope := shortDate + "/" + b.cfg.Region + "/s3/aws4_request"
	reqHash := sha256.Sum256([]byte(canonicalReq))
	stringToSign := "AWS4-HMAC-SHA256\n" + amzDate + "\n" + scope + "\n" + hex.EncodeToString(reqHash[:])

	signingKey := hmacSHA256(
		hmacSHA256(
			hmacSHA256(
				hmacSHA256([]byte("AWS4"+b.cfg.SecretAccessKey), shortDate),
				b.cfg.Region,
			),
			"s3",
		),
		"aws4_request",
	)
	sig := hex.EncodeToString(hmacSHA256(signingKey, stringToSign))
	auth := fmt.Sprintf("AWS4-HMAC-SHA256 Credential=%s/%s, SignedHeaders=%s, Signature=%s",
		b.cfg.AccessKeyID, scope, signedHeaders, sig)
	req.Header.Set("Authorization", auth)

	return b.client.Do(req)
}

func canonicalizeHeaders(req *http.Request) (string, string) {
	type kv struct {
		k string
		v string
	}
	var list []kv
	for k, vals := range req.Header {
		lk := strings.ToLower(k)
		if lk == "host" || lk == "content-type" || lk == "range" || strings.HasPrefix(lk, "x-amz-") {
			trimmed := make([]string, len(vals))
			for i, v := range vals {
				trimmed[i] = strings.Join(strings.Fields(v), " ")
			}
			list = append(list, kv{k: lk, v: strings.Join(trimmed, ",")})
		}
	}
	sort.Slice(list, func(i, j int) bool { return list[i].k < list[j].k })
	var canonical strings.Builder
	signed := make([]string, 0, len(list))
	for _, item := range list {
		canonical.WriteString(item.k)
		canonical.WriteByte(':')
		canonical.WriteString(item.v)
		canonical.WriteByte('\n')
		signed = append(signed, item.k)
	}
	return canonical.String(), strings.Join(signed, ";")
}

func hmacSHA256(key []byte, data string) []byte {
	mac := hmac.New(sha256.New, key)
	mac.Write([]byte(data))
	return mac.Sum(nil)
}

func drainError(resp *http.Response, op string) error {
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
	_ = resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return ErrNotFound
	}
	return fmt.Errorf("s3 %s failed (%d): %s", op, resp.StatusCode, strings.TrimSpace(string(body)))
}

type initiateMultipartResult struct {
	UploadID string `xml:"UploadId"`
}

type completedPart struct {
	PartNumber int    `xml:"PartNumber"`
	ETag       string `xml:"ETag"`
}

type completeMultipartRequest struct {
	XMLName xml.Name        `xml:"CompleteMultipartUpload"`
	Parts   []completedPart `xml:"Part"`
}

// Put uploads src under key, using a single PUT for <= partBytes and multipart
// upload for larger streams.
func (b *S3Backend) Put(ctx context.Context, key string, src io.Reader) error {
	buf := make([]byte, b.partBytes+1)
	n, err := io.ReadFull(src, buf)
	if err != nil && !errors.Is(err, io.EOF) && !errors.Is(err, io.ErrUnexpectedEOF) {
		return err
	}
	if n <= b.partBytes {
		resp, err := b.doSigned(ctx, http.MethodPut, key, nil, buf[:n], nil)
		if err != nil {
			return err
		}
		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			return drainError(resp, "put")
		}
		_ = resp.Body.Close()
		return nil
	}

	// Stream as S3 multipart upload.
	initResp, err := b.doSigned(ctx, http.MethodPost, key, url.Values{"uploads": {""}}, nil, nil)
	if err != nil {
		return err
	}
	initBytes, _ := io.ReadAll(io.LimitReader(initResp.Body, 64*1024))
	_ = initResp.Body.Close()
	if initResp.StatusCode < 200 || initResp.StatusCode >= 300 {
		return fmt.Errorf("s3 create multipart failed (%d): %s", initResp.StatusCode, strings.TrimSpace(string(initBytes)))
	}
	var initParsed initiateMultipartResult
	if err := xml.Unmarshal(initBytes, &initParsed); err != nil || initParsed.UploadID == "" {
		return fmt.Errorf("s3 create multipart parse error: %w", err)
	}
	uploadID := initParsed.UploadID

	completed := false
	defer func() {
		if !completed {
			abortCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			resp, err := b.doSigned(abortCtx, http.MethodDelete, key, url.Values{"uploadId": {uploadID}}, nil, nil)
			if err == nil {
				_ = resp.Body.Close()
			}
		}
	}()

	var parts []completedPart
	partNum := 1
	uploadPart := func(data []byte) error {
		q := url.Values{
			"partNumber": {strconv.Itoa(partNum)},
			"uploadId":   {uploadID},
		}
		resp, err := b.doSigned(ctx, http.MethodPut, key, q, data, nil)
		if err != nil {
			return err
		}
		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			return drainError(resp, "uploadPart")
		}
		etag := strings.TrimSpace(resp.Header.Get("ETag"))
		_ = resp.Body.Close()
		parts = append(parts, completedPart{PartNumber: partNum, ETag: etag})
		partNum++
		return nil
	}

	if err := uploadPart(buf[:b.partBytes]); err != nil {
		return err
	}
	// Carry the 1 extra byte we already read into the start of the next part buffer.
	partBuf := make([]byte, b.partBytes)
	partBuf[0] = buf[b.partBytes]
	filled := 1

	for {
		m, readErr := io.ReadFull(src, partBuf[filled:])
		total := filled + m
		if readErr != nil && !errors.Is(readErr, io.EOF) && !errors.Is(readErr, io.ErrUnexpectedEOF) {
			return readErr
		}
		if total > 0 {
			if err := uploadPart(partBuf[:total]); err != nil {
				return err
			}
		}
		if errors.Is(readErr, io.EOF) || errors.Is(readErr, io.ErrUnexpectedEOF) {
			break
		}
		filled = 0
	}

	payload, err := xml.Marshal(completeMultipartRequest{Parts: parts})
	if err != nil {
		return err
	}
	hdr := http.Header{"Content-Type": {"application/xml"}}
	compResp, err := b.doSigned(ctx, http.MethodPost, key, url.Values{"uploadId": {uploadID}}, payload, hdr)
	if err != nil {
		return err
	}
	if compResp.StatusCode < 200 || compResp.StatusCode >= 300 {
		return drainError(compResp, "completeMultipart")
	}
	_ = compResp.Body.Close()
	completed = true
	return nil
}

// Head returns the object's stored size in bytes.
func (b *S3Backend) Head(ctx context.Context, key string) (int64, error) {
	resp, err := b.doSigned(ctx, http.MethodHead, key, nil, nil, nil)
	if err != nil {
		return 0, err
	}
	_ = resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return 0, ErrNotFound
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return 0, fmt.Errorf("s3 head failed (%d)", resp.StatusCode)
	}
	if resp.ContentLength < 0 {
		return 0, errors.New("s3 head missing Content-Length")
	}
	return resp.ContentLength, nil
}

// GetRange downloads either a byte range [start, endInclusive] or (when endInclusive < 0)
// the full object, returning the response body and the total stored object size.
func (b *S3Backend) GetRange(ctx context.Context, key string, start, endInclusive int64) (io.ReadCloser, int64, error) {
	var hdr http.Header
	if endInclusive >= start && start >= 0 {
		hdr = http.Header{"Range": {fmt.Sprintf("bytes=%d-%d", start, endInclusive)}}
	}
	resp, err := b.doSigned(ctx, http.MethodGet, key, nil, nil, hdr)
	if err != nil {
		return nil, 0, err
	}
	if resp.StatusCode == http.StatusNotFound {
		_ = resp.Body.Close()
		return nil, 0, ErrNotFound
	}
	if resp.StatusCode == http.StatusRequestedRangeNotSatisfiable {
		total, ok := parseTotalFromContentRange(resp.Header.Get("Content-Range"))
		_ = resp.Body.Close()
		if ok && total == 0 && start == 0 {
			return io.NopCloser(bytes.NewReader(nil)), 0, nil
		}
		return nil, 0, ErrInvalidRange
	}
	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusPartialContent {
		return nil, 0, drainError(resp, "get")
	}
	total := resp.ContentLength
	if resp.StatusCode == http.StatusPartialContent {
		if parsedTotal, ok := parseTotalFromContentRange(resp.Header.Get("Content-Range")); ok {
			total = parsedTotal
		}
	}
	if total < 0 {
		total = 0
	}
	return resp.Body, total, nil
}

func parseTotalFromContentRange(raw string) (int64, bool) {
	idx := strings.LastIndex(raw, "/")
	if idx < 0 {
		return 0, false
	}
	tail := strings.TrimSpace(raw[idx+1:])
	if tail == "" || tail == "*" {
		return 0, false
	}
	val, err := strconv.ParseInt(tail, 10, 64)
	if err != nil || val < 0 {
		return 0, false
	}
	return val, true
}

// Delete removes key from S3 (missing keys succeed idempotently).
func (b *S3Backend) Delete(ctx context.Context, key string) error {
	resp, err := b.doSigned(ctx, http.MethodDelete, key, nil, nil, nil)
	if err != nil {
		return err
	}
	if resp.StatusCode == http.StatusNotFound || (resp.StatusCode >= 200 && resp.StatusCode < 300) {
		_ = resp.Body.Close()
		return nil
	}
	return drainError(resp, "delete")
}

// ObjectStore persists artifacts in S3-compatible object storage, always sealed
// under RKZA v1 with `object:<uuid>` identifiers matching ObjectArtifactStore.
type ObjectStore struct {
	s3   *S3Backend
	keys *contentcrypto.KeyRing
}

// NewObjectStore creates an encrypted S3 artifact store.
func NewObjectStore(s3 *S3Backend, keys *contentcrypto.KeyRing) (*ObjectStore, error) {
	if s3 == nil || keys == nil {
		return nil, errors.New("object storage requires s3 backend and key ring")
	}
	return &ObjectStore{s3: s3, keys: keys}, nil
}

func (s *ObjectStore) objectKey(spaceID, id string) (string, error) {
	if err := validateSegment(spaceID); err != nil {
		return "", err
	}
	raw, ok := strings.CutPrefix(id, objectPrefixID)
	if !ok || validateSegment(raw) != nil {
		return "", ErrInvalidID
	}
	return "artifacts/" + spaceID + "/" + raw, nil
}

// PutStream seals src in RKZA v1 and streams it to S3 without buffering the
// entire file on disk.
func (s *ObjectStore) PutStream(ctx context.Context, spaceID string, src io.Reader) (StoredBlob, error) {
	if err := validateSegment(spaceID); err != nil {
		return StoredBlob{}, err
	}
	rawID, err := newUUID()
	if err != nil {
		return StoredBlob{}, err
	}
	id := objectPrefixID + rawID
	objKey, err := s.objectKey(spaceID, id)
	if err != nil {
		return StoredBlob{}, err
	}
	key, err := s.keys.Current(ctx, spaceID)
	if err != nil {
		return StoredBlob{}, err
	}

	pr, pw := io.Pipe()
	type sealRes struct {
		plainBytes int64
		hashHex    string
		err        error
	}
	done := make(chan sealRes, 1)
	go func() {
		plainBytes, _, hashHex, sealErr := contentcrypto.SealArtifact(pw, src, key, spaceID, id)
		_ = pw.CloseWithError(sealErr)
		done <- sealRes{plainBytes: plainBytes, hashHex: hashHex, err: sealErr}
	}()

	putErr := s.s3.Put(ctx, objKey, pr)
	if putErr != nil {
		_ = pr.CloseWithError(putErr)
		<-done
		return StoredBlob{}, putErr
	}
	_ = pr.Close()
	res := <-done
	if res.err != nil {
		_ = s.s3.Delete(context.Background(), objKey)
		return StoredBlob{}, res.err
	}
	return StoredBlob{ID: id, Hash: res.hashHex, SizeBytes: res.plainBytes}, nil
}

// Stat returns the authenticated plaintext length of id.
func (s *ObjectStore) Stat(ctx context.Context, spaceID, id string) (int64, error) {
	objKey, err := s.objectKey(spaceID, id)
	if err != nil {
		return 0, err
	}
	rc, totalLen, err := s.s3.GetRange(ctx, objKey, 0, 271)
	if err != nil {
		return 0, err
	}
	prefix, readErr := io.ReadAll(io.LimitReader(rc, 272))
	_ = rc.Close()
	if readErr != nil {
		return 0, readErr
	}
	if !contentcrypto.IsSealedArtifact(prefix) {
		return totalLen, nil
	}
	hdr, _, err := contentcrypto.ParseArtifactHeaderBytes(prefix)
	if err != nil {
		return 0, err
	}
	key, err := s.keys.ByID(ctx, hdr.KeyID)
	if err != nil {
		return 0, err
	}
	if key.SpaceID != spaceID {
		return 0, contentcrypto.ErrAnotherSpace
	}
	return hdr.PlainSize(totalLen)
}

// OpenStream streams plaintext bytes (optionally restricted to byteRange) from S3.
func (s *ObjectStore) OpenStream(ctx context.Context, spaceID, id string, byteRange *ByteRange) (io.ReadCloser, int64, error) {
	objKey, err := s.objectKey(spaceID, id)
	if err != nil {
		return nil, 0, err
	}
	rc, sealedSize, err := s.s3.GetRange(ctx, objKey, 0, 271)
	if err != nil {
		return nil, 0, err
	}
	prefix, readErr := io.ReadAll(io.LimitReader(rc, 272))
	_ = rc.Close()
	if readErr != nil {
		return nil, 0, readErr
	}
	if !contentcrypto.IsSealedArtifact(prefix) {
		plainSize := sealedSize
		start, end, err := validateRange(byteRange, plainSize)
		if err != nil {
			return nil, 0, err
		}
		if plainSize == 0 {
			return io.NopCloser(bytes.NewReader(nil)), 0, nil
		}
		if end < int64(len(prefix)) && plainSize == int64(len(prefix)) {
			return io.NopCloser(bytes.NewReader(prefix[start : end+1])), plainSize, nil
		}
		body, _, err := s.s3.GetRange(ctx, objKey, start, end)
		return body, plainSize, err
	}

	hdr, _, err := contentcrypto.ParseArtifactHeaderBytes(prefix)
	if err != nil {
		return nil, 0, err
	}
	plainSize, err := hdr.PlainSize(sealedSize)
	if err != nil {
		return nil, 0, err
	}
	key, err := s.keys.ByID(ctx, hdr.KeyID)
	if err != nil {
		return nil, 0, err
	}
	start, end, err := validateRange(byteRange, plainSize)
	if err != nil {
		return nil, 0, err
	}
	stream, err := contentcrypto.OpenArtifactRangeReader(
		ctx,
		hdr,
		key,
		spaceID,
		id,
		sealedSize,
		start,
		end,
		func(callCtx context.Context, sStart, sEnd int64) (io.ReadCloser, error) {
			body, _, err := s.s3.GetRange(callCtx, objKey, sStart, sEnd)
			return body, err
		},
	)
	if err != nil {
		return nil, 0, err
	}
	return stream, plainSize, nil
}

// Remove deletes an object artifact from S3.
func (s *ObjectStore) Remove(ctx context.Context, spaceID, id string) error {
	objKey, err := s.objectKey(spaceID, id)
	if err != nil {
		return err
	}
	return s.s3.Delete(ctx, objKey)
}
