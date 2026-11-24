package push

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"unicode/utf16"

	"github.com/jackc/pgx/v5"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/orpc"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/shared"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/validate"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/wtf8"
)

// Register implements notifications.registerPush (account.ts:507-521 over
// push-token-store.ts:183-269, the "register" mode of `register`).
func Register(ctx context.Context, database *db.DB, vault *shared.SecretVault, actor db.Actor, input orpc.Input) (any, *orpc.Error) {
	parsed, failure := ParseRegister(input)
	if failure != nil {
		return nil, failure
	}
	// The handler refuses a caller without a session before doing anything
	// (account.ts:508-509); the RPC context always carries one.
	if actor.SessionID == "" {
		return nil, orpc.Unauthorized()
	}
	secrets, failure := store(vault)
	if failure != nil {
		return nil, failure
	}
	digest := credentialDigest(parsed.Token)
	// The TypeScript store seals before it opens its transaction
	// (push-token-store.ts:197-207), so an ended session still pays for a seal.
	// Node's cipher seals the UTF-8 encoding of the token string, which writes
	// U+FFFD for an unpaired surrogate; the WTF-8 form Go carries is converted
	// first (the call-push plaintext is JSON.stringify output, already escaped).
	ciphertext, failure := sealToken(ctx, secrets, "push-token:"+actor.UserID, wtf8.ToUTF8(parsed.Token))
	if failure != nil {
		return nil, failure
	}
	var presentation *string
	if parsed.Presentation != "" {
		value := parsed.Presentation
		presentation = &value
	}
	err := systemRetry(ctx, database, "register or import a notification device", func(tx pgx.Tx) error {
		// Account locks serialize sign-out and replacement; the token lock
		// serializes device handover (push-token-store.ts:203-206).
		if err := advisoryLock(ctx, tx, "push-token:"+digest); err != nil {
			return err
		}
		if err := advisoryLock(ctx, tx, "push-user:"+actor.UserID); err != nil {
			return err
		}
		live, err := sessionLive(ctx, tx, actor.SessionID, actor.UserID)
		if err != nil {
			return err
		}
		if !live {
			return errSessionEnded
		}
		// A device's token belongs to one account, and one session is one
		// device, so a rotated token replaces the session's previous one
		// (push-token-store.ts:254-265).
		if _, err := tx.Exec(ctx, `DELETE FROM push_registrations
			WHERE ("tokenDigest" = $1 AND "userId" <> $2)
			   OR ("userId" = $2 AND "sessionId" = $3 AND "tokenDigest" <> $1)`,
			digest, actor.UserID, actor.SessionID); err != nil {
			return err
		}
		_, err = tx.Exec(ctx, `INSERT INTO push_registrations
			("userId", "tokenDigest", "sessionId", ciphertext, presentation, "updatedAt")
			VALUES ($1, $2, $3, $4, $5, $6)
			ON CONFLICT ("userId", "tokenDigest") DO UPDATE SET
				"sessionId" = excluded."sessionId",
				ciphertext = excluded.ciphertext,
				presentation = excluded.presentation,
				"updatedAt" = excluded."updatedAt"`,
			actor.UserID, digest, actor.SessionID, ciphertext, presentation, now())
		return err
	})
	if errors.Is(err, errSessionEnded) {
		return nil, orpc.Unauthorized()
	}
	if err != nil {
		return nil, shared.Failure(err)
	}
	return ok, nil
}

