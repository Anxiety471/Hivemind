// Command runsproof is the Go side of the Infrastructure B proof.
// tools/infra-b-proof.mts drives it over JSON lines: each request line is
// answered by one response line. It is a test driver, not a service.
package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/contentcrypto"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/effects"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/events"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/jobs"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/runs"
)

type request struct {
	ID    int    `json:"id"`
	Op    string `json:"op"`
	Actor struct {
		SpaceID string `json:"spaceId"`
		UserID  string `json:"userId"`
	} `json:"actor"`

	SpaceID         string         `json:"spaceId"`
	BotID           string         `json:"botId"`
	ThreadID        string         `json:"threadId"`
	UserID          string         `json:"userId"`
	Prompt          string         `json:"prompt"`
	Trigger         string         `json:"trigger"`
	Status          string         `json:"status"`
	ClientNonce     *string        `json:"clientNonce"`
	SourceMessageID *string        `json:"sourceMessageId"`
	RoutineID       *string        `json:"routineId"`
	Model           *runs.ModelPin `json:"model"`
	Now             string         `json:"now"`
	RunID           string         `json:"runId"`
	RunIDs          []string       `json:"runIds"`
	BotIDs          []string       `json:"botIds"`
	KeepRunIDs      []string       `json:"keepRunIds"`
	HelperMessageID *string        `json:"helperMessageId"`
	NoteBotID       string         `json:"noteBotId"`
	NoteText        string         `json:"noteText"`
	At              string         `json:"at"`
	KeepExisting    bool           `json:"keepExisting"`
	Space2          string         `json:"space2Id"`
	WriteNotes      bool           `json:"writeNotes"`
}

type cancelledOut struct {
	ID              string  `json:"id"`
	TaskID          string  `json:"taskId"`
	UserID          string  `json:"userId"`
	SpaceID         string  `json:"spaceId"`
	ThreadID        string  `json:"threadId"`
	BotID           string  `json:"botId"`
	Trigger         string  `json:"trigger"`
	SourceMessageID *string `json:"sourceMessageId"`
	RoutineID       *string `json:"routineId"`
	RoutineName     *string `json:"routineName"`
}

type response struct {
	ID           int             `json:"id"`
	OK           bool            `json:"ok,omitempty"`
	Error        string          `json:"error,omitempty"`
	TaskID       string          `json:"taskId,omitempty"`
	RunID        string          `json:"runId,omitempty"`
	Changed      bool            `json:"changed,omitempty"`
	Cancelled    []cancelledOut  `json:"cancelled,omitempty"`
	EventSeq     *int32          `json:"eventSeq,omitempty"`
	NotesWritten int             `json:"notesWritten,omitempty"`
	Leases       []leaseOut      `json:"leases,omitempty"`
	Found        bool            `json:"found,omitempty"`
	Run          *cancelledOut   `json:"run,omitempty"`
	Status       string          `json:"status,omitempty"`
	RoutineIDs   []string        `json:"-"`
	StoppedCount int             `json:"stoppedHelpers,omitempty"`
	Computers    []computerOut   `json:"computers,omitempty"`
	Raw          json.RawMessage `json:"raw,omitempty"`
}

type leaseOut struct {
	ComputerID string `json:"computerId"`
	BotID      string `json:"botId"`
	RunID      string `json:"runId"`
	Fence      int32  `json:"fence"`
}

type computerOut struct {
	ID          string  `json:"id"`
	HomeKey     *string `json:"homeKey"`
	Kind        string  `json:"kind"`
	ProviderRef *string `json:"providerRef"`
}

func at(value string) (time.Time, error) {
	if value == "" {
		return time.Time{}, nil
	}
	return time.Parse(time.RFC3339Nano, value)
}

func main() {
	ctx := context.Background()
	connectionString := os.Getenv("DATABASE_URL")
	if connectionString == "" {
		fmt.Fprintln(os.Stderr, "DATABASE_URL is required")
		os.Exit(2)
	}
	database, err := db.Open(ctx, connectionString, "rakazo-runs-proof")
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	defer database.Close()

	var ring *contentcrypto.KeyRing
	if os.Getenv("ENCRYPTION_KEY") != "" || os.Getenv("ENCRYPTION_MASTER_KEYS") != "" {
		masters, err := contentcrypto.MasterKeysFromEnv(os.Getenv)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(2)
		}
		provider, err := contentcrypto.NewLocalKeyProvider(masters)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(2)
		}
		store, err := contentcrypto.OpenPgSpaceKeyStore(ctx, database)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(2)
		}
		defer store.Close()
		ring = contentcrypto.NewKeyRing(provider, store, contentcrypto.KeyRingOptions{
			EncryptWrites: os.Getenv("CONTENT_ENCRYPTION") != "off",
		})
	}
	notifier := effects.NewNotifier(database, nil)

	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 1<<20), 1<<20)
	encoder := json.NewEncoder(os.Stdout)
	for scanner.Scan() {
		var in request
		if err := json.Unmarshal(scanner.Bytes(), &in); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(2)
		}
		out := handle(ctx, database, ring, notifier, in)
		out.ID = in.ID
		if err := encoder.Encode(out); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(2)
		}
	}
}

