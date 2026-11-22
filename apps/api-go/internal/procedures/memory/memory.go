// Package memory ports the memory procedures over memory_documents and memory_revisions:
// memory.list, memory.update, memory.remove, memory.exportMarkdown and memory.budget
// (apps/api/src/routes/memory.ts:27-56, packages/memory/src/index.ts:19-140).
//
// The documents are seeded by the API's MarkdownMemoryStore and are the first procedure
// group whose rows carry rkz1 ciphertext: every read opens content with the Space key ring
// exactly where the TypeScript Prisma extension would, and every write seals it with the
// row's own owner (the document's userId; a revision's documentId) and Space.
package memory

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/contentcrypto"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/effects"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/orpc"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/shared"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/validate"
)

// MemoryIndexPath is MEMORY_INDEX_PATH (packages/contracts/src/domain.ts:885): the index
// cannot be deleted, only edited.
const MemoryIndexPath = "MEMORY.md"

// conflictMessage is MEMORY_REVISION_CONFLICT_ERROR (packages/adapter-kit/src/types.ts:409).
const conflictMessage = "Shared memory changed since it was read. Read the latest version and save again."

var scopes = []string{"bot", "user"}

// Document is MemoryDocumentSchema (packages/contracts/src/domain.ts:854).
type Document struct {
	ID        string  `json:"id"`
	Scope     string  `json:"scope"`
	BotID     *string `json:"botId"`
	Path      string  `json:"path"`
	Content   string  `json:"content"`
	Revision  int32   `json:"revision"`
	UpdatedAt string  `json:"updatedAt"`
}

// errorNoRing is a process that serves memory without a key ring; startup refuses it, so this
// only reports a programming mistake as a server error rather than panicking.
var errorNoRing = errors.New("content encryption is not configured")

const columns = `id, "spaceId", "userId", "botId", scope, path, content, revision, "createdAt", "updatedAt"`

// stored is one memory_documents row as the API's Prisma client selects it.
type stored struct {
	ID        string
	SpaceID   string
	UserID    string
	BotID     *string
	Scope     string
	Path      string
	Content   string
	Revision  int32
	CreatedAt time.Time
	UpdatedAt time.Time
}

func scan(row pgx.Row) (stored, error) {
	var value stored
	err := row.Scan(&value.ID, &value.SpaceID, &value.UserID, &value.BotID, &value.Scope, &value.Path,
		&value.Content, &value.Revision, &value.CreatedAt, &value.UpdatedAt)
	return value, err
}

func rowIDs(rows []*stored) []string {
	ids := make([]string, len(rows))
	for index, row := range rows {
		ids[index] = row.ID
	}
	return ids
}

// openDocuments decrypts content with the same failure behaviour as the Prisma extension
// (content-encryption.ts:315-350): an unreadable value fails the whole read.
func openDocuments(ctx context.Context, ring *contentcrypto.KeyRing, rows []*stored) error {
	if ring == nil {
		return errorNoRing
	}
	if len(rows) == 0 {
		return nil
	}
	values := make([]map[string]any, len(rows))
	for index, row := range rows {
		values[index] = map[string]any{
			"id": row.ID, "spaceId": row.SpaceID, "userId": row.UserID, "content": row.Content,
		}
	}
	if err := ring.OpenRows(ctx, "MemoryDocument", values); err != nil {
		return fmt.Errorf("open memory documents %v: %w", rowIDs(rows), err)
	}
	for index, row := range rows {
		content, ok := values[index]["content"].(string)
		if !ok {
			return fmt.Errorf("opened memory_documents content is not text")
		}
		row.Content = content
	}
	return nil
}

// written is the content as the API's Prisma client stores it. The content-encryption hook runs
// before withTextSanitization, so a sealed value is stored exactly as sent — NUL included, inside
// the ciphertext — and only a plaintext write is sanitized. With encryption off, text that merely
// looks like ciphertext gains a leading zero-width space so it is never read as a value under a
// missing key (content-encryption.ts:458-485).
func written(ring *contentcrypto.KeyRing, content string) string {
	if ring == nil || ring.EncryptWrites {
		return content
	}
	content = strings.ReplaceAll(content, "\x00", "\uFFFD")
	if contentcrypto.IsCiphertext(content) {
		return "\u200b" + content
	}
	return content
}

// sealContent is one encrypted column of a row being written, sealed exactly as the hook
// would: the Space's current key, bound to table, column, row id, owner and Space.
func sealContent(ctx context.Context, ring *contentcrypto.KeyRing, model string, row map[string]any) (string, error) {
	if ring == nil {
		return "", errorNoRing
	}
	sealed, err := ring.SealRow(ctx, model, row)
	if err != nil {
		return "", err
	}
	content, ok := sealed["content"].(string)
	if !ok {
		return "", fmt.Errorf("sealed %s content is not text", model)
	}
	return content, nil
}

