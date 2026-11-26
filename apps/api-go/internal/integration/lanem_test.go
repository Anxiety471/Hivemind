package integration

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/contentcrypto"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/effects"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/local"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/orpc"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/shared"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/vaultitems"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/vaultstore"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/secretstore"
)

const laneMVaultKey = "integration-lane-m-encryption-key-0123456789"

// laneMVault is the deployment a vault procedure needs: the announcing writer and the
// persistence hook over the test fixture.
func laneMVault(t *testing.T, database *db.DB) shared.Deployment {
	t.Helper()
	store, err := secretstore.NewStore(laneMVaultKey)
	if err != nil {
		t.Fatalf("secret store: %v", err)
	}
	writer := secretstore.NewWriter(store, nil)
	return shared.Deployment{Vault: &shared.SecretVault{
		Writer:      writer,
		Persistence: secretstore.NewPersistence(database, writer),
	}}
}

// sealLaneM seals a seeded value the way the API writes it before any vault key exists.
func sealLaneM(t *testing.T, plaintext, recordID string) string {
	t.Helper()
	store, err := secretstore.NewStore(laneMVaultKey)
	if err != nil {
		t.Fatalf("secret store: %v", err)
	}
	record, err := store.Put(context.Background(), plaintext, secretstore.PutOptions{RecordID: recordID})
	if err != nil {
		t.Fatalf("seal: %v", err)
	}
	return record.Ciphertext
}

// changeRecorder captures the refs a write announces on `secret-store-change`.
type changeRecorder struct {
	mu   sync.Mutex
	refs []string
}

func (r *changeRecorder) Publish(_ context.Context, _ string, payload string) error {
	var event struct {
		Ref string `json:"ref"`
	}
	if err := json.Unmarshal([]byte(payload), &event); err != nil {
		return err
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	r.refs = append(r.refs, event.Ref)
	return nil
}

func (r *changeRecorder) RefKinds() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	kinds := []string{}
	for _, ref := range r.refs {
		switch {
		case strings.HasPrefix(ref, "rkz1:"):
			kinds = append(kinds, "<rkz1>")
		case strings.HasPrefix(ref, "v2:"):
			kinds = append(kinds, "<v2>")
		default:
			kinds = append(kinds, "<ref>")
		}
	}
	sort.Strings(kinds)
	return kinds
}

func laneMVaultAnnouncing(t *testing.T, database *db.DB, recorder *changeRecorder) shared.Deployment {
	t.Helper()
	store, err := secretstore.NewStore(laneMVaultKey)
	if err != nil {
		t.Fatalf("secret store: %v", err)
	}
	writer := secretstore.NewWriter(store, secretstore.NewNotifier(recorder))
	master := sha256.Sum256([]byte(laneMVaultKey))
	provider, err := contentcrypto.NewLocalKeyProvider([]contentcrypto.MasterKey{
		{ID: contentcrypto.DerivedMasterKeyID, Key: master[:]},
	})
	if err != nil {
		t.Fatalf("key provider: %v", err)
	}
	spaceKeys, err := contentcrypto.OpenPgSpaceKeyStore(context.Background(), database)
	if err != nil {
		t.Fatalf("space key store: %v", err)
	}
	t.Cleanup(spaceKeys.Close)
	return shared.Deployment{
		Vault: &shared.SecretVault{
			Writer:      writer,
			Persistence: secretstore.NewPersistence(database, writer),
		},
		Content: contentcrypto.NewKeyRing(provider, spaceKeys, contentcrypto.KeyRingOptions{EncryptWrites: true}),
	}
}

