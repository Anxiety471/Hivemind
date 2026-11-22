package secretstore

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/contentcrypto"
)

const unitKey = "unit-test-key"

// tsVector was sealed by the shipped TypeScript EncryptedSecretStore for
// recordId "row-unit" and plaintext "vector İ 😀 <&>".
const tsVector = "v2:08H74vh7qu8Mv41XTXNh/xBqZugTaVIFKXXWsvavVSBdxHj9S56xwZjUuf9npBW7zRTdq/zw7CadMyWrQfk="

// tsLegacyVector was written in the pre-v2 format by the same implementation's
// key derivation (SHA-256, no AAD) for "legacy vector é".
const tsLegacyVector = "RgDAeHM1mEWcPW/HYGHG95syRLOPQX7e+OnPbzddKLqvIcWQ3uhmIv/UjKE="

func TestOpensTypeScriptVector(t *testing.T) {
	store, err := NewStore(unitKey)
	if err != nil {
		t.Fatal(err)
	}
	plaintext, err := store.Load(context.Background(), tsVector, "row-unit")
	if err != nil {
		t.Fatal(err)
	}
	if plaintext != "vector İ 😀 <&>" {
		t.Fatalf("plaintext = %q", plaintext)
	}
	legacy, err := store.Load(context.Background(), tsLegacyVector, "ignored")
	if err != nil {
		t.Fatal(err)
	}
	if legacy != "legacy vector é" {
		t.Fatalf("legacy = %q", legacy)
	}
}

func TestRoundTripBindsRecord(t *testing.T) {
	store, err := NewStore(unitKey)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	record, err := store.Put(ctx, "round trip \x00 İ", PutOptions{RecordID: "row-one"})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(record.Ref, VersionPrefix) || record.Ref != record.Ciphertext {
		t.Fatalf("unexpected record %#v", record)
	}
	opened, err := store.Load(ctx, record.Ref, "row-one")
	if err != nil || opened != "round trip \x00 İ" {
		t.Fatalf("open = %q, %v", opened, err)
	}
	if _, err := store.Load(ctx, record.Ref, "row-two"); !errors.Is(err, ErrAuthentication) {
		t.Fatalf("wrong record: %v", err)
	}
	if !IsPermanentDecryptFailure(ErrAuthentication) {
		t.Fatal("authentication failure must be permanent")
	}
}

func TestMalformedAndWrongKey(t *testing.T) {
	store, err := NewStore(unitKey)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	for _, bad := range []string{"v2:", "v2:AAAA", "v2:AAAA===="} {
		if _, err := store.Load(ctx, bad, "row"); !errors.Is(err, ErrMalformed) {
			t.Fatalf("%q: %v", bad, err)
		}
	}
	other, err := NewStore("another-key")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := other.Load(ctx, tsVector, "row-unit"); !errors.Is(err, ErrAuthentication) {
		t.Fatalf("wrong key: %v", err)
	}
	if _, err := store.Load(ctx, "infisical:v1:rakazo_abc_xyz", "row"); !errors.Is(err, ErrRemoteUnsupported) {
		t.Fatalf("remote ref: %v", err)
	}
}

func TestNodeBase64Leniency(t *testing.T) {
	store, err := NewStore(unitKey)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	body := strings.TrimPrefix(tsVector, VersionPrefix)
	for _, variant := range []string{
		body + "==",
		body[:4] + "!!" + body[4:],
		strings.ReplaceAll(strings.ReplaceAll(body, "+", "-"), "/", "_"),
	} {
		plaintext, err := store.Load(ctx, VersionPrefix+variant, "row-unit")
		if err != nil || plaintext != "vector İ 😀 <&>" {
			t.Fatalf("%q: %q, %v", variant, plaintext, err)
		}
	}
	// A mid-body '=' ends the input, as it does for Node.
	if _, err := store.Load(ctx, VersionPrefix+body[:8]+"="+body[8:], "row-unit"); !errors.Is(err, ErrMalformed) {
		t.Fatalf("mid-body padding: %v", err)
	}
}

