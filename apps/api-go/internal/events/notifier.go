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

// Publisher delivers a committed thread cursor to subscribers.
type Publisher interface {
	PublishThread(ctx context.Context, threadID string, cursor int32) error
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

// PublishThread sends one cursor signal.
func (p *PGPublisher) PublishThread(ctx context.Context, threadID string, cursor int32) error {
	payload, err := json.Marshal(struct {
		Cursor int32 `json:"cursor"`
	}{cursor})
	if err != nil {
		return err
	}
	envelope, err := json.Marshal(struct {
		Topic   string `json:"topic"`
		Payload string `json:"payload"`
	}{ThreadTopic(threadID), string(payload)})
	if err != nil {
		return err
	}
	if len(envelope) > MaxNotifyBytes {
		return errors.New("Realtime signal exceeds the PostgreSQL NOTIFY payload limit")
	}
	_, err = p.Pool.Exec(ctx, "SELECT pg_notify($1, $2)", RealtimeChannel, string(envelope))
	return err
}
