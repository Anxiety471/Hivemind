// Package shared holds what the ported procedures have in common.
package shared

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/contentcrypto"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/effects"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/events"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/orpc"
)

// ISOMillis is Date.prototype.toISOString for a UTC instant.
const ISOMillis = "2006-01-02T15:04:05.000Z"

// ISO formats a database timestamp as toISOString does.
func ISO(at time.Time) string { return at.UTC().Format(ISOMillis) }

// NotFound is the IsolationError the API answers for a row outside the caller's Space.
var NotFound = orpc.NotFound("Resource not found")

// Failure turns an error out of a database call into the response the API gives:
// a failure raised on purpose as is, an unreachable database as 503, anything else 500.
func Failure(err error) *orpc.Error {
	var failure *orpc.Error
	if errors.As(err, &failure) {
		return failure
	}
	if db.IsUnavailable(err) {
		return orpc.Unavailable()
	}
	return orpc.Internal()
}

// OutputInvalid is the failure the router answers when a procedure's result breaks its
// contract schema (a stored value outside an enum, say): a 500 with its own message.
func OutputInvalid() *orpc.Error {
	return orpc.New("INTERNAL_SERVER_ERROR", 500, "Output validation failed")
}

// Deployment is the process configuration some procedures read: where links to the web
// app point, whether the server sends email (which decides whether an invitee must have
// verified theirs before accepting), and the content key ring the encrypted procedures use.
type Deployment struct {
	WebOrigin     string
	EmailDelivery bool
	// InboundEmailDomain is env.inboundEmail?.domain (apps/api/src/env.ts:416): the lowercased
	// INBOUND_EMAIL_DOMAIN, absent when the server receives no email.
	InboundEmailDomain string
	// MaxComputersPerUser is the raw SANDBOX_MAX_COMPUTERS_PER_USER; procedures resolve it
	// per call as resolveMaxComputersPerUser does, because a bad value fails the call, not
	// the process.
	MaxComputersPerUser string
	// Content is the Space key ring (contentcrypto) that seals and opens rkz1 content. It is
	// nil only in tests that never touch an encrypted model.
	Content *contentcrypto.KeyRing
	// Events publishes a committed thread cursor (events.NotifyCommitted). nil in tests that
	// never append a product event.
	Events events.Publisher
	// Signals is the realtime notifier procedures publish organization and board changes
	// through. nil in tests that never publish one.
	Signals *effects.Notifier
	// Realtime delivers the signals other processes publish (board changes, for the board
	// stream). nil when no listener is wired: a stream then stays open and quiet.
	Realtime *events.Fanout
	// BoardLab is TICKET_BOARD_ENABLED: the board feature this deployment turns on for every
	// account (packages/adapters/src/labs-env.ts:4-11).
	BoardLab bool
	// Audit records the audit events a procedure raises itself (recordAuditEvent). nil in tests
	// that never record one.
	Audit *effects.Recorder
	// Waker wakes a ticket's worker bots through the task queue (retries, backoff, coalescing).
	// nil in tests that never wake one.
	Waker TicketWaker
}

// TicketWaker queues a wake for each bot, with a short note saying what changed on the ticket.
// It never fails the write that triggered it: a lost wake is recovered by the queue's retries
// and the idle-bot bump.
type TicketWaker interface {
	WakeWorkers(ctx context.Context, spaceID, ticketID string, botIDs []string, note string)
}

// RequireBot is repos.getBot (packages/db/src/repos.ts:415): a bot of the actor's Space that
// is not archived, or the isolation error. TypeScript reads the whole bot, thread and computer
// rows to answer; the thread's encrypted compaction summary is decrypted on the way and the
// value discarded, so the only observable difference is when that ciphertext is unreadable
// (hook-audit.md R1).
func RequireBot(ctx context.Context, tx pgx.Tx, actor db.Actor, botID string) error {
	var found string
	err := tx.QueryRow(ctx, `SELECT id FROM bots WHERE id = $1 AND "spaceId" = $2 AND "archivedAt" IS NULL`, botID, actor.SpaceID).Scan(&found)
	if errors.Is(err, pgx.ErrNoRows) {
		return NotFound
	}
	return err
}
