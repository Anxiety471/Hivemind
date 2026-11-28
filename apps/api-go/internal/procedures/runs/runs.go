// Package runs ports runs.list: the activity rail's active and recent runs
// (apps/api/src/threads/runs.ts).
//
// A bot_message-triggered run's preview is read from its source message's blocks. This
// port validates the one block shape it needs and declines the request for any other
// block list, rather than reimplement MessageBlock's whole discriminated union.
package runs

import (
	"context"
	"encoding/json"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/wtf8"
	"math"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/local"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/mdtext"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/orpc"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/shared"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/validate"
)

// recentLimit is RECENT_LIMIT (runs.ts:16).
const recentLimit = 20

// maxSnippet is activityPreview's default max: the schema's 120 characters.
const maxSnippet = 120

// helperHiddenTriggers is HELPER_HIDDEN_TRIGGERS (runs.ts:18).
var helperHiddenTriggers = []string{"helper", "helper_result"}

// activityHiddenTriggers is ACTIVITY_HIDDEN_TRIGGERS (runs.ts:20).
var activityHiddenTriggers = []string{"tickets", "helper", "helper_result"}

// terminalStatuses is TERMINAL_STATUSES (runs.ts:21).
var terminalStatuses = []string{"completed", "failed", "cancelled"}

// activeRunStatuses is ACTIVE_RUN_STATUSES (packages/core/src/runs/run-state.ts:14).
var activeRunStatuses = []string{"queued", "leased", "running", "waiting_input", "waiting_takeover"}

// runStatuses is RunStatusSchema.options (packages/contracts/src/ids.ts:15).
var runStatuses = map[string]bool{
	"queued": true, "leased": true, "running": true, "waiting_input": true,
	"waiting_takeover": true, "completed": true, "failed": true, "cancelled": true,
}

// runTriggers is RUN_TRIGGERS (packages/contracts/src/runs/runs.ts:33).
var runTriggers = map[string]bool{
	"user": true, "routine": true, "resume": true, "follow_up": true, "reaction": true,
	"call_end": true, "spawn": true, "skill": true, "bot_message": true, "webhook": true,
	"messaging": true, "cloud_agent": true, "purchase": true, "media": true, "created": true,
	"tickets": true, "helper": true, "helper_result": true,
}

// intents is BotMessageIntent (packages/contracts/src/threads/message-blocks.ts:16).
var intents = map[string]bool{"request": true, "result": true, "question": true, "status": true, "fyi": true}

// agentMessageKinds is RunActivityRowSchema's agentMessage union (runs.ts:129-138): update and
// request carry fromBotName and text, unknown carries only its kind.
var agentMessageKinds = map[string]bool{"update": true, "request": true, "unknown": true}

// AgentMessage is RunActivityRowSchema's agentMessage (packages/contracts/src/runs/runs.ts:129).
type AgentMessage struct {
	FromBotName string
	Kind        string
	Text        string
}

// MarshalJSON writes the strict object the schema declares: fromBotName and text belong to
// the update/request branch only.
func (m AgentMessage) MarshalJSON() ([]byte, error) {
	if m.Kind == "unknown" {
		return []byte(`{"kind":"unknown"}`), nil
	}
	return wtf8.Marshal(struct {
		FromBotName string `json:"fromBotName"`
		Kind        string `json:"kind"`
		Text        string `json:"text"`
	}{m.FromBotName, m.Kind, m.Text})
}

// Row is RunActivityRowSchema.
type Row struct {
	RunID                string        `json:"runId"`
	BotID                string        `json:"botId"`
	BotName              string        `json:"botName"`
	GroupID              *string       `json:"groupId"`
	GroupName            *string       `json:"groupName"`
	ThreadID             string        `json:"threadId"`
	Status               string        `json:"status"`
	Trigger              string        `json:"trigger"`
	NotificationsEnabled bool          `json:"notificationsEnabled"`
	PromptSnippet        string        `json:"promptSnippet"`
	AgentMessage         *AgentMessage `json:"agentMessage"`
	UpdatedAt            string        `json:"updatedAt"`
}

// Output is RunsListOutputSchema: { runs }.
type Output struct {
	Runs []Row `json:"runs"`
}

type filterInput struct {
	filter         string
	includeTickets bool
}