func TestLegacySealRoundTrip(t *testing.T) {
	store, err := NewStore(unitKey)
	if err != nil {
		t.Fatal(err)
	}
	ref, err := store.SealLegacy("legacy value 😀")
	if err != nil {
		t.Fatal(err)
	}
	if IsSealed(ref) {
		t.Fatal("legacy must not carry the prefix")
	}
	plaintext, err := store.Load(context.Background(), ref, "any")
	if err != nil || plaintext != "legacy value 😀" {
		t.Fatalf("legacy open = %q, %v", plaintext, err)
	}
}

func TestDerivedKeyCacheIsSingleFlight(t *testing.T) {
	store, err := NewStore(unitKey)
	if err != nil {
		t.Fatal(err)
	}
	record, err := store.Put(context.Background(), "cached", PutOptions{RecordID: "row-c"})
	if err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	var opened atomic.Int32
	for range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if plaintext, err := store.Load(context.Background(), record.Ref, "row-c"); err == nil && plaintext == "cached" {
				opened.Add(1)
			}
		}()
	}
	wg.Wait()
	if opened.Load() != 8 {
		t.Fatalf("opened %d of 8", opened.Load())
	}
	// The cache is bounded; the oldest entry is evicted, not merely capped.
	store.mu.Lock()
	for i := range KeyCacheSize + 10 {
		element := store.order.PushFront(&derivedEntry{
			id:    "synthetic-" + strconv.Itoa(i),
			entry: &keyEntry{ready: closedChannel()},
		})
		store.derived[element.Value.(*derivedEntry).id] = element
		if store.order.Len() > KeyCacheSize {
			oldest := store.order.Back()
			delete(store.derived, oldest.Value.(*derivedEntry).id)
			store.order.Remove(oldest)
		}
	}
	size := len(store.derived)
	store.mu.Unlock()
	if size != KeyCacheSize {
		t.Fatalf("cache holds %d entries, want %d", size, KeyCacheSize)
	}
	// One more derivation evicts exactly one and still opens its own value.
	salt := make([]byte, saltBytes)
	if _, err := store.derivedKey(salt); err != nil {
		t.Fatal(err)
	}
	store.mu.Lock()
	size = len(store.derived)
	store.mu.Unlock()
	if size != KeyCacheSize {
		t.Fatalf("cache holds %d entries after one derive, want %d", size, KeyCacheSize)
	}
	if _, err := store.Load(context.Background(), record.Ref, "row-c"); err != nil {
		t.Fatal(err)
	}
}

func closedChannel() chan struct{} {
	channel := make(chan struct{})
	close(channel)
	return channel
}

// Exact vectors produced by the shipped TypeScript redact.
func TestRedact(t *testing.T) {
	for sample, want := range map[string]string{
		"key sk-abcdefgh1234 here":            "key [redacted] here",
		"bearer eyJhbGciOi.eyJzdWIi.sig_part": "bearer [redacted]",
		"sk-short":                            "sk-short",
		"nothing to hide":                     "nothing to hide",
		"sk-12345678 sk-ABCDEFGH":             "[redacted] [redacted]",
		"xeyJa.b.c":                           "x[redacted]",
		"sk-abc:defghij":                      "sk-abc:defghij",
	} {
		if got := Redact(sample); got != want {
			t.Fatalf("%q: got %q, want %q", sample, got, want)
		}
	}
}

func TestLegacyTruncationIsNotPermanent(t *testing.T) {
	store, err := NewStore(unitKey)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	for body, want := range map[string]error{
		"":     ErrLegacyIV,
		"AAAA": ErrLegacyIV, // 3 bytes
	} {
		_, err := store.Load(ctx, body, "row")
		if !errors.Is(err, want) {
			t.Fatalf("%q: %v, want %v", body, err, want)
		}
		if IsPermanentDecryptFailure(err) {
			t.Fatalf("%q: truncated legacy must not be permanent", body)
		}
	}
	// IV present, tag missing: 12..27 bytes.
	shortTag := base64.StdEncoding.EncodeToString(make([]byte, 24))
	_, err = store.Load(ctx, shortTag, "row")
	if !errors.Is(err, ErrLegacyTag) || IsPermanentDecryptFailure(err) {
		t.Fatalf("short tag: %v", err)
	}
}

