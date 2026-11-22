package secretstore

import (
	"container/list"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"sync"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/contentcrypto"
)

// Record is SecretRecord (types.ts:1113-1118): the row id, the opaque
// reference the ciphertext column stores, and the value the column holds. The
// local store writes the sealed value inline, so Ref == Ciphertext.
type Record struct {
	ID         string
	Ref        string
	Ciphertext string
}

// PutOptions is SecretPutOptions for the local store (types.ts:1121-1128).
// RecordID binds the value to a row; empty picks 12 random bytes as hex
// (secrets.ts:110). Ephemeral selects local storage over a remote store, which
// is always the local store here. BeforeWrite is accepted for interface parity
// and never called: only a remote store names an entry before writing it.
type PutOptions struct {
	RecordID    string
	Ephemeral   bool
	BeforeWrite func(entry Record) error
}

// ChangeListener is SecretChangeListener (types.ts:1130).
type ChangeListener func(ref string)

// keyEntry is one in-flight or finished scrypt derivation. The channel closes
// when key and err are set, so concurrent readers of one salt wait instead of
// deriving a second time (secrets.ts:49-61,192-212).
type keyEntry struct {
	key   []byte
	err   error
	ready chan struct{}
}

// Store is EncryptedSecretStore (secrets.ts:88-188) for the configured
// `encrypted` SECRET_STORE: AES-256-GCM with a per-record scrypt key, the
// legacy SHA-256 format readable, and deletion only announcing the change.
type Store struct {
	master []byte

	mu       sync.Mutex
	derived  map[string]*list.Element
	order    *list.List // front = most recently used; values are *derivedEntry
	listener map[uint64]ChangeListener
	nextID   uint64

	// Logger receives redaction and listener failures, which never fail a write.
	Logger *slog.Logger
}

type derivedEntry struct {
	id    string
	entry *keyEntry
}

// NewStore opens the local store over the deployment's ENCRYPTION_KEY: the raw
// environment value, untrimmed, exactly as EncryptedSecretStore receives it
// (env.ts:resolveEncryptionKey, secrets.ts:97). An empty or whitespace-only key
// is refused rather than deriving a key nobody else uses; use
// ResolveEncryptionKey to read one from the environment with TypeScript's rules.
func NewStore(encryptionKey string) (*Store, error) {
	if trimJSString(encryptionKey) == "" {
		return nil, errors.New("secretstore: ENCRYPTION_KEY is required for stored credentials")
	}
	return &Store{
		master:   []byte(encryptionKey),
		derived:  map[string]*list.Element{},
		order:    list.New(),
		listener: map[uint64]ChangeListener{},
	}, nil
}

// ID is describe().id: the store that keeps a value in the ciphertext column
// itself (secrets.ts:100-108). sealVaultValue only uses content keys while this
// is the configured store (vault-values.ts:59-70).
func (s *Store) ID() string { return "app-encrypted" }

// IsRemote reports whether ref names a resource another service holds.
// EncryptedSecretStore answers false for every ref, including an `infisical:`
// one written by a previous configuration (secrets.ts:174-176).
func (s *Store) IsRemote(string) bool { return false }

// OnChange registers a listener and returns its unsubscribe
// (secret-changes.ts:5-15).
func (s *Store) OnChange(listener ChangeListener) func() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.nextID++
	id := s.nextID
	s.listener[id] = listener
	return func() {
		s.mu.Lock()
		delete(s.listener, id)
		s.mu.Unlock()
	}
}

func (s *Store) changed(ref string) {
	s.mu.Lock()
	listeners := make([]ChangeListener, 0, len(s.listener))
	for _, listener := range s.listener {
		listeners = append(listeners, listener)
	}
	s.mu.Unlock()
	for _, listener := range listeners {
		func() {
			defer func() {
				if recovered := recover(); recovered != nil && s.Logger != nil {
					s.Logger.Warn("secret change listener panicked", "panic", recovered)
				}
			}()
			listener(ref)
		}()
	}
}

// Close drops listeners; nothing else is held (secrets.ts:214).
func (s *Store) Close() {
	s.mu.Lock()
	s.listener = map[uint64]ChangeListener{}
	s.mu.Unlock()
}

