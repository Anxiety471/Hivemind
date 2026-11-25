package livestream

import (
	"context"
	"encoding/json"
	"strconv"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/local"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/orpc"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/shared"
)

// The pacing and queueing constants of the TypeScript sources.
const (
	// idleWait is IDLE_WAIT_MS (space-changes.ts, roster-changes.ts, organization-changes.ts).
	idleWait = 60 * time.Second
	// rosterSpacing is ROSTER_SIGNAL_SPACING_MS: the sidebar refetches at most this often.
	rosterSpacing = 10 * time.Second
	// maxQueuedAlerts is MAX_QUEUED_ALERTS: a stream that stops reading keeps only the newest.
	maxQueuedAlerts = 20
	// catchUp is PUSH_CATCH_UP_MS (event-stream.ts): a missed publish is covered by a re-read.
	catchUp = 30 * time.Second
)

// spaceChangeKinds is SpaceChangeKind.options, in declaration order.
var spaceChangeKinds = []string{"computerUpdates", "runs", "routines", "files"}

// quietThreadEvents is QUIET_THREAD_EVENTS (packages/db/src/bots/roster-changes.ts:27-47): events
// that stream while a bot works but change nothing the sidebar shows, so they wake nobody.
var quietThreadEvents = map[string]bool{
	"agent.tool.called":           true,
	"agent.tool.completed":        true,
	"computer.command":            true,
	"computer.status":             true,
	"computer.takeover.granted":   true,
	"computer.takeover.released":  true,
	"computer.takeover.requested": true,
	"effect.recorded":             true,
	"effect.reconciled":           true,
	"heartbeat":                   true,
	"run.checkpointed":            true,
	"run.steering.claimed":        true,
	"thread.artifact":             true,
	"thread.cloud_agent":          true,
	"thread.computer":             true,
	"thread.progress":             true,
	"thread.subagent":             true,
	"thread.thinking":             true,
	"usage.recorded":              true,
}

// Subscribe is notifications.subscribe (apps/api/src/routes/account.ts:383-446): run alerts for
// the member's chats in this Space, plus roster, Space, organization and heartbeat frames.
// Without a realtime fanout the TypeScript handler answers NOT_FOUND.
func Subscribe(ctx context.Context, database *db.DB, deployment shared.Deployment, actor db.Actor, _ orpc.Input) (*local.Follow, *orpc.Error) {
	realtime := deployment.Realtime
	if realtime == nil {
		// The handler throws at its first pull, so the client sees 200 and an error event.
		return local.Failed(orpc.NotFound("Not Found")), nil
	}
	r := New(ctx)
	r.Go(func(ctx context.Context) { followChatAlerts(ctx, r, realtime, actor) })
	r.Go(func(ctx context.Context) { followRosterChanges(ctx, r, realtime, database, actor.UserID) })
	r.Go(func(ctx context.Context) { followSpaceChanges(ctx, r, realtime, actor.SpaceID) })
	r.Go(func(ctx context.Context) { followOrganizationChanges(ctx, r, realtime, actor.UserID) })
	frames, stop := r.Frames()
	return &local.Follow{Signals: frames, Stop: stop, Heartbeat: HeartbeatFrame}, nil
}

func typeFrame(kind string) string { return `{"type":` + strconv.Quote(kind) + `}` }

// chatAlert is ChatAlert with the schema's parsing applied: unknown keys are dropped and a value
// of the wrong shape is not an alert (safeParse fails, so the publisher's signal is ignored).
type chatAlert struct {
	Kind     string  `json:"kind"`
	Title    string  `json:"title"`
	Body     string  `json:"body"`
	SpaceID  string  `json:"spaceId"`
	BotID    string  `json:"botId"`
	ThreadID string  `json:"threadId"`
	GroupID  *string `json:"groupId,omitempty"`
}

var chatAlertKinds = map[string]bool{"completion": true, "failure": true, "help": true, "takeover": true}

// parseChatAlert is ChatAlertSchema.safeParse(payload) with the stream's Space filter.
func parseChatAlert(payload, spaceID string) (chatAlert, bool) {
	var raw map[string]any
	if json.Unmarshal([]byte(payload), &raw) != nil || raw == nil {
		return chatAlert{}, false
	}
	text := func(key string) (string, bool) {
		value, ok := raw[key].(string)
		return value, ok
	}
	var alert chatAlert
	kind, ok := text("kind")
	if !ok || !chatAlertKinds[kind] {
		return chatAlert{}, false
	}
	alert.Kind = kind
	for _, field := range []struct {
		key  string
		into *string
	}{{"title", &alert.Title}, {"body", &alert.Body}, {"spaceId", &alert.SpaceID},
		{"botId", &alert.BotID}, {"threadId", &alert.ThreadID}} {
		value, ok := text(field.key)
		if !ok {
			return chatAlert{}, false
		}
		*field.into = value
	}
	if alert.SpaceID == "" || alert.BotID == "" || alert.ThreadID == "" || alert.SpaceID != spaceID {
		return chatAlert{}, false
	}
	if group, present := raw["groupId"]; present {
		value, ok := group.(string)
		if !ok || value == "" {
			return chatAlert{}, false
		}
		alert.GroupID = &value
	}
	return alert, true
}

