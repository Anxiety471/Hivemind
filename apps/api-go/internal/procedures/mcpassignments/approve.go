package mcpassignments

// mcp.assignments.approve (apps/api/src/routes/mcp.ts:437-497): the user accepts a server from its
// chat card (or from the MCP settings surface, which passes no threadId). The approval cards for
// that server are painted connected, the bot gets the assignment, and a decision made in a chat
// queues the hidden turn that lets the bot carry on with the server's tools.
//
// The card resolution is resolveMcpApprovalCards (mcp-approval.ts:165-200): the thread list is
// read first, then one serializable transaction repaints the cards, appends a
// thread.message.updated event per message it changed, and runs the assignment effect. The event
// cursors are notified only after that transaction committed, and the queued run is woken after
// it as well.

import (
	"context"
	"errors"
	"log/slog"
	"slices"
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
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/runs"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/validate"
)

// approvalMessages is the newest messages of a chat rewriteCards looks at
// (mcp-approval.ts:126: orderBy createdAt desc, take 100).
const approvalMessages = 100

// connectedCard is the status an approval paints on every card it closes.
const connectedCard = "connected"

// backgroundTriggers is BACKGROUND_RUN_TRIGGERS (packages/core/src/runs/run-state.ts:44).
var backgroundTriggers = []string{"tickets"}

// serverVisible is availableInSpace (packages/db/src/spaces/availability.ts:7-16) for a query on
// mcp_servers itself: $1 is the actor's Space and $2 the actor. A server is visible when the
// member added it in this Space, made it available in every Space, or shared it with this one.
const serverVisible = `"userId" = $2 AND ("spaceId" = $1 OR "allSpaces" = true
	OR EXISTS (SELECT 1 FROM mcp_server_spaces x WHERE x."serverId" = mcp_servers.id AND x."spaceId" = $1))`

// approveInput is z.object({ botId: Id, serverId: Id, threadId: Id.optional() })
// (packages/contracts/src/integrations/integrations-rpc.ts:125-127).
type approveInput struct {
	botID    string
	serverID string
	// threadID is the chat whose card the user answered; nil is the settings surface.
	threadID *string
}

func parseApprove(raw orpc.Input) (approveInput, *orpc.Error) {
	object, issues := validate.Decode(raw.Raw, nil)
	if issues != nil {
		return approveInput{}, validate.Fail(issues)
	}
	var found []validate.Issue
	botID, problems := validate.String(validate.Path{"botId"}, object.Field("botId"), validate.StringRules{Min: 1})
	found = append(found, problems...)
	serverID, problems := validate.String(validate.Path{"serverId"}, object.Field("serverId"), validate.StringRules{Min: 1})
	found = append(found, problems...)
	var threadID *string
	if value := object.Field("threadId"); value != validate.Undefined {
		text, problems := validate.String(validate.Path{"threadId"}, value, validate.StringRules{Min: 1})
		found = append(found, problems...)
		threadID = &text
	}
	if found != nil {
		return approveInput{}, validate.Fail(found)
	}
	return approveInput{botID: botID, serverID: serverID, threadID: threadID}, nil
}

// approvalThread is one chat resolveMcpApprovalCards rewrites: its id and, on a bot's own chat,
// that bot's id (a group chat names none).
type approvalThread struct {
	id    string
	botID *string
}

// Seq is one committed thread.message.updated cursor.
type Seq struct {
	ThreadID string
	Seq      int32
}

// cardDecision is McpApprovalDecision (mcp-approval.ts:26-32): whether this decision may create
// the assignment, and whether it closed an open card rather than repeating a decision.
type cardDecision struct {
	assign   bool
	resolved bool
}

// painted is rewriteCards' answer: the cursors to notify, how many cards this call closed, and
// whether it saw a card already connected or dismissed.
type painted struct {
	seqs      []Seq
	flipped   int
	dismissed bool
	connected bool
}

