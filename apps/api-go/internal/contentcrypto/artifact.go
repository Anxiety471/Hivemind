package contentcrypto

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
)

const (
	// ArtifactMagic identifies a streaming-sealed file in the RKZA v1 format
	// (packages/db/src/encryption/content-crypto.ts).
	ArtifactMagic = "RKZA\x01"
	// ArtifactChunkSize is the plaintext segment size in bytes (64 KiB).
	ArtifactChunkSize = 64 * 1024
	// ArtifactTagBytes is the AES-256-GCM authentication tag length.
	ArtifactTagBytes = 16
	// ArtifactSealedChunkSize is the sealed size of one full 64 KiB segment.
	ArtifactSealedChunkSize = ArtifactChunkSize + ArtifactTagBytes
	// ArtifactNoncePrefixBytes is the per-file random nonce prefix size.
	ArtifactNoncePrefixBytes = 8
)

var artifactMagicBytes = []byte(ArtifactMagic)

// KeyLookupFunc looks up a DataKey by its database id.
type KeyLookupFunc func(ctx context.Context, keyID string) (DataKey, error)

// ArtifactHeader is the decoded RKZA v1 header at the start of a sealed file.
type ArtifactHeader struct {
	KeyID       string
	NoncePrefix [ArtifactNoncePrefixBytes]byte
	Raw         []byte
}

// IsSealedArtifact reports whether prefix starts with the RKZA v1 magic bytes.
func IsSealedArtifact(prefix []byte) bool {
	return len(prefix) >= len(artifactMagicBytes) && bytes.Equal(prefix[:len(artifactMagicBytes)], artifactMagicBytes)
}

// BuildArtifactHeader encodes a valid RKZA v1 file header.
func BuildArtifactHeader(keyID string, noncePrefix [ArtifactNoncePrefixBytes]byte) ([]byte, error) {
	if len(keyID) == 0 || len(keyID) > 255 {
		return nil, fmt.Errorf("%w: invalid space key id length %d", ErrDecryption, len(keyID))
	}
	raw := make([]byte, len(artifactMagicBytes)+1+len(keyID)+ArtifactNoncePrefixBytes)
	pos := copy(raw, artifactMagicBytes)
	raw[pos] = byte(len(keyID))
	pos++
	pos += copy(raw[pos:], keyID)
	copy(raw[pos:], noncePrefix[:])
	return raw, nil
}

// ParseArtifactHeader reads and validates an RKZA v1 header from r.
func ParseArtifactHeader(r io.Reader) (ArtifactHeader, error) {
	var prefix [6]byte
	if _, err := io.ReadFull(r, prefix[:]); err != nil {
		if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) {
			return ArtifactHeader{}, ErrDecryption
		}
		return ArtifactHeader{}, err
	}
	if !bytes.Equal(prefix[:len(artifactMagicBytes)], artifactMagicBytes) {
		return ArtifactHeader{}, ErrDecryption
	}
	keyLen := int(prefix[5])
	if keyLen == 0 {
		return ArtifactHeader{}, ErrDecryption
	}
	rest := make([]byte, keyLen+ArtifactNoncePrefixBytes)
	if _, err := io.ReadFull(r, rest); err != nil {
		if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) {
			return ArtifactHeader{}, ErrDecryption
		}
		return ArtifactHeader{}, err
	}
	raw := make([]byte, len(prefix)+len(rest))
	copy(raw, prefix[:])
	copy(raw[len(prefix):], rest)
	var noncePrefix [ArtifactNoncePrefixBytes]byte
	copy(noncePrefix[:], rest[keyLen:])
	return ArtifactHeader{
		KeyID:       string(rest[:keyLen]),
		NoncePrefix: noncePrefix,
		Raw:         raw,
	}, nil
}

