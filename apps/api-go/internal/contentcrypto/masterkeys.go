package contentcrypto

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

// MasterKey wraps space data keys (content-keys.ts:7-10).
type MasterKey struct {
	ID  string
	Key []byte
}

// DerivedMasterKeyID is the id of the key derived from ENCRYPTION_KEY, always
// available for unwrapping so deployments without explicit master keys work
// (content-keys.ts:12).
const DerivedMasterKeyID = "env"

var masterKeyIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,32}$`)

// MasterKeysFromEnv is masterKeysFromEnv (content-keys.ts:17-55): the explicit
// keys from ENCRYPTION_MASTER_KEYS ("id:key,older-id:key", active first), then
// the key derived from ENCRYPTION_KEY. The first key wraps new data keys; every
// key still unwraps.
func MasterKeysFromEnv(getenv func(string) string) ([]MasterKey, error) {
	encryptionKey := getenv("ENCRYPTION_KEY")
	if strings.TrimSpace(encryptionKey) == "" {
		// TypeScript allows a development placeholder when NODE_ENV is not
		// production. Go refuses: a process serving content must have material.
		return nil, errors.New("ENCRYPTION_KEY is required for content encryption")
	}
	derived, err := deriveMasterKey(encryptionKey)
	if err != nil {
		return nil, err
	}
	var keys []MasterKey
	seen := map[string]bool{DerivedMasterKeyID: true}
	for _, entry := range strings.Split(getenv("ENCRYPTION_MASTER_KEYS"), ",") {
		entry = strings.TrimSpace(entry)
		if entry == "" {
			continue
		}
		separator := strings.IndexByte(entry, ':')
		if separator < 1 {
			return nil, errors.New("ENCRYPTION_MASTER_KEYS entries must look like id:key")
		}
		id := entry[:separator]
		if !masterKeyIDPattern.MatchString(id) || id == DerivedMasterKeyID {
			return nil, errors.New("ENCRYPTION_MASTER_KEYS entries must look like id:key")
		}
		if seen[id] {
			return nil, errors.New("ENCRYPTION_MASTER_KEYS ids must be unique")
		}
		seen[id] = true
		material, err := parseKeyMaterial(entry[separator+1:])
		if err != nil {
			return nil, err
		}
		keys = append(keys, MasterKey{ID: id, Key: material})
	}
	// The configured keys come first in file order (active first), then the
	// derived key last, as masterKeysFromEnv returns [...configured, derived].
	return append(keys, MasterKey{ID: DerivedMasterKeyID, Key: derived}), nil
}

// deriveMasterKey is hkdfSync("sha256", ENCRYPTION_KEY, "rakazo",
// "rakazo/content-master-key/v1", 32) on the raw, untrimmed value
// (content-keys.ts:38-46).
func deriveMasterKey(encryptionKey string) ([]byte, error) {
	return hkdfSHA256([]byte(encryptionKey), []byte("rakazo"),
		[]byte("rakazo/content-master-key/v1"), 32), nil
}

// parseKeyMaterial reads 32 bytes as 64 hex characters or base64
// (content-keys.ts:22-27).
func parseKeyMaterial(value string) ([]byte, error) {
	trimmed := strings.TrimSpace(value)
	var key []byte
	if len(trimmed) == 64 && isHex(trimmed) {
		decoded, err := hex.DecodeString(trimmed)
		if err != nil {
			return nil, errors.New("Each master key must be 32 bytes as hex or base64")
		}
		key = decoded
	} else {
		// Buffer.from(value, "base64") ignores padding and non-alphabet
		// characters and accepts the URL-safe alphabet (content-keys.ts:25).
		key = decodeBase64Lenient(trimmed)
	}
	if len(key) != 32 {
		return nil, errors.New("Each master key must be 32 bytes as hex or base64")
	}
	return key, nil
}

func isHex(value string) bool {
	for _, char := range value {
		if (char < '0' || char > '9') && (char < 'a' || char > 'f') && (char < 'A' || char > 'F') {
			return false
		}
	}
	return true
}

// KeyWrapContext is what a wrap binds besides the key material: the Space and
// the key version (adapter-kit's KeyWrapContext).
type KeyWrapContext struct {
	SpaceID string
	Version int
}

// WrappedDataKey is a space key as stored in space_keys.
type WrappedDataKey struct {
	MasterKeyID string
	WrappedKey  string
}

// KeyProvider wraps and unwraps space data keys. LocalKeyProvider is the local
// master-key provider; a KMS provider can implement the same interface (its
// ciphertext blobs are provider-generated and cannot be reproduced locally).
type KeyProvider interface {
	ActiveKeyID() string
	Wrap(dataKey []byte, context KeyWrapContext) (WrappedDataKey, error)
	Unwrap(wrapped WrappedDataKey, context KeyWrapContext) ([]byte, error)
}

// LocalKeyProvider is LocalKeyProvider (content-keys.ts:61-113): AES-256-GCM
// key wrapping under master keys held in process memory.
type LocalKeyProvider struct {
	keys   map[string][]byte
	active string
}

// NewLocalKeyProvider returns a provider over masterKeys; the first wraps new
// data keys.
func NewLocalKeyProvider(masterKeys []MasterKey) (*LocalKeyProvider, error) {
	if len(masterKeys) == 0 {
		return nil, errors.New("At least one master key is required")
	}
	provider := &LocalKeyProvider{keys: map[string][]byte{}, active: masterKeys[0].ID}
	for _, key := range masterKeys {
		provider.keys[key.ID] = key.Key
	}
	return provider, nil
}

// ActiveKeyID is the master key new space keys are wrapped under.
func (p *LocalKeyProvider) ActiveKeyID() string { return p.active }

// Has reports whether a master key id can unwrap.
func (p *LocalKeyProvider) Has(masterKeyID string) bool {
	_, ok := p.keys[masterKeyID]
	return ok
}

// wrapAAD is `rakazo/space-key/v1\0<spaceId>\0<version>` (content-keys.ts:57-59).
func wrapAAD(context KeyWrapContext) []byte {
	return []byte("rakazo/space-key/v1\x00" + context.SpaceID + "\x00" +
		strconv.Itoa(context.Version))
}

// Wrap seals a data key with the active master key and a fresh IV.
func (p *LocalKeyProvider) Wrap(dataKey []byte, context KeyWrapContext) (WrappedDataKey, error) {
	master, ok := p.keys[p.active]
	if !ok {
		return WrappedDataKey{}, fmt.Errorf("Master key %s is not configured", p.active)
	}
	block, err := aes.NewCipher(master)
	if err != nil {
		return WrappedDataKey{}, fmt.Errorf("wrap space key: %w", err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return WrappedDataKey{}, fmt.Errorf("wrap space key: %w", err)
	}
	iv := make([]byte, ivBytes)
	if _, err := rand.Read(iv); err != nil {
		return WrappedDataKey{}, fmt.Errorf("wrap space key iv: %w", err)
	}
	body := gcm.Seal(nil, iv, dataKey, wrapAAD(context))
	return WrappedDataKey{
		MasterKeyID: p.active,
		WrappedKey:  base64.RawURLEncoding.EncodeToString(append(iv, body...)),
	}, nil
}

// Unwrap opens a stored space key with the master key it names
// (content-keys.ts:95-112).
func (p *LocalKeyProvider) Unwrap(wrapped WrappedDataKey, context KeyWrapContext) ([]byte, error) {
	master, ok := p.keys[wrapped.MasterKeyID]
	if !ok {
		return nil, fmt.Errorf("Master key %s is not configured", wrapped.MasterKeyID)
	}
	fail := func() ([]byte, error) {
		return nil, fmt.Errorf("Space key could not be unwrapped with master key %s", wrapped.MasterKeyID)
	}
	body := decodeBase64Lenient(wrapped.WrappedKey)
	if len(body) < ivBytes+tagBytes {
		return fail()
	}
	block, err := aes.NewCipher(master)
	if err != nil {
		return fail()
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return fail()
	}
	plaintext, err := gcm.Open(nil, body[:ivBytes], body[ivBytes:], wrapAAD(context))
	if err != nil || len(plaintext) != 32 {
		return fail()
	}
	return plaintext, nil
}
