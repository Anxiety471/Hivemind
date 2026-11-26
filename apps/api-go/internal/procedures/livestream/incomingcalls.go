package livestream

import (
	"bytes"
	"context"
	"encoding/json"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/contentcrypto"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/local"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/orpc"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/shared"
)

// incomingCallPoll is INCOMING_CALL_POLL_MS (event-stream.ts:11): without a fanout each wake
// re-reads every ringing request, so the stream polls gently instead.
const incomingCallPoll = 3 * time.Second

// incomingCall is the CallRequestBlock slice ringingCall returns.
type incomingCall struct {
	CallID    string `json:"callId"`
	Reason    string `json:"reason"`
	Opening   string `json:"opening"`
	ExpiresAt string `json:"expiresAt"`
}

// incomingBotCall is IncomingBotCall: the bot's identity plus the request ringing it.
type incomingBotCall struct {
	ID           string       `json:"id"`
	SpaceID      string       `json:"spaceId"`
	Name         string       `json:"name"`
	Color        string       `json:"color"`
	AvatarSet    string       `json:"avatarSet"`
	IncomingCall incomingCall `json:"incomingCall"`
}

// SubscribeCalls is notifications.subscribeCalls (apps/api/src/routes/account.ts:448-465): the
// signed-in owner's ringing calls, re-read on every signal and after a quiet spell. Calls are off
// unless the deployment opted in. Without a fanout the stream still works: TypeScript's
// followIncomingCalls is always defined and falls back to polling every INCOMING_CALL_POLL_MS
// (event-stream.ts:158-160).
func SubscribeCalls(ctx context.Context, database *db.DB, deployment shared.Deployment, actor db.Actor, _ orpc.Input) (*local.Follow, *orpc.Error) {
	if !deployment.PhoneCallsEnabled {
		// The handler throws at its first pull: 200, then one NOT_FOUND event.
		return local.Failed(orpc.NotFound("Not Found")), nil
	}
	realtime := deployment.Realtime
	poll := catchUp
	if realtime == nil {
		poll = incomingCallPoll
	}
	r := New(ctx)
	r.Go(func(ctx context.Context) {
		l := newLatch()
		if realtime != nil {
			defer realtime.SubscribeFunc("incoming-calls:"+actor.UserID, func(string) { l.notify() })()
		}
		send := func() bool {
			calls, err := loadUserIncomingCalls(ctx, database, deployment.Content, actor.UserID)
			if err != nil {
				// The handler awaits the read inside the generator: a failure ends the stream with
				// one error event.
				r.Fail(shared.Failure(err))
				return false
			}
			frame, ok := Encode(callsFrame{
				Type:    "incoming.calls",
				Payload: callsPayload{Calls: calls},
			})
			return ok && r.Send(frame)
		}
		// followIncomingCallSignals yields once when following starts.
		if !send() {
			return
		}
		seen := l.snapshot()
		for {
			// A quiet spell re-reads too (PUSH_CATCH_UP_MS), so an expired request disappears
			// without a publisher.
			timer := time.NewTimer(poll)
			select {
			case <-ctx.Done():
				timer.Stop()
				return
			case <-l.wake:
				timer.Stop()
				if !l.changed(seen) {
					continue
				}
				seen = l.snapshot()
			case <-timer.C:
				seen = l.snapshot()
			}
			if !send() {
				return
			}
		}
	})
	frames, stop := r.Frames()
	return &local.Follow{Signals: frames, Stop: stop, Heartbeat: HeartbeatFrame, Ending: r.Ending}, nil
}

// callsFrame is the router's `{type, payload}` frame in its declared order: JSON.stringify writes
// the schema's keys as written, so a map (sorted) would put payload first and differ byte for byte.
type callsFrame struct {
	Type    string       `json:"type"`
	Payload callsPayload `json:"payload"`
}

type callsPayload struct {
	Calls []incomingBotCall `json:"calls"`
}