// TestLaneMVaultAnnouncements is the change-notification contract: a value sealed under a vault key
// announces nothing while it is written (the key holds the value), a refused write announces only
// the dropped value, and a legacy-envelope write announces the value it replaced.
func TestLaneMVaultAnnouncements(t *testing.T) {
	database := openTestDB(t)
	s := seed(t, database)
	ctx := context.Background()
	actor := db.Actor{UserID: s.UserID, SpaceID: s.Space1, SessionID: s.SessionID}
	recorder := &changeRecorder{}
	deployment := laneMVaultAnnouncing(t, database, recorder)
	// A Space gets its key the first time its vault is opened; until then a value takes the
	// legacy envelope, which the store announces.
	if _, err := deployment.Content.Current(ctx, "user:"+s.UserID); err != nil {
		t.Fatalf("space key: %v", err)
	}

	if _, failure := vaultstore.VaultPut(ctx, database, deployment, actor, laneMInput(t, `{
		"destination": {"name":"api","origin":"https://example.test","auth":{"type":"bearer"}},
		"value": "sealed-token"
	}`)); failure != nil {
		t.Fatalf("put: %+v", failure)
	}
	if kinds := recorder.RefKinds(); len(kinds) != 0 {
		t.Fatalf("a value under a vault key announced %v", kinds)
	}
	// A write refused after the value was sealed announces the value it drops.
	_, failure := vaultstore.VaultPut(ctx, database, deployment, actor, laneMInput(t, `{
		"destination": {"name":"api","origin":"https://example.test","auth":{"type":"bearer"}},
		"value": "token-value",
		"botIds": ["missing"]
	}`))
	if got := laneMFailure(t, failure); got.Code != "BAD_REQUEST" || got.Message != "Choose from your bots in this Space" {
		t.Fatalf("refused write = %+v", got)
	}
	if kinds := recorder.RefKinds(); len(kinds) != 1 || kinds[0] != "<rkz1>" {
		t.Fatalf("refused write announced %v", kinds)
	}
	// A legacy row is replaced: the envelope it dropped is announced, the keyed one is not.
	id := s.UserID + "-legacy"
	addLaneMVault(t, database, s.UserID, nil, laneMVaultRow{
		ID: id, Name: "legacy", Ciphertext: sealLaneM(t, "old", id),
	})
	recorder.mu.Lock()
	recorder.refs = nil
	recorder.mu.Unlock()
	if _, failure := vaultstore.VaultPut(ctx, database, deployment, actor, laneMInput(t, `{
		"destination": {"name":"legacy","origin":"https://example.test","auth":{"type":"bearer"}},
		"value": "new"
	}`)); failure != nil {
		t.Fatalf("legacy put: %+v", failure)
	}
	if kinds := recorder.RefKinds(); len(kinds) != 1 || kinds[0] != "<v2>" {
		t.Fatalf("legacy overwrite announced %v", kinds)
	}
	// The legacy value that was dropped no longer opens: the row holds the keyed one now.
	rows := laneMRows(t, database, s.UserID)
	for _, row := range rows {
		if row.Name == "legacy" && !strings.HasPrefix(row.Ciphertext, "rkz1:") {
			t.Fatalf("legacy overwrite wrote %q", row.Ciphertext[:8])
		}
	}
}

type laneMVaultRow struct {
	ID         string
	SpaceID    *string
	Name       string
	Origin     string
	Auth       []byte
	Title      string
	Note       string
	Policy     string
	AlsoOn     []string
	Ciphertext string
	CreatedAt  time.Time
	UpdatedAt  time.Time
}

func addLaneMVault(t *testing.T, database *db.DB, userID string, spaceID *string, row laneMVaultRow) {
	t.Helper()
	if row.ID == "" {
		row.ID = userID + "-vault-row"
	}
	if row.Name == "" {
		row.Name = "saved"
	}
	if row.Origin == "" {
		row.Origin = "https://example.test"
	}
	if len(row.Auth) == 0 {
		row.Auth = []byte(`{"type":"bearer"}`)
	}
	if row.Policy == "" {
		row.Policy = "allow"
	}
	if row.AlsoOn == nil {
		row.AlsoOn = []string{}
	}
	if row.CreatedAt.IsZero() {
		row.CreatedAt = time.Now().UTC().Truncate(time.Millisecond)
	}
	if row.UpdatedAt.IsZero() {
		row.UpdatedAt = row.CreatedAt
	}
	err := database.System(context.Background(), "seed a vault row", func(tx pgx.Tx) error {
		_, err := tx.Exec(context.Background(), `INSERT INTO vault_credentials
			(id, "userId", "spaceId", name, origin, auth, ciphertext, title, note, policy, "alsoOn",
			 "createdAt", "updatedAt")
			VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11, $12, $13)`,
			row.ID, userID, row.SpaceID, row.Name, row.Origin, string(row.Auth), row.Ciphertext,
			row.Title, row.Note, row.Policy, row.AlsoOn, row.CreatedAt, row.UpdatedAt)
		return err
	})
	if err != nil {
		t.Fatalf("seed vault row: %v", err)
	}
}

