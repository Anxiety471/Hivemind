package secretstore

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"regexp"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
)

// Model names the Prisma models withSecretPersistence hooks
// (secret-persistence.ts:138-151). Only the models whose rows (or cascades)
// hold a secret reference are listed.
type Model string

const (
	Secret                    Model = "Secret"
	BotSecret                 Model = "BotSecret"
	VaultCredential           Model = "VaultCredential"
	IntegrationProviderConfig Model = "IntegrationProviderConfig"

	User         Model = "User"
	Space        Model = "Space"
	Bot          Model = "Bot"
	Organization Model = "Organization"

	MessagingInstallation Model = "MessagingInstallation"
	PaymentWallet         Model = "PaymentWallet"
	Purchase              Model = "Purchase"
)

// CleanupKind is SecretCleanupKind (types.ts:1057-1067). `store_write` names an
// entry written before any row held it; the local store never produces one,
// because only a remote store has an entry to name before writing it.
type CleanupKind string

const (
	KindSecretRow                  CleanupKind = "secret_row"
	KindSecretTables               CleanupKind = "secret_tables"
	KindMessagingInstallation      CleanupKind = "messaging_installation"
	KindDeploymentComputerProvider CleanupKind = "deployment_computer_provider"
	KindPurchaseRequest            CleanupKind = "purchase_request"
	KindPurchaseCard               CleanupKind = "purchase_card"
	KindPurchaseToken              CleanupKind = "purchase_token"
	KindPaymentWallet              CleanupKind = "payment_wallet"
	KindStoreWrite                 CleanupKind = "store_write"
)

// Cleanup is one reference that a row stopped holding
// (secret-cleanup.ts:25-262).
type Cleanup struct {
	Kind     CleanupKind
	RecordID string
	Ref      string
}

var secretTable = map[Model]string{
	Secret:                    "secrets",
	BotSecret:                 "bot_secrets",
	VaultCredential:           "vault_credentials",
	IntegrationProviderConfig: "integration_provider_configs",
}

var parentTable = map[Model]string{
	User:         "user",
	Space:        "spaces",
	Bot:          "bots",
	Organization: "organization",
}

var cascadedTable = map[Model]string{
	MessagingInstallation: "messaging_installations",
	PaymentWallet:         "payment_wallets",
	Purchase:              "purchases",
}

const (
	integrationRecordPrefix = "integration-provider:"
	paymentWalletPrefix     = "payment-wallet:"
	purchaseRequestPrefix   = "purchase-request:"
	purchaseCardPrefix      = "purchase-card:"
	purchaseTokenPrefix     = "purchase-token:"
)

// State is the hook's per-mutation bookkeeping (secret-persistence.ts:22-32):
// the refs the mutation drops and the refs it writes. Cleanup runs after the
// transaction: this is `persistPreparedSecret`'s deferred cleanup made
// explicit.
type State struct {
	Old     []Cleanup
	written []Cleanup
}

// Persistence is withSecretPersistence for the local store
// (secret-persistence.ts:156-416). Procedures call CaptureDropped before a
// mutation that may remove a reference, TrackWrite for a value they just
// wrote, and Finish once their transaction ends.
type Persistence struct {
	DB     *db.DB
	Writer *Writer
	Logger *slog.Logger
}

// NewPersistence returns the hook over writer. The database is used for the
// cross-tenant reads a parent cascade and a held-reference check need.
func NewPersistence(database *db.DB, writer *Writer) *Persistence {
	return &Persistence{DB: database, Writer: writer}
}

// NewState starts the bookkeeping for one mutation.
func (p *Persistence) NewState() *State { return &State{} }

// TrackWrite records a value the transaction wrote, so a rolled-back
// transaction announces it unsaved and a committed one confirms its row holds
// it (secret-persistence.ts:210-247,487). The write is tracked before any
// database access so a pre-read failure still cleans it.
func (p *Persistence) TrackWrite(state *State, model Model, rowID, ciphertext string) {
	if _, ok := secretTable[model]; !ok || ciphertext == "" {
		return
	}
	recordID := rowID
	if model == IntegrationProviderConfig {
		recordID = integrationRecordPrefix + rowID
	}
	state.written = append(state.written, Cleanup{
		Kind:     KindSecretTables,
		RecordID: recordID,
		Ref:      ciphertext,
	})
}

