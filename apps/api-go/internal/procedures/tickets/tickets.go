// Package tickets serves the board and its tickets: boards.list, get, rename and subscribe, and
// tickets.list, get, create, update, move, comment and comments (apps/api/src/routes/boards.ts over
// packages/adapters/src/tasks/ticket-tools.ts and packages/db/src/artifacts/board.ts).
//
// All of them are behind boardEnabled (routes/context.ts:471-480): TICKET_BOARD_ENABLED for every account,
// else each account's own labs list. The writes are plain tickets/ticket_comments rows. After the
// board frame BoardEvents.notify publishes, a move to todo, doing or review and every comment wake
// the ticket's worker bots through the Go task queue (Deployment.Waker); done, closed and blocked
// moves wake nobody.
package tickets

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/wtf8"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"golang.org/x/text/cases"
	"golang.org/x/text/language"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/effects"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/orpc"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/shared"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/validate"
)

const (
	titleMaxLength       = 200
	descriptionMaxLength = 20_000
	maxWorkers           = 20
	searchMaxLength      = 200
	// commentMaxLength is TICKET_COMMENT_MAX_LENGTH (packages/contracts/src/board.ts:26).
	commentMaxLength          = 10_000
	decisionOptionCount       = 3
	decisionQuestionMaxLength = 300
	decisionOptionMaxLength   = 160
	decisionAnswerMaxLength   = 2_000
	// pullRequestMaxCount is TICKET_MAX_PULL_REQUESTS and pullRequestURLMaxLength
	// TICKET_PULL_REQUEST_URL_MAX_LENGTH (packages/contracts/src/artifacts/board.ts).
	pullRequestMaxCount     = 10
	pullRequestURLMaxLength = 500
)

var (
	// errBoardDisabled is `new ORPCError("NOT_FOUND")`: the lab is off for this account.
	errBoardDisabled = orpc.NotFound("Not Found")
	errBoardMissing  = orpc.BadRequest("Unknown board.")
	errTicketMissing = orpc.BadRequest("Ticket not found.")
	errBotMissing    = orpc.BadRequest("Unknown bot.")
	errUserMissing   = orpc.BadRequest("Unknown user.")
	// errStoredPullRequests stops an update that would build on a stored list this release cannot
	// read (readStoredTicketPullRequests' "reject"), answered as a 500.
	errStoredPullRequests = errors.New("stored tickets.pullRequests does not match its schema")
)

