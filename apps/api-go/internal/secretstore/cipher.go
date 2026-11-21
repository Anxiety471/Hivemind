// Package secretstore is the Go side of the credential store: the sealed
// `secrets` / `bot_secrets` / `vault_credentials` values, the vault-value
// envelope, and the secret-persistence cleanup that deleting a row requires.
//
// Two ciphers live here, because the TypeScript API uses both:
//
//   - The SecretStore envelope (`v2:`), used for every row whose ciphertext the
//     SecretStore wrote: `secrets`, `bot_secrets`, `integration_provider_configs`,
//     `messaging_installations`, `payment_wallets`, `purchases` and the
//     `deployment_settings` ciphers. Key = scrypt(ENCRYPTION_KEY, per-record
//     salt); see cipher.go.
//   - The vault-value envelope (`rkz1:`) under a vault's content data key
//     (`user:<userId>` or `vault:<spaceId>` in `space_keys`), sealed with the
//     same cipher, master keys and providers as internal/contentcrypto. See
//     vault.go.
//
// Only the `local` store and the `local` master-key provider are implemented.
// Every other configuration fails loudly instead of writing values the
// TypeScript API could not read.
package secretstore

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"regexp"
	"strings"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/contentcrypto"
	"golang.org/x/crypto/scrypt"
)

const (
	// VersionPrefix marks the current envelope (secrets.ts:15).
	VersionPrefix = "v2:"
	// InfisicalRefPrefix names a value held by an external store
	// (infisical-secret-store.ts:21).
	InfisicalRefPrefix = "infisical:"

	saltBytes = 16
	ivBytes   = 12
	tagBytes  = 16
	// Minimum body: salt | iv | tag (secrets.ts:56).
	minBodyBytes = saltBytes + ivBytes + tagBytes

	// scrypt parameters (secrets.ts:21-22).
	scryptN     = 16_384
	scryptR     = 8
	scryptP     = 1
	scryptBytes = 32
)

// ErrMalformed is "Encrypted secret is malformed" (secrets.ts:57).
var ErrMalformed = errors.New("Encrypted secret is malformed")

// ErrAuthentication is the OpenSSL message Node reports when AES-GCM
// authentication fails (secrets.ts:79-82 matches "unable to authenticate").
var ErrAuthentication = errors.New("Unsupported state or unable to authenticate data")

// ErrLegacyIV and ErrLegacyTag are what Node throws for a legacy body too short
// to carry an IV or an authentication tag ("Invalid initialization vector" /
// "Invalid authentication tag length"). They are deliberately not
// ErrAuthentication: the TypeScript predicate treats them as non-permanent
// (secrets.ts:73-84), so a retryable-classification port must agree.
var (
	ErrLegacyIV  = errors.New("Invalid initialization vector")
	ErrLegacyTag = errors.New("Invalid authentication tag length")
)

// ErrRemoteUnsupported is SecretStoreUnavailableError for an `infisical:`
// reference read by the local store (secrets.ts:135-143). The TypeScript
// message is kept verbatim so an operator sees the same instruction.
var ErrRemoteUnsupported = errors.New(
	"Infisical secret references require SECRET_STORE=infisical; run the reverse migration " +
		"before switching to encrypted storage (docs/infisical-secrets.md)")

// seal lays out salt | iv | tag | enc and prefixes it (secrets.ts:118-126).
func seal(key []byte, recordID, plaintext string) (string, error) {
	salt := make([]byte, saltBytes)
	if _, err := io.ReadFull(rand.Reader, salt); err != nil {
		return "", fmt.Errorf("seal a secret: %w", err)
	}
	return sealWithKey(key, salt, recordID, plaintext)
}

func sealWithKey(master []byte, salt []byte, recordID, plaintext string) (string, error) {
	key, err := deriveKey(master, salt)
	if err != nil {
		return "", err
	}
	gcm, err := newGCM(key)
	if err != nil {
		return "", err
	}
	iv := make([]byte, ivBytes)
	if _, err := io.ReadFull(rand.Reader, iv); err != nil {
		return "", fmt.Errorf("seal a secret: %w", err)
	}
	// Go appends the tag after the ciphertext; the TypeScript layout keeps it
	// before, so the two halves are written separately.
	sealed := gcm.Seal(nil, iv, []byte(plaintext), []byte(recordID))
	enc := sealed[:len(sealed)-tagBytes]
	tag := sealed[len(sealed)-tagBytes:]
	body := make([]byte, 0, saltBytes+ivBytes+tagBytes+len(enc))
	body = append(body, salt...)
	body = append(body, iv...)
	body = append(body, tag...)
	body = append(body, enc...)
	return VersionPrefix + base64.StdEncoding.EncodeToString(body), nil
}