// ParseArtifactHeaderBytes parses an RKZA v1 header from an in-memory byte slice,
// returning the decoded header and its byte length.
func ParseArtifactHeaderBytes(b []byte) (ArtifactHeader, int, error) {
	if len(b) < len(artifactMagicBytes)+1 {
		return ArtifactHeader{}, 0, ErrDecryption
	}
	if !IsSealedArtifact(b) {
		return ArtifactHeader{}, 0, ErrDecryption
	}
	keyLen := int(b[len(artifactMagicBytes)])
	headerLen := len(artifactMagicBytes) + 1 + keyLen + ArtifactNoncePrefixBytes
	if keyLen == 0 || len(b) < headerLen {
		return ArtifactHeader{}, 0, ErrDecryption
	}
	raw := make([]byte, headerLen)
	copy(raw, b[:headerLen])
	var noncePrefix [ArtifactNoncePrefixBytes]byte
	copy(noncePrefix[:], raw[headerLen-ArtifactNoncePrefixBytes:headerLen])
	keyID := string(raw[len(artifactMagicBytes)+1 : len(artifactMagicBytes)+1+keyLen])
	return ArtifactHeader{
		KeyID:       keyID,
		NoncePrefix: noncePrefix,
		Raw:         raw,
	}, headerLen, nil
}

// HeaderLen returns the encoded header byte length.
func (h ArtifactHeader) HeaderLen() int {
	return len(h.Raw)
}

// PlainSize computes the exact unencrypted payload length in O(1) from the
// sealed file length. Returns ErrDecryption when sealedSize violates framing.
func (h ArtifactHeader) PlainSize(sealedSize int64) (int64, error) {
	payload := sealedSize - int64(len(h.Raw))
	if payload < ArtifactTagBytes {
		return 0, ErrDecryption
	}
	fullSegs := payload / ArtifactSealedChunkSize
	lastSegSealed := payload % ArtifactSealedChunkSize
	if lastSegSealed < ArtifactTagBytes {
		return 0, ErrDecryption
	}
	return fullSegs*ArtifactChunkSize + (lastSegSealed - ArtifactTagBytes), nil
}

// SealedArtifactSize computes the sealed size of a plainSize-byte file.
func SealedArtifactSize(plainSize int64, headerLen int) int64 {
	if plainSize < 0 {
		return 0
	}
	finalSeg := plainSize / ArtifactChunkSize
	return int64(headerLen) + plainSize + (finalSeg+1)*ArtifactTagBytes
}

// ArtifactAAD constructs the per-segment AAD bound to header, Space, file id, and final flag.
func ArtifactAAD(rawHeader []byte, spaceID, fileID string, final bool) []byte {
	aad := make([]byte, 0, len(rawHeader)+len(spaceID)+len(fileID)+4)
	aad = append(aad, rawHeader...)
	aad = append(aad, 0)
	aad = append(aad, spaceID...)
	aad = append(aad, 0)
	aad = append(aad, fileID...)
	aad = append(aad, 0)
	if final {
		aad = append(aad, 1)
	} else {
		aad = append(aad, 0)
	}
	return aad
}

func makeSegmentNonce(prefix [ArtifactNoncePrefixBytes]byte, counter uint32) []byte {
	var nonce [ArtifactNoncePrefixBytes + 4]byte
	copy(nonce[:ArtifactNoncePrefixBytes], prefix[:])
	binary.BigEndian.PutUint32(nonce[ArtifactNoncePrefixBytes:], counter)
	return nonce[:]
}

func newArtifactGCM(key DataKey) (cipher.AEAD, error) {
	if len(key.Key) != 32 {
		return nil, fmt.Errorf("%w: unexpected space key length %d", ErrDecryption, len(key.Key))
	}
	block, err := aes.NewCipher(key.Key)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}

