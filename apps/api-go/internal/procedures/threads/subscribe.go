package threads

import (
	"context"
	"encoding/json"
	"errors"
	"sort"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/local"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/messageblocks"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/orpc"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/livestream"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/shared"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/validate"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/wtf8"
)

// This file is threads.subscribe and threads.helperSubscribe (apps/api/src/routes/threads.ts:194-217,
// 333-353): the chat's product events from `cursor` on, live. Every frame is a ProductEvent
// (packages/contracts/src/threads/events.ts:85-108); peer and background runs are filtered the way
// the transcript is (apps/api/src/threads/thread-message-pages.ts:167-263).

const (
	// eventBatchSize is EVENT_BATCH_SIZE (event-stream.ts): a catch-up reads until a short batch.
	eventBatchSize = 200
	// pushCatchUp is PUSH_CATCH_UP_MS: the periodic re-read that covers a missed publish.
	pushCatchUp = 30 * time.Second
	// pollOnlyCatchUp is POLL_ONLY_CATCH_UP_MS, for a deployment with no realtime listener.
	pollOnlyCatchUp = 400 * time.Millisecond
)

// productEventTypes is ProductEventType.options.
var productEventTypes = map[string]bool{
	"thread.message.created": true, "thread.cleared": true, "thread.message.updated": true,
	"thread.message.reaction": true, "thread.progress": true, "thread.thinking": true,
	"thread.artifact": true, "thread.ask": true, "thread.choice": true, "thread.meta": true,
	"thread.computer": true, "thread.subagent": true, "thread.cloud_agent": true,
	"thread.call.ended": true, "run.started": true, "run.steering.claimed": true,
	"run.checkpointed": true, "run.waiting_input": true, "run.completed": true, "run.failed": true,
	"run.cancelled": true, "computer.status": true, "computer.takeover.requested": true,
	"computer.takeover.granted": true, "computer.takeover.released": true, "computer.command": true,
	"memory.revised": true, "routine.created": true, "routine.updated": true, "routine.fired": true,
	"skill.teaching.started": true, "skill.teaching.stopped": true, "skill.draft.created": true,
	"skill.saved": true, "effect.recorded": true, "agent.tool.called": true,
	"agent.tool.completed": true, "effect.reconciled": true, "usage.recorded": true,
	"bot.spawned": true, "bot.updated": true, "bot.archived": true, "bot.deleted": true,
	"group.created": true, "group.updated": true, "group.handoff": true, "heartbeat": true,
}

// subscribeInput is threadTarget.safeExtend({cursor}): botId or groupId, and the cursor to read on
// from (-1 for everything).
type subscribeInput struct {
	Target
	Cursor int64
}

// parseSubscribe mirrors threadTarget.safeExtend({cursor: z.number().int().min(-1)}): the shape
// keys in declaration order, then the exactly-one check when no key failed its type (a type
// error aborts the object's checks).
func parseSubscribe(raw orpc.Input) (subscribeInput, *orpc.Error) {
	object, issues := validate.Decode(raw.Raw, nil)
	if issues != nil {
		return subscribeInput{}, validate.Fail(issues)
	}
	var in subscribeInput
	var found []validate.Issue
	aborted := false
	read := func(key string, into *string) {
		value, present := object.Get(key)
		if !present {
			return
		}
		text, problems := validate.String(validate.Path{key}, value, validate.StringRules{Min: 1})
		if _, isString := value.(string); !isString {
			aborted = true
		}
		found = append(found, problems...)
		if problems == nil {
			*into = text
		}
	}
	read("botId", &in.BotID)
	read("groupId", &in.GroupID)
	cursor, problems := validate.Integer(validate.Path{"cursor"}, object.Field("cursor"), validate.NumberRules{Min: validate.Float(-1)})
	if _, isNumber := object.Field("cursor").(json.Number); !isNumber {
		aborted = true
	}
	found = append(found, problems...)
	if problems == nil {
		in.Cursor = cursor
	}
	if !aborted && (in.BotID == "") == (in.GroupID == "") {
		found = append(found, validate.Issue{
			"code": "custom", "path": []any{"botId"}, "message": "Provide exactly one of botId or groupId",
		})
	}
	if found != nil {
		return subscribeInput{}, validate.Fail(found)
	}
	return in, nil
}

// parseHelperSubscribe mirrors z.object({threadId: Id, cursor: z.number().int().min(-1)}).
func parseHelperSubscribe(raw orpc.Input) (string, int64, *orpc.Error) {
	object, issues := validate.Decode(raw.Raw, nil)
	if issues != nil {
		return "", 0, validate.Fail(issues)
	}
	threadID, problems := validate.String(validate.Path{"threadId"}, object.Field("threadId"), validate.StringRules{Min: 1})
	cursor, cursorProblems := validate.Integer(validate.Path{"cursor"}, object.Field("cursor"), validate.NumberRules{Min: validate.Float(-1)})
	problems = append(problems, cursorProblems...)
	if problems != nil {
		return "", 0, validate.Fail(problems)
	}
	return threadID, cursor, nil
}