func laneMRows(t *testing.T, database *db.DB, userID string) []laneMVaultRow {
	t.Helper()
	rows := []laneMVaultRow{}
	err := database.System(context.Background(), "read vault rows", func(tx pgx.Tx) error {
		results, err := tx.Query(context.Background(), `SELECT id, "spaceId", name, origin, auth,
			title, note, policy, "alsoOn", ciphertext, "createdAt", "updatedAt"
			FROM vault_credentials WHERE "userId" = $1 ORDER BY name ASC`, userID)
		if err != nil {
			return err
		}
		defer results.Close()
		for results.Next() {
			var row laneMVaultRow
			if err := results.Scan(&row.ID, &row.SpaceID, &row.Name, &row.Origin, &row.Auth,
				&row.Title, &row.Note, &row.Policy, &row.AlsoOn, &row.Ciphertext,
				&row.CreatedAt, &row.UpdatedAt); err != nil {
				return err
			}
			rows = append(rows, row)
		}
		return results.Err()
	})
	if err != nil {
		t.Fatalf("read vault rows: %v", err)
	}
	return rows
}

func laneMInput(t *testing.T, text string) orpc.Input {
	t.Helper()
	if !json.Valid([]byte(text)) {
		t.Fatalf("test input is not JSON: %s", text)
	}
	return orpc.Input{Raw: json.RawMessage(text)}
}

func laneMFailure(t *testing.T, failure *orpc.Error) *orpc.Error {
	t.Helper()
	if failure == nil {
		t.Fatal("expected a failure")
	}
	return failure
}

// TestLaneMVaultPutSealsAndRecords is the write path end to end: the value is sealed with the
// vault key the deployment holds, the row is readable through OpenVaultValue, and the audited
// security event is recorded.
func TestLaneMVaultPutSealsAndRecords(t *testing.T) {
	database := openTestDB(t)
	s := seed(t, database)
	ctx := context.Background()
	actor := db.Actor{UserID: s.UserID, SpaceID: s.Space1, SessionID: s.SessionID}
	deployment := laneMVault(t, database)
	deployment.Audit = effects.NewRecorder(database, nil)

	result, failure := vaultstore.VaultPut(ctx, database, deployment, actor, laneMInput(t, `{
		"destination": {"name":"api","origin":"https://www.example.test","auth":{"type":"bearer"}},
		"value": "sealed-token",
		"title": "  My API  ",
		"note": "for tests"
	}`))
	if failure != nil {
		t.Fatalf("vault.put: %+v", failure)
	}
	item, ok := result.(vaultitems.Metadata)
	if !ok {
		t.Fatalf("result = %#v", result)
	}
	if item.Name != "api" || item.Origin != "https://www.example.test" {
		t.Fatalf("item = %#v", item)
	}
	// No bot choice means every bot may use it, as listVaultItems reports an unlimited item.
	if item.Title != "My API" || item.Note != "for tests" || !item.AllBots {
		t.Fatalf("labels = %#v", item)
	}
	rows := laneMRows(t, database, s.UserID)
	if len(rows) != 1 {
		t.Fatalf("rows = %d", len(rows))
	}
	row := rows[0]
	if row.SpaceID != nil {
		t.Fatalf("an unqualified put landed in the space vault: %v", *row.SpaceID)
	}
	plaintext, err := secretstore.OpenVaultValue(ctx, nil, deployment.Vault.Writer,
		secretstore.VaultRow{ID: row.ID, UserID: s.UserID}, row.Ciphertext)
	if err != nil {
		t.Fatalf("open the written row: %v", err)
	}
	if plaintext != "sealed-token" {
		t.Fatalf("plaintext = %q", plaintext)
	}
	// The same row does not open under another record id: the ciphertext is bound to it.
	if _, err := secretstore.OpenVaultValue(ctx, nil, deployment.Vault.Writer,
		secretstore.VaultRow{ID: row.ID + "-other", UserID: s.UserID}, row.Ciphertext); err == nil {
		t.Fatal("the value opened under another record id")
	}
	var events int
	if err := database.System(ctx, "count security events", func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT count(*)::int FROM security_events
			WHERE "userId" = $1 AND type = 'credential.changed'`, s.UserID).Scan(&events)
	}); err != nil {
		t.Fatal(err)
	}
	if events != 1 {
		t.Fatalf("security events = %d", events)
	}
	// The account-vault event is its person's own: one row in their own organization, naming the item.
	var organization, metadata string
	if err := database.System(ctx, "read the audit row", func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT "organizationId", metadata::text FROM audit_events
			WHERE "actorId" = $1 AND action = 'credential.changed'`, s.UserID).
			Scan(&organization, &metadata)
	}); err != nil {
		t.Fatalf("audit row: %v", err)
	}
	if organization != s.OrgID || !strings.Contains(metadata, `"name": "api"`) {
		t.Fatalf("audit row = %s %s", organization, metadata)
	}
}

