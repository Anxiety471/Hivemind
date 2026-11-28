package tickets

// Chat questions a settled board ticket leaves behind. This is retireWaitingQuestionsForTicket
// (packages/db/src/threads/ticket-chat-answers.ts) and the settledChatQuestion wiring in
// packages/adapters/src/tasks/ticket-tools.ts: once a ticket is decided, closed, marked done or
// has its pending decision cleared, every run waiting on a single, non-secret, non-approval
// question about that ticket is cancelled with the question answered.
//
// It runs after the ticket write has committed, one thread-locked transaction per run, so no
// ticket row lock is ever held while a thread is locked (the lock order is threads before runs
// and never tickets inside threads). A failure is logged and never fails the ticket write, as the
// TypeScript bestEffort does.

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/contentcrypto"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/events"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/messageblocks"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/shared"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/runs"
)

// settledAnswer is the answer a ticket change gives the questions it settles, or false when the
// change settles none. A completed status wins over a cleared decision, as in ticket-tools.ts.
func settledAnswer(ref string, statusChanged bool, status string, decisionCleared bool) (string, bool) {
	if statusChanged && completedStatus(status) {
		if status == "closed" {
			return "Closed " + ref, true
		}
		return "Marked " + ref + " done", true
	}
	if decisionCleared {
		return "Resolved on " + ref, true
	}
	return "", false
}

// retireChatQuestions retires the questions about ref with answer and logs, never returns, a
// failure: the ticket write has already committed.
func retireChatQuestions(ctx context.Context, database *db.DB, deployment shared.Deployment, actor db.Actor, ref, answer string) {
	if err := RetireWaitingQuestions(ctx, database, deployment, actor, ref, answer); err != nil {
		slog.Default().Warn("retire the chat questions about a settled ticket", "error", err)
	}
}

// waitingRun is a run in the Space waiting for an answer, with the fields a cancel writes.
type waitingRun struct {
	ID       string
	ThreadID string
}

// RetireWaitingQuestions answers and cancels the waiting runs whose only pending questions are
// single asks about ref. A run holding anything else pending (a secret, an approval, a batch, a
// question about another ticket, or a row this release cannot read whole) is left alone, because
// cancelling it would answer those too. Returns after every run was looked at.
func RetireWaitingQuestions(ctx context.Context, database *db.DB, deployment shared.Deployment, actor db.Actor, ticketRef, answer string) error {
	ref := strings.ToLower(strings.TrimSpace(ticketRef))
	answer = strings.TrimSpace(answer)
	if ref == "" || answer == "" {
		return nil
	}
	if deployment.Content == nil {
		return errors.New("tickets: retiring chat questions needs the content key ring")
	}
	vault, err := shared.VaultDeps(deployment.Vault)
	if err != nil {
		return err
	}
	var waiting []waitingRun
	err = database.Tenant(ctx, actor, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `SELECT id, "threadId" FROM runs
			WHERE "spaceId" = $1 AND status = 'waiting_input'`, actor.SpaceID)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var run waitingRun
			if err := rows.Scan(&run.ID, &run.ThreadID); err != nil {
				return err
			}
			waiting = append(waiting, run)
		}
		return rows.Err()
	})
	if err != nil {
		return err
	}
	for _, run := range waiting {
		seq, retired, err := retireRun(ctx, database, deployment, vault, actor, run, ref, answer)
		if err != nil {
			return err
		}
		if !retired {
			continue
		}
		events.NotifyCommitted(ctx, deployment.Events, nil, nil, run.ThreadID, seq, "", "")
		if deployment.Signals != nil {
			deployment.Signals.PublishSpaceChange(actor.SpaceID, "runs")
		}
	}
	return nil
}

