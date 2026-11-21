// Package tickets ports tickets.move and tickets.comment (apps/api/src/routes/boards.ts:167-184
// over packages/adapters/src/ticket-tools.ts:207-299 and packages/db/src/board.ts).
//
// Both are behind boardEnabled (routes/context.ts:471-480): TICKET_BOARD_ENABLED for every account,
// else each account's own labs list. The writes are plain tickets/ticket_comments rows; the only
// side effect is the board frame BoardEvents.notify publishes, and neither path wakes a run
// (wakeAssignee is false for a move that changes no assignee and for every comment).
package tickets

import (
	"context"
	"errors"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/effects"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/orpc"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/shared"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/validate"
)

// commentMaxLength is TICKET_COMMENT_MAX_LENGTH (packages/contracts/src/board.ts:26).
const commentMaxLength = 10_000

var (
	// errBoardDisabled is `new ORPCError("NOT_FOUND")`: the lab is off for this account.
	errBoardDisabled = orpc.NotFound("Not Found")
	errTicketMissing = orpc.BadRequest("Ticket not found.")
)

var (
	ticketStatuses   = []string{"todo", "doing", "review", "blocked", "done", "closed"}
	ticketPriorities = []string{"low", "normal", "high", "urgent"}
)

// Completed is isTicketCompletedStatus: done and closed stamp the completion time.
func completedStatus(status string) bool { return status == "done" || status == "closed" }

// Enabled is boardEnabled: the deployment's lab, else the account's own list.
func Enabled(ctx context.Context, tx pgx.Tx, deployment shared.Deployment, userID string) (bool, error) {
	if deployment.BoardLab {
		return true, nil
	}
	var labs []string
	err := tx.QueryRow(ctx, `SELECT labs FROM "user" WHERE id = $1`, userID).Scan(&labs)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, shared.NotFound
	}
	if err != nil {
		return false, err
	}
	for _, lab := range labs {
		if lab == "board" {
			return true, nil
		}
	}
	return false, nil
}

// Board is the part of a boards ticketRow a ticket DTO needs.
type Board struct{ ID, Prefix string }

// EnsureBoard is ensureBoard (packages/db/src/board.ts:12-22): the Space's board, created on first
// use with the Space's name (or "Board"). A concurrent first open is tolerated.
func EnsureBoard(ctx context.Context, tx pgx.Tx, spaceID string) (Board, error) {
	var board Board
	err := tx.QueryRow(ctx, `SELECT id, "ticketPrefix" FROM boards WHERE "spaceId" = $1`, spaceID).Scan(&board.ID, &board.Prefix)
	if err == nil {
		return board, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return Board{}, err
	}
	var spaceName *string
	err = tx.QueryRow(ctx, `SELECT name FROM spaces WHERE id = $1`, spaceID).Scan(&spaceName)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return Board{}, err
	}
	name := "Board"
	if spaceName != nil {
		if trimmed := validate.JSTrim(*spaceName); trimmed != "" {
			name = trimmed
		}
	}
	at := now()
	if _, err := tx.Exec(ctx, `INSERT INTO boards (id, "spaceId", name, "createdAt", "updatedAt")
		VALUES ($1, $2, $3, $4, $4) ON CONFLICT ("spaceId") DO NOTHING`, effects.NewID(), spaceID, name, at); err != nil {
		return Board{}, err
	}
	if err := tx.QueryRow(ctx, `SELECT id, "ticketPrefix" FROM boards WHERE "spaceId" = $1`, spaceID).Scan(&board.ID, &board.Prefix); err != nil {
		return Board{}, err
	}
	return board, nil
}

func now() time.Time { return time.Now().UTC().Truncate(time.Millisecond) }

// Gate is the boardEnabled middleware (routes/context.ts:471-480): the deployment's lab, else the
// account's own list. The route runs it before it parses the input, so bad input against an
// account without the lab is a 404 rather than a 400.
func Gate(ctx context.Context, database *db.DB, deployment shared.Deployment, actor db.Actor) error {
	return database.Tenant(ctx, actor, func(tx pgx.Tx) error {
		enabled, err := Enabled(ctx, tx, deployment, actor.UserID)
		if err != nil {
			return err
		}
		if !enabled {
			return errBoardDisabled
		}
		return nil
	})
}

