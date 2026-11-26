package vaultstore

// prepareBotSecret and storeBotSecret (packages/adapters/src/secrets/bot-secrets.ts:845-906,
// 1103-1112): the one write path vault.put, botSecrets.put, agentSecrets.put, vault.import and
// vault.remove's relabel share.
//
// The value is sealed before the transaction opens (so the transaction holds its locks for one
// round trip, as TypeScript's prepared write does), the row is written under the member's
// settings lock and the row's own lock, and the secret-persistence hook tracks the new
// reference before the statement and captures the replaced one before the UPDATE — exactly the
// hook's contract (infra-c design §3).

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/contentcrypto"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/effects"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/agentsecrets"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/shared"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/spacesettings"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/secretstore"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/validate"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/whatwgurl"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/wtf8"
	"golang.org/x/text/unicode/norm"
)

// Vault messages (bot-secrets.ts:105-157,198-210,1018,1056).
const (
	spaceVaultNotInUse = "This Space uses the account vault"
	vaultChanged       = "Vault changed while saving; retry"
	vaultFullMessage   = "Credential limit reached"
	savedLoginUnread   = "The saved login could not be read. Try again."
	unknownBots        = "Choose from your bots in this Space"
	tooManyItems       = 100 // VAULT_ITEM_LIMIT
)

// transactionConflict is TransactionConflictError: a CONFLICT the retry loop reruns.
type transactionConflict struct{ message string }

func (c *transactionConflict) Error() string { return c.message }

// secretAlreadySaved is SecretAlreadySavedError: create-only saw the name taken.
type secretAlreadySaved struct{}

func (*secretAlreadySaved) Error() string { return "A credential with this name is already saved" }

func isSecretAlreadySaved(err error) bool {
	var saved *secretAlreadySaved
	return errors.As(err, &saved)
}

// vaultFields is vaultFields (bot-secrets.ts:168-173).
type vaultFields struct {
	userID  string
	spaceID *string
}

func (f vaultFields) equal(other vaultFields) bool {
	left, right := f.spaceID, other.spaceID
	if (left == nil) != (right == nil) {
		return false
	}
	return f.userID == other.userID && (left == nil || *left == *right)
}

// row is one vault_credentials row with what a save reads of it.
type row struct {
	id             string
	userID         string
	spaceID        *string
	name           string
	origin         string
	auth           []byte
	ciphertext     string
	policy         string
	title          string
	note           string
	alsoOn         []string
	codesStoppedAt *time.Time
	createdAt      time.Time
	updatedAt      time.Time
}

const rowColumns = `id, "userId", "spaceId", name, origin, auth, ciphertext, policy, title, note,
	"alsoOn", "codesStoppedAt", "createdAt", "updatedAt"`

func scanRow(scanner interface{ Scan(...any) error }) (*row, error) {
	record := &row{}
	err := scanner.Scan(&record.id, &record.userID, &record.spaceID, &record.name, &record.origin,
		&record.auth, &record.ciphertext, &record.policy, &record.title, &record.note,
		&record.alsoOn, &record.codesStoppedAt, &record.createdAt, &record.updatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return record, nil
}

// writer is one request's view of the credential store.
type writer struct {
	database *db.DB
	vault    *shared.SecretVault
	ring     *contentcrypto.KeyRing
	actor    db.Actor
	// scope is the request's SettingsScope, empty when it was omitted.
	scope string
}

// fieldsFor is vaultFields: the account vault (no Space) or this Space's own.
func (w *writer) fieldsFor(ctx context.Context, tx pgx.Tx) (vaultFields, error) {
	return w.resolveFields(ctx, tx, w.scope)
}

// resolveFields is vaultFields(prisma, scope): the requested setting wins, and an absent one is
// the Space's own choice (an override, else the account vault).
func (w *writer) resolveFields(ctx context.Context, tx pgx.Tx, requested string) (vaultFields, error) {
	target, err := spacesettings.Target(ctx, tx, w.actor, "credentials", requested)
	if err != nil {
		return vaultFields{}, err
	}
	if target == "space" {
		id := w.actor.SpaceID
		return vaultFields{userID: w.actor.UserID, spaceID: &id}, nil
	}
	return vaultFields{userID: w.actor.UserID}, nil
}

// sameVault reports whether two field sets name one vault.
func sameVault(left, right vaultFields) bool {
	if left.userID != right.userID {
		return false
	}
	if left.spaceID == nil || right.spaceID == nil {
		return left.spaceID == nil && right.spaceID == nil
	}
	return *left.spaceID == *right.spaceID
}

// readFields runs fieldsFor in its own tenant transaction, as TypeScript's autocommit read
// does under the request's tenant context.
func (w *writer) readFields(ctx context.Context) (vaultFields, error) {
	var fields vaultFields
	err := w.database.Tenant(ctx, w.actor, func(tx pgx.Tx) error {
		var failure error
		fields, failure = w.fieldsFor(ctx, tx)
		return failure
	})
	return fields, err
}

// assertVaultInUse is assertVaultInUse (bot-secrets.ts:160-166): a write aimed at a Space's
// own vault is refused once the Space no longer keeps one.
func (w *writer) assertVaultInUse(ctx context.Context, tx pgx.Tx) error {
	if w.scope != "space" {
		return nil
	}
	target, err := spacesettings.Target(ctx, tx, w.actor, "credentials", "")
	if err != nil {
		return err
	}
	if target != "space" {
		return badRequest(spaceVaultNotInUse)
	}
	return nil
}

// lockVault is lockVault (bot-secrets.ts:100-104): the member's settings lock, then the person's
// own row, which orders every vault write of this member.
func lockVault(ctx context.Context, tx pgx.Tx, actor db.Actor) error {
	var locked int
	err := tx.QueryRow(ctx,
		`SELECT 1 FROM space_members WHERE "spaceId" = $1 AND "userId" = $2 FOR UPDATE`,
		actor.SpaceID, actor.UserID).Scan(&locked)
	if errors.Is(err, pgx.ErrNoRows) {
		return errors.New("Space membership not found")
	}
	if err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `SELECT id FROM "user" WHERE id = $1 FOR UPDATE`, actor.UserID); err != nil {
		return err
	}
	return nil
}

