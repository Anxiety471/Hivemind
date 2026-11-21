// Command secretsproof is the Go side of the Infrastructure C cross-language
// proof: the credential store's `v2:` envelope, the vault-value `rkz1:`
// envelope and the secret-persistence hook. tools/infra-c-proof.mts drives it
// over JSON lines; it is a test driver, not a service, and every key it uses is
// a test key from the environment.
package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/contentcrypto"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/secretstore"
)

type request struct {
	ID        int      `json:"id"`
	Op        string   `json:"op"`
	Plaintext string   `json:"plaintext"`
	RecordID  string   `json:"recordId"`
	Ref       string   `json:"ref"`
	Value     string   `json:"value"`
	ItemID    string   `json:"itemId"`
	ItemIDs   []string `json:"itemIds"`
	UserID    string   `json:"userId"`
	SpaceID   string   `json:"spaceId"`
	Kind      string   `json:"kind"`
	Scope     string   `json:"scope"`
	KeyID     string   `json:"keyId"`
	Model     string   `json:"model"`
	ParentID  string   `json:"parentId"`
	PauseMS   int      `json:"pauseMs"`
	Row       struct {
		ID      string  `json:"id"`
		UserID  string  `json:"userId"`
		SpaceID *string `json:"spaceId"`
	} `json:"row"`
}

type response struct {
	ID         int      `json:"id"`
	OK         bool     `json:"ok,omitempty"`
	Plaintext  string   `json:"plaintext"`
	Ciphertext string   `json:"ciphertext"`
	Ref        string   `json:"ref"`
	Refs       []string `json:"refs"`
	RecordID   string   `json:"recordId"`
	OldRef     string   `json:"oldRef"`
	Redacted   string   `json:"redacted"`
	KeyID      string   `json:"keyId"`
	Count      int      `json:"count"`
	Found      bool     `json:"found"`
	Present    bool     `json:"present"`
	During     string   `json:"during"`
	After      string   `json:"after"`
	Error      string   `json:"error,omitempty"`
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "secretsproof:", err)
		os.Exit(1)
	}
}

func run() error {
	ctx := context.Background()
	connectionString := os.Getenv("DATABASE_URL")
	if connectionString == "" {
		return errors.New("DATABASE_URL is required")
	}
	encryptionKey := os.Getenv("ENCRYPTION_KEY")
	store, err := secretstore.NewStore(encryptionKey)
	if err != nil {
		return err
	}
	database, err := db.Open(ctx, connectionString, "rakazo-secrets-proof")
	if err != nil {
		return err
	}
	defer database.Close()
	masters, err := contentcrypto.MasterKeysFromEnv(os.Getenv)
	if err != nil {
		return err
	}
	provider, err := contentcrypto.NewLocalKeyProvider(masters)
	if err != nil {
		return err
	}
	spaceKeys, err := contentcrypto.OpenPgSpaceKeyStore(ctx, database)
	if err != nil {
		return err
	}
	defer spaceKeys.Close()
	ring := contentcrypto.NewKeyRing(provider, spaceKeys, contentcrypto.KeyRingOptions{
		EncryptWrites: os.Getenv("CONTENT_ENCRYPTION") != "off",
	})
	writer := secretstore.NewWriter(store, secretstore.NewNotifier(
		&secretstore.PGPublisher{DB: database}))
	persistence := secretstore.NewPersistence(database, writer)

	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 0, 1<<20), 1<<24)
	encoder := json.NewEncoder(os.Stdout)
	for scanner.Scan() {
		line := scanner.Bytes()
		if len(line) == 0 {
			continue
		}
		var in request
		decoder := json.NewDecoder(bytes.NewReader(line))
		decoder.UseNumber()
		if err := decoder.Decode(&in); err != nil {
			_ = encoder.Encode(response{ID: in.ID, Error: "bad request: " + err.Error()})
			continue
		}
		out := handle(ctx, database, ring, writer, persistence, store, in)
		out.ID = in.ID
		if err := encoder.Encode(out); err != nil {
			return err
		}
	}
	return scanner.Err()
}

