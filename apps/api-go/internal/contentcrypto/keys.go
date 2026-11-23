package contentcrypto

import (
	"container/list"
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"regexp"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/effects"
)

// ErrVaultKeyOwnerGone is VaultKeyOwnerGoneError: the member or Space a vault
// key belongs to was deleted, taking everything it held (content-keys.ts:236-241).
var ErrVaultKeyOwnerGone = errors.New("The member or Space that owns this vault key was deleted")

// ErrSpaceKeyMissing is what a ciphertext naming a deleted key gets
// (content-keys.ts:398).
var ErrSpaceKeyMissing = errors.New("Encrypted content names a space key that no longer exists")

// SpaceKeyRecord is one row of space_keys (content-keys.ts:139-145).
type SpaceKeyRecord struct {
	ID          string
	SpaceID     string
	Version     int
	MasterKeyID string
	WrappedKey  string
}

// SpaceSource is a table whose rows resolve to a Space and an owner
// (content-keys.ts:147-153).
type SpaceSource string

// The tables whose encrypted rows the ring can resolve.
const (
	SourceThreads        SpaceSource = "threads"
	SourceMessages       SpaceSource = "messages"
	SourceEvents         SpaceSource = "events"
	SourceMemoryDocs     SpaceSource = "memory_documents"
	SourceMemoryRevision SpaceSource = "memory_revisions"
	SourceBotEmail       SpaceSource = "bot_email_messages"
)

// RowOwner is ROW_OWNER: the column holding each table's parent
// (content-keys.ts:169-176).
var RowOwner = map[SpaceSource]string{
	SourceThreads:        "userId",
	SourceMessages:       "threadId",
	SourceEvents:         "threadId",
	SourceMemoryDocs:     "userId",
	SourceMemoryRevision: "documentId",
	SourceBotEmail:       "botId",
}

// RowContext is the Space a row belongs to and the parent it is bound to
// (content-keys.ts:159-163).
type RowContext struct {
	SpaceID string
	Owner   string
}

// rowContextSQL is ROW_CONTEXT (content-keys.ts:243-250).
var rowContextSQL = map[SpaceSource]string{
	SourceThreads:        `SELECT "spaceId", "userId" AS owner FROM threads WHERE id = $1`,
	SourceEvents:         `SELECT "spaceId", "threadId" AS owner FROM events WHERE id = $1`,
	SourceMemoryDocs:     `SELECT "spaceId", "userId" AS owner FROM memory_documents WHERE id = $1`,
	SourceMessages:       `SELECT t."spaceId", m."threadId" AS owner FROM messages m JOIN threads t ON t.id = m."threadId" WHERE m.id = $1`,
	SourceMemoryRevision: `SELECT d."spaceId", r."documentId" AS owner FROM memory_revisions r JOIN memory_documents d ON d.id = r."documentId" WHERE r.id = $1`,
	SourceBotEmail:       `SELECT "spaceId", "botId" AS owner FROM bot_email_messages WHERE id = $1`,
}

// SpaceKeyStore is SpaceKeyStore (content-keys.ts:155-167).
type SpaceKeyStore interface {
	ForSpace(ctx context.Context, spaceID string) ([]SpaceKeyRecord, error)
	ByID(ctx context.Context, id string) (SpaceKeyRecord, bool, error)
	Insert(ctx context.Context, record SpaceKeyRecord) (SpaceKeyRecord, error)
	RowContext(ctx context.Context, source SpaceSource, id string) (RowContext, bool, error)
	SampleByMasterKey(ctx context.Context) ([]SpaceKeyRecord, error)
}

const spaceKeyColumns = `id, "spaceId", version, "masterKeyId", "wrappedKey"`

var vaultSpaceIDPattern = regexp.MustCompile(`^(user|vault):(.+)$`)