// findRow reads the caller's row of this name, optionally under its lock.
func findRow(ctx context.Context, tx pgx.Tx, fields vaultFields, name string, lock bool) (*row, error) {
	query := `SELECT ` + rowColumns + ` FROM vault_credentials
		WHERE "userId" = $1 AND "spaceId" IS NOT DISTINCT FROM $2::text AND name = $3`
	//writeaudit:dynamic read: the column list is rowColumns and the name is a filter
	if lock {
		query += ` FOR UPDATE`
	}
	return scanRow(tx.QueryRow(ctx, query, fields.userID, fields.spaceID, name))
}

// countRows is vaultCredential.count({where: vault}).
func countRows(ctx context.Context, tx pgx.Tx, fields vaultFields) (int, error) {
	var count int
	err := tx.QueryRow(ctx,
		`SELECT count(*)::int FROM vault_credentials WHERE "userId" = $1 AND "spaceId" IS NOT DISTINCT FROM $2::text`,
		fields.userID, fields.spaceID).Scan(&count)
	return count, err
}

// botsInput is VaultItemBots: what a save may change about which bots use an item.
type botsInput struct {
	allBots *bool
	botIDs  []string
	hasIDs  bool
}

// custom is one vault.put field that is written only when the request carried it.
type custom struct {
	title, note, policy *string
	bots                *botsInput
	alsoOn              []string
	hasAlsoOn           bool
}

// prepared is prepareBotSecret's answer: a sealed value and the writes that adopt it.
type prepared struct {
	id          string
	ciphertext  string
	destination Destination
	plaintext   string
	fields      vaultFields
	existing    *row
	keepsKey    bool
	createOnly  bool
	custom      custom
}

// policyField is policyField (bot-secrets.ts:1436-1442).
func policyField(auth Auth, policy *string) error {
	if policy == nil {
		return nil
	}
	// An auth that no longer parses has no type: BotSecretAuth.safeParse(...).data is undefined,
	// and only "ask" refuses then (an unreadable type is not a login).
	if auth.Type == "contact" || (*policy == "ask" && auth.Type != "login") {
		return badRequest(unsupportedAccess)
	}
	return nil
}

// alsoOnField is alsoOnField (bot-secrets.ts:1447-1460): HTTPS origins a login may also fill,
// each once, without its own site.
func alsoOnField(auth Auth, origin string, alsoOn []string, hasAlsoOn bool) ([]string, error) {
	if !hasAlsoOn {
		return nil, nil
	}
	if len(alsoOn) > 0 && auth.Type != "login" {
		return nil, badRequest(unsupportedAccess)
	}
	sites := make([]string, 0, len(alsoOn))
	for _, site := range alsoOn {
		parsed, ok := otherSiteOrigin(validate.JSTrim(site))
		if !ok {
			return nil, badRequest("Invalid credential destination — every other site must be an " +
				"HTTPS address a login can be saved for")
		}
		sites = append(sites, parsed)
	}
	seen := map[string]bool{}
	unique := make([]string, 0, len(sites))
	for _, site := range sites {
		if site == origin || seen[site] {
			continue
		}
		seen[site] = true
		unique = append(unique, site)
	}
	return unique, nil
}