// RegisterCall implements notifications.registerCallPush (account.ts:494-505
// over push-token-store.ts:60-121).
func RegisterCall(ctx context.Context, database *db.DB, vault *shared.SecretVault, actor db.Actor, input orpc.Input) (any, *orpc.Error) {
	parsed, failure := ParseCall(input)
	if failure != nil {
		return nil, failure
	}
	if actor.SessionID == "" {
		return nil, orpc.Unauthorized()
	}
	secrets, failure := store(vault)
	if failure != nil {
		return nil, failure
	}
	id := credentialDigest(parsed.DeviceID)
	err := systemRetry(ctx, database, "register a call notification device", func(tx pgx.Tx) error {
		// Locks are taken in sorted key order so concurrent registrations never
		// deadlock (push-token-store.ts:69-77).
		if err := advisoryLock(ctx, tx, "push-device:"+id); err != nil {
			return err
		}
		if parsed.HasExpo {
			if err := advisoryLock(ctx, tx, "push-expo:"+credentialDigest(parsed.ExpoToken)); err != nil {
				return err
			}
		}
		if err := advisoryLock(ctx, tx, "push-user:"+actor.UserID); err != nil {
			return err
		}
		if parsed.HasVoip {
			if err := advisoryLock(ctx, tx, "push-voip:"+credentialDigest(parsed.VoipToken)); err != nil {
				return err
			}
		}
		live, err := sessionLive(ctx, tx, actor.SessionID, actor.UserID)
		if err != nil {
			return err
		}
		if !live {
			return errSessionEnded
		}
		var owner, stored string
		err = tx.QueryRow(ctx, `SELECT "userId", ciphertext FROM call_push_devices WHERE id = $1`, id).
			Scan(&owner, &stored)
		var previous any
		switch {
		case err == nil && owner == actor.UserID:
			plaintext, err := openToken(ctx, secrets, "call-push:"+id, stored)
			if err != nil {
				return err
			}
			decoded, err := validate.DecodeAny([]byte(plaintext))
			if err != nil {
				return err
			}
			previous = decoded
		case err != nil && !errors.Is(err, pgx.ErrNoRows):
			return err
		}
		merged := mergeRegistration(previous, parsed)
		sealed, failure := sealToken(ctx, secrets, "call-push:"+id, validate.Stringify(merged))
		if failure != nil {
			return failure
		}
		expoDigest, err := registrationDigest(merged.Values["expoToken"])
		if err != nil {
			return err
		}
		voipDigest, err := registrationDigest(merged.Values["voipToken"])
		if err != nil {
			return err
		}
		// One physical push token has one owner, even after a reinstall or an
		// account handover (push-token-store.ts:98-107).
		conditions := []string{}
		arguments := []any{id}
		if expoDigest != nil {
			arguments = append(arguments, *expoDigest)
			conditions = append(conditions, fmt.Sprintf(`"expoTokenDigest" = $%d`, len(arguments)))
		}
		if voipDigest != nil {
			arguments = append(arguments, *voipDigest)
			conditions = append(conditions, fmt.Sprintf(`"voipTokenDigest" = $%d`, len(arguments)))
		}
		if len(conditions) > 0 {
			if _, err := tx.Exec(ctx, `DELETE FROM call_push_devices WHERE id <> $1 AND (`+
				strings.Join(conditions, " OR ")+`)`, arguments...); err != nil {
				return err
			}
		}
		_, err = tx.Exec(ctx, `INSERT INTO call_push_devices
			(id, "userId", "sessionId", ciphertext, "expoTokenDigest", "voipTokenDigest", "updatedAt")
			VALUES ($1, $2, $3, $4, $5, $6, $7)
			ON CONFLICT (id) DO UPDATE SET
				"userId" = excluded."userId",
				"sessionId" = excluded."sessionId",
				ciphertext = excluded.ciphertext,
				"expoTokenDigest" = excluded."expoTokenDigest",
				"voipTokenDigest" = excluded."voipTokenDigest",
				"updatedAt" = excluded."updatedAt"`,
			id, actor.UserID, actor.SessionID, sealed, expoDigest, voipDigest, now())
		return err
	})
	if errors.Is(err, errSessionEnded) {
		return nil, orpc.Unauthorized()
	}
	if err != nil {
		return nil, shared.Failure(err)
	}
	return ok, nil
}

// Unregister implements notifications.unregisterPush (account.ts:524-533):
// a signed-in session ends its own registrations on both transports, while a
// caller without one has every message token of the account removed.
func Unregister(ctx context.Context, database *db.DB, actor db.Actor, _ orpc.Input) (any, *orpc.Error) {
	err := endSession(ctx, database, actor.UserID, actor.SessionID)
	if err != nil {
		return nil, shared.Failure(err)
	}
	return ok, nil
}

