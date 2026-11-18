// Package scratchpad ports scratchpad.list, create, update and remove
// (routes/memory.ts, adapters/scratchpad-tools.ts). Items are a bot's notes,
// shared by every member of its Space; none of their columns is encrypted.
package scratchpad

import (
	"context"
	"errors"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/effects"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/orpc"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/spacesettings"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/validate"
)

const (
	titleMax  = 200
	notesMax  = 4000
	isoMillis = "2006-01-02T15:04:05.000Z"
)

var statuses = []string{"open", "parked", "done"}

var errIsolation = orpc.NotFound("Resource not found")

// Item is the wire shape of ScratchpadItemSchema.
type Item struct {
	ID        string `json:"id"`
	BotID     string `json:"botId"`
	Title     string `json:"title"`
	Status    string `json:"status"`
	Notes     string `json:"notes"`
	CreatedAt string `json:"createdAt"`
	UpdatedAt string `json:"updatedAt"`
}

const columns = `id, "botId", title, status, notes, "createdAt", "updatedAt"`

// scanItem is mapScratchpadItem: a status outside the three reads as open.
func scanItem(row pgx.Row) (Item, error) {
	var item Item
	var createdAt, updatedAt time.Time
	if err := row.Scan(&item.ID, &item.BotID, &item.Title, &item.Status, &item.Notes, &createdAt, &updatedAt); err != nil {
		return Item{}, err
	}
	switch item.Status {
	case "open", "parked", "done":
	default:
		item.Status = "open"
	}
	item.CreatedAt = createdAt.UTC().Format(isoMillis)
	item.UpdatedAt = updatedAt.UTC().Format(isoMillis)
	return item, nil
}

func now() time.Time { return time.Now().UTC().Truncate(time.Millisecond) }

// requireBot is repos.getBot: a bot of the Space that is not archived.
func requireBot(ctx context.Context, tx pgx.Tx, actor db.Actor, botID string) error {
	var found string
	err := tx.QueryRow(ctx, `SELECT id FROM bots WHERE id = $1 AND "spaceId" = $2 AND "archivedAt" IS NULL`, botID, actor.SpaceID).Scan(&found)
	if errors.Is(err, pgx.ErrNoRows) {
		return errIsolation
	}
	return err
}

func id(object *validate.Object, key string) (string, []validate.Issue) {
	return validate.String(validate.Path{key}, object.Field(key), validate.StringRules{Min: 1})
}

// optionalString reads z.string().min(1).max(max).optional() (min 0 for none).
func optionalString(object *validate.Object, key string, min, max int) (*string, []validate.Issue) {
	raw := object.Field(key)
	if raw == validate.Undefined {
		return nil, nil
	}
	text, issues := validate.String(validate.Path{key}, raw, validate.StringRules{Min: min, Max: max})
	if issues != nil {
		return nil, issues
	}
	return &text, nil
}

func optionalStatus(object *validate.Object) (*string, []validate.Issue) {
	raw := object.Field("status")
	if raw == validate.Undefined {
		return nil, nil
	}
	status, issues := validate.Enum(validate.Path{"status"}, raw, statuses...)
	if issues != nil {
		return nil, issues
	}
	return &status, nil
}

type listInput struct {
	BotID       string
	Status      *string
	IncludeDone bool
}

func parseList(raw orpc.Input) (listInput, *orpc.Error) {
	var input listInput
	object, issues := validate.Decode(raw.Raw, nil)
	if issues != nil {
		return input, validate.Fail(issues)
	}
	var found []validate.Issue
	botID, problems := id(object, "botId")
	found = append(found, problems...)
	status, problems := optionalStatus(object)
	found = append(found, problems...)
	var includeDone bool
	if value := object.Field("includeDone"); value != validate.Undefined {
		parsed, problems := validate.Boolean(validate.Path{"includeDone"}, value)
		found = append(found, problems...)
		includeDone = parsed
	}
	if found != nil {
		return listInput{}, validate.Fail(found)
	}
	return listInput{BotID: botID, Status: status, IncludeDone: includeDone}, nil
}

// List implements scratchpad.list: the bot's items, most recently changed first.
// Without a status, done items are left out unless asked for.
func List(ctx context.Context, database *db.DB, actor db.Actor, raw orpc.Input) (any, *orpc.Error) {
	input, failure := parseList(raw)
	if failure != nil {
		return nil, failure
	}
	items := []Item{}
	err := database.Tenant(ctx, actor, func(tx pgx.Tx) error {
		if err := requireBot(ctx, tx, actor, input.BotID); err != nil {
			return err
		}
		query := `SELECT ` + columns + ` FROM scratchpad_items WHERE "spaceId" = $1 AND "botId" = $2`
		args := []any{actor.SpaceID, input.BotID}
		switch {
		case input.Status != nil:
			query += ` AND status = $3`
			args = append(args, *input.Status)
		case !input.IncludeDone:
			query += ` AND status IN ('open', 'parked')`
		}
		rows, err := tx.Query(ctx, query+` ORDER BY "updatedAt" DESC, "createdAt" DESC`, args...)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			item, err := scanItem(rows)
			if err != nil {
				return err
			}
			items = append(items, item)
		}
		return rows.Err()
	})
	if err != nil {
		return nil, spacesettings.Failure(err)
	}
	return items, nil
}

type createInput struct {
	BotID, Title, Status, Notes string
}

