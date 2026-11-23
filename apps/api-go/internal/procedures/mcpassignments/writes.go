package mcpassignments

// mcp.assignments.dismiss and mcp.assignments.replace (apps/api/src/routes/mcp.ts:496-560), plus
// the two card repaints other procedures run inside their own transaction:
// revertConnectedMcpApprovals (mcp-approval.ts:222-252) and dismissMcpServerApprovals
// (mcp-approval.ts:264-287).
//
// Dismiss resolves the server's cards in the chats a card decision names, through
// resolveMcpApprovalCards (mcp-approval.ts:165-200) with no effect: the server and the bot are
// only read, and no assignment is ever touched. Replace is one plain transaction (the shipped
// handler does not raise the isolation level): the bot's assignments become exactly the list the
// caller sent, and a removed server's connected cards in that bot's chats go back to pending.

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/contentcrypto"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/effects"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/events"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/local"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/orpc"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/messageblocks"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/shared"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/validate"
)

// pendingCard is the status a removed assignment's connected card falls back to.
const pendingCard = "pending"

// dismiss input is approveInput: z.object({ botId: Id, serverId: Id, threadId: Id.optional() })
// (integrations-rpc.ts:125-127 makes dismiss share it).
func parseDismiss(raw orpc.Input) (approveInput, *orpc.Error) { return parseApprove(raw) }

// Dismiss implements mcp.assignments.dismiss: resolve the server's cards in this decision's
// chats as dismissed, touching no assignment, and answer ok.
func Dismiss(
	ctx context.Context,
	database *db.DB,
	deployment shared.Deployment,
	actor db.Actor,
	raw orpc.Input,
) (any, *orpc.Error) {
	input, failure := parseDismiss(raw)
	if failure != nil {
		return nil, failure
	}
	// security-audit.ts audits dismiss with the caller's botId and serverId; those ids do not
	// have to exist, so a value the TypeScript redactor could rewrite has to go to TypeScript
	// (the gateway declines to proxy) rather than be recorded differently or dropped.
	if !effects.AuditedMetadataServable(input.botID) || !effects.AuditedMetadataServable(input.serverID) {
		return nil, local.ErrDecline
	}
	ring := deployment.Content
	if ring == nil {
		return nil, shared.Failure(errors.New("encryption is not configured"))
	}
	threads, err := threadsForDecision(ctx, database, ring, actor, input)
	if err != nil {
		return nil, shared.Failure(err)
	}
	var seqs []Seq
	err = shared.Serializable(ctx, database, actor, func(tx pgx.Tx) error {
		// "Not now" resolves the card only. A stale card must not delete a live connection, and
		// server removal belongs to the MCP settings surface.
		painted, err := rewriteCards(ctx, tx, ring, actor, threads,
			input.botID, input.serverID, dismissedCard, selectableFor(input.threadID != nil))
		seqs = painted.seqs
		return err
	})
	if err != nil {
		return nil, shared.Failure(err)
	}
	for _, cursor := range seqs {
		// mcp-approval.ts notifies the committed cursor without an event type.
		events.NotifyCommitted(ctx, deployment.Events, nil, nil, cursor.ThreadID, cursor.Seq, "", "")
	}
	return map[string]any{"ok": true}, nil
}

// dismissedCard is the status a dismissal paints.
const dismissedCard = "dismissed"

// Replacement is one z.object({ serverId: Id, allowAllTools: z.boolean().default(true),
// allowedTools: z.array(z.string().min(1).max(200)).max(500).default([]) }).
type Replacement struct {
	ServerID      string
	AllowAllTools bool
	AllowedTools  []string
}

// ReplaceInput is mcp.assignments.replace's input.
type ReplaceInput struct {
	BotID       string
	Assignments []Replacement
}

const (
	allowedToolsMaximum = 500
	allowedToolMinimum  = 1
	allowedToolMaximum  = 200
)