// normalizeExisting is normalizeSecretDestination over a stored row; a row that no longer
// validates refuses the save, exactly as the adapter's parse throws.
func normalizeExisting(record *row) (Destination, error) {
	auth, ok := authFromJSON(record.auth)
	if !ok {
		return Destination{}, badRequest("Invalid credential destination — auth.type: Invalid " +
			"discriminator value. Expected 'bearer' | 'header' | 'basic' | 'login' | 'command' | " +
			"'card' | 'contact'")
	}
	return normalizeDestination(Destination{Name: record.name, Origin: record.origin, Auth: auth})
}

// authFromJSON reads a stored BotSecretAuth.
func authFromJSON(raw []byte) (Auth, bool) {
	if len(raw) == 0 {
		return Auth{}, false
	}
	value, err := validate.DecodeAny(raw)
	if err != nil {
		return Auth{}, false
	}
	object, ok := value.(*validate.Object)
	if !ok {
		return Auth{}, false
	}
	kind, ok := object.Values["type"].(string)
	if !ok {
		return Auth{}, false
	}
	auth := Auth{Type: kind}
	switch kind {
	case "bearer", "login", "command", "card", "contact":
	case "header":
		auth.Name, ok = object.Values["name"].(string)
		if !ok {
			return Auth{}, false
		}
	case "basic":
		auth.Username, ok = object.Values["username"].(string)
		if !ok {
			return Auth{}, false
		}
	default:
		return Auth{}, false
	}
	return auth, true
}

// sameDestination is sameSecretDestination (bot-secrets.ts:730-740).
func sameDestination(left, right Destination) bool {
	return left.Name == right.Name && left.Origin == right.Origin && left.Auth == right.Auth
}

// validate is prepareBotSecret's validate (bot-secrets.ts:925-940).
func validateSave(record *row, count int, destination Destination, createOnly bool) error {
	if record != nil && createOnly {
		return &secretAlreadySaved{}
	}
	if record != nil {
		saved, err := normalizeExisting(record)
		if err != nil {
			return err
		}
		// A save the bot started may move a login to another site (input.replaces); the owner's
		// own saves pass no replaces, so a different destination is always a refusal.
		if !sameDestination(saved, destination) {
			return badRequest("Remove the existing credential before changing its destination")
		}
	}
	if record == nil && count >= tooManyItems {
		return badRequest(vaultFullMessage)
	}
	return nil
}

// loadSavedValue is loadSavedValue (bot-secrets.ts:1024-1039): the stored value, or nil when it
// is known to be unreadable; an outage is the retry conflict.
func (w *writer) loadSavedValue(ctx context.Context, record *row) (*string, error) {
	identity := secretstore.VaultRow{ID: record.id, UserID: record.userID, SpaceID: record.spaceID}
	plaintext, err := secretstore.OpenVaultValue(ctx, w.ring, w.vault.Writer, identity, record.ciphertext)
	if err == nil {
		return &plaintext, nil
	}
	var decryption *secretstore.DecryptionError
	if errors.As(err, &decryption) || secretstore.IsPermanentDecryptFailure(err) {
		return nil, nil
	}
	return nil, conflict(savedLoginUnread)
}

// savedLoginKey is savedLoginKey (bot-secrets.ts:1041-1054).
func (w *writer) savedLoginKey(ctx context.Context, record *row) (string, error) {
	auth, ok := authFromJSON(record.auth)
	if !ok || auth.Type != "login" {
		return "", nil
	}
	plaintext, err := w.loadSavedValue(ctx, record)
	if err != nil || plaintext == nil {
		return "", err
	}
	canonical, err := canonicalLogin(*plaintext)
	if err != nil {
		return "", nil
	}
	value, err := validate.DecodeAny([]byte(canonical))
	if err != nil {
		return "", nil
	}
	object, ok := value.(*validate.Object)
	if !ok {
		return "", nil
	}
	otp, _ := object.Values["otp"].(string)
	return otp, nil
}