// CaptureDropped locks the rows a mutation is about to change and records
// their references (secret-persistence.ts:249-300). selectIDsSQL runs on the
// caller's connection, so row-level security decides which rows the caller may
// see; the lock then reads the references the rows actually hold, even if a
// concurrent writer replaced them between the selection and the lock
// (secret-persistence.ts:183-201).
//
// Call it for a delete/deleteMany of a secret table or a parent, or for an
// update that writes a `ciphertext` column.
func (p *Persistence) CaptureDropped(
	ctx context.Context,
	tx pgx.Tx,
	state *State,
	model Model,
	selectIDsSQL string,
	args ...any,
) error {
	ids, err := selectIDs(ctx, tx, selectIDsSQL, args...)
	if err != nil || len(ids) == 0 {
		return err
	}
	if table, ok := secretTable[model]; ok {
		cleanups, err := lockSecretRows(ctx, tx, table, ids)
		if err != nil {
			return err
		}
		for index := range cleanups {
			if model == IntegrationProviderConfig {
				cleanups[index].RecordID = integrationRecordPrefix + cleanups[index].RecordID
			}
		}
		state.Old = append(state.Old, cleanups...)
		return nil
	}
	table, ok := parentTable[model]
	if !ok {
		return fmt.Errorf("secretstore: %s has no secret hook", model)
	}
	if err := lockParentRows(ctx, tx, table, ids); err != nil {
		return err
	}
	// The cascade removes other tenants' rows too, so their references are
	// read across tenants; only the references leave this scope
	// (secret-persistence.ts:276-283).
	var cleanups []Cleanup
	err = p.DB.InSystem(ctx, tx, func() error {
		var err error
		cleanups, err = p.cascadedCleanups(ctx, tx, model, ids)
		return err
	})
	if err != nil {
		return err
	}
	state.Old = append(state.Old, cleanups...)
	return nil
}

// Finish runs the post-transaction cleanup (secret-persistence.ts:404-414).
// After a commit, the dropped and written refs are checked; after a rollback
// only the written refs are, because the transaction took the drops with it
// (secret-persistence.ts:412-414). Nothing here fails the caller: a cleanup
// error is logged, and the value is either still held by a row or already
// unreachable.
func (p *Persistence) Finish(ctx context.Context, state *State, txErr error) {
	if state == nil || (len(state.Old) == 0 && len(state.written) == 0) {
		return
	}
	// Cleanup does not follow the caller's cancellation, as the TypeScript
	// post-commit path takes no signal: a client disconnect must not leave a
	// dropped value unannounced or its held check unrun. The deadline bounds a
	// hung key-manager or database call.
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 30*time.Second)
	defer cancel()
	candidates := state.written
	if txErr == nil {
		candidates = append(append([]Cleanup{}, state.Old...), state.written...)
	}
	p.deleteUnreferenced(ctx, candidates)
}

// deleteUnreferenced is deleteUnreferenced (secret-persistence.ts:86-121) for
// a store with no queue: every candidate is checked and, when no row holds it,
// deleted now. The local store's delete only announces the ref, so this is the
// same `changed(ref)` the TypeScript hook's attempt produces.
func (p *Persistence) deleteUnreferenced(ctx context.Context, candidates []Cleanup) {
	for _, cleanup := range dedupeCleanups(candidates) {
		held, err := SecretIsHeld(ctx, p.DB, cleanup)
		if err != nil {
			p.logf("delete an unreferenced secret; nothing retries it: %v", err)
			continue
		}
		if held {
			continue
		}
		p.Writer.Delete(ctx, cleanup.Ref, cleanup.RecordID)
	}
}