var (
	ticketStatuses   = []string{"todo", "doing", "review", "blocked", "done", "closed"}
	ticketPriorities = []string{"low", "normal", "high", "urgent"}
	// pullRequestStates is TICKET_PULL_REQUEST_STATES.
	pullRequestStates = []string{"open", "merged", "closed"}
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

// Board is a boards row: the ticket DTO needs its id and prefix, boards.* its whole shape.
type Board struct {
	ID, SpaceID, Name, Prefix string
	NextNumber                int64
	CreatedAt, UpdatedAt      time.Time
}

// BoardColumns is the select list every boards row is read with.
const BoardColumns = `id, "spaceId", name, "ticketPrefix", "nextNumber", "createdAt", "updatedAt"`

// ScanBoard reads one boards row.
func ScanBoard(row pgx.Row) (Board, error) {
	var board Board
	err := row.Scan(&board.ID, &board.SpaceID, &board.Name, &board.Prefix, &board.NextNumber,
		&board.CreatedAt, &board.UpdatedAt)
	return board, err
}

// EnsureBoard is ensureBoard (packages/db/src/board.ts:12-22): the Space's board, created on first
// use with the Space's name (or "Board"). A concurrent first open is tolerated.
func EnsureBoard(ctx context.Context, tx pgx.Tx, spaceID string) (Board, error) {
	var board Board
	board, err := ScanBoard(tx.QueryRow(ctx, `SELECT `+BoardColumns+` FROM boards WHERE "spaceId" = $1`, spaceID))
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
		VALUES ($1, $2, $3, $4, $4) ON CONFLICT ("spaceId") DO NOTHING`,
		db.Data(effects.NewID(), spaceID, name, at)...); err != nil {
		return Board{}, err
	}
	board, err = ScanBoard(tx.QueryRow(ctx, `SELECT `+BoardColumns+` FROM boards WHERE "spaceId" = $1`, spaceID))
	if err != nil {
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

// TicketDecisionOption is one choice on a user decision card.
type TicketDecisionOption struct {
	ID          string `json:"id"`
	Label       string `json:"label"`
	Recommended bool   `json:"recommended,omitempty"`
}

// TicketDecision is TicketDecisionSchema (packages/contracts/src/artifacts/board.ts).
type TicketDecision struct {
	Question   string                 `json:"question"`
	Options    []TicketDecisionOption `json:"options"`
	Answer     string                 `json:"answer,omitempty"`
	AnsweredAt string                 `json:"answeredAt,omitempty"`
}

// TicketDecisionInput is TicketDecisionInputSchema (packages/contracts/src/artifacts/board.ts).
type TicketDecisionInput struct {
	Question    string   `json:"question"`
	Options     []string `json:"options"`
	Recommended string   `json:"recommended"`
}

// NormalizeTicketDecision validates and normalizes a 3-choice decision input into stored form.
func NormalizeTicketDecision(input TicketDecisionInput) (TicketDecision, bool) {
	question := validate.JSTrim(input.Question)
	if question == "" || len([]rune(question)) > decisionQuestionMaxLength || len(input.Options) != decisionOptionCount {
		return TicketDecision{}, false
	}
	seen := make(map[string]bool, decisionOptionCount)
	cleaned := make([]string, 0, decisionOptionCount)
	for _, raw := range input.Options {
		opt := validate.JSTrim(raw)
		if opt == "" || len([]rune(opt)) > decisionOptionMaxLength {
			return TicketDecision{}, false
		}
		lower := strings.ToLower(opt)
		if seen[lower] {
			return TicketDecision{}, false
		}
		seen[lower] = true
		cleaned = append(cleaned, opt)
	}
	recLower := strings.ToLower(validate.JSTrim(input.Recommended))
	if recLower == "" {
		return TicketDecision{}, false
	}
	recIndex := -1
	for i, opt := range cleaned {
		if strings.ToLower(opt) == recLower {
			recIndex = i
			break
		}
	}
	if recIndex < 0 {
		return TicketDecision{}, false
	}
	options := make([]TicketDecisionOption, decisionOptionCount)
	for i, opt := range cleaned {
		options[i] = TicketDecisionOption{
			ID:          fmt.Sprintf("choice-%d", i+1),
			Label:       opt,
			Recommended: i == recIndex,
		}
	}
	return TicketDecision{Question: question, Options: options}, true
}

// Ticket is TicketSchema (packages/contracts/src/artifacts/board.ts).
type Ticket struct {
	ID              string              `json:"id"`
	BoardID         string              `json:"boardId"`
	SpaceID         string              `json:"spaceId"`
	Number          int64               `json:"number"`
	Ref             string              `json:"ref"`
	Title           string              `json:"title"`
	Description     *string             `json:"description"`
	Status          string              `json:"status"`
	Priority        string              `json:"priority"`
	AssigneeBotID   *string             `json:"assigneeBotId"`
	OwnerUserID     *string             `json:"ownerUserId"`
	OwnerBotID      *string             `json:"ownerBotId"`
	WorkerBotIDs    []string            `json:"workerBotIds"`
	CreatedByBotID  *string             `json:"createdByBotId"`
	CreatedByUserID *string             `json:"createdByUserId"`
	CreatedAt       string              `json:"createdAt"`
	UpdatedAt       string              `json:"updatedAt"`
	CompletedAt     *string             `json:"completedAt"`
	Decision        *TicketDecision     `json:"decision,omitempty"`
	PullRequests    []TicketPullRequest `json:"pullRequests"`
	WaitingOnBotIDs []string            `json:"waitingOnBotIds,omitempty"`
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
	Decision        []byte
	PullRequests    []byte
}

const ticketColumns = `id, "boardId", "spaceId", number, title, description, status, priority, "assigneeBotId",
	"ownerUserId", "ownerBotId", "workerBotIds", "createdByBotId", "createdByUserId", "createdAt", "updatedAt", "completedAt", decision,
	"pullRequests"`

func scanTicket(row pgx.Row) (ticketRow, error) {
	var value ticketRow
	err := row.Scan(&value.ID, &value.BoardID, &value.SpaceID, &value.Number, &value.Title, &value.Description,
		&value.Status, &value.Priority, &value.AssigneeBotID, &value.OwnerUserID, &value.OwnerBotID,
		&value.WorkerBotIDs, &value.CreatedByBotID, &value.CreatedByUserID,
		&value.CreatedAt, &value.UpdatedAt, &value.CompletedAt, &value.Decision, &value.PullRequests)
	return value, err
}

func ticketRef(prefix string, number int64) string {
	return prefix + "-" + strconv.FormatInt(number, 10)
}

// pullRequestURLPattern is PULL_REQUEST_URL (packages/contracts/src/artifacts/board.ts), kept to
// the RE2 subset so the Go API normalizes a link exactly as TypeScript does.
var pullRequestURLPattern = regexp.MustCompile(`^https://([a-z0-9.-]+)((?:/[a-z0-9_.~-]+)+?)/(-/)?(pull|pulls|merge_requests|pull-requests)/([1-9][0-9]{0,9})(?:[/?#].*)?$`)

// pullRequestLower is String.prototype.toLowerCase: the Unicode default full lowercase mapping
// (cases.Lower), including the SpecialCasing entries strings.ToLower's simple mapping misses.
var pullRequestLower = cases.Lower(language.Und)

// normalizePullRequestURL is normalizePullRequestUrl: the one form a pull request link is stored
// and matched in (lowercase, https, ending at the number), or false when the text is not a pull
// or merge request link.
func normalizePullRequestURL(value string) (string, bool) {
	text := pullRequestLower.String(validate.JSTrim(value))
	if wtf8.Length(text) > pullRequestURLMaxLength {
		return "", false
	}
	match := pullRequestURLPattern.FindStringSubmatch(text)
	if match == nil {
		return "", false
	}
	return "https://" + match[1] + match[2] + "/" + match[3] + match[4] + "/" + match[5], true
}

// TicketPullRequest is TicketPullRequestSchema (packages/contracts/src/artifacts/board.ts).
type TicketPullRequest struct {
	URL   string `json:"url"`
	State string `json:"state"`
}

// readStoredPullRequests is readTicketPullRequests over a tickets.pullRequests value: a shape this
// release does not know (not an array of objects with a string url and a known state) reads as no
// links at all, the whole list rather than one item at a time. An item's unknown keys are dropped,
// as zod's object strips them. The bool reports whether the stored value matched the schema.
func readStoredPullRequests(raw []byte) ([]TicketPullRequest, bool) {
	value, err := validate.DecodeAny(raw)
	if err != nil {
		return []TicketPullRequest{}, false
	}
	items, ok := value.([]any)
	if !ok {
		return []TicketPullRequest{}, false
	}
	out := make([]TicketPullRequest, 0, len(items))
	for _, item := range items {
		object, ok := item.(*validate.Object)
		if !ok {
			return []TicketPullRequest{}, false
		}
		url, ok := object.Values["url"].(string)
		if !ok {
			return []TicketPullRequest{}, false
		}
		state, ok := object.Values["state"].(string)
		if !ok || !slices.Contains(pullRequestStates, state) {
			return []TicketPullRequest{}, false
		}
		out = append(out, TicketPullRequest{URL: url, State: state})
	}
	return out, true
}

// readTicketPullRequests is the DTO's read: a stored value that does not match shows no links.
func readTicketPullRequests(raw []byte) []TicketPullRequest {
	list, ok := readStoredPullRequests(raw)
	if !ok {
		return []TicketPullRequest{}
	}
	return list
}

// pullRequestInput is one TicketPullRequestInputSchema value after its url was normalized.
type pullRequestInput struct {
	URL   string
	State *string
}

// mergeTicketPullRequests is mergeTicketPullRequests: the input's order with duplicate links
// dropped, each keeping the state the input sets, else the one already recorded, else open.
func mergeTicketPullRequests(current []TicketPullRequest, input []pullRequestInput) []TicketPullRequest {
	known := make(map[string]string, len(current))
	for _, item := range current {
		known[item.URL] = item.State
	}
	seen := make(map[string]bool, len(input))
	out := make([]TicketPullRequest, 0, len(input))
	for _, item := range input {
		if seen[item.URL] {
			continue
		}
		seen[item.URL] = true
		state := "open"
		if item.State != nil {
			state = *item.State
		} else if recorded, ok := known[item.URL]; ok {
			state = recorded
		}
		out = append(out, TicketPullRequest{URL: item.URL, State: state})
	}
	return out
}

// pullRequestMergeFinishesTicket is pullRequestMergeFinishesTicket: the write records a merge the
// ticket did not have, and no linked pull request is left open.
func pullRequestMergeFinishesTicket(before, after []TicketPullRequest) bool {
	merged := make(map[string]bool, len(before))
	for _, item := range before {
		if item.State == "merged" {
			merged[item.URL] = true
		}
	}
	newMerge := false
	for _, item := range after {
		if item.State == "open" {
			return false
		}
		if item.State == "merged" && !merged[item.URL] {
			newMerge = true
		}
	}
	return newMerge
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

func readStoredDecision(raw []byte) *TicketDecision {
	if len(raw) == 0 || string(raw) == "null" {
		return nil
	}
	var d TicketDecision
	if err := json.Unmarshal(raw, &d); err != nil {
		return nil
	}
	if validate.JSTrim(d.Question) == "" || len(d.Options) != decisionOptionCount {
		return nil
	}
	for _, opt := range d.Options {
		if validate.JSTrim(opt.ID) == "" || validate.JSTrim(opt.Label) == "" {
			return nil
		}
	}
	return &d
}

// decisionValue is a tickets.decision payload for an INSERT or UPDATE: NULL stays
// NULL, and stored JSON text is sanitized per leaf as Prisma does for a Json column.
func decisionValue(encoded []byte) any {
	if encoded == nil {
		return nil
	}
	return db.JSONText(string(encoded))
}

// nullableText is a nullable string data value: nil stays NULL, and the string is
// wrapped by db.Data like any other written string.
func nullableText(value *string) any {
	if value == nil {
		return nil
	}
	return *value
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
		Decision:     readStoredDecision(value.Decision),
		PullRequests: readTicketPullRequests(value.PullRequests),
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
// move route calls it). The workers are untouched, but a move to todo, doing or review wakes
// them: the person is asking for the work to be picked up.
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
	var previousStatus string
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
		previousStatus = current.Status
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
		nextDecision := current.Decision
		if input.Status != "blocked" && input.Status != "review" {
			if existing := readStoredDecision(current.Decision); existing != nil && existing.Answer == "" {
				nextDecision = nil
			}
		}
		value, err := scanTicket(tx.QueryRow(ctx, `UPDATE tickets SET status = $2, "completedAt" = $3, "updatedAt" = $4,
			"archivedAt" = CASE WHEN $2 IN ('done', 'closed') THEN "archivedAt" END,
			decision = $5
			WHERE id = $1 RETURNING `+ticketColumns,
			append([]any{current.ID}, db.Data(input.Status, completed, updated, decisionValue(nextDecision))...)...))
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
	if deployment.Waker != nil && previousStatus != ticket.Status && wakesOnStatus(ticket.Status) {
		deployment.Waker.WakeWorkers(ctx, actor.SpaceID, ticket.ID, ticket.WorkerBotIDs,
			"Its status changed to "+ticket.Status+".")
	}
	return ticket, nil
}

// wakesOnStatus is the statuses that ask a worker to pick the ticket up; blocked, done and closed
// ask for nothing.
func wakesOnStatus(status string) bool {
	return status == "todo" || status == "doing" || status == "review"
}

// commentNote is the wake note for a comment: the comment itself, cut to a short excerpt, so the
// bot sees what was said before it reads the thread.
func commentNote(body string) string {
	const limit = 400
	excerpt := []rune(body)
	suffix := ""
	if len(excerpt) > limit {
		excerpt = excerpt[:limit]
		suffix = "…"
	}
	return "A person commented: " + strconv.Quote(string(excerpt)+suffix)
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
	var workers []string
	var mentionedBots []string
	err = database.Tenant(ctx, actor, func(tx pgx.Tx) error {
		ticket, err := findTicket(ctx, tx, actor.SpaceID, board.ID, input.TicketID)
		if err != nil {
			return err
		}
		if mapped, ok := dto(ticket, board.Prefix); ok {
			workers = mapped.WorkerBotIDs
		}
		spaceBots, err := LoadSpaceBots(ctx, tx, actor.SpaceID)
		if err != nil {
			return err
		}
		mentionedBots = ExtractMentionedBotIDs(input.Body, spaceBots, "")
		id := effects.NewID()
		at := now()
		if _, err := tx.Exec(ctx, `INSERT INTO ticket_comments (id, "ticketId", "spaceId", "authorUserId", body, "createdAt", "updatedAt")
			VALUES ($1, $2, $3, $4, $5, $6, $6)`,
			db.Data(id, ticket.ID, actor.SpaceID, actor.UserID, shared.StoredText(input.Body), at)...); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `UPDATE tickets SET "updatedAt" = $2 WHERE id = $1`,
			append([]any{ticket.ID}, db.Data(at)...)...); err != nil {
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
	wakeBotIDs := dedupeIDs(append(workers, mentionedBots...))
	if deployment.Waker != nil && len(wakeBotIDs) > 0 {
		deployment.Waker.WakeWorkers(ctx, actor.SpaceID, input.TicketID, wakeBotIDs, commentNote(input.Body))
	}
	return comment, nil
}

type decideInput struct {
	TicketID     string
	OptionID     *string
	CustomAnswer *string
}

type decideOutput struct {
	Ticket  Ticket        `json:"ticket"`
	Comment TicketComment `json:"comment"`
}

func parseDecide(raw orpc.Input) (decideInput, *orpc.Error) {
	object, issues := validate.Decode(raw.Raw, nil)
	if issues != nil {
		return decideInput{}, validate.Fail(issues)
	}
	var found []validate.Issue
	ticketID, problems := validate.String(validate.Path{"ticketId"}, object.Field("ticketId"), validate.StringRules{Min: 1})
	found = append(found, problems...)
	var optionID *string
	if v := object.Field("optionId"); v != validate.Undefined {
		str, p := validate.String(validate.Path{"optionId"}, v, validate.StringRules{Trim: true, Min: 1, Max: 64})
		found = append(found, p...)
		optionID = &str
	}
	var customAnswer *string
	if v := object.Field("customAnswer"); v != validate.Undefined {
		str, p := validate.String(validate.Path{"customAnswer"}, v, validate.StringRules{Trim: true, Min: 1, Max: decisionAnswerMaxLength})
		found = append(found, p...)
		customAnswer = &str
	}
	if len(found) == 0 && (optionID != nil) == (customAnswer != nil) {
		found = append(found, validate.Issue{
			"code":    "custom",
			"path":    []any{},
			"message": "Provide exactly one of optionId or customAnswer",
		})
	}
	if found != nil {
		return decideInput{}, validate.Fail(found)
	}
	return decideInput{TicketID: ticketID, OptionID: optionID, CustomAnswer: customAnswer}, nil
}

// Decide implements tickets.decide: records the user's choice or free-text reply, moves blocked/review
// tickets back to todo, adds a user comment, and wakes the responsible bots.
func Decide(ctx context.Context, database *db.DB, deployment shared.Deployment, actor db.Actor, raw orpc.Input) (any, *orpc.Error) {
	if err := Gate(ctx, database, deployment, actor); err != nil {
		return nil, shared.Failure(err)
	}
	input, failure := parseDecide(raw)
	if failure != nil {
		return nil, failure
	}
	board, err := openBoard(ctx, database, actor)
	if err != nil {
		return nil, shared.Failure(err)
	}
	var (
		outTicket  Ticket
		outComment TicketComment
		answerText string
		wakeBotIDs []string
	)
	err = database.Tenant(ctx, actor, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `SELECT id FROM tickets WHERE id = $1 AND "spaceId" = $2 FOR UPDATE`,
			input.TicketID, actor.SpaceID); err != nil {
			return err
		}
		current, err := findTicket(ctx, tx, actor.SpaceID, board.ID, input.TicketID)
		if err != nil {
			return err
		}
		existingDecision := readStoredDecision(current.Decision)
		if input.OptionID != nil {
			var matched *TicketDecisionOption
			if existingDecision != nil {
				for i := range existingDecision.Options {
					if existingDecision.Options[i].ID == *input.OptionID {
						matched = &existingDecision.Options[i]
						break
					}
				}
			}
			if matched == nil {
				return orpc.BadRequest("Decision option not found.")
			}
			answerText = matched.Label
		} else {
			answerText = *input.CustomAnswer
		}

		commentBody := answerText
		if existingDecision != nil {
			if input.OptionID != nil {
				commentBody = "> " + existingDecision.Question + "\n\n" + answerText
			} else {
				commentBody = "> " + existingDecision.Question + "\n\nOther: " + answerText
			}
		}

		at := now()
		nextStatus := current.Status
		if current.Status == "blocked" || current.Status == "review" {
			nextStatus = "todo"
		}
		nextDecisionBytes := current.Decision
		if existingDecision != nil {
			updatedDecision := *existingDecision
			updatedDecision.Answer = answerText
			updatedDecision.AnsweredAt = shared.ISO(at)
			encoded, err := wtf8.Marshal(updatedDecision)
			if err != nil {
				return err
			}
			nextDecisionBytes = encoded
		}
		var value ticketRow
		if nextStatus == "todo" {
			value, err = scanTicket(tx.QueryRow(ctx, `UPDATE tickets
				SET status = 'todo', "completedAt" = NULL, "archivedAt" = NULL, decision = $2, "updatedAt" = $3
				WHERE id = $1 RETURNING `+ticketColumns,
				append([]any{current.ID}, db.Data(decisionValue(nextDecisionBytes), at)...)...))
		} else {
			value, err = scanTicket(tx.QueryRow(ctx, `UPDATE tickets
				SET decision = $2, "updatedAt" = $3
				WHERE id = $1 RETURNING `+ticketColumns,
				append([]any{current.ID}, db.Data(decisionValue(nextDecisionBytes), at)...)...))
		}
		if err != nil {
			return err
		}

		commentID := effects.NewID()
		storedBody := shared.StoredText(commentBody)
		if _, err := tx.Exec(ctx, `INSERT INTO ticket_comments (id, "ticketId", "spaceId", "authorUserId", body, "createdAt", "updatedAt")
			VALUES ($1, $2, $3, $4, $5, $6, $6)`,
			db.Data(commentID, current.ID, actor.SpaceID, actor.UserID, storedBody, at)...); err != nil {
			return err
		}
		var authorName *string
		if err := tx.QueryRow(ctx, `SELECT name FROM "user" WHERE id = $1`, actor.UserID).Scan(&authorName); err != nil {
			return err
		}
		authorID := actor.UserID
		outComment = TicketComment{
			ID: commentID, TicketID: current.ID, Body: storedBody,
			AuthorUserID: &authorID, AuthorName: authorName,
			CreatedAt: shared.ISO(at), UpdatedAt: shared.ISO(at),
		}
		outTicket, _ = dto(value, board.Prefix)
		wakeBotIDs = append([]string{}, outTicket.WorkerBotIDs...)
		if len(wakeBotIDs) == 0 && outTicket.OwnerBotID != nil {
			wakeBotIDs = []string{*outTicket.OwnerBotID}
		}
		if deployment.Signals != nil {
			deployment.Signals.PublishBoard(actor.SpaceID, board.ID, current.ID)
		}
		return nil
	})
	if err != nil {
		return nil, shared.Failure(err)
	}
	if !ticketValid(outTicket) || outTicket.ID == "" {
		return nil, shared.OutputInvalid()
	}
	if deployment.Waker != nil && len(wakeBotIDs) > 0 {
		note := strings.Replace(commentNote(answerText), "A person commented: ", "User answered decision: ", 1)
		deployment.Waker.WakeWorkers(ctx, actor.SpaceID, outTicket.ID, wakeBotIDs, note)
	}
	return decideOutput{Ticket: outTicket, Comment: outComment}, nil
}

// SpaceBot is an active bot in a Space used to resolve @mentions on tickets.
type SpaceBot struct {
	ID   string
	Name string
}

// LoadSpaceBots returns all non-archived bots in the Space.
func LoadSpaceBots(ctx context.Context, tx pgx.Tx, spaceID string) ([]SpaceBot, error) {
	rows, err := tx.Query(ctx, `SELECT id, name FROM bots WHERE "spaceId" = $1 AND "archivedAt" IS NULL`, spaceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var bots []SpaceBot
	for rows.Next() {
		var b SpaceBot
		if err := rows.Scan(&b.ID, &b.Name); err != nil {
			return nil, err
		}
		bots = append(bots, b)
	}
	return bots, rows.Err()
}

var (
	nonAlnumRe = regexp.MustCompile(`[^A-Za-z0-9]+`)
)

func botCandidateHandles(name string) []string {
	trimmed := validate.JSTrim(name)
	if trimmed == "" {
		return nil
	}
	primary := trimmed
	for _, sep := range []string{" · ", " - "} {
		if idx := strings.Index(primary, sep); idx > 0 {
			primary = validate.JSTrim(primary[:idx])
			break
		}
	}
	compact := nonAlnumRe.ReplaceAllString(primary, "")
	seen := map[string]bool{}
	var out []string
	for _, c := range []string{trimmed, primary, compact} {
		if len(c) >= 2 && !seen[c] {
			seen[c] = true
			out = append(out, c)
		}
	}
	return out
}

func matchesHandleMention(text, handle string) bool {
	escaped := regexp.QuoteMeta(handle)
	atRe, err := regexp.Compile(`(?i)(?:^|[^\w])@` + escaped + `(?:$|[^\w])`)
	if err == nil && atRe.MatchString(text) {
		return true
	}
	blockedRe, err := regexp.Compile(`(?i)\b(?:blocked|waiting)\s+on\s+@?` + escaped + `(?:$|[^\w])`)
	return err == nil && blockedRe.MatchString(text)
}

// ExtractMentionedBotIDs finds bots in the Space that are @mentioned or named after "blocked/waiting on".
func ExtractMentionedBotIDs(text string, bots []SpaceBot, excludeBotID string) []string {
	if validate.JSTrim(text) == "" {
		return nil
	}
	var matched []string
	for _, bot := range bots {
		if excludeBotID != "" && bot.ID == excludeBotID {
			continue
		}
		for _, handle := range botCandidateHandles(bot.Name) {
			if matchesHandleMention(text, handle) {
				matched = append(matched, bot.ID)
				break
			}
		}
	}
	return dedupeIDs(matched)
}

type latestTicketComment struct {
	AuthorUserID *string
	Body         string
}

// waitingOnBotIDs is the bots a blocked ticket waits on: those @mentioned (or named after
// "blocked/waiting on") in its title, description or latest comment, leaving out its own workers.
func waitingOnBotIDs(t Ticket, latestComment *latestTicketComment, bots []SpaceBot) []string {
	if t.Status != "blocked" {
		return nil
	}
	text := t.Title
	if t.Description != nil {
		text += "\n" + *t.Description
	}
	if latestComment != nil {
		text += "\n" + latestComment.Body
	}
	var waiting []string
	for _, id := range ExtractMentionedBotIDs(text, bots, "") {
		if !slices.Contains(t.WorkerBotIDs, id) {
			waiting = append(waiting, id)
		}
	}
	return waiting
}

// resolveSpaceBoard is resolveSpaceBoard (apps/api/src/routes/boards.ts:19-29): ensures the Space's
// default board and checks an optional explicit boardId against the Space.
func resolveSpaceBoard(ctx context.Context, database *db.DB, actor db.Actor, boardID *string) (Board, error) {
	board, err := openBoard(ctx, database, actor)
	if err != nil {
		return Board{}, err
	}
	if boardID == nil || *boardID == board.ID {
		return board, nil
	}
	var found Board
	err = database.Tenant(ctx, actor, func(tx pgx.Tx) error {
		err := tx.QueryRow(ctx, `SELECT id, "ticketPrefix" FROM boards WHERE id = $1 AND "spaceId" = $2`,
			*boardID, actor.SpaceID).Scan(&found.ID, &found.Prefix)
		if errors.Is(err, pgx.ErrNoRows) {
			return errBoardMissing
		}
		return err
	})
	return found, err
}

func dedupeIDs(ids []string) []string {
	seen := make(map[string]bool, len(ids))
	result := make([]string, 0, len(ids))
	for _, raw := range ids {
		id := validate.JSTrim(raw)
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		result = append(result, id)
	}
	return result
}

func ownBotsInSpace(ctx context.Context, tx pgx.Tx, spaceID, userID string, botIDs []string) (bool, error) {
	unique := dedupeIDs(botIDs)
	if len(unique) == 0 {
		return true, nil
	}
	var count int
	err := tx.QueryRow(ctx, `
		SELECT COUNT(*) FROM bots
		WHERE id = ANY($1)
		  AND "spaceId" = $2
		  AND "userId" = $3
		  AND "archivedAt" IS NULL
	`, unique, spaceID, userID).Scan(&count)
	if err != nil {
		return false, err
	}
	return count == len(unique), nil
}

func userInSpace(ctx context.Context, tx pgx.Tx, spaceID, actingUserID, targetUserID string) (bool, error) {
	if targetUserID == actingUserID {
		return true, nil
	}
	var exists bool
	err := tx.QueryRow(ctx, `
		SELECT EXISTS(
			SELECT 1 FROM space_members
			WHERE "spaceId" = $1 AND "userId" = $2
		)
	`, spaceID, targetUserID).Scan(&exists)
	return exists, err
}

func escapeSearchWildcards(value string) string {
	var b strings.Builder
	b.Grow(len(value))
	for _, r := range value {
		if r == '%' || r == '_' || r == '\\' {
			b.WriteByte('\\')
		}
		b.WriteRune(r)
	}
	return b.String()
}

type listInput struct {
	BoardID       *string
	Status        *string
	AssigneeBotID *string
	WorkerBotID   *string
	OwnerBotID    *string
	OwnerUserID   *string
	Q             *string
	Archived      bool
}

// parseList is ListTicketsInput (packages/contracts/src/artifacts/board.ts:109-117).
func parseList(raw orpc.Input) (listInput, *orpc.Error) {
	object, issues := validate.Decode(raw.Raw, nil)
	if issues != nil {
		return listInput{}, validate.Fail(issues)
	}
	var (
		out   listInput
		found []validate.Issue
	)
	optID := func(key string) *string {
		v := object.Field(key)
		if v == validate.Undefined {
			return nil
		}
		str, problems := validate.String(validate.Path{key}, v, validate.StringRules{Min: 1})
		found = append(found, problems...)
		return &str
	}
	out.BoardID = optID("boardId")
	if v := object.Field("status"); v != validate.Undefined {
		status, problems := validate.Enum(validate.Path{"status"}, v, ticketStatuses...)
		found = append(found, problems...)
		out.Status = &status
	}
	out.AssigneeBotID = optID("assigneeBotId")
	out.WorkerBotID = optID("workerBotId")
	out.OwnerBotID = optID("ownerBotId")
	out.OwnerUserID = optID("ownerUserId")
	if v := object.Field("q"); v != validate.Undefined {
		q, problems := validate.String(validate.Path{"q"}, v, validate.StringRules{Trim: true, Max: searchMaxLength})
		found = append(found, problems...)
		out.Q = &q
	}
	if v := object.Field("archived"); v != validate.Undefined {
		archived, problems := validate.Boolean(validate.Path{"archived"}, v)
		found = append(found, problems...)
		out.Archived = archived
	}
	if found != nil {
		return listInput{}, validate.Fail(found)
	}
	return out, nil
}

// ListOutput is ListTicketsOutput (packages/contracts/src/artifacts/board.ts:120).
type ListOutput struct {
	Tickets []Ticket `json:"tickets"`
}

// List implements tickets.list (apps/api/src/routes/boards.ts:106-156).
func List(ctx context.Context, database *db.DB, deployment shared.Deployment, actor db.Actor, raw orpc.Input) (any, *orpc.Error) {
	if err := Gate(ctx, database, deployment, actor); err != nil {
		return nil, shared.Failure(err)
	}
	input, failure := parseList(raw)
	if failure != nil {
		return nil, failure
	}
	board, err := resolveSpaceBoard(ctx, database, actor, input.BoardID)
	if err != nil {
		return nil, shared.Failure(err)
	}
	tickets := []Ticket{}
	err = database.Tenant(ctx, actor, func(tx pgx.Tx) error {
		clauses := []string{`"spaceId" = $1`, `"boardId" = $2`}
		args := []any{actor.SpaceID, board.ID}
		addArg := func(v any) string {
			args = append(args, v)
			return fmt.Sprintf("$%d", len(args))
		}
		if input.Status != nil {
			p := addArg(*input.Status)
			clauses = append(clauses, fmt.Sprintf("status = %s", p))
		}
		if input.Archived {
			clauses = append(clauses, `"archivedAt" IS NOT NULL`)
		} else {
			clauses = append(clauses, `"archivedAt" IS NULL`)
		}
		if input.AssigneeBotID != nil {
			p := addArg(*input.AssigneeBotID)
			clauses = append(clauses, fmt.Sprintf(`("assigneeBotId" = %s OR %s = ANY("workerBotIds") OR "ownerBotId" = %s)`, p, p, p))
		}
		if input.WorkerBotID != nil {
			p := addArg(*input.WorkerBotID)
			clauses = append(clauses, fmt.Sprintf(`(%s = ANY("workerBotIds") OR "assigneeBotId" = %s)`, p, p))
		}
		if input.OwnerBotID != nil {
			p := addArg(*input.OwnerBotID)
			clauses = append(clauses, fmt.Sprintf(`"ownerBotId" = %s`, p))
		}
		if input.OwnerUserID != nil {
			ownerUser := *input.OwnerUserID
			if ownerUser == "me" {
				ownerUser = actor.UserID
			}
			p := addArg(ownerUser)
			clauses = append(clauses, fmt.Sprintf(`"ownerUserId" = %s`, p))
		}
		if input.Q != nil && *input.Q != "" {
			p := addArg("%" + escapeSearchWildcards(*input.Q) + "%")
			clauses = append(clauses, fmt.Sprintf(`(title ILIKE %s ESCAPE '\' OR COALESCE(description, '') ILIKE %s ESCAPE '\')`, p, p))
		}
		query := `SELECT ` + ticketColumns + ` FROM tickets WHERE ` + strings.Join(clauses, " AND ") + ` ORDER BY "updatedAt" DESC, id DESC`
		// writeaudit:dynamic read: clauses are fixed fragments; args are filters
		rows, err := tx.Query(ctx, query, args...)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			row, err := scanTicket(rows)
			if err != nil {
				return err
			}
			mapped, ok := dto(row, board.Prefix)
			if !ok {
				return errors.New("invalid ticket row")
			}
			tickets = append(tickets, mapped)
		}
		if err := rows.Err(); err != nil {
			return err
		}
		if len(tickets) > 0 {
			ticketIDs := make([]string, len(tickets))
			for i := range tickets {
				ticketIDs[i] = tickets[i].ID
			}
			latestByTicket := make(map[string]*latestTicketComment, len(tickets))
			cRows, err := tx.Query(ctx, `
				SELECT DISTINCT ON ("ticketId") "ticketId", "authorUserId", body
				FROM ticket_comments
				WHERE "spaceId" = $1 AND "ticketId" = ANY($2)
				ORDER BY "ticketId", "createdAt" DESC, id DESC
			`, actor.SpaceID, ticketIDs)
			if err == nil {
				for cRows.Next() {
					var (
						tid          string
						authorUserID *string
						body         string
					)
					if err := cRows.Scan(&tid, &authorUserID, &body); err == nil {
						latestByTicket[tid] = &latestTicketComment{AuthorUserID: authorUserID, Body: body}
					}
				}
				cRows.Close()
			}
			var bots []SpaceBot
			if slices.ContainsFunc(tickets, func(t Ticket) bool { return t.Status == "blocked" }) {
				if bots, err = LoadSpaceBots(ctx, tx, actor.SpaceID); err != nil {
					return err
				}
			}
			for i := range tickets {
				latest := latestByTicket[tickets[i].ID]
				tickets[i].WaitingOnBotIDs = waitingOnBotIDs(tickets[i], latest, bots)
			}
		}
		return nil
	})
	if err != nil {
		if err.Error() == "invalid ticket row" {
			return nil, shared.OutputInvalid()
		}
		return nil, shared.Failure(err)
	}
	return ListOutput{Tickets: tickets}, nil
}

type createInput struct {
	BoardID          *string
	Title            string
	Description      *string
	Priority         string
	HasOwnerUserID   bool
	OwnerUserID      *string
	HasOwnerBotID    bool
	OwnerBotID       *string
	HasWorkerBotIDs  bool
	WorkerBotIDs     []string
	HasAssigneeBotID bool
	AssigneeBotID    *string
	HasDecision      bool
	Decision         *TicketDecision
	HasPullRequests  bool
	PullRequests     []pullRequestInput
}

func parseNullableDecision(object *validate.Object, found *[]validate.Issue) (bool, *TicketDecision) {
	v := object.Field("decision")
	if v == validate.Undefined {
		return false, nil
	}
	if v == nil {
		return true, nil
	}
	path := validate.Path{"decision"}
	obj, ok := v.(*validate.Object)
	if !ok {
		*found = append(*found, validate.Issue{
			"code":    "invalid_type",
			"path":    []any{"decision"},
			"message": "Invalid input: expected object, received " + fmt.Sprintf("%T", v),
		})
		return true, nil
	}
	var local []validate.Issue
	question, p := validate.String(path.With("question"), obj.Field("question"),
		validate.StringRules{Trim: true, Min: 1, Max: decisionQuestionMaxLength})
	local = append(local, p...)

	optsVal := obj.Field("options")
	items, arrProblems := validate.AsArray(path.With("options"), optsVal)
	var options []string
	if arrProblems != nil {
		local = append(local, arrProblems...)
	} else {
		if len(items) < decisionOptionCount {
			local = append(local, validate.Issue{
				"origin":    "array",
				"code":      "too_small",
				"minimum":   decisionOptionCount,
				"inclusive": true,
				"exact":     true,
				"path":      []any{"decision", "options"},
				"message":   fmt.Sprintf("Too small: expected array to have exactly %d items", decisionOptionCount),
			})
		} else if len(items) > decisionOptionCount {
			local = append(local, validate.Issue{
				"origin":    "array",
				"code":      "too_big",
				"maximum":   decisionOptionCount,
				"inclusive": true,
				"exact":     true,
				"path":      []any{"decision", "options"},
				"message":   fmt.Sprintf("Too big: expected array to have exactly %d items", decisionOptionCount),
			})
		}
		for i, item := range items {
			opt, optProblems := validate.String(path.With("options").With(i), item,
				validate.StringRules{Trim: true, Min: 1, Max: decisionOptionMaxLength})
			local = append(local, optProblems...)
			options = append(options, opt)
		}
	}

	recommended, recProblems := validate.String(path.With("recommended"), obj.Field("recommended"),
		validate.StringRules{Trim: true, Min: 1, Max: decisionOptionMaxLength})
	local = append(local, recProblems...)

	if len(local) == 0 {
		normalized, ok := NormalizeTicketDecision(TicketDecisionInput{
			Question:    question,
			Options:     options,
			Recommended: recommended,
		})
		if !ok {
			local = append(local, validate.Issue{
				"code":    "custom",
				"path":    []any{"decision"},
				"message": "Decision must have 3 distinct options and recommended matching one of them.",
			})
		} else {
			return true, &normalized
		}
	}
	*found = append(*found, local...)
	return true, nil
}

func parseNullableOptID(object *validate.Object, key string, found *[]validate.Issue) (bool, *string) {
	v := object.Field(key)
	if v == validate.Undefined {
		return false, nil
	}
	if v == nil {
		return true, nil
	}
	str, problems := validate.String(validate.Path{key}, v, validate.StringRules{Min: 1})
	*found = append(*found, problems...)
	return true, &str
}

func parseWorkerBotIDs(object *validate.Object, found *[]validate.Issue) (bool, []string) {
	v := object.Field("workerBotIds")
	if v == validate.Undefined {
		return false, nil
	}
	path := validate.Path{"workerBotIds"}
	items, problems := validate.AsArray(path, v)
	if problems != nil {
		*found = append(*found, problems...)
		return true, nil
	}
	ids := make([]string, 0, len(items))
	for index, item := range items {
		id, itemProblems := validate.String(path.With(index), item, validate.StringRules{Min: 1})
		*found = append(*found, itemProblems...)
		ids = append(ids, id)
	}
	*found = append(*found, validate.ArrayBounds(path, len(items), 0, maxWorkers)...)
	return true, ids
}

// pullRequestURLMessage is the custom issue TicketPullRequestInputSchema's transform raises.
const pullRequestURLMessage = "Use a pull request link such as https://example.com/owner/repo/pull/12."

// parsePullRequests is `z.array(TicketPullRequestInputSchema).max(TICKET_MAX_PULL_REQUESTS).optional()`:
// each item's url is normalized, and state stays unset when the input leaves it out. An array past
// the limit reports only the length, as zod's size cap stops before the items are parsed.
func parsePullRequests(object *validate.Object, found *[]validate.Issue) (bool, []pullRequestInput) {
	v := object.Field("pullRequests")
	if v == validate.Undefined {
		return false, nil
	}
	path := validate.Path{"pullRequests"}
	items, problems := validate.AsArray(path, v)
	if problems != nil {
		*found = append(*found, problems...)
		return true, nil
	}
	if len(items) > pullRequestMaxCount {
		*found = append(*found, validate.ArrayBounds(path, len(items), 0, pullRequestMaxCount)...)
		return true, nil
	}
	out := make([]pullRequestInput, 0, len(items))
	for index, item := range items {
		itemPath := path.With(index)
		fields, problems := validate.AsObject(item, itemPath)
		if problems != nil {
			*found = append(*found, problems...)
			continue
		}
		var url string
		rawURL, urlProblems := validate.String(itemPath.With("url"), fields.Field("url"),
			validate.StringRules{Max: pullRequestURLMaxLength})
		*found = append(*found, urlProblems...)
		if urlProblems == nil {
			normalized, ok := normalizePullRequestURL(rawURL)
			if !ok {
				*found = append(*found, validate.Issue{
					"code": "custom", "path": itemPath.With("url").Raw(), "message": pullRequestURLMessage,
				})
			} else {
				url = normalized
			}
		}
		var state *string
		if rawState := fields.Field("state"); rawState != validate.Undefined {
			parsed, stateProblems := validate.Enum(itemPath.With("state"), rawState, pullRequestStates...)
			*found = append(*found, stateProblems...)
			state = &parsed
		}
		out = append(out, pullRequestInput{URL: url, State: state})
	}
	return true, out
}

// parseCreate is CreateTicketInput (packages/contracts/src/artifacts/board.ts:133-147).
func parseCreate(raw orpc.Input) (createInput, *orpc.Error) {
	object, issues := validate.Decode(raw.Raw, nil)
	if issues != nil {
		return createInput{}, validate.Fail(issues)
	}
	var (
		out   createInput
		found []validate.Issue
	)
	if v := object.Field("boardId"); v != validate.Undefined {
		boardID, problems := validate.String(validate.Path{"boardId"}, v, validate.StringRules{Min: 1})
		found = append(found, problems...)
		out.BoardID = &boardID
	}
	title, problems := validate.String(validate.Path{"title"}, object.Field("title"),
		validate.StringRules{Trim: true, Min: 1, Max: titleMaxLength})
	found = append(found, problems...)
	out.Title = title
	if v := object.Field("description"); v != validate.Undefined {
		desc, problems := validate.String(validate.Path{"description"}, v, validate.StringRules{Max: descriptionMaxLength})
		found = append(found, problems...)
		out.Description = &desc
	}
	out.Priority = "normal"
	if v := object.Field("priority"); v != validate.Undefined {
		priority, problems := validate.Enum(validate.Path{"priority"}, v, ticketPriorities...)
		found = append(found, problems...)
		out.Priority = priority
	}
	out.HasOwnerUserID, out.OwnerUserID = parseNullableOptID(object, "ownerUserId", &found)
	out.HasOwnerBotID, out.OwnerBotID = parseNullableOptID(object, "ownerBotId", &found)
	out.HasWorkerBotIDs, out.WorkerBotIDs = parseWorkerBotIDs(object, &found)
	out.HasAssigneeBotID, out.AssigneeBotID = parseNullableOptID(object, "assigneeBotId", &found)
	out.HasDecision, out.Decision = parseNullableDecision(object, &found)
	out.HasPullRequests, out.PullRequests = parsePullRequests(object, &found)
	if found == nil && out.OwnerUserID != nil && out.OwnerBotID != nil {
		found = append(found, validate.Issue{
			"code":    "custom",
			"path":    []any{"ownerBotId"},
			"message": "Specify at most one of ownerUserId or ownerBotId",
		})
	}
	if found != nil {
		return createInput{}, validate.Fail(found)
	}
	return out, nil
}

// Create implements tickets.create (apps/api/src/routes/boards.ts:168-183 over
// packages/adapters/src/tasks/ticket-tools.ts:237-314).
func Create(ctx context.Context, database *db.DB, deployment shared.Deployment, actor db.Actor, raw orpc.Input) (any, *orpc.Error) {
	if err := Gate(ctx, database, deployment, actor); err != nil {
		return nil, shared.Failure(err)
	}
	input, failure := parseCreate(raw)
	if failure != nil {
		return nil, failure
	}
	board, err := resolveSpaceBoard(ctx, database, actor, input.BoardID)
	if err != nil {
		return nil, shared.Failure(err)
	}

	var requestedBots []string
	if input.OwnerBotID != nil {
		requestedBots = append(requestedBots, *input.OwnerBotID)
	}
	if input.AssigneeBotID != nil {
		requestedBots = append(requestedBots, *input.AssigneeBotID)
	}
	requestedBots = append(requestedBots, input.WorkerBotIDs...)
	requestedBots = dedupeIDs(requestedBots)

	ownerUserInput := input.OwnerUserID
	if ownerUserInput != nil && *ownerUserInput == "me" {
		me := actor.UserID
		ownerUserInput = &me
	}

	var (
		ownerUserID *string
		ownerBotID  *string
	)
	switch {
	case input.OwnerBotID != nil:
		ownerBotID = input.OwnerBotID
	case ownerUserInput != nil:
		ownerUserID = ownerUserInput
	case input.HasOwnerBotID && input.HasOwnerUserID:
		// Both explicitly null.
	case input.HasOwnerBotID:
		me := actor.UserID
		ownerUserID = &me
	case input.HasOwnerUserID:
		// ownerUserId explicitly null -> no user owner.
	default:
		me := actor.UserID
		ownerUserID = &me
	}

	var workerBotIDs []string
	switch {
	case input.HasWorkerBotIDs:
		workerBotIDs = dedupeIDs(input.WorkerBotIDs)
	case input.HasAssigneeBotID:
		if input.AssigneeBotID != nil {
			workerBotIDs = []string{*input.AssigneeBotID}
		} else {
			workerBotIDs = []string{}
		}
	default:
		workerBotIDs = []string{}
	}
	var assigneeBotID *string
	if len(workerBotIDs) > 0 {
		first := workerBotIDs[0]
		assigneeBotID = &first
	}

	var botsToValidate []string
	if ownerBotID != nil {
		botsToValidate = append(botsToValidate, *ownerBotID)
	}
	botsToValidate = append(botsToValidate, workerBotIDs...)

	var ticket Ticket
	var mentionedBots []string
	err = database.Tenant(ctx, actor, func(tx pgx.Tx) error {
		for _, botID := range requestedBots {
			if err := shared.RequireBot(ctx, tx, actor, botID); err != nil {
				return err
			}
		}
		validBots, err := ownBotsInSpace(ctx, tx, actor.SpaceID, actor.UserID, botsToValidate)
		if err != nil {
			return err
		}
		if !validBots {
			return errBotMissing
		}
		if ownerUserID != nil {
			validUser, err := userInSpace(ctx, tx, actor.SpaceID, actor.UserID, *ownerUserID)
			if err != nil {
				return err
			}
			if !validUser {
				return errUserMissing
			}
		}
		var nextNumber int64
		if err := tx.QueryRow(ctx, `UPDATE boards SET "nextNumber" = "nextNumber" + 1 WHERE id = $1 RETURNING "nextNumber"`,
			board.ID).Scan(&nextNumber); err != nil {
			return err
		}
		number := nextNumber - 1
		var desc *string
		if input.Description != nil {
			stored := shared.StoredText(*input.Description)
			desc = &stored
		}
		// Create starts from no recorded links; an input list is the whole list (mergeTicketPullRequests).
		pullRequests := mergeTicketPullRequests(nil, input.PullRequests)
		// Linking work that already merged records finished work, which waits on no decision.
		finished := pullRequestMergeFinishesTicket(nil, pullRequests)
		var decisionJSON any
		if input.Decision != nil && !finished {
			decisionJSON = db.JSON(*input.Decision)
		}
		pullRequestsJSON := db.JSON(pullRequests)
		at := now()
		status := "todo"
		var completedAt any
		if finished {
			status = "done"
			completedAt = at
		}
		value, err := scanTicket(tx.QueryRow(ctx, `
			INSERT INTO tickets (
				id, "boardId", "spaceId", number, title, description, status, priority,
				"assigneeBotId", "ownerUserId", "ownerBotId", "workerBotIds",
				"createdByBotId", "createdByUserId", "createdAt", "updatedAt", decision, "pullRequests",
				"completedAt"
			)
			VALUES ($1, $2, $3, $4, $5, $6, $16, $7, $8, $9, $10, $11, NULL, $12, $13, $13, $14, $15, $17)
			RETURNING `+ticketColumns,
			db.Data(effects.NewID(), board.ID, actor.SpaceID, number, shared.StoredText(input.Title), nullableText(desc),
				input.Priority, nullableText(assigneeBotID), nullableText(ownerUserID), nullableText(ownerBotID),
				workerBotIDs, actor.UserID, at, decisionJSON, pullRequestsJSON, status, completedAt)...,
		))
		if err != nil {
			return err
		}
		if deployment.Signals != nil {
			deployment.Signals.PublishBoard(actor.SpaceID, board.ID, value.ID)
		}
		ticket, _ = dto(value, board.Prefix)
		if desc != nil {
			if spaceBots, err := LoadSpaceBots(ctx, tx, actor.SpaceID); err == nil {
				mentionedBots = ExtractMentionedBotIDs(*desc, spaceBots, "")
			}
		}
		return nil
	})
	if err != nil {
		return nil, shared.Failure(err)
	}
	if !ticketValid(ticket) || ticket.ID == "" {
		return nil, shared.OutputInvalid()
	}
	wakeBotIDs := dedupeIDs(append(append([]string{}, ticket.WorkerBotIDs...), mentionedBots...))
	if deployment.Waker != nil && len(wakeBotIDs) > 0 {
		note := ""
		if len(ticket.WorkerBotIDs) == 0 && len(mentionedBots) > 0 {
			note = "You were mentioned on this ticket — read it with ticket_get and address what is needed from you."
		}
		deployment.Waker.WakeWorkers(ctx, actor.SpaceID, ticket.ID, wakeBotIDs, note)
	}
	return ticket, nil
}

type updateInput struct {
	ID               string
	HasTitle         bool
	Title            string
	HasDescription   bool
	Description      *string
	HasPriority      bool
	Priority         *string
	HasStatus        bool
	Status           string
	HasOwnerUserID   bool
	OwnerUserID      *string
	HasOwnerBotID    bool
	OwnerBotID       *string
	HasWorkerBotIDs  bool
	WorkerBotIDs     []string
	HasAssigneeBotID bool
	AssigneeBotID    *string
	HasDecision      bool
	Decision         *TicketDecision
	HasPullRequests  bool
	PullRequests     []pullRequestInput
}

// parseUpdate is UpdateTicketInput (packages/contracts/src/artifacts/board.ts:150-165).
func parseUpdate(raw orpc.Input) (updateInput, *orpc.Error) {
	object, issues := validate.Decode(raw.Raw, nil)
	if issues != nil {
		return updateInput{}, validate.Fail(issues)
	}
	var (
		out   updateInput
		found []validate.Issue
	)
	id, problems := validate.String(validate.Path{"id"}, object.Field("id"), validate.StringRules{Min: 1})
	found = append(found, problems...)
	out.ID = id
	if v := object.Field("title"); v != validate.Undefined {
		out.HasTitle = true
		title, problems := validate.String(validate.Path{"title"}, v,
			validate.StringRules{Trim: true, Min: 1, Max: titleMaxLength})
		found = append(found, problems...)
		out.Title = title
	}
	if v := object.Field("description"); v != validate.Undefined {
		out.HasDescription = true
		if v != nil {
			desc, problems := validate.String(validate.Path{"description"}, v,
				validate.StringRules{Max: descriptionMaxLength})
			found = append(found, problems...)
			out.Description = &desc
		}
	}
	if v := object.Field("priority"); v != validate.Undefined {
		out.HasPriority = true
		if v != nil {
			priority, problems := validate.Enum(validate.Path{"priority"}, v, ticketPriorities...)
			found = append(found, problems...)
			out.Priority = &priority
		}
	}
	if v := object.Field("status"); v != validate.Undefined {
		out.HasStatus = true
		status, problems := validate.Enum(validate.Path{"status"}, v, ticketStatuses...)
		found = append(found, problems...)
		out.Status = status
	}
	out.HasOwnerUserID, out.OwnerUserID = parseNullableOptID(object, "ownerUserId", &found)
	out.HasOwnerBotID, out.OwnerBotID = parseNullableOptID(object, "ownerBotId", &found)
	out.HasWorkerBotIDs, out.WorkerBotIDs = parseWorkerBotIDs(object, &found)
	out.HasAssigneeBotID, out.AssigneeBotID = parseNullableOptID(object, "assigneeBotId", &found)
	out.HasDecision, out.Decision = parseNullableDecision(object, &found)
	out.HasPullRequests, out.PullRequests = parsePullRequests(object, &found)
	if found == nil && out.OwnerUserID != nil && out.OwnerBotID != nil {
		found = append(found, validate.Issue{
			"code":    "custom",
			"path":    []any{"ownerBotId"},
			"message": "Specify at most one of ownerUserId or ownerBotId",
		})
	}
	if found != nil {
		return updateInput{}, validate.Fail(found)
	}
	return out, nil
}

// Update implements tickets.update (apps/api/src/routes/boards.ts:184-198 over
// packages/adapters/src/tasks/ticket-tools.ts:316-430).
func Update(ctx context.Context, database *db.DB, deployment shared.Deployment, actor db.Actor, raw orpc.Input) (any, *orpc.Error) {
	if err := Gate(ctx, database, deployment, actor); err != nil {
		return nil, shared.Failure(err)
	}
	input, failure := parseUpdate(raw)
	if failure != nil {
		return nil, failure
	}

	var requestedBots []string
	if input.OwnerBotID != nil {
		requestedBots = append(requestedBots, *input.OwnerBotID)
	}
	if input.AssigneeBotID != nil {
		requestedBots = append(requestedBots, *input.AssigneeBotID)
	}
	requestedBots = append(requestedBots, input.WorkerBotIDs...)
	requestedBots = dedupeIDs(requestedBots)

	ownerUserInput := input.OwnerUserID
	if ownerUserInput != nil && *ownerUserInput == "me" {
		me := actor.UserID
		ownerUserInput = &me
	}

	hasWorkersUpdate := input.HasWorkerBotIDs || input.HasAssigneeBotID
	var nextWorkers []string
	if hasWorkersUpdate {
		if input.HasWorkerBotIDs {
			nextWorkers = dedupeIDs(input.WorkerBotIDs)
		} else if input.AssigneeBotID != nil {
			nextWorkers = []string{*input.AssigneeBotID}
		} else {
			nextWorkers = []string{}
		}
	}

	var botsToValidate []string
	if input.OwnerBotID != nil {
		botsToValidate = append(botsToValidate, *input.OwnerBotID)
	}
	botsToValidate = append(botsToValidate, nextWorkers...)

	// Validate requested bots and owner user before opening the board, matching the TS route order.
	if len(requestedBots) > 0 || len(botsToValidate) > 0 || ownerUserInput != nil {
		if err := database.Tenant(ctx, actor, func(tx pgx.Tx) error {
			for _, botID := range requestedBots {
				if err := shared.RequireBot(ctx, tx, actor, botID); err != nil {
					return err
				}
			}
			validBots, err := ownBotsInSpace(ctx, tx, actor.SpaceID, actor.UserID, botsToValidate)
			if err != nil {
				return err
			}
			if !validBots {
				return errBotMissing
			}
			if ownerUserInput != nil {
				validUser, err := userInSpace(ctx, tx, actor.SpaceID, actor.UserID, *ownerUserInput)
				if err != nil {
					return err
				}
				if !validUser {
					return errUserMissing
				}
			}
			return nil
		}); err != nil {
			return nil, shared.Failure(err)
		}
	}

	board, err := openBoard(ctx, database, actor)
	if err != nil {
		return nil, shared.Failure(err)
	}

	var (
		ticket        Ticket
		addedWorkers  []string
		mentionedBots []string
		statusChanged bool
	)
	err = database.Tenant(ctx, actor, func(tx pgx.Tx) error {
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

		prevWorkers := map[string]bool{}
		if len(current.WorkerBotIDs) > 0 {
			for _, id := range current.WorkerBotIDs {
				prevWorkers[id] = true
			}
		} else if current.AssigneeBotID != nil {
			prevWorkers[*current.AssigneeBotID] = true
		}

		title := current.Title
		if input.HasTitle {
			title = shared.StoredText(input.Title)
		}
		description := current.Description
		if input.HasDescription {
			if input.Description != nil {
				stored := shared.StoredText(*input.Description)
				description = &stored
			} else {
				description = nil
			}
		}
		priority := coercePriority(current.Priority)
		if input.HasPriority {
			if input.Priority != nil {
				priority = *input.Priority
			} else {
				priority = "normal"
			}
		}
		ownerUserID := current.OwnerUserID
		ownerBotID := current.OwnerBotID
		if input.HasOwnerBotID || input.HasOwnerUserID {
			switch {
			case input.OwnerBotID != nil:
				ownerBotID = input.OwnerBotID
				ownerUserID = nil
			case ownerUserInput != nil:
				ownerUserID = ownerUserInput
				ownerBotID = nil
			default:
				if input.HasOwnerBotID {
					ownerBotID = nil
				}
				if input.HasOwnerUserID {
					ownerUserID = nil
				}
			}
		}
		workerBotIDs := current.WorkerBotIDs
		if workerBotIDs == nil {
			workerBotIDs = []string{}
		}
		assigneeBotID := current.AssigneeBotID
		if hasWorkersUpdate {
			workerBotIDs = nextWorkers
			if len(nextWorkers) > 0 {
				first := nextWorkers[0]
				assigneeBotID = &first
			} else {
				assigneeBotID = nil
			}
			for _, id := range nextWorkers {
				if !prevWorkers[id] {
					addedWorkers = append(addedWorkers, id)
				}
			}
		}

		// A provided list replaces the recorded one; a stored shape this release cannot read stops
		// the write (readStoredTicketPullRequests' "reject"), and an absent list leaves the column.
		var pullRequestsValue any
		finished := false
		if input.HasPullRequests {
			stored, ok := readStoredPullRequests(current.PullRequests)
			if !ok {
				return errStoredPullRequests
			}
			next := mergeTicketPullRequests(stored, input.PullRequests)
			pullRequestsValue = db.JSON(next)
			// Recording a merge that leaves nothing open finishes the ticket, as the webhook does,
			// unless the same write sets a status itself.
			finished = !input.HasStatus && !completedStatus(coerceStatus(current.Status)) &&
				pullRequestMergeFinishesTicket(stored, next)
		}

		status := current.Status
		completedAt := current.CompletedAt
		if input.HasStatus || finished {
			if input.HasStatus {
				statusChanged = input.Status != current.Status
				status = input.Status
			} else {
				status = "done"
			}
			if completedStatus(status) {
				if completedAt == nil {
					at := now()
					completedAt = &at
				}
			} else {
				completedAt = nil
			}
		}

		nextDecision := current.Decision
		if input.HasDecision && !finished {
			if input.Decision != nil {
				encoded, err := wtf8.Marshal(input.Decision)
				if err != nil {
					return err
				}
				nextDecision = encoded
			} else {
				nextDecision = nil
			}
		} else if (input.HasStatus || finished) && status != "blocked" && status != "review" {
			// A finished ticket waits on nobody, so a question sent with the merge is dropped too.
			if existing := readStoredDecision(current.Decision); existing != nil && existing.Answer == "" {
				nextDecision = nil
			}
		}

		updatedAt := now()
		value, err := scanTicket(tx.QueryRow(ctx, `
			UPDATE tickets
			SET title = $2, description = $3, priority = $4,
			    "ownerUserId" = $5, "ownerBotId" = $6,
			    "workerBotIds" = $7, "assigneeBotId" = $8,
			    status = $9, "completedAt" = $10, "updatedAt" = $11,
			    "archivedAt" = CASE WHEN $9 IN ('done', 'closed') THEN "archivedAt" END,
			    decision = $12, "pullRequests" = COALESCE($13, "pullRequests")
			WHERE id = $1
			RETURNING `+ticketColumns,
			append([]any{current.ID}, db.Data(title, nullableText(description), priority,
				nullableText(ownerUserID), nullableText(ownerBotID),
				workerBotIDs, nullableText(assigneeBotID),
				status, completedAt, updatedAt, decisionValue(nextDecision), pullRequestsValue)...)...,
		))
		if err != nil {
			return err
		}
		if deployment.Signals != nil {
			deployment.Signals.PublishBoard(actor.SpaceID, board.ID, value.ID)
		}
		ticket, _ = dto(value, board.Prefix)
		if input.HasDescription && description != nil {
			if spaceBots, err := LoadSpaceBots(ctx, tx, actor.SpaceID); err == nil {
				mentionedBots = ExtractMentionedBotIDs(*description, spaceBots, "")
			}
		}
		return nil
	})
	if err != nil {
		return nil, shared.Failure(err)
	}
	if !ticketValid(ticket) || ticket.ID == "" {
		return nil, shared.OutputInvalid()
	}
	var statusWakes []string
	if statusChanged && wakesOnStatus(ticket.Status) {
		statusWakes = ticket.WorkerBotIDs
	}
	wakeBotIDs := dedupeIDs(append(append(addedWorkers, statusWakes...), mentionedBots...))
	if deployment.Waker != nil && len(wakeBotIDs) > 0 {
		note := ""
		if len(statusWakes) > 0 {
			note = "Its status changed to " + ticket.Status + "."
		} else if len(mentionedBots) > 0 && len(addedWorkers) == 0 {
			note = "You were mentioned on this ticket — read it with ticket_get and address what is needed from you."
		}
		deployment.Waker.WakeWorkers(ctx, actor.SpaceID, ticket.ID, wakeBotIDs, note)
	}
	return ticket, nil
}