// TestLaneMVaultPutRefusesBeforeWriting is the destination and limit refusals: the message is the
// TypeScript one and nothing is written.
func TestLaneMVaultPutRefusesBeforeWriting(t *testing.T) {
	database := openTestDB(t)
	s := seed(t, database)
	ctx := context.Background()
	actor := db.Actor{UserID: s.UserID, SpaceID: s.Space1, SessionID: s.SessionID}
	deployment := laneMVault(t, database)

	_, failure := vaultstore.VaultPut(ctx, database, deployment, actor, laneMInput(t, `{
		"destination": {"name":"api","origin":"https://example.test","auth":{"type":"bearer"}},
		"value": "x"
	}`))
	if failure != nil {
		t.Fatalf("first put: %+v", failure)
	}
	_, failure = vaultstore.VaultPut(ctx, database, deployment, actor, laneMInput(t, `{
		"destination": {"name":"api","origin":"https://elsewhere.example.test","auth":{"type":"bearer"}},
		"value": "x"
	}`))
	if got := laneMFailure(t, failure); got.Code != "BAD_REQUEST" ||
		got.Message != "Remove the existing credential before changing its destination" {
		t.Fatalf("destination change = %+v", got)
	}
	for index := 1; index < 100; index++ {
		suffix := fmt.Sprintf("%03d", index)
		addLaneMVault(t, database, s.UserID, nil, laneMVaultRow{
			ID:   s.UserID + "-fill-" + suffix,
			Name: "fill-" + suffix,
		})
	}
	_, failure = vaultstore.VaultPut(ctx, database, deployment, actor, laneMInput(t, `{
		"destination": {"name":"one-more","origin":"https://example.test","auth":{"type":"bearer"}},
		"value": "x"
	}`))
	if got := laneMFailure(t, failure); got.Code != "BAD_REQUEST" || got.Message != "Credential limit reached" {
		t.Fatalf("limit = %+v", got)
	}
	if rows := laneMRows(t, database, s.UserID); len(rows) != 100 {
		t.Fatalf("rows after the refused writes = %d", len(rows))
	}
}

// TestLaneMVaultPutSpaceScope checks assertVaultInUse and the column the row lands in.
func TestLaneMVaultPutSpaceScope(t *testing.T) {
	database := openTestDB(t)
	s := seed(t, database)
	ctx := context.Background()
	actor := db.Actor{UserID: s.UserID, SpaceID: s.Space1, SessionID: s.SessionID}
	deployment := laneMVault(t, database)
	input := laneMInput(t, `{"scope":"space",
		"destination": {"name":"api","origin":"https://example.test","auth":{"type":"bearer"}},
		"value": "space-token"}`)

	_, failure := vaultstore.VaultPut(ctx, database, deployment, actor, input)
	if got := laneMFailure(t, failure); got.Code != "BAD_REQUEST" ||
		got.Message != "This Space uses the account vault" {
		t.Fatalf("without an override = %+v", got)
	}
	err := database.System(ctx, "seed the override", func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `INSERT INTO space_setting_overrides ("spaceId", "userId", setting, "createdAt")
			VALUES ($1, $2, 'credentials', now())`, s.Space1, s.UserID)
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, failure := vaultstore.VaultPut(ctx, database, deployment, actor, input); failure != nil {
		t.Fatalf("with the override: %+v", failure)
	}
	rows := laneMRows(t, database, s.UserID)
	if len(rows) != 1 || rows[0].SpaceID == nil || *rows[0].SpaceID != s.Space1 {
		t.Fatalf("rows = %#v", rows)
	}
	if _, failure := vaultstore.VaultPut(ctx, database, deployment, actor,
		laneMInput(t, `{"scope":"account",
			"destination": {"name":"account-api","origin":"https://example.test","auth":{"type":"bearer"}},
			"value": "account-token"}`)); failure != nil {
		t.Fatalf("account scope with an override: %+v", failure)
	}
	rows = laneMRows(t, database, s.UserID)
	if len(rows) != 2 {
		t.Fatalf("rows = %d", len(rows))
	}
	for _, row := range rows {
		if row.Name == "account-api" && row.SpaceID != nil {
			t.Fatalf("an account write landed in the space vault")
		}
	}
}