// parseCreate mirrors CreateScratchpadItemInput: the title and notes are bounded as
// sent and trimmed afterwards by the handler.
func parseCreate(raw orpc.Input) (createInput, *orpc.Error) {
	var input createInput
	object, issues := validate.Decode(raw.Raw, nil)
	if issues != nil {
		return input, validate.Fail(issues)
	}
	var found []validate.Issue
	botID, problems := id(object, "botId")
	found = append(found, problems...)
	title, problems := validate.String(validate.Path{"title"}, object.Field("title"), validate.StringRules{Min: 1, Max: titleMax})
	found = append(found, problems...)
	status := "open"
	if value := object.Field("status"); value != validate.Undefined {
		parsed, problems := validate.Enum(validate.Path{"status"}, value, statuses...)
		found = append(found, problems...)
		if problems == nil {
			status = parsed
		}
	}
	notes := ""
	if value := object.Field("notes"); value != validate.Undefined {
		parsed, problems := validate.String(validate.Path{"notes"}, value, validate.StringRules{Max: notesMax})
		found = append(found, problems...)
		notes = parsed
	}
	if found != nil {
		return createInput{}, validate.Fail(found)
	}
	return createInput{BotID: botID, Title: written(title), Status: status, Notes: written(notes)}, nil
}

// written is the text as the API's Prisma client stores it: trimmed by the handler, then
// NUL replaced with U+FFFD (withTextSanitization; unpaired surrogates never survive decoding).
func written(text string) string {
	return strings.ReplaceAll(validate.JSTrim(text), "\x00", "\uFFFD")
}

// Create implements scratchpad.create.
func Create(ctx context.Context, database *db.DB, actor db.Actor, raw orpc.Input) (any, *orpc.Error) {
	input, failure := parseCreate(raw)
	if failure != nil {
		return nil, failure
	}
	var item Item
	err := database.Tenant(ctx, actor, func(tx pgx.Tx) error {
		if err := requireBot(ctx, tx, actor, input.BotID); err != nil {
			return err
		}
		var err error
		item, err = scanItem(tx.QueryRow(ctx, `INSERT INTO scratchpad_items (id, "spaceId", "botId", "userId", title, status, notes, "createdAt", "updatedAt")
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8) RETURNING `+columns,
			effects.NewID(), actor.SpaceID, input.BotID, actor.UserID, input.Title, input.Status, input.Notes, now()))
		return err
	})
	if err != nil {
		return nil, spacesettings.Failure(err)
	}
	return item, nil
}

type updateInput struct {
	ItemID string
	Title  *string
	Status *string
	Notes  *string
}

func parseUpdate(raw orpc.Input) (updateInput, *orpc.Error) {
	var input updateInput
	object, issues := validate.Decode(raw.Raw, nil)
	if issues != nil {
		return input, validate.Fail(issues)
	}
	var found []validate.Issue
	itemID, problems := id(object, "itemId")
	found = append(found, problems...)
	title, problems := optionalString(object, "title", 1, titleMax)
	found = append(found, problems...)
	status, problems := optionalStatus(object)
	found = append(found, problems...)
	notes, problems := optionalString(object, "notes", 0, notesMax)
	found = append(found, problems...)
	if found != nil {
		return updateInput{}, validate.Fail(found)
	}
	if title != nil {
		trimmed := written(*title)
		title = &trimmed
	}
	if notes != nil {
		trimmed := written(*notes)
		notes = &trimmed
	}
	return updateInput{ItemID: itemID, Title: title, Status: status, Notes: notes}, nil
}

// Update implements scratchpad.update: any item of the Space, with only the given
// fields changed. The change time moves with a change; an update that names no
// field writes nothing (Prisma skips an empty update and returns the row).
func Update(ctx context.Context, database *db.DB, actor db.Actor, raw orpc.Input) (any, *orpc.Error) {
	input, failure := parseUpdate(raw)
	if failure != nil {
		return nil, failure
	}
	var item Item
	err := database.Tenant(ctx, actor, func(tx pgx.Tx) error {
		sets := []string{`"updatedAt" = $1`}
		args := []any{now()}
		set := func(column string, value *string) {
			if value != nil {
				args = append(args, *value)
				sets = append(sets, column+" = $"+strconv.Itoa(len(args)))
			}
		}
		set("title", input.Title)
		set("status", input.Status)
		set("notes", input.Notes)
		var err error
		if len(sets) == 1 {
			item, err = scanItem(tx.QueryRow(ctx, `SELECT `+columns+` FROM scratchpad_items WHERE id = $1 AND "spaceId" = $2`, input.ItemID, actor.SpaceID))
		} else {
			args = append(args, input.ItemID, actor.SpaceID)
			item, err = scanItem(tx.QueryRow(ctx, `UPDATE scratchpad_items SET `+strings.Join(sets, ", ")+
				` WHERE id = $`+strconv.Itoa(len(args)-1)+` AND "spaceId" = $`+strconv.Itoa(len(args))+` RETURNING `+columns, args...))
		}
		if errors.Is(err, pgx.ErrNoRows) {
			return errIsolation
		}
		return err
	})
	if err != nil {
		return nil, spacesettings.Failure(err)
	}
	return item, nil
}

// Remove implements scratchpad.remove.
func Remove(ctx context.Context, database *db.DB, actor db.Actor, raw orpc.Input) (any, *orpc.Error) {
	object, issues := validate.Decode(raw.Raw, nil)
	if issues != nil {
		return nil, validate.Fail(issues)
	}
	itemID, issues := id(object, "itemId")
	if issues != nil {
		return nil, validate.Fail(issues)
	}
	err := database.Tenant(ctx, actor, func(tx pgx.Tx) error {
		tag, err := tx.Exec(ctx, `DELETE FROM scratchpad_items WHERE id = $1 AND "spaceId" = $2`, itemID, actor.SpaceID)
		if err != nil {
			return err
		}
		if tag.RowsAffected() != 1 {
			return errIsolation
		}
		return nil
	})
	if err != nil {
		return nil, spacesettings.Failure(err)
	}
	return map[string]any{"ok": true}, nil
}
