package computer

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/orpc"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/shared"
)

// historyEvents is COMPUTER_COMMAND_HISTORY_EVENTS (apps/api/src/routes/computer.ts:72).
const historyEvents = 200

var errNoRing = errors.New("content encryption is not configured")

// storedEvent is one events row as the command history reads it.
type storedEvent struct {
	ID, SpaceID, ThreadID, BotID string
	Payload                      any
	CreatedAt                    time.Time
}

// Command is ComputerCommandSchema plus the event's createdAt
// (packages/contracts/src/events.ts:456-465, rpc.ts:944-946).
type Command struct {
	ExecutionID string `json:"executionId"`
	Kind        string `json:"kind"`
	Command     string `json:"command"`
	Cwd         string `json:"cwd"`
	Status      string `json:"status"`
	ExitCode    *int   `json:"exitCode"`
	Output      string `json:"output"`
	Bytes       *int   `json:"bytes,omitempty"`
	CreatedAt   string `json:"createdAt"`
}

// commandKinds is ComputerCommandKind; the statuses are ComputerCommandSchema's enum.
var commandKinds = map[string]bool{
	"shell": true, "write_file": true, "attach_file": true, "open_path": true, "launch_app": true,
}

// Commands implements computer.commands: the bot's last 200 `computer.command` events, reversed,
// with each payload parsed by ComputerCommandSchema (payloads that do not parse are dropped whole)
// and folded so one entry per execution remains (routes/computer.ts:585-601, events.ts:473-478).
func Commands(ctx context.Context, database *db.DB, deployment shared.Deployment, actor db.Actor, raw orpc.Input) (any, *orpc.Error) {
	fields, failure := shared.IDFields(raw, "botId")
	if failure != nil {
		return nil, failure
	}
	ring := deployment.Content
	if ring == nil {
		return nil, shared.Failure(errNoRing)
	}
	commands := []Command{}
	err := database.Tenant(ctx, actor, func(tx pgx.Tx) error {
		// getBot: the bot is the Space's and not archived. TypeScript reads its thread whole, so an
		// unreadable compaction summary fails the call (hook-audit.md R1).
		var botID string
		var threadID, threadSpace, threadUser *string
		var summary *string
		err := tx.QueryRow(ctx, `SELECT b.id, t.id, t."spaceId", t."userId", t."historyCompactionSummary"
			FROM bots b LEFT JOIN threads t ON t."botId" = b.id
			WHERE b.id = $1 AND b."spaceId" = $2 AND b."archivedAt" IS NULL LIMIT 1`,
			fields["botId"], actor.SpaceID).Scan(&botID, &threadID, &threadSpace, &threadUser, &summary)
		if errors.Is(err, pgx.ErrNoRows) {
			return shared.NotFound
		}
		if err != nil {
			return err
		}
		if threadID != nil && threadSpace != nil && threadUser != nil {
			if err := ring.OpenRows(ctx, "Thread", []map[string]any{{
				"id": *threadID, "spaceId": *threadSpace, "userId": *threadUser,
				"historyCompactionSummary": summary,
			}}); err != nil {
				return err
			}
		}
		rows, err := tx.Query(ctx, `SELECT id, "spaceId", "threadId", "botId", payload, "createdAt"
			FROM events WHERE "spaceId" = $1 AND "botId" = $2 AND type = 'computer.command'
			ORDER BY "createdAt" DESC, id DESC LIMIT $3`, actor.SpaceID, botID, historyEvents)
		if err != nil {
			return err
		}
		defer rows.Close()
		var events []storedEvent
		for rows.Next() {
			var event storedEvent
			if err := rows.Scan(&event.ID, &event.SpaceID, &event.ThreadID, &event.BotID, &event.Payload, &event.CreatedAt); err != nil {
				return err
			}
			events = append(events, event)
		}
		if err := rows.Err(); err != nil {
			return err
		}
		// The API takes them newest first and reverses the list before folding it.
		for left, right := 0, len(events)-1; left < right; left, right = left+1, right-1 {
			events[left], events[right] = events[right], events[left]
		}
		open := make([]map[string]any, len(events))
		for index, event := range events {
			open[index] = map[string]any{
				"id": event.ID, "spaceId": event.SpaceID, "threadId": event.ThreadID,
				"botId": event.BotID, "payload": event.Payload,
			}
		}
		if err := ring.OpenRows(ctx, "Event", open); err != nil {
			return err
		}
		for index, event := range events {
			parsed, ok := parseCommand(open[index]["payload"])
			if !ok {
				continue
			}
			parsed.CreatedAt = shared.ISO(event.CreatedAt)
			commands = append(commands, parsed)
		}
		return nil
	})
	if err != nil {
		return nil, shared.Failure(err)
	}
	return foldCommands(commands), nil
}

