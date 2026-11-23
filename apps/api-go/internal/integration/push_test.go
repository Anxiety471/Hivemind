package integration

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"strings"
	"sync"
	"testing"

	"github.com/jackc/pgx/v5"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/push"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/shared"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/secretstore"
)

const pushTestKey = "contract-test-encryption-key-0123456789abcdef"

// cleanupPush removes the token rows a test wrote. The seeded users are unique per
// run, but their rows are not removed with them here (nothing deletes the users), and
// the tables carry globally unique digests a later run of another suite would collide
// with.
func cleanupPush(t *testing.T, database *db.DB, userIDs ...string) {
	t.Helper()
	t.Cleanup(func() {
		if err := database.System(context.Background(), "test clean push rows", func(tx pgx.Tx) error {
			if _, err := tx.Exec(context.Background(), `DELETE FROM push_registrations WHERE "userId" = ANY($1)`, userIDs); err != nil {
				return err
			}
			_, err := tx.Exec(context.Background(), `DELETE FROM call_push_devices WHERE "userId" = ANY($1)`, userIDs)
			return err
		}); err != nil {
			t.Errorf("clean push rows: %v", err)
		}
	})
}

func pushDigest(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])
}

func pushVault(t *testing.T, database *db.DB) *shared.SecretVault {
	t.Helper()
	store, err := secretstore.NewStore(pushTestKey)
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	writer := secretstore.NewWriter(store, nil)
	return &shared.SecretVault{Writer: writer, Persistence: secretstore.NewPersistence(database, writer)}
}

// pushRow is one push_registrations row, with its ciphertext opened.
type pushRow struct {
	UserID       string
	TokenDigest  string
	SessionID    string
	Presentation *string
	Plaintext    string
}

func pushRows(t *testing.T, database *db.DB, users ...string) []pushRow {
	t.Helper()
	store, err := secretstore.NewStore(pushTestKey)
	if err != nil {
		t.Fatal(err)
	}
	var rows []pushRow
	if err := database.System(context.Background(), "test read push rows", func(tx pgx.Tx) error {
		found, err := tx.Query(context.Background(), `SELECT "userId", "tokenDigest", "sessionId", presentation, ciphertext
			FROM push_registrations WHERE "userId" = ANY($1) ORDER BY "tokenDigest"`, users)
		if err != nil {
			return err
		}
		defer found.Close()
		for found.Next() {
			var row pushRow
			if err := found.Scan(&row.UserID, &row.TokenDigest, &row.SessionID, &row.Presentation, &row.Plaintext); err != nil {
				return err
			}
			if row.Plaintext, err = store.Load(context.Background(), row.Plaintext, "push-token:"+row.UserID); err != nil {
				return err
			}
			rows = append(rows, row)
		}
		return found.Err()
	}); err != nil {
		t.Fatalf("read push rows: %v", err)
	}
	return rows
}

// deviceRow is one call_push_devices row, with its ciphertext opened.
type deviceRow struct {
	ID        string
	UserID    string
	SessionID string
	Expo      *string
	Voip      *string
	Plaintext string
}

func deviceRows(t *testing.T, database *db.DB, users ...string) []deviceRow {
	t.Helper()
	store, err := secretstore.NewStore(pushTestKey)
	if err != nil {
		t.Fatal(err)
	}
	var rows []deviceRow
	if err := database.System(context.Background(), "test read call devices", func(tx pgx.Tx) error {
		found, err := tx.Query(context.Background(), `SELECT id, "userId", "sessionId", "expoTokenDigest", "voipTokenDigest", ciphertext
			FROM call_push_devices WHERE "userId" = ANY($1) ORDER BY id`, users)
		if err != nil {
			return err
		}
		defer found.Close()
		for found.Next() {
			var row deviceRow
			if err := found.Scan(&row.ID, &row.UserID, &row.SessionID, &row.Expo, &row.Voip, &row.Plaintext); err != nil {
				return err
			}
			if row.Plaintext, err = store.Load(context.Background(), row.Plaintext, "call-push:"+row.ID); err != nil {
				return err
			}
			rows = append(rows, row)
		}
		return found.Err()
	}); err != nil {
		t.Fatalf("read call devices: %v", err)
	}
	return rows
}

