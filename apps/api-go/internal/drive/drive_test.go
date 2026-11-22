package drive

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/auth"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/contentcrypto"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/filepolicy"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/filestore"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/orpc"
)

type memoryKeyStore struct {
	mu   sync.Mutex
	rows map[string][]contentcrypto.SpaceKeyRecord
}

func (m *memoryKeyStore) ForSpace(_ context.Context, spaceID string) ([]contentcrypto.SpaceKeyRecord, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return append([]contentcrypto.SpaceKeyRecord(nil), m.rows[spaceID]...), nil
}

func (m *memoryKeyStore) ByID(_ context.Context, id string) (contentcrypto.SpaceKeyRecord, bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, list := range m.rows {
		for _, r := range list {
			if r.ID == id {
				return r, true, nil
			}
		}
	}
	return contentcrypto.SpaceKeyRecord{}, false, nil
}

func (m *memoryKeyStore) Insert(_ context.Context, r contentcrypto.SpaceKeyRecord) (contentcrypto.SpaceKeyRecord, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	r.ID = "sk-1"
	m.rows[r.SpaceID] = append(m.rows[r.SpaceID], r)
	return r, nil
}

func (m *memoryKeyStore) RowContext(_ context.Context, _ contentcrypto.SpaceSource, _ string) (contentcrypto.RowContext, bool, error) {
	return contentcrypto.RowContext{}, false, nil
}

func (m *memoryKeyStore) SampleByMasterKey(_ context.Context) ([]contentcrypto.SpaceKeyRecord, error) {
	return nil, nil
}

type fakeAuth struct {
	lastSpace string
}

func (a *fakeAuth) Authenticate(_ context.Context, r *http.Request) (*auth.Session, *http.Cookie, *orpc.Error) {
	if r.Header.Get("Cookie") == "" && r.Header.Get("Authorization") == "" {
		return nil, nil, orpc.Unauthorized()
	}
	return &auth.Session{}, nil, nil
}

func (a *fakeAuth) Actor(_ context.Context, _ *auth.Session, requestedSpace string) (db.Actor, *orpc.Error) {
	a.lastSpace = requestedSpace
	if requestedSpace == "" {
		requestedSpace = "space-1"
	}
	return db.Actor{UserID: "user-1", SpaceID: requestedSpace}, nil
}

type fakeBackend struct {
	store      filestore.Store
	maxBytes   int64
	mu         sync.Mutex
	files      map[string]ContentMeta
	lastParams UploadParams
}

func newFakeBackend(t *testing.T) *fakeBackend {
	t.Helper()
	provider, err := contentcrypto.NewLocalKeyProvider([]contentcrypto.MasterKey{{ID: "m1", Key: bytes.Repeat([]byte{0x11}, 32)}})
	if err != nil {
		t.Fatal(err)
	}
	ring := contentcrypto.NewKeyRing(provider, &memoryKeyStore{rows: map[string][]contentcrypto.SpaceKeyRecord{}}, contentcrypto.KeyRingOptions{EncryptWrites: true})
	return &fakeBackend{
		store:    filestore.NewLocalStore(t.TempDir(), ring),
		maxBytes: 1024 * 1024,
		files:    map[string]ContentMeta{},
	}
}

func (f *fakeBackend) MaxFileBytes() int64 { return f.maxBytes }

func (f *fakeBackend) UploadStream(ctx context.Context, actor db.Actor, params UploadParams, src io.Reader) (DriveFile, *orpc.Error) {
	name, err := filepolicy.ValidateDriveName(normalizeFilename(params.Name))
	if err != nil {
		return DriveFile{}, orpc.BadRequest(err.Error())
	}
	mimeType, err := filepolicy.InferMIME(name, params.MimeType)
	if err != nil {
		return DriveFile{}, orpc.BadRequest(err.Error())
	}
	prefix := make([]byte, sniffBytes)
	pn, readErr := io.ReadFull(src, prefix)
	if readErr != nil && !errors.Is(readErr, io.EOF) && !errors.Is(readErr, io.ErrUnexpectedEOF) {
		return DriveFile{}, orpc.BadRequest("read failed")
	}
	prefix = prefix[:pn]
	if err := filepolicy.SniffSafeUpload(mimeType, prefix); err != nil {
		return DriveFile{}, orpc.BadRequest(err.Error())
	}
	lr := &boundedStreamReader{r: io.MultiReader(bytes.NewReader(prefix), src), max: f.maxBytes}
	blob, err := f.store.PutStream(ctx, actor.SpaceID, lr)
	if err != nil {
		if errors.Is(err, errStreamTooLarge) {
			return DriveFile{}, orpc.TooLarge("File exceeds limit")
		}
		return DriveFile{}, orpc.Internal()
	}
	sum := sha256.Sum256(prefix)
	_ = hex.EncodeToString(sum[:])

	f.mu.Lock()
	defer f.mu.Unlock()
	id := "file-" + blob.ID[:8]
	f.files[id] = ContentMeta{
		ID:         id,
		Name:       name,
		MimeType:   mimeType,
		Size:       blob.SizeBytes,
		Hash:       blob.Hash,
		StorageKey: blob.ID,
	}
	f.lastParams = params
	return DriveFile{
		ID:           id,
		FolderID:     params.FolderID,
		Source:       params.Source,
		Name:         name,
		MimeType:     mimeType,
		Size:         blob.SizeBytes,
		Hash:         blob.Hash,
		Version:      1,
		VersionCount: 1,
		ContentURL:   contentURLFor(id),
	}, nil
}

