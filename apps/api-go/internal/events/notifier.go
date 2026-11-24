package events

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	// RealtimeChannel is the NOTIFY channel every API, worker and gateway
	// process shares (packages/adapters/src/realtime.ts:7).
	RealtimeChannel = "rakazo_events"
	// MaxNotifyBytes bounds an envelope; larger signals would not fit a
	// PostgreSQL NOTIFY payload (realtime.ts:8).
	MaxNotifyBytes = 7_900
)

// Publisher delivers a committed thread cursor to subscribers. The event type is optional, as in
// notifyRealtime (event-stream.ts:35-43): a publisher that names none wakes every follower.
type Publisher interface {
	PublishThread(ctx context.Context, threadID string, cursor int32, eventType string) error
}

// PGPublisher publishes through pg_notify, the same call
// PostgresRealtimeFanout.publish makes (realtime.ts:72-79): one envelope
// `{"topic":...,"payload":"{\"cursor\":N}"}` on rakazo_events.
type PGPublisher struct {
	Pool *pgxpool.Pool
}

// ThreadTopic is threadTopic: the fanout topic for one chat.
func ThreadTopic(threadID string) string {
	return "thread:" + threadID
}

// threadEnvelope is notifyRealtime's signal (event-stream.ts:41-43) in its exact bytes: the
// cursor first, then the event type only when the publisher names one.
func threadEnvelope(threadID string, cursor int32, eventType string) ([]byte, error) {
	payload, err := json.Marshal(struct {
		Cursor int32  `json:"cursor"`
		Type   string `json:"type,omitempty"`
	}{cursor, eventType})
	if err != nil {
		return nil, err
	}
	return json.Marshal(struct {
		Topic   string `json:"topic"`
		Payload string `json:"payload"`
	}{ThreadTopic(threadID), string(payload)})
}

// PublishThread sends one cursor signal. A named event type lets followers that watch many
// threads, such as the roster, skip the events their view does not show.
func (p *PGPublisher) PublishThread(ctx context.Context, threadID string, cursor int32, eventType string) error {
	envelope, err := threadEnvelope(threadID, cursor, eventType)
	if err != nil {
		return err
	}
	if len(envelope) > MaxNotifyBytes {
		return errors.New("Realtime signal exceeds the PostgreSQL NOTIFY payload limit")
	}
	// writeaudit:dynamic notification only; arguments are the channel and payload
	_, err = p.Pool.Exec(ctx, "SELECT pg_notify($1, $2)", RealtimeChannel, string(envelope))
	return err
}