// Approve implements mcp.assignments.approve: resolve this server's approval cards and return the
// bot's assignment DTO.
func Approve(ctx context.Context, database *db.DB, deployment shared.Deployment, publisher runs.Publisher, actor db.Actor, raw orpc.Input) (any, *orpc.Error) {
	input, failure := parseApprove(raw)
	if failure != nil {
		return nil, failure
	}
	// The security event carries both ids; see Dismiss.
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
	var assignment *Assignment
	var runID string
	var seqs []Seq
	err = shared.Serializable(ctx, database, actor, func(tx pgx.Tx) error {
		resolution, err := rewriteCards(ctx, tx, ring, actor, threads,
			input.botID, input.serverID, connectedCard, selectableFor(input.threadID != nil))
		if err != nil {
			return err
		}
		seqs = resolution.seqs
		decision := decide(input.threadID != nil, resolution)
		if !decision.assign {
			// A dismissal already won this card: the approve must not assign.
			return shared.NotFound
		}
		row, created, err := connect(ctx, tx, actor, input, decision)
		if err != nil {
			return err
		}
		assignment = &row
		runID = created
		return nil
	})
	if err != nil {
		return nil, shared.Failure(err)
	}
	if assignment == nil {
		return nil, shared.NotFound
	}
	// The cursors are announced only once their events committed, as deps.events.notify is.
	// That notify names no event type (mcp-approval.ts:217), so neither does this one.
	for _, event := range seqs {
		events.NotifyCommitted(ctx, deployment.Events, nil, nil, event.ThreadID, event.Seq, "", "")
	}
	if runID != "" {
		// wakeRun logs a failed nudge and drops it: the run row is durable and recovery starts it.
		runs.TryWakeFor(ctx, database, actor, publisher, slog.Default(), runID, runs.WakeOptions{})
	}
	// The router validates the handler's answer after the transaction committed, so a broken
	// stored row is a 500 that leaves the writes in place.
	if failure := ValidateAssignments([]Assignment{*assignment}); failure != nil {
		return nil, failure
	}
	return *assignment, nil
}

// threadsForDecision is threadsForDecision (mcp-approval.ts:40-86): the chats whose cards this
// decision may resolve. Threads are shared by the Space, but a card is about one member's own
// server, so only a server visible to the actor resolves anything at all.
func threadsForDecision(ctx context.Context, database *db.DB, ring *contentcrypto.KeyRing, actor db.Actor, input approveInput) ([]approvalThread, error) {
	var threads []approvalThread
	err := database.Tenant(ctx, actor, func(tx pgx.Tx) error {
		var serverID string
		err := tx.QueryRow(ctx, `SELECT id FROM mcp_servers WHERE id = $3 AND `+serverVisible,
			actor.SpaceID, actor.UserID, input.serverID).Scan(&serverID)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		if err != nil {
			return err
		}
		if input.threadID == nil {
			threads, err = threadsForBot(ctx, tx, actor, input.botID)
			return err
		}
		threads, err = threadsForThread(ctx, tx, ring, actor, input)
		return err
	})
	return threads, err
}

// threadsForBot is threadsForBot (mcp-approval.ts:93-104): the bot's own chat and every group it
// has written in.
func threadsForBot(ctx context.Context, tx pgx.Tx, actor db.Actor, botID string) ([]approvalThread, error) {
	rows, err := tx.Query(ctx, `SELECT id, "botId" FROM threads WHERE "spaceId" = $1
		AND ("botId" = $2 OR ("groupId" IS NOT NULL AND EXISTS (
			SELECT 1 FROM messages m WHERE m."threadId" = threads.id AND m."botId" = $2)))`,
		actor.SpaceID, botID)
	if err != nil {
		return nil, err
	}
	return collectThreads(rows)
}