// openBoard is the route's own first step after the input is parsed: ensureBoard, committed in
// its own transaction before the write it precedes.
func openBoard(ctx context.Context, database *db.DB, actor db.Actor) (Board, error) {
	var board Board
	err := database.Tenant(ctx, actor, func(tx pgx.Tx) error {
		var err error
		board, err = EnsureBoard(ctx, tx, actor.SpaceID)
		return err
	})
	return board, err
}

// Ticket is TicketSchema (packages/contracts/src/artifacts/board.ts).
type Ticket struct {
	ID              string   `json:"id"`
	BoardID         string   `json:"boardId"`
	SpaceID         string   `json:"spaceId"`
	Number          int64    `json:"number"`
	Ref             string   `json:"ref"`
	Title           string   `json:"title"`
	Description     *string  `json:"description"`
	Status          string   `json:"status"`
	Priority        string   `json:"priority"`
	AssigneeBotID   *string  `json:"assigneeBotId"`
	OwnerUserID     *string  `json:"ownerUserId"`
	OwnerBotID      *string  `json:"ownerBotId"`
	WorkerBotIDs    []string `json:"workerBotIds"`
	CreatedByBotID  *string  `json:"createdByBotId"`
	CreatedByUserID *string  `json:"createdByUserId"`
	CreatedAt       string   `json:"createdAt"`
	UpdatedAt       string   `json:"updatedAt"`
	CompletedAt     *string  `json:"completedAt"`
}

// TicketComment is TicketCommentSchema (packages/contracts/src/board.ts:75-85).
type TicketComment struct {
	ID           string  `json:"id"`
	TicketID     string  `json:"ticketId"`
	Body         string  `json:"body"`
	AuthorBotID  *string `json:"authorBotId"`
	AuthorUserID *string `json:"authorUserId"`
	AuthorName   *string `json:"authorName"`
	CreatedAt    string  `json:"createdAt"`
	UpdatedAt    string  `json:"updatedAt"`
}

// ticketRow is one tickets ticketRow as the DTO reads it.
type ticketRow struct {
	ID              string
	BoardID         string
	SpaceID         string
	Number          int64
	Title           string
	Description     *string
	Status          string
	Priority        *string
	AssigneeBotID   *string
	OwnerUserID     *string
	OwnerBotID      *string
	WorkerBotIDs    []string
	CreatedByBotID  *string
	CreatedByUserID *string
	CreatedAt       time.Time
	UpdatedAt       time.Time
	CompletedAt     *time.Time
}

const ticketColumns = `id, "boardId", "spaceId", number, title, description, status, priority, "assigneeBotId",
	"ownerUserId", "ownerBotId", "workerBotIds", "createdByBotId", "createdByUserId", "createdAt", "updatedAt", "completedAt"`

func scanTicket(row pgx.Row) (ticketRow, error) {
	var value ticketRow
	err := row.Scan(&value.ID, &value.BoardID, &value.SpaceID, &value.Number, &value.Title, &value.Description,
		&value.Status, &value.Priority, &value.AssigneeBotID, &value.OwnerUserID, &value.OwnerBotID,
		&value.WorkerBotIDs, &value.CreatedByBotID, &value.CreatedByUserID,
		&value.CreatedAt, &value.UpdatedAt, &value.CompletedAt)
	return value, err
}

func ticketRef(prefix string, number int64) string {
	return prefix + "-" + strconv.FormatInt(number, 10)
}

// coerceStatus and coercePriority are toTicketDto's fallbacks for a legacy stored value.
func coerceStatus(value string) string {
	for _, known := range ticketStatuses {
		if value == known {
			return value
		}
	}
	return "todo"
}

func coercePriority(value *string) string {
	if value == nil {
		return "normal"
	}
	trimmed := validate.JSTrim(*value)
	for _, known := range ticketPriorities {
		if trimmed == known {
			return trimmed
		}
	}
	return "normal"
}