// SealArtifact streams plaintext from src, encrypts it in 64 KiB RKZA v1
// segments bound to spaceID and fileID, writes the sealed stream to dst, and
// returns plaintext byte count, sealed byte count, and lowercase hex SHA-256 of
// the plaintext.
func SealArtifact(dst io.Writer, src io.Reader, key DataKey, spaceID, fileID string) (int64, int64, string, error) {
	if key.SpaceID != "" && key.SpaceID != spaceID {
		return 0, 0, "", ErrAnotherSpace
	}
	gcm, err := newArtifactGCM(key)
	if err != nil {
		return 0, 0, "", err
	}
	var noncePrefix [ArtifactNoncePrefixBytes]byte
	if _, err := io.ReadFull(rand.Reader, noncePrefix[:]); err != nil {
		return 0, 0, "", fmt.Errorf("artifact nonce: %w", err)
	}
	rawHeader, err := BuildArtifactHeader(key.ID, noncePrefix)
	if err != nil {
		return 0, 0, "", err
	}
	if _, err := dst.Write(rawHeader); err != nil {
		return 0, 0, "", err
	}

	aadNonFinal := ArtifactAAD(rawHeader, spaceID, fileID, false)
	aadFinal := ArtifactAAD(rawHeader, spaceID, fileID, true)
	hasher := sha256.New()
	tee := io.TeeReader(src, hasher)

	plainBuf := make([]byte, ArtifactChunkSize)
	sealedBuf := make([]byte, 0, ArtifactSealedChunkSize)
	var plainTotal int64
	sealedTotal := int64(len(rawHeader))
	var counter uint32

	for {
		n, readErr := io.ReadFull(tee, plainBuf)
		if readErr != nil && !errors.Is(readErr, io.EOF) && !errors.Is(readErr, io.ErrUnexpectedEOF) {
			return plainTotal, sealedTotal, "", readErr
		}
		plainTotal += int64(n)
		isFinal := errors.Is(readErr, io.EOF) || errors.Is(readErr, io.ErrUnexpectedEOF)
		aad := aadNonFinal
		if isFinal {
			aad = aadFinal
		}
		nonce := makeSegmentNonce(noncePrefix, counter)
		sealedBuf = gcm.Seal(sealedBuf[:0], nonce, plainBuf[:n], aad)
		if _, err := dst.Write(sealedBuf); err != nil {
			return plainTotal, sealedTotal, "", err
		}
		sealedTotal += int64(len(sealedBuf))
		if isFinal {
			break
		}
		if counter == ^uint32(0) {
			return plainTotal, sealedTotal, "", fmt.Errorf("%w: artifact exceeds max segment count", ErrDecryption)
		}
		counter++
	}
	return plainTotal, sealedTotal, hex.EncodeToString(hasher.Sum(nil)), nil
}

// SealArtifactBytes encrypts an in-memory slice in RKZA v1 format and returns
// the sealed bytes and lowercase hex plaintext SHA-256.
func SealArtifactBytes(plain []byte, key DataKey, spaceID, fileID string) ([]byte, string, error) {
	var out bytes.Buffer
	out.Grow(int(SealedArtifactSize(int64(len(plain)), len(artifactMagicBytes)+1+len(key.ID)+ArtifactNoncePrefixBytes)))
	_, _, sum, err := SealArtifact(&out, bytes.NewReader(plain), key, spaceID, fileID)
	if err != nil {
		return nil, "", err
	}
	return out.Bytes(), sum, nil
}