func handle(
	ctx context.Context,
	database *db.DB,
	ring *contentcrypto.KeyRing,
	writer *secretstore.Writer,
	persistence *secretstore.Persistence,
	store *secretstore.Store,
	in request,
) response {
	fail := func(err error) response {
		if err == nil {
			return response{OK: true}
		}
		return response{Error: err.Error()}
	}
	switch in.Op {
	case "ping":
		return response{OK: true}
	case "seal":
		record, err := store.Put(ctx, in.Plaintext, secretstore.PutOptions{RecordID: in.RecordID})
		if err != nil {
			return fail(err)
		}
		return response{Ref: record.Ref, RecordID: record.ID}
	case "seal-new":
		record, err := store.Put(ctx, in.Plaintext, secretstore.PutOptions{})
		if err != nil {
			return fail(err)
		}
		return response{Ref: record.Ref, RecordID: record.ID}
	case "open":
		source := store
		if in.KeyID != "" {
			alternate, err := secretstore.NewStore(in.KeyID)
			if err != nil {
				return fail(err)
			}
			source = alternate
		}
		plaintext, err := source.Load(ctx, in.Ref, in.RecordID)
		if err != nil {
			return fail(err)
		}
		return response{Plaintext: plaintext}
	case "legacy-seal":
		ciphertext, err := legacySeal(store, in.Plaintext)
		if err != nil {
			return fail(err)
		}
		return response{Ref: ciphertext}
	case "redact":
		return response{Redacted: secretstore.Redact(in.Value)}
	case "key-current":
		key, err := ring.Current(ctx, in.Scope)
		if err != nil {
			return fail(err)
		}
		return response{KeyID: key.ID}
	case "key-newest":
		id, found, err := secretstore.NewestVaultKeyID(ctx, database.Pool, in.Scope)
		if err != nil {
			return fail(err)
		}
		return response{KeyID: id, Found: found}
	case "delete-key":
		if err := database.System(ctx, "remove a proof vault key", func(tx pgx.Tx) error {
			_, err := tx.Exec(ctx, `DELETE FROM space_keys WHERE id = $1`, in.KeyID)
			return err
		}); err != nil {
			return fail(err)
		}
		return response{OK: true}
	case "vault-seal":
		row := secretstore.VaultRow{ID: in.Row.ID, UserID: in.Row.UserID, SpaceID: in.Row.SpaceID}
		ciphertext, err := secretstore.SealVaultValue(ctx, database.Pool, ring, writer, row, in.Plaintext)
		if err != nil {
			return fail(err)
		}
		return response{Ciphertext: ciphertext}
	case "vault-seal-in-tx":
		// A pool query is what a procedure's tenant transaction does; the proof
		// uses the pool because the row-level-security settings do not change
		// which vault key is newest.
		row := secretstore.VaultRow{ID: in.Row.ID, UserID: in.Row.UserID, SpaceID: in.Row.SpaceID}
		var ciphertext string
		err := database.Tenant(ctx, db.Actor{UserID: in.UserID, SpaceID: in.SpaceID},
			func(tx pgx.Tx) error {
				var err error
				ciphertext, err = secretstore.SealVaultValue(ctx, tx, ring, writer, row, in.Plaintext)
				return err
			})
		if err != nil {
			return fail(err)
		}
		return response{Ciphertext: ciphertext}
	case "vault-open":
		row := secretstore.VaultRow{ID: in.Row.ID, UserID: in.Row.UserID, SpaceID: in.Row.SpaceID}
		plaintext, err := secretstore.OpenVaultValue(ctx, ring, writer, row, in.Value)
		if err != nil {
			return fail(err)
		}
		return response{Plaintext: plaintext}
	case "secret-create":
		return hookSecretCreate(ctx, database, writer, persistence, store, in)
	case "secret-update":
		return hookSecretUpdate(ctx, database, writer, persistence, store, in)
	case "secret-delete":
		return hookSecretDelete(ctx, database, writer, persistence, in)
	case "secret-delete-many":
		return hookSecretDeleteMany(ctx, database, writer, persistence, in)
	case "secret-create-rollback":
		return hookSecretCreateRollback(ctx, database, writer, persistence, store, in)
	case "secret-delete-rollback":
		return hookSecretDeleteRollback(ctx, database, writer, persistence, in)
	case "parent-delete":
		return hookParentDelete(ctx, database, writer, persistence, in)
	case "lock-probe":
		return hookLockProbe(ctx, database, writer, persistence, in)
	case "row-state":
		return rowState(ctx, database, in.ItemID)
	case "jobs-count":
		var count int
		if err := database.System(ctx, "count proof jobs", func(tx pgx.Tx) error {
			return tx.QueryRow(ctx, `SELECT count(*) FROM graphile_worker._private_jobs
				WHERE payload->>'kind' IS NOT NULL`).Scan(&count)
		}); err != nil {
			return fail(err)
		}
		return response{Count: count}
	}
	return response{Error: "unknown op " + in.Op}
}

func actorOf(in request) db.Actor {
	return db.Actor{UserID: in.UserID, SpaceID: in.SpaceID}
}

