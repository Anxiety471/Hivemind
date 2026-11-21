package secretstore

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/contentcrypto"
)

// VaultRow is the identity a vault value is bound to: the row id, its owner
// and the Space whose vault holds it, null for the account vault
// (vault-values.ts:14-24, bot-secrets.ts:168-173).
type VaultRow struct {
	ID      string
	UserID  string
	SpaceID *string
}

// DecryptionError is ContentDecryptionError (content-crypto.ts:33-38): the
// stored value cannot be opened where it was found. Its messages are fixed and
// quote no value.
type DecryptionError struct{ Message string }

func (e *DecryptionError) Error() string { return e.Message }

func decryptionError(message string) error { return &DecryptionError{Message: message} }

// VaultScope is keyScope: `vault:<space id>` for a Space's own vault and
// `user:<member id>` for the account vault every Space shares
// (vault-values.ts:17-19).
func VaultScope(row VaultRow) string {
	if row.SpaceID != nil && *row.SpaceID != "" {
		return "vault:" + *row.SpaceID
	}
	return "user:" + row.UserID
}

// VaultLocation is the AAD location of a vault value (vault-values.ts:20-25).
// Note that `bot_secrets` values sealed through sealVaultValue use this same
// table name: the TypeScript helper is shared, so its binding says
// `vault_credentials` even for a bot secret (bot-secrets.ts:903-906).
func VaultLocation(row VaultRow) contentcrypto.Location {
	return contentcrypto.Location{
		Table:  "vault_credentials",
		Column: "ciphertext",
		RowID:  row.ID,
		Owner:  row.UserID,
	}
}

// QueryRower is satisfied by pgx.Tx, *pgxpool.Pool and *sql.DB-like wrappers.
type QueryRower interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

// NewestVaultKeyID returns the newest stored key id of a vault scope without
// creating one (vault-values.ts:35-41). The read runs on the caller's
// connection so the row-level-security settings that apply to the vault apply
// here; the key itself is unwrapped by the ring's own store, as TypeScript's
// ring does.
func NewestVaultKeyID(ctx context.Context, q QueryRower, scope string) (string, bool, error) {
	var id string
	err := q.QueryRow(ctx,
		`SELECT id FROM space_keys WHERE "spaceId" = $1 ORDER BY version DESC LIMIT 1`, scope).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	return id, true, nil
}

// Sealer is the write side of the credential store a vault value falls back to
// while its vault has no key (SecretStore.put). A *Writer publishes the change;
// a *Store seals without announcing.
type Sealer interface {
	Put(ctx context.Context, plaintext string, options PutOptions) (Record, error)
}

// Loader is the read side (SecretStore.load).
type Loader interface {
	Load(ctx context.Context, ref, recordID string) (string, error)
}

// SealVaultValue is sealVaultValue (vault-values.ts:52-71). Once the vault's
// key exists and content encryption is on, a value is sealed under that key
// (`rkz1:`); until then, and whenever encryption is off, the SecretStore writes
// the format the previous release reads (`v2:`). A nil ring means this build
// has no content keys, which is the same fallback.
func SealVaultValue(
	ctx context.Context,
	q QueryRower,
	ring *contentcrypto.KeyRing,
	store Sealer,
	row VaultRow,
	plaintext string,
) (string, error) {
	if ring != nil && ring.EncryptWrites {
		keyID, ok, err := NewestVaultKeyID(ctx, q, VaultScope(row))
		if err != nil {
			return "", err
		}
		if ok {
			key, err := ring.ByID(ctx, keyID)
			if err != nil {
				return "", err
			}
			return contentcrypto.EncryptText(key, VaultLocation(row), plaintext)
		}
	}
	record, err := store.Put(ctx, plaintext, PutOptions{RecordID: row.ID})
	if err != nil {
		return "", err
	}
	return record.Ciphertext, nil
}

// OpenVaultValue is openVaultValue (vault-values.ts:74-84). It decides on the
// stored prefix exactly as TypeScript does (`startsWith(CIPHERTEXT_PREFIX)`),
// so a damaged value that starts with `rkz1:` but names no key is a vault
// error, not a legacy SecretStore decrypt.
func OpenVaultValue(
	ctx context.Context,
	ring *contentcrypto.KeyRing,
	store Loader,
	row VaultRow,
	ciphertext string,
) (string, error) {
	if !strings.HasPrefix(ciphertext, contentcrypto.CiphertextPrefix) {
		return store.Load(ctx, ciphertext, row.ID)
	}
	return OpenSealedVaultValue(ctx, ring, row, ciphertext)
}

// OpenSealedVaultValue is openSealedVaultValue (vault-values.ts:91-109): the
// value must name a key of this vault, and only that key opens it.
func OpenSealedVaultValue(
	ctx context.Context,
	ring *contentcrypto.KeyRing,
	row VaultRow,
	ciphertext string,
) (string, error) {
	keyID, ok := contentcrypto.CiphertextKeyID(ciphertext)
	if !ok {
		return "", decryptionError("Vault item names no key")
	}
	if ring == nil {
		// The TypeScript path throws "Vault item encryption is unavailable"
		// when the content ring is not installed (vault-values.ts:27-31).
		return "", errors.New("Vault item encryption is unavailable")
	}
	key, err := ring.ByID(ctx, keyID)
	if err != nil {
		// A key row that is gone is damaged data; an existing key that cannot
		// unwrap keeps the key manager's error (vault-values.ts:98-104).
		if errors.Is(err, contentcrypto.ErrSpaceKeyMissing) {
			return "", decryptionError("Vault item names a key that no longer exists")
		}
		return "", fmt.Errorf("vault item key %s: %w", keyID, err)
	}
	if key.SpaceID != VaultScope(row) {
		return "", decryptionError("Vault item names another vault's key")
	}
	plaintext, err := contentcrypto.DecryptText(key, VaultLocation(row), ciphertext)
	if err != nil {
		// Every content failure is a ContentDecryptionError to TypeScript; a
		// port that classifies by type must see the same type here.
		if errors.Is(err, contentcrypto.ErrDecryption) || errors.Is(err, contentcrypto.ErrAnotherKey) {
			return "", &DecryptionError{Message: err.Error()}
		}
		return "", err
	}
	return plaintext, nil
}