// OpenArtifact streams an RKZA v1 payload from src, authenticates every segment
// and the trailing final marker, and writes plaintext to dst.
func OpenArtifact(ctx context.Context, dst io.Writer, src io.Reader, lookup KeyLookupFunc, spaceID, fileID string) (int64, error) {
	hdr, err := ParseArtifactHeader(src)
	if err != nil {
		return 0, err
	}
	key, err := lookup(ctx, hdr.KeyID)
	if err != nil {
		return 0, err
	}
	if key.SpaceID != spaceID {
		return 0, ErrAnotherSpace
	}
	gcm, err := newArtifactGCM(key)
	if err != nil {
		return 0, err
	}

	aadNonFinal := ArtifactAAD(hdr.Raw, spaceID, fileID, false)
	aadFinal := ArtifactAAD(hdr.Raw, spaceID, fileID, true)
	sealedBuf := make([]byte, ArtifactSealedChunkSize)
	plainBuf := make([]byte, 0, ArtifactChunkSize)
	var plainTotal int64
	var counter uint32

	for {
		n, readErr := io.ReadFull(src, sealedBuf)
		if readErr != nil && !errors.Is(readErr, io.EOF) && !errors.Is(readErr, io.ErrUnexpectedEOF) {
			return plainTotal, readErr
		}
		if errors.Is(readErr, io.EOF) && n == 0 {
			// A valid stream ends with a final segment of size [ArtifactTagBytes, ArtifactSealedChunkSize).
			return plainTotal, ErrDecryption
		}
		isFinal := errors.Is(readErr, io.EOF) || errors.Is(readErr, io.ErrUnexpectedEOF)
		if n < ArtifactTagBytes {
			return plainTotal, ErrDecryption
		}
		aad := aadNonFinal
		if isFinal {
			aad = aadFinal
		}
		nonce := makeSegmentNonce(hdr.NoncePrefix, counter)
		decrypted, err := gcm.Open(plainBuf[:0], nonce, sealedBuf[:n], aad)
		if err != nil {
			return plainTotal, ErrDecryption
		}
		plainBuf = decrypted
		if len(decrypted) > 0 {
			if _, err := dst.Write(decrypted); err != nil {
				return plainTotal, err
			}
			plainTotal += int64(len(decrypted))
		}
		if isFinal {
			return plainTotal, nil
		}
		if counter == ^uint32(0) {
			return plainTotal, ErrDecryption
		}
		counter++
	}
}

// OpenArtifactRangeReader returns a streaming io.ReadCloser yielding plaintext
// bytes [plainStart, plainEndInclusive] from a random-access RKZA v1 blob of
// total length sealedSize.
//
// For zero-length plaintext files, call with plainStart == 0 and
// plainEndInclusive == -1; it authenticates the trailing empty segment before
// returning an empty reader.
func OpenArtifactRangeReader(
	ctx context.Context,
	hdr ArtifactHeader,
	key DataKey,
	spaceID, fileID string,
	sealedSize int64,
	plainStart, plainEndInclusive int64,
	openSealedRange func(ctx context.Context, sealedStart, sealedEndInclusive int64) (io.ReadCloser, error),
) (io.ReadCloser, error) {
	if key.SpaceID != spaceID {
		return nil, ErrAnotherSpace
	}
	gcm, err := newArtifactGCM(key)
	if err != nil {
		return nil, err
	}
	plainSize, err := hdr.PlainSize(sealedSize)
	if err != nil {
		return nil, err
	}
	headerLen := int64(len(hdr.Raw))
	payloadSize := sealedSize - headerLen
	lastSeg := payloadSize / ArtifactSealedChunkSize
	lastSegSealedLen := payloadSize % ArtifactSealedChunkSize

	if plainSize == 0 {
		if plainStart != 0 || plainEndInclusive != -1 {
			return nil, fmt.Errorf("%w: empty range mismatch", ErrDecryption)
		}
		// Authenticate the empty final segment (16-byte tag) before reporting empty EOF.
		rc, err := openSealedRange(ctx, headerLen, sealedSize-1)
		if err != nil {
			return nil, err
		}
		tag := make([]byte, ArtifactTagBytes)
		_, readErr := io.ReadFull(rc, tag)
		_ = rc.Close()
		if readErr != nil {
			if errors.Is(readErr, io.EOF) || errors.Is(readErr, io.ErrUnexpectedEOF) {
				return nil, ErrDecryption
			}
			return nil, readErr
		}
		nonce := makeSegmentNonce(hdr.NoncePrefix, 0)
		aad := ArtifactAAD(hdr.Raw, spaceID, fileID, true)
		if _, err := gcm.Open(nil, nonce, tag, aad); err != nil {
			return nil, ErrDecryption
		}
		return io.NopCloser(bytes.NewReader(nil)), nil
	}

	if plainStart < 0 || plainEndInclusive < plainStart || plainEndInclusive >= plainSize {
		return nil, fmt.Errorf("invalid range [%d, %d] for size %d", plainStart, plainEndInclusive, plainSize)
	}

	startSeg := plainStart / ArtifactChunkSize
	endSeg := plainEndInclusive / ArtifactChunkSize
	if endSeg > lastSeg {
		return nil, ErrDecryption
	}

	sealedStart := headerLen + startSeg*ArtifactSealedChunkSize
	var sealedEndInclusive int64
	if endSeg == lastSeg {
		sealedEndInclusive = sealedSize - 1
	} else {
		sealedEndInclusive = headerLen + (endSeg+1)*ArtifactSealedChunkSize - 1
	}

	rc, err := openSealedRange(ctx, sealedStart, sealedEndInclusive)
	if err != nil {
		return nil, err
	}

	return &artifactRangeReader{
		src:              rc,
		hdr:              hdr,
		gcm:              gcm,
		aadNonFinal:      ArtifactAAD(hdr.Raw, spaceID, fileID, false),
		aadFinal:         ArtifactAAD(hdr.Raw, spaceID, fileID, true),
		startSeg:         startSeg,
		endSeg:           endSeg,
		lastSeg:          lastSeg,
		lastSegSealedLen: int(lastSegSealedLen),
		curSeg:           startSeg,
		firstOffset:      int(plainStart % ArtifactChunkSize),
		remaining:        plainEndInclusive - plainStart + 1,
		sealedBuf:        make([]byte, ArtifactSealedChunkSize),
		plainBuf:         make([]byte, 0, ArtifactChunkSize),
	}, nil
}