// followChatAlerts is createChatAlerts(realtime).follow (packages/db/src/threads/chat-alerts.ts:23-64).
// The queue fills from the fanout on its own goroutine so a burst is kept (newest twenty) while a
// frame is being written, exactly like the TypeScript queue.
func followChatAlerts(ctx context.Context, r *Runner, realtime fanout, actor db.Actor) {
	signals, unsubscribe := realtime.Subscribe("chat-alerts:" + actor.UserID)
	defer unsubscribe()
	queue := make([]chatAlert, 0, maxQueuedAlerts)
	wake := make(chan struct{}, 1)
	var mu sync.Mutex
	r.Go(func(ctx context.Context) {
		for {
			select {
			case <-ctx.Done():
				return
			case payload := <-signals:
				alert, ok := parseChatAlert(payload, actor.SpaceID)
				if !ok {
					continue
				}
				mu.Lock()
				if len(queue) == maxQueuedAlerts {
					queue = queue[1:]
				}
				queue = append(queue, alert)
				mu.Unlock()
				select {
				case wake <- struct{}{}:
				default:
				}
			}
		}
	})
	for {
		for {
			mu.Lock()
			if len(queue) == 0 {
				mu.Unlock()
				break
			}
			alert := queue[0]
			queue = queue[1:]
			mu.Unlock()
			frame, ok := Encode(map[string]any{"type": "alert", "alert": alert})
			if !ok || !r.Send(frame) {
				return
			}
		}
		select {
		case <-ctx.Done():
			return
		case <-wake:
		}
	}
}

// followSpaceChanges is followSpaceChanges (packages/db/src/spaces/space-changes.ts:41-79): every
// kind once when following starts, then each kind that may have changed, in arrival order.
func followSpaceChanges(ctx context.Context, r *Runner, realtime fanout, spaceID string) {
	changes, unsubscribe := realtime.Subscribe("space-changes:" + spaceID)
	defer unsubscribe()
	// Workers from the previous release announce computer updates here until they drain.
	legacy, unsubscribeLegacy := realtime.Subscribe("computer-updates:" + spaceID)
	defer unsubscribeLegacy()
	pending := append([]string{}, spaceChangeKinds...)
	seen := map[string]bool{}
	for _, kind := range pending {
		seen[kind] = true
	}
	add := func(kind string) {
		if seen[kind] {
			return
		}
		seen[kind] = true
		pending = append(pending, kind)
	}
	idle := time.NewTicker(idleWait)
	defer idle.Stop()
	for {
		for _, kind := range pending {
			if !r.Send(typeFrame(kind)) {
				return
			}
		}
		pending, seen = nil, map[string]bool{}
		select {
		case <-ctx.Done():
			return
		case payload := <-changes:
			// An empty payload is the fanout's catch-up after a reconnect: anything may have changed.
			if payload == "" {
				for _, kind := range spaceChangeKinds {
					add(kind)
				}
				continue
			}
			for _, kind := range spaceChangeKinds {
				if payload == kind {
					add(kind)
				}
			}
		case <-legacy:
			add("computerUpdates")
		case <-idle.C:
			// Like the TypeScript idle wait: nothing to send, the loop simply waits again.
		}
	}
}

// followOrganizationChanges is followOrganizationChanges
// (packages/db/src/spaces/organization-changes.ts:53-73): once when following starts, then once
// per burst of signals.
func followOrganizationChanges(ctx context.Context, r *Runner, realtime fanout, userID string) {
	l := newLatch()
	signals, unsubscribe := realtime.Subscribe("organization-changes:" + userID)
	defer unsubscribe()
	r.Go(func(ctx context.Context) {
		for {
			select {
			case <-ctx.Done():
				return
			case <-signals:
				l.notify()
			}
		}
	})
	seen := l.snapshot()
	if !r.Send(typeFrame("organizations")) {
		return
	}
	idle := time.NewTicker(idleWait)
	defer idle.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-l.wake:
		case <-idle.C:
			// An idle check only notices a signal that was already counted.
		}
		if !l.changed(seen) {
			continue
		}
		// A burst becomes one frame: the generation is read after the wait, as the TypeScript
		// latch does, so changes during the frame are one further wake.
		seen = l.snapshot()
		if !r.Send(typeFrame("organizations")) {
			return
		}
	}
}

// rosterScope is RosterScope: the member's Spaces, and the chats in them.
type rosterScope struct {
	spaceIDs  []string
	threadIDs []string
}

