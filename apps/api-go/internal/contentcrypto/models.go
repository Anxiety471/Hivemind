package contentcrypto

import (
	"context"
	"errors"
	"fmt"
	"strings"
)

// FieldSpec is FieldSpec (content-encryption.ts:35-44).
type FieldSpec struct {
	// PlainKeys marks a JSON column and the scalar keys kept queryable beside
	// the sealed copy.
	PlainKeys map[string]bool
	// Hidden is a column only code that selects it reads; search never indexes
	// it (Message.toolHistory).
	Hidden bool
}

// Field is one encrypted column in declaration order.
type Field struct {
	Name string
	Spec FieldSpec
}

// ModelSpec is ModelSpec (content-encryption.ts:46-59): where a model's rows
// live, which fields are encrypted, and how the owning Space is found.
type ModelSpec struct {
	// Table is the PostgreSQL table and the AAD's table field.
	Table string
	// Fields are the encrypted columns.
	Fields []Field
	// SpaceColumn is the row's own Space column, or empty when the Space comes
	// from the parent row.
	SpaceColumn string
	// Parent is the table the row's Space is resolved through when SpaceColumn
	// is empty.
	Parent SpaceSource
	// OwnerColumn is the parent the row is bound to (ROW_OWNER).
	OwnerColumn string
	// SearchTokens marks models whose blind-index tokens are written with them.
	SearchTokens bool
	// Source is the table name used for cached row contexts.
	Source SpaceSource
}

// messageBlockPlainKeys is MESSAGE_BLOCK_PLAIN_KEYS (content-encryption.ts:23).
var messageBlockPlainKeys = map[string]bool{
	"kind": true, "status": true, "channelId": true, "serverId": true, "artifactId": true,
}

// eventPayloadPlainKeys is EVENT_PAYLOAD_PLAIN_KEYS (content-encryption.ts:24-30).
var eventPayloadPlainKeys = map[string]bool{
	"messageId": true, "notice": true, "state": true, "updatedAt": true, "streaming": true,
}

// Models is ENCRYPTED_MODELS (content-encryption.ts:62-94). A new encrypted
// column is added here and in the TS map together.
var Models = map[string]ModelSpec{
	"Message": {
		Table: "messages",
		Fields: []Field{
			{Name: "blocks", Spec: FieldSpec{PlainKeys: messageBlockPlainKeys}},
			{Name: "toolHistory", Spec: FieldSpec{Hidden: true}},
		},
		Parent:       SourceThreads,
		OwnerColumn:  "threadId",
		SearchTokens: true,
		Source:       SourceMessages,
	},
	"Event": {
		Table:       "events",
		Fields:      []Field{{Name: "payload", Spec: FieldSpec{PlainKeys: eventPayloadPlainKeys}}},
		SpaceColumn: "spaceId",
		OwnerColumn: "threadId",
		Source:      SourceEvents,
	},
	"MemoryDocument": {
		Table:       "memory_documents",
		Fields:      []Field{{Name: "content"}},
		SpaceColumn: "spaceId",
		OwnerColumn: "userId",
		Source:      SourceMemoryDocs,
	},
	"MemoryRevision": {
		Table:       "memory_revisions",
		Fields:      []Field{{Name: "content"}},
		Parent:      SourceMemoryDocs,
		OwnerColumn: "documentId",
		Source:      SourceMemoryRevision,
	},
	"Thread": {
		Table:       "threads",
		Fields:      []Field{{Name: "historyCompactionSummary"}},
		SpaceColumn: "spaceId",
		OwnerColumn: "userId",
		Source:      SourceThreads,
	},
	"BotEmailMessage": {
		Table: "bot_email_messages",
		Fields: []Field{
			{Name: "fromAddress"}, {Name: "fromName"}, {Name: "subject"}, {Name: "text"},
		},
		SpaceColumn:  "spaceId",
		OwnerColumn:  "botId",
		SearchTokens: true,
		Source:       SourceBotEmail,
	},
}