// PgSpaceKeyStore is PgSpaceKeyStore (content-keys.ts:221-285). Like the TS
// store's own small pool, every call runs in its own short transaction outside
// any caller transaction: a rolled-back caller never leaves rows encrypted
// under a key that does not exist, and a key lookup cannot starve the caller's
// pool. Row contexts resolve under the system bypass, because which Space owns
// a row must not depend on who may read it.
type PgSpaceKeyStore struct {
	DB *db.DB
}

// OpenPgSpaceKeyStore gives the ring its own two-connection pool, as
// createDb does (packages/db/src/client.ts:98-106). Without it, a key created
// on first use inside a saturated caller pool would wait for a connection that
// only it could release.
func OpenPgSpaceKeyStore(ctx context.Context, database *db.DB) (*PgSpaceKeyStore, error) {
	pool, err := database.NewPool(ctx, 2, "rakazo-api-go-content-keys")
	if err != nil {
		return nil, err
	}
	return &PgSpaceKeyStore{DB: pool}, nil
}

// Close releases the store's own pool.
func (s *PgSpaceKeyStore) Close() {
	if s.DB != nil {
		s.DB.Close()
	}
}

// ForSpace returns a Space's keys, oldest first.
func (s *PgSpaceKeyStore) ForSpace(ctx context.Context, spaceID string) ([]SpaceKeyRecord, error) {
	var records []SpaceKeyRecord
	err := s.DB.System(ctx, "read a Space's content keys", func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx,
			`SELECT `+spaceKeyColumns+` FROM space_keys WHERE "spaceId" = $1 ORDER BY version`,
			spaceID)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var record SpaceKeyRecord
			if err := rows.Scan(&record.ID, &record.SpaceID, &record.Version,
				&record.MasterKeyID, &record.WrappedKey); err != nil {
				return err
			}
			records = append(records, record)
		}
		return rows.Err()
	})
	return records, err
}

// ByID resolves one key version named by a ciphertext header.
func (s *PgSpaceKeyStore) ByID(ctx context.Context, id string) (SpaceKeyRecord, bool, error) {
	var record SpaceKeyRecord
	found := false
	err := s.DB.System(ctx, "read a content key by id", func(tx pgx.Tx) error {
		err := tx.QueryRow(ctx,
			`SELECT `+spaceKeyColumns+` FROM space_keys WHERE id = $1`, id).
			Scan(&record.ID, &record.SpaceID, &record.Version, &record.MasterKeyID, &record.WrappedKey)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		if err != nil {
			return err
		}
		found = true
		return nil
	})
	return record, found, err
}

// Insert stores a new key version unless the (space, version) pair exists, and
// returns the stored row either way. A vault key is created only while its
// member or Space exists: the statement locks that row as a foreign key would,
// so a deletion either waits and then shreds the new key, or commits first and
// leaves nothing to insert (content-keys.ts:278-302).
func (s *PgSpaceKeyStore) Insert(ctx context.Context, record SpaceKeyRecord) (SpaceKeyRecord, error) {
	kind, owner := "", ""
	if match := vaultSpaceIDPattern.FindStringSubmatch(record.SpaceID); match != nil {
		kind, owner = match[1], match[2]
	}
	values := []any{record.ID, record.SpaceID, record.Version, record.MasterKeyID, record.WrappedKey}
	query := `INSERT INTO space_keys (` + spaceKeyColumns + `) VALUES ($1, $2, $3, $4, $5)
		ON CONFLICT ("spaceId", version) DO NOTHING RETURNING ` + spaceKeyColumns
	if owner != "" {
		table := "spaces"
		if kind == "user" {
			table = `"user"`
		}
		query = `WITH owner AS (SELECT 1 FROM ` + table + ` WHERE id = $6 FOR KEY SHARE)
			INSERT INTO space_keys (` + spaceKeyColumns + `)
			SELECT $1::text, $2::text, $3::int, $4::text, $5::text FROM owner
			ON CONFLICT ("spaceId", version) DO NOTHING RETURNING ` + spaceKeyColumns
		values = append(values, owner)
	}
	var stored SpaceKeyRecord
	inserted := false
	err := s.DB.System(ctx, "create a content key", func(tx pgx.Tx) error {
		err := tx.QueryRow(ctx, query, values...).Scan(&stored.ID, &stored.SpaceID,
			&stored.Version, &stored.MasterKeyID, &stored.WrappedKey)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		if err != nil {
			return err
		}
		inserted = true
		return nil
	})
	if err != nil {
		return SpaceKeyRecord{}, err
	}
	if inserted {
		return stored, nil
	}
	existing, err := s.ForSpace(ctx, record.SpaceID)
	if err != nil {
		return SpaceKeyRecord{}, err
	}
	for _, row := range existing {
		if row.Version == record.Version {
			return row, nil
		}
	}
	if owner != "" {
		return SpaceKeyRecord{}, ErrVaultKeyOwnerGone
	}
	return SpaceKeyRecord{}, errors.New("Space key insert lost a race to a deleted key")
}