// dto is toTicketDto over a ticketRow.
func dto(value ticketRow, prefix string) (Ticket, bool) {
	workers := value.WorkerBotIDs
	if len(workers) == 0 && value.AssigneeBotID != nil {
		workers = []string{*value.AssigneeBotID}
	}
	if workers == nil {
		workers = []string{}
	}
	assignee := value.AssigneeBotID
	if assignee == nil && len(workers) > 0 {
		first := workers[0]
		assignee = &first
	}
	ticket := Ticket{
		ID: value.ID, BoardID: value.BoardID, SpaceID: value.SpaceID, Number: value.Number,
		Ref: ticketRef(prefix, value.Number), Title: value.Title, Description: value.Description,
		Status: coerceStatus(value.Status), Priority: coercePriority(value.Priority),
		AssigneeBotID: assignee, OwnerUserID: value.OwnerUserID, OwnerBotID: value.OwnerBotID,
		WorkerBotIDs: workers, CreatedByBotID: value.CreatedByBotID,
		CreatedByUserID: value.CreatedByUserID,
		CreatedAt:       shared.ISO(value.CreatedAt), UpdatedAt: shared.ISO(value.UpdatedAt),
	}
	if value.CompletedAt != nil {
		at := shared.ISO(*value.CompletedAt)
		ticket.CompletedAt = &at
	}
	return ticket, ticketValid(ticket)
}

// ticketValid is the router's output parse of TicketSchema: the ids are non-empty when present and
// the number is positive.
func ticketValid(ticket Ticket) bool {
	if ticket.Number <= 0 {
		return false
	}
	for _, id := range []*string{
		ticket.AssigneeBotID,
		ticket.OwnerUserID,
		ticket.OwnerBotID,
		ticket.CreatedByBotID,
		ticket.CreatedByUserID,
	} {
		if id != nil && *id == "" {
			return false
		}
	}
	for _, id := range ticket.WorkerBotIDs {
		if id == "" {
			return false
		}
	}
	return true
}

type moveInput struct {
	ID     string
	Status string
}

// parseMove is MoveTicketInput (packages/contracts/src/board.ts:148-151).
func parseMove(raw orpc.Input) (moveInput, *orpc.Error) {
	object, issues := validate.Decode(raw.Raw, nil)
	if issues != nil {
		return moveInput{}, validate.Fail(issues)
	}
	var found []validate.Issue
	id, problems := validate.String(validate.Path{"id"}, object.Field("id"), validate.StringRules{Min: 1})
	found = append(found, problems...)
	status, problems := validate.Enum(validate.Path{"status"}, object.Field("status"), ticketStatuses...)
	found = append(found, problems...)
	if found != nil {
		return moveInput{}, validate.Fail(found)
	}
	return moveInput{ID: id, Status: status}, nil
}

// Move implements tickets.move: updateTicket with only a status (ticket-tools.ts:207-259 as the
// move route calls it). The assignee is untouched, so nothing wakes.
func Move(ctx context.Context, database *db.DB, deployment shared.Deployment, actor db.Actor, raw orpc.Input) (any, *orpc.Error) {
	// boardEnabled runs before the input parse, as the route's middleware does.
	if err := Gate(ctx, database, deployment, actor); err != nil {
		return nil, shared.Failure(err)
	}
	input, failure := parseMove(raw)
	if failure != nil {
		return nil, failure
	}
	// ensureBoard runs on its own, as it does in TypeScript: a move that then fails leaves the
	// board it created behind.
	board, err := openBoard(ctx, database, actor)
	if err != nil {
		return nil, shared.Failure(err)
	}
	var ticket Ticket
	err = database.Tenant(ctx, actor, func(tx pgx.Tx) error {
		// The ticketRow is held (FOR UPDATE) before it is read, so a concurrent move cannot interleave.
		if _, err := tx.Exec(ctx, `SELECT id FROM tickets WHERE id = $1 AND "spaceId" = $2 FOR UPDATE`,
			input.ID, actor.SpaceID); err != nil {
			return err
		}
		current, err := scanTicket(tx.QueryRow(ctx, `SELECT `+ticketColumns+` FROM tickets
			WHERE id = $1 AND "spaceId" = $2 AND "boardId" = $3`, input.ID, actor.SpaceID, board.ID))
		if errors.Is(err, pgx.ErrNoRows) {
			return errTicketMissing
		}
		if err != nil {
			return err
		}
		// done and closed stamp the first completion; any other status clears it.
		completed := current.CompletedAt
		if completedStatus(input.Status) {
			if completed == nil {
				at := now()
				completed = &at
			}
		} else {
			completed = nil
		}
		updated := now()
		value, err := scanTicket(tx.QueryRow(ctx, `UPDATE tickets SET status = $2, "completedAt" = $3, "updatedAt" = $4
			WHERE id = $1 RETURNING `+ticketColumns, current.ID, input.Status, completed, updated))
		if err != nil {
			return err
		}
		if deployment.Signals != nil {
			deployment.Signals.PublishBoard(actor.SpaceID, board.ID, value.ID)
		}
		ticket, _ = dto(value, board.Prefix)
		return nil
	})
	if err != nil {
		return nil, shared.Failure(err)
	}
	if !ticketValid(ticket) || ticket.ID == "" {
		return nil, shared.OutputInvalid()
	}
	return ticket, nil
}