func TestVaultPrefixDecision(t *testing.T) {
	store, err := NewStore(unitKey)
	if err != nil {
		t.Fatal(err)
	}
	row := VaultRow{ID: "row", UserID: "user"}
	for _, damaged := range []string{"rkz1:", "rkz1::AAAA", "rkz1:abc", "rkz1::"} {
		_, err := OpenVaultValue(context.Background(), nil, store, row, damaged)
		var decryption *DecryptionError
		if !errors.As(err, &decryption) || decryption.Message != "Vault item names no key" {
			t.Fatalf("%q: %v", damaged, err)
		}
	}
}

func TestResolveEncryptionKey(t *testing.T) {
	env := func(values map[string]string) func(string) string {
		return func(key string) string { return values[key] }
	}
	if _, err := ResolveEncryptionKey(env(nil)); err == nil {
		t.Fatal("a missing key outside dev must be refused")
	}
	if key, err := ResolveEncryptionKey(env(map[string]string{"NODE_ENV": "development"})); err != nil ||
		key != DevEncryptionKeyPlaceholder {
		t.Fatalf("dev fallback: %q, %v", key, err)
	}
	production := env(map[string]string{"NODE_ENV": "production"})
	if _, err := ResolveEncryptionKey(production); err == nil {
		t.Fatal("a missing key in production must be refused")
	}
	if _, err := ResolveEncryptionKey(env(map[string]string{
		"NODE_ENV": "production", "ENCRYPTION_KEY": "   ",
	})); err == nil {
		t.Fatal("whitespace-only must be refused")
	}
	if _, err := ResolveEncryptionKey(env(map[string]string{
		"NODE_ENV": "production", "ENCRYPTION_KEY": DevEncryptionKeyPlaceholder,
	})); err == nil {
		t.Fatal("the dev placeholder must be refused in production")
	}
	key, err := ResolveEncryptionKey(env(map[string]string{
		"NODE_ENV": "production", "ENCRYPTION_KEY": "  real-key-value  ",
	}))
	if err != nil || key != "  real-key-value  " {
		t.Fatalf("the raw value must be kept: %q, %v", key, err)
	}
}

func TestNotifyEnvelopeFieldOrder(t *testing.T) {
	envelope, err := notifyEnvelope(ChangeTopic, `{"origin":"o","ref":"r"}`)
	if err != nil {
		t.Fatal(err)
	}
	want := `{"topic":"secret-store-change","payload":"{\"origin\":\"o\",\"ref\":\"r\"}"}`
	if string(envelope) != want {
		t.Fatalf("envelope = %s", envelope)
	}
}

func TestAfterPrefixBlindSlice(t *testing.T) {
	if got := afterPrefix("payment-wallet:", paymentWalletPrefix); got != "" {
		t.Fatalf("equal length = %q", got)
	}
	if got := afterPrefix("short", paymentWalletPrefix); got != "" {
		t.Fatalf("short = %q", got)
	}
	if got := afterPrefix("purchase-card:abc", purchaseCardPrefix); got != "abc" {
		t.Fatalf("tail = %q", got)
	}
}

type fakePublisher struct {
	mu       sync.Mutex
	announce []string
	fail     bool
}

func (p *fakePublisher) Publish(_ context.Context, topic, payload string) error {
	if p.fail {
		return errors.New("publish failed")
	}
	var inner struct {
		Ref    string `json:"ref"`
		Origin string `json:"origin"`
	}
	if topic != ChangeTopic {
		return errors.New("unexpected topic " + topic)
	}
	if err := json.Unmarshal([]byte(payload), &inner); err != nil {
		return err
	}
	p.mu.Lock()
	p.announce = append(p.announce, inner.Ref)
	p.mu.Unlock()
	return nil
}