// threadsForThread is the threadId half of threadsForDecision (mcp-approval.ts:54-85). A bot
// removed from a group leaves its card behind: the card still resolves in that group, but the bot
// has to belong to this Space first, and the fallback never opens another bot's direct chat.
func threadsForThread(ctx context.Context, tx pgx.Tx, ring *contentcrypto.KeyRing, actor db.Actor, input approveInput) ([]approvalThread, error) {
	rows, err := tx.Query(ctx, `SELECT id, "botId" FROM threads WHERE id = $3 AND "spaceId" = $1
		AND ("botId" = $2 OR EXISTS (SELECT 1 FROM chat_group_members m
			WHERE m."groupId" = threads."groupId" AND m."botId" = $2))`,
		actor.SpaceID, input.botID, *input.threadID)
	if err != nil {
		return nil, err
	}
	found, err := collectThreads(rows)
	if err != nil || len(found) > 0 {
		return found, err
	}
	if err := requireBotThread(ctx, tx, ring, actor, input.botID); err != nil {
		if errors.Is(err, shared.NotFound) {
			return nil, nil
		}
		return nil, err
	}
	rows, err = tx.Query(ctx, `SELECT id, "botId" FROM threads
		WHERE id = $2 AND "spaceId" = $1 AND "groupId" IS NOT NULL`,
		actor.SpaceID, *input.threadID)
	if err != nil {
		return nil, err
	}
	return collectThreads(rows)
}

func collectThreads(rows pgx.Rows) ([]approvalThread, error) {
	defer rows.Close()
	found := []approvalThread{}
	for rows.Next() {
		var thread approvalThread
		if err := rows.Scan(&thread.id, &thread.botID); err != nil {
			return nil, err
		}
		found = append(found, thread)
	}
	return found, rows.Err()
}

// requireBotThread is requireBotThread (apps/api/src/bots/bot-thread.ts:11-20): the bot of the
// actor's Space and its thread. The thread is read with its encrypted compaction summary opened,
// because the Prisma read TypeScript runs there opens it; an unreadable one fails the call.
func requireBotThread(ctx context.Context, tx pgx.Tx, ring *contentcrypto.KeyRing, actor db.Actor, botID string) error {
	var threadID, spaceID, userID *string
	var summary *string
	err := tx.QueryRow(ctx, `SELECT t.id, t."spaceId", t."userId", t."historyCompactionSummary"
		FROM bots b JOIN threads t ON t."botId" = b.id WHERE b.id = $1 AND b."spaceId" = $2`,
		botID, actor.SpaceID).Scan(&threadID, &spaceID, &userID, &summary)
	if errors.Is(err, pgx.ErrNoRows) {
		return shared.NotFound
	}
	if err != nil {
		return err
	}
	if threadID == nil || spaceID == nil || userID == nil {
		return shared.NotFound
	}
	var stored any
	if summary != nil {
		stored = *summary
	}
	return ring.OpenRows(ctx, "Thread", []map[string]any{{
		"id": *threadID, "spaceId": *spaceID, "userId": *userID, "historyCompactionSummary": stored,
	}})
}

// rewriteCards is rewriteCards (mcp-approval.ts:107-160): every message in these chats that holds
// an approval card for the server has the selectable cards painted connected, its row sealed
// again, and a thread.message.updated appended in the same transaction.
func rewriteCards(ctx context.Context, tx pgx.Tx, ring *contentcrypto.KeyRing, actor db.Actor,
	threads []approvalThread, botID, serverID, status string, selectable func(map[string]any) bool) (painted, error) {
	var result painted
	for _, thread := range threads {
		// tx.message.findMany({ where: { threadId }, orderBy: { createdAt: "desc" }, take: 100 })
		rows, err := tx.Query(ctx, `SELECT id, "botId", blocks FROM messages WHERE "threadId" = $1
			ORDER BY "createdAt" DESC LIMIT $2`, thread.id, approvalMessages)
		if err != nil {
			return result, err
		}
		type storedMessage struct {
			id     string
			botID  *string
			blocks any
		}
		var messages []storedMessage
		for rows.Next() {
			var message storedMessage
			if err := rows.Scan(&message.id, &message.botID, &message.blocks); err != nil {
				rows.Close()
				return result, err
			}
			messages = append(messages, message)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return result, err
		}
		opened := make([]map[string]any, len(messages))
		for index, message := range messages {
			opened[index] = map[string]any{"id": message.id, "threadId": thread.id, "blocks": message.blocks}
		}
		if len(opened) > 0 {
			if err := ring.OpenRows(ctx, "Message", opened); err != nil {
				return result, err
			}
		}
		for index, message := range messages {
			// A card is only ever the bot's, but a user message may still hold one; the bot's own
			// and the user's messages are both read, another bot's are not.
			if message.botID != nil && *message.botID != "" && *message.botID != botID {
				continue
			}
			// changeMessageBlocks writes the row's own list back, so entries a read drops survive:
			// the selection reads the blocks, the rewrite keeps the list.
			raw := opened[index]["blocks"]
			cards := readCards(messageblocks.Stored(raw), serverID, selectable)
			if !cards.present {
				continue
			}
			result.dismissed = result.dismissed || cards.dismissed
			result.connected = result.connected || cards.connected
			if !cards.selectable {
				continue
			}
			stored, shown, changed, ok := messageblocks.Rewrite(raw, repaint(serverID, status, selectable))
			if !ok || !changed {
				continue
			}
			if err := messageblocks.Write(ctx, tx, ring, message.id, thread.id, stored); err != nil {
				return result, err
			}
			result.flipped++
			eventBotID := botID
			if message.botID != nil {
				eventBotID = *message.botID
			} else if thread.botID != nil {
				eventBotID = *thread.botID
			}
			event, err := events.AppendTx(ctx, tx, ring, events.Input{
				SpaceID: actor.SpaceID, ThreadID: thread.id, BotID: eventBotID,
				Type: "thread.message.updated",
				Payload: map[string]any{
					"messageId": message.id, "role": "bot", "blocks": messageblocks.JSONValue(shown),
				},
			})
			if err != nil {
				return result, err
			}
			result.seqs = append(result.seqs, Seq{ThreadID: thread.id, Seq: event.Seq})
		}
	}
	return result, nil
}

