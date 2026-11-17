package effects

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"sync"
	"time"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
)

const (
	realtimeChannel   = "rakazo_events"
	maxNotifyBytes    = 7_900
	publishRetryAfter = 15 * time.Second
)

// Notifier publishes realtime signals the way PostgresRealtimeFanout does: a
// pg_notify on rakazo_events carrying {"topic": ..., "payload": ...}. A signal
// rides out a short database outage in the background and is dropped past 15s.
type Notifier struct {
	db     *db.DB
	logger *slog.Logger
	sleep  func(time.Duration)
	wait   sync.WaitGroup
}

// NewNotifier returns a notifier publishing through database.
func NewNotifier(database *db.DB, logger *slog.Logger) *Notifier {
	if logger == nil {
		logger = slog.New(slog.NewJSONHandler(discard{}, nil))
	}
	return &Notifier{db: database, logger: logger, sleep: time.Sleep}
}

// Wait blocks until every signal started so far has been delivered or dropped.
func (n *Notifier) Wait() { n.wait.Wait() }

// Envelope is the payload pg_notify carries.
func Envelope(topic, payload string) ([]byte, error) {
	body, err := json.Marshal(struct {
		Topic   string `json:"topic"`
		Payload string `json:"payload"`
	}{topic, payload})
	if err != nil {
		return nil, err
	}
	if len(body) > maxNotifyBytes {
		return nil, errors.New("realtime signal exceeds the PostgreSQL NOTIFY payload limit")
	}
	return body, nil
}

// RosterChange is who sees a roster change: every member of these Spaces, and these people.
type RosterChange struct {
	SpaceIDs []string
	UserIDs  []string
}

// PublishRoster is publishRosterChange: one empty signal per Space, then per user.
func (n *Notifier) PublishRoster(change RosterChange) {
	for _, id := range change.SpaceIDs {
		n.publish("roster-space:"+id, "")
	}
	for _, id := range change.UserIDs {
		n.publish("roster-user:"+id, "")
	}
}

// PublishSpaceChange is publishSpaceChange: the kind travels as the payload.
func (n *Notifier) PublishSpaceChange(spaceID, kind string) {
	n.publish("space-changes:"+spaceID, kind)
}

func (n *Notifier) publish(topic, payload string) {
	body, err := Envelope(topic, payload)
	if err != nil {
		n.logger.Warn("realtime signal not published", "topic", topic, "error", err)
		return
	}
	n.wait.Add(1)
	go func() {
		defer n.wait.Done()
		deadline := time.Now().Add(publishRetryAfter)
		for attempt := 0; ; attempt++ {
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			_, err := n.db.Pool.Exec(ctx, "SELECT pg_notify($1, $2)", realtimeChannel, string(body))
			cancel()
			if err == nil {
				return
			}
			if !db.IsUnavailable(err) || time.Now().After(deadline) {
				n.logger.Warn("roster signal not published", "topic", topic, "error", err)
				return
			}
			backoff := 200 * time.Millisecond << min(attempt, 8)
			n.sleep(min(backoff, 5*time.Second))
		}
	}()
}
