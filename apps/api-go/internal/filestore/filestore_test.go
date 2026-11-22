package filestore

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/contentcrypto"
)

type memoryKeyStore struct {
	keys []contentcrypto.DataKey
}

func testKeyRing(t *testing.T, encryptWrites bool) *contentcrypto.KeyRing {
	t.Helper()
	master := bytes.Repeat([]byte{0x42}, 32)
	provider, err := contentcrypto.NewLocalKeyProvider([]contentcrypto.MasterKey{{ID: "m1", Key: master}})
	if err != nil {
		t.Fatal(err)
	}
	store := &memorySpaceKeys{rows: map[string][]contentcrypto.SpaceKeyRecord{}}
	return contentcrypto.NewKeyRing(provider, store, contentcrypto.KeyRingOptions{EncryptWrites: encryptWrites})
}

type memorySpaceKeys struct {
	mu   sync.Mutex
	rows map[string][]contentcrypto.SpaceKeyRecord
}

func (m *memorySpaceKeys) ForSpace(_ context.Context, spaceID string) ([]contentcrypto.SpaceKeyRecord, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return append([]contentcrypto.SpaceKeyRecord(nil), m.rows[spaceID]...), nil
}

func (m *memorySpaceKeys) ByID(_ context.Context, id string) (contentcrypto.SpaceKeyRecord, bool, error) {
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

func (m *memorySpaceKeys) Insert(_ context.Context, record contentcrypto.SpaceKeyRecord) (contentcrypto.SpaceKeyRecord, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	record.ID = "sk-" + strconv.Itoa(len(m.rows[record.SpaceID])+1)
	m.rows[record.SpaceID] = append(m.rows[record.SpaceID], record)
	return record, nil
}

func (m *memorySpaceKeys) RowContext(_ context.Context, _ contentcrypto.SpaceSource, _ string) (contentcrypto.RowContext, bool, error) {
	return contentcrypto.RowContext{}, false, nil
}

func (m *memorySpaceKeys) SampleByMasterKey(_ context.Context) ([]contentcrypto.SpaceKeyRecord, error) {
	return nil, nil
}

func TestLocalStorePermissionsSymlinksAndRanges(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	keys := testKeyRing(t, true)
	store := NewLocalStore(dir, keys)

	payload := make([]byte, 150*1024)
	for i := range payload {
		payload[i] = byte(i * 17)
	}
	blob, err := PutBytes(ctx, store, "space-1", payload)
	if err != nil {
		t.Fatalf("PutBytes failed: %v", err)
	}
	if blob.SizeBytes != int64(len(payload)) {
		t.Fatalf("SizeBytes = %d, want %d", blob.SizeBytes, len(payload))
	}

	onDiskPath := filepath.Join(dir, "artifacts", "space-1", blob.ID)
	info, err := os.Stat(onDiskPath)
	if err != nil {
		t.Fatalf("stat failed: %v", err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("file mode = %o, want 0600", info.Mode().Perm())
	}
	rawDisk, err := os.ReadFile(onDiskPath)
	if err != nil || !contentcrypto.IsSealedArtifact(rawDisk) {
		t.Fatalf("expected RKZA sealed file on disk (err=%v)", err)
	}

	plainSize, err := store.Stat(ctx, "space-1", blob.ID)
	if err != nil || plainSize != int64(len(payload)) {
		t.Fatalf("Stat = (%d, %v), want %d", plainSize, err, len(payload))
	}

	gotAll, err := ReadAll(ctx, store, "space-1", blob.ID)
	if err != nil || !bytes.Equal(gotAll, payload) {
		t.Fatalf("ReadAll mismatch (err=%v, len=%d)", err, len(gotAll))
	}

	// Range spanning across the 64 KiB encryption chunk boundary.
	start, end := int64(64*1024-100), int64(64*1024+200)
	rc, total, err := store.OpenStream(ctx, "space-1", blob.ID, &ByteRange{Start: start, EndInclusive: end})
	if err != nil || total != int64(len(payload)) {
		t.Fatalf("OpenStream range failed: total=%d err=%v", total, err)
	}
	gotSlice, err := io.ReadAll(rc)
	_ = rc.Close()
	if err != nil || !bytes.Equal(gotSlice, payload[start:end+1]) {
		t.Fatalf("range slice mismatch (err=%v, len=%d)", err, len(gotSlice))
	}

	if _, _, err := store.OpenStream(ctx, "space-1", blob.ID, &ByteRange{Start: total, EndInclusive: total}); !errors.Is(err, ErrInvalidRange) {
		t.Fatalf("expected ErrInvalidRange, got %v", err)
	}

	// Symlink replacement refusal via O_NOFOLLOW.
	outside := filepath.Join(dir, "outside.txt")
	if err := os.WriteFile(outside, []byte("secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(onDiskPath); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, onDiskPath); err != nil {
		t.Fatal(err)
	}
	if _, _, err := store.OpenStream(ctx, "space-1", blob.ID, nil); err == nil {
		t.Fatal("expected symlink refusal")
	}

	// Plaintext writes still work when encryption is off, and range seeks directly.
	plainStore := NewLocalStore(dir, testKeyRing(t, false))
	pb, err := PutBytes(ctx, plainStore, "space-2", []byte("hello world"))
	if err != nil {
		t.Fatal(err)
	}
	prc, ptotal, err := plainStore.OpenStream(ctx, "space-2", pb.ID, &ByteRange{Start: 6, EndInclusive: 10})
	if err != nil || ptotal != 11 {
		t.Fatalf("plain range open = (%d, %v)", ptotal, err)
	}
	pBytes, _ := io.ReadAll(prc)
	_ = prc.Close()
	if string(pBytes) != "world" {
		t.Fatalf("plain range got %q", string(pBytes))
	}
	if err := plainStore.Remove(ctx, "space-2", pb.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := plainStore.Stat(ctx, "space-2", pb.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("expected ErrNotFound after remove, got %v", err)
	}
}

type mockS3Server struct {
	mu      sync.Mutex
	objects map[string][]byte
	uploads map[string]map[int][]byte
	lastSig string
}

func newMockS3Server(t *testing.T) (*httptest.Server, *mockS3Server) {
	t.Helper()
	m := &mockS3Server{
		objects: map[string][]byte{},
		uploads: map[string]map[int][]byte{},
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		m.mu.Lock()
		defer m.mu.Unlock()
		if auth := r.Header.Get("Authorization"); !strings.HasPrefix(auth, "AWS4-HMAC-SHA256 ") || r.Header.Get("x-amz-content-sha256") == "" {
			w.WriteHeader(http.StatusForbidden)
			return
		} else {
			m.lastSig = auth
		}
		key := strings.TrimPrefix(r.URL.Path, "/")
		q := r.URL.Query()
		switch r.Method {
		case http.MethodPost:
			if q.Has("uploads") {
				m.uploads[key] = map[int][]byte{}
				w.WriteHeader(http.StatusOK)
				_, _ = w.Write([]byte(`<InitiateMultipartUploadResult><UploadId>up-1</UploadId></InitiateMultipartUploadResult>`))
				return
			}
			if q.Get("uploadId") == "up-1" {
				parts := m.uploads[key]
				var assembled bytes.Buffer
				for i := 1; i <= len(parts); i++ {
					assembled.Write(parts[i])
				}
				m.objects[key] = assembled.Bytes()
				delete(m.uploads, key)
				w.WriteHeader(http.StatusOK)
				_, _ = w.Write([]byte(`<CompleteMultipartUploadResult></CompleteMultipartUploadResult>`))
				return
			}
		case http.MethodPut:
			body, _ := io.ReadAll(r.Body)
			if q.Has("uploadId") {
				pn, _ := strconv.Atoi(q.Get("partNumber"))
				m.uploads[key][pn] = body
				w.Header().Set("ETag", `"part-etag"`)
				w.WriteHeader(http.StatusOK)
				return
			}
			m.objects[key] = body
			w.WriteHeader(http.StatusOK)
			return
		case http.MethodHead:
			obj, ok := m.objects[key]
			if !ok {
				w.WriteHeader(http.StatusNotFound)
				return
			}
			w.Header().Set("Content-Length", strconv.Itoa(len(obj)))
			w.WriteHeader(http.StatusOK)
			return
		case http.MethodGet:
			obj, ok := m.objects[key]
			if !ok {
				w.WriteHeader(http.StatusNotFound)
				return
			}
			rng := r.Header.Get("Range")
			if rng == "" {
				w.Header().Set("Content-Length", strconv.Itoa(len(obj)))
				w.WriteHeader(http.StatusOK)
				_, _ = w.Write(obj)
				return
			}
			spec := strings.TrimPrefix(rng, "bytes=")
			pair := strings.Split(spec, "-")
			start, _ := strconv.ParseInt(pair[0], 10, 64)
			end, _ := strconv.ParseInt(pair[1], 10, 64)
			if end >= int64(len(obj)) {
				end = int64(len(obj)) - 1
			}
			slice := obj[start : end+1]
			w.Header().Set("Content-Range", "bytes "+strconv.FormatInt(start, 10)+"-"+strconv.FormatInt(end, 10)+"/"+strconv.Itoa(len(obj)))
			w.Header().Set("Content-Length", strconv.Itoa(len(slice)))
			w.WriteHeader(http.StatusPartialContent)
			_, _ = w.Write(slice)
			return
		case http.MethodDelete:
			if q.Has("uploadId") {
				delete(m.uploads, key)
				w.WriteHeader(http.StatusNoContent)
				return
			}
			delete(m.objects, key)
			w.WriteHeader(http.StatusNoContent)
			return
		}
		w.WriteHeader(http.StatusBadRequest)
	}))
	t.Cleanup(srv.Close)
	return srv, m
}

func TestObjectStoreMultipartAndDeploymentRouting(t *testing.T) {
	ctx := context.Background()
	srv, mock := newMockS3Server(t)
	s3, err := NewS3Backend(S3Config{
		Bucket:          "test-bucket",
		Endpoint:        srv.URL,
		Region:          "us-east-1",
		AccessKeyID:     "AKIA",
		SecretAccessKey: "SECRET",
		Prefix:          "hivemind",
		PathStyle:       true,
		partBytes:       64 * 1024, // force multipart for > 64 KiB streams cleanly in tests
	})
	if err != nil {
		t.Fatal(err)
	}
	keys := testKeyRing(t, true)
	objStore, err := NewObjectStore(s3, keys)
	if err != nil {
		t.Fatal(err)
	}

	localStore := NewLocalStore(t.TempDir(), keys)
	deploy := NewDeploymentStoreWith(localStore, objStore)

	// Upload > 2 parts through DeploymentStore -> routed to S3 as object:<uuid>.
	payload := make([]byte, 140*1024)
	for i := range payload {
		payload[i] = byte(i ^ 0x5a)
	}
	objBlob, err := PutBytes(ctx, deploy, "space-s3", payload)
	if err != nil {
		t.Fatalf("PutBytes via DeploymentStore failed: %v", err)
	}
	if !strings.HasPrefix(objBlob.ID, "object:") {
		t.Fatalf("expected object: id prefix, got %q", objBlob.ID)
	}
	if mock.lastSig == "" {
		t.Fatal("expected SigV4 signature on S3 request")
	}

	rc, total, err := deploy.OpenStream(ctx, "space-s3", objBlob.ID, &ByteRange{Start: 70000, EndInclusive: 90000})
	if err != nil || total != int64(len(payload)) {
		t.Fatalf("S3 range read = (%d, %v)", total, err)
	}
	got, _ := io.ReadAll(rc)
	_ = rc.Close()
	if !bytes.Equal(got, payload[70000:90001]) {
		t.Fatalf("S3 range slice mismatch")
	}

	// Pre-existing local artifact (without object: prefix) still reads via local fallback.
	localBlob, err := PutBytes(ctx, localStore, "space-s3", []byte("legacy-local"))
	if err != nil {
		t.Fatal(err)
	}
	legacyBytes, err := ReadAll(ctx, deploy, "space-s3", localBlob.ID)
	if err != nil || string(legacyBytes) != "legacy-local" {
		t.Fatalf("legacy local fallback failed: %q (%v)", string(legacyBytes), err)
	}

	// Reading an object: artifact when object storage isn't configured fails explicitly.
	noS3 := NewDeploymentStoreWith(localStore, nil)
	if _, _, err := noS3.OpenStream(ctx, "space-s3", objBlob.ID, nil); !errors.Is(err, ErrObjectStorageMissing) {
		t.Fatalf("expected ErrObjectStorageMissing, got %v", err)
	}

	if err := deploy.Remove(ctx, "space-s3", objBlob.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := deploy.Stat(ctx, "space-s3", objBlob.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("expected ErrNotFound after remove, got %v", err)
	}
}
