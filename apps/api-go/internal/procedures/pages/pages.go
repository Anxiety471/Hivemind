// Package pages ports pages.list, rename, pin, remove and setVisibility. pages.get still
// reads the page detail in TypeScript; every page share write here uses the SecretStore.
package pages

import (
	"context"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/orpc"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/shared"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/wtf8"
)

const (
	defaultListLimit = 30
	// PAGE_TITLE_MAX_LENGTH (packages/contracts/src/pages.ts:4).
	titleMaxLength = 200
)

// Summary is the wire shape of PageSummarySchema.
type Summary struct {
	ID             string  `json:"id"`
	Title          string  `json:"title"`
	BotID          *string `json:"botId"`
	GroupID        *string `json:"groupId"`
	Visibility     string  `json:"visibility"`
	CurrentVersion int32   `json:"currentVersion"`
	Pinned         bool    `json:"pinned"`
	CreatedAt      string  `json:"createdAt"`
	UpdatedAt      string  `json:"updatedAt"`
}

// ListOutput is pages.list's output.
type ListOutput struct {
	Items      []Summary `json:"items"`
	NextCursor *string   `json:"nextCursor"`
}

// List implements pages.list (apps/api/src/pages.ts listPages): the actor's own
// pages in the active Space, pinned first by pin time, then newest update, then id.
func List(ctx context.Context, database *db.DB, actor db.Actor, raw orpc.Input) (any, *orpc.Error) {
	input, failure := parseList(raw)
	if failure != nil {
		return nil, failure
	}
	limit := defaultListLimit
	if input.HasLimit {
		limit = input.Limit
	}

	args := []any{actor.SpaceID, actor.UserID}
	conditions := []string{`"spaceId" = $1`, `"userId" = $2`}
	arg := func(value any) string {
		args = append(args, value)
		return "$" + strconv.Itoa(len(args))
	}
	if input.HasGroupID {
		conditions = append(conditions, `"groupId" = `+arg(input.GroupID))
	}
	if input.HasBotID {
		conditions = append(conditions, `"botId" = `+arg(input.BotID))
		if !input.HasGroupID {
			conditions = append(conditions, `"groupId" IS NULL`)
		}
	}
	if input.HasCursor {
		after, ok := decodeCursor(input.Cursor)
		if !ok {
			return nil, orpc.BadRequest("Invalid page list cursor")
		}
		conditions = append(conditions, afterCursor(after, arg))
	}
	if input.HasQuery {
		// writeaudit:dynamic input.Query is a request field, not a pgx method value
		conditions = append(conditions, `title ILIKE '%' || `+arg(escapeSearchWildcards(input.Query))+` || '%'`)
	}
	query := fmt.Sprintf(`SELECT `+summaryColumns+`
		FROM pages WHERE %s
		ORDER BY "pinnedAt" DESC NULLS LAST, "updatedAt" DESC, id DESC
		LIMIT %s`, strings.Join(conditions, " AND "), arg(limit+1))

	var rows []row
	err := database.Tenant(ctx, actor, func(tx pgx.Tx) error {
		// writeaudit:dynamic read: conditions/limit are fixed fragments; args are filters
		result, err := tx.Query(ctx, query, args...)
		if err != nil {
			return err
		}
		defer result.Close()
		for result.Next() {
			item, err := scanRow(result)
			if err != nil {
				return err
			}
			rows = append(rows, item)
		}
		return result.Err()
	})
	if err != nil {
		return nil, shared.Failure(err)
	}

	output := ListOutput{Items: []Summary{}}
	page := rows
	if len(page) > limit {
		page = page[:limit]
	}
	for _, item := range page {
		// The router parses the output, which holds the page and not the extra row read to
		// learn whether another page follows.
		if item.invalid() {
			return nil, shared.OutputInvalid()
		}
		output.Items = append(output.Items, item.summary)
	}
	if len(rows) > limit && len(page) > 0 {
		last := page[len(page)-1]
		next := encodeCursor(last.pinnedAt, last.updatedAt, last.summary.ID)
		output.NextCursor = &next
	}
	return output, nil
}

// summaryColumns are the columns of a page that PageSummarySchema is built from.
const summaryColumns = `id, title, "botId", "groupId", visibility, "currentVersion", "pinnedAt", "createdAt", "updatedAt"`

// row is a page as stored, with the times its list cursor needs.
type row struct {
	summary   Summary
	pinnedAt  *time.Time
	updatedAt time.Time
	createdAt time.Time
}

// scanRow reads summaryColumns as pageSummary does: a visibility other than link reads as
// private. The output checks are left to invalid, after the work is committed.
func scanRow(source pgx.Row) (row, error) {
	var item row
	if err := source.Scan(&item.summary.ID, &item.summary.Title, &item.summary.BotID, &item.summary.GroupID,
		&item.summary.Visibility, &item.summary.CurrentVersion, &item.pinnedAt, &item.createdAt, &item.updatedAt); err != nil {
		return row{}, err
	}
	if item.summary.Visibility != "link" {
		item.summary.Visibility = "private"
	}
	item.summary.Pinned = item.pinnedAt != nil
	item.summary.CreatedAt = item.createdAt.UTC().Format(isoMillis)
	item.summary.UpdatedAt = item.updatedAt.UTC().Format(isoMillis)
	return item, nil
}

// invalid is whether the router would refuse this row against PageSummarySchema (a strict
// object): non-empty ids, a title within bounds, a positive version, four-digit-year times.
func (r row) invalid() bool {
	empty := func(id *string) bool { return id != nil && *id == "" }
	fourDigits := func(at time.Time) bool { return at.UTC().Year() >= 0 && at.UTC().Year() <= 9999 }
	return r.summary.ID == "" || empty(r.summary.BotID) || empty(r.summary.GroupID) ||
		!wtf8.ZodMaxPass(r.summary.Title, titleMaxLength) || r.summary.CurrentVersion < 1 ||
		!fourDigits(r.createdAt) || !fourDigits(r.updatedAt)
}

// afterCursor selects the rows after the cursor in list order.
func afterCursor(after cursor, arg func(any) string) string {
	updated := arg(after.UpdatedAt.UTC())
	id := arg(after.ID)
	sameUpdate := fmt.Sprintf(`("updatedAt" < %s OR ("updatedAt" = %s AND id < %s))`, updated, updated, id)
	if after.PinnedAt == nil {
		return `"pinnedAt" IS NULL AND ` + sameUpdate
	}
	pinned := arg(after.PinnedAt.UTC())
	return fmt.Sprintf(`("pinnedAt" IS NULL OR "pinnedAt" < %s OR ("pinnedAt" = %s AND %s))`, pinned, pinned, sameUpdate)
}

// escapeSearchWildcards is core's escapeSearchWildcards: \, % and _ are literal.
func escapeSearchWildcards(value string) string {
	var out strings.Builder
	for _, character := range value {
		if character == '\\' || character == '%' || character == '_' {
			out.WriteByte('\\')
		}
		out.WriteRune(character)
	}
	return out.String()
}