func (f *fakeBackend) StatContent(_ context.Context, _ db.Actor, fileID string) (ContentMeta, *orpc.Error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	meta, ok := f.files[fileID]
	if !ok {
		return ContentMeta{}, orpc.NotFound("File not found")
	}
	return meta, nil
}

func (f *fakeBackend) OpenContent(ctx context.Context, actor db.Actor, fileID string, byteRange *filestore.ByteRange) (ContentMeta, io.ReadCloser, int64, *orpc.Error) {
	meta, failure := f.StatContent(ctx, actor, fileID)
	if failure != nil {
		return ContentMeta{}, nil, 0, failure
	}
	rc, total, err := f.store.OpenStream(ctx, actor.SpaceID, meta.StorageKey, byteRange)
	if err != nil {
		if errors.Is(err, filestore.ErrInvalidRange) {
			return meta, nil, meta.Size, orpc.New("RANGE_NOT_SATISFIABLE", 416, "range")
		}
		return ContentMeta{}, nil, 0, orpc.Internal()
	}
	return meta, rc, total, nil
}

func TestParseSingleByteRange(t *testing.T) {
	if r, unsat := parseSingleByteRange("", 100); r != nil || unsat {
		t.Fatalf("empty range failed")
	}
	if r, unsat := parseSingleByteRange("bytes=0-49", 100); unsat || r.Start != 0 || r.EndInclusive != 49 {
		t.Fatalf("bytes=0-49: got %+v, unsat=%v", r, unsat)
	}
	if r, unsat := parseSingleByteRange("bytes=80-999", 100); unsat || r.Start != 80 || r.EndInclusive != 99 {
		t.Fatalf("clamp end: got %+v, unsat=%v", r, unsat)
	}
	if r, unsat := parseSingleByteRange("bytes=-25", 100); unsat || r.Start != 75 || r.EndInclusive != 99 {
		t.Fatalf("suffix: got %+v, unsat=%v", r, unsat)
	}
	if _, unsat := parseSingleByteRange("bytes=100-", 100); !unsat {
		t.Fatal("expected unsatisfiable at size boundary")
	}
	if r, unsat := parseSingleByteRange("bytes=0-1, 4-5", 100); r != nil || unsat {
		t.Fatal("multi-range should degrade to full read")
	}
}