// loadRosterScope is loadRosterScope (packages/db/src/bots/roster-changes.ts:92-105), a system
// read across the member's Spaces.
func loadRosterScope(ctx context.Context, database *db.DB, userID string) (rosterScope, error) {
	var scope rosterScope
	err := database.System(ctx, "roster signals across the member's Spaces", func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `SELECT "spaceId" FROM space_members WHERE "userId" = $1`, userID)
		if err != nil {
			return err
		}
		for rows.Next() {
			var spaceID string
			if err := rows.Scan(&spaceID); err != nil {
				rows.Close()
				return err
			}
			scope.spaceIDs = append(scope.spaceIDs, spaceID)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}
		if len(scope.spaceIDs) == 0 {
			return nil
		}
		threads, err := tx.Query(ctx, `SELECT id FROM threads WHERE "spaceId" = ANY($1) AND "helperBotId" IS NULL`, scope.spaceIDs)
		if err != nil {
			return err
		}
		defer threads.Close()
		for threads.Next() {
			var threadID string
			if err := threads.Scan(&threadID); err != nil {
				return err
			}
			scope.threadIDs = append(scope.threadIDs, threadID)
		}
		return threads.Err()
	})
	return scope, err
}

// followRosterChanges is followRosterChanges (packages/db/src/bots/roster-changes.ts:110-160):
// once when following starts, then whenever the member's sidebar may have changed, spaced so a
// burst becomes one. The scope is re-read after each wake, so new chats and Spaces join.
func followRosterChanges(ctx context.Context, r *Runner, realtime fanout, database *db.DB, userID string) {
	l := newLatch()
	subscriptions := map[string]func(){}
	defer func() {
		for _, unsubscribe := range subscriptions {
			unsubscribe()
		}
	}()
	watch := func(ctx context.Context) error {
		scope, err := loadRosterScope(ctx, database, userID)
		if err != nil {
			return err
		}
		topics := map[string]bool{"roster-user:" + userID: true}
		for _, spaceID := range scope.spaceIDs {
			topics["roster-space:"+spaceID] = true
		}
		// A thread's own signals change its preview, unread mark or run status, so the roster
		// watches the thread topic itself rather than a roster-specific one.
		for _, threadID := range scope.threadIDs {
			topics["thread:"+threadID] = true
		}
		for topic, unsubscribe := range subscriptions {
			if topics[topic] {
				continue
			}
			delete(subscriptions, topic)
			unsubscribe()
		}
		for topic := range topics {
			if _, ok := subscriptions[topic]; ok {
				continue
			}
			signals, unsubscribe := realtime.Subscribe(topic)
			topicCtx, cancelTopic := context.WithCancel(ctx)
			subscriptions[topic] = func() {
				cancelTopic()
				unsubscribe()
			}
			r.Go(func(ctx context.Context) {
				for {
					select {
					case <-topicCtx.Done():
						return
					case <-ctx.Done():
						return
					case payload := <-signals:
						if threadEventChangesRoster(signalledType(payload)) {
							l.notify()
						}
					}
				}
			})
		}
		return nil
	}
	// The first scope is read before any frame; a failure ends the stream, as the TypeScript
	// generator's first `await watch()` does.
	if watch(ctx) != nil {
		return
	}
	seen := l.snapshot()
	if !r.Send(typeFrame("roster")) {
		return
	}
	idle := time.NewTicker(idleWait)
	defer idle.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-l.wake:
			if !l.changed(seen) {
				continue
			}
			seen = l.snapshot()
			// A failed re-read keeps the chats already watched; the next wake tries again.
			_ = watch(ctx)
			if !r.Send(typeFrame("roster")) {
				return
			}
			// A burst during the spacing is one further frame after it ends.
			if !sleep(ctx, rosterSpacing) {
				return
			}
		case <-idle.C:
			// An idle check also picks up chats a missed roster signal never told this stream about.
			_ = watch(ctx)
		}
	}
}

// signalledType is signalledType: the event type a thread signal names, if it names one.
func signalledType(payload string) (string, bool) {
	var parsed struct {
		Type *string `json:"type"`
	}
	if json.Unmarshal([]byte(payload), &parsed) != nil || parsed.Type == nil {
		return "", false
	}
	return *parsed.Type, true
}

// threadEventChangesRoster is threadEventChangesRoster: a publisher that names no type may have
// changed anything, so it wakes as before.
func threadEventChangesRoster(name string, named bool) bool {
	return !named || !quietThreadEvents[name]
}

// sleep waits for d, or returns false when the stream ends first.
func sleep(ctx context.Context, d time.Duration) bool {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}

// fanout is the part of events.Fanout these sources use, so a test can hand in its own.
type fanout interface {
	Subscribe(topic string) (<-chan string, func())
}