func (p *Persistence) logf(format string, args ...any) {
	if p.Logger != nil {
		p.Logger.Warn(fmt.Sprintf(format, args...))
	}
}

// dedupeCleanups keeps one entry per ref, the last value winning and the first
// position holding, as `new Map(candidates.map(row => [row.ref, row]))`
// iterates (secret-persistence.ts:95).
func dedupeCleanups(candidates []Cleanup) []Cleanup {
	order := make([]string, 0, len(candidates))
	byRef := make(map[string]Cleanup, len(candidates))
	for _, cleanup := range candidates {
		if _, seen := byRef[cleanup.Ref]; !seen {
			order = append(order, cleanup.Ref)
		}
		byRef[cleanup.Ref] = cleanup
	}
	out := make([]Cleanup, 0, len(order))
	for _, ref := range order {
		out = append(out, byRef[ref])
	}
	return out
}

func selectIDs(ctx context.Context, tx pgx.Tx, query string, args ...any) ([]string, error) {
	//writeaudit:dynamic callers pass SELECT statements; every argument is a filter
	rows, err := tx.Query(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

// lockSecretRows is lockedRows for a secret table (secret-persistence.ts:183-201).
func lockSecretRows(ctx context.Context, tx pgx.Tx, table string, ids []string) ([]Cleanup, error) {
	const columns = `id, ciphertext`
	rows, err := tx.Query(ctx,
		`SELECT `+columns+` FROM "`+table+`" WHERE id = ANY($1) ORDER BY id FOR UPDATE`, ids)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var cleanups []Cleanup
	for rows.Next() {
		var id, ciphertext string
		if err := rows.Scan(&id, &ciphertext); err != nil {
			return nil, err
		}
		cleanups = append(cleanups, Cleanup{Kind: KindSecretTables, RecordID: id, Ref: ciphertext})
	}
	return cleanups, rows.Err()
}

func lockParentRows(ctx context.Context, tx pgx.Tx, table string, ids []string) error {
	rows, err := tx.Query(ctx,
		`SELECT id FROM "`+table+`" WHERE id = ANY($1) ORDER BY id FOR UPDATE`, ids)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return err
		}
	}
	return rows.Err()
}

