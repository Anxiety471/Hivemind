package tickets

import (
	"context"
	"encoding/json"
	"errors"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/effects"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/orpc"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/shared"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/validate"
)

const (
	// ticketNumberMax is TICKET_NUMBER_MAX: ticket numbers are stored as PostgreSQL Int values.
	ticketNumberMax = 2_147_483_647
	refMaxLength    = 120
)

var errBadRef = orpc.BadRequest("Invalid ticket reference.")

var ticketRefPattern = regexp.MustCompile(`^([A-Za-z][A-Za-z0-9]*)-([1-9][0-9]*)$`)

// parseTicketRef is parseTicketRef (packages/contracts/src/artifacts/board.ts:34-48): the ref's number when it
// is well formed and carries the expected prefix, compared without case.
func parseTicketRef(value, expectedPrefix string) (int64, bool) {
	match := ticketRefPattern.FindStringSubmatch(validate.JSTrim(value))
	if match == nil {
		return 0, false
	}
	if strings.ToUpper(match[1]) != strings.ToUpper(validate.JSTrim(expectedPrefix)) {
		return 0, false
	}
	number, err := strconv.ParseInt(match[2], 10, 64)
	if err != nil || number > ticketNumberMax {
		return 0, false
	}
	return number, true
}

// FollowBoard is boards.subscribe's start (apps/api/src/routes/boards.ts:97-106): behind the board
// lab like the rest, it listens for the Space's board signals. Without a realtime listener the
// stream stays open and empty.
func FollowBoard(ctx context.Context, database *db.DB, deployment shared.Deployment, actor db.Actor, _ orpc.Input) (<-chan string, func(), *orpc.Error) {
	if err := Gate(ctx, database, deployment, actor); err != nil {
		return nil, nil, shared.Failure(err)
	}
	if deployment.Realtime == nil {
		return nil, func() {}, nil
	}
	signals, stop := deployment.Realtime.Subscribe("board:" + actor.SpaceID)
	return signals, stop, nil
}

// BoardFrame is the BoardEvent a signal stands for (createBoardEvents.follow,
// packages/db/src/artifacts/board-live.ts:33-60): the board and ticket it names, stamped when the
// frame is sent. A payload that is empty or not the expected JSON names neither.
func BoardFrame(actor db.Actor, payload string) any {
	var change struct {
		BoardID  string `json:"boardId"`
		TicketID string `json:"ticketId"`
	}
	if payload != "" {
		if err := json.Unmarshal([]byte(payload), &change); err != nil {
			change.BoardID, change.TicketID = "", ""
		}
	}
	return effects.BoardEvent{
		SpaceID: actor.SpaceID, BoardID: change.BoardID, TicketID: change.TicketID, CreatedAt: shared.ISO(now()),
	}
}

// parseTicketID mirrors z.object({ ticketId: Id }).
func parseTicketID(raw orpc.Input) (string, *orpc.Error) {
	object, issues := validate.Decode(raw.Raw, nil)
	if issues != nil {
		return "", validate.Fail(issues)
	}
	ticketID, problems := validate.String(validate.Path{"ticketId"}, object.Field("ticketId"), validate.StringRules{Min: 1})
	if problems != nil {
		return "", validate.Fail(problems)
	}
	return ticketID, nil
}