func parseInput(raw orpc.Input) (filterInput, *orpc.Error) {
	object, issues := validate.Decode(raw.Raw, nil)
	if issues != nil {
		return filterInput{}, validate.Fail(issues)
	}
	var input filterInput
	var found []validate.Issue
	filter, problems := validate.Enum(validate.Path{"filter"}, object.Field("filter"), "active", "recent")
	found = append(found, problems...)
	input.filter = filter
	if tickets := object.Field("includeTickets"); tickets != validate.Undefined {
		include, problems := validate.Boolean(validate.Path{"includeTickets"}, tickets)
		found = append(found, problems...)
		input.includeTickets = include
	}
	if found != nil {
		return filterInput{}, validate.Fail(found)
	}
	return input, nil
}

// List implements runs.list.
func List(
	ctx context.Context,
	database *db.DB,
	deployment *shared.Deployment,
	actor db.Actor,
	raw orpc.Input,
) (any, *orpc.Error) {
	input, failure := parseInput(raw)
	if failure != nil {
		return nil, failure
	}
	hidden := activityHiddenTriggers
	if input.includeTickets {
		hidden = helperHiddenTriggers
	}
	rows := []Row{}
	var decline bool
	err := database.Tenant(ctx, actor, func(tx pgx.Tx) error {
		ids := []string{}
		if input.filter == "recent" {
			var err error
			ids, err = latestFinishedRunPerChat(ctx, tx, actor, hidden)
			if err != nil {
				return err
			}
			if len(ids) == 0 {
				return nil
			}
		}
		loaded, declined, err := readRuns(ctx, tx, deployment, actor, input.filter, hidden, ids)
		decline = declined
		rows = loaded
		return err
	})
	if err != nil {
		return nil, shared.Failure(err)
	}
	if decline {
		return nil, local.ErrDecline
	}
	return Output{Runs: rows}, nil
}

type runRow struct {
	ID             string
	BotID          string
	ThreadID       string
	Status         string
	Trigger        string
	BotName        string
	GroupID        *string
	GroupName      *string
	NotifyOnFinish bool
	UpdatedAt      time.Time
	CompletedAt    *time.Time
	Prompt         *string
	MessageID      *string
	Blocks         any
}