// parseCommand is ComputerCommandSchema.safeParse: an object whose fields all fit, with unknown
// keys dropped. A payload that fails drops its whole command.
func parseCommand(payload any) (Command, bool) {
	object, ok := payload.(map[string]any)
	if !ok {
		return Command{}, false
	}
	var command Command
	if command.ExecutionID, ok = object["executionId"].(string); !ok {
		return Command{}, false
	}
	if command.Kind, ok = object["kind"].(string); !ok || !commandKinds[command.Kind] {
		return Command{}, false
	}
	if command.Command, ok = object["command"].(string); !ok {
		return Command{}, false
	}
	if command.Cwd, ok = object["cwd"].(string); !ok {
		return Command{}, false
	}
	if command.Status, ok = object["status"].(string); !ok || (command.Status != "running" && command.Status != "done") {
		return Command{}, false
	}
	// exitCode: z.number().int().nullable() — required, and null is accepted.
	exit, present := object["exitCode"]
	if !present {
		return Command{}, false
	}
	if exit != nil {
		value, ok := integerValue(exit)
		if !ok {
			return Command{}, false
		}
		command.ExitCode = &value
	}
	if command.Output, ok = object["output"].(string); !ok {
		return Command{}, false
	}
	// bytes: a nonnegative integer when present; null fails the schema.
	if bytes, present := object["bytes"]; present {
		if bytes == nil {
			return Command{}, false
		}
		value, ok := integerValue(bytes)
		if !ok || value < 0 {
			return Command{}, false
		}
		command.Bytes = &value
	}
	return command, true
}

// integerValue is z.number().int() for a JSON number: an integer that a JavaScript number can
// hold. Values arrive as json.Number from a decrypted payload and as float64 from a jsonb column
// Postgres decoded directly.
func integerValue(value any) (int, bool) {
	switch typed := value.(type) {
	case float64:
		if math.IsInf(typed, 0) || math.IsNaN(typed) || typed != math.Trunc(typed) {
			return 0, false
		}
		if typed < math.MinInt32 || typed > math.MaxInt32 {
			if typed < math.MinInt64 || typed > math.MaxInt64 {
				return 0, false
			}
			return int(typed), true
		}
		return int(typed), true
	case json.Number:
		asFloat, err := typed.Float64()
		if err != nil || math.IsInf(asFloat, 0) || math.IsNaN(asFloat) || asFloat != math.Trunc(asFloat) {
			return 0, false
		}
		exact, err := strconv.ParseInt(typed.String(), 10, 64)
		if err != nil {
			if asFloat < math.MinInt32 || asFloat > math.MaxInt32 {
				return 0, false
			}
			return int(asFloat), true
		}
		return int(exact), true
	case int:
		return typed, true
	case int64:
		return int(typed), true
	}
	return 0, false
}

// foldCommands is foldComputerCommands: one entry per executionId, in start order, and a finished
// command is never replaced by a running one.
func foldCommands(commands []Command) []Command {
	position := make(map[string]int, len(commands))
	folded := make([]Command, 0, len(commands))
	for _, command := range commands {
		index, seen := position[command.ExecutionID]
		if seen && folded[index].Status == "done" && command.Status == "running" {
			continue
		}
		if seen {
			folded[index] = command
			continue
		}
		position[command.ExecutionID] = len(folded)
		folded = append(folded, command)
	}
	return folded
}
