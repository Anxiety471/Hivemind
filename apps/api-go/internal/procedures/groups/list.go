package groups

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/orpc"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/shared"
)

// groupMemberMin is GROUP_MEMBER_MIN (packages/contracts/src/spaces/groups.ts:17): a group
// with fewer active bots does not open.
const groupMemberMin = 2

// GroupMember is GroupMemberSchema (packages/contracts/src/spaces/groups.ts:6).
type GroupMember struct {
	BotID     string `json:"botId"`
	Name      string `json:"name"`
	Color     string `json:"color"`
	AvatarSet string `json:"avatarSet"`
	Status    string `json:"status"`
}

// Group is GroupSchema (packages/contracts/src/spaces/groups.ts:26).
type Group struct {
	ID           string        `json:"id"`
	SpaceID      string        `json:"spaceId"`
	Name         string        `json:"name"`
	Pinned       bool          `json:"pinned"`
	SectionID    *string       `json:"sectionId"`
	ArchivedAt   *string       `json:"archivedAt"`
	Members      []GroupMember `json:"members"`
	ThreadID     string        `json:"threadId"`
	Preview      string        `json:"preview"`
	Unread       bool          `json:"unread"`
	SnoozedUntil *string       `json:"snoozedUntil"`
	UpdatedAt    string        `json:"updatedAt"`
	CreatedAt    string        `json:"createdAt"`
}

// activeRunStatuses is ACTIVE_RUN_STATUSES (packages/core/src/runs/run-state.ts:14):
// working and waiting-on-user runs, which a member's status shows.
var activeRunStatuses = []string{"queued", "leased", "running", "waiting_input", "waiting_takeover"}

// errMissingThread is the IsolationError mapGroup throws for a group without its thread.
var errMissingThread = orpc.NotFound("Group is missing its thread")

// List implements groups.list: the Space's open groups, pinned first and newest activity
// first, each with its roster and the preview of its newest message
// (repos.listGroups, packages/db/src/spaces/groups.ts:358).
func List(ctx context.Context, database *db.DB, deployment shared.Deployment, actor db.Actor) (any, *orpc.Error) {
	return listGroups(ctx, database, deployment, actor, false)
}

// ListArchived implements groups.listArchived: archived groups and groups left with too few
// active bots to open (listArchivedGroups, groups.ts:332).
func ListArchived(ctx context.Context, database *db.DB, deployment shared.Deployment, actor db.Actor) (any, *orpc.Error) {
	return listGroups(ctx, database, deployment, actor, true)
}

type groupRow struct {
	ID           string
	SpaceID      string
	Name         string
	Pinned       bool
	SectionID    *string
	ArchivedAt   *time.Time
	CreatedAt    time.Time
	UpdatedAt    time.Time
	ThreadID     *string
	Unread       *bool
	SnoozedUntil *time.Time
}

type memberRow struct {
	GroupID   string
	BotID     string
	Name      string
	Color     string
	AvatarSet *string
	Archived  *time.Time
}

