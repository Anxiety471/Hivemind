// Package push ports the three notification-registration writes the mobile
// apps call: notifications.registerPush, notifications.registerCallPush and
// notifications.unregisterPush (apps/api/src/routes/account.ts:494-533 over
// packages/adapters/src/notifications/push-token-store.ts:48-341).
//
// The rows they write are sealed with the plain EncryptedSecretStore envelope
// (`v2:`), not the vault or rkz1 one: every token is bound to a record id
// (`push-token:<userId>` / `call-push:<deviceDigest>`), so a later read by the
// TypeScript worker opens only the token it belongs to. The store instance the
// TypeScript push-token store owns has no change listeners, so a put here
// announces nothing on `secret-store-change`; this package therefore seals with
// the bare store rather than the announcing Writer.
//
// The token tables are system-only under row-level security
// (20261226120000_push_registrations, 20261119120000_call_push_devices), so
// every statement runs in a system transaction, with the same transaction-scoped
// advisory locks the TypeScript store takes and the same three-attempt retry on
// a serialization or deadlock conflict.
package push

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/orpc"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/shared"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/secretstore"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/wtf8"
)

// ok is the procedures' only success output: z.object({ok: z.literal(true)}).
var ok = map[string]any{"ok": true}

// errSessionEnded is PushSessionEndedError (push-token-store.ts:48-52): the
// session the request authenticated with was deleted (or expired) before its
// registration committed, so the handler answers 401 "Unauthorized" through a
// ClientError rather than the generic error path (account.ts:499-502,523-526).
var errSessionEnded = errors.New("push session ended")

const maxTransactionTries = 3

// credentialDigest is credentialDigest (credential-digest.ts:1-6): sha256 of
// the value's UTF-8 bytes as lower-case hex. Node hashes the UTF-8 encoding of
// the JS string, which writes U+FFFD for an unpaired surrogate; the WTF-8 form
// Go carries is converted first, so the digest and the advisory-lock key match
// TypeScript's (the call-push digests go through the same conversion).
func credentialDigest(value string) string {
	sum := sha256.Sum256([]byte(wtf8.ToUTF8(value)))
	return hex.EncodeToString(sum[:])
}

// now is the instant Prisma's @updatedAt writes: milliseconds, UTC.
func now() time.Time { return time.Now().UTC().Truncate(time.Millisecond) }

// systemRetry is withTransactionRetry (transaction-retry.ts:48-58) around a
// system transaction: a serialization failure or deadlock runs the whole
// transaction again, at most three attempts in all.
func systemRetry(ctx context.Context, database *db.DB, reason string, fn func(pgx.Tx) error) error {
	for attempt := 1; ; attempt++ {
		err := database.System(ctx, reason, fn)
		if err == nil || !shared.TransactionConflict(err) || attempt >= maxTransactionTries {
			return err
		}
	}
}

// advisoryLock takes the transaction-scoped lock advisoryLock(tx, namespace,
// key, "joined") takes: hashtextextended('<namespace>:<key>', 0)
// (advisory-lock.ts:9-22).
func advisoryLock(ctx context.Context, tx pgx.Tx, key string) error {
	//writeaudit:dynamic transaction-scoped advisory lock; no row payload
	_, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, key)
	return err
}

// sessionLive locks the registering session against deletion until the
// transaction ends and reports whether it is still the caller's and unexpired:
// `SELECT id FROM "session" WHERE id = $1 AND "userId" = $2 AND "expiresAt" >
// CURRENT_TIMESTAMP FOR UPDATE` (push-token-store.ts:81-86,239-244).
func sessionLive(ctx context.Context, tx pgx.Tx, sessionID, userID string) (bool, error) {
	var id string
	err := tx.QueryRow(ctx, `SELECT id FROM "session" WHERE id = $1 AND "userId" = $2
		AND "expiresAt" > CURRENT_TIMESTAMP FOR UPDATE`, sessionID, userID).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, nil
}

// store seals and opens token rows. It is *secretstore.Store, the bare
// EncryptedSecretStore the TypeScript push-token store owns.
func store(vault *shared.SecretVault) (*secretstore.Store, *orpc.Error) {
	deps, err := shared.VaultDeps(vault)
	if err != nil {
		return nil, shared.Failure(err)
	}
	return deps.Writer.Store, nil
}

// sealToken writes one token with its record id (secrets.ts:97-117).
func sealToken(ctx context.Context, s *secretstore.Store, recordID, plaintext string) (string, *orpc.Error) {
	record, err := s.Put(ctx, plaintext, secretstore.PutOptions{RecordID: recordID})
	if err != nil {
		return "", shared.Failure(err)
	}
	return record.Ciphertext, nil
}

// openToken reads one token back (secrets.ts:132-150).
func openToken(ctx context.Context, s *secretstore.Store, recordID, ciphertext string) (string, error) {
	return s.Load(ctx, ciphertext, recordID)
}
