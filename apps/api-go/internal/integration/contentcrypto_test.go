package integration

import (
	"context"
	"errors"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/contentcrypto"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/effects"
)

const proofEncryptionKey = "integration-encryption-key-0123456789abcdef"

// keyedRing builds a ring the way the API process does, from the environment.
func keyedRing(t *testing.T, database *db.DB) *contentcrypto.KeyRing {
	t.Helper()
	masters, err := contentcrypto.MasterKeysFromEnv(func(name string) string {
		switch name {
		case "ENCRYPTION_KEY":
			return proofEncryptionKey
		case "ENCRYPTION_MASTER_KEYS":
			return "k1:" + strings.Repeat("ab", 32)
		}
		return ""
	})
	if err != nil {
		t.Fatalf("master keys: %v", err)
	}
	provider, err := contentcrypto.NewLocalKeyProvider(masters)
	if err != nil {
		t.Fatalf("provider: %v", err)
	}
	store, err := contentcrypto.OpenPgSpaceKeyStore(context.Background(), database)
	if err != nil {
		t.Fatalf("key store: %v", err)
	}
	t.Cleanup(store.Close)
	return contentcrypto.NewKeyRing(provider, store, contentcrypto.KeyRingOptions{EncryptWrites: true})
}

type cryptoFixture struct {
	userID, spaceID, botID, threadID string
}