// RowContext is rowContext (content-keys.ts:298-302), under the system bypass.
func (s *PgSpaceKeyStore) RowContext(ctx context.Context, source SpaceSource, id string) (RowContext, bool, error) {
	query, ok := rowContextSQL[source]
	if !ok {
		return RowContext{}, false, fmt.Errorf("unknown space source %q", source)
	}
	var resolved RowContext
	found := false
	err := s.DB.System(ctx, "resolve the Space that owns an encrypted row", func(tx pgx.Tx) error {
		err := tx.QueryRow(ctx, query, id).Scan(&resolved.SpaceID, &resolved.Owner)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		if err != nil {
			return err
		}
		found = true
		return nil
	})
	return resolved, found, err
}

// SampleByMasterKey is sampleByMasterKey (content-keys.ts:304-309).
func (s *PgSpaceKeyStore) SampleByMasterKey(ctx context.Context) ([]SpaceKeyRecord, error) {
	var records []SpaceKeyRecord
	err := s.DB.System(ctx, "check the content master keys", func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `SELECT DISTINCT ON ("masterKeyId") `+spaceKeyColumns+`
			FROM space_keys ORDER BY "masterKeyId", id`)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var record SpaceKeyRecord
			if err := rows.Scan(&record.ID, &record.SpaceID, &record.Version,
				&record.MasterKeyID, &record.WrappedKey); err != nil {
				return err
			}
			records = append(records, record)
		}
		return rows.Err()
	})
	return records, err
}

// ttlCache is TtlCache (content-keys.ts:311-340): entries expire after ttl and
// the oldest leaves past max.
type ttlCache[V any] struct {
	mu      sync.Mutex
	ttl     time.Duration
	max     int
	entries map[string]*list.Element
	order   *list.List
}

type cacheEntry[V any] struct {
	key     string
	value   V
	expires time.Time
}

func newTTLCache[V any](ttl time.Duration, max int) *ttlCache[V] {
	return &ttlCache[V]{ttl: ttl, max: max, entries: map[string]*list.Element{}, order: list.New()}
}

func (c *ttlCache[V]) get(key string) (V, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	element, ok := c.entries[key]
	if !ok {
		var zero V
		return zero, false
	}
	entry := element.Value.(*cacheEntry[V])
	if !entry.expires.After(time.Now()) {
		c.order.Remove(element)
		delete(c.entries, key)
		var zero V
		return zero, false
	}
	return entry.value, true
}

func (c *ttlCache[V]) set(key string, value V) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if element, ok := c.entries[key]; ok {
		c.order.Remove(element)
		delete(c.entries, key)
	}
	element := c.order.PushBack(&cacheEntry[V]{key: key, value: value, expires: time.Now().Add(c.ttl)})
	c.entries[key] = element
	for len(c.entries) > c.max {
		oldest := c.order.Front()
		if oldest == nil {
			break
		}
		entry := oldest.Value.(*cacheEntry[V])
		c.order.Remove(oldest)
		delete(c.entries, entry.key)
	}
}