// hookSecretCreate is a procedure's write: seal, insert the row in a tenant
// transaction, and let the hook confirm the committed row holds the ref.
func hookSecretCreate(
	ctx context.Context, database *db.DB, writer *secretstore.Writer,
	persistence *secretstore.Persistence, store *secretstore.Store, in request,
) response {
	record, err := writer.Put(ctx, in.Plaintext, secretstore.PutOptions{RecordID: in.ItemID})
	if err != nil {
		return response{Error: err.Error()}
	}
	state := persistence.NewState()
	err = database.Tenant(ctx, actorOf(in), func(tx pgx.Tx) error {
		// Track before any database access: a failed insert must still clean
		// the value sealed for it (secret-persistence.ts:226-247).
		persistence.TrackWrite(state, secretstore.Secret, in.ItemID, record.Ciphertext)
		if _, err := tx.Exec(ctx,
			`INSERT INTO secrets (id, "userId", "spaceId", kind, ciphertext)
			 VALUES ($1, $2, nullif($3, ''), $4, $5)`,
			in.ItemID, in.UserID, in.SpaceID, in.Kind, record.Ciphertext); err != nil {
			return err
		}
		return nil
	})
	persistence.Finish(ctx, state, err)
	if err != nil {
		return response{Error: err.Error()}
	}
	return response{Ref: record.Ref, RecordID: record.ID}
}

func hookSecretUpdate(
	ctx context.Context, database *db.DB, writer *secretstore.Writer,
	persistence *secretstore.Persistence, store *secretstore.Store, in request,
) response {
	record, err := writer.Put(ctx, in.Plaintext, secretstore.PutOptions{RecordID: in.ItemID})
	if err != nil {
		return response{Error: err.Error()}
	}
	state := persistence.NewState()
	var oldRef string
	err = database.Tenant(ctx, actorOf(in), func(tx pgx.Tx) error {
		if err := persistence.CaptureDropped(ctx, tx, state, secretstore.Secret,
			`SELECT id FROM secrets WHERE id = $1`, in.ItemID); err != nil {
			return err
		}
		if len(state.Old) > 0 {
			oldRef = state.Old[0].Ref
		}
		// Track before the UPDATE for the same reason as a create.
		persistence.TrackWrite(state, secretstore.Secret, in.ItemID, record.Ciphertext)
		if _, err := tx.Exec(ctx,
			`UPDATE secrets SET ciphertext = $2 WHERE id = $1`, in.ItemID, record.Ciphertext); err != nil {
			return err
		}
		return nil
	})
	persistence.Finish(ctx, state, err)
	if err != nil {
		return response{Error: err.Error()}
	}
	return response{Ref: record.Ref, OldRef: oldRef}
}

func hookSecretDelete(
	ctx context.Context, database *db.DB, writer *secretstore.Writer,
	persistence *secretstore.Persistence, in request,
) response {
	state := persistence.NewState()
	err := database.Tenant(ctx, actorOf(in), func(tx pgx.Tx) error {
		if err := persistence.CaptureDropped(ctx, tx, state, secretstore.Secret,
			`SELECT id FROM secrets WHERE id = $1`, in.ItemID); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, `DELETE FROM secrets WHERE id = $1`, in.ItemID)
		return err
	})
	persistence.Finish(ctx, state, err)
	if err != nil {
		return response{Error: err.Error()}
	}
	return response{Refs: cleanupRefs(state.Old)}
}

func hookSecretDeleteMany(
	ctx context.Context, database *db.DB, writer *secretstore.Writer,
	persistence *secretstore.Persistence, in request,
) response {
	state := persistence.NewState()
	err := database.Tenant(ctx, actorOf(in), func(tx pgx.Tx) error {
		return deleteMany(ctx, tx, persistence, state, in.ItemIDs)
	})
	persistence.Finish(ctx, state, err)
	if err != nil {
		return response{Error: err.Error()}
	}
	return response{Refs: cleanupRefs(state.Old)}
}

func deleteMany(ctx context.Context, tx pgx.Tx, persistence *secretstore.Persistence,
	state *secretstore.State, ids []string) error {
	if err := persistence.CaptureDropped(ctx, tx, state, secretstore.Secret,
		`SELECT id FROM secrets WHERE id = ANY($1) ORDER BY id`, ids); err != nil {
		return err
	}
	_, err := tx.Exec(ctx, `DELETE FROM secrets WHERE id = ANY($1)`, ids)
	return err
}

func hookSecretCreateRollback(
	ctx context.Context, database *db.DB, writer *secretstore.Writer,
	persistence *secretstore.Persistence, store *secretstore.Store, in request,
) response {
	record, err := writer.Put(ctx, in.Plaintext, secretstore.PutOptions{RecordID: in.ItemID})
	if err != nil {
		return response{Error: err.Error()}
	}
	state := persistence.NewState()
	err = database.Tenant(ctx, actorOf(in), func(tx pgx.Tx) error {
		// Tracked before the insert so the rollback still cleans it.
		persistence.TrackWrite(state, secretstore.Secret, in.ItemID, record.Ciphertext)
		if _, err := tx.Exec(ctx,
			`INSERT INTO secrets (id, "userId", "spaceId", kind, ciphertext)
			 VALUES ($1, $2, nullif($3, ''), $4, $5)`,
			in.ItemID, in.UserID, in.SpaceID, in.Kind, record.Ciphertext); err != nil {
			return err
		}
		return errors.New("proof rollback")
	})
	persistence.Finish(ctx, state, err)
	if err == nil {
		return response{Error: "rollback did not fail"}
	}
	return response{Ref: record.Ref, RecordID: record.ID}
}

