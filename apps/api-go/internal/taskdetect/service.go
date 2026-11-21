package taskdetect

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/contentcrypto"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/effects"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/messageblocks"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/shared"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/tickets"
)

// Service runs task-detection context loading, turn preparation, and board sync
// directly against Postgres under tenant row-level security.
type Service struct {
	DB       *db.DB
	BoardLab bool
	Content  *contentcrypto.KeyRing
	Signals  *effects.Notifier
	Logger   *slog.Logger
	Now      func() time.Time
}

func (s *Service) now() time.Time {
	if s.Now != nil {
		return s.Now().UTC().Truncate(time.Millisecond)
	}
	return time.Now().UTC().Truncate(time.Millisecond)
}

func (s *Service) deployment() shared.Deployment {
	return shared.Deployment{BoardLab: s.BoardLab, Signals: s.Signals, Content: s.Content}
}

// LoadContext returns a bot's open assigned Kanban tickets plus any explicitly
// referenced tickets from promptText.
func (s *Service) LoadContext(ctx context.Context, req ContextRequest) (ContextResponse, error) {
	if req.SpaceID == "" || req.UserID == "" || req.BotID == "" {
		return ContextResponse{}, errors.New("spaceId, userId, and botId are required")
	}
	actor := db.Actor{SpaceID: req.SpaceID, UserID: req.UserID}
	resp := ContextResponse{OpenTickets: []OpenTicket{}}
	maxBytes := req.MaxBytes
	if maxBytes <= 0 {
		maxBytes = DefaultContextMaxBytes
	}

	err := s.DB.Tenant(ctx, actor, func(tx pgx.Tx) error {
		enabled, err := tickets.Enabled(ctx, tx, s.deployment(), req.UserID)
		if err != nil {
			return err
		}
		if !enabled {
			return nil
		}
		resp.Enabled = true

		var board tickets.Board
		err = tx.QueryRow(ctx, `SELECT id, "ticketPrefix" FROM boards WHERE "spaceId" = $1`, req.SpaceID).
			Scan(&board.ID, &board.Prefix)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		if err != nil {
			return err
		}

		open, err := loadOpenAssignedTickets(ctx, tx, req.SpaceID, board, req.BotID, MaxOpenTicketsInContext)
		if err != nil {
			return err
		}
		resp.OpenTickets = open
		resp.AssignedContext = RenderAssignedTickets(open, maxBytes)

		refNumbers := ExtractTicketNumbers(req.PromptText, board.Prefix)
		if len(refNumbers) > 0 {
			assignedIDs := make(map[string]bool, len(open))
			for _, t := range open {
				assignedIDs[t.ID] = true
			}
			refs, err := loadReferencedTickets(ctx, tx, req.SpaceID, board, refNumbers, assignedIDs)
			if err != nil {
				return err
			}
			resp.ReferencedContext = RenderReferencedTickets(refs, maxBytes)
		}
		return nil
	})
	return resp, err
}