func handle(ctx context.Context, database *db.DB, ring *contentcrypto.KeyRing, notifier *effects.Notifier, in request) response {
	actor := db.Actor{SpaceID: in.Actor.SpaceID, UserID: in.Actor.UserID}
	if actor.SpaceID == "" {
		actor.SpaceID = in.SpaceID
	}
	if actor.UserID == "" {
		actor.UserID = in.UserID
	}
	now, err := at(in.Now)
	if err != nil {
		return response{Error: err.Error()}
	}
	due, err := at(in.At)
	if err != nil {
		return response{Error: err.Error()}
	}
	canceller := runs.Canceller{Ring: ring}
	switch in.Op {
	case "create":
		var created runs.Created
		err := database.Tenant(ctx, actor, func(tx pgx.Tx) error {
			var err error
			created, err = runs.Create(ctx, tx, runs.CreateInput{
				SpaceID: in.SpaceID, BotID: in.BotID, ThreadID: in.ThreadID, UserID: in.UserID,
				Prompt: in.Prompt, Trigger: in.Trigger, Status: in.Status,
				ClientNonce: in.ClientNonce, SourceMessageID: in.SourceMessageID,
				RoutineID: in.RoutineID, Model: in.Model, Now: now,
			})
			return err
		})
		if err != nil {
			return response{Error: err.Error()}
		}
		return response{OK: true, TaskID: created.TaskID, RunID: created.RunID}
	case "wake":
		var changed bool
		err := database.Tenant(ctx, actor, func(tx pgx.Tx) error {
			var err error
			changed, err = runs.Wake(ctx, tx, notifier, in.RunID, runs.WakeOptions{
				At: due, KeepExisting: in.KeepExisting, Now: now,
			})
			return err
		})
		notifier.Wait()
		if err != nil {
			return response{Error: err.Error()}
		}
		return response{OK: true, Changed: changed}
	case "cancelActive":
		var cancelled []runs.Cancelled
		err := database.Tenant(ctx, actor, func(tx pgx.Tx) error {
			var err error
			cancelled, err = canceller.CancelActive(ctx, tx, in.RunIDs, now, nil)
			return err
		})
		if err != nil {
			return response{Error: err.Error()}
		}
		return response{OK: true, Cancelled: cancelledOuts(cancelled)}
	case "supersedeQueued":
		var cancelled []runs.Cancelled
		err := database.Tenant(ctx, actor, func(tx pgx.Tx) error {
			var err error
			cancelled, err = canceller.SupersedeQueued(ctx, tx, in.ThreadID, in.BotIDs, in.KeepRunIDs, now, nil)
			return err
		})
		if err != nil {
			return response{Error: err.Error()}
		}
		return response{OK: true, Cancelled: cancelledOuts(cancelled)}
	case "cancelConversation":
		var result runs.ConversationCancel
		var notesWritten int
		err := database.Tenant(ctx, actor, func(tx pgx.Tx) error {
			target := runs.ConversationTarget{
				SpaceID: in.SpaceID, ThreadID: in.ThreadID, BotIDs: in.BotIDs,
				HelperMessageID: in.HelperMessageID,
			}
			if in.NoteText != "" {
				target.Note = &runs.Note{BotID: in.NoteBotID, Text: in.NoteText}
			}
			spaceID := in.SpaceID
			if spaceID == "" {
				spaceID = actor.SpaceID
			}
			if in.WriteNotes {
				if ring == nil {
					return errors.New("writeNotes needs the content key ring")
				}
				target.WriteNote = func(ctx context.Context, tx pgx.Tx, note runs.Note) (int32, error) {
					notesWritten += 1
					return writeNote(ctx, tx, ring, spaceID, in.ThreadID, note)
				}
			}
			var err error
			result, err = canceller.CancelConversation(ctx, tx, target, now, nil)
			return err
		})
		if err != nil {
			return response{Error: err.Error()}
		}
		out := response{OK: true, Cancelled: cancelledOuts(result.Runs), EventSeq: result.EventSeq, NotesWritten: notesWritten}
		for _, lease := range result.Leases {
			out.Leases = append(out.Leases, leaseOut{lease.ComputerID, lease.BotID, lease.RunID, lease.Fence})
		}
		for _, computer := range result.Computers {
			out.Computers = append(out.Computers, computerOut{computer.ID, computer.HomeKey, computer.Kind, computer.ProviderRef})
		}
		out.StoppedCount = len(result.StoppedHelpers)
		return out
	case "enqueueRoutineWakeup":
		due, err := at(in.At)
		if err != nil || due.IsZero() || in.RoutineID == nil {
			return response{Error: "enqueueRoutineWakeup needs At and routineId"}
		}
		err = database.Tenant(ctx, actor, func(tx pgx.Tx) error {
			return jobs.EnqueueIn(ctx, tx, jobs.RoutineWakeup(*in.RoutineID, due))
		})
		if err != nil {
			return response{Error: err.Error()}
		}
		return response{OK: true}
	case "wakeMany":
		runs.WakeMany(ctx, database, actor, notifier, nil, in.RunIDs)
		notifier.Wait()
		return response{OK: true}
	case "byThreadUserNonce":
		var ref runs.RunRef
		var ok bool
		err := database.Tenant(ctx, actor, func(tx pgx.Tx) error {
			var err error
			ref, ok, err = runs.ByThreadUserNonce(ctx, tx, in.ThreadID, in.UserID, deref(in.ClientNonce))
			return err
		})
		if err != nil {
			return response{Error: err.Error()}
		}
		return response{OK: true, Found: ok, RunID: ref.ID, TaskID: ref.TaskID, Status: ref.Status}
	case "byNonce":
		var ref runs.RunRef
		var ok bool
		err := database.Tenant(ctx, actor, func(tx pgx.Tx) error {
			var err error
			ref, ok, err = runs.ByNonce(ctx, tx, in.SpaceID, deref(in.ClientNonce))
			return err
		})
		if err != nil {
			return response{Error: err.Error()}
		}
		return response{OK: true, Found: ok, RunID: ref.ID, TaskID: ref.TaskID, Status: ref.Status}
	default:
		return response{Error: "unknown op " + in.Op}
	}
}