// cardState is what one message's blocks say about one server's approval cards.
type cardState struct {
	present    bool
	connected  bool
	dismissed  bool
	selectable bool
}

// readCards is the matching half of rewriteCards over one message's stored blocks. The connected
// and dismissed flags cover every card found, selectable covers only the cards this decision may
// repaint.
func readCards(blocks []map[string]any, serverID string, selectable func(map[string]any) bool) cardState {
	var cards cardState
	for _, block := range blocks {
		if !approvalServer(block, serverID) {
			continue
		}
		cards.present = true
		switch status, _ := block["status"].(string); status {
		case "dismissed":
			cards.dismissed = true
		case "connected":
			cards.connected = true
		}
		if selectable(block) {
			cards.selectable = true
		}
	}
	return cards
}

// approvalServer is isApproval (mcp-approval.ts:34-36).
func approvalServer(block map[string]any, serverID string) bool {
	kind, _ := block["kind"].(string)
	server, _ := block["serverId"].(string)
	return kind == "mcp_approval" && server == serverID
}

// openApproval is isOpen (mcp-approval.ts:38-40): a card still waiting for its decision. A stored
// card without a status reads as pending, as the schema's default does.
func openApproval(block map[string]any) bool {
	status, _ := block["status"].(string)
	return status != "connected" && status != "dismissed"
}

// selectableFor is the selectable predicate of resolveMcpApprovalCards: settings approval (no
// threadId) repaints every card that is not already connected, including a dismissed one; a card
// decision repaints only a card still open.
func selectableFor(threadScoped bool) func(map[string]any) bool {
	if threadScoped {
		return openApproval
	}
	return func(block map[string]any) bool {
		status, _ := block["status"].(string)
		return status != "connected"
	}
}

// repaint is rewriteCards' change function: the selectable cards for this server become status in
// a copy of the block, and every other block is returned as it was.
func repaint(serverID, status string, selectable func(map[string]any) bool) func(map[string]any) (map[string]any, bool) {
	return func(block map[string]any) (map[string]any, bool) {
		if !approvalServer(block, serverID) || !selectable(block) {
			return block, false
		}
		next := make(map[string]any, len(block)+1)
		for key, value := range block {
			next[key] = value
		}
		next["status"] = status
		return next, true
	}
}

// decide is resolveMcpApprovalCards' decision: a card decision sees assign false when a dismissal
// already won the race, and resolved is true only when this call closed an open card.
func decide(threadScoped bool, resolution painted) cardDecision {
	dismissalWon := threadScoped && resolution.flipped == 0 && !resolution.connected && resolution.dismissed
	return cardDecision{assign: !dismissalWon, resolved: resolution.flipped > 0}
}