// Prepare loads a completed run's turn transcript and open tickets, decides
// whether the turn merits LLM task extraction, and returns the extraction prompts.
func (s *Service) Prepare(ctx context.Context, req PrepareRequest) (PrepareResponse, error) {
	if req.RunID == "" || req.SpaceID == "" || req.UserID == "" || req.BotID == "" {
		return PrepareResponse{}, errors.New("runId, spaceId, userId, and botId are required")
	}
	actor := db.Actor{SpaceID: req.SpaceID, UserID: req.UserID}
	var resp PrepareResponse

	err := s.DB.Tenant(ctx, actor, func(tx pgx.Tx) error {
		enabled, err := tickets.Enabled(ctx, tx, s.deployment(), req.UserID)
		if err != nil {
			return err
		}
		if !enabled {
			resp = PrepareResponse{Inspect: false, Reason: "board_disabled"}
			return nil
		}

		var (
			trigger         string
			status          string
			threadID        string
			sourceMessageID *string
			botName         string
			botArchivedAt   *time.Time
			threadBotID     *string
			threadGroupID   *string
		)
		err = tx.QueryRow(ctx, `
			SELECT r.trigger, r.status, r."threadId", r."sourceMessageId",
			       b.name, b."archivedAt", t."botId", t."groupId"
			FROM runs r
			JOIN bots b ON b.id = r."botId"
			JOIN threads t ON t.id = r."threadId"
			WHERE r.id = $1 AND r."spaceId" = $2 AND r."botId" = $3
		`, req.RunID, req.SpaceID, req.BotID).Scan(
			&trigger, &status, &threadID, &sourceMessageID,
			&botName, &botArchivedAt, &threadBotID, &threadGroupID,
		)
		if errors.Is(err, pgx.ErrNoRows) {
			resp = PrepareResponse{Inspect: false, Reason: "run_not_found"}
			return nil
		}
		if err != nil {
			return err
		}
		if status != "completed" {
			resp = PrepareResponse{Inspect: false, Reason: "run_not_completed"}
			return nil
		}
		if botArchivedAt != nil {
			resp = PrepareResponse{Inspect: false, Reason: "bot_archived"}
			return nil
		}
		if !TriggerEligible(trigger) {
			resp = PrepareResponse{Inspect: false, Reason: "ineligible_trigger"}
			return nil
		}
		if sourceMessageID == nil || *sourceMessageID == "" {
			resp = PrepareResponse{Inspect: false, Reason: "missing_source_message"}
			return nil
		}
		if (threadBotID == nil || *threadBotID != req.BotID) && threadGroupID == nil {
			resp = PrepareResponse{Inspect: false, Reason: "ineligible_thread"}
			return nil
		}

		userText, assistantText, usedTools, err := s.loadTurnTranscript(
			ctx, tx, req.SpaceID, threadID, req.RunID, *sourceMessageID, req.AnsweredMessageIDs,
		)
		if err != nil {
			return err
		}

		var openTickets []OpenTicket
		var board tickets.Board
		err = tx.QueryRow(ctx, `SELECT id, "ticketPrefix" FROM boards WHERE "spaceId" = $1`, req.SpaceID).
			Scan(&board.ID, &board.Prefix)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		if board.ID != "" {
			openTickets, err = loadOpenAssignedTickets(ctx, tx, req.SpaceID, board, req.BotID, MaxOpenTicketsInContext)
			if err != nil {
				return err
			}
		}

		inspect, reason := ShouldInspect(trigger, userText, assistantText, usedTools, len(openTickets))
		if !inspect {
			resp = PrepareResponse{Inspect: false, Reason: reason}
			return nil
		}

		botTouchedTickets, err := runTouchedTickets(ctx, tx, req.RunID)
		if err != nil {
			return err
		}

		var transcript strings.Builder
		if userText != "" {
			transcript.WriteString("User:\n")
			transcript.WriteString(userText)
			transcript.WriteString("\n\n")
		}
		if assistantText != "" {
			transcript.WriteString(botName)
			transcript.WriteString(":\n")
			transcript.WriteString(assistantText)
		}

		resp = PrepareResponse{
			Inspect:      true,
			SystemPrompt: ExtractionSystemPrompt(),
			UserPrompt:   BuildExtractionPrompt(botName, openTickets, transcript.String(), botTouchedTickets),
			OpenTickets:  openTickets,
		}
		return nil
	})
	return resp, err
}

