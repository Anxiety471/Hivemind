package filestore

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"syscall"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/contentcrypto"
)

// LocalStore stores artifacts under <root>/artifacts/<spaceId>/<id>, matching
// LocalArtifactStore in packages/adapters/src/storage/artifacts.ts.
type LocalStore struct {
	root string
	keys *contentcrypto.KeyRing
}

// NewLocalStore returns a LocalStore rooted at dataDir.
func NewLocalStore(dataDir string, keys *contentcrypto.KeyRing) *LocalStore {
	if strings.TrimSpace(dataDir) == "" {
		dataDir = "./data"
	}
	return &LocalStore{root: dataDir, keys: keys}
}

func (s *LocalStore) blobPath(spaceID, id string) (string, error) {
	if err := validateSegment(spaceID); err != nil {
		return "", err
	}
	if err := validateSegment(id); err != nil {
		return "", err
	}
	return filepath.Join(s.root, "artifacts", spaceID, id), nil
}

// PutStream writes src atomically with mode 0o600, sealing in RKZA v1 when
// encryption writes are active.
func (s *LocalStore) PutStream(ctx context.Context, spaceID string, src io.Reader) (StoredBlob, error) {
	if err := validateSegment(spaceID); err != nil {
		return StoredBlob{}, err
	}
	id, err := newUUID()
	if err != nil {
		return StoredBlob{}, err
	}
	dstPath, err := s.blobPath(spaceID, id)
	if err != nil {
		return StoredBlob{}, err
	}
	dir := filepath.Dir(dstPath)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return StoredBlob{}, err
	}
	suffix, err := newUUID()
	if err != nil {
		return StoredBlob{}, err
	}
	tmpPath := filepath.Join(dir, "."+id+".tmp-"+suffix)
	f, err := os.OpenFile(tmpPath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return StoredBlob{}, err
	}
	cleanup := true
	defer func() {
		if f != nil {
			_ = f.Close()
		}
		if cleanup {
			_ = os.Remove(tmpPath)
		}
	}()

	var plainBytes int64
	var hashHex string

	if s.keys != nil && s.keys.EncryptWrites {
		key, err := s.keys.Current(ctx, spaceID)
		if err != nil {
			return StoredBlob{}, err
		}
		plainBytes, _, hashHex, err = contentcrypto.SealArtifact(f, src, key, spaceID, id)
		if err != nil {
			return StoredBlob{}, err
		}
	} else {
		hasher := sha256.New()
		n, err := io.Copy(f, io.TeeReader(src, hasher))
		if err != nil {
			return StoredBlob{}, err
		}
		plainBytes = n
		hashHex = hex.EncodeToString(hasher.Sum(nil))
	}

	if err := f.Sync(); err != nil {
		return StoredBlob{}, err
	}
	if err := f.Close(); err != nil {
		f = nil
		return StoredBlob{}, err
	}
	f = nil
	if err := os.Chmod(tmpPath, 0o600); err != nil {
		return StoredBlob{}, err
	}
	if err := os.Rename(tmpPath, dstPath); err != nil {
		return StoredBlob{}, err
	}
	cleanup = false
	return StoredBlob{ID: id, Hash: hashHex, SizeBytes: plainBytes}, nil
}

func openNoFollow(path string) (*os.File, os.FileInfo, error) {
	fd, err := syscall.Open(path, syscall.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) || errors.Is(err, syscall.ENOENT) {
			return nil, nil, ErrNotFound
		}
		return nil, nil, err
	}
	f := os.NewFile(uintptr(fd), path)
	info, err := f.Stat()
	if err != nil {
		_ = f.Close()
		return nil, nil, err
	}
	if info.IsDir() {
		_ = f.Close()
		return nil, nil, ErrInvalidID
	}
	return f, info, nil
}