func cancelledOuts(runs []runs.Cancelled) []cancelledOut {
	out := make([]cancelledOut, 0, len(runs))
	for _, run := range runs {
		out = append(out, cancelledOut{
			ID: run.ID, TaskID: run.TaskID, UserID: run.UserID, SpaceID: run.SpaceID,
			ThreadID: run.ThreadID, BotID: run.BotID, Trigger: run.Trigger,
			SourceMessageID: run.SourceMessageID, RoutineID: run.RoutineID,
			RoutineName: run.RoutineName,
		})
	}
	return out
}

func deref(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

// writeNote is the driver's ConversationTarget.WriteNote: the same two writes
// createThreadMessageInTransaction + appendEventInTransaction make for a system
// note (thread counter, sealed blocks, thread.message.created), returning the
// event seq the cancel uses as its notify cursor. A real stop procedure supplies
// its message helper instead.
func writeNote(
	ctx context.Context,
	tx pgx.Tx,
	ring *contentcrypto.KeyRing,
	spaceID, threadID string,
	note runs.Note,
) (int32, error) {
	var seq int32
	if err := tx.QueryRow(ctx, `UPDATE threads SET "nextMessageSeq" = "nextMessageSeq" + 1
		WHERE id = $1 RETURNING "nextMessageSeq" - 1`, threadID).Scan(&seq); err != nil {
		return 0, err
	}
	messageID := effects.NewID()
	blocks := []any{map[string]any{"kind": "meta", "text": note.Text}}
	sealed, err := ring.SealRow(ctx, "Message", map[string]any{
		"id": messageID, "threadId": threadID, "blocks": blocks,
	})
	if err != nil {
		return 0, err
	}
	blocksJSON, err := json.Marshal(sealed["blocks"])
	if err != nil {
		return 0, err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO messages (id, "threadId", seq, role, blocks, "botId")
		VALUES ($1, $2, $3, 'system', $4::jsonb, $5)`,
		messageID, threadID, seq, string(blocksJSON), note.BotID); err != nil {
		return 0, err
	}
	event, err := events.Append(ctx, tx, ring, events.Input{
		SpaceID:  spaceID,
		ThreadID: threadID,
		BotID:    note.BotID,
		Type:     "thread.message.created",
		Payload:  map[string]any{"messageId": messageID, "role": "system", "blocks": blocks},
	})
	if err != nil {
		return 0, err
	}
	return event.Seq, nil
}