func listGroups(ctx context.Context, database *db.DB, deployment shared.Deployment, actor db.Actor, archived bool) (any, *orpc.Error) {
	groups := []Group{}
	err := database.Tenant(ctx, actor, func(tx pgx.Tx) error {
		// groupInclude/archivedGroupInclude (groups.ts:181,189): the group, its thread and the
		// caller's own read state.
		query := `SELECT g.id, g."spaceId", g.name, g.pinned, g."sectionId", g."archivedAt",
				g."createdAt", g."updatedAt", t.id, r.unread, r."snoozedUntil"
			FROM chat_groups g
			LEFT JOIN threads t ON t."groupId" = g.id
			LEFT JOIN thread_reads r ON r."threadId" = t.id AND r."userId" = $2
			WHERE g."spaceId" = $1 AND g."archivedAt" IS NULL
			ORDER BY g.pinned DESC, g."updatedAt" DESC`
		if archived {
			// Archived groups, and groups left with too few active bots to open, whatever
			// their member count: this is the only list they appear in (groups.ts:332).
			query = `SELECT g.id, g."spaceId", g.name, g.pinned, g."sectionId", g."archivedAt",
					g."createdAt", g."updatedAt", t.id, r.unread, r."snoozedUntil"
				FROM chat_groups g
				LEFT JOIN threads t ON t."groupId" = g.id
				LEFT JOIN thread_reads r ON r."threadId" = t.id AND r."userId" = $2
				WHERE g."spaceId" = $1 AND (g."archivedAt" IS NOT NULL OR EXISTS (
					SELECT 1 FROM chat_group_members m JOIN bots b ON b.id = m."botId"
					WHERE m."groupId" = g.id AND b."archivedAt" IS NOT NULL))
				ORDER BY g.pinned DESC, g."updatedAt" DESC`
		}
		rows, err := tx.Query(ctx, query, actor.SpaceID, actor.UserID)
		if err != nil {
			return err
		}
		loaded := []groupRow{}
		for rows.Next() {
			var row groupRow
			if err := rows.Scan(&row.ID, &row.SpaceID, &row.Name, &row.Pinned, &row.SectionID,
				&row.ArchivedAt, &row.CreatedAt, &row.UpdatedAt, &row.ThreadID, &row.Unread,
				&row.SnoozedUntil); err != nil {
				rows.Close()
				return err
			}
			loaded = append(loaded, row)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}
		if len(loaded) == 0 {
			return nil
		}

		// withNewestThreadMessages(prisma, groups, 1): one indexed read of the newest message
		// per thread, opened with the Space key (preview-messages.ts:22).
		threadIDs := make([]string, 0, len(loaded))
		groupIDs := make([]string, 0, len(loaded))
		for _, row := range loaded {
			groupIDs = append(groupIDs, row.ID)
			if row.ThreadID != nil {
				threadIDs = append(threadIDs, *row.ThreadID)
			}
		}
		previews := map[string]any{}
		if len(threadIDs) > 0 {
			messageRows, err := tx.Query(ctx, `SELECT m."threadId", m.id, m.blocks
				FROM unnest($1::text[]) AS t(id)
				CROSS JOIN LATERAL (
					SELECT "threadId", id, blocks, seq FROM messages
					WHERE "threadId" = t.id ORDER BY seq DESC LIMIT 1
				) m
				ORDER BY m."threadId", m.seq DESC`, threadIDs)
			if err != nil {
				return err
			}
			type previewRow struct {
				ThreadID string
				ID       string
				Blocks   any
			}
			messages := []previewRow{}
			for messageRows.Next() {
				var message previewRow
				if err := messageRows.Scan(&message.ThreadID, &message.ID, &message.Blocks); err != nil {
					messageRows.Close()
					return err
				}
				messages = append(messages, message)
			}
			messageRows.Close()
			if err := messageRows.Err(); err != nil {
				return err
			}
			if ring := deployment.Content; ring != nil {
				open := make([]map[string]any, len(messages))
				for index, message := range messages {
					open[index] = map[string]any{
						"id": message.ID, "threadId": message.ThreadID, "blocks": message.Blocks,
					}
				}
				if err := ring.OpenRows(ctx, "Message", open); err != nil {
					return err
				}
				for index := range messages {
					messages[index].Blocks = open[index]["blocks"]
				}
			}
			for _, message := range messages {
				previews[message.ThreadID] = message.Blocks
			}
		}

		members, activeCount, err := groupMembers(ctx, tx, groupIDs, archived)
		if err != nil {
			return err
		}

		// TypeScript filters before it maps (groups.ts:358-378), so a group the list leaves out
		// never reaches mapGroup and its missing thread is never asked for.
		for _, row := range loaded {
			roster := members[row.ID]
			if roster == nil {
				roster = []GroupMember{}
			}
			// A group left with fewer than GROUP_MEMBER_MIN active bots does not open; it is
			// only listed as archived (listGroups/listArchivedGroups, groups.ts:332-369).
			if archived {
				// Archived, or left with too few active bots to open (groups.ts:350).
				if row.ArchivedAt == nil && activeCount[row.ID] >= groupMemberMin {
					continue
				}
			} else if len(roster) < groupMemberMin {
				continue
			}
			if row.ThreadID == nil {
				return errMissingThread
			}
			group := Group{
				ID:           row.ID,
				SpaceID:      row.SpaceID,
				Name:         row.Name,
				Pinned:       row.Pinned,
				SectionID:    row.SectionID,
				Members:      roster,
				ThreadID:     *row.ThreadID,
				Preview:      shared.PreviewFromBlocks(previews[*row.ThreadID]),
				Unread:       row.Unread != nil && *row.Unread,
				SnoozedUntil: shared.ISOOrNil(row.SnoozedUntil),
				UpdatedAt:    shared.ISO(row.UpdatedAt),
				CreatedAt:    shared.ISO(row.CreatedAt),
			}
			if row.ArchivedAt != nil {
				archivedAt := shared.ISO(*row.ArchivedAt)
				group.ArchivedAt = &archivedAt
			}
			if failure := validateGroup(group); failure != nil {
				return failure
			}
			groups = append(groups, group)
		}
		return nil
	})
	if err != nil {
		return nil, shared.Failure(err)
	}
	return groups, nil
}