// TestLaneMVaultRelabelKeepsTheValue is the relabel-only path: the ciphertext and destination
// stay, the labels change, and an absent item is a 404 rather than a 409 from the DTO read.
func TestLaneMVaultRelabelKeepsTheValue(t *testing.T) {
	database := openTestDB(t)
	s := seed(t, database)
	ctx := context.Background()
	actor := db.Actor{UserID: s.UserID, SpaceID: s.Space1, SessionID: s.SessionID}
	deployment := laneMVault(t, database)
	id := s.UserID + "-saved"
	addLaneMVault(t, database, s.UserID, nil, laneMVaultRow{
		ID: id, Name: "saved", Ciphertext: sealLaneM(t, "keep-me", id),
		Title: "Kept", Note: "Kept note", Policy: "ask",
	})
	before := laneMRows(t, database, s.UserID)

	_, failure := vaultstore.VaultPut(ctx, database, deployment, actor,
		laneMInput(t, `{"destination":{"name":"saved","origin":"https://example.test","auth":{"type":"bearer"}},"title":"  New title  ","policy":"off"}`))
	if failure != nil {
		t.Fatalf("relabel: %+v", failure)
	}
	after := laneMRows(t, database, s.UserID)
	if len(after) != 1 {
		t.Fatalf("rows = %d", len(after))
	}
	if after[0].Ciphertext != before[0].Ciphertext {
		t.Fatal("a relabel rewrote the value")
	}
	if after[0].Title != "New title" || after[0].Policy != "off" || after[0].Note != "Kept note" {
		t.Fatalf("labels = %#v", after[0])
	}
	_, failure = vaultstore.VaultPut(ctx, database, deployment, actor,
		laneMInput(t, `{"destination":{"name":"absent","origin":"https://example.test","auth":{"type":"bearer"}},"title":"x"}`))
	if got := laneMFailure(t, failure); got.Code != "NOT_FOUND" || got.Message != "Credential not found" {
		t.Fatalf("absent relabel = %+v", got)
	}
	_, failure = vaultstore.VaultPut(ctx, database, deployment, actor,
		laneMInput(t, `{"destination":{"origin":"https://example.test","auth":{"type":"bearer"}},"title":"x"}`))
	if got := laneMFailure(t, failure); got.Code != "BAD_REQUEST" || got.Message != "A new item needs its value" {
		t.Fatalf("nameless relabel = %+v", got)
	}
}

// TestLaneMVaultLoginKeepsItsKey is the authenticator-key keep and clear rule.
func TestLaneMVaultLoginKeepsItsKey(t *testing.T) {
	database := openTestDB(t)
	s := seed(t, database)
	ctx := context.Background()
	actor := db.Actor{UserID: s.UserID, SpaceID: s.Space1, SessionID: s.SessionID}
	deployment := laneMVault(t, database)
	id := s.UserID + "-login"
	stored := `{"fields":[{"label":"Username","value":"u","hidden":false}],"otp":"JBSWY3DPEHPK3PXP"}`
	addLaneMVault(t, database, s.UserID, nil, laneMVaultRow{
		ID: id, Name: "login", Origin: "https://login.example.test",
		Auth: []byte(`{"type":"login"}`), Ciphertext: sealLaneM(t, stored, id),
	})
	put := func(value string) string {
		t.Helper()
		quoted, err := json.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		_, failure := vaultstore.VaultPut(ctx, database, deployment, actor,
			laneMInput(t, `{"destination":{"name":"login","origin":"https://login.example.test","auth":{"type":"login"}},"value":`+string(quoted)+`}`))
		if failure != nil {
			t.Fatalf("put %s: %+v", value, failure)
		}
		rows := laneMRows(t, database, s.UserID)
		plaintext, err := secretstore.OpenVaultValue(ctx, nil, deployment.Vault.Writer,
			secretstore.VaultRow{ID: rows[0].ID, UserID: s.UserID}, rows[0].Ciphertext)
		if err != nil {
			t.Fatalf("open: %v", err)
		}
		return plaintext
	}
	kept := put(`{"fields":[{"label":"Username","value":"u","hidden":false},{"label":"Password","value":"p","hidden":true}]}`)
	if !strings.Contains(kept, `"otp":"JBSWY3DPEHPK3PXP"`) {
		t.Fatalf("saved without otp kept no key: %s", kept)
	}
	cleared := put(`{"fields":[{"label":"Username","value":"u","hidden":false}],"otp":""}`)
	if strings.Contains(cleared, `"otp"`) {
		t.Fatalf("an empty key did not clear the saved one: %s", cleared)
	}
}

