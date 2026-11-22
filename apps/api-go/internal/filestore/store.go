package filestore

import (
	"bytes"
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"io"
	"strings"
)

var (
	// ErrNotFound reports a missing stored blob.
	ErrNotFound = errors.New("stored artifact not found")
	// ErrInvalidID reports an unsafe or malformed storage identifier.
	ErrInvalidID = errors.New("invalid artifact storage key")
	// ErrInvalidRange reports an out-of-bounds plaintext byte range.
	ErrInvalidRange = errors.New("invalid byte range")
)

// StoredBlob describes the result of storing a file stream.
type StoredBlob struct {
	ID        string
	Hash      string
	SizeBytes int64
}

// ByteRange is an inclusive plaintext byte interval [Start, EndInclusive].
type ByteRange struct {
	Start        int64
	EndInclusive int64
}

// Store persists and streams artifact blobs with optional RKZA v1 sealing.
type Store interface {
	PutStream(ctx context.Context, spaceID string, src io.Reader) (StoredBlob, error)
	OpenStream(ctx context.Context, spaceID, id string, byteRange *ByteRange) (io.ReadCloser, int64, error)
	Stat(ctx context.Context, spaceID, id string) (int64, error)
	Remove(ctx context.Context, spaceID, id string) error
}

// PutBytes is a convenience helper around PutStream for small in-memory payloads.
func PutBytes(ctx context.Context, store Store, spaceID string, data []byte) (StoredBlob, error) {
	return store.PutStream(ctx, spaceID, bytes.NewReader(data))
}

// ReadAll reads an entire stored artifact into memory.
func ReadAll(ctx context.Context, store Store, spaceID, id string) ([]byte, error) {
	rc, _, err := store.OpenStream(ctx, spaceID, id, nil)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rc.Close() }()
	return io.ReadAll(rc)
}

func validateSegment(s string) error {
	if s == "" || len(s) > 128 || s == "." || s == ".." {
		return ErrInvalidID
	}
	if strings.ContainsAny(s, `/\:`) {
		return ErrInvalidID
	}
	for i := 0; i < len(s); i++ {
		if s[i] < 0x20 || s[i] == 0x7f {
			return ErrInvalidID
		}
	}
	return nil
}

func validateRange(byteRange *ByteRange, totalSize int64) (int64, int64, error) {
	if byteRange == nil {
		if totalSize == 0 {
			return 0, -1, nil
		}
		return 0, totalSize - 1, nil
	}
	if totalSize == 0 || byteRange.Start < 0 || byteRange.EndInclusive < byteRange.Start || byteRange.EndInclusive >= totalSize {
		return 0, 0, ErrInvalidRange
	}
	return byteRange.Start, byteRange.EndInclusive, nil
}

func newUUID() (string, error) {
	var b [16]byte
	if _, err := io.ReadFull(rand.Reader, b[:]); err != nil {
		return "", fmt.Errorf("uuid entropy: %w", err)
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x",
		b[0:4], b[4:6], b[6:8], b[8:10], b[10:16]), nil
}
