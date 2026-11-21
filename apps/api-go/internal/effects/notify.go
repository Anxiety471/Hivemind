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

// PublishRunReady wakes worker processes listening on runs:ready for a newly queued run.
func (n *Notifier) PublishRunReady(runID string) {
	if runID == "" {
		return
	}
	n.publish("runs:ready", runID)
}

// BoardEvent is the payload of a board:<spaceId> signal (board-live.ts:20-28): the board and
// ticket are named when the change has one, and the client refetches on any frame.
type BoardEvent struct {
	SpaceID   string `json:"spaceId"`
	BoardID   string `json:"boardId,omitempty"`
	TicketID  string `json:"ticketId,omitempty"`
	CreatedAt string `json:"createdAt"`
}

// PublishBoard is BoardEvents.notify (packages/db/src/board-live.ts:19-31): one frame per
// change, sent once (createBoardEvents swallows the publish failure), never retried.
func (n *Notifier) PublishBoard(spaceID, boardID, ticketID string) {
	event := BoardEvent{
		SpaceID: spaceID, BoardID: boardID, TicketID: ticketID,
		CreatedAt: time.Now().UTC().Format("2006-01-02T15:04:05.000Z"),
	}
	payload, err := json.Marshal(event)
	if err != nil {
		return
	}
	body, err := Envelope("board:"+spaceID, string(payload))
	if err != nil {
		n.logger.Warn("realtime signal not published", "topic", "board:"+spaceID, "error", err)
		return
	}
	n.wait.Add(1)
	go func() {
		defer n.wait.Done()
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if _, err := n.db.Pool.Exec(ctx, "SELECT pg_notify($1, $2)", realtimeChannel, string(body)); err != nil {
			n.logger.Warn("board signal not published", "topic", "board:"+spaceID, "error", err)
		}
	}()
}

// PublishOrganization is publishOrganizationChange (packages/db/src/organization-changes.ts:20-45):
// every member above guest hears on their own topic that the organization's people may have
// changed, and `also` names people already gone who must hear it too. The member read and the
// publishes ride out a short database outage together, as retryWhileDatabaseUnavailable does;
// a failure past 15s is logged and dropped.
func (n *Notifier) PublishOrganization(organizationID string, also ...string) {
	n.wait.Add(1)
	go func() {
		defer n.wait.Done()
		deadline := time.Now().Add(publishRetryAfter)
		for attempt := 0; ; attempt++ {
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			users, err := n.organizationMembers(ctx, organizationID)
			cancel()
			if err == nil {
				seen := make(map[string]bool, len(users)+len(also))
				for _, userID := range append(users, also...) {
					if userID == "" || seen[userID] {
						continue
					}
					seen[userID] = true
					n.send(context.Background(), "organization-changes:"+userID, "", false)
				}
				return
			}
			if !db.IsUnavailable(err) || time.Now().After(deadline) {
				n.logger.Warn("organization signal not published", "organization", organizationID, "error", err)
				return
			}
			n.sleep(backoffFor(attempt))
		}
	}()
}

// organizationMembers is publishOrganizationChange's member query: everyone above guest.
func (n *Notifier) organizationMembers(ctx context.Context, organizationID string) ([]string, error) {
	rows, err := n.db.Pool.Query(ctx, `SELECT "userId" FROM member WHERE "organizationId" = $1 AND role <> 'guest'`, organizationID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var users []string
	for rows.Next() {
		var userID string
		if err := rows.Scan(&userID); err != nil {
			return nil, err
		}
		users = append(users, userID)
	}
	return users, rows.Err()
}

func backoffFor(attempt int) time.Duration {
	return min(200*time.Millisecond<<min(attempt, 8), 5*time.Second)
}

func (n *Notifier) publish(topic, payload string) {
	n.wait.Add(1)
	go func() {
		defer n.wait.Done()
		n.send(context.WithoutCancel(context.Background()), topic, payload, true)
	}()
}

// send publishes one signal, retrying while the database is unavailable only when asked (a
// publish that fails is otherwise dropped, as PostgresRealtimeFanout.publish leaves it).
func (n *Notifier) send(ctx context.Context, topic, payload string, retry bool) {
	body, err := Envelope(topic, payload)
	if err != nil {
		n.logger.Warn("realtime signal not published", "topic", topic, "error", err)
		return
	}
	deadline := time.Now().Add(publishRetryAfter)
	for attempt := 0; ; attempt++ {
		runCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
		_, err := n.db.Pool.Exec(runCtx, "SELECT pg_notify($1, $2)", realtimeChannel, string(body))
		cancel()
		if err == nil {
			return
		}
		if !retry || !db.IsUnavailable(err) || time.Now().After(deadline) {
			n.logger.Warn("realtime signal not published", "topic", topic, "error", err)
			return
		}
		n.sleep(backoffFor(attempt))
	}
}