// TestLaneMVaultRevealNeedsConfirmation is the step-up gate and the reveal shapes.
func TestLaneMVaultRevealNeedsConfirmation(t *testing.T) {
	database := openTestDB(t)
	s := seed(t, database)
	ctx := context.Background()
	actor := db.Actor{UserID: s.UserID, SpaceID: s.Space1, SessionID: s.SessionID}
	deployment := laneMVault(t, database)
	id := s.UserID + "-login"
	stored := `{"fields":[{"label":"Username","value":"u","hidden":false}],"otp":"JBSWY3DPEHPK3PXP"}`
	addLaneMVault(t, database, s.UserID, nil, laneMVaultRow{
		ID: id, Name: "login", Origin: "https://login.example.test",
		Auth: []byte(`{"type":"login"}`), Ciphertext: sealLaneM(t, stored, id),
	})
	input := laneMInput(t, `{"name":"login"}`)
	_, failure := vaultstore.VaultReveal(ctx, database, deployment, actor, input)
	if got := laneMFailure(t, failure); got.Code != "IDENTITY_CONFIRMATION_REQUIRED" {
		t.Fatalf("without confirmation = %+v", got)
	}
	err := database.System(ctx, "confirm identity", func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `INSERT INTO verification (id, identifier, value, "expiresAt", "createdAt", "updatedAt")
			VALUES ($1, $2, $3, now() + interval '5 minutes', now(), now())`,
			s.UserID+"-confirmation", "identity-confirmed-"+s.SessionID, s.UserID)
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	result, failure := vaultstore.VaultReveal(ctx, database, deployment, actor, input)
	if failure != nil {
		t.Fatalf("reveal: %+v", failure)
	}
	body, err := json.Marshal(result)
	if err != nil {
		t.Fatal(err)
	}
	if string(body) != `{"fields":[{"label":"Username","value":"u","hidden":false}],"otp":"JBSWY3DPEHPK3PXP"}` {
		t.Fatalf("revealed = %s", body)
	}
}

// TestLaneMIdentityConfirmationReadsNewestRow is findVerificationValue's row choice and cleanup
// (better-auth internal-adapter.mjs:789-804): the newest verification row for the identifier is
// the proof — so a newer expired row hides an older valid one — and every expired verification
// row is deleted on each lookup.
func TestLaneMIdentityConfirmationReadsNewestRow(t *testing.T) {
	database := openTestDB(t)
	s := seed(t, database)
	ctx := context.Background()
	actor := db.Actor{UserID: s.UserID, SpaceID: s.Space1, SessionID: s.SessionID}
	deployment := laneMVault(t, database)
	id := s.UserID + "-login"
	addLaneMVault(t, database, s.UserID, nil, laneMVaultRow{
		ID: id, Name: "login", Origin: "https://login.example.test",
		Auth: []byte(`{"type":"login"}`), Ciphertext: sealLaneM(t, `{"fields":[{"label":"Username","value":"u","hidden":false}]}`, id),
	})
	input := laneMInput(t, `{"name":"login"}`)
	identifier := "identity-confirmed-" + s.SessionID
	rows := func(t *testing.T) []string {
		t.Helper()
		var ids []string
		err := database.System(ctx, "read verification rows", func(tx pgx.Tx) error {
			result, failure := tx.Query(ctx, `SELECT id FROM verification WHERE identifier = $1 ORDER BY id`, identifier)
			if failure != nil {
				return failure
			}
			defer result.Close()
			for result.Next() {
				var rowID string
				if err := result.Scan(&rowID); err != nil {
					return err
				}
				ids = append(ids, rowID)
			}
			return result.Err()
		})
		if err != nil {
			t.Fatal(err)
		}
		return ids
	}
	insert := func(t *testing.T, rowID, created, expires string) {
		t.Helper()
		err := database.System(ctx, "seed a verification row", func(tx pgx.Tx) error {
			_, err := tx.Exec(ctx, `INSERT INTO verification (id, identifier, value, "expiresAt", "createdAt", "updatedAt")
				VALUES ($1, $2, $3, `+expires+`, `+created+`, `+created+`)`, rowID, identifier, s.UserID)
			return err
		})
		if err != nil {
			t.Fatal(err)
		}
	}

	// Newest wins: an older row that has expired is not the proof, and the lookup then deletes it.
	insert(t, s.UserID+"-confirmation-old", "now() - interval '2 hours'", "now() - interval '1 hour'")
	insert(t, s.UserID+"-confirmation-new", "now()", "now() + interval '5 minutes'")
	if _, failure := vaultstore.VaultReveal(ctx, database, deployment, actor, input); failure != nil {
		t.Fatalf("newest valid row should confirm: %+v", failure)
	}
	if left := rows(t); len(left) != 1 || left[0] != s.UserID+"-confirmation-new" {
		t.Fatalf("expired row after a valid confirmation = %v", left)
	}

	// The same rule denies: a newer expired row hides the older valid one TypeScript never reads.
	insert(t, s.UserID+"-confirmation-valid", "now() - interval '2 hours'", "now() + interval '1 year'")
	if _, failure := vaultstore.VaultReveal(ctx, database, deployment, actor, input); failure != nil {
		t.Fatalf("the older valid row still confirms: %+v", failure)
	}
	if _, err := database.Pool.Exec(ctx, `UPDATE verification SET "createdAt" = now() + interval '1 hour',
		"expiresAt" = now() - interval '1 minute' WHERE id = $1`, s.UserID+"-confirmation-new"); err != nil {
		t.Fatal(err)
	}
	_, failure := vaultstore.VaultReveal(ctx, database, deployment, actor, input)
	if got := laneMFailure(t, failure); got.Code != "IDENTITY_CONFIRMATION_REQUIRED" {
		t.Fatalf("a newer expired row must deny, not accept an older row: %+v", got)
	}
	if left := rows(t); len(left) != 1 || left[0] != s.UserID+"-confirmation-valid" {
		t.Fatalf("expired rows after the lookup = %v", left)
	}
}