// EndSession is PrismaPushTokenStore.endSession without a retarget
// (push-token-store.ts:316-341): the deletes a deleted session's rows. The
// auth layer runs it for every session better-auth deletes, exactly like
// apps/api/src/app.ts:616-624's afterDeleteSession.
func EndSession(ctx context.Context, database *db.DB, userID, sessionID string) error {
	return endSession(ctx, database, userID, sessionID)
}

// endSession deletes a session's rows on both transports under the account's
// push lock; an empty sessionID deletes every message token of the account
// (the store's remove branch, unreachable through RPC).
func endSession(ctx context.Context, database *db.DB, userID, sessionID string) error {
	return systemRetry(ctx, database, "revoke or retarget a session's notification registration", func(tx pgx.Tx) error {
		if err := advisoryLock(ctx, tx, "push-user:"+userID); err != nil {
			return err
		}
		if sessionID == "" {
			_, err := tx.Exec(ctx, `DELETE FROM push_registrations WHERE "userId" = $1`, userID)
			return err
		}
		// Sign-out revokes both transports (push-token-store.ts:325-341).
		if _, err := tx.Exec(ctx, `DELETE FROM call_push_devices WHERE "userId" = $1 AND "sessionId" = $2`,
			userID, sessionID); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, `DELETE FROM push_registrations WHERE "userId" = $1 AND "sessionId" = $2`,
			userID, sessionID)
		return err
	})
}

// registrationDigest is `merged.expoToken ? credentialDigest(merged.expoToken)
// : null` (push-token-store.ts:96-97): a truthy non-string is a TypeError in
// TypeScript, so it is a 500 here too.
func registrationDigest(value any) (*string, error) {
	if !jsTruthy(value) {
		return nil, nil
	}
	text, isText := value.(string)
	if !isText {
		return nil, orpc.Internal()
	}
	digest := credentialDigest(text)
	return &digest, nil
}

// mergeRegistration is `{ ...previous, ...registration }` (push-token-store.ts:88):
// the previous row's keys keep their order, a sent field replaces its value in
// place, and a new field is appended in the registration's own order.
func mergeRegistration(previous any, registration CallInput) *validate.Object {
	merged := spreadValue(previous)
	fields := []struct {
		key     string
		value   string
		present bool
	}{
		{"deviceId", registration.DeviceID, true},
		{"platform", registration.Platform, true},
		{"expoToken", registration.ExpoToken, registration.HasExpo},
		{"voipToken", registration.VoipToken, registration.HasVoip},
	}
	for _, field := range fields {
		if !field.present {
			continue
		}
		if _, exists := merged.Values[field.key]; !exists {
			merged.Keys = append(merged.Keys, field.key)
		}
		merged.Values[field.key] = field.value
	}
	return merged
}

// spreadValue is object spread over a decoded stored registration. Every writer
// stores an object; the other cases follow JavaScript's own spreads so a
// hand-written row still merges the way the TypeScript store merges it.
func spreadValue(value any) *validate.Object {
	spread := &validate.Object{Values: map[string]any{}}
	switch typed := value.(type) {
	case *validate.Object:
		spread.Keys = append(spread.Keys, typed.Keys...)
		for key, item := range typed.Values {
			spread.Values[key] = item
		}
	case []any:
		for index, item := range typed {
			key := strconv.Itoa(index)
			spread.Keys = append(spread.Keys, key)
			spread.Values[key] = item
		}
	case string:
		// A string spreads into its UTF-16 code units; Go has no lone surrogate,
		// so one becomes U+FFFD, the bytes Node's UTF-8 encoder writes for it.
		for index, unit := range utf16.Encode([]rune(typed)) {
			key := strconv.Itoa(index)
			spread.Keys = append(spread.Keys, key)
			spread.Values[key] = string(rune(unit))
		}
	}
	return spread
}