// loadUserIncomingCalls is loadUserIncomingCalls (packages/adapters/src/calls/call-request.ts:296-336):
// the signed-in call owner's ringing requests across their Spaces, newest first, one per bot.
func loadUserIncomingCalls(ctx context.Context, database *db.DB, ring *contentcrypto.KeyRing, userID string) ([]incomingBotCall, error) {
	type row struct {
		blocks    []byte
		messageID string
		threadID  string
		id        string
		spaceID   string
		name      string
		color     string
		avatarSet *string
		createdAt time.Time
	}
	var rows []row
	err := database.System(ctx, "load the signed-in call owner's incoming calls", func(tx pgx.Tx) error {
		result, err := tx.Query(ctx, `SELECT m.blocks, m.id, m."threadId", b.id, b."spaceId", b.name, b.color, b."avatarSet", m."createdAt"
			FROM messages m
			JOIN threads t ON t.id = m."threadId"
			JOIN bots b ON b.id = t."botId"
			WHERE m.role = 'bot'
				AND m."clientNonce" LIKE 'call:%:request'
				AND m.blocks->0->>'status' = 'ringing'
				AND t."userId" = $1 AND t."groupId" IS NULL AND t."externalConversationId" IS NULL
				AND b."userId" = $1 AND b."archivedAt" IS NULL
			ORDER BY m."createdAt" DESC
			LIMIT 50`, userID)
		if err != nil {
			return err
		}
		defer result.Close()
		for result.Next() {
			var item row
			if err := result.Scan(&item.blocks, &item.messageID, &item.threadID, &item.id, &item.spaceID,
				&item.name, &item.color, &item.avatarSet, &item.createdAt); err != nil {
				return err
			}
			rows = append(rows, item)
		}
		return result.Err()
	})
	if err != nil {
		return nil, err
	}
	// The blocks column is sealed content: open it outside the transaction so no pooled connection
	// is held while the key ring reads its own.
	open := make([]map[string]any, len(rows))
	for index, item := range rows {
		decoded, err := decodeJSON(item.blocks)
		if err != nil {
			return nil, err
		}
		open[index] = map[string]any{
			"id": item.messageID, "spaceId": item.spaceID, "threadId": item.threadID,
			"blocks": decoded,
		}
	}
	if ring != nil && len(open) > 0 {
		if err := ring.OpenRows(ctx, "Message", open); err != nil {
			return nil, err
		}
	}
	now := time.Now()
	calls := make([]incomingBotCall, 0, len(rows))
	seen := map[string]bool{}
	for index, item := range rows {
		call, ok := ringingCall(open[index]["blocks"], now)
		if !ok || seen[item.id] {
			continue
		}
		seen[item.id] = true
		calls = append(calls, incomingBotCall{
			ID: item.id, SpaceID: item.spaceID, Name: item.name, Color: item.color,
			AvatarSet: resolveBotAvatarSet(item.avatarSet), IncomingCall: call,
		})
	}
	return calls, nil
}

// ringingCall is ringingCall (packages/core/src/calls/call-request.ts:37-54): the request
// ringing among a chat's newest message, when its first block is a live call_request.
func ringingCall(blocks any, now time.Time) (incomingCall, bool) {
	list, ok := blocks.([]any)
	if !ok || len(list) == 0 {
		return incomingCall{}, false
	}
	block, ok := list[0].(map[string]any)
	if !ok || block["kind"] != "call_request" || block["status"] != "ringing" {
		return incomingCall{}, false
	}
	field := func(key string) (string, bool) {
		value, ok := block[key].(string)
		return value, ok
	}
	callID, ok := field("callId")
	if !ok {
		return incomingCall{}, false
	}
	expiresAt, ok := field("expiresAt")
	if !ok {
		return incomingCall{}, false
	}
	reason, ok := field("reason")
	if !ok {
		return incomingCall{}, false
	}
	opening, ok := field("opening")
	if !ok {
		return incomingCall{}, false
	}
	// callIsRinging: Date.parse(expiresAt) > now; an unparseable value is not ringing.
	expiry, err := time.Parse(time.RFC3339Nano, expiresAt)
	if err != nil || !expiry.After(now) {
		return incomingCall{}, false
	}
	return incomingCall{CallID: callID, Reason: reason, Opening: opening, ExpiresAt: expiresAt}, true
}

// resolveBotAvatarSet is resolveBotAvatarSet (packages/contracts/src/bots/bot-avatar.ts:8-10).
func resolveBotAvatarSet(value *string) string {
	if value != nil && *value == "rakazo" {
		return "rakazo"
	}
	return "organic"
}

// decodeJSON parses a stored JSON column as JavaScript would, keeping numbers exact for the
// encoder.
func decodeJSON(raw []byte) (any, error) {
	if len(raw) == 0 {
		return nil, nil
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		return nil, err
	}
	return value, nil
}