// readRuns loads the activity rows and maps them. `declined` reports a request the
// TypeScript answer cannot be reproduced for (a bot_message source with blocks this port
// does not validate block by block).
func readRuns(
	ctx context.Context,
	tx pgx.Tx,
	deployment *shared.Deployment,
	actor db.Actor,
	filter string,
	hidden []string,
	ids []string,
) ([]Row, bool, error) {
	query := `SELECT r.id, r."botId", r."threadId", r.status, r.trigger, b.name,
			t."groupId", g.name, b."notifyOnFinish", r."updatedAt", r."completedAt",
			task.prompt, sm.id, sm.blocks
		FROM runs r
		JOIN bots b ON b.id = r."botId" AND b."archivedAt" IS NULL
		JOIN threads t ON t.id = r."threadId"
		LEFT JOIN chat_groups g ON g.id = t."groupId"
		LEFT JOIN tasks task ON task.id = r."taskId"
		LEFT JOIN messages sm ON sm.id = r."sourceMessageId"
		WHERE r."spaceId" = $1
			AND r.trigger <> ALL($2)
			AND r.status = ANY($3)`
	args := []any{actor.SpaceID, hidden, activeRunStatuses}
	if filter == "recent" {
		query = `SELECT r.id, r."botId", r."threadId", r.status, r.trigger, b.name,
				t."groupId", g.name, b."notifyOnFinish", r."updatedAt", r."completedAt",
				task.prompt, sm.id, sm.blocks
			FROM runs r
			JOIN bots b ON b.id = r."botId" AND b."archivedAt" IS NULL
			JOIN threads t ON t.id = r."threadId"
			LEFT JOIN chat_groups g ON g.id = t."groupId"
			LEFT JOIN tasks task ON task.id = r."taskId"
			LEFT JOIN messages sm ON sm.id = r."sourceMessageId"
			WHERE r."spaceId" = $1 AND r.id = ANY($2)
			ORDER BY r."completedAt" DESC, r."updatedAt" DESC, r.id DESC`
		args = []any{actor.SpaceID, ids}
	} else {
		query += ` ORDER BY r."updatedAt" DESC, r.id DESC`
	}
	rows, err := tx.Query(ctx, query, args...)
	if err != nil {
		return nil, false, err
	}
	loaded := []runRow{}
	for rows.Next() {
		var row runRow
		if err := rows.Scan(&row.ID, &row.BotID, &row.ThreadID, &row.Status, &row.Trigger,
			&row.BotName, &row.GroupID, &row.GroupName, &row.NotifyOnFinish, &row.UpdatedAt,
			&row.CompletedAt, &row.Prompt, &row.MessageID, &row.Blocks); err != nil {
			rows.Close()
			return nil, false, err
		}
		loaded = append(loaded, row)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, false, err
	}
	if len(loaded) == 0 {
		return []Row{}, false, nil
	}

	// The Prisma client opens every Message it reads; a source message is no exception.
	toOpen := []map[string]any{}
	for _, row := range loaded {
		if row.MessageID != nil {
			toOpen = append(toOpen, map[string]any{
				"id": *row.MessageID, "threadId": row.ThreadID, "blocks": row.Blocks,
			})
		}
	}
	if ring := deployment.Content; ring != nil && len(toOpen) > 0 {
		if err := ring.OpenRows(ctx, "Message", toOpen); err != nil {
			return nil, false, err
		}
		for index, row := range loaded {
			if row.MessageID == nil {
				continue
			}
			for _, opened := range toOpen {
				if opened["id"] == *row.MessageID {
					loaded[index].Blocks = opened["blocks"]
					break
				}
			}
		}
	}

	result := make([]Row, 0, len(loaded))
	for _, row := range loaded {
		if row.Prompt == nil {
			// TypeScript reads row.task.prompt through a required relation; a run without
			// its task fails the request.
			return nil, false, orpc.Internal()
		}
		snippet, message, declined := activityPreview(row.Trigger, *row.Prompt, row.Blocks)
		if declined {
			return nil, true, nil
		}
		updatedAt := row.UpdatedAt
		if filter == "recent" && row.CompletedAt != nil {
			updatedAt = *row.CompletedAt
		}
		entry := Row{
			RunID:                row.ID,
			BotID:                row.BotID,
			BotName:              row.BotName,
			GroupID:              row.GroupID,
			GroupName:            row.GroupName,
			ThreadID:             row.ThreadID,
			Status:               row.Status,
			Trigger:              row.Trigger,
			NotificationsEnabled: row.GroupID != nil || row.NotifyOnFinish,
			PromptSnippet:        snippet,
			AgentMessage:         message,
			UpdatedAt:            shared.ISO(updatedAt),
		}
		if failure := validateRow(entry); failure != nil {
			return nil, false, failure
		}
		result = append(result, entry)
	}
	return result, false, nil
}

// activityPreview is activityPreview (runs.ts:30).
func activityPreview(trigger, prompt string, blocks any) (string, *AgentMessage, bool) {
	if trigger != "bot_message" {
		return promptSnippet(prompt, maxSnippet), nil, false
	}
	rows, isArray := blocks.([]any)
	if !isArray || len(rows) == 0 {
		// MessageBlock.array() fails (null/undefined) or succeeds with no blocks: either way
		// botMessageContext finds nothing.
		return "Message from another agent", &AgentMessage{Kind: "unknown"}, false
	}
	if len(rows) != 1 {
		return "", nil, true
	}
	block, ok := rows[0].(map[string]any)
	if !ok || block["kind"] != "bot_message_received" {
		return "", nil, true
	}
	fromBotName, text, intent, valid := botMessageReceived(block)
	if !valid {
		return "Message from another agent", &AgentMessage{Kind: "unknown"}, false
	}
	name := shared.DisplayName(&fromBotName, "Another agent")
	kind := "request"
	if intent == "result" || intent == "status" || intent == "fyi" {
		kind = "update"
	}
	label := name + " asked"
	if kind == "update" {
		label = "Update from " + name
	}
	message := text
	if validate.JSTrim(message) != "" {
		message = label + ": " + text
	} else {
		message = label
	}
	return promptSnippet(message, maxSnippet), &AgentMessage{
		FromBotName: shared.DisplayName(&fromBotName, ""),
		Kind:        kind,
		Text:        promptSnippet(text, maxSnippet),
	}, false
}

