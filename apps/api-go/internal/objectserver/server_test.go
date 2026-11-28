package objectserver_test

import (
	"bytes"
	"context"
	"crypto/rand"
	"errors"
	"io"
	"net/http/httptest"
	"testing"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/filestore"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/objectserver"
)

const (
	testBucket = "drive"
	testAccess = "test-access"
	testSecret = "test-secret"
)

// client is the deployment's own S3 client, so these tests prove the server
// speaks what production sends.
func start(t *testing.T, secret string) (*filestore.S3Backend, string) {
	t.Helper()
	dir := t.TempDir()
	srv, err := objectserver.New(objectserver.Config{Dir: dir, Bucket: testBucket, AccessKeyID: testAccess, SecretAccessKey: testSecret})
	if err != nil {
		t.Fatal(err)
	}
	ts := httptest.NewServer(srv)
	t.Cleanup(ts.Close)
	backend, err := filestore.NewS3Backend(filestore.S3Config{
		Bucket: testBucket, Endpoint: ts.URL, AccessKeyID: testAccess, SecretAccessKey: secret, PathStyle: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	return backend, dir
}

func TestRoundTripSmallAndMultipart(t *testing.T) {
	backend, _ := start(t, testSecret)
	ctx := context.Background()
	big := make([]byte, 33<<20) // two full 16 MiB parts and a remainder
	if _, err := rand.Read(big); err != nil {
		t.Fatal(err)
	}
	for name, payload := range map[string][]byte{
		"artifacts/space-1/small": []byte("hello drive"),
		"artifacts/space-1/empty": {},
		"artifacts/space-1/big":   big,
	} {
		if err := backend.Put(ctx, name, bytes.NewReader(payload)); err != nil {
			t.Fatalf("put %s: %v", name, err)
		}
		size, err := backend.Head(ctx, name)
		if err != nil || size != int64(len(payload)) {
			t.Fatalf("head %s = %d, %v; want %d", name, size, err, len(payload))
		}
		rc, total, err := backend.GetRange(ctx, name, 0, -1)
		if err != nil || total != int64(len(payload)) {
			t.Fatalf("get %s: total %d, %v", name, total, err)
		}
		got, _ := io.ReadAll(rc)
		_ = rc.Close()
		if !bytes.Equal(got, payload) {
			t.Fatalf("get %s: body differs", name)
		}
	}
}

func TestRangeAndMissing(t *testing.T) {
	backend, _ := start(t, testSecret)
	ctx := context.Background()
	if err := backend.Put(ctx, "k/a b+c", bytes.NewReader([]byte("0123456789"))); err != nil {
		t.Fatal(err)
	}
	rc, total, err := backend.GetRange(ctx, "k/a b+c", 2, 5)
	if err != nil || total != 10 {
		t.Fatalf("range: total %d, %v", total, err)
	}
	got, _ := io.ReadAll(rc)
	_ = rc.Close()
	if string(got) != "2345" {
		t.Fatalf("range body = %q", got)
	}
	if _, _, err := backend.GetRange(ctx, "k/a b+c", 20, 30); !errors.Is(err, filestore.ErrInvalidRange) {
		t.Fatalf("out-of-range = %v, want ErrInvalidRange", err)
	}
	if _, err := backend.Head(ctx, "nope"); !errors.Is(err, filestore.ErrNotFound) {
		t.Fatalf("head missing = %v, want ErrNotFound", err)
	}
	if _, _, err := backend.GetRange(ctx, "nope", 0, -1); !errors.Is(err, filestore.ErrNotFound) {
		t.Fatalf("get missing = %v, want ErrNotFound", err)
	}
}

func TestDeleteIsIdempotent(t *testing.T) {
	backend, _ := start(t, testSecret)
	ctx := context.Background()
	if err := backend.Put(ctx, "gone", bytes.NewReader([]byte("x"))); err != nil {
		t.Fatal(err)
	}
	for range 2 {
		if err := backend.Delete(ctx, "gone"); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := backend.Head(ctx, "gone"); !errors.Is(err, filestore.ErrNotFound) {
		t.Fatalf("head after delete = %v", err)
	}
}

func TestWrongSecretIsRejected(t *testing.T) {
	backend, _ := start(t, "not-the-secret")
	err := backend.Put(context.Background(), "k", bytes.NewReader([]byte("x")))
	if err == nil {
		t.Fatal("put with a wrong secret succeeded")
	}
}