func hookSecretDeleteRollback(
	ctx context.Context, database *db.DB, writer *secretstore.Writer,
	persistence *secretstore.Persistence, in request,
) response {
	state := persistence.NewState()
	err := database.Tenant(ctx, actorOf(in), func(tx pgx.Tx) error {
		if err := persistence.CaptureDropped(ctx, tx, state, secretstore.Secret,
			`SELECT id FROM secrets WHERE id = $1`, in.ItemID); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `DELETE FROM secrets WHERE id = $1`, in.ItemID); err != nil {
			return err
		}
		return errors.New("proof rollback")
	})
	persistence.Finish(ctx, state, err)
	if err == nil {
		return response{Error: "rollback did not fail"}
	}
	return response{Refs: cleanupRefs(state.Old)}
}

func hookParentDelete(
	ctx context.Context, database *db.DB, writer *secretstore.Writer,
	persistence *secretstore.Persistence, in request,
) response {
	state := persistence.NewState()
	model := secretstore.Model(in.Model)
	err := database.System(ctx, "delete a proof parent row", func(tx pgx.Tx) error {
		if err := persistence.CaptureDropped(ctx, tx, state, model,
			`SELECT id FROM "`+parentTableName(model)+`" WHERE id = $1`, in.ParentID); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, `DELETE FROM "`+parentTableName(model)+`" WHERE id = $1`, in.ParentID)
		return err
	})
	persistence.Finish(ctx, state, err)
	if err != nil {
		return response{Error: err.Error()}
	}
	return response{Refs: cleanupRefs(state.Old)}
}

func parentTableName(model secretstore.Model) string {
	switch model {
	case secretstore.User:
		return "user"
	case secretstore.Space:
		return "spaces"
	case secretstore.Bot:
		return "bots"
	case secretstore.Organization:
		return "organization"
	}
	return ""
}

// hookLockProbe proves the hook locks the rows it captures: while its
// transaction is open, a second connection's FOR UPDATE NOWAIT is refused;
// after the commit it succeeds.
func hookLockProbe(
	ctx context.Context, database *db.DB, writer *secretstore.Writer,
	persistence *secretstore.Persistence, in request,
) response {
	state := persistence.NewState()
	var during, after string
	probe := func(label string) {
		value := "ok"
		err := database.System(ctx, "probe a locked secret row", func(tx pgx.Tx) error {
			var id string
			return tx.QueryRow(ctx,
				`SELECT id FROM secrets WHERE id = $1 FOR UPDATE NOWAIT`, in.ItemID).Scan(&id)
		})
		if err != nil {
			value = "blocked"
		}
		if label == "during" {
			during = value
		} else {
			after = value
		}
	}
	err := database.Tenant(ctx, actorOf(in), func(tx pgx.Tx) error {
		if err := persistence.CaptureDropped(ctx, tx, state, secretstore.Secret,
			`SELECT id FROM secrets WHERE id = $1`, in.ItemID); err != nil {
			return err
		}
		probe("during")
		if in.PauseMS > 0 {
			time.Sleep(time.Duration(in.PauseMS) * time.Millisecond)
		}
		return nil
	})
	persistence.Finish(ctx, state, err)
	probe("after")
	if err != nil {
		return response{Error: err.Error()}
	}
	return response{During: during, After: after, OK: true}
}

func rowState(ctx context.Context, database *db.DB, itemID string) response {
	out := response{}
	err := database.System(ctx, "read a proof secret row", func(tx pgx.Tx) error {
		var kind, ciphertext string
		err := tx.QueryRow(ctx,
			`SELECT kind, ciphertext FROM secrets WHERE id = $1`, itemID).Scan(&kind, &ciphertext)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		if err != nil {
			return err
		}
		out.Present = true
		out.Ciphertext = ciphertext
		out.Redacted = kind
		return nil
	})
	if err != nil {
		return response{Error: err.Error()}
	}
	return out
}

func cleanupRefs(cleanups []secretstore.Cleanup) []string {
	refs := make([]string, len(cleanups))
	for index, cleanup := range cleanups {
		refs[index] = cleanup.Ref
	}
	return refs
}

// legacySeal writes the pre-v2 format: SHA-256 of the encryption key, no AAD,
// `base64(iv | tag | ciphertext)` (secrets.ts:170-180,206-214).
func legacySeal(store *secretstore.Store, plaintext string) (string, error) {
	return store.SealLegacy(plaintext)
}