type commentInput struct {
	TicketID string
	Body     string
}

// parseComment is CommentTicketInput (packages/contracts/src/board.ts:151-156): the body is trimmed
// before it is measured.
func parseComment(raw orpc.Input) (commentInput, *orpc.Error) {
	object, issues := validate.Decode(raw.Raw, nil)
	if issues != nil {
		return commentInput{}, validate.Fail(issues)
	}
	var found []validate.Issue
	ticketID, problems := validate.String(validate.Path{"ticketId"}, object.Field("ticketId"), validate.StringRules{Min: 1})
	found = append(found, problems...)
	body, problems := validate.String(validate.Path{"body"}, object.Field("body"),
		validate.StringRules{Trim: true, Min: 1, Max: commentMaxLength})
	found = append(found, problems...)
	if found != nil {
		return commentInput{}, validate.Fail(found)
	}
	return commentInput{TicketID: ticketID, Body: body}, nil
}

// findTicket is findTicket by id (packages/db/src/board.ts:53-67): the board's ticket in the Space.
func findTicket(ctx context.Context, tx pgx.Tx, spaceID, boardID, ticketID string) (ticketRow, error) {
	value, err := scanTicket(tx.QueryRow(ctx, `SELECT `+ticketColumns+` FROM tickets
		WHERE id = $1 AND "spaceId" = $2 AND "boardId" = $3`, ticketID, spaceID, boardID))
	if errors.Is(err, pgx.ErrNoRows) {
		return ticketRow{}, errTicketMissing
	}
	return value, err
}

// Comment implements tickets.comment: commentTicket (ticket-tools.ts:266-299). The author is the
// signed-in person; no bot authors a comment from this route.
func Comment(ctx context.Context, database *db.DB, deployment shared.Deployment, actor db.Actor, raw orpc.Input) (any, *orpc.Error) {
	// boardEnabled runs before the input parse, as the route's middleware does.
	if err := Gate(ctx, database, deployment, actor); err != nil {
		return nil, shared.Failure(err)
	}
	input, failure := parseComment(raw)
	if failure != nil {
		return nil, failure
	}
	// ensureBoard commits on its own here too, so a comment on an unknown ticket still opens the board.
	board, err := openBoard(ctx, database, actor)
	if err != nil {
		return nil, shared.Failure(err)
	}
	var comment TicketComment
	err = database.Tenant(ctx, actor, func(tx pgx.Tx) error {
		ticket, err := findTicket(ctx, tx, actor.SpaceID, board.ID, input.TicketID)
		if err != nil {
			return err
		}
		id := effects.NewID()
		at := now()
		if _, err := tx.Exec(ctx, `INSERT INTO ticket_comments (id, "ticketId", "spaceId", "authorUserId", body, "createdAt", "updatedAt")
			VALUES ($1, $2, $3, $4, $5, $6, $6)`, id, ticket.ID, actor.SpaceID, actor.UserID,
			shared.StoredText(input.Body), at); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `UPDATE tickets SET "updatedAt" = $2 WHERE id = $1`, ticket.ID, at); err != nil {
			return err
		}
		// The comment's DTO joins the author's name; a person's account is never deleted mid-write.
		var authorName *string
		if err := tx.QueryRow(ctx, `SELECT name FROM "user" WHERE id = $1`, actor.UserID).Scan(&authorName); err != nil {
			return err
		}
		authorID := actor.UserID
		comment = TicketComment{
			ID: id, TicketID: ticket.ID, Body: shared.StoredText(input.Body),
			AuthorUserID: &authorID, AuthorName: authorName,
			CreatedAt: shared.ISO(at), UpdatedAt: shared.ISO(at),
		}
		if deployment.Signals != nil {
			deployment.Signals.PublishBoard(actor.SpaceID, board.ID, ticket.ID)
		}
		return nil
	})
	if err != nil {
		return nil, shared.Failure(err)
	}
	if comment.ID == "" || comment.AuthorUserID == nil || *comment.AuthorUserID == "" {
		return nil, shared.OutputInvalid()
	}
	return comment, nil
}