func TestHTTPStreamingUploadRangeETagAndSecurity(t *testing.T) {
	backend := newFakeBackend(t)
	authSvc := &fakeAuth{}
	h := newHTTPHandler(backend, authSvc, HTTPConfig{WebOrigin: "https://app.example.test"})
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)

	// 1. Upload .sh script via multipart/form-data.
	shScript := "#!/usr/bin/env bash\necho hello\n"
	var mp bytes.Buffer
	mw := multipart.NewWriter(&mp)
	_ = mw.WriteField("folderId", "folder-42")
	fw, _ := mw.CreateFormFile("file", "deploy.sh")
	_, _ = fw.Write([]byte(shScript))
	_ = mw.Close()

	req, _ := http.NewRequest(http.MethodPost, srv.URL+"/api/v1/files", &mp)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	req.Header.Set("Cookie", "session=ok")
	req.Header.Set("Origin", "https://app.example.test")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("sh upload status = %d: %s", resp.StatusCode, string(body))
	}
	var shFile DriveFile
	if err := json.Unmarshal(body, &shFile); err != nil {
		t.Fatal(err)
	}
	if shFile.MimeType != "application/x-sh" || shFile.FolderID == nil || *shFile.FolderID != "folder-42" {
		t.Fatalf("unexpected sh metadata: %+v", shFile)
	}

	// Verify .sh Content-Disposition is attachment (not inline) on API origin.
	getSh, _ := http.NewRequest(http.MethodGet, srv.URL+shFile.ContentURL+"?spaceId=space-9", nil)
	getSh.Header.Set("Cookie", "session=ok")
	shResp, err := http.DefaultClient.Do(getSh)
	if err != nil {
		t.Fatal(err)
	}
	_ = shResp.Body.Close()
	if authSvc.lastSpace != "space-9" {
		t.Fatalf("expected ?spaceId fallback auth, got %q", authSvc.lastSpace)
	}
	if cd := shResp.Header.Get("Content-Disposition"); !strings.HasPrefix(cd, "attachment") {
		t.Fatalf(".sh Content-Disposition = %q, want attachment", cd)
	}
	if shResp.Header.Get("X-Content-Type-Options") != "nosniff" {
		t.Fatal("missing nosniff")
	}

	// 2. Upload >64 KiB .mp4 across encryption segments and verify 206 Range + ETag 304 + 416.
	mp4Data := make([]byte, 90*1024)
	for i := range mp4Data {
		mp4Data[i] = byte(i * 19)
	}
	mp.Reset()
	mw = multipart.NewWriter(&mp)
	fw, _ = mw.CreateFormFile("file", "clip.mp4")
	_, _ = fw.Write(mp4Data)
	_ = mw.Close()
	req, _ = http.NewRequest(http.MethodPost, srv.URL+"/api/v1/files", &mp)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	req.Header.Set("Authorization", "Bearer tok")
	resp, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	mp4JSON, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	var mp4File DriveFile
	_ = json.Unmarshal(mp4JSON, &mp4File)
	if mp4File.MimeType != "video/mp4" {
		t.Fatalf("mp4 mime = %q", mp4File.MimeType)
	}

	rngReq, _ := http.NewRequest(http.MethodGet, srv.URL+mp4File.ContentURL, nil)
	rngReq.Header.Set("Authorization", "Bearer tok")
	rngReq.Header.Set("Range", "bytes=65500-65699")
	rngResp, err := http.DefaultClient.Do(rngReq)
	if err != nil {
		t.Fatal(err)
	}
	gotSlice, _ := io.ReadAll(rngResp.Body)
	_ = rngResp.Body.Close()
	if rngResp.StatusCode != http.StatusPartialContent {
		t.Fatalf("range status = %d", rngResp.StatusCode)
	}
	if !strings.HasPrefix(rngResp.Header.Get("Content-Disposition"), "inline") {
		t.Fatalf("mp4 should be inline: %q", rngResp.Header.Get("Content-Disposition"))
	}
	if rngResp.Header.Get("Content-Range") != "bytes 65500-65699/92160" {
		t.Fatalf("Content-Range = %q", rngResp.Header.Get("Content-Range"))
	}
	if !bytes.Equal(gotSlice, mp4Data[65500:65700]) {
		t.Fatal("range payload mismatch across RKZA chunk boundary")
	}

	// ETag 304 check.
	etag := rngResp.Header.Get("ETag")
	inmReq, _ := http.NewRequest(http.MethodGet, srv.URL+mp4File.ContentURL, nil)
	inmReq.Header.Set("Authorization", "Bearer tok")
	inmReq.Header.Set("If-None-Match", etag)
	inmResp, _ := http.DefaultClient.Do(inmReq)
	_ = inmResp.Body.Close()
	if inmResp.StatusCode != http.StatusNotModified {
		t.Fatalf("If-None-Match status = %d, want 304", inmResp.StatusCode)
	}

	// Out-of-bounds range -> 416.
	badRngReq, _ := http.NewRequest(http.MethodGet, srv.URL+mp4File.ContentURL, nil)
	badRngReq.Header.Set("Authorization", "Bearer tok")
	badRngReq.Header.Set("Range", "bytes=999999-1000000")
	badRngResp, _ := http.DefaultClient.Do(badRngReq)
	_ = badRngResp.Body.Close()
	if badRngResp.StatusCode != http.StatusRequestedRangeNotSatisfiable {
		t.Fatalf("bad range status = %d, want 416", badRngResp.StatusCode)
	}

	// 3. Reject blocked .exe and spoofed PNG polyglot.
	for _, tc := range []struct {
		name, ctype, content string
		want                 int
	}{
		{"dropper.exe", "application/octet-stream", "MZ...", http.StatusBadRequest},
		{"xss.png", "image/png", "<svg onload=alert(1)>", http.StatusBadRequest},
		{"too-big.bin", "application/octet-stream", strings.Repeat("a", 1024*1024+10), http.StatusRequestEntityTooLarge},
	} {
		upReq, _ := http.NewRequest(http.MethodPost, srv.URL+"/api/v1/files", strings.NewReader(tc.content))
		upReq.Header.Set("Authorization", "Bearer tok")
		upReq.Header.Set("X-File-Name", tc.name)
		upReq.Header.Set("Content-Type", tc.ctype)
		upResp, _ := http.DefaultClient.Do(upReq)
		_ = upResp.Body.Close()
		if upResp.StatusCode != tc.want {
			t.Fatalf("%s: status = %d, want %d", tc.name, upResp.StatusCode, tc.want)
		}
	}
}