// TestLaneMIdentityConfirmationReadsBothIdentifiersBeforeCleanup is the ordering of the two
// findVerificationValue calls: hasRecentIdentityConfirmation asks for identity-confirmed and
// oidc-reauth with Promise.all (identity-confirmation.ts:55-67), so both newest rows are observed
// before either lookup's global cleanup. An expired newest oidc proof must therefore deny even
// though an older oidc row is still valid; reading and cleaning one identifier at a time would
// delete the expired row before the oidc read and accept the older row.
func TestLaneMIdentityConfirmationReadsBothIdentifiersBeforeCleanup(t *testing.T) {
	database := openTestDB(t)
	s := seed(t, database)
	ctx := context.Background()
	actor := db.Actor{UserID: s.UserID, SpaceID: s.Space1, SessionID: s.SessionID}
	deployment := laneMVault(t, database)
	id := s.UserID + "-login"
	addLaneMVault(t, database, s.UserID, nil, laneMVaultRow{
		ID: id, Name: "login", Origin: "https://login.example.test",
		Auth:       []byte(`{"type":"login"}`),
		Ciphertext: sealLaneM(t, `{"fields":[{"label":"Username","value":"u","hidden":false}]}`, id),
	})
	input := laneMInput(t, `{"name":"login"}`)
	identifier := "oidc-reauth-" + s.SessionID
	now := time.Now().UTC().Truncate(time.Millisecond)
	insert := func(t *testing.T, rowID string, createdAt, expiresAt time.Time) {
		t.Helper()
		err := database.System(ctx, "seed a verification row", func(tx pgx.Tx) error {
			_, err := tx.Exec(ctx, `INSERT INTO verification (id, identifier, value, "expiresAt", "createdAt", "updatedAt")
				VALUES ($1, $2, $3, $4, $5, $5)`, rowID, identifier, s.UserID, expiresAt, createdAt)
			return err
		})
		if err != nil {
			t.Fatalf("seed verification row: %v", err)
		}
	}
	rows := func(t *testing.T) []string {
		t.Helper()
		var ids []string
		err := database.System(ctx, "read verification rows", func(tx pgx.Tx) error {
			result, failure := tx.Query(ctx, `SELECT id FROM verification WHERE identifier = $1 ORDER BY id`, identifier)
			if failure != nil {
				return failure
			}
			defer result.Close()
			for result.Next() {
				var rowID string
				if err := result.Scan(&rowID); err != nil {
					return err
				}
				ids = append(ids, rowID)
			}
			return result.Err()
		})
		if err != nil {
			t.Fatal(err)
		}
		return ids
	}

	// The newer oidc row is expired; the older one is still valid. Both newest rows are read
	// before the cleanup, so the expired row is the proof and the gate denies.
	insert(t, s.UserID+"-oidc-valid", now.Add(-2*time.Hour), now.Add(time.Hour))
	insert(t, s.UserID+"-oidc-expired", now.Add(-time.Hour), now.Add(-time.Minute))
	_, failure := vaultstore.VaultReveal(ctx, database, deployment, actor, input)
	if got := laneMFailure(t, failure); got.Code != "IDENTITY_CONFIRMATION_REQUIRED" {
		t.Fatalf("a newer expired oidc row must deny, not accept an older row: %+v", got)
	}
	// The lookup's global cleanup still removes the expired row and leaves the older valid one.
	if left := rows(t); len(left) != 1 || left[0] != s.UserID+"-oidc-valid" {
		t.Fatalf("verification rows after the lookup = %v", left)
	}
}

