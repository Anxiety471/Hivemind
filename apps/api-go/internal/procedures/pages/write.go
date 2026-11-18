package pages

import (
	"context"
	"errors"
	"strings"
	"time"
	"unicode"

	"github.com/jackc/pgx/v5"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/orpc"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/shared"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/validate"
)

func now() time.Time { return time.Now().UTC().Truncate(time.Millisecond) }

// requirePage is requirePage in pages.ts: the actor's own page in the active Space, or the
// isolation error every other page (another Space's, another member's, none) gets.
func requirePage(ctx context.Context, tx pgx.Tx, actor db.Actor, pageID string) (row, error) {
	item, err := scanRow(tx.QueryRow(ctx, `SELECT `+summaryColumns+` FROM pages WHERE id = $1 AND "spaceId" = $2 AND "userId" = $3`,
		pageID, actor.SpaceID, actor.UserID))
	if errors.Is(err, pgx.ErrNoRows) {
		return row{}, shared.NotFound
	}
	return item, err
}

// foldTitle is the transform of PageTitleSchema: control characters, line breaks and
// whitespace fold into single spaces, and the ends are trimmed.
func foldTitle(title string) string {
	var out strings.Builder
	folding := false
	for _, r := range title {
		if unicode.Is(unicode.Cc, r) || validate.IsJSSpace(r) {
			folding = true
			continue
		}
		if folding {
			out.WriteByte(' ')
			folding = false
		}
		out.WriteRune(r)
	}
	if folding {
		out.WriteByte(' ')
	}
	return validate.JSTrim(out.String())
}

// pageID reads Id, the key every pages input names its page by.
func pageID(object *validate.Object) (string, []validate.Issue) {
	return validate.String(validate.Path{"pageId"}, object.Field("pageId"), validate.StringRules{Min: 1})
}

// parseRename mirrors z.strictObject({ pageId: Id, title: PageTitleSchema }). The title is
// z.string() transformed by foldTitle and piped into z.string().min(1).max(200), so a value
// that is not a string fails the first stage alone and the bounds apply to the folded text.
func parseRename(raw orpc.Input) (id, title string, failure *orpc.Error) {
	object, issues := validate.Decode(raw.Raw, nil)
	if issues != nil {
		return "", "", validate.Fail(issues)
	}
	var found []validate.Issue
	id, problems := pageID(object)
	found = append(found, problems...)
	path := validate.Path{"title"}
	title, problems = validate.String(path, object.Field("title"), validate.StringRules{})
	if problems == nil {
		title, problems = validate.String(path, foldTitle(title), validate.StringRules{Min: 1, Max: titleMaxLength})
	}
	found = append(found, problems...)
	found = append(found, object.Unrecognized(nil, "pageId", "title")...)
	if found != nil {
		return "", "", validate.Fail(found)
	}
	return id, title, nil
}

// Rename implements pages.rename (renamePage): the page's title and its update time change.
// The title holds no NUL or unpaired surrogate for the sanitizing client to replace: the
// fold removed the first, and decoding the request replaced the second.
func Rename(ctx context.Context, database *db.DB, actor db.Actor, raw orpc.Input) (any, *orpc.Error) {
	id, title, failure := parseRename(raw)
	if failure != nil {
		return nil, failure
	}
	var renamed row
	err := database.Tenant(ctx, actor, func(tx pgx.Tx) error {
		if _, err := requirePage(ctx, tx, actor, id); err != nil {
			return err
		}
		// A page deleted since the read above reads as gone, like any other missing page.
		var err error
		renamed, err = scanRow(tx.QueryRow(ctx, `UPDATE pages SET title = $1, "updatedAt" = $2 WHERE id = $3 RETURNING `+summaryColumns,
			title, now(), id))
		if errors.Is(err, pgx.ErrNoRows) {
			return shared.NotFound
		}
		return err
	})
	if err != nil {
		return nil, shared.Failure(err)
	}
	// The router parses the output after the write has committed.
	if renamed.invalid() {
		return nil, shared.OutputInvalid()
	}
	return renamed.summary, nil
}

// parsePin mirrors z.strictObject({ pageId: Id, pinned: z.boolean() }).
func parsePin(raw orpc.Input) (id string, pinned bool, failure *orpc.Error) {
	object, issues := validate.Decode(raw.Raw, nil)
	if issues != nil {
		return "", false, validate.Fail(issues)
	}
	var found []validate.Issue
	id, problems := pageID(object)
	found = append(found, problems...)
	pinned, problems = validate.Boolean(validate.Path{"pinned"}, object.Field("pinned"))
	found = append(found, problems...)
	found = append(found, object.Unrecognized(nil, "pageId", "pinned")...)
	if found != nil {
		return "", false, validate.Fail(found)
	}
	return id, pinned, nil
}

// Pin implements pages.pin (pinPage). A page already in the asked state is returned as read;
// pinning or unpinning one sets the pin time and leaves the update time alone (updatedAt
// moves with the page's content or title, not with its pin).
func Pin(ctx context.Context, database *db.DB, actor db.Actor, raw orpc.Input) (any, *orpc.Error) {
	id, pinned, failure := parsePin(raw)
	if failure != nil {
		return nil, failure
	}
	var result row
	err := database.Tenant(ctx, actor, func(tx pgx.Tx) error {
		current, err := requirePage(ctx, tx, actor, id)
		if err != nil {
			return err
		}
		if (current.pinnedAt != nil) == pinned {
			result = current
			return nil
		}
		var pinnedAt *time.Time
		if pinned {
			at := now()
			pinnedAt = &at
		}
		result, err = scanRow(tx.QueryRow(ctx, `UPDATE pages SET "pinnedAt" = $1 WHERE id = $2 RETURNING `+summaryColumns, pinnedAt, id))
		if errors.Is(err, pgx.ErrNoRows) {
			return shared.NotFound
		}
		return err
	})
	if err != nil {
		return nil, shared.Failure(err)
	}
	if result.invalid() {
		return nil, shared.OutputInvalid()
	}
	return result.summary, nil
}
