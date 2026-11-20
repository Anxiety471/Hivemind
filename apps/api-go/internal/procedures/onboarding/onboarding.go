// Package onboarding ports the first-run focus card procedures: onboarding.promptFocus and
// onboarding.dismissFocus (apps/api/src/onboarding.ts:150-234 over packages/db/src/messages.ts
// and events.ts).
//
// Both write the bot's thread: promptFocus posts one `choice` card, dismissFocus answers the
// thread's first pending `choice`. The card lives in messages.blocks, an rkz1 column, so every
// read opens it with the Space key ring and every write seals it; the event that announces the
// write carries the same blocks in its sealed payload and is followed by the thread's cursor
// signal. Nothing here wakes a run, touches the SecretStore or calls an adapter.
package onboarding

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/contentcrypto"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/effects"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/events"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/orpc"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/messageblocks"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/shared"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/validate"
)

// focusDismissedAnswerID is FOCUS_DISMISSED_ANSWER_ID: the sentinel answerId for a focus card the
// user dismissed without choosing (onboarding.ts:126).
const focusDismissedAnswerID = "_dismissed"

// threadLockTimeout is THREAD_LOCK_TRANSACTION_OPTIONS.timeout (transaction-retry.ts:11): the
// transaction is given 20 seconds, and it is not rerun on a conflict.
const threadLockTimeout = 20 * time.Second

// focusOptions is FOCUS_OPTIONS (onboarding.ts:29-55); the card keeps only id, letter and label.
type focusOption struct{ ID, Letter, Label string }

var focusOptions = []focusOption{
	{"day", "A", "Day-to-day work"},
	{"inbox", "B", "Inbox & email"},
	{"research", "C", "Research & writing"},
	{"everything", "D", "A bit of everything"},
}

// botThread is requireBotThread's answer (apps/api/src/bot-thread.ts:11-20): the bot of the actor's
// Space and its thread. An archived bot still answers, because the lookup does not filter it.
type botThread struct {
	BotID    string
	ThreadID string
	SpaceID  string
}

// requireBotThread is requireBotThread. The thread is read whole, so its encrypted compaction
// summary is decrypted on the way; an unreadable one fails the call, as the Prisma read does.
func requireBotThread(ctx context.Context, tx pgx.Tx, ring *contentcrypto.KeyRing, actor db.Actor, botID string) (botThread, error) {
	var found botThread
	var threadID, spaceID, userID *string
	var summary *string
	err := tx.QueryRow(ctx, `SELECT b.id, t.id, t."spaceId", t."userId", t."historyCompactionSummary"
		FROM bots b LEFT JOIN threads t ON t."botId" = b.id
		WHERE b.id = $1 AND b."spaceId" = $2 LIMIT 1`, botID, actor.SpaceID).
		Scan(&found.BotID, &threadID, &spaceID, &userID, &summary)
	if errors.Is(err, pgx.ErrNoRows) {
		return botThread{}, shared.NotFound
	}
	if err != nil {
		return botThread{}, err
	}
	if threadID == nil || spaceID == nil || userID == nil {
		return botThread{}, shared.NotFound
	}
	found.ThreadID, found.SpaceID = *threadID, *spaceID
	row := map[string]any{
		"id": *threadID, "spaceId": *spaceID, "userId": *userID,
		"historyCompactionSummary": summary,
	}
	if err := ring.OpenRows(ctx, "Thread", []map[string]any{row}); err != nil {
		return botThread{}, err
	}
	return found, nil
}

// parseBotID is z.object({ botId: Id }): a non-empty string.
func parseBotID(raw orpc.Input) (string, *orpc.Error) {
	object, issues := validate.Decode(raw.Raw, nil)
	if issues != nil {
		return "", validate.Fail(issues)
	}
	botID, problems := validate.String(validate.Path{"botId"}, object.Field("botId"), validate.StringRules{Min: 1})
	if problems != nil {
		return "", validate.Fail(problems)
	}
	return botID, nil
}