func addSession(t *testing.T, database *db.DB, id, token, userID, expires string) {
	t.Helper()
	if err := database.System(context.Background(), "test add a session", func(tx pgx.Tx) error {
		_, err := tx.Exec(context.Background(), `INSERT INTO session (id, "expiresAt", token, "userId", "createdAt", "updatedAt")
			VALUES ($1, `+expires+`, $2, $3, now(), now())`, id, token, userID)
		return err
	}); err != nil {
		t.Fatalf("add session: %v", err)
	}
}

// The push writes are the first procedures whose rows carry the plain
// EncryptedSecretStore envelope with a record id and whose transactions take
// advisory locks and a session row lock: the sealed value must open under the
// row's own record id, a registration that loses its session must write
// nothing, and unregistration must be per session.
func TestPushRegistration(t *testing.T) {
	database := openTestDB(t)
	s := seed(t, database)
	cleanupPush(t, database, s.UserID, s.User2ID)
	vault := pushVault(t, database)
	ctx := context.Background()
	actor := db.Actor{UserID: s.UserID, SpaceID: s.Space1, SessionID: s.SessionID}
	users := []string{s.UserID, s.User2ID}

	output, failure := push.Register(ctx, database, vault, actor, raw(`{"token":"abcdefgh"}`))
	if failure != nil || output.(map[string]any)["ok"] != true {
		t.Fatalf("register = %v %v", output, failure)
	}
	rows := pushRows(t, database, users...)
	if len(rows) != 1 || rows[0].Plaintext != "abcdefgh" || rows[0].TokenDigest != pushDigest("abcdefgh") ||
		rows[0].SessionID != s.SessionID || rows[0].Presentation != nil {
		t.Fatalf("rows = %+v", rows)
	}

	// A re-registration replaces the row, and the presentation travels with it.
	if _, failure := push.Register(ctx, database, vault, actor, raw(`{"token":"abcdefgh","presentation":"android_sender"}`)); failure != nil {
		t.Fatal(failure)
	}
	rows = pushRows(t, database, users...)
	if len(rows) != 1 || rows[0].Presentation == nil || *rows[0].Presentation != "android_sender" {
		t.Fatalf("re-registered = %+v", rows)
	}
	// A second token from the same session replaces the session's first one.
	if _, failure := push.Register(ctx, database, vault, actor, raw(`{"token":"ijklmnop"}`)); failure != nil {
		t.Fatal(failure)
	}
	rows = pushRows(t, database, users...)
	if len(rows) != 1 || rows[0].Plaintext != "ijklmnop" || rows[0].Presentation != nil {
		t.Fatalf("rotated = %+v", rows)
	}

	// Another session of the account keeps its own token; moving that token to this
	// session takes the row over without dropping the other session's registration.
	addSession(t, database, s.SessionID+"-b", s.SessionToken+"b", s.UserID, `now() + interval '7 days'`)
	if _, failure := push.Register(ctx, database, vault, db.Actor{UserID: s.UserID, SpaceID: s.Space1, SessionID: s.SessionID + "-b"},
		raw(`{"token":"othersession"}`)); failure != nil {
		t.Fatal(failure)
	}
	rows = pushRows(t, database, users...)
	if len(rows) != 2 {
		t.Fatalf("two sessions = %+v", rows)
	}
	if _, failure := push.Register(ctx, database, vault, actor, raw(`{"token":"othersession"}`)); failure != nil {
		t.Fatal(failure)
	}
	rows = pushRows(t, database, users...)
	if len(rows) != 1 || rows[0].SessionID != s.SessionID || rows[0].Plaintext != "othersession" {
		t.Fatalf("moved token = %+v", rows)
	}

	// One physical token has one owner: another account's row for it goes.
	addSession(t, database, s.User2ID+"-session", s.SessionToken+"2", s.User2ID, `now() + interval '7 days'`)
	if _, failure := push.Register(ctx, database, vault, db.Actor{UserID: s.User2ID, SpaceID: s.Space1, SessionID: s.User2ID + "-session"},
		raw(`{"token":"sharedtoken"}`)); failure != nil {
		t.Fatal(failure)
	}
	if _, failure := push.Register(ctx, database, vault, actor, raw(`{"token":"sharedtoken"}`)); failure != nil {
		t.Fatal(failure)
	}
	// The takeover also replaced this session's previous token, so one row is left.
	rows = pushRows(t, database, users...)
	if len(rows) != 1 || rows[0].UserID != s.UserID || rows[0].Plaintext != "sharedtoken" {
		t.Fatalf("after takeover = %+v", rows)
	}

	// A session that is gone, expired, or someone else's writes nothing.
	before := len(pushRows(t, database, users...))
	if _, failure := push.Register(ctx, database, vault, db.Actor{UserID: s.UserID, SpaceID: s.Space1, SessionID: "gone"},
		raw(`{"token":"gonetoken"}`)); failure == nil || failure.Code != "UNAUTHORIZED" || failure.Message != "Unauthorized" {
		t.Fatalf("missing session = %v", failure)
	}
	addSession(t, database, s.SessionID+"-old", s.SessionToken+"o", s.UserID, `now() - interval '1 second'`)
	if _, failure := push.Register(ctx, database, vault, db.Actor{UserID: s.UserID, SpaceID: s.Space1, SessionID: s.SessionID + "-old"},
		raw(`{"token":"expiredtoken"}`)); failure == nil || failure.Code != "UNAUTHORIZED" {
		t.Fatalf("expired session = %v", failure)
	}
	if _, failure := push.Register(ctx, database, vault, db.Actor{UserID: s.UserID, SpaceID: s.Space1, SessionID: s.User2ID + "-session"},
		raw(`{"token":"foreignsession"}`)); failure == nil || failure.Code != "UNAUTHORIZED" {
		t.Fatalf("foreign session = %v", failure)
	}
	if after := len(pushRows(t, database, users...)); after != before {
		t.Fatalf("ended sessions wrote %d row(s)", after-before)
	}

	// A registration without a session id is refused before the store is touched.
	if _, failure := push.Register(ctx, database, vault, db.Actor{UserID: s.UserID, SpaceID: s.Space1},
		raw(`{"token":"nosession"}`)); failure == nil || failure.Code != "UNAUTHORIZED" {
		t.Fatalf("no session id = %v", failure)
	}
	// No credential store: a 500 rather than a value nobody could read.
	if _, failure := push.Register(ctx, database, nil, actor, raw(`{"token":"nostorevalue"}`)); failure == nil || failure.Status != 500 {
		t.Fatalf("no vault = %v", failure)
	}

	// Concurrent registrations of one token serialize on the store's token lock.
	var mutex sync.Mutex
	var codes []string
	done := make(chan struct{})
	for range 3 {
		go func() {
			defer func() { done <- struct{}{} }()
			if _, failure := push.Register(ctx, database, vault, actor, raw(`{"token":"race-token"}`)); failure != nil {
				mutex.Lock()
				codes = append(codes, failure.Code)
				mutex.Unlock()
			}
		}()
	}
	for range 3 {
		<-done
	}
	if len(codes) != 0 {
		t.Fatalf("concurrent registrations failed: %v", codes)
	}
	if raceRows := pushRows(t, database, s.UserID); len(raceRows) != 1 || raceRows[0].Plaintext != "race-token" {
		t.Fatalf("race rows = %+v", raceRows)
	}
}

