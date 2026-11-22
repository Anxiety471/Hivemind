package bots

import (
	"context"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/orpc"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/shared"
)

// InstructionVersion is InstructionVersionSchema (packages/contracts/src/bots/bot.ts:22).
type InstructionVersion struct {
	ID           string `json:"id"`
	Instructions string `json:"instructions"`
	Reason       string `json:"reason"`
	CreatedAt    string `json:"createdAt"`
}

// IncomingCall is BotSchema's incomingCall (packages/contracts/src/bots/bot.ts:78). Its fields
// are whatever the stored call_request block holds; the output parse rejects non-strings.
type IncomingCall struct {
	CallID    any `json:"callId"`
	Reason    any `json:"reason"`
	Opening   any `json:"opening"`
	ExpiresAt any `json:"expiresAt"`
}

// Bot is BotSchema (packages/contracts/src/bots/bot.ts:31).
type Bot struct {
	ID                      string               `json:"id"`
	SpaceID                 string               `json:"spaceId"`
	Name                    string               `json:"name"`
	Title                   string               `json:"title"`
	Description             string               `json:"description"`
	Instructions            string               `json:"instructions"`
	InstructionHistory      []InstructionVersion `json:"instructionHistory"`
	Color                   string               `json:"color"`
	AvatarSet               string               `json:"avatarSet"`
	NotifyOnFinish          bool                 `json:"notifyOnFinish"`
	Pinned                  bool                 `json:"pinned"`
	SectionID               *string              `json:"sectionId"`
	ArchivedAt              *string              `json:"archivedAt"`
	Unread                  bool                 `json:"unread"`
	SnoozedUntil            *string              `json:"snoozedUntil"`
	ParentBotID             *string              `json:"parentBotId"`
	MemoryScope             *string              `json:"memoryScope"`
	ThreadID                string               `json:"threadId"`
	Preview                 string               `json:"preview"`
	Status                  string               `json:"status"`
	ThreadStatus            string               `json:"threadStatus"`
	RunErrorID              *string              `json:"runErrorId"`
	ComputerMode            string               `json:"computerMode"`
	CreatedAt               string               `json:"createdAt"`
	UpdatedAt               string               `json:"updatedAt"`
	VoiceID                 *string              `json:"voiceId"`
	AutoSpeak               bool                 `json:"autoSpeak"`
	ModelProvider           *string              `json:"modelProvider"`
	ModelID                 *string              `json:"modelId"`
	ThinkingLevel           *string              `json:"thinkingLevel"`
	TeamChatAmbientEnabled  bool                 `json:"teamChatAmbientEnabled"`
	TeamChatRules           string               `json:"teamChatRules"`
	CrossSpaceCommunication bool                 `json:"crossSpaceCommunication"`
	DailyCheckIns           bool                 `json:"dailyCheckIns"`
	FleetManagement         bool                 `json:"fleetManagement"`
	ReplyMode               string               `json:"replyMode"`
	DisabledBuiltinTools    []string             `json:"disabledBuiltinTools"`
	WebhookConfigured       bool                 `json:"webhookConfigured"`
	SpawnKey                *string              `json:"spawnKey"`
	IncomingCall            *IncomingCall        `json:"incomingCall"`
}

// activeRunStatuses is ACTIVE_RUN_STATUSES (packages/core/src/runs/run-state.ts:14).
var activeRunStatuses = []string{"queued", "leased", "running", "waiting_input", "waiting_takeover"}

// thinkingLevels is ThinkingLevelSchema (packages/contracts/src/ids.ts:27).
var thinkingLevels = map[string]bool{
	"off": true, "minimal": true, "low": true, "medium": true, "high": true, "xhigh": true, "max": true,
}

var errBotMissingThread = orpc.NotFound("Bot is missing its thread")

type threadRun struct {
	ID     string
	Status string
}

// activeRun is one row of activeRunSelection (thread-listing.ts:20).
type activeRun struct {
	ThreadID string
	Status   string
}

// ListBots implements bots.list: the Space's bots, pinned first then by position and creation
// (repos.listBots, packages/db/src/bots/bot-repository.ts:356).
func ListBots(ctx context.Context, database *db.DB, deployment shared.Deployment, actor db.Actor) (any, *orpc.Error) {
	bots, result := listBots(ctx, database, deployment, actor, false)
	if result != nil {
		return nil, result
	}
	return validatedBots(bots)
}

// ListArchivedBots implements bots.listArchived.
func ListArchivedBots(ctx context.Context, database *db.DB, deployment shared.Deployment, actor db.Actor) (any, *orpc.Error) {
	bots, result := listBots(ctx, database, deployment, actor, true)
	if result != nil {
		return nil, result
	}
	return validatedBots(bots)
}