// Put seals plaintext bound to a record id and announces the new ref
// (secrets.ts:107-116). Every call draws a fresh salt, so two values for one
// record have two ciphertexts and the earlier one keeps opening.
func (s *Store) Put(ctx context.Context, plaintext string, options PutOptions) (Record, error) {
	if err := ctx.Err(); err != nil {
		return Record{}, err
	}
	recordID := options.RecordID
	if recordID == "" {
		var random [12]byte
		if _, err := rand.Read(random[:]); err != nil {
			return Record{}, fmt.Errorf("seal a secret: %w", err)
		}
		recordID = hex.EncodeToString(random[:])
	}
	salt := make([]byte, saltBytes)
	if _, err := rand.Read(salt); err != nil {
		return Record{}, fmt.Errorf("seal a secret: %w", err)
	}
	ciphertext, err := sealWithKey(s.master, salt, recordID, plaintext)
	if err != nil {
		return Record{}, err
	}
	record := Record{ID: recordID, Ref: ciphertext, Ciphertext: ciphertext}
	// The local store never calls BeforeWrite (secrets.ts:107-116): only a
	// remote store has an entry to name before writing it.
	s.changed(record.Ref)
	return record, nil
}

// Load opens ref bound to recordID (secrets.ts:129-163). A `v2:` value derives
// its key from the salt and authenticates the record id; anything else is the
// legacy format, which authenticates nothing.
func (s *Store) Load(ctx context.Context, ref, recordID string) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	if len(ref) >= len(InfisicalRefPrefix) && ref[:len(InfisicalRefPrefix)] == InfisicalRefPrefix {
		return "", ErrRemoteUnsupported
	}
	if !IsSealed(ref) {
		return openLegacy(s.master, ref)
	}
	salt, err := sealedSalt(ref)
	if err != nil {
		return "", err
	}
	key, err := s.derivedKey(salt)
	if err != nil {
		return "", err
	}
	if err := ctx.Err(); err != nil {
		return "", err
	}
	return openSealedWithKeyCached(key, ref, recordID)
}

// sealedSalt reads the salt a v2 body names without deriving its key.
func sealedSalt(ciphertext string) ([]byte, error) {
	body := decodeBase64Ref(ciphertext)
	if len(body) < minBodyBytes {
		return nil, ErrMalformed
	}
	return body[:saltBytes], nil
}

// openSealedWithKeyCached opens with an already-derived key; openSealedWithKey
// is the uncached form Put uses. Both verify the same AAD.
func openSealedWithKeyCached(key []byte, ciphertext, recordID string) (string, error) {
	body := decodeBase64Ref(ciphertext)
	if len(body) < minBodyBytes {
		return "", ErrMalformed
	}
	iv := body[saltBytes : saltBytes+ivBytes]
	tag := body[saltBytes+ivBytes : saltBytes+ivBytes+tagBytes]
	enc := body[saltBytes+ivBytes+tagBytes:]
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

func decodeBase64Ref(ciphertext string) []byte {
	if !IsSealed(ciphertext) {
		return nil
	}
	return contentcrypto.DecodeBase64Node(ciphertext[len(VersionPrefix):])
}

// derivedKey returns the key for a salt, deriving it once for concurrent
// readers and keeping the most recent KeyCacheSize keys (secrets.ts:192-212).
func (s *Store) derivedKey(salt []byte) ([]byte, error) {
	id := base64.StdEncoding.EncodeToString(salt)
	s.mu.Lock()
	if element, ok := s.derived[id]; ok {
		s.order.MoveToFront(element)
		entry := element.Value.(*derivedEntry).entry
		s.mu.Unlock()
		<-entry.ready
		return entry.key, entry.err
	}
	entry := &keyEntry{ready: make(chan struct{})}
	s.derived[id] = s.order.PushFront(&derivedEntry{id: id, entry: entry})
	if s.order.Len() > KeyCacheSize {
		if oldest := s.order.Back(); oldest != nil {
			delete(s.derived, oldest.Value.(*derivedEntry).id)
			s.order.Remove(oldest)
		}
	}
	s.mu.Unlock()

	// Derived outside the lock; a failure is not cached, so the next read
	// tries again (secrets.ts:200-204).
	key, err := deriveKey(s.master, salt)
	entry.key, entry.err = key, err
	close(entry.ready)
	if err != nil {
		s.mu.Lock()
		if element, ok := s.derived[id]; ok && element.Value.(*derivedEntry).entry == entry {
			delete(s.derived, id)
			s.order.Remove(element)
		}
		s.mu.Unlock()
	}
	return key, err
}

// Delete announces that ref is gone (secrets.ts:217-219). The value lives in
// the row that held it, so there is nothing else to remove; an entry under a
// remote store is a different store's job.
func (s *Store) Delete(_ context.Context, ref, _ string) { s.changed(ref) }
