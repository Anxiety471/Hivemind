package bots

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/orpc"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/shared"
)

// SpaceBot is SpaceBotSchema (packages/contracts/src/spaces/space.ts:14), the bot row a
// Space the member is not in shows: the roster fields without its settings.
type SpaceBot struct {
	ID             string  `json:"id"`
	SpaceID        string  `json:"spaceId"`
	Name           string  `json:"name"`
	Title          string  `json:"title"`
	Color          string  `json:"color"`
	AvatarSet      string  `json:"avatarSet"`
	NotifyOnFinish bool    `json:"notifyOnFinish"`
	Pinned         bool    `json:"pinned"`
	SectionID      *string `json:"sectionId"`
	Unread         bool    `json:"unread"`
	SnoozedUntil   *string `json:"snoozedUntil"`
	ParentBotID    *string `json:"parentBotId"`
	Preview        string  `json:"preview"`
	Status         string  `json:"status"`
	ThreadStatus   string  `json:"threadStatus"`
	RunErrorID     *string `json:"runErrorId"`
	UpdatedAt      string  `json:"updatedAt"`
}

type spaceBotRow struct {
	ID             string
	SpaceID        string
	Name           string
	Color          string
	AvatarSet      string
	NotifyOnFinish bool
	Pinned         bool
	SectionID      *string
	UpdatedAt      time.Time
	ParentBotID    *string
	ThreadID       *string
	Unread         *bool
	SnoozedUntil   *time.Time
}