func (c *ttlCache[V]) deleteWhere(predicate func(V) bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for key, element := range c.entries {
		if predicate(element.Value.(*cacheEntry[V]).value) {
			c.order.Remove(element)
			delete(c.entries, key)
		}
	}
}

func (c *ttlCache[V]) clear() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.entries = map[string]*list.Element{}
	c.order = list.New()
}

// floatFlight is the single-flight map ring loads use
// (content-keys.ts:370-377), so concurrent readers load one key once.
type flight[T any] struct {
	done   chan struct{}
	result T
	err    error
}

func (r *KeyRing) once(key string, load func() (any, error)) (any, error) {
	r.flightMu.Lock()
	if existing, ok := r.inflight[key]; ok {
		r.flightMu.Unlock()
		<-existing.done
		return existing.result, existing.err
	}
	call := &flight[any]{done: make(chan struct{})}
	r.inflight[key] = call
	r.flightMu.Unlock()
	call.result, call.err = load()
	close(call.done)
	r.flightMu.Lock()
	delete(r.inflight, key)
	r.flightMu.Unlock()
	return call.result, call.err
}

// KeyRingOptions are ContentKeyRingOptions (content-keys.ts:342-350).
type KeyRingOptions struct {
	// TTL is how long unwrapped keys and the current version stay in memory.
	// Zero means ten minutes, the TS default.
	TTL time.Duration
	// EncryptWrites false stores new content in plaintext; existing ciphertext
	// still decrypts.
	EncryptWrites bool
}

// KeyRing is ContentKeyRing (content-keys.ts:352-485): per-space data keys.
// The newest version encrypts; every version decrypts. Keys are created on
// first use and cached unwrapped for a bounded time, so a deleted Space's key
// leaves process memory within the TTL.
type KeyRing struct {
	Provider KeyProvider
	store    SpaceKeyStore
	// EncryptWrites reports whether new content is sealed.
	EncryptWrites bool

	keys     *ttlCache[DataKey]
	versions *ttlCache[[]DataKey]
	rows     *ttlCache[RowContext]

	flightMu sync.Mutex
	inflight map[string]*flight[any]
}

// ErrNoKeyStore is a read of ciphertext through a ring built without a store,
// which is only NoEncryptionKeyRing: the deployment says its rows are plaintext,
// so a ciphertext there is a misconfiguration, not a value to ignore.
var ErrNoKeyStore = errors.New("content crypto: no key store (content encryption is off)")

// NoEncryptionKeyRing is the ring a deployment with content encryption off
// builds. The library's cancels require a ring because they open sealed message
// blocks; this one passes plaintext rows through, writes no ciphertext, and
// reports a ciphertext as ErrNoKeyStore rather than silently skipping it. It is
// safe for concurrent use and has no provider or key store.
func NoEncryptionKeyRing() *KeyRing {
	return NewKeyRing(nil, nil, KeyRingOptions{EncryptWrites: false})
}

// NewKeyRing returns a ring over provider and store.
func NewKeyRing(provider KeyProvider, store SpaceKeyStore, options KeyRingOptions) *KeyRing {
	ttl := options.TTL
	if ttl == 0 {
		ttl = 10 * time.Minute
	}
	return &KeyRing{
		Provider:      provider,
		store:         store,
		EncryptWrites: options.EncryptWrites,
		keys:          newTTLCache[DataKey](ttl, 20_000),
		versions:      newTTLCache[[]DataKey](ttl, 20_000),
		rows:          newTTLCache[RowContext](time.Hour, 50_000),
		inflight:      map[string]*flight[any]{},
	}
}

