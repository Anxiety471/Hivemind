// Package taskqueue provides Redis-backed (with in-memory fallback) ticket
// wake dispatch, exponential retry backoff, dead-letter tracking, and a
// periodic sweeper that bumps idle worker bots when their open tasks stall.
package taskqueue

import (
	"context"
	"fmt"
	"time"
)

const (
	// KindAssign dispatches an initial wake when a worker bot is assigned to a ticket.
	KindAssign = "assign"
	// KindBump nudges an idle worker bot that still has an active todo/doing ticket.
	KindBump = "bump"

	DefaultMaxAttempts     = 5
	DefaultBumpInterval    = 60 * time.Second
	DefaultBumpIdle        = 5 * time.Minute
	DefaultBumpCooldown    = 15 * time.Minute
	DefaultInflightTTL     = 30 * time.Second
	DefaultKeyPrefix       = "rakazo:taskqueue"
	DefaultDeadLetterLimit = 500
)

var retrySchedule = []time.Duration{
	5 * time.Second,
	15 * time.Second,
	45 * time.Second,
	2 * time.Minute,
	5 * time.Minute,
}

// RetryDelay returns the backoff wait after a failed delivery attempt (1-indexed).
func RetryDelay(attempt int) time.Duration {
	if attempt <= 1 {
		return retrySchedule[0]
	}
	idx := attempt - 1
	if idx >= len(retrySchedule) {
		return retrySchedule[len(retrySchedule)-1]
	}
	return retrySchedule[idx]
}

// Job is one queued ticket wake or bump delivery stored in Redis (or memory).
type Job struct {
	ID          string `json:"id"`
	Kind        string `json:"kind"`
	SpaceID     string `json:"spaceId"`
	TicketID    string `json:"ticketId"`
	BotID       string `json:"botId"`
	Attempt     int    `json:"attempt"`
	MaxAttempts int    `json:"maxAttempts"`
	LastError   string `json:"lastError,omitempty"`
	EnqueuedAt  string `json:"enqueuedAt"`
}

// DispatchRequest is the payload for POST /internal/task-queue/dispatch.
type DispatchRequest struct {
	SpaceID  string `json:"spaceId"`
	TicketID string `json:"ticketId"`
	BotID    string `json:"botId"`
}

// DispatchResponse reports whether a dispatch or bump was queued.
type DispatchResponse struct {
	Queued bool   `json:"queued"`
	Driver string `json:"driver"`
	Reason string `json:"reason,omitempty"`
}

// BumpRequest is the payload for POST /internal/task-queue/bump.
type BumpRequest struct {
	SpaceID  string `json:"spaceId"`
	TicketID string `json:"ticketId"`
	BotID    string `json:"botId"`
	Force    bool   `json:"force,omitempty"`
}

// HealthResponse reports queue driver status and backlog counts.
type HealthResponse struct {
	Enabled   bool   `json:"enabled"`
	Driver    string `json:"driver"`
	Connected bool   `json:"connected"`
	Pending   int64  `json:"pending"`
	Dead      int64  `json:"dead"`
}

// QueueStats summarizes queue sizes.
type QueueStats struct {
	Pending int64
	Dead    int64
}

// QueueStore abstracts Redis vs in-memory storage for delayed dispatch, retries,
// atomic cooldown locks, and dead-letter retention.
type QueueStore interface {
	Driver() string
	Ping(ctx context.Context) error
	Enqueue(ctx context.Context, job Job, dueAt time.Time) error
	PopDue(ctx context.Context, now time.Time, limit int) ([]Job, error)
	PushDead(ctx context.Context, job Job) error
	AcquireLock(ctx context.Context, key string, ttl time.Duration) (bool, error)
	Stats(ctx context.Context) (QueueStats, error)
	Close() error
}

// TicketWakePrompt matches ticketWakePrompt in packages/adapters/src/runs/wakeups/wakes.prompt.ts.
func TicketWakePrompt(ref string) string {
	return fmt.Sprintf(
		"Work on ticket %s. Read it with ticket_get. Keep progress in ticket comments and update its status with ticket_update. Use ask or approval cards when user input is needed.",
		ref,
	)
}

// TicketBumpPrompt nudges an idle bot that still has an open ticket in todo or doing.
func TicketBumpPrompt(ref, title, status string) string {
	return fmt.Sprintf(
		"Reminder: ticket %s (%q) is still in %s and you are not currently working on it. Read it with ticket_get, continue the work, or update its status to blocked, review, or done with ticket_update.",
		ref, title, status,
	)
}