// Subscribe is threads.subscribe: one bot's or group's chat events from `cursor` on.
func Subscribe(ctx context.Context, database *db.DB, deployment shared.Deployment, actor db.Actor, raw orpc.Input) (*local.Follow, *orpc.Error) {
	in, failure := parseSubscribe(raw)
	if failure != nil {
		return nil, failure
	}
	var threadID string
	err := database.Tenant(ctx, actor, func(tx pgx.Tx) error {
		resolved, err := resolve(ctx, tx, actor, in.Target)
		threadID = resolved.ThreadID
		return err
	})
	if err != nil {
		// In TypeScript the target lookup runs inside the event generator: a thread that is not
		// the caller's is discovered at the first pull, after the 200 is on the wire, so the client
		// sees an empty stream rather than a 404.
		if errors.Is(err, errIsolation) {
			return local.Failed(orpc.Internal()), nil
		}
		return nil, shared.Failure(err)
	}
	// A bot thread's id is not the bot. Groups have no single bot, so the thread id stands in.
	botID := in.BotID
	if botID == "" {
		botID = threadID
	}
	return follow(ctx, database, deployment, actor, threadID, in.Cursor, botID, actor.SpaceID, true)
}

// HelperSubscribe is threads.helperSubscribe: a background helper's own thread events. The helper
// thread is found from its id and must belong to the Space.
func HelperSubscribe(ctx context.Context, database *db.DB, deployment shared.Deployment, actor db.Actor, raw orpc.Input) (*local.Follow, *orpc.Error) {
	threadID, cursor, failure := parseHelperSubscribe(raw)
	if failure != nil {
		return nil, failure
	}
	var botID string
	err := database.Tenant(ctx, actor, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT b.id FROM threads t JOIN bots b ON b.id = t."helperBotId"
			WHERE t.id = $1 AND t."spaceId" = $2 AND t."helperBotId" IS NOT NULL`,
			threadID, actor.SpaceID).Scan(&botID)
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return local.Failed(orpc.Internal()), nil
	}
	if err != nil {
		return nil, shared.Failure(err)
	}
	return follow(ctx, database, deployment, actor, threadID, cursor, botID, actor.SpaceID, false)
}

// follow starts the event source for one chat. filter selects the peer/background run rules of
// threads.subscribe; the helper stream forwards every stored event.
func follow(ctx context.Context, database *db.DB, deployment shared.Deployment, actor db.Actor, threadID string, cursor int64, botID, spaceID string, filter bool) (*local.Follow, *orpc.Error) {
	realtime := deployment.Realtime
	var signals <-chan string
	var unsubscribe = func() {}
	if realtime != nil {
		signals, unsubscribe = realtime.Subscribe("thread:" + threadID)
	}
	r := livestream.New(ctx)
	r.Go(func(ctx context.Context) {
		defer unsubscribe()
		cache := map[string]string{}
		seq := cursor
		for {
			for {
				events, err := readEvents(ctx, database, deployment, actor, threadID, seq)
				if err != nil {
					// The TypeScript generator throws out of the stream: nothing more is sent.
					return
				}
				for _, event := range events {
					seq = int64(event.seq)
					if filter {
						forward, err := forwardEvent(ctx, database, actor, cache, event)
						if err != nil {
							return
						}
						if !forward {
							continue
						}
					}
					frame, ok := eventFrame(event)
					if !ok || !r.Send(frame) {
						return
					}
				}
				if len(events) < eventBatchSize {
					break
				}
			}
			catchUp := pushCatchUp
			if realtime == nil {
				catchUp = pollOnlyCatchUp
			}
			timer := time.NewTimer(catchUp)
			select {
			case <-ctx.Done():
				timer.Stop()
				return
			case <-signals:
				timer.Stop()
			case <-timer.C:
			}
		}
	})
	frames, stop := r.Frames()
	heartbeat := func() any {
		frame, ok := eventFrame(storedEvent{
			id: "heartbeat", spaceID: spaceID, threadID: threadID, botID: botID, seq: 0,
			eventType: "heartbeat", payload: map[string]any{}, createdAt: time.Now(),
		})
		if !ok {
			return map[string]any{}
		}
		return json.RawMessage(frame)
	}
	return &local.Follow{Signals: frames, Stop: stop, Heartbeat: heartbeat}, nil
}

// storedEvent is one events row as the stream reads it.
type storedEvent struct {
	id        string
	spaceID   string
	threadID  string
	botID     string
	seq       int32
	eventType string
	runID     *string
	payload   any
	createdAt time.Time
}

// readEvents is eventsAfter(prisma, threadId, cursor, EVENT_BATCH_SIZE): the next events in seq
// order, payloads opened. The read holds a pooled connection only for its own statement.
func readEvents(ctx context.Context, database *db.DB, deployment shared.Deployment, actor db.Actor, threadID string, cursor int64) ([]storedEvent, error) {
	var events []storedEvent
	rows := make([][]byte, 0, eventBatchSize)
	err := database.Tenant(ctx, actor, func(tx pgx.Tx) error {
		result, err := tx.Query(ctx, `SELECT id, "spaceId", "threadId", "botId", seq, type, payload, "runId", "createdAt"
			FROM events WHERE "threadId" = $1 AND seq > $2 ORDER BY seq ASC LIMIT $3`,
			threadID, cursor, eventBatchSize)
		if err != nil {
			return err
		}
		defer result.Close()
		for result.Next() {
			var event storedEvent
			var payload []byte
			if err := result.Scan(&event.id, &event.spaceID, &event.threadID, &event.botID, &event.seq,
				&event.eventType, &payload, &event.runID, &event.createdAt); err != nil {
				return err
			}
			events = append(events, event)
			rows = append(rows, payload)
		}
		return result.Err()
	})
	if err != nil {
		return nil, err
	}
	if len(events) == 0 {
		return nil, nil
	}
	open := make([]map[string]any, len(events))
	for index, event := range events {
		decoded, err := messageblocks.DecodeJSON(rows[index])
		if err != nil {
			return nil, err
		}
		open[index] = map[string]any{
			"id": event.id, "spaceId": event.spaceID, "threadId": event.threadID,
			"payload": decoded,
		}
	}
	if deployment.Content != nil {
		if err := deployment.Content.OpenRows(ctx, "Event", open); err != nil {
			return nil, err
		}
	}
	for index := range events {
		events[index].payload = open[index]["payload"]
	}
	return events, nil
}

// eventFrame is mapProductEvent followed by the router's output schema: the payload falls back to
// {} when it is not an object (readJsonColumn's fallback), and a frame the schema rejects ends the
// stream, as a failed output validation does in oRPC (the connection is dropped, no frame).
func eventFrame(event storedEvent) (string, bool) {
	payload, ok := event.payload.(map[string]any)
	if !ok {
		payload = map[string]any{}
	}
	if !productEventTypes[event.eventType] || event.id == "" || event.spaceID == "" ||
		event.threadID == "" || event.botID == "" || event.seq < 0 {
		return "", false
	}
	if !payloadMatchesType(event.eventType, event.runID, payload) {
		return "", false
	}
	// The payload is spliced in as its own JSON: JSON.stringify prints a jsonb number as the
	// IEEE double TypeScript read from it (1.0 → 1, 1e21 → 1e+21, -0 → 0), and validate.Stringify
	// is the repo's encoder for exactly that. Object keys come out sorted: a jsonb object has no
	// order to recover.
	payloadJSON := json.RawMessage(validate.Stringify(jsValue(payload)))
	body, err := wtf8.Marshal(productEvent{
		ID: event.id, SpaceID: event.spaceID, ThreadID: event.threadID, BotID: event.botID,
		Seq: event.seq, Type: event.eventType, RunID: event.runID,
		CreatedAt: shared.ISO(event.createdAt), Payload: payloadJSON,
	})
	if err != nil {
		return "", false
	}
	return string(body), true
}

// jsValue shapes a decoded JSON value the way validate.Stringify prints JSON.stringify:
// objects become *validate.Object (keys sorted), arrays stay arrays, and numbers keep their
// json.Number text for jsNumber to read as a double.
func jsValue(value any) any {
	switch typed := value.(type) {
	case map[string]any:
		keys := make([]string, 0, len(typed))
		for key := range typed {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		object := &validate.Object{Keys: keys, Values: make(map[string]any, len(keys))}
		for _, key := range keys {
			object.Values[key] = jsValue(typed[key])
		}
		return object
	case []any:
		items := make([]any, len(typed))
		for index, item := range typed {
			items[index] = jsValue(item)
		}
		return items
	case float64:
		// Not what a stored column decodes to, but Stringify prints only json.Number as a
		// number: route every Go numeric back through the text jsNumber reads as a double.
		return json.Number(strconv.FormatFloat(typed, 'g', -1, 64))
	case int64:
		return json.Number(strconv.FormatInt(typed, 10))
	case int32:
		return json.Number(strconv.FormatInt(int64(typed), 10))
	case int:
		return json.Number(strconv.Itoa(typed))
	}
	return value
}

// productEvent is ProductEventSchema's fields, in its order.
type productEvent struct {
	ID        string  `json:"id"`
	SpaceID   string  `json:"spaceId"`
	ThreadID  string  `json:"threadId"`
	BotID     string  `json:"botId"`
	Seq       int32   `json:"seq"`
	Type      string  `json:"type"`
	RunID     *string `json:"runId,omitempty"`
	CreatedAt string  `json:"createdAt"`
	Payload   any     `json:"payload"`
}

// payloadMatchesType is ProductEventSchema's superRefine: run reasoning and the activity marker
// are the two payloads a client applies blind, so a malformed one fails the frame.
func payloadMatchesType(eventType string, runID *string, payload map[string]any) bool {
	if eventType == "thread.thinking" {
		if runID == nil {
			return false
		}
		if len(payload) != 3 {
			return false
		}
		if !nonNegativeInt(payload["segment"]) || !nonNegativeInt(payload["durationMs"]) {
			return false
		}
		lines, ok := payload["lines"].([]any)
		if !ok {
			return false
		}
		for _, line := range lines {
			if _, ok := line.(string); !ok {
				return false
			}
		}
		return true
	}
	if eventType != "thread.meta" {
		return true
	}
	activity, ok := payload["activity"].(map[string]any)
	if !ok {
		return true
	}
	thinking, marked := activity["thinking"]
	if !marked {
		return true
	}
	if runID == nil || len(payload) != 1 || len(activity) != 1 {
		return false
	}
	_, ok = thinking.(bool)
	return ok
}

// nonNegativeInt is z.number().int().nonnegative() over a decoded JSON value.
func nonNegativeInt(value any) bool {
	switch number := value.(type) {
	case json.Number:
		parsed, err := number.Int64()
		return err == nil && parsed >= 0
	case float64:
		return number >= 0 && number == float64(int64(number))
	}
	return false
}

// forwardEvent applies the peer and background run rules to one event, caching each run's trigger
// for the life of the stream as isPeerRun/isBackgroundRun's caches do.
func forwardEvent(ctx context.Context, database *db.DB, actor db.Actor, cache map[string]string, event storedEvent) (bool, error) {
	if event.runID == nil || *event.runID == "" {
		return true, nil
	}
	trigger, ok := cache[*event.runID]
	if !ok {
		var found *string
		err := database.Tenant(ctx, actor, func(tx pgx.Tx) error {
			return tx.QueryRow(ctx, `SELECT trigger FROM runs WHERE id = $1`, *event.runID).Scan(&found)
		})
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return false, err
		}
		trigger = ""
		if found != nil {
			trigger = *found
		}
		cache[*event.runID] = trigger
	}
	if trigger == peerTrigger {
		return shouldForwardPeerEvent(event), nil
	}
	if trigger == backgroundTrigger {
		return shouldForwardBackgroundEvent(event), nil
	}
	return true, nil
}

// shouldForwardPeerEvent is shouldForwardPeerThreadEvent: terminals, waits, receipts, asks,
// text, charts and attachments still reach an open thread.
func shouldForwardPeerEvent(event storedEvent) bool {
	switch event.eventType {
	case "run.completed", "run.failed", "run.cancelled", "run.waiting_input",
		"computer.takeover.requested":
		return true
	}
	if event.eventType != "thread.message.created" && event.eventType != "thread.message.updated" {
		return false
	}
	return blocksMatch(event.payload, func(block map[string]any) bool {
		switch block["kind"] {
		case "bot_message_received", "bot_message_sent", "ask", "text", "chart", "app", "file",
			"image", "page":
			return true
		}
		return false
	})
}

// shouldForwardBackgroundEvent is shouldForwardBackgroundThreadEvent: a background run's chatter
// stays off the transcript, but its terminal states and the user's own input cards remain.
func shouldForwardBackgroundEvent(event storedEvent) bool {
	switch event.eventType {
	case "run.completed", "run.failed", "run.cancelled", "run.waiting_input",
		"computer.takeover.requested":
		return true
	}
	if event.eventType != "thread.message.created" && event.eventType != "thread.message.updated" {
		return false
	}
	if !blocksMatch(event.payload, func(map[string]any) bool { return true }) {
		return false
	}
	payload, _ := event.payload.(map[string]any)
	if payload["role"] == "user" && !blocksMatch(event.payload, func(block map[string]any) bool {
		return block["kind"] == "delivery"
	}) {
		return true
	}
	return blocksMatch(event.payload, func(block map[string]any) bool {
		switch block["kind"] {
		case "ask", "computer", "mcp_approval", "app_connect":
			return true
		}
		return false
	})
}

// blocksMatch applies a predicate to the event payload's blocks array; a payload without one
// matches nothing.
func blocksMatch(payload any, match func(block map[string]any) bool) bool {
	record, ok := payload.(map[string]any)
	if !ok {
		return false
	}
	blocks, ok := record["blocks"].([]any)
	if !ok {
		return false
	}
	for _, block := range blocks {
		if object, ok := block.(map[string]any); ok && match(object) {
			return true
		}
	}
	return false
}