type artifactRangeReader struct {
	src              io.ReadCloser
	hdr              ArtifactHeader
	gcm              cipher.AEAD
	aadNonFinal      []byte
	aadFinal         []byte
	startSeg         int64
	endSeg           int64
	lastSeg          int64
	lastSegSealedLen int
	curSeg           int64
	firstOffset      int
	remaining        int64
	sealedBuf        []byte
	plainBuf         []byte
	unread           []byte
}

func (r *artifactRangeReader) Read(p []byte) (int, error) {
	for len(r.unread) == 0 {
		if r.remaining <= 0 || r.curSeg > r.endSeg {
			return 0, io.EOF
		}
		isFinal := r.curSeg == r.lastSeg
		needSealed := ArtifactSealedChunkSize
		if isFinal {
			needSealed = r.lastSegSealedLen
		}
		if _, err := io.ReadFull(r.src, r.sealedBuf[:needSealed]); err != nil {
			if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) {
				return 0, ErrDecryption
			}
			return 0, err
		}
		aad := r.aadNonFinal
		if isFinal {
			aad = r.aadFinal
		}
		nonce := makeSegmentNonce(r.hdr.NoncePrefix, uint32(r.curSeg))
		decrypted, err := r.gcm.Open(r.plainBuf[:0], nonce, r.sealedBuf[:needSealed], aad)
		if err != nil {
			return 0, ErrDecryption
		}
		r.plainBuf = decrypted

		slice := decrypted
		if r.curSeg == r.startSeg && r.firstOffset > 0 {
			if r.firstOffset > len(slice) {
				return 0, ErrDecryption
			}
			slice = slice[r.firstOffset:]
		}
		if int64(len(slice)) > r.remaining {
			slice = slice[:r.remaining]
		}
		r.unread = slice
		r.curSeg++
	}

	n := copy(p, r.unread)
	r.unread = r.unread[n:]
	r.remaining -= int64(n)
	return n, nil
}

func (r *artifactRangeReader) Close() error {
	return r.src.Close()
}