// sealDocument seals a memory_documents content for the row's own owner and Space.
func sealDocument(ctx context.Context, ring *contentcrypto.KeyRing, id, spaceID, userID, content string) (string, error) {
	return sealContent(ctx, ring, "MemoryDocument", map[string]any{
		"id": id, "spaceId": spaceID, "userId": userID, "content": written(ring, content),
	})
}

// sealRevision seals a memory_revisions content; its Space comes from the parent document.
func sealRevision(ctx context.Context, ring *contentcrypto.KeyRing, id, documentID string, content string) (string, error) {
	return sealContent(ctx, ring, "MemoryRevision", map[string]any{
		"id": id, "documentId": documentID, "content": written(ring, content),
	})
}

// checkDocument is the router's output parse of MemoryDocumentSchema: a stored scope outside
// the enum becomes 500 "Output validation failed" (hook-audit.md §5).
func checkDocument(value Document) bool {
	switch value.Scope {
	case "bot", "user":
	default:
		return false
	}
	if value.ID == "" {
		return false
	}
	if value.BotID != nil && *value.BotID == "" {
		return false
	}
	return true
}

func optionalID(object *validate.Object, key string) (*string, []validate.Issue) {
	raw := object.Field(key)
	if raw == validate.Undefined {
		return nil, nil
	}
	text, issues := validate.String(validate.Path{key}, raw, validate.StringRules{Min: 1})
	if issues != nil {
		return nil, issues
	}
	return &text, nil
}

// List implements memory.list: every document of the Space, optionally for one bot and one
// scope. The API sets no order, so rows come back in the database's own order.
func List(ctx context.Context, database *db.DB, actor db.Actor, ring *contentcrypto.KeyRing, raw orpc.Input) (any, *orpc.Error) {
	object, issues := validate.Decode(raw.Raw, nil)
	if issues != nil {
		return nil, validate.Fail(issues)
	}
	var found []validate.Issue
	botID, problems := optionalID(object, "botId")
	found = append(found, problems...)
	var scope *string
	if value := object.Field("scope"); value != validate.Undefined {
		text, problems := validate.Enum(validate.Path{"scope"}, value, scopes...)
		found = append(found, problems...)
		if problems == nil {
			scope = &text
		}
	}
	if found != nil {
		return nil, validate.Fail(found)
	}
	documents := []Document{}
	err := database.Tenant(ctx, actor, func(tx pgx.Tx) error {
		query := `SELECT ` + columns + ` FROM memory_documents WHERE "spaceId" = $1`
		args := []any{actor.SpaceID}
		if botID != nil {
			args = append(args, *botID)
			query += fmt.Sprintf(` AND "botId" = $%d`, len(args))
		}
		if scope != nil {
			args = append(args, *scope)
			query += fmt.Sprintf(` AND scope = $%d`, len(args))
		}
		rows, err := tx.Query(ctx, query, args...)
		if err != nil {
			return err
		}
		defer rows.Close()
		var collected []*stored
		for rows.Next() {
			value, err := scan(rows)
			if err != nil {
				return err
			}
			collected = append(collected, &value)
		}
		if err := rows.Err(); err != nil {
			return err
		}
		if err := openDocuments(ctx, ring, collected); err != nil {
			return err
		}
		for _, value := range collected {
			documents = append(documents, Document{
				ID: value.ID, Scope: value.Scope, BotID: value.BotID, Path: value.Path,
				Content: value.Content, Revision: value.Revision, UpdatedAt: shared.ISO(value.UpdatedAt),
			})
		}
		return nil
	})
	if err != nil {
		return nil, shared.Failure(err)
	}
	for _, document := range documents {
		if !checkDocument(document) {
			return nil, shared.OutputInvalid()
		}
	}
	return documents, nil
}

// ExportMarkdown implements memory.exportMarkdown: every document (optionally one bot's) as
// `# path` followed by its content, separated by a blank line. No order is applied.
func ExportMarkdown(ctx context.Context, database *db.DB, actor db.Actor, ring *contentcrypto.KeyRing, raw orpc.Input) (any, *orpc.Error) {
	object, issues := validate.Decode(raw.Raw, nil)
	if issues != nil {
		return nil, validate.Fail(issues)
	}
	botID, problems := optionalID(object, "botId")
	if problems != nil {
		return nil, validate.Fail(problems)
	}
	parts := []string{}
	err := database.Tenant(ctx, actor, func(tx pgx.Tx) error {
		query := `SELECT ` + columns + ` FROM memory_documents WHERE "spaceId" = $1`
		args := []any{actor.SpaceID}
		if botID != nil {
			args = append(args, *botID)
			query += fmt.Sprintf(` AND "botId" = $%d`, len(args))
		}
		rows, err := tx.Query(ctx, query, args...)
		if err != nil {
			return err
		}
		defer rows.Close()
		var collected []*stored
		for rows.Next() {
			value, err := scan(rows)
			if err != nil {
				return err
			}
			collected = append(collected, &value)
		}
		if err := rows.Err(); err != nil {
			return err
		}
		if err := openDocuments(ctx, ring, collected); err != nil {
			return err
		}
		for _, value := range collected {
			parts = append(parts, "# "+value.Path+"\n\n"+value.Content)
		}
		return nil
	})
	if err != nil {
		return nil, shared.Failure(err)
	}
	return strings.Join(parts, "\n\n"), nil
}

