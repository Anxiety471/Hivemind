package contentcrypto

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"testing"
)

func testDataKey(spaceID string) DataKey {
	key := make([]byte, 32)
	for i := range key {
		key[i] = byte(i + 1)
	}
	return DataKey{
		ID:      "key-v1",
		SpaceID: spaceID,
		Version: 1,
		Key:     key,
	}
}

func deterministicPattern(n int) []byte {
	out := make([]byte, n)
	for i := range out {
		out[i] = byte((i*131 + i/257) & 0xff)
	}
	return out
}

func TestSealAndOpenArtifactBoundaries(t *testing.T) {
	ctx := context.Background()
	key := testDataKey("space-1")
	lookup := func(_ context.Context, keyID string) (DataKey, error) {
		if keyID == key.ID {
			return key, nil
		}
		return DataKey{}, ErrSpaceKeyMissing
	}

	sizes := []int{
		0,
		1,
		100,
		ArtifactChunkSize - 1,
		ArtifactChunkSize,
		ArtifactChunkSize + 1,
		2*ArtifactChunkSize - 1,
		2 * ArtifactChunkSize,
		2*ArtifactChunkSize + 17,
	}

	for _, size := range sizes {
		plain := deterministicPattern(size)
		sealed, sum, err := SealArtifactBytes(plain, key, "space-1", "file-1")
		if err != nil {
			t.Fatalf("size %d: SealArtifactBytes failed: %v", size, err)
		}
		if !IsSealedArtifact(sealed) {
			t.Fatalf("size %d: expected RKZA magic", size)
		}
		wantHash := sha256.Sum256(plain)
		if sum != hex.EncodeToString(wantHash[:]) {
			t.Fatalf("size %d: hash mismatch: got %s", size, sum)
		}

		hdr, hdrLen, err := ParseArtifactHeaderBytes(sealed)
		if err != nil {
			t.Fatalf("size %d: ParseArtifactHeaderBytes failed: %v", size, err)
		}
		if hdr.KeyID != key.ID {
			t.Fatalf("size %d: keyID = %q", size, hdr.KeyID)
		}
		if gotSealed := SealedArtifactSize(int64(size), hdrLen); gotSealed != int64(len(sealed)) {
			t.Fatalf("size %d: SealedArtifactSize = %d, want %d", size, gotSealed, len(sealed))
		}
		gotPlainSize, err := hdr.PlainSize(int64(len(sealed)))
		if err != nil || gotPlainSize != int64(size) {
			t.Fatalf("size %d: PlainSize = (%d, %v), want %d", size, gotPlainSize, err, size)
		}

		var opened bytes.Buffer
		n, err := OpenArtifact(ctx, &opened, bytes.NewReader(sealed), lookup, "space-1", "file-1")
		if err != nil {
			t.Fatalf("size %d: OpenArtifact failed: %v", size, err)
		}
		if n != int64(size) || !bytes.Equal(opened.Bytes(), plain) {
			t.Fatalf("size %d: content mismatch (n=%d)", size, n)
		}
	}
}

func TestOpenArtifactRangeReaderAcrossSegments(t *testing.T) {
	ctx := context.Background()
	key := testDataKey("space-1")
	plain := deterministicPattern(2*ArtifactChunkSize + 500)
	sealed, _, err := SealArtifactBytes(plain, key, "space-1", "file-range")
	if err != nil {
		t.Fatalf("seal failed: %v", err)
	}
	hdr, _, err := ParseArtifactHeaderBytes(sealed)
	if err != nil {
		t.Fatalf("header parse failed: %v", err)
	}

	openRange := func(_ context.Context, start, endInclusive int64) (io.ReadCloser, error) {
		return io.NopCloser(bytes.NewReader(sealed[start : endInclusive+1])), nil
	}

	ranges := [][2]int64{
		{0, 0},
		{0, 1023},
		{ArtifactChunkSize - 10, ArtifactChunkSize + 20},
		{ArtifactChunkSize, 2*ArtifactChunkSize - 1},
		{ArtifactChunkSize + 7, int64(len(plain)) - 1},
		{int64(len(plain)) - 1, int64(len(plain)) - 1},
		{0, int64(len(plain)) - 1},
	}

	for _, r := range ranges {
		rc, err := OpenArtifactRangeReader(ctx, hdr, key, "space-1", "file-range", int64(len(sealed)), r[0], r[1], openRange)
		if err != nil {
			t.Fatalf("range [%d,%d]: open failed: %v", r[0], r[1], err)
		}
		got, err := io.ReadAll(rc)
		_ = rc.Close()
		if err != nil {
			t.Fatalf("range [%d,%d]: read failed: %v", r[0], r[1], err)
		}
		want := plain[r[0] : r[1]+1]
		if !bytes.Equal(got, want) {
			t.Fatalf("range [%d,%d]: got %d bytes, want %d bytes", r[0], r[1], len(got), len(want))
		}
	}

	// Empty sealed file range authentication.
	emptySealed, _, err := SealArtifactBytes(nil, key, "space-1", "empty")
	if err != nil {
		t.Fatalf("empty seal failed: %v", err)
	}
	emptyHdr, _, err := ParseArtifactHeaderBytes(emptySealed)
	if err != nil {
		t.Fatalf("empty hdr failed: %v", err)
	}
	rc, err := OpenArtifactRangeReader(ctx, emptyHdr, key, "space-1", "empty", int64(len(emptySealed)), 0, -1,
		func(_ context.Context, start, endInclusive int64) (io.ReadCloser, error) {
			return io.NopCloser(bytes.NewReader(emptySealed[start : endInclusive+1])), nil
		})
	if err != nil {
		t.Fatalf("empty range reader failed: %v", err)
	}
	got, err := io.ReadAll(rc)
	_ = rc.Close()
	if err != nil || len(got) != 0 {
		t.Fatalf("empty range read = (%d, %v)", len(got), err)
	}
}