// cascadedCleanups reads every reference the rows a deleted parent cascades to
// hold (secret-persistence.ts:284-342). The queries run under the system
// bypass; their table and column names are this file's fixed allowlist.
func (p *Persistence) cascadedCleanups(
	ctx context.Context,
	tx pgx.Tx,
	model Model,
	parentIDs []string,
) ([]Cleanup, error) {
	filterColumn, filterIDs := "", parentIDs
	switch model {
	case User:
		filterColumn = `"userId"`
	case Space:
		filterColumn = `"spaceId"`
	case Bot:
		filterColumn = `"botId"`
	case Organization:
		spaces, err := lockSpacesOfOrganization(ctx, tx, parentIDs)
		if err != nil {
			return nil, err
		}
		filterColumn, filterIDs = `"spaceId"`, spaces
	}
	cleanups := []Cleanup{}
	appendRows := func(table, columns, filter string, ids []string, kind CleanupKind, record func(row pgx.Row) (Cleanup, error)) error {
		if len(ids) == 0 {
			return nil
		}
		rows, err := tx.Query(ctx,
			`SELECT `+columns+` FROM "`+table+`" WHERE `+filter+` = ANY($1) ORDER BY id FOR UPDATE`, ids)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			candidate, err := record(rows)
			if err != nil {
				return err
			}
			// An empty ciphertext is kept, as TypeScript announces it too.
			candidate.Kind = kind
			cleanups = append(cleanups, candidate)
		}
		return rows.Err()
	}
	plainSecret := func(row pgx.Row) (Cleanup, error) {
		var id, ciphertext string
		if err := row.Scan(&id, &ciphertext); err != nil {
			return Cleanup{}, err
		}
		return Cleanup{RecordID: id, Ref: ciphertext}, nil
	}
	// A deleted Bot cascades to neither `secrets` nor `vault_credentials`: it
	// owns only bot secrets (secret-persistence.ts:316-320).
	if model != Bot {
		if err := appendRows("secrets", "id, ciphertext", filterColumn, filterIDs,
			KindSecretTables, plainSecret); err != nil {
			return nil, err
		}
		if err := appendRows("vault_credentials", "id, ciphertext", filterColumn, filterIDs,
			KindSecretTables, plainSecret); err != nil {
			return nil, err
		}
	}
	if err := appendRows("bot_secrets", "id, ciphertext", filterColumn, filterIDs,
		KindSecretTables, plainSecret); err != nil {
		return nil, err
	}
	if err := appendRows("messaging_installations", "id, ciphertext", filterColumn, filterIDs,
		KindMessagingInstallation, plainSecret); err != nil {
		return nil, err
	}
	if model == User {
		if err := appendRows("payment_wallets", `id, "userId", ciphertext`, filterColumn, filterIDs,
			KindPaymentWallet, func(row pgx.Row) (Cleanup, error) {
				var id, userID, ciphertext string
				if err := row.Scan(&id, &userID, &ciphertext); err != nil {
					return Cleanup{}, err
				}
				return Cleanup{RecordID: paymentWalletPrefix + userID, Ref: ciphertext}, nil
			}); err != nil {
			return nil, err
		}
	}
	// Purchases go with their Space only (secret-persistence.ts:335-341), and
	// one row can hold three references.
	if model == Space || model == Organization {
		if len(filterIDs) > 0 {
			rows, err := tx.Query(ctx,
				`SELECT id, "operationKey", "cardCiphertext", "requestCiphertext", "tokenCiphertext"
				 FROM purchases WHERE `+filterColumn+` = ANY($1) ORDER BY id FOR UPDATE`, filterIDs)
			if err != nil {
				return nil, err
			}
			for rows.Next() {
				var id, operationKey string
				var card, request, token *string
				if err := rows.Scan(&id, &operationKey, &card, &request, &token); err != nil {
					rows.Close()
					return nil, err
				}
				if card != nil {
					cleanups = append(cleanups, Cleanup{Kind: KindPurchaseCard,
						RecordID: purchaseCardPrefix + id, Ref: *card})
				}
				if request != nil {
					cleanups = append(cleanups, Cleanup{Kind: KindPurchaseRequest,
						RecordID: purchaseRequestPrefix + operationKey, Ref: *request})
				}
				if token != nil {
					cleanups = append(cleanups, Cleanup{Kind: KindPurchaseToken,
						RecordID: purchaseTokenPrefix + id, Ref: *token})
				}
			}
			if err := rows.Err(); err != nil {
				rows.Close()
				return nil, err
			}
			rows.Close()
		}
	}
	return cleanups, nil
}

func lockSpacesOfOrganization(ctx context.Context, tx pgx.Tx, organizationIDs []string) ([]string, error) {
	rows, err := tx.Query(ctx,
		`SELECT id FROM spaces WHERE "organizationId" = ANY($1) ORDER BY id FOR UPDATE`, organizationIDs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var spaces []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		spaces = append(spaces, id)
	}
	return spaces, rows.Err()
}

// holderColumns is secret-holder-columns.json `checked`
// (secret-holder-columns.json:2-14): every column a reference can be saved in.
var holderColumns = []string{
	"bot_secrets.ciphertext",
	"deployment_settings.computerProviderCipher",
	"integration_provider_configs.ciphertext",
	"messaging_installations.ciphertext",
	"payment_wallets.ciphertext",
	"purchases.cardCiphertext",
	"purchases.requestCiphertext",
	"purchases.tokenCiphertext",
	"secrets.ciphertext",
	"vault_credentials.ciphertext",
}

var holderColumnPattern = regexp.MustCompile(`^\w+\.\w+$`)