type updateInput struct {
	DocumentID       string
	Content          string
	ExpectedRevision *int64
}

func parseUpdate(raw orpc.Input) (updateInput, *orpc.Error) {
	var input updateInput
	object, issues := validate.Decode(raw.Raw, nil)
	if issues != nil {
		return input, validate.Fail(issues)
	}
	var found []validate.Issue
	documentID, problems := validate.String(validate.Path{"documentId"}, object.Field("documentId"), validate.StringRules{Min: 1})
	found = append(found, problems...)
	content, problems := validate.String(validate.Path{"content"}, object.Field("content"), validate.StringRules{})
	found = append(found, problems...)
	var expected *int64
	if value := object.Field("expectedRevision"); value != validate.Undefined {
		revision, problems := validate.Integer(validate.Path{"expectedRevision"}, value, validate.NumberRules{Gt: validate.Float(0)})
		found = append(found, problems...)
		if problems == nil {
			expected = &revision
		}
	}
	if found != nil {
		return updateInput{}, validate.Fail(found)
	}
	return updateInput{DocumentID: documentID, Content: content, ExpectedRevision: expected}, nil
}

// findNaturalKey is the commit's lookup by (spaceId, scope, botId, path): Prisma reads
// `botId: null` as IS NULL.
func findNaturalKey(ctx context.Context, tx pgx.Tx, spaceID, scope string, botID *string, path string) (*stored, error) {
	row := tx.QueryRow(ctx, `SELECT `+columns+` FROM memory_documents
		WHERE "spaceId" = $1 AND scope = $2 AND "botId" IS NOT DISTINCT FROM $3 AND path = $4`,
		spaceID, scope, botID, path)
	value, err := scan(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &value, nil
}

// Update implements memory.update: MarkdownMemoryStore.commit (packages/memory/src/index.ts:73-116).
// The document is read first (its own read, as the handler's findFirst is), then a serializable
// transaction replaces the content, bumps the revision, appends the history row, and gives up
// with a CONFLICT when expectedRevision is not what the row holds.
func Update(ctx context.Context, database *db.DB, actor db.Actor, ring *contentcrypto.KeyRing, raw orpc.Input) (any, *orpc.Error) {
	input, failure := parseUpdate(raw)
	if failure != nil {
		return nil, failure
	}
	var doc stored
	err := database.Tenant(ctx, actor, func(tx pgx.Tx) error {
		value, err := scan(tx.QueryRow(ctx, `SELECT `+columns+` FROM memory_documents WHERE id = $1 AND "spaceId" = $2`,
			input.DocumentID, actor.SpaceID))
		if errors.Is(err, pgx.ErrNoRows) {
			return shared.NotFound
		}
		if err != nil {
			return err
		}
		doc = value
		return openDocuments(ctx, ring, []*stored{&doc})
	})
	if err != nil {
		return nil, shared.Failure(err)
	}
	var result Document
	result, err = commitDocument(ctx, database, actor, ring, doc.Scope, doc.BotID, doc.Path,
		input.Content, input.ExpectedRevision)
	if err != nil {
		return nil, shared.Failure(err)
	}
	if !checkDocument(result) {
		return nil, shared.OutputInvalid()
	}
	return result, nil
}

// CommitInput is MarkdownMemoryStore.commit's request
// (packages/memory/src/index.ts:73-116): a scope and natural key, the complete
// new content, and the revision the caller read.
type CommitInput struct {
	Scope            string
	BotID            *string
	Path             string
	Content          string
	ExpectedRevision *int64
}

// Commit is MarkdownMemoryStore.commit without a run or thread source: it creates
// a missing document or replaces one, appends the revision row, and refuses a
// stale expectedRevision with CONFLICT. The roamer uses it to seed and consolidate
// memory outside a chat run.
func Commit(ctx context.Context, database *db.DB, actor db.Actor, ring *contentcrypto.KeyRing, input CommitInput) (Document, error) {
	if input.Scope != "bot" && input.Scope != "user" {
		return Document{}, fmt.Errorf("memory scope must be bot or user")
	}
	if (input.Scope == "bot") != (input.BotID != nil) {
		return Document{}, fmt.Errorf("bot memory needs a bot id and shared memory must omit it")
	}
	if input.Path == "" {
		return Document{}, fmt.Errorf("memory path is required")
	}
	return commitDocument(ctx, database, actor, ring, input.Scope, input.BotID, input.Path,
		input.Content, input.ExpectedRevision)
}

// commitDocument is the serializable write Update and Commit share. The caller
// has already resolved the natural key; expectedRevision nil writes without one.
func commitDocument(ctx context.Context, database *db.DB, actor db.Actor, ring *contentcrypto.KeyRing,
	scope string, botID *string, path, content string, expectedRevision *int64) (Document, error) {
	var result Document
	err := shared.Serializable(ctx, database, actor, func(tx pgx.Tx) error {
		existing, err := findNaturalKey(ctx, tx, actor.SpaceID, scope, botID, path)
		if err != nil {
			return err
		}
		if expectedRevision != nil {
			var live int64
			if existing != nil {
				live = int64(existing.Revision)
			}
			if live != *expectedRevision {
				return orpc.Conflict(conflictMessage)
			}
		}
		at := time.Now().UTC().Truncate(time.Millisecond)
		id := ""
		var revision int32
		if existing != nil {
			sealed, err := sealDocument(ctx, ring, existing.ID, existing.SpaceID, existing.UserID, content)
			if err != nil {
				return err
			}
			if err := tx.QueryRow(ctx, `UPDATE memory_documents SET content = $1, revision = revision + 1, "updatedAt" = $2
				WHERE id = $3 RETURNING revision`, sealed, at, existing.ID).Scan(&revision); err != nil {
				return err
			}
			id = existing.ID
		} else {
			id = effects.NewID()
			sealed, err := sealDocument(ctx, ring, id, actor.SpaceID, actor.UserID, content)
			if err != nil {
				return err
			}
			if err := tx.QueryRow(ctx, `INSERT INTO memory_documents
				(id, "spaceId", "userId", "botId", scope, path, content, revision, "createdAt", "updatedAt")
				VALUES ($1, $2, $3, $4, $5, $6, $7, 1, $8, $8) RETURNING revision`,
				id, actor.SpaceID, actor.UserID, botID, scope, path, sealed, at).Scan(&revision); err != nil {
				return err
			}
		}
		revisionID := effects.NewID()
		sealedRevision, err := sealRevision(ctx, ring, revisionID, id, content)
		if err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `INSERT INTO memory_revisions
			(id, "documentId", revision, content, "sourceRunId", "sourceThreadId", "createdAt")
			VALUES ($1, $2, $3, $4, NULL, NULL, $5)`, revisionID, id, revision, sealedRevision, at); err != nil {
			return err
		}
		result = Document{
			ID: id, Scope: scope, BotID: botID, Path: path,
			Content: written(ring, content), Revision: revision, UpdatedAt: shared.ISO(at),
		}
		return nil
	})
	return result, err
}