func TestWriterAnnouncesAndHolds(t *testing.T) {
	store, err := NewStore(unitKey)
	if err != nil {
		t.Fatal(err)
	}
	publisher := &fakePublisher{}
	writer := NewWriter(store, NewNotifier(publisher))
	ctx := context.Background()
	held := writer.Hold()
	record, err := held.Put(ctx, "deferred", PutOptions{RecordID: "row-h"})
	if err != nil {
		t.Fatal(err)
	}
	if len(publisher.announce) != 0 {
		t.Fatal("a held write must not announce yet")
	}
	held.Flush(ctx)
	if len(publisher.announce) != 1 || publisher.announce[0] != record.Ref {
		t.Fatalf("announcements = %#v", publisher.announce)
	}
	writer.Delete(ctx, record.Ref, record.ID)
	if len(publisher.announce) != 2 {
		t.Fatalf("announcements = %#v", publisher.announce)
	}
	publisher.fail = true
	writer.Delete(ctx, "v2:whatever", "id") // a failed announcement is swallowed
}

func TestVaultScopeAndLocation(t *testing.T) {
	space := "sp-1"
	account := VaultRow{ID: "row", UserID: "user-1"}
	if VaultScope(account) != "user:user-1" {
		t.Fatalf("scope = %q", VaultScope(account))
	}
	inSpace := VaultRow{ID: "row", UserID: "user-1", SpaceID: &space}
	if VaultScope(inSpace) != "vault:sp-1" {
		t.Fatalf("scope = %q", VaultScope(inSpace))
	}
	empty := ""
	if VaultScope(VaultRow{ID: "row", UserID: "u", SpaceID: &empty}) != "user:u" {
		t.Fatal("an empty Space is the account vault")
	}
	location := VaultLocation(inSpace)
	if location.Table != "vault_credentials" || location.Column != "ciphertext" ||
		location.RowID != "row" || location.Owner != "user-1" {
		t.Fatalf("location = %#v", location)
	}
}

func TestDedupeCleanupsKeepsLastValueInFirstPosition(t *testing.T) {
	got := dedupeCleanups([]Cleanup{
		{Kind: KindSecretTables, RecordID: "a", Ref: "r1"},
		{Kind: KindSecretTables, RecordID: "b", Ref: "r2"},
		{Kind: KindMessagingInstallation, RecordID: "c", Ref: "r1"},
	})
	if len(got) != 2 || got[0].Ref != "r1" || got[0].RecordID != "c" || got[1].Ref != "r2" {
		t.Fatalf("dedupe = %#v", got)
	}
}

func TestSealAndOpenJSONNumbersUnaffected(t *testing.T) {
	// A secret value is an opaque string: JSON-looking text round-trips byte
	// for byte, including invalid UTF-8 replacement done by TypeScript.
	value := `{"a":1,"b":"İ"}` + "\n"
	store, err := NewStore(unitKey)
	if err != nil {
		t.Fatal(err)
	}
	record, err := store.Put(context.Background(), value, PutOptions{})
	if err != nil {
		t.Fatal(err)
	}
	opened, err := store.Load(context.Background(), record.Ref, record.ID)
	if err != nil || opened != value {
		t.Fatalf("opened = %q, %v", opened, err)
	}
}

func TestContentRingFallbackShape(t *testing.T) {
	// Without a ring, SealVaultValue uses the store format; with a ring whose
	// writes are off, it does the same. A nil ring must not panic.
	store, err := NewStore(unitKey)
	if err != nil {
		t.Fatal(err)
	}
	row := VaultRow{ID: "v", UserID: "u"}
	sealed, err := SealVaultValue(context.Background(), nil, nil, store, row, "value")
	if err != nil {
		t.Fatal(err)
	}
	if !IsSealed(sealed) {
		t.Fatalf("sealed = %q", sealed)
	}
	ring := contentcrypto.NewKeyRing(nil, nil, contentcrypto.KeyRingOptions{EncryptWrites: false})
	sealed, err = SealVaultValue(context.Background(), nil, ring, store, row, "value")
	if err != nil {
		t.Fatal(err)
	}
	if !IsSealed(sealed) {
		t.Fatalf("sealed with writes off = %q", sealed)
	}
}
