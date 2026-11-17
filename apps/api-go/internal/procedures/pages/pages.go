// Package pages ports pages.list. The other pages procedures read and write
// share secrets, versions and files, and stay on the TypeScript API.
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
)

const defaultListLimit = 30

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
		conditions = append(conditions, `title ILIKE '%' || `+arg(escapeSearchWildcards(input.Query))+` || '%'`)
	}
	query := fmt.Sprintf(`SELECT id, title, "botId", "groupId", visibility, "currentVersion", "pinnedAt", "createdAt", "updatedAt"
		FROM pages WHERE %s
		ORDER BY "pinnedAt" DESC NULLS LAST, "updatedAt" DESC, id DESC
		LIMIT %s`, strings.Join(conditions, " AND "), arg(limit+1))

	type row struct {
		summary   Summary
		pinnedAt  *time.Time
		updatedAt time.Time
	}
	var rows []row
	err := database.Tenant(ctx, actor, func(tx pgx.Tx) error {
		result, err := tx.Query(ctx, query, args...)
		if err != nil {
			return err
		}
		defer result.Close()
		for result.Next() {
			var item row
			var createdAt time.Time
			if err := result.Scan(&item.summary.ID, &item.summary.Title, &item.summary.BotID, &item.summary.GroupID,
				&item.summary.Visibility, &item.summary.CurrentVersion, &item.pinnedAt, &createdAt, &item.updatedAt); err != nil {
				return err
			}
			if item.summary.Visibility != "link" {
				item.summary.Visibility = "private"
			}
			item.summary.Pinned = item.pinnedAt != nil
			item.summary.CreatedAt = createdAt.UTC().Format(isoMillis)
			item.summary.UpdatedAt = item.updatedAt.UTC().Format(isoMillis)
			rows = append(rows, item)
		}
		return result.Err()
	})
	if err != nil {
		if db.IsUnavailable(err) {
			return nil, orpc.Unavailable()
		}
		return nil, orpc.Internal()
	}

	output := ListOutput{Items: []Summary{}}
	page := rows
	if len(page) > limit {
		page = page[:limit]
	}
	for _, item := range page {
		output.Items = append(output.Items, item.summary)
	}
	if len(rows) > limit && len(page) > 0 {
		last := page[len(page)-1]
		next := encodeCursor(last.pinnedAt, last.updatedAt, last.summary.ID)
		output.NextCursor = &next
	}
	return output, nil
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