// botMessageReceived validates the one block activityPreview reads: Id is z.string().min(1),
// text a string, and the optional intent a BotMessageIntent. Unknown keys are stripped by
// the schema, so extras are fine.
func botMessageReceived(block map[string]any) (fromBotName, text, intent string, valid bool) {
	fromID, ok := block["fromBotId"].(string)
	if !ok || fromID == "" {
		return "", "", "", false
	}
	fromBotName, ok = block["fromBotName"].(string)
	if !ok {
		return "", "", "", false
	}
	text, ok = block["text"].(string)
	if !ok {
		return "", "", "", false
	}
	if raw, present := block["intent"]; present {
		value, ok := raw.(string)
		if !ok || !intents[value] {
			return "", "", "", false
		}
		intent = value
	}
	if raw, present := block["returnToMessageId"]; present {
		value, ok := raw.(string)
		if !ok || value == "" {
			return "", "", "", false
		}
	}
	if raw, present := block["hop"]; present {
		// Sealed blocks decode with json.Number; a legacy plaintext jsonb value comes back
		// as float64. Both must be a non-negative whole number, as z.number().int() accepts.
		switch number := raw.(type) {
		case json.Number:
			value, err := strconv.ParseInt(string(number), 10, 64)
			if err != nil || value < 0 {
				return "", "", "", false
			}
		case float64:
			if math.IsNaN(number) || math.IsInf(number, 0) || number < 0 || math.Trunc(number) != number {
				return "", "", "", false
			}
		default:
			return "", "", "", false
		}
	}
	return fromBotName, text, intent, true
}

// promptSnippet is promptSnippet (runs.ts:23): one line, at most `max` UTF-16 units.
func promptSnippet(prompt string, max int) string {
	oneLine := collapseWhitespace(prompt)
	units := mdtext.Units(oneLine)
	if len(units) <= max {
		return oneLine
	}
	return mdtext.String(mdtext.TruncatePlainTextUnits(units, max-1)) + "…"
}

// collapseWhitespace is prompt.replace(/\s+/g, " ").trim().
func collapseWhitespace(text string) string {
	var out strings.Builder
	pendingSpace := false
	for _, r := range text {
		if validate.IsJSSpace(r) {
			pendingSpace = out.Len() > 0
			continue
		}
		if pendingSpace {
			out.WriteByte(' ')
			pendingSpace = false
		}
		out.WriteRune(r)
	}
	return out.String()
}

// latestFinishedRunPerChat is latestFinishedRunPerChat (runs.ts:141): one finished,
// non-ticket run per chat, newest first, bounded in SQL.
func latestFinishedRunPerChat(ctx context.Context, tx pgx.Tx, actor db.Actor, hidden []string) ([]string, error) {
	rows, err := tx.Query(ctx, `SELECT id FROM (
			SELECT DISTINCT ON (COALESCE('group:' || t."groupId", 'bot:' || r."botId"))
				r.id, r."completedAt", r."updatedAt"
			FROM runs r
			JOIN threads t ON t.id = r."threadId"
			JOIN bots b ON b.id = r."botId"
			WHERE r."spaceId" = $1 AND b."archivedAt" IS NULL
				AND r.trigger <> ALL($2) AND r.status = ANY($3)
			ORDER BY COALESCE('group:' || t."groupId", 'bot:' || r."botId"),
				r."completedAt" DESC, r."updatedAt" DESC, r.id DESC
		) latest
		ORDER BY "completedAt" DESC, "updatedAt" DESC, id DESC
		LIMIT $4`, actor.SpaceID, hidden, terminalStatuses, recentLimit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	ids := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

// validateRow is the router's parse of RunActivityRowSchema.
func validateRow(row Row) *orpc.Error {
	if row.RunID == "" || row.BotID == "" || row.ThreadID == "" {
		return shared.OutputInvalid()
	}
	if row.GroupID != nil && *row.GroupID == "" {
		return shared.OutputInvalid()
	}
	if !runStatuses[row.Status] || !runTriggers[row.Trigger] {
		return shared.OutputInvalid()
	}
	if row.AgentMessage != nil {
		if !agentMessageKinds[row.AgentMessage.Kind] {
			return shared.OutputInvalid()
		}
		if row.AgentMessage.Kind != "unknown" && len(mdtext.Units(row.AgentMessage.Text)) > maxSnippet {
			return shared.OutputInvalid()
		}
	}
	return nil
}