func TestArtifactCryptoRejectsTamperWrongSpaceWrongFile(t *testing.T) {
	ctx := context.Background()
	key := testDataKey("space-1")
	lookup := func(_ context.Context, _ string) (DataKey, error) { return key, nil }

	plain := deterministicPattern(ArtifactChunkSize + 123)
	sealed, _, err := SealArtifactBytes(plain, key, "space-1", "file-1")
	if err != nil {
		t.Fatalf("seal failed: %v", err)
	}

	// Wrong file id.
	var out bytes.Buffer
	if _, err := OpenArtifact(ctx, &out, bytes.NewReader(sealed), lookup, "space-1", "other-file"); !errors.Is(err, ErrDecryption) {
		t.Fatalf("expected ErrDecryption for wrong fileID, got %v", err)
	}

	// Wrong space id: key belongs to space-1, caller opens as space-2.
	if _, err := OpenArtifact(ctx, &out, bytes.NewReader(sealed), lookup, "space-2", "file-1"); !errors.Is(err, ErrAnotherSpace) {
		t.Fatalf("expected ErrAnotherSpace, got %v", err)
	}
	// Wrong space id even when another space supplies matching raw key bytes: AAD rejects.
	otherKey := testDataKey("space-2")
	if _, err := OpenArtifact(ctx, &out, bytes.NewReader(sealed), func(_ context.Context, _ string) (DataKey, error) { return otherKey, nil }, "space-2", "file-1"); !errors.Is(err, ErrDecryption) {
		t.Fatalf("expected ErrDecryption for forged space AAD, got %v", err)
	}

	// Truncated after first full segment (missing trailing final tag).
	hdr, hdrLen, _ := ParseArtifactHeaderBytes(sealed)
	truncatedAfterSeg0 := sealed[:hdrLen+ArtifactSealedChunkSize]
	if _, err := OpenArtifact(ctx, &out, bytes.NewReader(truncatedAfterSeg0), lookup, "space-1", "file-1"); !errors.Is(err, ErrDecryption) {
		t.Fatalf("expected ErrDecryption for missing final segment, got %v", err)
	}
	if _, err := hdr.PlainSize(int64(len(truncatedAfterSeg0))); !errors.Is(err, ErrDecryption) {
		t.Fatalf("expected PlainSize ErrDecryption for zero trailing bytes, got %v", err)
	}

	// Bit flip in final segment detected by range reader.
	corrupted := append([]byte(nil), sealed...)
	corrupted[len(corrupted)-5] ^= 0xff
	rc, err := OpenArtifactRangeReader(ctx, hdr, key, "space-1", "file-1", int64(len(corrupted)), ArtifactChunkSize+10, ArtifactChunkSize+20,
		func(_ context.Context, start, endInclusive int64) (io.ReadCloser, error) {
			return io.NopCloser(bytes.NewReader(corrupted[start : endInclusive+1])), nil
		})
	if err != nil {
		t.Fatalf("unexpected open error: %v", err)
	}
	if _, err := io.ReadAll(rc); !errors.Is(err, ErrDecryption) {
		t.Fatalf("expected ErrDecryption on bit flip, got %v", err)
	}
	_ = rc.Close()

	// Exact TypeScript-compatible binary header layout check.
	var prefix [ArtifactNoncePrefixBytes]byte
	_, _ = rand.Read(prefix[:])
	raw, err := BuildArtifactHeader("k123", prefix)
	if err != nil || string(raw[:5]) != "RKZA\x01" || raw[5] != 4 || string(raw[6:10]) != "k123" || !bytes.Equal(raw[10:], prefix[:]) {
		t.Fatalf("unexpected header layout: %x (%v)", raw, err)
	}
}