func (r *KeyRing) unwrap(ctx context.Context, record SpaceKeyRecord) (DataKey, error) {
	if cached, ok := r.keys.get(record.ID); ok {
		return cached, nil
	}
	material, err := r.Provider.Unwrap(
		WrappedDataKey{MasterKeyID: record.MasterKeyID, WrappedKey: record.WrappedKey},
		KeyWrapContext{SpaceID: record.SpaceID, Version: record.Version},
	)
	if err != nil {
		return DataKey{}, err
	}
	key := DataKey{ID: record.ID, SpaceID: record.SpaceID, Version: record.Version, Key: material}
	r.keys.set(record.ID, key)
	return key, nil
}

// All returns every key version of a Space, oldest first. Empty when the Space
// has none yet (content-keys.ts:394-407).
func (r *KeyRing) All(ctx context.Context, spaceID string) ([]DataKey, error) {
	if r.store == nil {
		return nil, ErrNoKeyStore
	}
	if cached, ok := r.versions.get(spaceID); ok {
		return cached, nil
	}
	value, err := r.once("space:"+spaceID, func() (any, error) {
		records, err := r.store.ForSpace(ctx, spaceID)
		if err != nil {
			return nil, err
		}
		keys := make([]DataKey, 0, len(records))
		for _, record := range records {
			key, err := r.unwrap(ctx, record)
			if err != nil {
				return nil, err
			}
			keys = append(keys, key)
		}
		if len(keys) > 0 {
			r.versions.set(spaceID, keys)
		}
		return keys, nil
	})
	if err != nil {
		return nil, err
	}
	return value.([]DataKey), nil
}

// Current is the key new content is sealed with, created on first use
// (content-keys.ts:413-418).
func (r *KeyRing) Current(ctx context.Context, spaceID string) (DataKey, error) {
	keys, err := r.All(ctx, spaceID)
	if err != nil {
		return DataKey{}, err
	}
	if len(keys) > 0 {
		return keys[len(keys)-1], nil
	}
	return r.create(ctx, spaceID, 1)
}

// Rotate adds a new key version that becomes current; older versions keep
// decrypting (content-keys.ts:420-426).
func (r *KeyRing) Rotate(ctx context.Context, spaceID string) (DataKey, error) {
	r.versions.deleteWhere(func(value []DataKey) bool {
		return len(value) > 0 && value[0].SpaceID == spaceID
	})
	keys, err := r.All(ctx, spaceID)
	if err != nil {
		return DataKey{}, err
	}
	version := 1
	if len(keys) > 0 {
		version = keys[len(keys)-1].Version + 1
	}
	return r.create(ctx, spaceID, version)
}

func (r *KeyRing) create(ctx context.Context, spaceID string, version int) (DataKey, error) {
	value, err := r.once(fmt.Sprintf("create:%s:%d", spaceID, version), func() (any, error) {
		dataKey := make([]byte, 32)
		if _, err := rand.Read(dataKey); err != nil {
			return nil, fmt.Errorf("content data key: %w", err)
		}
		wrapped, err := r.Provider.Wrap(dataKey, KeyWrapContext{SpaceID: spaceID, Version: version})
		if err != nil {
			return nil, err
		}
		stored, err := r.store.Insert(ctx, SpaceKeyRecord{
			ID:          effects.NewID(),
			SpaceID:     spaceID,
			Version:     version,
			MasterKeyID: wrapped.MasterKeyID,
			WrappedKey:  wrapped.WrappedKey,
		})
		if err != nil {
			return nil, err
		}
		r.versions.deleteWhere(func(value []DataKey) bool {
			return len(value) > 0 && value[0].SpaceID == spaceID
		})
		key, err := r.unwrap(ctx, stored)
		if err != nil {
			return nil, err
		}
		if _, err := r.All(ctx, spaceID); err != nil {
			return nil, err
		}
		return key, nil
	})
	if err != nil {
		return DataKey{}, err
	}
	return value.(DataKey), nil
}