// Apply parses (when rawOutput is supplied), validates, deduplicates, and writes
// detected task actions directly to the Space's Kanban board without waking bots.
func (s *Service) Apply(ctx context.Context, req ApplyRequest) (ApplyResponse, error) {
	if req.SpaceID == "" || req.UserID == "" || req.BotID == "" {
		return ApplyResponse{}, errors.New("spaceId, userId, and botId are required")
	}
	actions := SanitizeActions(req.Actions)
	if len(actions) == 0 && strings.TrimSpace(req.RawOutput) != "" {
		parsed, err := ParseModelOutput(req.RawOutput)
		if err != nil {
			if s.Logger != nil {
				s.Logger.Warn("task.detect output unparseable", "run.id", req.RunID, "error", err)
			}
			return ApplyResponse{Created: []AppliedTicket{}, Updated: []AppliedTicket{}}, nil
		}
		actions = parsed
	}
	resp := ApplyResponse{Created: []AppliedTicket{}, Updated: []AppliedTicket{}}
	if len(actions) == 0 {
		return resp, nil
	}

	actor := db.Actor{SpaceID: req.SpaceID, UserID: req.UserID}
	type boardSignal struct{ boardID, ticketID string }
	var signals []boardSignal

	err := s.DB.Tenant(ctx, actor, func(tx pgx.Tx) error {
		enabled, err := tickets.Enabled(ctx, tx, s.deployment(), req.UserID)
		if err != nil {
			return err
		}
		if !enabled {
			resp.Skipped += len(actions)
			return nil
		}
		var botExists string
		err = tx.QueryRow(ctx, `
			SELECT id FROM bots
			WHERE id = $1 AND "spaceId" = $2 AND "userId" = $3 AND "archivedAt" IS NULL
		`, req.BotID, req.SpaceID, req.UserID).Scan(&botExists)
		if errors.Is(err, pgx.ErrNoRows) {
			resp.Skipped += len(actions)
			return nil
		}
		if err != nil {
			return err
		}

		board, err := tickets.EnsureBoard(ctx, tx, req.SpaceID)
		if err != nil {
			return err
		}

		open, err := loadOpenAssignedTickets(ctx, tx, req.SpaceID, board, req.BotID, 100)
		if err != nil {
			return err
		}
		byID := make(map[string]OpenTicket, len(open))
		byRef := make(map[string]OpenTicket, len(open))
		for _, item := range open {
			byID[item.ID] = item
			byRef[strings.ToUpper(item.Ref)] = item
		}

		for _, action := range actions {
			if action.Op == "create" {
				if dup, found := FindDuplicate(action.Title, open); found {
					updated, changed, err := applyUpdateToTicket(ctx, tx, req.SpaceID, board, dup, action, s.now())
					if err != nil {
						return err
					}
					if !changed {
						resp.Skipped++
						continue
					}
					resp.Updated = append(resp.Updated, updated)
					signals = append(signals, boardSignal{boardID: board.ID, ticketID: updated.ID})
					replaceOpenTicket(open, byID, byRef, dup.ID, updated, action.Description)
					continue
				}

				created, openEntry, err := insertDetectedTicket(ctx, tx, req.SpaceID, req.UserID, req.BotID, board, action, s.now())
				if err != nil {
					return err
				}
				resp.Created = append(resp.Created, created)
				signals = append(signals, boardSignal{boardID: board.ID, ticketID: created.ID})
				if created.Status != "done" && created.Status != "closed" {
					open = append(open, openEntry)
					byID[openEntry.ID] = openEntry
					byRef[strings.ToUpper(openEntry.Ref)] = openEntry
				}
				continue
			}

			// op == "update"
			target, found := resolveTargetTicket(action, byID, byRef)
			if !found {
				resp.Skipped++
				continue
			}
			updated, changed, err := applyUpdateToTicket(ctx, tx, req.SpaceID, board, target, action, s.now())
			if err != nil {
				return err
			}
			if !changed {
				resp.Skipped++
				continue
			}
			resp.Updated = append(resp.Updated, updated)
			signals = append(signals, boardSignal{boardID: board.ID, ticketID: updated.ID})
			replaceOpenTicket(open, byID, byRef, target.ID, updated, action.Description)
		}
		return nil
	})
	if err != nil {
		return ApplyResponse{}, err
	}

	// Publish realtime Kanban notifications after commit; never wake the bot.
	if s.Signals != nil {
		for _, sig := range signals {
			s.Signals.PublishBoard(req.SpaceID, sig.boardID, sig.ticketID)
		}
	}
	return resp, nil
}

func resolveTargetTicket(action Action, byID, byRef map[string]OpenTicket) (OpenTicket, bool) {
	if action.TicketID != "" {
		if target, ok := byID[action.TicketID]; ok {
			return target, true
		}
	}
	if action.Ref != "" {
		if target, ok := byRef[strings.ToUpper(action.Ref)]; ok {
			return target, true
		}
	}
	return OpenTicket{}, false
}