// connect is the approve effect: the bot and an enabled server visible to the member must exist,
// the assignment is created when absent, and a card decision that resolved a card queues the
// bot's connected run in that chat.
func connect(ctx context.Context, tx pgx.Tx, actor db.Actor, input approveInput, decision cardDecision) (Assignment, string, error) {
	var botID string
	err := tx.QueryRow(ctx, `SELECT id FROM bots WHERE id = $2 AND "spaceId" = $1`,
		actor.SpaceID, input.botID).Scan(&botID)
	if errors.Is(err, pgx.ErrNoRows) {
		return Assignment{}, "", shared.NotFound
	}
	if err != nil {
		return Assignment{}, "", err
	}
	var serverID string
	err = tx.QueryRow(ctx, `SELECT id FROM mcp_servers WHERE id = $3 AND `+serverVisible+` AND enabled = true`,
		actor.SpaceID, actor.UserID, input.serverID).Scan(&serverID)
	if errors.Is(err, pgx.ErrNoRows) {
		return Assignment{}, "", shared.NotFound
	}
	if err != nil {
		return Assignment{}, "", err
	}
	// botMcpServer.upsert({ where: { botId_serverId }, create, update: {} }): an existing row is
	// left as it is, so the conflict writes nothing and the row is read below.
	at := time.Now().UTC().Truncate(time.Millisecond)
	if _, err := tx.Exec(ctx, `INSERT INTO bot_mcp_servers
		(id, "spaceId", "userId", "botId", "serverId", "allowAllTools", "allowedTools", "createdAt", "updatedAt")
		VALUES ($1, $2, $3, $4, $5, true, '[]'::jsonb, $6, $6)
		ON CONFLICT ("botId", "serverId") DO NOTHING`,
		db.Data(effects.NewID(), actor.SpaceID, actor.UserID, botID, serverID, at)...); err != nil {
		return Assignment{}, "", err
	}
	// writeaudit:dynamic read: the column list is the fixed local const; args are filters
	rows, err := tx.Query(ctx, `SELECT `+columns+` FROM bot_mcp_servers a
		WHERE a."botId" = $1 AND a."serverId" = $2`, botID, serverID)
	if err != nil {
		return Assignment{}, "", err
	}
	found, err := collect(rows)
	if err != nil {
		return Assignment{}, "", err
	}
	if len(found) != 1 {
		return Assignment{}, "", errors.New("assignment missing after upsert")
	}
	runID := ""
	if input.threadID != nil && decision.resolved {
		runID, err = queueMcpConnectedRun(ctx, tx, actor, queueInput{
			botID: botID, serverID: serverID, threadID: *input.threadID,
		})
		if err != nil {
			return Assignment{}, "", err
		}
	}
	return found[0], runID, nil
}

// queueInput is queueMcpConnectedRun's input.
type queueInput struct {
	botID    string
	serverID string
	threadID string
}

// queueThread is one chat as queueMcpConnectedRun reads it: the bot of a direct chat, and a group
// with its archivedAt and whether the bot is still a member.
type queueThread struct {
	BotID   *string
	GroupID *string
	live    bool
	member  bool
}