// groupMembers is the `members` include of groupInclude/archivedGroupInclude (groups.ts:164,
// 189): the roster in (createdAt, botId) order with each bot's active runs, and how many of
// them are not archived (which is what the archived list's minimum counts).
func groupMembers(ctx context.Context, tx pgx.Tx, groupIDs []string, archived bool) (map[string][]GroupMember, map[string]int, error) {
	query := `SELECT m."groupId", m."botId", b.name, b.color, b."avatarSet", NULL::timestamptz
		FROM chat_group_members m JOIN bots b ON b.id = m."botId"
		WHERE m."groupId" = ANY($1) AND b."archivedAt" IS NULL
		ORDER BY m."createdAt" ASC, m."botId" ASC`
	if archived {
		query = `SELECT m."groupId", m."botId", b.name, b.color, b."avatarSet", b."archivedAt"
		FROM chat_group_members m JOIN bots b ON b.id = m."botId"
		WHERE m."groupId" = ANY($1)
		ORDER BY m."createdAt" ASC, m."botId" ASC`
	}
	rows, err := tx.Query(ctx, query, groupIDs)
	if err != nil {
		return nil, nil, err
	}
	roster := []memberRow{}
	botIDs := []string{}
	for rows.Next() {
		var row memberRow
		if err := rows.Scan(&row.GroupID, &row.BotID, &row.Name, &row.Color, &row.AvatarSet,
			&row.Archived); err != nil {
			rows.Close()
			return nil, nil, err
		}
		roster = append(roster, row)
		botIDs = append(botIDs, row.BotID)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, nil, err
	}
	statuses := map[string]string{}
	if len(botIDs) > 0 {
		runRows, err := tx.Query(ctx, `SELECT "botId", status FROM runs
			WHERE "botId" = ANY($1) AND status = ANY($2) AND trigger NOT IN ('tickets', 'helper')
			ORDER BY "createdAt" DESC`, botIDs, activeRunStatuses)
		if err != nil {
			return nil, nil, err
		}
		runs := map[string][]string{}
		for runRows.Next() {
			var botID, status string
			if err := runRows.Scan(&botID, &status); err != nil {
				runRows.Close()
				return nil, nil, err
			}
			runs[botID] = append(runs[botID], status)
		}
		runRows.Close()
		if err := runRows.Err(); err != nil {
			return nil, nil, err
		}
		for botID, ordered := range runs {
			statuses[botID] = primaryActiveRun(ordered)
		}
	}
	members := map[string][]GroupMember{}
	activeCount := map[string]int{}
	for _, row := range roster {
		status := statuses[row.BotID]
		if status == "" {
			status = "idle"
		}
		avatarSet := "organic"
		if row.AvatarSet != nil && *row.AvatarSet == "rakazo" {
			avatarSet = "rakazo"
		}
		members[row.GroupID] = append(members[row.GroupID], GroupMember{
			BotID:     row.BotID,
			Name:      row.Name,
			Color:     row.Color,
			AvatarSet: avatarSet,
			Status:    status,
		})
		if row.Archived == nil {
			activeCount[row.GroupID]++
		}
	}
	return members, activeCount, nil
}

// primaryActiveRun is primaryActiveRun (thread-listing.ts:30): waiting, running, then leased
// work wins over queued work, regardless of creation order.
func primaryActiveRun(statuses []string) string {
	for _, wanted := range []string{"waiting_takeover", "waiting_input"} {
		for _, status := range statuses {
			if status == wanted {
				return status
			}
		}
	}
	for _, wanted := range []string{"running", "leased"} {
		for _, status := range statuses {
			if status == wanted {
				return status
			}
		}
	}
	return statuses[0]
}

// validateGroup is GroupSchema's parse of the mapped row: the ids must be nonempty, and a
// stored value outside the schema answers the router's output failure.
func validateGroup(group Group) *orpc.Error {
	if group.ID == "" || group.SpaceID == "" || group.ThreadID == "" {
		return shared.OutputInvalid()
	}
	if group.SectionID != nil && *group.SectionID == "" {
		return shared.OutputInvalid()
	}
	for _, member := range group.Members {
		if member.BotID == "" {
			return shared.OutputInvalid()
		}
		if member.AvatarSet != "organic" && member.AvatarSet != "rakazo" {
			return shared.OutputInvalid()
		}
	}
	return nil
}