func replaceOpenTicket(open []OpenTicket, byID, byRef map[string]OpenTicket, id string, updated AppliedTicket, desc *string) {
	next := OpenTicket{
		ID:       updated.ID,
		Ref:      updated.Ref,
		Title:    updated.Title,
		Status:   updated.Status,
		Priority: updated.Priority,
		Description: func() *string {
			if desc != nil {
				return desc
			}
			return byID[id].Description
		}(),
	}
	byID[id] = next
	byRef[strings.ToUpper(next.Ref)] = next
	for i := range open {
		if open[i].ID == id {
			open[i] = next
			break
		}
	}
}

func insertDetectedTicket(
	ctx context.Context,
	tx pgx.Tx,
	spaceID, userID, botID string,
	board tickets.Board,
	action Action,
	at time.Time,
) (AppliedTicket, OpenTicket, error) {
	var nextNumber int64
	err := tx.QueryRow(ctx, `
		UPDATE boards
		SET "nextNumber" = "nextNumber" + 1, "updatedAt" = $2
		WHERE id = $1
		RETURNING "nextNumber" - 1
	`, board.ID, at).Scan(&nextNumber)
	if err != nil {
		return AppliedTicket{}, OpenTicket{}, err
	}

	id := effects.NewID()
	status := action.Status
	if status == "" {
		status = "todo"
	}
	priority := action.Priority
	if priority == "" {
		priority = "normal"
	}
	var completedAt *time.Time
	if status == "done" || status == "closed" {
		completedAt = &at
	}
	var desc *string
	if action.Description != nil {
		stored := shared.StoredText(*action.Description)
		desc = &stored
	}
	title := shared.StoredText(action.Title)

	_, err = tx.Exec(ctx, `
		INSERT INTO tickets (
			id, "boardId", "spaceId", number, title, description, status, priority,
			"assigneeBotId", "createdByBotId", "createdByUserId", "createdAt", "updatedAt", "completedAt"
		) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9, $10, $11, $11, $12)
	`, id, board.ID, spaceID, nextNumber, title, desc, status, priority, botID, userID, at, completedAt)
	if err != nil {
		return AppliedTicket{}, OpenTicket{}, err
	}

	ref := fmt.Sprintf("%s-%d", board.Prefix, nextNumber)
	applied := AppliedTicket{
		ID:       id,
		Ref:      ref,
		Title:    title,
		Status:   status,
		Priority: priority,
		Op:       "create",
	}
	entry := OpenTicket{
		ID:          id,
		Ref:         ref,
		Title:       title,
		Status:      status,
		Priority:    priority,
		Description: desc,
	}
	return applied, entry, nil
}

func applyUpdateToTicket(
	ctx context.Context,
	tx pgx.Tx,
	spaceID string,
	board tickets.Board,
	target OpenTicket,
	action Action,
	at time.Time,
) (AppliedTicket, bool, error) {
	if _, err := tx.Exec(ctx, `SELECT id FROM tickets WHERE id = $1 AND "spaceId" = $2 FOR UPDATE`, target.ID, spaceID); err != nil {
		return AppliedTicket{}, false, err
	}
	var (
		currentTitle       string
		currentDescription *string
		currentStatus      string
		currentPriority    *string
		currentCompletedAt *time.Time
	)
	err := tx.QueryRow(ctx, `
		SELECT title, description, status, priority, "completedAt"
		FROM tickets
		WHERE id = $1 AND "spaceId" = $2 AND "boardId" = $3
	`, target.ID, spaceID, board.ID).Scan(
		&currentTitle, &currentDescription, &currentStatus, &currentPriority, &currentCompletedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return AppliedTicket{}, false, nil
	}
	if err != nil {
		return AppliedTicket{}, false, err
	}

	nextTitle := currentTitle
	if action.Op == "update" && action.Title != "" && action.Title != currentTitle {
		nextTitle = shared.StoredText(action.Title)
	}
	nextStatus := currentStatus
	if action.Status != "" && action.Status != currentStatus {
		nextStatus = action.Status
	}
	nextPriority := "normal"
	if currentPriority != nil && *currentPriority != "" {
		nextPriority = *currentPriority
	}
	if action.Priority != "" && action.Priority != nextPriority {
		nextPriority = action.Priority
	}
	nextDescription := currentDescription
	if action.Description != nil {
		stored := shared.StoredText(*action.Description)
		if currentDescription == nil || *currentDescription != stored {
			nextDescription = &stored
		}
	}

	descChanged := (currentDescription == nil) != (nextDescription == nil) ||
		(currentDescription != nil && nextDescription != nil && *currentDescription != *nextDescription)
	priorityChanged := currentPriority == nil || *currentPriority != nextPriority
	if nextTitle == currentTitle && nextStatus == currentStatus && !descChanged && !priorityChanged {
		return AppliedTicket{}, false, nil
	}

	completedAt := currentCompletedAt
	if nextStatus == "done" || nextStatus == "closed" {
		if completedAt == nil {
			completedAt = &at
		}
	} else {
		completedAt = nil
	}

	_, err = tx.Exec(ctx, `
		UPDATE tickets
		SET title = $2, description = $3, status = $4, priority = $5, "completedAt" = $6, "updatedAt" = $7
		WHERE id = $1
	`, target.ID, nextTitle, nextDescription, nextStatus, nextPriority, completedAt, at)
	if err != nil {
		return AppliedTicket{}, false, err
	}

	return AppliedTicket{
		ID:       target.ID,
		Ref:      target.Ref,
		Title:    nextTitle,
		Status:   nextStatus,
		Priority: nextPriority,
		Op:       "update",
	}, true, nil
}