// findCommandVariableConflict is findCommandVariableConflict (bot-secrets.ts:500-518).
func findCommandVariableConflict(ctx context.Context, tx pgx.Tx, fields vaultFields, destination Destination) (string, error) {
	if destination.Auth.Type != "command" {
		return "", nil
	}
	variable := agentsecrets.CommandVariableName(destination.Name)
	rows, err := tx.Query(ctx,
		`SELECT name, auth FROM vault_credentials
		 WHERE "userId" = $1 AND "spaceId" IS NOT DISTINCT FROM $2::text AND name <> $3
		 ORDER BY name ASC`, fields.userID, fields.spaceID, destination.Name)
	if err != nil {
		return "", err
	}
	defer rows.Close()
	for rows.Next() {
		var name string
		var auth []byte
		if err := rows.Scan(&name, &auth); err != nil {
			return "", err
		}
		stored, ok := authFromJSON(auth)
		if !ok || stored.Type != "command" {
			continue
		}
		if agentsecrets.CommandVariableName(name) == variable {
			return name, nil
		}
	}
	return "", rows.Err()
}

// prepare is prepareBotSecret: every read the save needs, then the seal. It opens its own
// tenant transactions for the reads, as the TypeScript client autocommits them.
func (w *writer) prepare(ctx context.Context, destination Destination, plaintext string,
	createOnly bool, changes custom) (*prepared, error) {
	if plaintext == "" || wtf8.Length(plaintext) > secretValueMax {
		return nil, badRequest(invalidLengthError)
	}
	normalized, err := normalizeDestination(destination)
	if err != nil {
		return nil, err
	}
	destination = normalized
	if err := policyField(destination.Auth, changes.policy); err != nil {
		return nil, err
	}
	if sites, err := alsoOnField(destination.Auth, destination.Origin, changes.alsoOn,
		changes.hasAlsoOn); err != nil {
		return nil, err
	} else if changes.hasAlsoOn {
		// The row holds the normalized list (trimmed, origin-reduced, deduped, own site dropped).
		changes.alsoOn = sites
	}
	value, err := checkValueKind(destination, plaintext)
	if err != nil {
		return nil, err
	}
	var fields vaultFields
	var existing *row
	var count int
	hasOTP := false
	if destination.Auth.Type == "login" {
		hasOTP = jsonHasKey(plaintext, "otp")
	}
	err = w.database.Tenant(ctx, w.actor, func(tx pgx.Tx) error {
		if err := w.assertVaultInUse(ctx, tx); err != nil {
			return err
		}
		var failure error
		if fields, failure = w.fieldsFor(ctx, tx); failure != nil {
			return failure
		}
		if existing, failure = findRow(ctx, tx, fields, destination.Name, false); failure != nil {
			return failure
		}
		if count, failure = countRows(ctx, tx, fields); failure != nil {
			return failure
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	keepsKey := destination.Auth.Type == "login" && existing != nil && !hasOTP
	if err := validateSave(existing, count, destination, createOnly); err != nil {
		return nil, err
	}
	if keepsKey {
		otp, err := w.savedLoginKey(ctx, existing)
		if err != nil {
			return nil, err
		}
		if otp != "" {
			value, err = withLoginOTP(value, otp)
			if err != nil {
				return nil, err
			}
		}
	}
	id := ""
	if existing != nil {
		id = existing.id
	} else {
		raw := make([]byte, 12)
		if _, err := rand.Read(raw); err != nil {
			return nil, err
		}
		id = hex.EncodeToString(raw)
	}
	ciphertext, err := w.seal(ctx, id, fields, value)
	if err != nil {
		return nil, err
	}
	return &prepared{
		id: id, ciphertext: ciphertext, destination: destination, plaintext: value,
		fields: fields, existing: existing, keepsKey: keepsKey, createOnly: createOnly,
		custom: changes,
	}, nil
}

// seal is sealVaultValue for the row the value will be written to: under the vault's key once
// it has one, otherwise the SecretStore envelope bound to the row id. The newest-key lookup runs
// in the caller's tenant transaction, as TypeScript's read runs under the request's tenant.
func (w *writer) seal(ctx context.Context, id string, fields vaultFields, plaintext string) (string, error) {
	// The announcement waits for the read transaction to end: publishing from inside it would take a
	// second pooled connection while this one is held, and four concurrent legacy seals exhaust the
	// gateway's four-connection pool (secret-store-factory.ts:71-82 documents the same trap).
	held := w.vault.Writer.Hold()
	// Flushed on every exit, as holdSecretNotifications flushes in a finally: the seal's read
	// transaction is over by then, and a failure after the seal still announces the value it
	// could not keep (a failed seal records no ref, so nothing is announced for it).
	defer held.Flush(ctx)
	var ciphertext string
	err := w.database.Tenant(ctx, w.actor, func(tx pgx.Tx) error {
		var failure error
		ciphertext, failure = secretstore.SealVaultValue(ctx, tx, w.ring, held,
			secretstore.VaultRow{ID: id, UserID: fields.userID, SpaceID: fields.spaceID},
			wtf8.ToUTF8(plaintext))
		return failure
	})
	return ciphertext, err
}

// jsonHasKey reports whether the JSON object carries the key, whatever its value.
func jsonHasKey(text, key string) bool {
	value, err := validate.DecodeAny([]byte(text))
	if err != nil {
		return false
	}
	object, ok := value.(*validate.Object)
	if !ok {
		return false
	}
	_, present := object.Get(key)
	return present
}

// withLoginOTP keeps a saved authenticator key on a login saved without one
// (bot-secrets.ts:995-997): plaintext = encodeLoginSecret({...decodeLoginSecret(plaintext), otp}).
func withLoginOTP(plaintext, otp string) (string, error) {
	value, err := decodeLogin(plaintext)
	if err != nil {
		return "", err
	}
	value.OTP = &otp
	return encodeLogin(value)
}

// retry is withTransactionRetry (packages/db/src/database/transaction-retry.ts:48-66): the
// operation runs again, up to three times in all, when it lost a serialization or deadlock
// conflict, or when the row changed under it.
func (w *writer) retry(ctx context.Context, operation func() error) error {
	for attempt := 1; ; attempt++ {
		err := operation()
		if err == nil {
			return err
		}
		var lost *transactionConflict
		if !errors.As(err, &lost) && !shared.TransactionConflict(err) {
			return err
		}
		if attempt >= 3 {
			return err
		}
		if ctxErr := ctx.Err(); ctxErr != nil {
			return err
		}
	}
}

// storeBotSecret is storeBotSecret (bot-secrets.ts:1103-1112): prepare, then one transaction
// that adopts the sealed value under the vault locks, then the persistence hook's cleanup.
func (w *writer) storeBotSecret(
	ctx context.Context,
	destination Destination,
	plaintext string,
	createOnly bool,
	changes custom,
) (*row, error) {
	var saved *row
	err := w.retry(ctx, func() error {
		saved = nil
		prepared, err := w.prepare(ctx, destination, plaintext, createOnly, changes)
		if err != nil {
			return err
		}
		state := w.vault.Persistence.NewState()
		err = w.database.Tenant(ctx, w.actor, func(tx pgx.Tx) error {
			// Tracked before any database access, so a refused transaction still cleans the value
			// sealed for it (secret-persistence.ts:210-247).
			w.vault.Persistence.TrackWrite(state, secretstore.VaultCredential, prepared.id, prepared.ciphertext)
			if err := w.storePrepared(ctx, tx, state, prepared); err != nil {
				return err
			}
			record, err := findRow(ctx, tx, prepared.fields, prepared.destination.Name, false)
			if err != nil {
				return err
			}
			saved = record
			return nil
		})
		w.vault.Persistence.Finish(ctx, state, err)
		return err
	})
	if err != nil {
		return nil, err
	}
	return saved, nil
}

// storePrepared is prepared.store (bot-secrets.ts:955-1014).
func (w *writer) storePrepared(ctx context.Context, tx pgx.Tx, state *secretstore.State, prepared *prepared) error {
	if err := lockVault(ctx, tx, w.actor); err != nil {
		return err
	}
	if prepared.existing != nil {
		if _, err := tx.Exec(ctx, `SELECT id FROM vault_credentials WHERE id = $1 FOR UPDATE`,
			prepared.existing.id); err != nil {
			return err
		}
	}
	if err := w.assertVaultInUse(ctx, tx); err != nil {
		return err
	}
	current, err := findRow(ctx, tx, prepared.fields, prepared.destination.Name, false)
	if err != nil {
		return err
	}
	fields, err := w.fieldsFor(ctx, tx)
	if err != nil {
		return err
	}
	if !fields.equal(prepared.fields) {
		return &transactionConflict{vaultChanged}
	}
	count, err := countRows(ctx, tx, fields)
	if err != nil {
		return err
	}
	if err := validateSave(current, count, prepared.destination, prepared.createOnly); err != nil {
		return err
	}
	conflictName, err := findCommandVariableConflict(ctx, tx, fields, prepared.destination)
	if err != nil {
		return err
	}
	if conflictName != "" {
		return badRequest("Invalid credential destination — name: " + conflictName +
			" is already exported as $" + agentsecrets.CommandVariableName(prepared.destination.Name))
	}
	// The kept key was read before the lock, so a value saved since then is read again here.
	if changedCiphertext(current, prepared) {
		return &transactionConflict{"Credential changed while saving; retry"}
	}
	if current != nil {
		return w.updateRow(ctx, tx, state, prepared, current)
	}
	return w.createRow(ctx, tx, prepared)
}

// changedCiphertext is the value-changed guard in prepared.store (bot-secrets.ts:988-995).
func changedCiphertext(current *row, prepared *prepared) bool {
	if (current == nil) != (prepared.existing == nil) {
		return true
	}
	if current == nil {
		return false
	}
	if current.id != prepared.existing.id {
		return true
	}
	if prepared.keepsKey && current.ciphertext != prepared.existing.ciphertext {
		return true
	}
	currentKey, currentOK := contentcrypto.CiphertextKeyID(current.ciphertext)
	existingKey, existingOK := contentcrypto.CiphertextKeyID(prepared.existing.ciphertext)
	return currentOK != existingOK || currentKey != existingKey
}

// labelled is the row's mutable labels as the save sets them (bot-secrets.ts:998-1013).
type labelled struct {
	codesStopped bool
	title        *string
	note         *string
	policy       *string
	alsoOn       []string
	hasAlsoOn    bool
}

func labelsFor(current *row, prepared *prepared) labelled {
	set := labelled{title: prepared.custom.title, note: prepared.custom.note, policy: prepared.custom.policy}
	if current != nil && current.codesStoppedAt != nil {
		// Its owner's own save may carry a fixed key, so its codes are typed again.
		set.codesStopped = true
	}
	if prepared.custom.hasAlsoOn {
		set.hasAlsoOn = true
		set.alsoOn = append([]string{}, prepared.custom.alsoOn...)
		return set
	}
	if current == nil {
		return set
	}
	// A login moved to one of its other sites no longer lists that site.
	for _, site := range current.alsoOn {
		if site != prepared.destination.Origin {
			continue
		}
		filtered := make([]string, 0, len(current.alsoOn))
		for _, other := range current.alsoOn {
			if other != prepared.destination.Origin {
				filtered = append(filtered, other)
			}
		}
		set.alsoOn, set.hasAlsoOn = filtered, true
		return set
	}
	return set
}

// updateRow replaces the value of an existing row, capturing the reference it held.
func (w *writer) updateRow(ctx context.Context, tx pgx.Tx, state *secretstore.State, prepared *prepared, current *row) error {
	labels := labelsFor(current, prepared)
	if err := w.vault.Persistence.CaptureDropped(ctx, tx, state, secretstore.VaultCredential,
		`SELECT id FROM vault_credentials WHERE id = $1`, current.id); err != nil {
		return err
	}
	assignments := []string{"origin = $1", "ciphertext = $2"}
	args := []any{prepared.destination.Origin, prepared.ciphertext}
	if labels.codesStopped {
		assignments = append(assignments, `"codesStoppedAt" = NULL`)
	}
	if labels.title != nil {
		args = append(args, *labels.title)
		assignments = append(assignments, "title = $"+strconv.Itoa(len(args)))
	}
	if labels.note != nil {
		args = append(args, *labels.note)
		assignments = append(assignments, "note = $"+strconv.Itoa(len(args)))
	}
	if labels.policy != nil {
		args = append(args, *labels.policy)
		assignments = append(assignments, "policy = $"+strconv.Itoa(len(args)))
	}
	if labels.hasAlsoOn {
		args = append(args, labels.alsoOn)
		assignments = append(assignments, `"alsoOn" = $`+strconv.Itoa(len(args)))
	}
	args = append(args, time.Now().UTC().Truncate(time.Millisecond))
	dataCount := len(args)
	assignments = append(assignments, `"updatedAt" = $`+strconv.Itoa(dataCount))
	args = append(args, current.id)
	arguments := append(db.Data(args[:dataCount]...), args[dataCount:]...)
	//writeaudit:dynamic the SET list is built from optional fields; args[:dataCount] is wrapped with db.Data and the suffix holds only the id filter
	if _, err := tx.Exec(ctx, `UPDATE vault_credentials SET `+strings.Join(assignments, ", ")+
		` WHERE id = $`+strconv.Itoa(len(args)), arguments...); err != nil {
		return err
	}
	return w.saveItemBots(ctx, tx, prepared.fields, current.id, prepared.custom.bots)
}

// createRow inserts a new item, or a new value under a name the caller chose.
func (w *writer) createRow(ctx context.Context, tx pgx.Tx, prepared *prepared) error {
	now := time.Now().UTC().Truncate(time.Millisecond)
	title, note, policy := "", "", "allow"
	if prepared.custom.title != nil {
		title = *prepared.custom.title
	}
	if prepared.custom.note != nil {
		note = *prepared.custom.note
	}
	if prepared.custom.policy != nil {
		policy = *prepared.custom.policy
	}
	alsoOn := []string{}
	if prepared.custom.hasAlsoOn && prepared.custom.alsoOn != nil {
		alsoOn = prepared.custom.alsoOn
	}
	if _, err := tx.Exec(ctx, `INSERT INTO vault_credentials
		(id, "userId", "spaceId", name, origin, auth, ciphertext, title, note, policy, "alsoOn",
		 "createdAt", "updatedAt")
		VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11, $12, $13)`,
		db.Data(prepared.id, prepared.fields.userID, prepared.fields.spaceID,
			prepared.destination.Name, prepared.destination.Origin,
			db.JSON(authJSONFor(prepared.destination.Auth)),
			prepared.ciphertext, title, note, policy, alsoOn, now, now)...); err != nil {
		return err
	}
	return w.saveItemBots(ctx, tx, prepared.fields, prepared.id, prepared.custom.bots)
}

// authJSONFor builds the stored auth object.
func authJSONFor(auth Auth) map[string]any {
	value := map[string]any{"type": auth.Type}
	switch auth.Type {
	case "header":
		value["name"] = auth.Name
	case "basic":
		value["username"] = auth.Username
	}
	return value
}

// saveItemBots is saveItemBots (bot-secrets.ts:213-258): a choice of bots is never kept
// without the limit it serves, so the two cannot drift apart.
func (w *writer) saveItemBots(ctx context.Context, tx pgx.Tx, owner vaultFields, credentialID string, bots *botsInput) error {
	if bots == nil {
		return nil
	}
	if bots.allBots != nil && *bots.allBots {
		if _, err := tx.Exec(ctx, `DELETE FROM vault_credential_limits
			WHERE "userId" = $1 AND "spaceId" = $2 AND "credentialId" = $3`,
			owner.userID, w.actor.SpaceID, credentialID); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, `DELETE FROM vault_credential_bots
			WHERE "userId" = $1 AND "spaceId" = $2 AND "credentialId" = $3`,
			owner.userID, w.actor.SpaceID, credentialID)
		return err
	}
	if bots.allBots == nil && !bots.hasIDs {
		return nil
	}
	now := time.Now().UTC().Truncate(time.Millisecond)
	limited, err := tx.Exec(ctx, `INSERT INTO vault_credential_limits
		(id, "credentialId", "userId", "spaceId", "createdAt")
		VALUES ($1, $2, $3, $4, $5)
		ON CONFLICT ("credentialId", "spaceId") DO NOTHING`,
		db.Data(effects.NewID(), credentialID, owner.userID, w.actor.SpaceID, now)...)
	if err != nil {
		return err
	}
	// Newly limited, the item starts from no bots: rows an earlier save left behind on an
	// unlimited item were never a choice.
	if limited.RowsAffected() > 0 && !bots.hasIDs {
		_, err := tx.Exec(ctx, `DELETE FROM vault_credential_bots
			WHERE "userId" = $1 AND "spaceId" = $2 AND "credentialId" = $3`,
			owner.userID, w.actor.SpaceID, credentialID)
		return err
	}
	if !bots.hasIDs {
		return nil
	}
	botIDs := uniqueStrings(bots.botIDs)
	if len(botIDs) > 0 {
		// A bot is named from the Space's own vault: when this Space keeps its credentials in a
		// different vault than the item, the choice cannot be honored (bot-secrets.ts:242-246).
		here, err := w.resolveFields(ctx, tx, "")
		if err != nil {
			return err
		}
		if !sameVault(here, owner) {
			return badRequest(unknownBots)
		}
		var found int
		if err := tx.QueryRow(ctx, `SELECT count(*)::int FROM bots
			WHERE "spaceId" = $1 AND id = ANY($2)`, w.actor.SpaceID, botIDs).Scan(&found); err != nil {
			return err
		}
		if found != len(botIDs) {
			return badRequest(unknownBots)
		}
	}
	if _, err := tx.Exec(ctx, `DELETE FROM vault_credential_bots
		WHERE "userId" = $1 AND "spaceId" = $2 AND "credentialId" = $3 AND NOT ("botId" = ANY($4))`,
		owner.userID, w.actor.SpaceID, credentialID, botIDs); err != nil {
		return err
	}
	for _, botID := range botIDs {
		if _, err := tx.Exec(ctx, `INSERT INTO vault_credential_bots
			(id, "credentialId", "botId", "userId", "spaceId", "createdAt")
			VALUES ($1, $2, $3, $4, $5, $6)
			ON CONFLICT ("credentialId", "botId") DO NOTHING`,
			db.Data(effects.NewID(), credentialID, botID, owner.userID, w.actor.SpaceID, now)...); err != nil {
			return err
		}
	}
	return nil
}

func uniqueStrings(values []string) []string {
	seen := make(map[string]bool, len(values))
	out := make([]string, 0, len(values))
	for _, value := range values {
		if seen[value] {
			continue
		}
		seen[value] = true
		out = append(out, value)
	}
	return out
}

// newVaultItemName is newVaultItemName (bot-secrets.ts:1407-1434): a free handle for a new
// item, from its title.
func (w *writer) newVaultItemName(ctx context.Context, base, kind string) (string, error) {
	stem := newVaultItemNameSlug(base)
	if stem == "" {
		stem = kind
	}
	var taken []string
	err := w.database.Tenant(ctx, w.actor, func(tx pgx.Tx) error {
		fields, err := w.fieldsFor(ctx, tx)
		if err != nil {
			return err
		}
		rows, err := tx.Query(ctx, `SELECT name FROM vault_credentials
			WHERE "userId" = $1 AND "spaceId" IS NOT DISTINCT FROM $2::text
				AND starts_with(name, $3)`, fields.userID, fields.spaceID, stem)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var name string
			if err := rows.Scan(&name); err != nil {
				return err
			}
			taken = append(taken, name)
		}
		return rows.Err()
	})
	if err != nil {
		return "", err
	}
	names := make(map[string]bool, len(taken))
	for _, name := range taken {
		names[name] = true
	}
	if !names[stem] {
		return stem, nil
	}
	for suffix := 2; ; suffix++ {
		candidate := stem + "-" + strconv.Itoa(suffix)
		if !names[candidate] {
			return candidate, nil
		}
	}
}

// newVaultItemNameSlug is newVaultItemName's slug step (bot-secrets.ts:1409-1421): the title
// folded to ASCII, lowered, and reduced to [a-z0-9-] between a letter and a letter or digit.
func newVaultItemNameSlug(base string) string {
	slug := casesLower(norm.NFKD.String(base))
	slug = nonSlugRun.ReplaceAllString(slug, "-")
	slug = leadingNonLetter.ReplaceAllString(slug, "")
	slug = trailingDashes.ReplaceAllString(slug, "")
	// The slug is [a-z0-9-] only after the replacements, so a byte cut is the JS UTF-16 cut.
	if len(slug) > 56 {
		slug = slug[:56]
	}
	return slug
}

var (
	nonSlugRun       = regexp.MustCompile(`[^a-z0-9]+`)
	leadingNonLetter = regexp.MustCompile(`^[^a-z]+`)
	trailingDashes   = regexp.MustCompile(`-+$`)
)

// defaultTitle is defaultVaultItemTitle (bot-secrets.ts:1336-1354).
func defaultTitle(destination Destination, plaintext string) string {
	value, err := canonicalValue(destination, plaintext)
	if err != nil {
		return ""
	}
	switch destination.Auth.Type {
	case "card":
		if number := cardNumberOf(value); number != "" {
			return cardTitle(number)
		}
	case "contact":
		if contact, ok := contactOf(value); ok {
			if name, exists := contact["name"].(string); exists && name != "" {
				return name
			}
		}
	}
	return titleFromOrigin(destination.Origin, "")
}

// titleFromOrigin is vaultItemTitle for an item with no title (bot-secrets.ts:1324-1334).
func titleFromOrigin(origin, name string) string {
	if origin == "" {
		return name
	}
	parsed, err := whatwgurl.Parse(origin)
	if err != nil || parsed.Protocol() == "" || parsed.Host() == "" {
		return name
	}
	return strings.TrimPrefix(parsed.Host(), "www.")
}

// cardNumberOf reads the number out of a canonical card value.
func cardNumberOf(canonical string) string {
	value, err := validate.DecodeAny([]byte(canonical))
	if err != nil {
		return ""
	}
	object, ok := value.(*validate.Object)
	if !ok {
		return ""
	}
	number, _ := object.Values["number"].(string)
	return number
}

// contactOf decodes a canonical contact value.
func contactOf(canonical string) (map[string]any, bool) {
	value, err := validate.DecodeAny([]byte(canonical))
	if err != nil {
		return nil, false
	}
	object, ok := value.(*validate.Object)
	if !ok {
		return nil, false
	}
	out := make(map[string]any, len(object.Values))
	for key, entry := range object.Values {
		out[key] = entry
	}
	return out, true
}