// TestLaneMVaultRemoveDropsTheReference is forgetBotSecret: the row goes, the reference it held is
// cleaned up, and an absent name is a no-op success.
func TestLaneMVaultRemoveDropsTheReference(t *testing.T) {
	database := openTestDB(t)
	s := seed(t, database)
	ctx := context.Background()
	actor := db.Actor{UserID: s.UserID, SpaceID: s.Space1, SessionID: s.SessionID}
	deployment := laneMVault(t, database)
	id := s.UserID + "-saved"
	addLaneMVault(t, database, s.UserID, nil, laneMVaultRow{
		ID: id, Name: "saved", Ciphertext: sealLaneM(t, "value", id),
	})
	addLaneMVault(t, database, s.UserID, nil, laneMVaultRow{
		ID: s.UserID + "-kept", Name: "kept", Ciphertext: sealLaneM(t, "value", s.UserID+"-kept"),
	})
	result, failure := vaultstore.VaultRemove(ctx, database, deployment, actor,
		laneMInput(t, `{"name":"saved"}`))
	if failure != nil {
		t.Fatalf("remove: %+v", failure)
	}
	if ok, _ := result.(map[string]any)["ok"].(bool); !ok {
		t.Fatalf("result = %#v", result)
	}
	rows := laneMRows(t, database, s.UserID)
	if len(rows) != 1 || rows[0].Name != "kept" {
		t.Fatalf("rows = %#v", rows)
	}
	if _, failure := vaultstore.VaultRemove(ctx, database, deployment, actor,
		laneMInput(t, `{"name":"absent"}`)); failure != nil {
		t.Fatalf("absent remove: %+v", failure)
	}
}

// TestLaneMVaultGateDeclinesBeforeWriting is the redaction gate's contract: a name the gate cannot
// prove is answered by TypeScript, and nothing has been written when it declines.
func TestLaneMVaultGateDeclinesBeforeWriting(t *testing.T) {
	database := openTestDB(t)
	s := seed(t, database)
	ctx := context.Background()
	actor := db.Actor{UserID: s.UserID, SpaceID: s.Space1, SessionID: s.SessionID}
	deployment := laneMVault(t, database)
	id := s.UserID + "-sk"
	addLaneMVault(t, database, s.UserID, nil, laneMVaultRow{
		ID: id, Name: "sk-abc", Auth: []byte(`{"type":"command"}`), Origin: "",
		Ciphertext: sealLaneM(t, "value", id),
	})
	_, failure := vaultstore.AgentRemove(ctx, database, deployment, actor,
		laneMInput(t, `{"id":"sk-abc"}`))
	if !errors.Is(failure, local.ErrDecline) {
		t.Fatalf("decline = %v", failure)
	}
	if rows := laneMRows(t, database, s.UserID); len(rows) != 1 {
		t.Fatalf("a declined remove wrote: %d rows", len(rows))
	}
	_, failure = vaultstore.VaultPut(ctx, database, deployment, actor, laneMInput(t, `{
		"destination": {"name":"sk-new","origin":"https://example.test","auth":{"type":"bearer"}},
		"value": "x"
	}`))
	if !errors.Is(failure, local.ErrDecline) {
		t.Fatalf("put decline = %v", failure)
	}
	if rows := laneMRows(t, database, s.UserID); len(rows) != 1 {
		t.Fatalf("a declined put wrote: %d rows", len(rows))
	}
}

// TestLaneMVaultOwnerGate is requireSpaceOwner: a guest's Space role cannot write a variable.
func TestLaneMVaultOwnerGate(t *testing.T) {
	database := openTestDB(t)
	s := seed(t, database)
	ctx := context.Background()
	deployment := laneMVault(t, database)
	err := database.System(ctx, "make the Space role a guest", func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `UPDATE space_members SET role = 'guest' WHERE "spaceId" = $1 AND "userId" = $2`,
			s.Space2, s.UserID)
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	actor := db.Actor{UserID: s.UserID, SpaceID: s.Space2, SessionID: s.SessionID}
	_, failure := vaultstore.AgentPut(ctx, database, deployment, actor,
		laneMInput(t, `{"name":"DEPLOY_KEY","value":"x"}`))
	if got := laneMFailure(t, failure); got.Code != "FORBIDDEN" || got.Message != "Only the space owner can do that" {
		t.Fatalf("guest put = %+v", got)
	}
	if rows := laneMRows(t, database, s.UserID); len(rows) != 0 {
		t.Fatalf("a refused put wrote %d rows", len(rows))
	}
}