// SealRow seals the encrypted fields of one row, as the Prisma extension's
// create/update hook does (content-encryption.ts:352-400, 449-460). The row
// must carry its id and the columns naming its owner and Space; the returned
// map no longer holds plaintext in those fields, and gains searchTokens when
// the model carries them.
func (r *KeyRing) SealRow(ctx context.Context, model string, row map[string]any) (map[string]any, error) {
	spec, ok := Models[model]
	if !ok {
		return nil, fmt.Errorf("unknown encrypted model %q", model)
	}
	if !r.EncryptWrites {
		return row, nil
	}
	rowID, ok := row["id"].(string)
	if !ok || rowID == "" {
		return nil, errors.New("Encrypted rows need their id and owner")
	}
	owner, ok := row[spec.OwnerColumn].(string)
	if !ok || owner == "" {
		return nil, fmt.Errorf("Encrypted %s writes must name their %s", spec.Table, spec.OwnerColumn)
	}
	var spaceID string
	if spec.SpaceColumn != "" {
		value, ok := row[spec.SpaceColumn].(string)
		if !ok || value == "" {
			return nil, fmt.Errorf("Encrypted %s writes must name their %s", spec.Table, spec.SpaceColumn)
		}
		spaceID = value
	} else {
		resolved, err := r.SpaceOf(ctx, spec.Parent, owner)
		if err != nil {
			return nil, err
		}
		spaceID = resolved
	}
	writable := func(field string) bool {
		value, present := row[field]
		return present && value != nil
	}
	anyField := false
	for _, field := range spec.Fields {
		if writable(field.Name) {
			anyField = true
			break
		}
	}
	if !anyField {
		return row, nil
	}
	key, err := r.Current(ctx, spaceID)
	if err != nil {
		return nil, err
	}
	next := make(map[string]any, len(row)+1)
	for name, value := range row {
		next[name] = value
	}
	var words []string
	var indexedStrings []string
	wroteIndexed := false
	for _, field := range spec.Fields {
		value, present := row[field.Name]
		if !present || value == nil {
			continue
		}
		location := Location{Table: spec.Table, Column: field.Name, RowID: rowID, Owner: owner}
		encrypt := func(plaintext string) (string, error) {
			return EncryptText(key, location, plaintext)
		}
		if field.Spec.PlainKeys != nil {
			value = canonicalJSON(value)
			words = append(words, historySearchText(value))
			indexedStrings = append(indexedStrings, stringsIn(value)...)
			sealed, err := SealJSON(value, field.Spec.PlainKeys, encrypt)
			if err != nil {
				return nil, err
			}
			next[field.Name] = sealed
			wroteIndexed = wroteIndexed || !field.Spec.Hidden
			continue
		}
		text, ok := value.(string)
		if !ok {
			return nil, fmt.Errorf("Unsupported write to encrypted %s.%s", spec.Table, field.Name)
		}
		if !field.Spec.Hidden {
			words = append(words, text)
			indexedStrings = append(indexedStrings, text)
			wroteIndexed = true
		}
		sealed, err := encrypt(text)
		if err != nil {
			return nil, err
		}
		next[field.Name] = sealed
	}
	if spec.SearchTokens && wroteIndexed {
		next["searchTokens"] = SearchTokens(key, strings.Join(words, "\n"), indexedStrings)
	}
	r.Remember(spec.Source, rowID, RowContext{SpaceID: spaceID, Owner: owner})
	return next, nil
}

// OpenRows decrypts the encrypted fields of rows read with raw SQL, as
// openRows/openAll does (content-encryption.ts:176-183, 315-350). Rows must
// include id and the owner column (and spaceId for models whose Space is their
// own). A value sealed under another Space's key, or moved to another row,
// parent or column, fails.
func (r *KeyRing) OpenRows(ctx context.Context, model string, rows []map[string]any) error {
	spec, ok := Models[model]
	if !ok {
		return fmt.Errorf("unknown encrypted model %q", model)
	}
	keys := map[string]DataKey{}
	for _, row := range rows {
		for _, id := range spec.keyIDs(row) {
			key, err := r.ByID(ctx, id)
			if err != nil {
				return err
			}
			keys[id] = key
		}
	}
	for _, row := range rows {
		rowKeyIDs := spec.keyIDs(row)
		if len(rowKeyIDs) == 0 {
			continue
		}
		rowID, ok := row["id"].(string)
		if !ok || rowID == "" {
			return errors.New("Encrypted rows need their id and owner")
		}
		owner, ok := row[spec.OwnerColumn].(string)
		if !ok || owner == "" {
			return errors.New("Encrypted rows need their id and owner")
		}
		var spaceID string
		if spec.SpaceColumn != "" {
			value, ok := row[spec.SpaceColumn].(string)
			if !ok || value == "" {
				return fmt.Errorf("Encrypted %s rows need their space", spec.Table)
			}
			spaceID = value
		} else {
			resolved, err := r.SpaceOf(ctx, spec.Parent, owner)
			if err != nil {
				return err
			}
			spaceID = resolved
		}
		for _, field := range spec.Fields {
			value, present := row[field.Name]
			if !present {
				continue
			}
			location := Location{Table: spec.Table, Column: field.Name, RowID: rowID, Owner: owner}
			decrypt := func(ciphertext string) (string, error) {
				id, ok := CiphertextKeyID(ciphertext)
				if !ok {
					return "", ErrDecryption
				}
				key, ok := keys[id]
				if !ok {
					return "", ErrAnotherKey
				}
				if key.SpaceID != spaceID {
					return "", ErrAnotherSpace
				}
				return DecryptText(key, location, ciphertext)
			}
			if field.Spec.PlainKeys != nil {
				opened, err := OpenJSON(value, decrypt)
				if err != nil {
					return err
				}
				row[field.Name] = opened
				continue
			}
			if ciphertext, ok := value.(string); ok && IsCiphertext(ciphertext) {
				opened, err := decrypt(ciphertext)
				if err != nil {
					return err
				}
				row[field.Name] = opened
			}
		}
		r.Remember(spec.Source, rowID, RowContext{
			SpaceID: keys[rowKeyIDs[0]].SpaceID,
			Owner:   owner,
		})
	}
	return nil
}

// keyIDs is keyIdsOf (content-encryption.ts:283-290).
func (s ModelSpec) keyIDs(row map[string]any) []string {
	var ids []string
	for _, field := range s.Fields {
		value, present := row[field.Name]
		if !present {
			continue
		}
		if field.Spec.PlainKeys != nil {
			ids = append(ids, JSONKeyIDs(value)...)
			continue
		}
		if id, ok := CiphertextKeyID(value); ok {
			ids = append(ids, id)
		}
	}
	return ids
}