func loadOpenAssignedTickets(
	ctx context.Context,
	tx pgx.Tx,
	spaceID string,
	board tickets.Board,
	botID string,
	limit int,
) ([]OpenTicket, error) {
	rows, err := tx.Query(ctx, `
		SELECT id, number, title, description, status, priority
		FROM tickets
		WHERE "spaceId" = $1
		  AND "boardId" = $2
		  AND "assigneeBotId" = $3
		  AND status NOT IN ('done', 'closed')
		ORDER BY "updatedAt" DESC, id DESC
		LIMIT $4
	`, spaceID, board.ID, botID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []OpenTicket{}
	for rows.Next() {
		var (
			id          string
			number      int64
			title       string
			description *string
			status      string
			priority    *string
		)
		if err := rows.Scan(&id, &number, &title, &description, &status, &priority); err != nil {
			return nil, err
		}
		prio := "normal"
		if priority != nil && validPriorities[strings.TrimSpace(*priority)] {
			prio = strings.TrimSpace(*priority)
		}
		if !validActionStatuses[status] {
			status = "todo"
		}
		out = append(out, OpenTicket{
			ID:          id,
			Ref:         fmt.Sprintf("%s-%d", board.Prefix, number),
			Title:       title,
			Status:      status,
			Priority:    prio,
			Description: description,
		})
	}
	return out, rows.Err()
}

func loadReferencedTickets(
	ctx context.Context,
	tx pgx.Tx,
	spaceID string,
	board tickets.Board,
	numbers []int64,
	skipIDs map[string]bool,
) ([]ReferencedTicketEntry, error) {
	rows, err := tx.Query(ctx, `
		SELECT t.id, t.number, t.title, t.status, COALESCE(b.name, ''),
		       COALESCE((
		           SELECT c.body FROM ticket_comments c
		           WHERE c."spaceId" = t."spaceId" AND c."ticketId" = t.id
		           ORDER BY c."createdAt" DESC, c.id DESC
		           LIMIT 1
		       ), '')
		FROM tickets t
		LEFT JOIN bots b ON b.id = t."assigneeBotId"
		WHERE t."spaceId" = $1 AND t."boardId" = $2 AND t.number = ANY($3)
	`, spaceID, board.ID, numbers)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	byNumber := make(map[int64]ReferencedTicketEntry, len(numbers))
	for rows.Next() {
		var (
			id          string
			number      int64
			title       string
			status      string
			assignee    string
			lastComment string
		)
		if err := rows.Scan(&id, &number, &title, &status, &assignee, &lastComment); err != nil {
			return nil, err
		}
		if skipIDs[id] {
			continue
		}
		byNumber[number] = ReferencedTicketEntry{
			Ref:         fmt.Sprintf("%s-%d", board.Prefix, number),
			Title:       title,
			Status:      status,
			Assignee:    strings.TrimSpace(assignee),
			LastComment: strings.TrimSpace(lastComment),
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	entries := make([]ReferencedTicketEntry, 0, len(byNumber))
	for _, n := range numbers {
		if entry, ok := byNumber[n]; ok {
			entries = append(entries, entry)
		}
	}
	return entries, nil
}

func (s *Service) loadTurnTranscript(
	ctx context.Context,
	tx pgx.Tx,
	spaceID, threadID, runID, sourceMessageID string,
	answeredMessageIDs []string,
) (userText string, assistantText string, usedTools bool, err error) {
	userIDs := make([]string, 0, 1+len(answeredMessageIDs))
	userIDs = append(userIDs, sourceMessageID)
	for _, id := range answeredMessageIDs {
		if id != "" && id != sourceMessageID {
			userIDs = append(userIDs, id)
		}
	}

	rows, err := tx.Query(ctx, `
		SELECT id, seq, role, blocks, "clientNonce"
		FROM messages
		WHERE "threadId" = $1
		  AND (id = ANY($2) OR ("runId" = $3 AND role = 'bot'))
		ORDER BY seq ASC
	`, threadID, userIDs, runID)
	if err != nil {
		return "", "", false, err
	}
	defer rows.Close()

	type msgRow struct {
		id          string
		role        string
		blocks      any
		clientNonce *string
	}
	var loaded []msgRow
	var decryptRows []map[string]any
	for rows.Next() {
		var (
			id          string
			seq         int64
			role        string
			rawBlocks   []byte
			clientNonce *string
		)
		if err := rows.Scan(&id, &seq, &role, &rawBlocks, &clientNonce); err != nil {
			return "", "", false, err
		}
		if clientNonce != nil && (strings.HasPrefix(*clientNonce, "partial:") || strings.HasPrefix(*clientNonce, "progress:")) {
			continue
		}
		var blocks any
		if len(rawBlocks) > 0 {
			if err := json.Unmarshal(rawBlocks, &blocks); err != nil {
				continue
			}
		}
		idx := len(loaded)
		loaded = append(loaded, msgRow{id: id, role: role, blocks: blocks, clientNonce: clientNonce})
		decryptRows = append(decryptRows, map[string]any{
			"id":       id,
			"threadId": threadID,
			"spaceId":  spaceID,
			"blocks":   blocks,
			"_index":   idx,
		})
	}
	if err := rows.Err(); err != nil {
		return "", "", false, err
	}

	if s.Content != nil && len(decryptRows) > 0 {
		if err := s.Content.OpenRows(ctx, "Message", decryptRows); err != nil {
			return "", "", false, err
		}
		for _, decrypted := range decryptRows {
			idx := decrypted["_index"].(int)
			loaded[idx].blocks = decrypted["blocks"]
		}
	}

	var userParts, botParts []string
	for _, item := range loaded {
		stored := messageblocks.Stored(item.blocks)
		for _, block := range stored {
			if block["kind"] == "steps" || block["kind"] == "subagent" {
				usedTools = true
			}
		}
		text := strings.TrimSpace(contentcrypto.HistoryMessageText(item.blocks))
		if text == "" {
			continue
		}
		text = TruncateUTF8(text, MaxMessageChars)
		if item.role == "bot" {
			botParts = append(botParts, text)
		} else {
			userParts = append(userParts, text)
		}
	}

	if !usedTools {
		var hasToolEvent bool
		if err := tx.QueryRow(ctx, `
			SELECT EXISTS(
				SELECT 1 FROM events
				WHERE "runId" = $1 AND type = 'agent.tool.completed'
			)
		`, runID).Scan(&hasToolEvent); err == nil && hasToolEvent {
			usedTools = true
		}
	}

	return strings.Join(userParts, "\n\n"), strings.Join(botParts, "\n\n"), usedTools, nil
}

func runTouchedTickets(ctx context.Context, tx pgx.Tx, runID string) (bool, error) {
	var touched bool
	err := tx.QueryRow(ctx, `
		SELECT EXISTS(
			SELECT 1 FROM events
			WHERE "runId" = $1
			  AND type = 'agent.tool.completed'
			  AND payload->>'name' IN ('ticket_create', 'ticket_update', 'task_sync')
		)
	`, runID).Scan(&touched)
	return touched, err
}