// Stat returns the plaintext byte size of a stored artifact.
func (s *LocalStore) Stat(ctx context.Context, spaceID, id string) (int64, error) {
	path, err := s.blobPath(spaceID, id)
	if err != nil {
		return 0, err
	}
	f, info, err := openNoFollow(path)
	if err != nil {
		return 0, err
	}
	defer func() { _ = f.Close() }()

	var magic [5]byte
	n, err := io.ReadFull(f, magic[:])
	if err != nil && !errors.Is(err, io.EOF) && !errors.Is(err, io.ErrUnexpectedEOF) {
		return 0, err
	}
	if !contentcrypto.IsSealedArtifact(magic[:n]) {
		return info.Size(), nil
	}
	if s.keys == nil {
		return 0, contentcrypto.ErrDecryption
	}
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		return 0, err
	}
	hdr, err := contentcrypto.ParseArtifactHeader(f)
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
	return hdr.PlainSize(info.Size())
}

// OpenStream opens a plaintext streaming reader (optionally sliced to byteRange)
// and returns the stream and full plaintext file length.
func (s *LocalStore) OpenStream(ctx context.Context, spaceID, id string, byteRange *ByteRange) (io.ReadCloser, int64, error) {
	path, err := s.blobPath(spaceID, id)
	if err != nil {
		return nil, 0, err
	}
	f, info, err := openNoFollow(path)
	if err != nil {
		return nil, 0, err
	}
	closeOnErr := true
	defer func() {
		if closeOnErr {
			_ = f.Close()
		}
	}()

	var magic [5]byte
	n, err := io.ReadFull(f, magic[:])
	if err != nil && !errors.Is(err, io.EOF) && !errors.Is(err, io.ErrUnexpectedEOF) {
		return nil, 0, err
	}

	if !contentcrypto.IsSealedArtifact(magic[:n]) {
		plainSize := info.Size()
		start, end, err := validateRange(byteRange, plainSize)
		if err != nil {
			return nil, 0, err
		}
		if plainSize == 0 {
			return io.NopCloser(bytes.NewReader(nil)), 0, nil
		}
		sr := io.NewSectionReader(f, start, end-start+1)
		closeOnErr = false
		return &fileSectionReadCloser{file: f, reader: sr}, plainSize, nil
	}

	if s.keys == nil {
		return nil, 0, contentcrypto.ErrDecryption
	}
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		return nil, 0, err
	}
	hdr, err := contentcrypto.ParseArtifactHeader(f)
	if err != nil {
		return nil, 0, err
	}
	diskSize := info.Size()
	plainSize, err := hdr.PlainSize(diskSize)
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
	rc, err := contentcrypto.OpenArtifactRangeReader(
		ctx,
		hdr,
		key,
		spaceID,
		id,
		diskSize,
		start,
		end,
		func(_ context.Context, sealedStart, sealedEndInclusive int64) (io.ReadCloser, error) {
			return io.NopCloser(io.NewSectionReader(f, sealedStart, sealedEndInclusive-sealedStart+1)), nil
		},
	)
	if err != nil {
		return nil, 0, err
	}
	closeOnErr = false
	return &wrappedReadCloser{ReadCloser: rc, closer: f}, plainSize, nil
}

// Remove deletes a stored file on disk if present.
func (s *LocalStore) Remove(_ context.Context, spaceID, id string) error {
	path, err := s.blobPath(spaceID, id)
	if err != nil {
		return err
	}
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

type fileSectionReadCloser struct {
	file   *os.File
	reader *io.SectionReader
}

func (f *fileSectionReadCloser) Read(p []byte) (int, error) {
	return f.reader.Read(p)
}

func (f *fileSectionReadCloser) Close() error {
	return f.file.Close()
}

type wrappedReadCloser struct {
	io.ReadCloser
	closer io.Closer
}

func (w *wrappedReadCloser) Close() error {
	err1 := w.ReadCloser.Close()
	err2 := w.closer.Close()
	if err1 != nil {
		return err1
	}
	return err2
}
