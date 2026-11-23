package effects

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgconn"

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
	// execute runs the one statement a signal is published with; tests replace it to fail.
	execute func(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
	wait    sync.WaitGroup
}

// NewNotifier returns a notifier publishing through database. A nil database is a
// process without signals, as the gateway's local-server tests build: the notifier
// is usable and every publish is logged and dropped (never a nil pool dereference).
func NewNotifier(database *db.DB, logger *slog.Logger) *Notifier {
	if logger == nil {
		logger = slog.New(slog.NewJSONHandler(discard{}, nil))
	}
	notifier := &Notifier{db: database, logger: logger, sleep: time.Sleep}
	if database != nil {
		notifier.execute = database.Pool.Exec
	}
	return notifier
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
	// Heartbeat marks the stream's quiet-spell frame: liveness only, so no client reads for it.
	Heartbeat bool `json:"heartbeat,omitempty"`
}

// PublishBoard is BoardEvents.notify (packages/db/src/artifacts/board-live.ts): one frame per
// change. A board signal is the only thing that makes an open board read its tickets, so like
// the roster and Space signals it rides out a short database outage (15s) and is logged and
// dropped past that; apps catch up when their stream reopens.
func (n *Notifier) PublishBoard(spaceID, boardID, ticketID string) {
	event := BoardEvent{
		SpaceID: spaceID, BoardID: boardID, TicketID: ticketID,
		CreatedAt: time.Now().UTC().Format("2006-01-02T15:04:05.000Z"),
	}
	payload, err := json.Marshal(event)
	if err != nil {
		return
	}
	n.publish("board:"+spaceID, string(payload))
}

// PublishOrganization is publishOrganizationChange (packages/db/src/organization-changes.ts:20-45):
// every member above guest hears on their own topic that the organization's people may have
// changed, and `also` names people already gone who must hear it too. The member read and the
// publishes ride out a short database outage together, as retryWhileDatabaseUnavailable does;
// a failure past 15s is logged and dropped.
func (n *Notifier) PublishOrganization(organizationID string, also ...string) {
	if n.db == nil {
		// A gateway local server with no database has no members to read and no
		// channel to publish on; drop it like any other signal without a pool.
		n.logger.Warn("organization signal not published", "organization", organizationID, "reason", "no database")
		return
	}
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
	if n.execute == nil {
		n.logger.Warn("realtime signal not published", "topic", topic, "reason", "no database")
		return
	}
	deadline := time.Now().Add(publishRetryAfter)
	for attempt := 0; ; attempt++ {
		runCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
		_, err := n.execute(runCtx, "SELECT pg_notify($1, $2)", realtimeChannel, string(body))
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