// SpaceBotRows is listSpaceBotsForSpaces (packages/db/src/bots/bot-repository.ts:185): the
// open bots of each Space, pinned first, with the caller's read state and each thread's
// newest message as the preview. `spaces.list` reads it as system over the member's other
// Spaces; the caller limits the ids.
func SpaceBotRows(
	ctx context.Context,
	tx pgx.Tx,
	deployment shared.Deployment,
	spaceIDs []string,
	userID string,
) ([]SpaceBot, error) {
	bots := []SpaceBot{}
	if len(spaceIDs) == 0 {
		return bots, nil
	}
	rows, err := tx.Query(ctx, `SELECT b.id, b."spaceId", b.name, b.color, b."avatarSet",
			b."notifyOnFinish", b.pinned, b."sectionId", b."updatedAt", b."parentBotId",
			t.id, r.unread, r."snoozedUntil"
		FROM bots b
		LEFT JOIN threads t ON t."botId" = b.id
		LEFT JOIN thread_reads r ON r."threadId" = t.id AND r."userId" = $2
		WHERE b."spaceId" = ANY($1) AND b."archivedAt" IS NULL
		ORDER BY b.pinned DESC, b.position ASC, b."createdAt" ASC`, spaceIDs, userID)
	if err != nil {
		return nil, err
	}
	loaded := []spaceBotRow{}
	for rows.Next() {
		var row spaceBotRow
		if err := rows.Scan(&row.ID, &row.SpaceID, &row.Name, &row.Color, &row.AvatarSet,
			&row.NotifyOnFinish, &row.Pinned, &row.SectionID, &row.UpdatedAt,
			&row.ParentBotID, &row.ThreadID, &row.Unread, &row.SnoozedUntil); err != nil {
			rows.Close()
			return nil, err
		}
		loaded = append(loaded, row)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(loaded) == 0 {
		return bots, nil
	}

	threadIDs := make([]string, 0, len(loaded))
	botIDs := make([]string, 0, len(loaded))
	for _, row := range loaded {
		botIDs = append(botIDs, row.ID)
		if row.ThreadID != nil {
			threadIDs = append(threadIDs, *row.ThreadID)
		}
	}

	// activeRunSelection: the foreground runs a sidebar status shows, newest first.
	runsByBot := map[string][]activeRun{}
	runRows, err := tx.Query(ctx, `SELECT "botId", "threadId", status FROM runs
		WHERE "botId" = ANY($1) AND status = ANY($2) AND trigger NOT IN ('tickets', 'helper')
		ORDER BY "createdAt" DESC`, botIDs, activeRunStatuses)
	if err != nil {
		return nil, err
	}
	for runRows.Next() {
		var botID, threadID, status string
		if err := runRows.Scan(&botID, &threadID, &status); err != nil {
			runRows.Close()
			return nil, err
		}
		runsByBot[botID] = append(runsByBot[botID], activeRun{ThreadID: threadID, Status: status})
	}
	runRows.Close()
	if err := runRows.Err(); err != nil {
		return nil, err
	}

	// withLatestBotRuns: the newest user-visible run per thread, for runErrorId.
	latestRuns := map[string]threadRun{}
	if len(threadIDs) > 0 {
		latestRows, err := tx.Query(ctx, `SELECT r.id, r."threadId", r.status
			FROM unnest($1::text[]) AS t(id)
			CROSS JOIN LATERAL (
				SELECT id, "threadId", status FROM runs
				WHERE "threadId" = t.id AND trigger NOT IN ('bot_message', 'tickets')
				ORDER BY "createdAt" DESC, id DESC LIMIT 1
			) r`, threadIDs)
		if err != nil {
			return nil, err
		}
		for latestRows.Next() {
			var id, threadID, status string
			if err := latestRows.Scan(&id, &threadID, &status); err != nil {
				latestRows.Close()
				return nil, err
			}
			latestRuns[threadID] = threadRun{ID: id, Status: status}
		}
		latestRows.Close()
		if err := latestRows.Err(); err != nil {
			return nil, err
		}
	}

	// withNewestThreadMessages(prisma, rows, 1): the newest message per thread, opened with
	// the Space key; its time wins over the bot's for updatedAt.
	previews := map[string]any{}
	newestAt := map[string]time.Time{}
	if len(threadIDs) > 0 {
		messageRows, err := tx.Query(ctx, `SELECT m."threadId", m.id, m.blocks, m."createdAt"
			FROM unnest($1::text[]) AS t(id)
			CROSS JOIN LATERAL (
				SELECT "threadId", id, blocks, seq, "createdAt" FROM messages
				WHERE "threadId" = t.id ORDER BY seq DESC LIMIT 1
			) m
			ORDER BY m."threadId", m.seq DESC`, threadIDs)
		if err != nil {
			return nil, err
		}
		type previewRow struct {
			ThreadID  string
			ID        string
			Blocks    any
			CreatedAt time.Time
		}
		messages := []previewRow{}
		for messageRows.Next() {
			var message previewRow
			if err := messageRows.Scan(&message.ThreadID, &message.ID, &message.Blocks,
				&message.CreatedAt); err != nil {
				messageRows.Close()
				return nil, err
			}
			messages = append(messages, message)
		}
		messageRows.Close()
		if err := messageRows.Err(); err != nil {
			return nil, err
		}
		if ring := deployment.Content; ring != nil {
			open := make([]map[string]any, len(messages))
			for index, message := range messages {
				open[index] = map[string]any{
					"id": message.ID, "threadId": message.ThreadID, "blocks": message.Blocks,
				}
			}
			if err := ring.OpenRows(ctx, "Message", open); err != nil {
				return nil, err
			}
			for index := range messages {
				messages[index].Blocks = open[index]["blocks"]
			}
		}
		for _, message := range messages {
			previews[message.ThreadID] = message.Blocks
			newestAt[message.ThreadID] = message.CreatedAt
		}
	}

	for _, row := range loaded {
		if row.ThreadID == nil {
			return nil, errBotMissingThread
		}
		statuses := make([]string, len(runsByBot[row.ID]))
		for index, run := range runsByBot[row.ID] {
			statuses[index] = run.Status
		}
		active := primaryRunStatus(statuses)
		statusesInThread := []string{}
		for _, run := range runsByBot[row.ID] {
			if run.ThreadID == *row.ThreadID {
				statusesInThread = append(statusesInThread, run.Status)
			}
		}
		var latest *threadRun
		if run, ok := latestRuns[*row.ThreadID]; ok {
			latest = &run
		}
		updatedAt := row.UpdatedAt
		if newest, ok := newestAt[*row.ThreadID]; ok {
			updatedAt = newest
		}
		bot := SpaceBot{
			ID:             row.ID,
			SpaceID:        row.SpaceID,
			Name:           row.Name,
			Title:          "",
			Color:          row.Color,
			AvatarSet:      resolveAvatarSet(row.AvatarSet),
			NotifyOnFinish: row.NotifyOnFinish,
			Pinned:         row.Pinned,
			SectionID:      row.SectionID,
			Unread:         row.Unread != nil && *row.Unread,
			SnoozedUntil:   shared.ISOOrNil(row.SnoozedUntil),
			ParentBotID:    row.ParentBotID,
			Preview:        shared.PreviewFromBlocks(previews[*row.ThreadID]),
			Status:         active,
			ThreadStatus:   primaryRunStatus(statusesInThread),
			RunErrorID:     rosterRunErrorID(latest, active),
			UpdatedAt:      shared.ISO(updatedAt),
		}
		if failure := validateSpaceBot(bot); failure != nil {
			return nil, failure
		}
		bots = append(bots, bot)
	}
	return bots, nil
}

// validateSpaceBot is the router's parse of SpaceBotSchema: ids must be nonempty.
func validateSpaceBot(bot SpaceBot) *orpc.Error {
	if bot.ID == "" || bot.SpaceID == "" {
		return shared.OutputInvalid()
	}
	for _, id := range []*string{bot.SectionID, bot.ParentBotID, bot.RunErrorID} {
		if id != nil && *id == "" {
			return shared.OutputInvalid()
		}
	}
	return nil
}
