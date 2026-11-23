package botsections

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/effects"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/orpc"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/validate"
)

const nameMaxLength = 60

var errIsolation = orpc.NotFound("Resource not found")

func conflict(message string) *orpc.Error { return orpc.Conflict(message) }

func unavailableOr(err error) *orpc.Error {
	if db.IsUnavailable(err) {
		return orpc.Unavailable()
	}
	return orpc.Internal()
}

// CreateInput is botSections.create's input: exactly one of botId or groupId, and a name.
type CreateInput struct {
	BotID, GroupID, Name string
}

// ParseCreate mirrors threadTarget.safeExtend({ name: BotSectionName }): an object
// of optional ids and a trimmed 1..60 name, refined to exactly one id.
func ParseCreate(raw orpc.Input) (CreateInput, *orpc.Error) {
	var input CreateInput
	object, issues := validate.Decode(raw.Raw, nil)
	if issues != nil {
		return input, validate.Fail(issues)
	}
	var found []validate.Issue
	aborted := false
	id := func(key string, target *string) {
		value, present := object.Get(key)
		if !present {
			return
		}
		text, problems := validate.String(validate.Path{key}, value, validate.StringRules{Min: 1})
		if _, isString := value.(string); !isString {
			aborted = true
		}
		found = append(found, problems...)
		if problems == nil {
			*target = text
		}
	}
	id("botId", &input.BotID)
	id("groupId", &input.GroupID)
	name, problems := validate.String(validate.Path{"name"}, object.Field("name"), validate.StringRules{Trim: true, Min: 1, Max: nameMaxLength})
	if _, isString := object.Field("name").(string); !isString {
		aborted = true
	}
	found = append(found, problems...)
	input.Name = name
	// The refinement runs unless a type check aborted the object.
	if !aborted && (input.BotID != "") == (input.GroupID != "") {
		found = append(found, validate.Issue{
			"code": "custom", "path": []any{"botId"}, "message": "Provide exactly one of botId or groupId",
		})
	}
	if found != nil {
		return CreateInput{}, validate.Fail(found)
	}
	return input, nil
}

// UpdateInput is botSections.update's input.
type UpdateInput struct{ SectionID, Name string }

// ParseUpdate mirrors z.object({ sectionId: Id, name: BotSectionName }).
func ParseUpdate(raw orpc.Input) (UpdateInput, *orpc.Error) {
	var input UpdateInput
	object, issues := validate.Decode(raw.Raw, nil)
	if issues != nil {
		return input, validate.Fail(issues)
	}
	var found []validate.Issue
	id, problems := validate.String(validate.Path{"sectionId"}, object.Field("sectionId"), validate.StringRules{Min: 1})
	found = append(found, problems...)
	name, problems := validate.String(validate.Path{"name"}, object.Field("name"), validate.StringRules{Trim: true, Min: 1, Max: nameMaxLength})
	found = append(found, problems...)
	if found != nil {
		return UpdateInput{}, validate.Fail(found)
	}
	return UpdateInput{SectionID: id, Name: name}, nil
}

// ParseRemove mirrors z.object({ sectionId: Id }).
func ParseRemove(raw orpc.Input) (string, *orpc.Error) {
	object, issues := validate.Decode(raw.Raw, nil)
	if issues != nil {
		return "", validate.Fail(issues)
	}
	id, problems := validate.String(validate.Path{"sectionId"}, object.Field("sectionId"), validate.StringRules{Min: 1})
	if problems != nil {
		return "", validate.Fail(problems)
	}
	return id, nil
}

// lockSpace is lockSpaceForContentCreation: serialize with the empty-Space
// deletion claim, and require the actor to be a member of a live Space.
func lockSpace(ctx context.Context, tx pgx.Tx, actor db.Actor) error {
	// writeaudit:dynamic transaction-scoped advisory lock; no row payload
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, actor.SpaceID); err != nil {
		return err
	}
	var deletingAt *time.Time
	err := tx.QueryRow(ctx, `SELECT s."deletingAt" FROM space_members sm JOIN spaces s ON s.id = sm."spaceId"
		WHERE sm."spaceId" = $1 AND sm."userId" = $2`, actor.SpaceID, actor.UserID).Scan(&deletingAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return errIsolation
	}
	if err != nil {
		return err
	}
	if deletingAt != nil {
		return conflict("Space deletion is already in progress")
	}
	return nil
}

func asFailure(err error) *orpc.Error {
	var failure *orpc.Error
	if errors.As(err, &failure) {
		return failure
	}
	return unavailableOr(err)
}

type row struct {
	id, name  string
	position  int32
	createdAt time.Time
	updatedAt time.Time
}

func (r row) section() Section {
	return Section{
		ID: r.id, Name: r.name, Position: r.position,
		CreatedAt: r.createdAt.UTC().Format(isoMillis), UpdatedAt: r.updatedAt.UTC().Format(isoMillis),
	}
}

const sectionColumns = `id, name, position, "createdAt", "updatedAt"`

func scanRow(r pgx.Row) (row, error) {
	var found row
	err := r.Scan(&found.id, &found.name, &found.position, &found.createdAt, &found.updatedAt)
	return found, err
}

func now() time.Time { return time.Now().UTC().Truncate(time.Millisecond) }