// parseReplace validates mcp.assignments.replace's input. Defaults apply where zod applies them
// (a missing key, never a null), and the issues keep zod's order: the bot, then each assignment's
// fields, then the list bounds after their items.
func parseReplace(raw orpc.Input) (ReplaceInput, *orpc.Error) {
	object, issues := validate.Decode(raw.Raw, nil)
	if issues != nil {
		return ReplaceInput{}, validate.Fail(issues)
	}
	var found []validate.Issue
	botID, problems := validate.String(validate.Path{"botId"}, object.Field("botId"), validate.StringRules{Min: 1})
	found = append(found, problems...)
	result := ReplaceInput{BotID: botID, Assignments: []Replacement{}}
	items, problems := validate.AsArray(validate.Path{"assignments"}, object.Field("assignments"))
	found = append(found, problems...)
	for index, item := range items {
		path := validate.Path{"assignments", index}
		entry, problems := validate.AsObject(item, path)
		if problems != nil {
			found = append(found, problems...)
			continue
		}
		var replacement Replacement
		replacement.ServerID, problems = validate.String(path.With("serverId"), entry.Field("serverId"), validate.StringRules{Min: 1})
		found = append(found, problems...)
		if value := entry.Field("allowAllTools"); value != validate.Undefined {
			replacement.AllowAllTools, problems = validate.Boolean(path.With("allowAllTools"), value)
			found = append(found, problems...)
		} else {
			replacement.AllowAllTools = true
		}
		replacement.AllowedTools = []string{}
		toolsPath := path.With("allowedTools")
		if value := entry.Field("allowedTools"); value != validate.Undefined {
			tools, problems := validate.AsArray(toolsPath, value)
			found = append(found, problems...)
			for toolIndex, tool := range tools {
				text, problems := validate.String(toolsPath.With(toolIndex), tool,
					validate.StringRules{Min: allowedToolMinimum, Max: allowedToolMaximum})
				found = append(found, problems...)
				if problems == nil {
					replacement.AllowedTools = append(replacement.AllowedTools, text)
				}
			}
			found = append(found, validate.ArrayBounds(toolsPath, len(tools), 0, allowedToolsMaximum)...)
		}
		result.Assignments = append(result.Assignments, replacement)
	}
	if found != nil {
		return ReplaceInput{}, validate.Fail(found)
	}
	return result, nil
}