// queueMcpConnectedRun is queueMcpConnectedRun (mcp-approval.ts:284-330): approving a card in a
// chat is the user's turn, so a hidden-prompt run lets the bot carry on with the server's tools.
// It is skipped while the bot is busy in that chat, no longer in it, or archived along with the
// chat. It returns the run to wake after the creating transaction commits.
func queueMcpConnectedRun(ctx context.Context, tx pgx.Tx, actor db.Actor, input queueInput) (string, error) {
	thread, found, err := loadQueueThread(ctx, tx, actor, input)
	if err != nil || !found || !inThreadScope(thread, input.botID) {
		return "", err
	}
	var archivedAt *time.Time
	err = tx.QueryRow(ctx, `SELECT "archivedAt" FROM bots WHERE id = $1 AND "spaceId" = $2`,
		input.botID, actor.SpaceID).Scan(&archivedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	if !botLive(archivedAt) {
		return "", nil
	}
	busy, err := chatBusy(ctx, tx, input)
	if err != nil || busy {
		return "", err
	}
	var name string
	err = tx.QueryRow(ctx, `SELECT name FROM mcp_servers WHERE id = $3 AND `+serverVisible,
		actor.SpaceID, actor.UserID, input.serverID).Scan(&name)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	created, err := runs.Create(ctx, tx, runs.CreateInput{
		SpaceID: actor.SpaceID, BotID: input.botID, ThreadID: input.threadID, UserID: actor.UserID,
		Prompt: mcpConnectedPrompt(name), Trigger: "user",
	})
	if err != nil {
		return "", err
	}
	return created.RunID, nil
}

// loadQueueThread reads one chat of the Space. A group's liveness and the bot's membership are
// read beside it, because the queue predicate needs both.
func loadQueueThread(ctx context.Context, tx pgx.Tx, actor db.Actor, input queueInput) (queueThread, bool, error) {
	var thread queueThread
	err := tx.QueryRow(ctx, `SELECT "botId", "groupId" FROM threads WHERE id = $1 AND "spaceId" = $2`,
		input.threadID, actor.SpaceID).Scan(&thread.BotID, &thread.GroupID)
	if errors.Is(err, pgx.ErrNoRows) {
		return queueThread{}, false, nil
	}
	if err != nil {
		return queueThread{}, false, err
	}
	if thread.GroupID == nil {
		return thread, true, nil
	}
	var archivedAt *time.Time
	err = tx.QueryRow(ctx, `SELECT g."archivedAt",
		EXISTS (SELECT 1 FROM chat_group_members m WHERE m."groupId" = g.id AND m."botId" = $2)
		FROM chat_groups g WHERE g.id = $1`, *thread.GroupID, input.botID).Scan(&archivedAt, &thread.member)
	if errors.Is(err, pgx.ErrNoRows) {
		return thread, true, nil
	}
	if err != nil {
		return queueThread{}, false, err
	}
	thread.live = archivedAt == nil
	return thread, true, nil
}

// inThreadScope is queueMcpConnectedRun's thread predicate: the bot's own chat, or a group that is
// not archived and still has the bot as a member.
func inThreadScope(thread queueThread, botID string) bool {
	if thread.BotID != nil && *thread.BotID == botID {
		return true
	}
	return thread.GroupID != nil && thread.live && thread.member
}

// botLive is queueMcpConnectedRun's archived check: an archived bot takes no new turn.
func botLive(archivedAt *time.Time) bool { return archivedAt == nil }

// chatBusy reports whether a queue-holding run of the bot holds this chat, as the HOLDS_CHAT
// filter of queueMcpConnectedRun's findFirst does.
func chatBusy(ctx context.Context, tx pgx.Tx, input queueInput) (bool, error) {
	rows, err := tx.Query(ctx, `SELECT r.trigger, ro."inChat" FROM runs r
		LEFT JOIN routines ro ON ro.id = r."routineId"
		WHERE r."threadId" = $1 AND r."botId" = $2 AND r.status = ANY($3::text[])`,
		input.threadID, input.botID, runs.QueueHoldingStatuses)
	if err != nil {
		return false, err
	}
	defer rows.Close()
	for rows.Next() {
		var trigger string
		var routineInChat *bool
		if err := rows.Scan(&trigger, &routineInChat); err != nil {
			return false, err
		}
		if chatHolding(trigger, routineInChat) {
			return true, nil
		}
	}
	return false, rows.Err()
}

// chatHolding is runHoldsChat (packages/db/src/runs/chat-holding-runs.ts:16-22): background work
// and a routine that runs alongside its chat never make a chat turn wait; every other
// queue-holding run does.
func chatHolding(trigger string, routineInChat *bool) bool {
	if slices.Contains(backgroundTriggers, trigger) {
		return false
	}
	return !(trigger == "routine" && routineInChat != nil && !*routineInChat)
}

// mcpConnectedPrompt is mcpConnectedPrompt (apps/api/src/bots/hidden-turns.prompt.ts:60-62).
func mcpConnectedPrompt(name string) string {
	return "The user just connected the MCP server " + validate.Stringify(name) +
		" from its approval card, so its tools are available now. Carry on with what they asked for." +
		" If nothing is left to do, confirm in one short sentence."
}