// Remove implements memory.remove: the index may not be deleted, any other document of the
// Space may. Revisions cascade with the row.
func Remove(ctx context.Context, database *db.DB, actor db.Actor, ring *contentcrypto.KeyRing, raw orpc.Input) (any, *orpc.Error) {
	object, issues := validate.Decode(raw.Raw, nil)
	if issues != nil {
		return nil, validate.Fail(issues)
	}
	documentID, problems := validate.String(validate.Path{"documentId"}, object.Field("documentId"), validate.StringRules{Min: 1})
	if problems != nil {
		return nil, validate.Fail(problems)
	}
	err := database.Tenant(ctx, actor, func(tx pgx.Tx) error {
		value, err := scan(tx.QueryRow(ctx, `SELECT `+columns+` FROM memory_documents WHERE id = $1 AND "spaceId" = $2`,
			documentID, actor.SpaceID))
		if errors.Is(err, pgx.ErrNoRows) {
			return shared.NotFound
		}
		if err != nil {
			return err
		}
		doc := value
		// The handler reads the whole row first, so an unreadable content fails here.
		if err := openDocuments(ctx, ring, []*stored{&doc}); err != nil {
			return err
		}
		if doc.Path == MemoryIndexPath {
			return orpc.BadRequest(doc.Path + " cannot be deleted; edit its content instead.")
		}
		_, err = tx.Exec(ctx, `DELETE FROM memory_documents
			WHERE id = $1 AND "spaceId" = $2 AND scope = $3 AND "botId" IS NOT DISTINCT FROM $4 AND path = $5`,
			doc.ID, actor.SpaceID, doc.Scope, doc.BotID, doc.Path)
		return err
	})
	if err != nil {
		return nil, shared.Failure(err)
	}
	return map[string]any{"ok": true}, nil
}
