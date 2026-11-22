package filestore

import (
	"context"
	"io"
	"strings"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/config"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/contentcrypto"
)

// DeploymentStore routes writes to ObjectStore when configured (falling back
// to LocalStore) and reads by `object:` id prefix so existing local files stay
// readable during object storage migration.
type DeploymentStore struct {
	local  *LocalStore
	remote Store
}

// NewDeploymentStore wires LocalStore and (when configured) ObjectStore.
func NewDeploymentStore(cfg config.Config, keys *contentcrypto.KeyRing) (*DeploymentStore, error) {
	local := NewLocalStore(cfg.DataDir, keys)
	var remote Store
	if cfg.ObjectStorage != nil {
		s3, err := NewS3Backend(S3Config{
			Bucket:          cfg.ObjectStorage.Bucket,
			Endpoint:        cfg.ObjectStorage.Endpoint,
			Region:          cfg.ObjectStorage.Region,
			AccessKeyID:     cfg.ObjectStorage.AccessKeyID,
			SecretAccessKey: cfg.ObjectStorage.SecretAccessKey,
			Prefix:          cfg.ObjectStorage.Prefix,
			PathStyle:       cfg.ObjectStorage.PathStyle,
		})
		if err != nil {
			return nil, err
		}
		obj, err := NewObjectStore(s3, keys)
		if err != nil {
			return nil, err
		}
		remote = obj
	}
	return &DeploymentStore{local: local, remote: remote}, nil
}

// NewDeploymentStoreWith stores custom local and remote backends (useful in tests).
func NewDeploymentStoreWith(local *LocalStore, remote Store) *DeploymentStore {
	return &DeploymentStore{local: local, remote: remote}
}

func (s *DeploymentStore) forID(id string) (Store, error) {
	if strings.HasPrefix(id, objectPrefixID) {
		if s.remote == nil {
			return nil, ErrObjectStorageMissing
		}
		return s.remote, nil
	}
	return s.local, nil
}

// PutStream writes new blobs to remote object storage when active, else local disk.
func (s *DeploymentStore) PutStream(ctx context.Context, spaceID string, src io.Reader) (StoredBlob, error) {
	if s.remote != nil {
		return s.remote.PutStream(ctx, spaceID, src)
	}
	return s.local.PutStream(ctx, spaceID, src)
}

// OpenStream reads id from its owning backend.
func (s *DeploymentStore) OpenStream(ctx context.Context, spaceID, id string, byteRange *ByteRange) (io.ReadCloser, int64, error) {
	backend, err := s.forID(id)
	if err != nil {
		return nil, 0, err
	}
	return backend.OpenStream(ctx, spaceID, id, byteRange)
}

// Stat returns the plaintext size of id from its owning backend.
func (s *DeploymentStore) Stat(ctx context.Context, spaceID, id string) (int64, error) {
	backend, err := s.forID(id)
	if err != nil {
		return 0, err
	}
	return backend.Stat(ctx, spaceID, id)
}

// Remove deletes id from its owning backend.
func (s *DeploymentStore) Remove(ctx context.Context, spaceID, id string) error {
	backend, err := s.forID(id)
	if err != nil {
		return err
	}
	return backend.Remove(ctx, spaceID, id)
}
