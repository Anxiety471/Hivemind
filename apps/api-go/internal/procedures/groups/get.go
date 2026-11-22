package groups

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/orpc"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/shared"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/threads"
)

// This file is groups.get: groupRepos.getGroup and mapGroup (packages/db/src/spaces/groups.ts:379
// and :75) plus the newest message page of the group's thread, as the route embeds it
// (apps/api/src/routes/bots.ts:735). A group that is archived or left with fewer than
// GROUP_MEMBER_MIN active bots is the isolation error, exactly as getGroup answers.

// GroupDetail is GroupDetailSchema: the group with its first message page.
type GroupDetail struct {
	Group
	Messages []map[string]any `json:"messages"`
}

// Get implements groups.get.
func Get(ctx context.Context, database *db.DB, deployment shared.Deployment, actor db.Actor, raw orpc.Input) (any, *orpc.Error) {
	groupID, failure := parseGroupID(raw)
	if failure != nil {
		return nil, failure
	}
	var detail GroupDetail
	err := database.Tenant(ctx, actor, func(tx pgx.Tx) error {
		// getGroup: the group, its thread and the caller's read state, archived groups excluded.
		var row groupRow
		var threadID *string
		err := tx.QueryRow(ctx, `SELECT g.id, g."spaceId", g.name, g.pinned, g."sectionId", g."archivedAt",
				g."createdAt", g."updatedAt", t.id, r.unread, r."snoozedUntil"
			FROM chat_groups g
			LEFT JOIN threads t ON t."groupId" = g.id
			LEFT JOIN thread_reads r ON r."threadId" = t.id AND r."userId" = $2
			WHERE g.id = $1 AND g."spaceId" = $3 AND g."archivedAt" IS NULL`,
			groupID, actor.UserID, actor.SpaceID).Scan(&row.ID, &row.SpaceID, &row.Name, &row.Pinned,
			&row.SectionID, &row.ArchivedAt, &row.CreatedAt, &row.UpdatedAt, &threadID, &row.Unread,
			&row.SnoozedUntil)
		if errors.Is(err, pgx.ErrNoRows) {
			return errIsolation
		}
		if err != nil {
			return err
		}
		roster, active, err := groupMembers(ctx, tx, []string{groupID}, false)
		if err != nil {
			return err
		}
		if active[groupID] < groupMemberMin {
			return errIsolation
		}
		if threadID == nil {
			return errMissingThread
		}
		row.ThreadID = threadID

		preview, err := threads.NewestMessagePreview(ctx, tx, deployment.Content, *threadID)
		if err != nil {
			return err
		}
		group := Group{
			ID:           row.ID,
			SpaceID:      row.SpaceID,
			Name:         row.Name,
			Pinned:       row.Pinned,
			SectionID:    row.SectionID,
			Members:      roster[groupID],
			ThreadID:     *threadID,
			Preview:      preview,
			Unread:       row.Unread != nil && *row.Unread,
			SnoozedUntil: shared.ISOOrNil(row.SnoozedUntil),
			UpdatedAt:    shared.ISO(row.UpdatedAt),
			CreatedAt:    shared.ISO(row.CreatedAt),
		}
		if group.Members == nil {
			group.Members = []GroupMember{}
		}
		if failure := validateGroup(group); failure != nil {
			return failure
		}
		page, err := threads.LoadFirstPage(ctx, tx, deployment.Content, *threadID)
		if err != nil {
			return err
		}
		if failure := threads.ValidateMessages(page.Messages); failure != nil {
			return failure
		}
		detail = GroupDetail{Group: group, Messages: page.Messages}
		return nil
	})
	if err != nil {
		return nil, shared.Failure(err)
	}
	return detail, nil
}
