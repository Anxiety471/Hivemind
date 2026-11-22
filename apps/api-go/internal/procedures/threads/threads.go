// Package threads ports the thread read-state procedures: threads.head,
// threads.markRead, threads.markUnread and threads.snooze. They resolve the chat
// the way resolveThreadTarget does and touch only plaintext columns: the thread's
// `nextMessageSeq`, event `seq`, message `seq` and the `thread_reads` row. The
// encrypted `threads.historyCompactionSummary`, `messages.blocks` and
// `events.payload` are never selected.
package threads

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/orpc"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/validate"
)

const (
	groupMemberMin        = 2
	maxSnooze             = 366 * 24 * time.Hour
	maxTransactionTries   = 3
	lockedTransactionTime = 20 * time.Second
)

var (
	errIsolation = orpc.NotFound("Resource not found")
	errNotFound  = orpc.NotFound("Not Found")
)

func asFailure(err error) *orpc.Error {
	var failure *orpc.Error
	if errors.As(err, &failure) {
		return failure
	}
	if db.IsUnavailable(err) {
		return orpc.Unavailable()
	}
	return orpc.Internal()
}

// target is a resolved chat: the thread of a bot or a group in the actor's Space.
type target struct{ ThreadID string }

// Target is the validated threadTarget input: exactly one of botId or groupId.
type Target struct{ BotID, GroupID string }

// parseTarget mirrors threadTarget: z.object({ botId: Id.optional(), groupId: Id.optional() })
// refined to exactly one of them. A type error aborts the refinement; a length error does not.
func parseTarget(object *validate.Object) (Target, []validate.Issue) {
	var result Target
	var found []validate.Issue
	aborted := false
	read := func(key string, into *string) {
		value, present := object.Get(key)
		if !present {
			return
		}
		text, problems := validate.String(validate.Path{key}, value, validate.StringRules{Min: 1})
		if _, isString := value.(string); !isString {
			aborted = true
		}
		found = append(found, problems...)
		if problems == nil {
			*into = text
		}
	}
	read("botId", &result.BotID)
	read("groupId", &result.GroupID)
	if !aborted && (result.BotID != "") == (result.GroupID != "") {
		found = append(found, validate.Issue{
			"code": "custom", "path": []any{"botId"}, "message": "Provide exactly one of botId or groupId",
		})
	}
	return result, found
}

// parseWith mirrors threadTarget.and(z.object({ ... })): an intersection reports its
// left side's issues, then its right side's, each parsing the whole input.
func parseWith(raw orpc.Input, right func(*validate.Object) []validate.Issue) (Target, *orpc.Error) {
	object, issues := validate.Decode(raw.Raw, nil)
	if issues != nil {
		if right == nil {
			return Target{}, validate.Fail(issues)
		}
		return Target{}, validate.Fail(append(append([]validate.Issue{}, issues...), issues...))
	}
	result, found := parseTarget(object)
	if right != nil {
		found = append(found, right(object)...)
	}
	if found != nil {
		return Target{}, validate.Fail(found)
	}
	return result, nil
}

// resolve is resolveThreadTarget: the bot's or group's thread in the actor's Space.
// Anything missing, archived or in another Space is NOT_FOUND "Resource not found".
func resolve(ctx context.Context, tx pgx.Tx, actor db.Actor, in Target) (target, error) {
	return resolveWith(ctx, tx, actor, in, false)
}