// GetBot implements bots.get: the same list, found by id; a bot it does not hold is the
// isolation error (apps/api/src/routes/bots.ts:345).
func GetBot(ctx context.Context, database *db.DB, deployment shared.Deployment, actor db.Actor, raw orpc.Input) (any, *orpc.Error) {
	botID, failure := parseBotID(raw)
	if failure != nil {
		return nil, failure
	}
	bots, result := listBots(ctx, database, deployment, actor, false)
	if result != nil {
		return nil, result
	}
	for _, bot := range bots {
		if bot.ID == botID {
			// The router parses only the value the handler returns, so an unrelated roster row
			// that breaks BotSchema does not fail this call (routes/bots.ts:345).
			if failure := validateBot(bot); failure != nil {
				return nil, failure
			}
			return bot, nil
		}
	}
	return nil, shared.NotFound
}

type listedBotRow struct {
	ID                      string
	SpaceID                 string
	Name                    string
	Description             string
	Instructions            string
	InstructionHistory      any
	Color                   string
	AvatarSet               string
	NotifyOnFinish          bool
	Pinned                  bool
	SectionID               *string
	ArchivedAt              *time.Time
	ParentBotID             *string
	MemoryScope             *string
	CreatedAt               time.Time
	UpdatedAt               time.Time
	VoiceID                 *string
	AutoSpeak               bool
	ModelProvider           *string
	ModelID                 *string
	ThinkingLevel           *string
	TeamChatAmbientEnabled  bool
	TeamChatRules           string
	CrossSpaceCommunication bool
	DailyCheckIns           bool
	FleetManagement         bool
	ReplyMode               string
	DisabledBuiltinTools    []string
	WebhookSecretID         *string
	SpawnKey                *string
	ThreadID                *string
	ComputerScope           *string
	Unread                  *bool
	SnoozedUntil            *time.Time
}