// retireRun retires one waiting run in its thread's lock. It returns the seq of the run.cancelled
// event it committed, and false when the run was no longer waiting or held a question it may not
// answer.
func retireRun(
	ctx context.Context,
	database *db.DB,
	deployment shared.Deployment,
	vault *shared.SecretVault,
	actor db.Actor,
	run waitingRun,
	ref, answer string,
) (int32, bool, error) {
	state := vault.Persistence.NewState()
	var seq int32
	var retired bool
	err := runs.ThreadLockTransaction(ctx, database, actor, run.ThreadID, func(ctx context.Context, tx pgx.Tx) error {
		var botID string
		err := tx.QueryRow(ctx, `SELECT "botId" FROM runs
			WHERE id = $1 AND "threadId" = $2 AND "spaceId" = $3 AND status = 'waiting_input'`,
			run.ID, run.ThreadID, actor.SpaceID).Scan(&botID)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		if err != nil {
			return err
		}
		messages, err := botMessagesOfRun(ctx, tx, deployment.Content, run)
		if err != nil {
			return err
		}
		questions, ok := planRetirement(messages, ref, answer)
		if !ok || len(questions) == 0 {
			return nil
		}
		// The run is cancelled first: if it stopped waiting meanwhile, nothing is written.
		cancelled, err := (runs.Canceller{Ring: deployment.Content, Vault: vault.Persistence}).
			CancelActive(ctx, tx, []string{run.ID}, now(), state)
		if err != nil {
			return err
		}
		if len(cancelled) == 0 {
			return nil
		}
		if _, err := tx.Exec(ctx, `UPDATE runs SET checkpoint = NULL WHERE id = $1`, run.ID); err != nil {
			return err
		}
		// A waiting attempt is cancelled too, as retireWaitingQuestionInTransaction does; the
		// general cancel only stops running attempts.
		if _, err := tx.Exec(ctx, `UPDATE attempts SET status = 'cancelled', "finishedAt" = $2
			WHERE "runId" = $1 AND status = 'waiting_input'`,
			append([]any{run.ID}, db.Data(now())...)...); err != nil {
			return err
		}
		for _, question := range questions {
			if err := messageblocks.Write(ctx, tx, deployment.Content, question.id, run.ThreadID,
				messageblocks.JSONValue(question.blocks)); err != nil {
				return err
			}
			if _, err := events.AppendTx(ctx, tx, deployment.Content, events.Input{
				SpaceID: actor.SpaceID, ThreadID: run.ThreadID, BotID: botID, RunID: run.ID,
				Type: "thread.message.updated", AllowCancelledRun: true,
				Payload: map[string]any{
					"messageId": question.id, "role": "bot",
					"blocks": messageblocks.JSONValue(question.blocks),
				},
			}); err != nil {
				return err
			}
		}
		event, err := events.AppendTx(ctx, tx, deployment.Content, events.Input{
			SpaceID: actor.SpaceID, ThreadID: run.ThreadID, BotID: botID, RunID: run.ID,
			Type: "run.cancelled", Payload: map[string]any{},
		})
		if err != nil {
			return err
		}
		seq = event.Seq
		retired = true
		return nil
	})
	vault.Persistence.Finish(ctx, state, err)
	if err != nil {
		return 0, false, fmt.Errorf("retire run %s: %w", run.ID, err)
	}
	return seq, retired, nil
}

// botMessage is one bot message of a run, its blocks opened with the Space key ring.
type botMessage struct {
	id       string
	threadID string
	blocks   any
}

func botMessagesOfRun(ctx context.Context, tx pgx.Tx, ring *contentcrypto.KeyRing, run waitingRun) ([]botMessage, error) {
	rows, err := tx.Query(ctx, `SELECT id, "threadId", blocks FROM messages
		WHERE "threadId" = $1 AND "runId" = $2 AND role = 'bot'`, run.ThreadID, run.ID)
	if err != nil {
		return nil, err
	}
	var messages []botMessage
	for rows.Next() {
		var message botMessage
		if err := rows.Scan(&message.id, &message.threadID, &message.blocks); err != nil {
			rows.Close()
			return nil, err
		}
		messages = append(messages, message)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	opened := make([]map[string]any, len(messages))
	for index, message := range messages {
		opened[index] = map[string]any{"id": message.id, "threadId": message.threadID, "blocks": message.blocks}
	}
	if len(opened) > 0 {
		if err := ring.OpenRows(ctx, "Message", opened); err != nil {
			return nil, err
		}
	}
	for index := range messages {
		messages[index].blocks = opened[index]["blocks"]
	}
	return messages, nil
}

// questionUpdate is one message whose pending questions the retirement answers: its id and the
// whole blocks list with those questions answered.
type questionUpdate struct {
	id     string
	blocks []map[string]any
}

// planRetirement decides what retiring the ticket's questions writes. ok is false when the run
// must be left alone: a message whose blocks are not a list of blocks (readMessageBlocks reports
// it not intact), or any pending question that is not a single, non-secret, non-approval ask about
// ref. Otherwise the returned updates answer exactly the matching questions.
func planRetirement(messages []botMessage, ref, answer string) ([]questionUpdate, bool) {
	var updates []questionUpdate
	for _, message := range messages {
		entries, isList := message.blocks.([]any)
		if !isList {
			return nil, false
		}
		blocks := make([]map[string]any, 0, len(entries))
		pending := false
		for _, entry := range entries {
			block, isBlock := messageblocks.IsBlock(entry)
			if !isBlock {
				return nil, false
			}
			if block["kind"] != "ask" || block["status"] == "answered" {
				blocks = append(blocks, block)
				continue
			}
			if !isSingleTicketQuestion(block, ref) {
				return nil, false
			}
			pending = true
			answered := make(map[string]any, len(block)+2)
			for key, value := range block {
				answered[key] = value
			}
			answered["status"] = "answered"
			answered["answer"] = answer
			blocks = append(blocks, answered)
		}
		if pending {
			updates = append(updates, questionUpdate{id: message.id, blocks: blocks})
		}
	}
	return updates, len(updates) > 0
}

// isSingleTicketQuestion is a pending ask that retirement may answer: about ref, a single question
// (no batch items), and neither a secret nor an approval that holds an external effect.
func isSingleTicketQuestion(block map[string]any, ref string) bool {
	if block["input"] == "secret" {
		return false
	}
	if effect, has := block["approvalEffectId"]; has && effect != nil && effect != "" {
		return false
	}
	if _, batch := block["items"]; batch {
		return false
	}
	ticket, _ := block["ticketRef"].(string)
	return strings.ToLower(strings.TrimSpace(ticket)) == ref
}