// openSealedWithKey reverses sealWithKey (secrets.ts:65-71).
func openSealedWithKey(master []byte, ciphertext, recordID string) (string, error) {
	body := contentcrypto.DecodeBase64Node(ciphertext[len(VersionPrefix):])
	if len(body) < minBodyBytes {
		return "", ErrMalformed
	}
	salt := body[:saltBytes]
	iv := body[saltBytes : saltBytes+ivBytes]
	tag := body[saltBytes+ivBytes : saltBytes+ivBytes+tagBytes]
	enc := body[saltBytes+ivBytes+tagBytes:]
	key, err := deriveKey(master, salt)
	if err != nil {
		return "", err
	}
	gcm, err := newGCM(key)
	if err != nil {
		return "", err
	}
	combined := make([]byte, 0, len(enc)+tagBytes)
	combined = append(combined, enc...)
	combined = append(combined, tag...)
	plaintext, err := gcm.Open(nil, iv, combined, []byte(recordID))
	if err != nil {
		return "", ErrAuthentication
	}
	return string(plaintext), nil
}

// openLegacy reads the pre-v2 format: a single SHA-256 key, no AAD, and no
// version prefix (secrets.ts:170-180).
func openLegacy(master []byte, ciphertext string) (string, error) {
	body := contentcrypto.DecodeBase64Node(ciphertext)
	if len(body) < ivBytes {
		return "", ErrLegacyIV
	}
	if len(body) < ivBytes+tagBytes {
		return "", ErrLegacyTag
	}
	digest := sha256.Sum256(master)
	gcm, err := newGCM(digest[:])
	if err != nil {
		return "", err
	}
	iv := body[:ivBytes]
	tag := body[ivBytes : ivBytes+tagBytes]
	enc := body[ivBytes+tagBytes:]
	combined := make([]byte, 0, len(enc)+tagBytes)
	combined = append(combined, enc...)
	combined = append(combined, tag...)
	plaintext, err := gcm.Open(nil, iv, combined, nil)
	if err != nil {
		return "", ErrAuthentication
	}
	return string(plaintext), nil
}

func deriveKey(master, salt []byte) ([]byte, error) {
	key, err := scrypt.Key(master, salt, scryptN, scryptR, scryptP, scryptBytes)
	if err != nil {
		return nil, fmt.Errorf("derive a secret key: %w", err)
	}
	return key, nil
}

func newGCM(key []byte) (cipher.AEAD, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, fmt.Errorf("seal a secret: %w", err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, fmt.Errorf("seal a secret: %w", err)
	}
	return gcm, nil
}

// SealLegacy writes the pre-v2 format for compatibility proofs: SHA-256 of the
// encryption key, no AAD, `base64(iv | tag | ciphertext)`. The TypeScript API
// only reads this format (secrets.ts:170-180); nothing writes it any more.
func (s *Store) SealLegacy(plaintext string) (string, error) {
	digest := sha256.Sum256(s.master)
	gcm, err := newGCM(digest[:])
	if err != nil {
		return "", err
	}
	iv := make([]byte, ivBytes)
	if _, err := rand.Read(iv); err != nil {
		return "", fmt.Errorf("seal a legacy secret: %w", err)
	}
	sealed := gcm.Seal(nil, iv, []byte(plaintext), nil)
	enc := sealed[:len(sealed)-tagBytes]
	tag := sealed[len(sealed)-tagBytes:]
	body := make([]byte, 0, ivBytes+tagBytes+len(enc))
	body = append(body, iv...)
	body = append(body, tag...)
	body = append(body, enc...)
	return base64.StdEncoding.EncodeToString(body), nil
}

// IsSealed reports whether ciphertext is in the current envelope; anything else
// is the legacy format (secrets.ts:147).
func IsSealed(ciphertext string) bool {
	return strings.HasPrefix(ciphertext, VersionPrefix)
}

// IsPermanentDecryptFailure reports a failure no retry changes
// (secrets.ts:79-84): a malformed value or a failed authentication, never an
// unavailable store.
func IsPermanentDecryptFailure(err error) bool {
	return errors.Is(err, ErrMalformed) || errors.Is(err, ErrAuthentication)
}

// KeyCacheSize bounds the derived keys kept in memory (secrets.ts:26).
const KeyCacheSize = 1_000

var (
	redactAPIKey = regexp.MustCompile(`sk-[a-zA-Z0-9-_]{8,}`)
	redactJWT    = regexp.MustCompile(`eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+`)
)

// Redact hides the shapes a provider key takes in free text
// (secrets.ts:182-188). In `[a-zA-Z0-9-_]` both engines treat the second `-` as
// a literal at the end of the class, not as the range `9-_`; a differential
// corpus over the whole byte and astral range found no difference.
func Redact(value string) string {
	value = redactAPIKey.ReplaceAllString(value, "[redacted]")
	return redactJWT.ReplaceAllString(value, "[redacted]")
}