// Create implements botSections.create (repos.createBotSection): put a bot or
// group in the Space's section of that name, creating it when no member has.
func Create(ctx context.Context, database *db.DB, actor db.Actor, raw orpc.Input) (Section, *orpc.Error) {
	input, failure := ParseCreate(raw)
	if failure != nil {
		return Section{}, failure
	}
	var created Section
	err := database.Tenant(ctx, actor, func(tx pgx.Tx) error {
		table, id := "chat_groups", input.GroupID
		if input.BotID != "" {
			table, id = "bots", input.BotID
		}
		var target string
		err := tx.QueryRow(ctx, `SELECT id FROM `+table+` WHERE id = $1 AND "spaceId" = $2 AND "archivedAt" IS NULL`,
			id, actor.SpaceID).Scan(&target)
		if errors.Is(err, pgx.ErrNoRows) {
			return errIsolation
		}
		if err != nil {
			return err
		}
		// Sections belong to the space: a name another member already used is the same section.
		if err := lockSpace(ctx, tx, actor); err != nil {
			return err
		}
		section, err := scanRow(tx.QueryRow(ctx, `SELECT `+sectionColumns+` FROM bot_sections
			WHERE "spaceId" = $1 AND name = $2 ORDER BY position ASC, "createdAt" ASC LIMIT 1`, actor.SpaceID, input.Name))
		if errors.Is(err, pgx.ErrNoRows) {
			var next int32
			if err := tx.QueryRow(ctx, `SELECT coalesce(max(position), -1) + 1 FROM bot_sections WHERE "spaceId" = $1`, actor.SpaceID).Scan(&next); err != nil {
				return err
			}
			at := now()
			section, err = scanRow(tx.QueryRow(ctx, `INSERT INTO bot_sections (id, "spaceId", "userId", name, position, "createdAt", "updatedAt")
				VALUES ($1, $2, $3, $4, $5, $6, $6) RETURNING `+sectionColumns,
				db.Data(effects.NewID(), actor.SpaceID, actor.UserID, input.Name, next, at)...))
		}
		if err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `UPDATE `+table+` SET "sectionId" = $1, "updatedAt" = $2 WHERE id = $3`,
			append(db.Data(section.id, now()), target)...); err != nil {
			return err
		}
		created = section.section()
		return nil
	})
	if err != nil {
		return Section{}, asFailure(err)
	}
	return created, nil
}

// Update implements botSections.update (repos.updateBotSection): rename a section
// of the Space, refusing a name another section already has.
func Update(ctx context.Context, database *db.DB, actor db.Actor, raw orpc.Input) (Section, *orpc.Error) {
	input, failure := ParseUpdate(raw)
	if failure != nil {
		return Section{}, failure
	}
	var result Section
	err := database.Tenant(ctx, actor, func(tx pgx.Tx) error {
		existing, err := scanRow(tx.QueryRow(ctx, `SELECT `+sectionColumns+` FROM bot_sections WHERE id = $1 AND "spaceId" = $2`,
			input.SectionID, actor.SpaceID))
		if errors.Is(err, pgx.ErrNoRows) {
			return errIsolation
		}
		if err != nil {
			return err
		}
		if existing.name == input.Name {
			result = existing.section()
			return nil
		}
		// Serializes with section creation so two members cannot both end up with one name.
		if err := lockSpace(ctx, tx, actor); err != nil {
			return err
		}
		var taken string
		err = tx.QueryRow(ctx, `SELECT id FROM bot_sections WHERE "spaceId" = $1 AND name = $2 AND id <> $3 LIMIT 1`,
			actor.SpaceID, input.Name, existing.id).Scan(&taken)
		if err == nil {
			return conflict("Section name already used")
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		updated, err := scanRow(tx.QueryRow(ctx, `UPDATE bot_sections SET name = $1, "updatedAt" = $2 WHERE id = $3 RETURNING `+sectionColumns,
			append(db.Data(input.Name, now()), existing.id)...))
		if err != nil {
			return err
		}
		result = updated.section()
		return nil
	})
	if err != nil {
		return Section{}, asFailure(err)
	}
	return result, nil
}

// Removed is botSections.remove's output.
type Removed struct {
	ID             string `json:"id"`
	ReleasedBots   int64  `json:"releasedBots"`
	ReleasedGroups int64  `json:"releasedGroups"`
}

// Remove implements botSections.remove (repos.deleteBotSection): delete one of the
// Space's sections; its bots and groups stay, unsectioned (foreign key SET NULL).
func Remove(ctx context.Context, database *db.DB, actor db.Actor, raw orpc.Input) (Removed, *orpc.Error) {
	sectionID, failure := ParseRemove(raw)
	if failure != nil {
		return Removed{}, failure
	}
	result := Removed{ID: sectionID}
	err := database.Tenant(ctx, actor, func(tx pgx.Tx) error {
		// The row lock blocks concurrent moves into this section until the delete commits.
		var locked string
		err := tx.QueryRow(ctx, `SELECT id FROM bot_sections WHERE id = $1 AND "spaceId" = $2 FOR UPDATE`, sectionID, actor.SpaceID).Scan(&locked)
		if errors.Is(err, pgx.ErrNoRows) {
			return errIsolation
		}
		if err != nil {
			return err
		}
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM bots WHERE "sectionId" = $1`, sectionID).Scan(&result.ReleasedBots); err != nil {
			return err
		}
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM chat_groups WHERE "sectionId" = $1`, sectionID).Scan(&result.ReleasedGroups); err != nil {
			return err
		}
		_, err = tx.Exec(ctx, `DELETE FROM bot_sections WHERE id = $1`, sectionID)
		return err
	})
	if err != nil {
		return Removed{}, asFailure(err)
	}
	return result, nil
}