// locked runs fn in the tenant transaction promptFocus and answerPendingChoice open: the thread
// row is held FOR UPDATE first, for at most 20 seconds, and never rerun.
func locked(ctx context.Context, database *db.DB, actor db.Actor, fn func(context.Context, pgx.Tx) error) error {
	runCtx, cancel := context.WithTimeout(ctx, threadLockTimeout)
	defer cancel()
	return database.Tenant(runCtx, actor, func(tx pgx.Tx) error { return fn(runCtx, tx) })
}

// lockThread is `SELECT id FROM threads WHERE id = $1 FOR UPDATE`; a thread this Space cannot see
// is an error on the update path, as Prisma's P2025 is.
func lockThread(ctx context.Context, tx pgx.Tx, threadID string) error {
	var id string
	err := tx.QueryRow(ctx, `SELECT id FROM threads WHERE id = $1 FOR UPDATE`, threadID).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return errThreadGone
	}
	return err
}

var errThreadGone = errors.New("the thread no longer exists")

// storedMessage is the part of a messages row these procedures read.
type storedMessage struct {
	ID     string
	Role   string
	Blocks any
}

// recentMessages is the tx.message.findMany the two procedures read: every message of the thread
// in createdAt order, with its blocks (opened) and with the encrypted toolHistory left out.
func recentMessages(ctx context.Context, tx pgx.Tx, ring *contentcrypto.KeyRing, threadID string) ([]storedMessage, error) {
	rows, err := tx.Query(ctx, `SELECT id, role, blocks FROM messages WHERE "threadId" = $1 ORDER BY "createdAt" ASC`, threadID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var messages []storedMessage
	for rows.Next() {
		var message storedMessage
		if err := rows.Scan(&message.ID, &message.Role, &message.Blocks); err != nil {
			return nil, err
		}
		messages = append(messages, message)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(messages) == 0 {
		return nil, nil
	}
	open := make([]map[string]any, len(messages))
	for index, message := range messages {
		open[index] = map[string]any{"id": message.ID, "threadId": threadID, "blocks": message.Blocks}
	}
	if err := ring.OpenRows(ctx, "Message", open); err != nil {
		return nil, err
	}
	for index := range messages {
		messages[index].Blocks = open[index]["blocks"]
	}
	return messages, nil
}

// hasBlockKind is messageHasChoiceOrAsk: a stored choice or ask block, whatever its fields.
func hasBlockKind(message storedMessage, kinds ...string) bool {
	for _, block := range messageblocks.Stored(message.Blocks) {
		kind, _ := block["kind"].(string)
		for _, wanted := range kinds {
			if kind == wanted {
				return true
			}
		}
	}
	return false
}

// pendingChoice is `block.kind === "choice" && !block.answerId`: a card the user has not answered.
// JavaScript falsiness decides, so an absent, null, false, zero or empty answer still counts as
// unanswered.
func pendingChoice(block map[string]any) bool {
	if block["kind"] != "choice" {
		return false
	}
	answer, present := block["answerId"]
	return !present || jsFalsy(answer)
}

func jsFalsy(value any) bool {
	switch typed := value.(type) {
	case nil:
		return true
	case bool:
		return !typed
	case string:
		return typed == ""
	case float64:
		return typed == 0
	case json.Number:
		parsed, err := typed.Float64()
		return err == nil && parsed == 0
	}
	return false
}

// hasPendingChoice is messageHasPendingChoice: a choice block the user has not answered.
func hasPendingChoice(message storedMessage) (map[string]any, bool) {
	for _, block := range messageblocks.Stored(message.Blocks) {
		if pendingChoice(block) {
			return block, true
		}
	}
	return nil, false
}

// appendEvent is appendEventInTransaction: the seq is allocated under the thread lock the caller
// already holds, and the payload is sealed for this Space.
func appendEvent(ctx context.Context, tx pgx.Tx, ring *contentcrypto.KeyRing, input events.Input) (events.Event, error) {
	return events.AppendTx(ctx, tx, ring, input)
}

// notifyEvent is deps.events.notify after the transaction committed.
func notifyEvent(ctx context.Context, database *db.DB, deployment shared.Deployment, event events.Event) {
	firstResponse := ""
	if event.FirstResponse && event.RunID != nil {
		firstResponse = *event.RunID
	}
	events.NotifyCommitted(ctx, deployment.Events, slog.Default(), database, event.ThreadID, event.Seq, firstResponse)
}

// createMessage is createThreadMessageInTransaction (packages/db/src/messages.ts:130-168) for the
// fields these procedures pass: the thread's sequence moves first, then the message is written
// with its blocks sealed. markUnread is false here, so no read state changes. The blocks hold no
// steps, so splitToolHistory leaves them and adds no tool history.
func createMessage(ctx context.Context, tx pgx.Tx, ring *contentcrypto.KeyRing, threadID, role string, blocks []map[string]any) (string, error) {
	var nextSeq int32
	err := tx.QueryRow(ctx, `UPDATE threads SET "nextMessageSeq" = "nextMessageSeq" + 1
		WHERE id = $1 RETURNING "nextMessageSeq"`, threadID).Scan(&nextSeq)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", errThreadGone
	}
	if err != nil {
		return "", err
	}
	id := effects.NewID()
	value := messageblocks.JSONValue(blocks)
	sealed, err := ring.SealRow(ctx, "Message", map[string]any{
		"id": id, "threadId": threadID, "blocks": value,
	})
	if err != nil {
		return "", err
	}
	body, err := json.Marshal(sealed["blocks"])
	if err != nil {
		return "", fmt.Errorf("store message blocks: %w", err)
	}
	_, err = tx.Exec(ctx, `INSERT INTO messages
		(id, "threadId", seq, role, blocks, "searchTokens", "createdAt")
		VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)`,
		id, threadID, nextSeq-1, role, string(body), sealed["searchTokens"], now())
	return id, err
}

func now() time.Time { return time.Now().UTC().Truncate(time.Millisecond) }

// choiceBlock is the focus card promptFocus posts: the answerId is absent until the user answers
// or dismisses it.
func choiceBlock() map[string]any {
	options := make([]any, len(focusOptions))
	for index, option := range focusOptions {
		options[index] = map[string]any{"id": option.ID, "letter": option.Letter, "label": option.Label}
	}
	return map[string]any{
		"kind":     "choice",
		"question": "What do you want me on first?",
		"options":  options,
	}
}

// PromptFocus implements onboarding.promptFocus: post the focus card unless the thread already
// asks something, the user has written, or a created-run intro is still going. Nothing is posted
// in those cases and the call still answers ok.
func PromptFocus(ctx context.Context, database *db.DB, deployment shared.Deployment, actor db.Actor, raw orpc.Input) (any, *orpc.Error) {
	botID, failure := parseBotID(raw)
	if failure != nil {
		return nil, failure
	}
	ring := deployment.Content
	if ring == nil {
		return nil, shared.Failure(errNoRing)
	}
	var posted *events.Event
	err := locked(ctx, database, actor, func(ctx context.Context, tx pgx.Tx) error {
		found, err := requireBotThread(ctx, tx, ring, actor, botID)
		if err != nil {
			return err
		}
		if err := lockThread(ctx, tx, found.ThreadID); err != nil {
			return err
		}
		messages, err := recentMessages(ctx, tx, ring, found.ThreadID)
		if err != nil {
			return err
		}
		for _, message := range messages {
			if message.Role == "user" {
				return nil
			}
			if hasBlockKind(message, "choice", "ask") {
				return nil
			}
		}
		var intro string
		err = tx.QueryRow(ctx, `SELECT id FROM runs WHERE "threadId" = $1 AND trigger = 'created'
			AND status NOT IN ('failed', 'cancelled') LIMIT 1`, found.ThreadID).Scan(&intro)
		if err == nil {
			return nil
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		blocks := []map[string]any{choiceBlock()}
		messageID, err := createMessage(ctx, tx, ring, found.ThreadID, "bot", blocks)
		if err != nil {
			return err
		}
		event, err := appendEvent(ctx, tx, ring, events.Input{
			SpaceID: found.SpaceID, ThreadID: found.ThreadID, BotID: found.BotID,
			Type: "thread.message.created",
			Payload: map[string]any{
				"messageId": messageID, "role": "bot", "blocks": messageblocks.JSONValue(blocks),
			},
		})
		if err != nil {
			return err
		}
		posted = &event
		return nil
	})
	if err != nil {
		return nil, shared.Failure(err)
	}
	if posted != nil {
		notifyEvent(ctx, database, deployment, *posted)
	}
	return map[string]any{"ok": true}, nil
}

// DismissFocus implements onboarding.dismissFocus: answer the thread's first pending choice card
// with the dismissed sentinel (answerPendingChoice, onboarding.ts:205-234).
func DismissFocus(ctx context.Context, database *db.DB, deployment shared.Deployment, actor db.Actor, raw orpc.Input) (any, *orpc.Error) {
	botID, failure := parseBotID(raw)
	if failure != nil {
		return nil, failure
	}
	ring := deployment.Content
	if ring == nil {
		return nil, shared.Failure(errNoRing)
	}
	var claimed *events.Event
	err := locked(ctx, database, actor, func(ctx context.Context, tx pgx.Tx) error {
		found, err := requireBotThread(ctx, tx, ring, actor, botID)
		if err != nil {
			return err
		}
		if err := lockThread(ctx, tx, found.ThreadID); err != nil {
			return err
		}
		messages, err := recentMessages(ctx, tx, ring, found.ThreadID)
		if err != nil {
			return err
		}
		for _, message := range messages {
			if _, ok := hasPendingChoice(message); !ok {
				continue
			}
			stored, shown, changed, ok := messageblocks.Rewrite(message.Blocks, func(block map[string]any) (map[string]any, bool) {
				if !pendingChoice(block) {
					return block, false
				}
				next := make(map[string]any, len(block)+1)
				for key, value := range block {
					next[key] = value
				}
				next["answerId"] = focusDismissedAnswerID
				return next, true
			})
			if !ok || !changed {
				return nil
			}
			sealed, err := ring.SealRow(ctx, "Message", map[string]any{
				"id": message.ID, "threadId": found.ThreadID, "blocks": stored,
			})
			if err != nil {
				return err
			}
			body, err := json.Marshal(sealed["blocks"])
			if err != nil {
				return fmt.Errorf("store message blocks: %w", err)
			}
			setTokens := ""
			args := []any{string(body), message.ID}
			if ring.EncryptWrites {
				// The extension seals the write and recomputes the blind index over what it wrote.
				setTokens = `, "searchTokens" = $3`
				args = append(args, sealed["searchTokens"])
			} else {
				// Encryption off, a rewritten message clears its tokens so search reads its text
				// (content-encryption.ts:458-485).
				setTokens = `, "searchTokens" = '{}'`
			}
			if _, err := tx.Exec(ctx, `UPDATE messages SET blocks = $1::jsonb`+setTokens+` WHERE id = $2`, args...); err != nil {
				return err
			}
			event, err := appendEvent(ctx, tx, ring, events.Input{
				SpaceID: found.SpaceID, ThreadID: found.ThreadID, BotID: found.BotID,
				Type: "thread.message.updated",
				Payload: map[string]any{
					"messageId": message.ID, "role": "bot", "blocks": messageblocks.JSONValue(shown),
				},
			})
			if err != nil {
				return err
			}
			claimed = &event
			return nil
		}
		return nil
	})
	if err != nil {
		return nil, shared.Failure(err)
	}
	if claimed != nil {
		notifyEvent(ctx, database, deployment, *claimed)
	}
	return map[string]any{"ok": true}, nil
}

var errNoRing = errors.New("content encryption is not configured")