// Replace implements mcp.assignments.replace: the bot's assignments become exactly this list.
func Replace(
	ctx context.Context,
	database *db.DB,
	deployment shared.Deployment,
	actor db.Actor,
	raw orpc.Input,
) (any, *orpc.Error) {
	input, failure := parseReplace(raw)
	if failure != nil {
		return nil, failure
	}
	ring := deployment.Content
	if ring == nil {
		return nil, shared.Failure(errors.New("encryption is not configured"))
	}
	var assignments []Assignment
	var seqs []Seq
	err := database.Tenant(ctx, actor, func(tx pgx.Tx) error {
		var botID string
		err := tx.QueryRow(ctx, `SELECT id FROM bots WHERE id = $1 AND "spaceId" = $2`,
			input.BotID, actor.SpaceID).Scan(&botID)
		if errors.Is(err, pgx.ErrNoRows) {
			return shared.NotFound
		}
		if err != nil {
			return err
		}
		serverIDs := make([]string, len(input.Assignments))
		for index, assignment := range input.Assignments {
			serverIDs[index] = assignment.ServerID
		}
		// The servers list collapses duplicate ids, so a repeated server in the input makes the
		// count differ and this is an isolation failure before any write, as in TypeScript.
		var visible int
		err = tx.QueryRow(ctx, `SELECT count(*)::int FROM mcp_servers
			WHERE id = ANY($3) AND `+serverVisible, actor.SpaceID, actor.UserID, serverIDs).Scan(&visible)
		if err != nil {
			return err
		}
		if visible != len(input.Assignments) {
			return shared.NotFound
		}
		rows, err := tx.Query(ctx, `SELECT "serverId" FROM bot_mcp_servers
			WHERE "botId" = $1 AND "spaceId" = $2 AND "userId" = $3`,
			botID, actor.SpaceID, actor.UserID)
		if err != nil {
			return err
		}
		previous := []string{}
		for rows.Next() {
			var serverID string
			if err := rows.Scan(&serverID); err != nil {
				rows.Close()
				return err
			}
			previous = append(previous, serverID)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}
		next := map[string]bool{}
		for _, assignment := range input.Assignments {
			next[assignment.ServerID] = true
		}
		removed := []string{}
		for _, serverID := range previous {
			if !next[serverID] {
				removed = append(removed, serverID)
			}
		}
		if _, err := tx.Exec(ctx, `DELETE FROM bot_mcp_servers
			WHERE "botId" = $1 AND "spaceId" = $2 AND "userId" = $3`,
			botID, actor.SpaceID, actor.UserID); err != nil {
			return err
		}
		if len(input.Assignments) > 0 {
			// createMany without skipDuplicates: one INSERT, and a repeated server would be a
			// unique violation. The count check above already refuses that list.
			at := time.Now().UTC().Truncate(time.Millisecond)
			for _, assignment := range input.Assignments {
				tools, err := json.Marshal(assignment.AllowedTools)
				if err != nil {
					return err
				}
				if _, err := tx.Exec(ctx, `INSERT INTO bot_mcp_servers
					(id, "spaceId", "userId", "botId", "serverId", "allowAllTools", "allowedTools", "createdAt", "updatedAt")
					VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $8)`,
					effects.NewID(), actor.SpaceID, actor.UserID, botID, assignment.ServerID,
					assignment.AllowAllTools, string(tools), at); err != nil {
					return err
				}
			}
		}
		for _, serverID := range removed {
			seq, err := RevertConnected(ctx, tx, ring, actor, botID, serverID)
			if err != nil {
				return err
			}
			seqs = append(seqs, seq...)
		}
		assignmentRows, err := tx.Query(ctx, `SELECT `+columns+` FROM bot_mcp_servers a
			WHERE a."botId" = $1 AND a."spaceId" = $2 AND a."userId" = $3
			ORDER BY a."createdAt" ASC`, botID, actor.SpaceID, actor.UserID)
		if err != nil {
			return err
		}
		found, err := collect(assignmentRows)
		if err != nil {
			return err
		}
		assignments = found
		return nil
	})
	if err != nil {
		return nil, shared.Failure(err)
	}
	for _, cursor := range seqs {
		// revertConnectedMcpApprovals' transaction path does not notify: the caller does, after
		// the transaction committed.
		events.NotifyCommitted(ctx, deployment.Events, nil, nil, cursor.ThreadID, cursor.Seq, "", "")
	}
	if failure := ValidateAssignments(assignments); failure != nil {
		return nil, failure
	}
	return assignments, nil
}

// RevertConnected is revertConnectedMcpApprovals with a transaction (mcp-approval.ts:222-252):
// a removed assignment must not leave its card saying the server is connected, so the bot's
// connected cards for the server go back to pending inside the caller's transaction.
func RevertConnected(
	ctx context.Context,
	tx pgx.Tx,
	ring *contentcrypto.KeyRing,
	actor db.Actor,
	botID, serverID string,
) ([]Seq, error) {
	threads, err := threadsForBot(ctx, tx, actor, botID)
	if err != nil {
		return nil, err
	}
	painted, err := rewriteCards(ctx, tx, ring, actor, threads,
		botID, serverID, pendingCard, connectedOnly)
	if err != nil {
		return nil, err
	}
	return painted.seqs, nil
}