func listBots(ctx context.Context, database *db.DB, deployment shared.Deployment, actor db.Actor, archived bool) ([]Bot, *orpc.Error) {
	bots := []Bot{}
	err := database.Tenant(ctx, actor, func(tx pgx.Tx) error {
		archivedFilter := `AND b."archivedAt" IS NULL`
		if archived {
			archivedFilter = `AND b."archivedAt" IS NOT NULL`
		}
		rows, err := tx.Query(ctx, `SELECT b.id, b."spaceId", b.name, b.description, b.instructions,
				b."instructionHistory", b.color, b."avatarSet", b."notifyOnFinish", b.pinned,
				b."sectionId", b."archivedAt", b."parentBotId", b."memoryScope", b."createdAt",
				b."updatedAt", b."voiceId", b."autoSpeak", b."modelProvider", b."modelId",
				b."thinkingLevel", b."teamChatAmbientEnabled", b."teamChatRules",
				b."crossSpaceCommunication", b."dailyCheckIns", b."fleetManagement", b."replyMode",
				b."disabledBuiltinTools", b."webhookSecretId", b."spawnKey",
				t.id, c.scope, r.unread, r."snoozedUntil"
			FROM bots b
			LEFT JOIN threads t ON t."botId" = b.id
			LEFT JOIN computers c ON c.id = b."computerId"
			LEFT JOIN thread_reads r ON r."threadId" = t.id AND r."userId" = $2
			WHERE b."spaceId" = $1 `+archivedFilter+`
			ORDER BY b.pinned DESC, b.position ASC, b."createdAt" ASC`, actor.SpaceID, actor.UserID)
		if err != nil {
			return err
		}
		loaded := []listedBotRow{}
		for rows.Next() {
			var row listedBotRow
			if err := rows.Scan(&row.ID, &row.SpaceID, &row.Name, &row.Description,
				&row.Instructions, &row.InstructionHistory, &row.Color, &row.AvatarSet,
				&row.NotifyOnFinish, &row.Pinned, &row.SectionID, &row.ArchivedAt,
				&row.ParentBotID, &row.MemoryScope, &row.CreatedAt, &row.UpdatedAt,
				&row.VoiceID, &row.AutoSpeak, &row.ModelProvider, &row.ModelID,
				&row.ThinkingLevel, &row.TeamChatAmbientEnabled, &row.TeamChatRules,
				&row.CrossSpaceCommunication, &row.DailyCheckIns, &row.FleetManagement,
				&row.ReplyMode, &row.DisabledBuiltinTools, &row.WebhookSecretID, &row.SpawnKey,
				&row.ThreadID, &row.ComputerScope, &row.Unread, &row.SnoozedUntil); err != nil {
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

		threadIDs := make([]string, 0, len(loaded))
		botIDs := make([]string, 0, len(loaded))
		for _, row := range loaded {
			botIDs = append(botIDs, row.ID)
			if row.ThreadID != nil {
				threadIDs = append(threadIDs, *row.ThreadID)
			}
		}

		// runs: activeRunSelection (thread-listing.ts:20) — status and threadId only, newest
		// first, with background ticket runs and background helpers left out
		// (statusHiddenRunTriggers, thread-listing.ts:13).
		runsByBot := map[string][]activeRun{}
		type runRow struct {
			BotID    string
			ThreadID string
			Status   string
		}
		runRows, err := tx.Query(ctx, `SELECT "botId", "threadId", status FROM runs
			WHERE "botId" = ANY($1) AND status = ANY($2) AND trigger NOT IN ('tickets', 'helper')
			ORDER BY "createdAt" DESC`, botIDs, activeRunStatuses)
		if err != nil {
			return err
		}
		for runRows.Next() {
			var row runRow
			if err := runRows.Scan(&row.BotID, &row.ThreadID, &row.Status); err != nil {
				runRows.Close()
				return err
			}
			runsByBot[row.BotID] = append(runsByBot[row.BotID], activeRun{ThreadID: row.ThreadID, Status: row.Status})
		}
		runRows.Close()
		if err := runRows.Err(); err != nil {
			return err
		}

		// withLatestBotRuns (thread-listing.ts:65): the latest user-visible run per thread,
		// skipping the triggers userVisibleBotRunTriggers names (thread-listing.ts:12).
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
				return err
			}
			for latestRows.Next() {
				var id, threadID, status string
				if err := latestRows.Scan(&id, &threadID, &status); err != nil {
					latestRows.Close()
					return err
				}
				latestRuns[threadID] = threadRun{ID: id, Status: status}
			}
			latestRows.Close()
			if err := latestRows.Err(); err != nil {
				return err
			}
		}

		previews, newestAt, err := botThreadPreviews(ctx, tx, deployment.Content, threadIDs)
		if err != nil {
			return err
		}

		calls, err := ringingCalls(ctx, tx, deployment, threadIDs)
		if err != nil {
			return err
		}

		for _, row := range loaded {
			if row.ThreadID == nil {
				return errBotMissingThread
			}
			history, failure := parseInstructionHistory(row.InstructionHistory)
			if failure != nil {
				return failure
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
			computerMode := "team"
			if row.ComputerScope != nil {
				if *row.ComputerScope != "team" && *row.ComputerScope != "dedicated" {
					// parseComputerMode throws on an unknown scope, which the router answers as
					// an opaque 500.
					return orpc.Internal()
				}
				computerMode = *row.ComputerScope
			}
			bot := Bot{
				ID:                      row.ID,
				SpaceID:                 row.SpaceID,
				Name:                    row.Name,
				Title:                   "",
				Description:             row.Description,
				Instructions:            row.Instructions,
				InstructionHistory:      history,
				Color:                   row.Color,
				AvatarSet:               resolveAvatarSet(row.AvatarSet),
				NotifyOnFinish:          row.NotifyOnFinish,
				Pinned:                  row.Pinned,
				SectionID:               row.SectionID,
				Unread:                  row.Unread != nil && *row.Unread,
				SnoozedUntil:            shared.ISOOrNil(row.SnoozedUntil),
				ParentBotID:             row.ParentBotID,
				MemoryScope:             row.MemoryScope,
				ThreadID:                *row.ThreadID,
				Preview:                 previews[*row.ThreadID],
				Status:                  active,
				ThreadStatus:            primaryRunStatus(statusesInThread),
				RunErrorID:              rosterRunErrorID(latest, active),
				ComputerMode:            computerMode,
				CreatedAt:               shared.ISO(row.CreatedAt),
				UpdatedAt:               shared.ISO(rosterUpdatedAt(newestAt[*row.ThreadID], row.UpdatedAt)),
				VoiceID:                 row.VoiceID,
				AutoSpeak:               row.AutoSpeak,
				ModelProvider:           canonicalProviderID(row.ModelProvider),
				ModelID:                 row.ModelID,
				ThinkingLevel:           row.ThinkingLevel,
				TeamChatAmbientEnabled:  row.TeamChatAmbientEnabled,
				TeamChatRules:           row.TeamChatRules,
				CrossSpaceCommunication: row.CrossSpaceCommunication,
				DailyCheckIns:           row.DailyCheckIns,
				FleetManagement:         row.FleetManagement,
				ReplyMode:               replyMode(row.ReplyMode),
				DisabledBuiltinTools:    disabledBuiltinToolSet(row.DisabledBuiltinTools),
				WebhookConfigured:       row.WebhookSecretID != nil && *row.WebhookSecretID != "",
				SpawnKey:                row.SpawnKey,
				IncomingCall:            calls[*row.ThreadID],
			}
			if row.ArchivedAt != nil {
				archivedAt := shared.ISO(*row.ArchivedAt)
				bot.ArchivedAt = &archivedAt
			}
			bots = append(bots, bot)
		}
		return nil
	})
	if err != nil {
		return nil, shared.Failure(err)
	}
	return bots, nil
}

// ringingCalls is the incoming-call query of listBots (bot-repository.ts:379): the newest
// `call:` nonce per thread inside the ring window, when calls are enabled.
func ringingCalls(ctx context.Context, tx pgx.Tx, deployment shared.Deployment, threadIDs []string) (map[string]*IncomingCall, error) {
	calls := map[string]*IncomingCall{}
	if !deployment.PhoneCallsEnabled || len(threadIDs) == 0 {
		return calls, nil
	}
	now := time.Now().UTC()
	cutoff := now.Add(-time.Duration(deployment.PhoneCallRingSeconds * float64(time.Second)))
	rows, err := tx.Query(ctx, `SELECT "threadId", id, role, blocks FROM messages
		WHERE "threadId" = ANY($1) AND "createdAt" > $2 AND role = 'bot'
			AND "clientNonce" LIKE 'call:%' AND "clientNonce" LIKE '%:request'
		ORDER BY seq DESC`, threadIDs, cutoff)
	if err != nil {
		return nil, err
	}
	type callRow struct {
		ThreadID string
		ID       string
		Role     string
		Blocks   any
	}
	loaded := []callRow{}
	seen := map[string]bool{}
	for rows.Next() {
		var row callRow
		if err := rows.Scan(&row.ThreadID, &row.ID, &row.Role, &row.Blocks); err != nil {
			rows.Close()
			return nil, err
		}
		// distinct: ["threadId"] keeps the newest message per thread.
		if seen[row.ThreadID] {
			continue
		}
		seen[row.ThreadID] = true
		loaded = append(loaded, row)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if ring := deployment.Content; ring != nil {
		open := make([]map[string]any, len(loaded))
		for index, row := range loaded {
			open[index] = map[string]any{"id": row.ID, "threadId": row.ThreadID, "blocks": row.Blocks}
		}
		if err := ring.OpenRows(ctx, "Message", open); err != nil {
			return nil, err
		}
		for index := range loaded {
			loaded[index].Blocks = open[index]["blocks"]
		}
	}
	for _, row := range loaded {
		if call := ringingCall(row.Role, row.Blocks, now); call != nil {
			calls[row.ThreadID] = call
		}
	}
	return calls, nil
}

// ringingCall is ringingCall (packages/core/src/calls/call-request.ts:37): a call_request first
// block whose call is still ringing.
func ringingCall(role string, blocks any, now time.Time) *IncomingCall {
	if role != "bot" {
		return nil
	}
	entries, ok := blocks.([]any)
	if !ok || len(entries) == 0 {
		return nil
	}
	block, ok := entries[0].(map[string]any)
	if !ok || block["kind"] != "call_request" || block["status"] != "ringing" {
		return nil
	}
	expiresAt, ok := block["expiresAt"].(string)
	if !ok {
		return nil
	}
	parsed, ok := shared.ParseDate(expiresAt)
	if !ok || !parsed.After(now) {
		return nil
	}
	return &IncomingCall{
		CallID:    block["callId"],
		Reason:    block["reason"],
		Opening:   block["opening"],
		ExpiresAt: block["expiresAt"],
	}
}

// rosterRunErrorID is rosterRunErrorId (bot-repository.ts:54): a failed latest run shows its id
// unless the bot is paused on the user.
func rosterRunErrorID(latest *threadRun, activeStatus string) *string {
	if latest == nil || latest.Status != "failed" {
		return nil
	}
	if activeStatus == "waiting_input" || activeStatus == "waiting_takeover" {
		return nil
	}
	id := latest.ID
	return &id
}

// rosterUpdatedAt is rosterUpdatedAt (bot-repository.ts:66): the chat's last movement wins over
// settings writes.
func rosterUpdatedAt(newest time.Time, botUpdatedAt time.Time) time.Time {
	if newest.IsZero() {
		return botUpdatedAt
	}
	return newest
}

// primaryRunStatus is primaryActiveRun (thread-listing.ts:30) over statuses newest first: the
// newest waiting run wins, then running, then leased.
func primaryRunStatus(statuses []string) string {
	if len(statuses) == 0 {
		return "idle"
	}
	for _, status := range statuses {
		if status == "waiting_takeover" || status == "waiting_input" {
			return status
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

// resolveAvatarSet is resolveBotAvatarSet (packages/contracts/src/bots/bot-avatar.ts:8).
func resolveAvatarSet(value string) string {
	if value == "rakazo" {
		return "rakazo"
	}
	return "organic"
}

// canonicalProviderID is canonicalPiProviderId (packages/contracts/src/models/model-provider.ts:19).
// The mapper treats an empty string as absent.
func canonicalProviderID(provider *string) *string {
	if provider == nil || *provider == "" {
		return nil
	}
	if *provider == "azure-openai-responses" {
		value := "azure"
		return &value
	}
	return provider
}

// replyMode is mapBot's coercion: only "messages" is kept.
func replyMode(value string) string {
	if value == "messages" {
		return "messages"
	}
	return "chat"
}

// disabledBuiltinToolSet is disabledBuiltinToolSet (builtin-tools.ts:100): trimmed known names,
// first occurrence first.
func disabledBuiltinToolSet(names []string) []string {
	disabled := []string{}
	seen := map[string]bool{}
	for _, raw := range names {
		name := strings.TrimSpace(raw)
		if !builtinToolNameSet[name] || seen[name] {
			continue
		}
		seen[name] = true
		disabled = append(disabled, name)
	}
	return disabled
}

// parseInstructionHistory is InstructionVersionSchema.array().parse: a stored value that does
// not fit throws out of mapBot, which the router answers as an opaque 500.
func parseInstructionHistory(value any) ([]InstructionVersion, *orpc.Error) {
	if value == nil {
		return []InstructionVersion{}, nil
	}
	entries, ok := value.([]any)
	if !ok {
		return nil, orpc.Internal()
	}
	history := make([]InstructionVersion, 0, len(entries))
	for _, entry := range entries {
		object, ok := entry.(map[string]any)
		if !ok {
			return nil, orpc.Internal()
		}
		id, ok := object["id"].(string)
		if !ok || id == "" {
			return nil, orpc.Internal()
		}
		instructions, ok := object["instructions"].(string)
		if !ok {
			return nil, orpc.Internal()
		}
		reason, ok := object["reason"].(string)
		if !ok {
			return nil, orpc.Internal()
		}
		createdAt, ok := object["createdAt"].(string)
		if !ok {
			return nil, orpc.Internal()
		}
		history = append(history, InstructionVersion{
			ID: id, Instructions: instructions, Reason: reason, CreatedAt: createdAt,
		})
	}
	return history, nil
}

// validatedBots is BotSchema.array().parse of a list result.
func validatedBots(bots []Bot) (any, *orpc.Error) {
	for _, bot := range bots {
		if failure := validateBot(bot); failure != nil {
			return nil, failure
		}
	}
	return bots, nil
}

// validateBot is BotSchema's parse of the mapped row.
func validateBot(bot Bot) *orpc.Error {
	if bot.ID == "" || bot.SpaceID == "" || bot.ThreadID == "" {
		return shared.OutputInvalid()
	}
	if bot.SectionID != nil && *bot.SectionID == "" {
		return shared.OutputInvalid()
	}
	if bot.ParentBotID != nil && *bot.ParentBotID == "" {
		return shared.OutputInvalid()
	}
	if bot.RunErrorID != nil && *bot.RunErrorID == "" {
		return shared.OutputInvalid()
	}
	if bot.AvatarSet != "organic" && bot.AvatarSet != "rakazo" {
		return shared.OutputInvalid()
	}
	if bot.MemoryScope != nil && *bot.MemoryScope != "isolated" && *bot.MemoryScope != "shared" {
		return shared.OutputInvalid()
	}
	if bot.ThinkingLevel != nil && !thinkingLevels[*bot.ThinkingLevel] {
		return shared.OutputInvalid()
	}
	if bot.ReplyMode != "chat" && bot.ReplyMode != "messages" {
		return shared.OutputInvalid()
	}
	if bot.ComputerMode != "team" && bot.ComputerMode != "dedicated" {
		return shared.OutputInvalid()
	}
	if bot.IncomingCall != nil {
		for _, value := range []any{bot.IncomingCall.CallID, bot.IncomingCall.Reason,
			bot.IncomingCall.Opening, bot.IncomingCall.ExpiresAt} {
			if _, ok := value.(string); !ok {
				return shared.OutputInvalid()
			}
		}
	}
	return nil
}