// The call transports share one row per device: a registration merges into the
// stored value, keeps the other transport's token, and takes over a device or a
// token another account held.
func TestCallPushRegistration(t *testing.T) {
	database := openTestDB(t)
	s := seed(t, database)
	cleanupPush(t, database, s.UserID, s.User2ID)
	vault := pushVault(t, database)
	ctx := context.Background()
	actor := db.Actor{UserID: s.UserID, SpaceID: s.Space1, SessionID: s.SessionID}
	users := []string{s.UserID, s.User2ID}
	const device = "8f14e45f-ea4b-4f3c-8f2c-0b6a1d9e7c10"
	const otherDevice = "c9f0f895-fb98-4b3a-8a1c-6d7e8f901234"
	voip := strings.Repeat("a", 64)

	if _, failure := push.RegisterCall(ctx, database, vault, actor, raw(`{"deviceId":"`+device+`","platform":"ios","voipToken":"`+voip+`"}`)); failure != nil {
		t.Fatal(failure)
	}
	devices := deviceRows(t, database, users...)
	if len(devices) != 1 {
		t.Fatalf("devices = %+v", devices)
	}
	first := devices[0]
	var firstValue map[string]any
	if err := json.Unmarshal([]byte(first.Plaintext), &firstValue); err != nil {
		t.Fatal(err)
	}
	if firstValue["deviceId"] != device || firstValue["platform"] != "ios" || firstValue["voipToken"] != voip {
		t.Fatalf("stored = %s", first.Plaintext)
	}
	if first.Voip == nil || *first.Voip != pushDigest(voip) || first.Expo != nil || first.UserID != s.UserID {
		t.Fatalf("row = %+v", first)
	}

	// The same device adds the Expo transport: the stored VoIP token stays.
	if _, failure := push.RegisterCall(ctx, database, vault, actor, raw(`{"deviceId":"`+device+`","platform":"ios","expoToken":"ExponentPushToken[abc]"}`)); failure != nil {
		t.Fatal(failure)
	}
	devices = deviceRows(t, database, users...)
	if len(devices) != 1 {
		t.Fatalf("merged = %+v", devices)
	}
	var merged map[string]any
	if err := json.Unmarshal([]byte(devices[0].Plaintext), &merged); err != nil {
		t.Fatal(err)
	}
	if merged["voipToken"] != voip || merged["expoToken"] != "ExponentPushToken[abc]" {
		t.Fatalf("merged = %s", devices[0].Plaintext)
	}
	if devices[0].Expo == nil || *devices[0].Expo != pushDigest("ExponentPushToken[abc]") {
		t.Fatalf("digests = %+v", devices[0])
	}
	// The stored key order is the merge's: the previous shape, a new field appended.
	if !strings.HasSuffix(devices[0].Plaintext, `"expoToken":"ExponentPushToken[abc]"}`) {
		t.Fatalf("key order = %s", devices[0].Plaintext)
	}

	// Another account's device with the same id is taken over.
	addSession(t, database, s.User2ID+"-session", s.SessionToken+"2", s.User2ID, `now() + interval '7 days'`)
	other := db.Actor{UserID: s.User2ID, SpaceID: s.Space1, SessionID: s.User2ID + "-session"}
	if _, failure := push.RegisterCall(ctx, database, vault, other, raw(`{"deviceId":"`+otherDevice+`","platform":"android","expoToken":"ExponentPushToken[shared]"}`)); failure != nil {
		t.Fatal(failure)
	}
	// This account's device registers the same Expo token: the other device's row goes.
	if _, failure := push.RegisterCall(ctx, database, vault, actor, raw(`{"deviceId":"`+device+`","platform":"android","expoToken":"ExponentPushToken[shared]"}`)); failure != nil {
		t.Fatal(failure)
	}
	devices = deviceRows(t, database, users...)
	if len(devices) != 1 || devices[0].UserID != s.UserID {
		t.Fatalf("handover = %+v", devices)
	}

	// Taking over another account's device id moves the row.
	if _, failure := push.RegisterCall(ctx, database, vault, other, raw(`{"deviceId":"`+device+`","platform":"ios","voipToken":"`+voip+`"}`)); failure != nil {
		t.Fatal(failure)
	}
	if _, failure := push.RegisterCall(ctx, database, vault, actor, raw(`{"deviceId":"`+device+`","platform":"ios","voipToken":"`+voip+`"}`)); failure != nil {
		t.Fatal(failure)
	}
	devices = deviceRows(t, database, users...)
	if len(devices) != 1 || devices[0].UserID != s.UserID || devices[0].SessionID != s.SessionID {
		t.Fatalf("device takeover = %+v", devices)
	}

	// Input and session branches.
	if _, failure := push.RegisterCall(ctx, database, vault, actor, raw(`{"deviceId":"`+device+`","platform":"android"}`)); failure == nil ||
		failure.Status != 400 || failure.Message != "Input validation failed" {
		t.Fatalf("refinement = %v", failure)
	}
	if _, failure := push.RegisterCall(ctx, database, vault, db.Actor{UserID: s.UserID, SpaceID: s.Space1, SessionID: "gone"},
		raw(`{"deviceId":"`+device+`","platform":"android","expoToken":"ExponentPushToken[gone]"}`)); failure == nil || failure.Code != "UNAUTHORIZED" {
		t.Fatalf("ended session = %v", failure)
	}
	if _, failure := push.RegisterCall(ctx, database, vault, db.Actor{UserID: s.UserID, SpaceID: s.Space1},
		raw(`{"deviceId":"`+device+`","platform":"android","expoToken":"ExponentPushToken[none]"}`)); failure == nil || failure.Code != "UNAUTHORIZED" {
		t.Fatalf("no session id = %v", failure)
	}
}