func seedCryptoFixture(t *testing.T, database *db.DB) cryptoFixture {
	t.Helper()
	suffix := strconv.FormatInt(time.Now().UnixNano(), 36)
	fixture := cryptoFixture{
		userID:   "u-cc-" + suffix,
		spaceID:  "sp-cc-" + suffix,
		botID:    "bot-cc-" + suffix,
		threadID: "th-cc-" + suffix,
	}
	ctx := context.Background()
	err := database.System(ctx, "seed content crypto fixture", func(tx pgx.Tx) error {
		orgID := "org-cc-" + suffix
		steps := []struct {
			sql  string
			args []any
		}{
			{`INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
			  VALUES ($1, 'Crypto User', $2, true, now(), now())`, []any{fixture.userID, fixture.userID + "@example.test"}},
			{`INSERT INTO organization (id, name, slug, "createdAt") VALUES ($1, 'Crypto Org', $2, now())`,
				[]any{orgID, "org-cc-" + suffix}},
			{`INSERT INTO spaces (id, "organizationId", name, "isDefault", "createdAt")
			  VALUES ($1, $2, 'Crypto Space', true, now())`, []any{fixture.spaceID, orgID}},
			{`INSERT INTO bots (id, "spaceId", "userId", name, color, "createdAt", "updatedAt")
			  VALUES ($1, $2, $3, 'Crypto Bot', 'blue', now(), now())`,
				[]any{fixture.botID, fixture.spaceID, fixture.userID}},
			{`INSERT INTO threads (id, "spaceId", "userId", "botId", "createdAt")
			  VALUES ($1, $2, $3, $4, now())`,
				[]any{fixture.threadID, fixture.spaceID, fixture.userID, fixture.botID}},
		}
		for _, step := range steps {
			if _, err := tx.Exec(ctx, step.sql, step.args...); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		t.Fatalf("seed: %v", err)
	}
	return fixture
}

func TestContentKeyRingSealsAndOpensRows(t *testing.T) {
	database := openTestDB(t)
	fixture := seedCryptoFixture(t, database)
	ring := keyedRing(t, database)
	ctx := context.Background()

	key, err := ring.Current(ctx, fixture.spaceID)
	if err != nil {
		t.Fatalf("current key: %v", err)
	}
	if key.Version != 1 || len(key.Key) != 32 {
		t.Fatalf("first key = version %d, %d bytes", key.Version, len(key.Key))
	}
	keys, err := ring.All(ctx, fixture.spaceID)
	if err != nil || len(keys) != 1 {
		t.Fatalf("all keys = %d, %v", len(keys), err)
	}

	threadRow := map[string]any{
		"id":                       fixture.threadID,
		"spaceId":                  fixture.spaceID,
		"userId":                   fixture.userID,
		"historyCompactionSummary": "summary İ 😀",
	}
	sealed, err := ring.SealRow(ctx, "Thread", threadRow)
	if err != nil {
		t.Fatalf("seal thread: %v", err)
	}
	summary, ok := sealed["historyCompactionSummary"].(string)
	if !ok || !contentcrypto.IsCiphertext(summary) {
		t.Fatalf("summary not sealed: %#v", sealed["historyCompactionSummary"])
	}
	err = database.System(ctx, "write sealed thread", func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `UPDATE threads SET "historyCompactionSummary" = $2 WHERE id = $1`,
			fixture.threadID, summary)
		return err
	})
	if err != nil {
		t.Fatalf("write: %v", err)
	}

	// A fresh ring with no cached keys must unwrap the stored space key and open
	// the ciphertext, as a restarted process does.
	fresh := keyedRing(t, database)
	row := map[string]any{}
	var rowID, rowSpaceID, rowUserID, rowSummary string
	err = database.System(ctx, "read sealed thread", func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT id, "spaceId", "userId", "historyCompactionSummary"
			FROM threads WHERE id = $1`, fixture.threadID).
			Scan(&rowID, &rowSpaceID, &rowUserID, &rowSummary)
	})
	row["id"], row["spaceId"], row["userId"], row["historyCompactionSummary"] =
		rowID, rowSpaceID, rowUserID, rowSummary
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if err := fresh.OpenRows(ctx, "Thread", []map[string]any{row}); err != nil {
		t.Fatalf("open: %v", err)
	}
	if row["historyCompactionSummary"] != "summary İ 😀" {
		t.Fatalf("opened summary = %#v", row["historyCompactionSummary"])
	}

	// The AAD binds the row, its owner and its Space: any move fails.
	for name, moved := range map[string]map[string]any{
		"row":   {"id": fixture.threadID + "-other", "spaceId": fixture.spaceID, "userId": fixture.userID, "historyCompactionSummary": summary},
		"owner": {"id": fixture.threadID, "spaceId": fixture.spaceID, "userId": fixture.userID + "-other", "historyCompactionSummary": summary},
	} {
		t.Run("moved "+name, func(t *testing.T) {
			if err := fresh.OpenRows(ctx, "Thread", []map[string]any{moved}); !errors.Is(err, contentcrypto.ErrDecryption) {
				t.Fatalf("error = %v, want a decryption failure", err)
			}
		})
	}
}

func TestContentKeyRingBlindIndexAndRotation(t *testing.T) {
	database := openTestDB(t)
	fixture := seedCryptoFixture(t, database)
	ring := keyedRing(t, database)
	ctx := context.Background()

	blocks := []any{
		map[string]any{"kind": "text", "text": "Pelican İstanbul 😀 report", "status": "done"},
		map[string]any{"kind": "steps", "steps": []any{map[string]any{"label": "Search the web", "note": "found pelican"}}},
	}
	row := map[string]any{
		"id":          effects.NewID(),
		"threadId":    fixture.threadID,
		"blocks":      blocks,
		"toolHistory": `{"calls":[]}`,
	}
	sealed, err := ring.SealRow(ctx, "Message", row)
	if err != nil {
		t.Fatalf("seal message: %v", err)
	}
	tokens, ok := sealed["searchTokens"].([]int32)
	if !ok || len(tokens) == 0 {
		t.Fatalf("searchTokens = %#v", sealed["searchTokens"])
	}
	key, err := ring.Current(ctx, fixture.spaceID)
	if err != nil {
		t.Fatalf("current: %v", err)
	}
	wanted := contentcrypto.QuerySearchTokens(key, "pelican", contentcrypto.DomainWord)
	have := map[int32]bool{}
	for _, token := range tokens {
		have[token] = true
	}
	for _, token := range wanted {
		if !have[token] {
			t.Fatalf("word token %d missing", token)
		}
	}
	prefixes := contentcrypto.QuerySearchTokens(key, "peli rep", contentcrypto.DomainPrefix)
	for _, token := range prefixes {
		if !have[token] {
			t.Fatalf("prefix token %d missing", token)
		}
	}

	// Rotation adds a version; the old ciphertext still opens and new writes use
	// the new key.
	rotated, err := ring.Rotate(ctx, fixture.spaceID)
	if err != nil {
		t.Fatalf("rotate: %v", err)
	}
	if rotated.Version != 2 {
		t.Fatalf("rotated version = %d", rotated.Version)
	}
	oldCiphertext := sealed["toolHistory"].(string)
	opened, err := contentcrypto.DecryptText(key, contentcrypto.Location{
		Table: "messages", Column: "toolHistory", RowID: row["id"].(string), Owner: fixture.threadID,
	}, oldCiphertext)
	if err != nil || opened != `{"calls":[]}` {
		t.Fatalf("old version = %q, %v", opened, err)
	}
	next, err := ring.SealRow(ctx, "Message", map[string]any{
		"id": effects.NewID(), "threadId": fixture.threadID, "blocks": blocks,
	})
	if err != nil {
		t.Fatalf("seal after rotation: %v", err)
	}
	newCiphertext := next["blocks"].([]any)[0].(map[string]any)["$sealed"].(string)
	if id, _ := contentcrypto.CiphertextKeyID(newCiphertext); id != rotated.ID {
		t.Fatalf("new ciphertext names key %q, want %q", id, rotated.ID)
	}
}

func TestContentKeyRingReportsUnreadableMasterKeys(t *testing.T) {
	database := openTestDB(t)
	fixture := seedCryptoFixture(t, database)
	ring := keyedRing(t, database)
	if _, err := ring.Current(context.Background(), fixture.spaceID); err != nil {
		t.Fatalf("create key: %v", err)
	}
	masters, err := contentcrypto.MasterKeysFromEnv(func(name string) string {
		if name == "ENCRYPTION_KEY" {
			return proofEncryptionKey
		}
		return "k9:" + strings.Repeat("cd", 32)
	})
	if err != nil {
		t.Fatalf("master keys: %v", err)
	}
	provider, err := contentcrypto.NewLocalKeyProvider(masters)
	if err != nil {
		t.Fatalf("provider: %v", err)
	}
	otherStore, err := contentcrypto.OpenPgSpaceKeyStore(context.Background(), database)
	if err != nil {
		t.Fatalf("key store: %v", err)
	}
	t.Cleanup(otherStore.Close)
	other := contentcrypto.NewKeyRing(provider, otherStore, contentcrypto.KeyRingOptions{EncryptWrites: true})
	keys := other.UnreadableMasterKeys(context.Background())
	found := false
	for _, id := range keys {
		if id == "k1" {
			found = true
		}
	}
	if !found {
		t.Fatalf("unreadable master keys = %v, want k1", keys)
	}
}