// connectedOnly is the selectable predicate of a pending revert: only a connected card changes.
func connectedOnly(block map[string]any) bool {
	status, _ := block["status"].(string)
	return status == connectedCard
}

// CloseServerCards is dismissMcpServerApprovals with a transaction (mcp-approval.ts:264-287):
// deleting a server closes every approval card for it, including cards that were never assigned.
func CloseServerCards(
	ctx context.Context,
	tx pgx.Tx,
	ring *contentcrypto.KeyRing,
	actor db.Actor,
	serverID string,
) ([]Seq, error) {
	needle, err := json.Marshal([]map[string]any{{"kind": "mcp_approval", "serverId": serverID}})
	if err != nil {
		return nil, err
	}
	// message.findMany({ where: { thread: { spaceId }, blocks: { array_contains: [...] } } }):
	// the sealed copy keeps `kind` and `serverId` readable beside it for exactly this filter.
	rows, err := tx.Query(ctx, `SELECT m.id, m."botId", m.blocks, m."threadId", t."botId"
		FROM messages m JOIN threads t ON t.id = m."threadId"
		WHERE t."spaceId" = $1 AND m.blocks @> $2::jsonb`,
		actor.SpaceID, string(needle))
	if err != nil {
		return nil, err
	}
	type storedClose struct {
		id        string
		botID     *string
		blocks    any
		threadID  string
		threadBot *string
	}
	var messages []storedClose
	for rows.Next() {
		var message storedClose
		if err := rows.Scan(&message.id, &message.botID, &message.blocks, &message.threadID,
			&message.threadBot); err != nil {
			rows.Close()
			return nil, err
		}
		messages = append(messages, message)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	opened := make([]map[string]any, len(messages))
	for index, message := range messages {
		opened[index] = map[string]any{"id": message.id, "threadId": message.threadID,
			"blocks": message.blocks}
	}
	if len(opened) > 0 {
		if err := ring.OpenRows(ctx, "Message", opened); err != nil {
			return nil, err
		}
	}
	seqs := []Seq{}
	for index, message := range messages {
		stored, shown, changed, ok := messageblocks.Rewrite(opened[index]["blocks"],
			repaint(serverID, dismissedCard, notDismissed))
		if !ok || !changed {
			continue
		}
		if err := writeBlocks(ctx, tx, ring, message.id, message.threadID, stored); err != nil {
			return nil, err
		}
		eventBotID := ""
		if message.botID != nil {
			eventBotID = *message.botID
		} else if message.threadBot != nil {
			eventBotID = *message.threadBot
		}
		if eventBotID == "" {
			continue
		}
		event, err := events.AppendTx(ctx, tx, ring, events.Input{
			SpaceID: actor.SpaceID, ThreadID: message.threadID, BotID: eventBotID,
			Type: "thread.message.updated",
			Payload: map[string]any{
				"messageId": message.id, "role": "bot", "blocks": messageblocks.JSONValue(shown),
			},
		})
		if err != nil {
			return nil, err
		}
		seqs = append(seqs, Seq{ThreadID: message.threadID, Seq: event.Seq})
	}
	return seqs, nil
}

// notDismissed is closeServerCards' selectable predicate: a card already dismissed stays as is.
func notDismissed(block map[string]any) bool {
	status, _ := block["status"].(string)
	return status != dismissedCard
}

// ListServer is mcp.servers.agents' final read: every assignment of this server, oldest first.
// The server is already known to be the caller's, so no availability filter applies.
func ListServer(ctx context.Context, tx pgx.Tx, actor db.Actor, serverID string) ([]Assignment, error) {
	rows, err := tx.Query(ctx, `SELECT `+columns+` FROM bot_mcp_servers a
		WHERE a."spaceId" = $1 AND a."userId" = $2 AND a."serverId" = $3
		ORDER BY a."createdAt" ASC`, actor.SpaceID, actor.UserID, serverID)
	if err != nil {
		return nil, err
	}
	return collect(rows)
}