// Unregistration ends the calling session's registrations on both transports and
// nothing else.
func TestUnregisterPush(t *testing.T) {
	database := openTestDB(t)
	s := seed(t, database)
	cleanupPush(t, database, s.UserID, s.User2ID)
	vault := pushVault(t, database)
	ctx := context.Background()
	actor := db.Actor{UserID: s.UserID, SpaceID: s.Space1, SessionID: s.SessionID}
	users := []string{s.UserID, s.User2ID}
	addSession(t, database, s.SessionID+"-b", s.SessionToken+"b", s.UserID, `now() + interval '7 days'`)
	second := db.Actor{UserID: s.UserID, SpaceID: s.Space1, SessionID: s.SessionID + "-b"}
	addSession(t, database, s.User2ID+"-session", s.SessionToken+"2", s.User2ID, `now() + interval '7 days'`)
	other := db.Actor{UserID: s.User2ID, SpaceID: s.Space1, SessionID: s.User2ID + "-session"}

	for _, who := range []db.Actor{actor, second, other} {
		if _, failure := push.Register(ctx, database, vault, who, raw(`{"token":"abcdefgh"}`)); failure != nil {
			t.Fatal(failure)
		}
	}
	if _, failure := push.RegisterCall(ctx, database, vault, actor, raw(`{"deviceId":"8f14e45f-ea4b-4f3c-8f2c-0b6a1d9e7c10","platform":"ios","voipToken":"`+strings.Repeat("b", 64)+`"}`)); failure != nil {
		t.Fatal(failure)
	}
	if _, failure := push.RegisterCall(ctx, database, vault, second, raw(`{"deviceId":"c9f0f895-fb98-4b3a-8a1c-6d7e8f901234","platform":"android","expoToken":"ExponentPushToken[b]"}`)); failure != nil {
		t.Fatal(failure)
	}
	if _, failure := push.Unregister(ctx, database, actor, raw(``)); failure != nil {
		t.Fatal(failure)
	}
	if rows := pushRows(t, database, users...); len(rows) != 1 || rows[0].UserID != s.User2ID {
		t.Fatalf("tokens after unregister = %+v", rows)
	}
	devices := deviceRows(t, database, users...)
	if len(devices) != 1 || devices[0].SessionID != s.SessionID+"-b" {
		t.Fatalf("devices after unregister = %+v", devices)
	}

	// The session-less path removes every message token of the account and leaves
	// the call devices alone.
	if _, failure := push.Unregister(ctx, database, db.Actor{UserID: s.UserID, SpaceID: s.Space1}, raw(``)); failure != nil {
		t.Fatal(failure)
	}
	if rows := pushRows(t, database, s.UserID); len(rows) != 0 {
		t.Fatalf("tokens left = %+v", rows)
	}
	if devices := deviceRows(t, database, s.UserID); len(devices) != 1 {
		t.Fatalf("devices changed = %+v", devices)
	}
	// Unregistering again changes nothing.
	if _, failure := push.Unregister(ctx, database, actor, raw(``)); failure != nil {
		t.Fatal(failure)
	}
}