// anyRecordHolds is anyRecordHolds (secret-cleanup.ts:107-119): one query
// checking every column a reference can live in.
func anyRecordHolds(ctx context.Context, tx pgx.Tx, ref string) (bool, error) {
	lookups := make([]string, 0, len(holderColumns))
	for _, name := range holderColumns {
		if !holderColumnPattern.MatchString(name) {
			return false, fmt.Errorf("secretstore: invalid holder column %q", name)
		}
		table, column, _ := strings.Cut(name, ".")
		lookups = append(lookups,
			`EXISTS (SELECT 1 FROM "`+table+`" WHERE "`+column+`" = $1)`)
	}
	var held bool
	err := tx.QueryRow(ctx, `SELECT `+strings.Join(lookups, " OR "), ref).Scan(&held)
	return held, err
}

// SecretIsHeld is secretIsHeld (secret-cleanup.ts:166-181): whether any row of
// any tenant still holds the reference now. It reads under the system bypass.
func SecretIsHeld(ctx context.Context, database *db.DB, cleanup Cleanup) (bool, error) {
	var held *string
	err := database.System(ctx, "check that nothing refers to a secret before deleting it",
		func(tx pgx.Tx) error {
			scan := func(query string, args ...any) error {
				held = nil
				//writeaudit:dynamic the scan closure runs SELECT statements; every argument is a filter
				return tx.QueryRow(ctx, query, args...).Scan(&held)
			}
			var err error
			switch cleanup.Kind {
			case KindSecretRow:
				err = scan(`SELECT ciphertext FROM secrets WHERE id = $1`, cleanup.RecordID)
			case KindSecretTables:
				var exists bool
				err = tx.QueryRow(ctx, `SELECT
					EXISTS (SELECT 1 FROM secrets WHERE ciphertext = $1) OR
					EXISTS (SELECT 1 FROM bot_secrets WHERE ciphertext = $1) OR
					EXISTS (SELECT 1 FROM vault_credentials WHERE ciphertext = $1) OR
					EXISTS (SELECT 1 FROM integration_provider_configs WHERE ciphertext = $1)`,
					cleanup.Ref).Scan(&exists)
				if err == nil && exists {
					held = &cleanup.Ref
				}
			case KindStoreWrite:
				var exists bool
				exists, err = anyRecordHolds(ctx, tx, cleanup.Ref)
				if err == nil && exists {
					held = &cleanup.Ref
				}
			case KindMessagingInstallation:
				err = scan(`SELECT ciphertext FROM messaging_installations WHERE id = $1`, cleanup.RecordID)
			case KindDeploymentComputerProvider:
				err = scan(`SELECT "computerProviderCipher" FROM deployment_settings WHERE id = 'default'`)
			case KindPurchaseRequest:
				err = scan(`SELECT "requestCiphertext" FROM purchases WHERE "operationKey" = $1`,
					afterPrefix(cleanup.RecordID, purchaseRequestPrefix))
			case KindPurchaseCard:
				err = scan(`SELECT "cardCiphertext" FROM purchases WHERE id = $1`,
					afterPrefix(cleanup.RecordID, purchaseCardPrefix))
			case KindPurchaseToken:
				err = scan(`SELECT "tokenCiphertext" FROM purchases WHERE id = $1`,
					afterPrefix(cleanup.RecordID, purchaseTokenPrefix))
			case KindPaymentWallet:
				err = scan(`SELECT ciphertext FROM payment_wallets WHERE "userId" = $1`,
					afterPrefix(cleanup.RecordID, paymentWalletPrefix))
			default:
				return fmt.Errorf("secretstore: unknown cleanup kind %q", cleanup.Kind)
			}
			if errors.Is(err, pgx.ErrNoRows) {
				return nil
			}
			return err
		})
	if err != nil {
		return false, err
	}
	return held != nil && *held == cleanup.Ref, nil
}

// afterPrefix is `recordId.slice(prefix.length)`: a blind slice, not a prefix
// match. A shorter string yields ""; a record id of the same length with other
// content yields its tail (a crafted cleanup payload only).
func afterPrefix(value, prefix string) string {
	if len(value) < len(prefix) {
		return ""
	}
	return value[len(prefix):]
}