// Comments implements tickets.comments (apps/api/src/routes/boards.ts:187-196): a ticket's comments,
// oldest first, each with its author's name.
func Comments(ctx context.Context, database *db.DB, deployment shared.Deployment, actor db.Actor, raw orpc.Input) (any, *orpc.Error) {
	if err := Gate(ctx, database, deployment, actor); err != nil {
		return nil, shared.Failure(err)
	}
	ticketID, failure := parseTicketID(raw)
	if failure != nil {
		return nil, failure
	}
	board, err := openBoard(ctx, database, actor)
	if err != nil {
		return nil, shared.Failure(err)
	}
	comments := []TicketComment{}
	err = database.Tenant(ctx, actor, func(tx pgx.Tx) error {
		var found bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM tickets WHERE id = $1 AND "spaceId" = $2 AND "boardId" = $3)`,
			ticketID, actor.SpaceID, board.ID).Scan(&found); err != nil {
			return err
		}
		if !found {
			return shared.NotFound
		}
		rows, err := tx.Query(ctx, `SELECT c.id, c."ticketId", c.body, c."authorBotId", c."authorUserId",
				COALESCE(b.name, u.name), c."createdAt", c."updatedAt"
			FROM ticket_comments c
			LEFT JOIN bots b ON b.id = c."authorBotId"
			LEFT JOIN "user" u ON u.id = c."authorUserId"
			WHERE c."ticketId" = $1 AND c."spaceId" = $2
			ORDER BY c."createdAt" ASC, c.id ASC`, ticketID, actor.SpaceID)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var (
				comment              TicketComment
				createdAt, updatedAt time.Time
			)
			if err := rows.Scan(&comment.ID, &comment.TicketID, &comment.Body, &comment.AuthorBotID,
				&comment.AuthorUserID, &comment.AuthorName, &createdAt, &updatedAt); err != nil {
				return err
			}
			comment.CreatedAt, comment.UpdatedAt = shared.ISO(createdAt), shared.ISO(updatedAt)
			comments = append(comments, comment)
		}
		return rows.Err()
	})
	if err != nil {
		return nil, shared.Failure(err)
	}
	return comments, nil
}

type getInput struct {
	ID  string
	Ref string
}

// parseGet is GetTicketInput (packages/contracts/src/artifacts/board.ts:122-130): exactly one of id or ref.
func parseGet(raw orpc.Input) (getInput, *orpc.Error) {
	object, issues := validate.Decode(raw.Raw, nil)
	if issues != nil {
		return getInput{}, validate.Fail(issues)
	}
	var (
		out     getInput
		found   []validate.Issue
		aborted bool
	)
	if value, present := object.Get("id"); present {
		id, problems := validate.String(validate.Path{"id"}, value, validate.StringRules{Min: 1})
		found = append(found, problems...)
		if _, ok := value.(string); !ok {
			aborted = true
		}
		out.ID = id
	}
	if value, present := object.Get("ref"); present {
		ref, problems := validate.String(validate.Path{"ref"}, value, validate.StringRules{Trim: true, Min: 1, Max: refMaxLength})
		found = append(found, problems...)
		if _, ok := value.(string); !ok {
			aborted = true
		}
		out.Ref = ref
	}
	if !aborted && (out.ID != "") == (out.Ref != "") {
		found = append(found, validate.Issue{
			"code": "custom", "path": []any{}, "message": "Provide exactly one of id or ref",
		})
	}
	if found != nil {
		return getInput{}, validate.Fail(found)
	}
	return out, nil
}

// Get implements tickets.get (apps/api/src/routes/boards.ts:157-166): one ticket by id or by ref. Like
// the list, the answer says whether it mentions the caller and whom a blocked one waits on.
func Get(ctx context.Context, database *db.DB, deployment shared.Deployment, actor db.Actor, raw orpc.Input) (any, *orpc.Error) {
	if err := Gate(ctx, database, deployment, actor); err != nil {
		return nil, shared.Failure(err)
	}
	input, failure := parseGet(raw)
	if failure != nil {
		return nil, failure
	}
	board, err := openBoard(ctx, database, actor)
	if err != nil {
		return nil, shared.Failure(err)
	}
	var ticket Ticket
	err = database.Tenant(ctx, actor, func(tx pgx.Tx) error {
		var row ticketRow
		var err error
		if input.ID != "" {
			row, err = scanTicket(tx.QueryRow(ctx, `SELECT `+ticketColumns+` FROM tickets
				WHERE id = $1 AND "spaceId" = $2 AND "boardId" = $3`, input.ID, actor.SpaceID, board.ID))
		} else {
			number, ok := parseTicketRef(input.Ref, board.Prefix)
			if !ok {
				return errBadRef
			}
			row, err = scanTicket(tx.QueryRow(ctx, `SELECT `+ticketColumns+` FROM tickets
				WHERE number = $1 AND "spaceId" = $2 AND "boardId" = $3`, number, actor.SpaceID, board.ID))
		}
		if errors.Is(err, pgx.ErrNoRows) {
			return shared.NotFound
		}
		if err != nil {
			return err
		}
		mapped, ok := dto(row, board.Prefix)
		if !ok {
			return errInvalidRow
		}
		ticket = mapped
		var latest *latestTicketComment
		var authorUserID *string
		var body string
		err = tx.QueryRow(ctx, `SELECT "authorUserId", body FROM ticket_comments
			WHERE "spaceId" = $1 AND "ticketId" = $2 ORDER BY "createdAt" DESC, id DESC LIMIT 1`,
			actor.SpaceID, ticket.ID).Scan(&authorUserID, &body)
		if err == nil {
			latest = &latestTicketComment{AuthorUserID: authorUserID, Body: body}
		} else if !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		if ticket.Status == "blocked" {
			bots, err := LoadSpaceBots(ctx, tx, actor.SpaceID)
			if err != nil {
				return err
			}
			ticket.WaitingOnBotIDs = waitingOnBotIDs(ticket, latest, bots)
		}
		return nil
	})
	if errors.Is(err, errInvalidRow) {
		return nil, shared.OutputInvalid()
	}
	if err != nil {
		return nil, shared.Failure(err)
	}
	return ticket, nil
}

var errInvalidRow = errors.New("invalid ticket row")