// resolveWith is resolveThreadTarget with its includeArchived option: a bot resolves archived or
// not as asked, while a group always needs its active members (getGroupTarget, thread-target.ts:389).
func resolveWith(ctx context.Context, tx pgx.Tx, actor db.Actor, in Target, includeArchived bool) (target, error) {
	var threadID *string
	switch {
	case in.BotID != "":
		archived := `AND b."archivedAt" IS NULL`
		if includeArchived {
			archived = ""
		}
		var botID string
		err := tx.QueryRow(ctx, `SELECT b.id, t.id FROM bots b LEFT JOIN threads t ON t."botId" = b.id
			WHERE b.id = $1 AND b."spaceId" = $2 `+archived, in.BotID, actor.SpaceID).Scan(&botID, &threadID)
		if errors.Is(err, pgx.ErrNoRows) {
			return target{}, errIsolation
		}
		if err != nil {
			return target{}, err
		}
	case in.GroupID != "":
		var groupID string
		err := tx.QueryRow(ctx, `SELECT g.id, t.id FROM chat_groups g LEFT JOIN threads t ON t."groupId" = g.id
			WHERE g.id = $1 AND g."spaceId" = $2 AND g."archivedAt" IS NULL`, in.GroupID, actor.SpaceID).Scan(&groupID, &threadID)
		if errors.Is(err, pgx.ErrNoRows) {
			return target{}, errIsolation
		}
		if err != nil {
			return target{}, err
		}
		var members int
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM chat_group_members m JOIN bots b ON b.id = m."botId"
			WHERE m."groupId" = $1 AND b."archivedAt" IS NULL`, groupID).Scan(&members); err != nil {
			return target{}, err
		}
		if members < groupMemberMin {
			return target{}, errIsolation
		}
	default:
		return target{}, errIsolation
	}
	if threadID == nil {
		return target{}, errIsolation
	}
	return target{ThreadID: *threadID}, nil
}

// transactionConflict is a serialization failure or deadlock, which is run again.
func transactionConflict(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && (pgErr.Code == "40001" || pgErr.Code == "40P01")
}

// locked runs fn in a tenant transaction that holds the thread as the TypeScript does
// (a 20 second budget, rerun up to three times on a conflict): withTransactionRetry
// around THREAD_LOCK_TRANSACTION_OPTIONS.
func locked(ctx context.Context, database *db.DB, actor db.Actor, fn func(context.Context, pgx.Tx) error) error {
	var err error
	for attempt := 1; ; attempt++ {
		runCtx, cancel := context.WithTimeout(ctx, lockedTransactionTime)
		err = database.Tenant(runCtx, actor, func(tx pgx.Tx) error { return fn(runCtx, tx) })
		cancel()
		if err == nil || !transactionConflict(err) || attempt >= maxTransactionTries {
			return err
		}
	}
}

// lockThread holds the thread so a clear waits and its seq is the latest
// (lockThread in thread-reads.ts). found is false when the Space has no such thread.
func lockThread(ctx context.Context, tx pgx.Tx, actor db.Actor, threadID string) (nextSeq int32, found bool, err error) {
	err = tx.QueryRow(ctx, `SELECT "nextMessageSeq" FROM threads WHERE id = $1 AND "spaceId" = $2 FOR SHARE`, threadID, actor.SpaceID).Scan(&nextSeq)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, false, nil
	}
	return nextSeq, err == nil, err
}

// Head implements threads.head: the thread id and the newest event seq (-1 for none).
func Head(ctx context.Context, database *db.DB, actor db.Actor, raw orpc.Input) (any, *orpc.Error) {
	in, failure := parseWith(raw, nil)
	if failure != nil {
		return nil, failure
	}
	var result struct {
		ThreadID string `json:"threadId"`
		Cursor   int32  `json:"cursor"`
	}
	err := database.Tenant(ctx, actor, func(tx pgx.Tx) error {
		resolved, err := resolve(ctx, tx, actor, in)
		if err != nil {
			return err
		}
		result.ThreadID, result.Cursor = resolved.ThreadID, -1
		var seq int32
		err = tx.QueryRow(ctx, `SELECT seq FROM events WHERE "threadId" = $1 ORDER BY seq DESC LIMIT 1`, resolved.ThreadID).Scan(&seq)
		if err == nil {
			result.Cursor = seq
		} else if !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		return nil
	})
	if err != nil {
		return nil, asFailure(err)
	}
	return result, nil
}

// MarkRead implements threads.markRead: read the chat up to its latest message and
// report the seq the person had read to before (null when no "New" divider applies).
func MarkRead(ctx context.Context, database *db.DB, actor db.Actor, raw orpc.Input) (any, *orpc.Error) {
	in, failure := parseWith(raw, nil)
	if failure != nil {
		return nil, failure
	}
	var unreadAfter *int32
	err := locked(ctx, database, actor, func(ctx context.Context, tx pgx.Tx) error {
		unreadAfter = nil
		resolved, err := resolve(ctx, tx, actor, in)
		if err != nil {
			return err
		}
		nextSeq, found, err := lockThread(ctx, tx, actor, resolved.ThreadID)
		if err != nil || !found {
			return err
		}
		latest := nextSeq - 1
		// Held until commit, so a Mark as Unread from another tab lands before or after, not lost.
		var unread bool
		var lastRead int32
		var woke *bool
		err = tx.QueryRow(ctx, `SELECT unread, "lastReadSeq", "snoozedUntil" <= now() FROM thread_reads
			WHERE "threadId" = $1 AND "userId" = $2 FOR UPDATE`, resolved.ThreadID, actor.UserID).Scan(&unread, &lastRead, &woke)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		if err != nil {
			return err
		}
		didWake := woke != nil && *woke
		if !unread && !didWake && lastRead >= latest {
			return nil
		}
		// Opening a chat that woke from a snooze ends the snooze.
		if didWake {
			_, err = tx.Exec(ctx, `UPDATE thread_reads SET unread = false, "lastReadSeq" = $3, "snoozedUntil" = NULL WHERE "threadId" = $1 AND "userId" = $2`,
				resolved.ThreadID, actor.UserID, latest)
		} else {
			_, err = tx.Exec(ctx, `UPDATE thread_reads SET unread = false, "lastReadSeq" = $3 WHERE "threadId" = $1 AND "userId" = $2`,
				resolved.ThreadID, actor.UserID, latest)
		}
		if err != nil {
			return err
		}
		// A chat only gets a divider when its unread dot was on, so replies seen live never do.
		if unread && lastRead < latest {
			unreadAfter = &lastRead
		}
		return nil
	})
	if err != nil {
		return nil, asFailure(err)
	}
	return map[string]any{"ok": true, "unreadAfterSeq": unreadAfter}, nil
}

// MarkUnread implements threads.markUnread: with a messageId the divider goes above
// that message; without one the chat is flagged unread where it stands.
func MarkUnread(ctx context.Context, database *db.DB, actor db.Actor, raw orpc.Input) (any, *orpc.Error) {
	var messageID string
	in, failure := parseWith(raw, func(object *validate.Object) []validate.Issue {
		value, present := object.Get("messageId")
		if !present {
			return nil
		}
		text, problems := validate.String(validate.Path{"messageId"}, value, validate.StringRules{Min: 1})
		messageID = text
		return problems
	})
	if failure != nil {
		return nil, failure
	}
	err := locked(ctx, database, actor, func(ctx context.Context, tx pgx.Tx) error {
		resolved, err := resolve(ctx, tx, actor, in)
		if err != nil {
			return err
		}
		nextSeq, found, err := lockThread(ctx, tx, actor, resolved.ThreadID)
		if messageID != "" {
			if err != nil {
				return err
			}
			if !found {
				return errNotFound
			}
			var seq int32
			err := tx.QueryRow(ctx, `SELECT seq FROM messages WHERE id = $1 AND "threadId" = $2`, messageID, resolved.ThreadID).Scan(&seq)
			if errors.Is(err, pgx.ErrNoRows) {
				return errNotFound
			}
			if err != nil {
				return err
			}
			_, err = tx.Exec(ctx, `INSERT INTO thread_reads ("threadId", "userId", "spaceId", unread, "lastReadSeq") VALUES ($1, $2, $3, true, $4)
				ON CONFLICT ("threadId", "userId") DO UPDATE SET unread = true, "lastReadSeq" = EXCLUDED."lastReadSeq"`,
				resolved.ThreadID, actor.UserID, actor.SpaceID, seq-1)
			return err
		}
		if err != nil || !found {
			return err
		}
		// Someone with no read state had read it all.
		_, err = tx.Exec(ctx, `INSERT INTO thread_reads ("threadId", "userId", "spaceId", unread, "lastReadSeq") VALUES ($1, $2, $3, true, $4)
			ON CONFLICT ("threadId", "userId") DO UPDATE SET unread = true`,
			resolved.ThreadID, actor.UserID, actor.SpaceID, nextSeq-1)
		return err
	})
	if err != nil {
		return nil, asFailure(err)
	}
	return map[string]any{"ok": true}, nil
}

// Snooze implements threads.snooze: hide the chat from the caller's list until a time
// within the next year, or wake it with null.
func Snooze(ctx context.Context, database *db.DB, actor db.Actor, raw orpc.Input) (any, *orpc.Error) {
	var until *string
	in, failure := parseWith(raw, func(object *validate.Object) []validate.Issue {
		value, problems := validate.ISODateTime(validate.Path{"until"}, object.Field("until"), true)
		until = value
		return problems
	})
	if failure != nil {
		return nil, failure
	}
	err := locked(ctx, database, actor, func(ctx context.Context, tx pgx.Tx) error {
		resolved, err := resolve(ctx, tx, actor, in)
		if err != nil {
			return err
		}
		if until == nil {
			// No lock: waking a chat only clears the person's own row.
			_, err := tx.Exec(ctx, `UPDATE thread_reads SET "snoozedUntil" = NULL WHERE "threadId" = $1 AND "userId" = $2`, resolved.ThreadID, actor.UserID)
			return err
		}
		wake, err := parseInstant(*until)
		if err != nil {
			return err
		}
		now := time.Now()
		if !wake.After(now) || wake.Sub(now) > maxSnooze {
			return orpc.BadRequest("Pick a time within the next year")
		}
		nextSeq, found, err := lockThread(ctx, tx, actor, resolved.ThreadID)
		if err != nil || !found {
			return err
		}
		// Someone with no read state had read it all.
		_, err = tx.Exec(ctx, `INSERT INTO thread_reads ("threadId", "userId", "spaceId", "lastReadSeq", "snoozedUntil") VALUES ($1, $2, $3, $4, $5)
			ON CONFLICT ("threadId", "userId") DO UPDATE SET "snoozedUntil" = EXCLUDED."snoozedUntil"`,
			resolved.ThreadID, actor.UserID, actor.SpaceID, nextSeq-1, wake.UTC())
		return err
	})
	if err != nil {
		return nil, asFailure(err)
	}
	return map[string]any{"ok": true}, nil
}

// parseInstant is `new Date(text)` for a string z.iso.datetime already accepted:
// millisecond precision (further digits are dropped).
func parseInstant(text string) (time.Time, error) {
	parsed, err := time.Parse(time.RFC3339Nano, text)
	if err != nil {
		return time.Time{}, err
	}
	return parsed.Truncate(time.Millisecond), nil
}
