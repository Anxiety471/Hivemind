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
	// signalFailureHold is SIGNAL_FAILURE_HOLD_MS (account.ts:80): after a source fails the
	// stream keeps its other frames briefly, then ends so the app reconnects and re-reads.
	signalFailureHold = 30 * time.Second
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
//
// A deployment without a realtime fanout still streams: TypeScript's followChatAlerts is always
// defined (events.ts:269), so the handler's NOT_FOUND is unreachable and the stream opens, stays
// empty and heartbeats. The roster, Space and organization sources need the fanout and simply
// take part only when there is one (events.ts:275-280).
func Subscribe(ctx context.Context, database *db.DB, deployment shared.Deployment, actor db.Actor, _ orpc.Input) (*local.Follow, *orpc.Error) {
	realtime := deployment.Realtime
	r := New(ctx)
	if realtime == nil {
		r.Go(func(ctx context.Context) { <-ctx.Done() })
	} else {
		r.Go(func(ctx context.Context) { followChatAlerts(ctx, r, realtime, actor) })
		r.Go(func(ctx context.Context) { followRosterChanges(ctx, r, realtime, database, actor.UserID) })
		r.Go(func(ctx context.Context) { followSpaceChanges(ctx, r, realtime, actor.SpaceID) })
		r.Go(func(ctx context.Context) { followOrganizationChanges(ctx, r, realtime, actor.UserID) })
	}
	frames, stop := r.Frames()
	return &local.Follow{Signals: frames, Stop: stop, Heartbeat: HeartbeatFrame, Ending: r.Ending}, nil
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

// alertFrame is the router's `{type, alert}` in its declared order.
type alertFrame struct {
	Type  string    `json:"type"`
	Alert chatAlert `json:"alert"`
}

// followChatAlerts is createChatAlerts(realtime).follow (packages/db/src/threads/chat-alerts.ts:23-64).
// The queue fills from the fanout on its own goroutine so a burst is kept (newest twenty) while a
// frame is being written, exactly like the TypeScript queue.
func followChatAlerts(ctx context.Context, r *Runner, realtime fanout, actor db.Actor) {
	queue := make([]chatAlert, 0, maxQueuedAlerts)
	wake := make(chan struct{}, 1)
	var mu sync.Mutex
	// createChatAlerts subscribes with a callback: the queue fills as the signal arrives, so a
	// burst is kept (newest twenty) while a frame is being written, exactly like TypeScript.
	defer realtime.SubscribeFunc("chat-alerts:"+actor.UserID, func(payload string) {
		alert, ok := parseChatAlert(payload, actor.SpaceID)
		if !ok {
			return
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
	})()
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
			frame, ok := Encode(alertFrame{Type: "alert", Alert: alert})
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
//
// TypeScript adds each arriving kind to a Set in the subscribe callback, so a mixed burst can
// never lose one: the fanout's channel would drop the newest when thirty-two signals pile up
// behind a slow client. The callback appends to the same set-and-order pair under the fanout's
// own lock, which is the same guarantee.
func followSpaceChanges(ctx context.Context, r *Runner, realtime fanout, spaceID string) {
	var mu sync.Mutex
	pending := append([]string{}, spaceChangeKinds...)
	seen := map[string]bool{}
	for _, kind := range pending {
		seen[kind] = true
	}
	wake := make(chan struct{}, 1)
	add := func(kind string) {
		mu.Lock()
		if !seen[kind] {
			seen[kind] = true
			pending = append(pending, kind)
		}
		mu.Unlock()
		select {
		case wake <- struct{}{}:
		default:
		}
	}
	unsubscribe := realtime.SubscribeFunc("space-changes:"+spaceID, func(payload string) {
		// An empty payload is the fanout's catch-up after a reconnect: anything may have changed.
		if payload == "" {
			for _, kind := range spaceChangeKinds {
				add(kind)
			}
			return
		}
		for _, kind := range spaceChangeKinds {
			if payload == kind {
				add(kind)
			}
		}
	})
	defer unsubscribe()
	// Workers from the previous release announce computer updates here until they drain.
	defer realtime.SubscribeFunc("computer-updates:"+spaceID, func(string) { add("computerUpdates") })()
	idle := time.NewTicker(idleWait)
	defer idle.Stop()
	for {
		mu.Lock()
		ready := pending
		pending, seen = nil, map[string]bool{}
		mu.Unlock()
		for _, kind := range ready {
			if !r.Send(typeFrame(kind)) {
				return
			}
		}
		select {
		case <-ctx.Done():
			return
		case <-wake:
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
	defer realtime.SubscribeFunc("organization-changes:"+userID, func(string) { l.notify() })()
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
		// One callback per topic and no goroutine of its own: TypeScript registers exactly these
		// subscriptions, and a member with many chats and several tabs would otherwise pay a
		// goroutine and a channel for each.
		for topic := range topics {
			if _, ok := subscriptions[topic]; ok {
				continue
			}
			subscriptions[topic] = realtime.SubscribeFunc(topic, func(payload string) {
				if threadEventChangesRoster(signalledType(payload)) {
					l.notify()
				}
			})
		}
		return nil
	}
	// The first scope is read before any frame; TypeScript's first `await watch()` throws there
	// and account.ts holds SIGNAL_FAILURE_HOLD_MS before rethrowing, so the client has a moment
	// of alerts before the stream ends and reconnects.
	if err := watch(ctx); err != nil {
		if sleep(ctx, signalFailureHold) {
			r.Fail(shared.Failure(err))
		}
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
	// SubscribeFunc follows a topic with a callback: every signal, in order, none dropped.
	SubscribeFunc(topic string, onSignal func(string)) func()
}