// ByID resolves the key version a ciphertext names (content-keys.ts:386-396).
func (r *KeyRing) ByID(ctx context.Context, id string) (DataKey, error) {
	if r.store == nil {
		return DataKey{}, ErrNoKeyStore
	}
	if cached, ok := r.keys.get(id); ok {
		return cached, nil
	}
	value, err := r.once("key:"+id, func() (any, error) {
		record, found, err := r.store.ByID(ctx, id)
		if err != nil {
			return nil, err
		}
		if !found {
			return nil, ErrSpaceKeyMissing
		}
		return r.unwrap(ctx, record)
	})
	if err != nil {
		return DataKey{}, err
	}
	return value.(DataKey), nil
}

// Remember caches a row's Space and owner from a result the caller saw
// (content-keys.ts:404-406).
func (r *KeyRing) Remember(source SpaceSource, id string, context RowContext) {
	r.rows.set(fmt.Sprintf("%s:%s", source, id), context)
}

// RowContext is a row's Space and owner, from rows this process has seen or
// from the database (content-keys.ts:443-453).
func (r *KeyRing) RowContext(ctx context.Context, source SpaceSource, id string) (RowContext, error) {
	if r.store == nil {
		return RowContext{}, ErrNoKeyStore
	}
	cacheKey := fmt.Sprintf("%s:%s", source, id)
	if cached, ok := r.rows.get(cacheKey); ok {
		return cached, nil
	}
	value, err := r.once("row:"+cacheKey, func() (any, error) {
		resolved, found, err := r.store.RowContext(ctx, source, id)
		if err != nil {
			return nil, err
		}
		if !found {
			return nil, fmt.Errorf("Cannot resolve the space for %s row", source)
		}
		return resolved, nil
	})
	if err != nil {
		return RowContext{}, err
	}
	resolved := value.(RowContext)
	r.rows.set(cacheKey, resolved)
	return resolved, nil
}

// SpaceOf is spaceOf (content-keys.ts:455-457).
func (r *KeyRing) SpaceOf(ctx context.Context, source SpaceSource, id string) (string, error) {
	resolved, err := r.RowContext(ctx, source, id)
	if err != nil {
		return "", err
	}
	return resolved.SpaceID, nil
}

// AllFresh reads every version straight from the store, for search: another
// process may have rotated the Space (content-keys.ts:461-469).
func (r *KeyRing) AllFresh(ctx context.Context, spaceID string) ([]DataKey, error) {
	r.versions.deleteWhere(func(value []DataKey) bool {
		return len(value) > 0 && value[0].SpaceID == spaceID
	})
	return r.All(ctx, spaceID)
}

// UnreadableMasterKeys is the startup check (content-keys.ts:471-485): the
// master key ids stored space keys use but that can no longer be unwrapped.
func (r *KeyRing) UnreadableMasterKeys(ctx context.Context) []string {
	_ = r.Provider.ActiveKeyID()
	unreadable := []string{}
	records, err := r.store.SampleByMasterKey(ctx)
	if err != nil {
		// A database that is not migrated yet is not a key problem.
		return unreadable
	}
	for _, record := range records {
		if _, err := r.Provider.Unwrap(
			WrappedDataKey{MasterKeyID: record.MasterKeyID, WrappedKey: record.WrappedKey},
			KeyWrapContext{SpaceID: record.SpaceID, Version: record.Version},
		); err != nil {
			unreadable = append(unreadable, record.MasterKeyID)
		}
	}
	return unreadable
}

// Forget drops a deleted Space's unwrapped keys from memory
// (content-keys.ts:478-482).
func (r *KeyRing) Forget(spaceID string) {
	r.keys.deleteWhere(func(key DataKey) bool { return key.SpaceID == spaceID })
	r.versions.deleteWhere(func(value []DataKey) bool {
		return len(value) > 0 && value[0].SpaceID == spaceID
	})
	r.rows.deleteWhere(func(value RowContext) bool { return value.SpaceID == spaceID })
}

// Clear drops every cache entry.
func (r *KeyRing) Clear() {
	r.keys.clear()
	r.versions.clear()
	r.rows.clear()
}
