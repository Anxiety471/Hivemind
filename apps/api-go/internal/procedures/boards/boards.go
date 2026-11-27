// Package boards ports boards.list, boards.get and boards.rename: the lab-gated board of the
// actor's Space (apps/api/src/routes/boards.ts:31-92 over packages/db/src/artifacts/board.ts).
//
// Opening the board is a lazy write: the first call creates the row named after the Space, in its
// own transaction just as ensureBoard's createMany wraps itself. Renaming is a plain boards write;
// the ticket prefix may only change while the board has no tickets.
package boards

import (
	"context"
	"errors"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"golang.org/x/text/cases"
	"golang.org/x/text/language"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/orpc"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/shared"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/tickets"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/validate"
)

var errPrefix = orpc.BadRequest("Cannot change the ticket prefix once tickets exist.")

// prefixPattern is TicketPrefixSchema's regex.
var prefixPattern = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9]*$`)

const prefixPatternSource = "/^[A-Za-z][A-Za-z0-9]*$/"

const (
	// maxRepositories is BOARD_MAX_REPOSITORIES, maxAliases BOARD_REPOSITORY_MAX_ALIASES and
	// aliasMaxLength BOARD_REPOSITORY_ALIAS_MAX_LENGTH (packages/contracts/src/artifacts/board.ts).
	maxRepositories = 20
	maxAliases      = 10
	aliasMaxLength  = 40
	// linkURLMaxLength is TICKET_LINK_URL_MAX_LENGTH, the cap a repository link is checked against.
	linkURLMaxLength = 500
	aliasLineMessage = "Alias cannot contain line breaks"
)

// linkLower is the JavaScript toLowerCase the alias dedupe compares with.
var linkLower = cases.Lower(language.Und)

// BoardRepository is BoardRepositorySchema (packages/contracts/src/artifacts/board.ts).
type BoardRepository struct {
	URL       string   `json:"url"`
	Aliases   []string `json:"aliases"`
	IsDefault bool     `json:"isDefault"`
}

// Board is BoardSchema (packages/contracts/src/artifacts/board.ts).
type Board struct {
	ID           string            `json:"id"`
	SpaceID      string            `json:"spaceId"`
	Name         string            `json:"name"`
	TicketPrefix string            `json:"ticketPrefix"`
	Repositories []BoardRepository `json:"repositories"`
	CreatedAt    string            `json:"createdAt"`
	UpdatedAt    string            `json:"updatedAt"`
}

func dto(row tickets.Board) Board {
	return Board{
		ID: row.ID, SpaceID: row.SpaceID, Name: row.Name, TicketPrefix: row.Prefix,
		Repositories: readRepositories(row.Repositories),
		CreatedAt:    shared.ISO(row.CreatedAt), UpdatedAt: shared.ISO(row.UpdatedAt),
	}
}

// readRepositories is readBoardRepositories: a stored value this release does not know shows no
// repositories rather than failing the board. It always returns a non-nil slice (JSON `[]`).
func readRepositories(raw []byte) []BoardRepository {
	value, err := validate.DecodeAny(raw)
	if err != nil {
		return []BoardRepository{}
	}
	items, ok := value.([]any)
	if !ok {
		return []BoardRepository{}
	}
	out := make([]BoardRepository, 0, len(items))
	for _, item := range items {
		object, ok := item.(*validate.Object)
		if !ok {
			return []BoardRepository{}
		}
		url, ok := object.Values["url"].(string)
		if !ok {
			return []BoardRepository{}
		}
		isDefault, ok := object.Values["isDefault"].(bool)
		if !ok {
			return []BoardRepository{}
		}
		rawAliases, ok := object.Values["aliases"].([]any)
		if !ok {
			return []BoardRepository{}
		}
		aliases := make([]string, 0, len(rawAliases))
		for _, rawAlias := range rawAliases {
			alias, ok := rawAlias.(string)
			if !ok {
				return []BoardRepository{}
			}
			aliases = append(aliases, alias)
		}
		out = append(out, BoardRepository{URL: url, Aliases: aliases, IsDefault: isDefault})
	}
	return out
}

// gate is the boardEnabled middleware: it runs before the input parse, so an account without the
// lab answers 404 even for malformed input.
func gate(ctx context.Context, database *db.DB, deployment shared.Deployment, actor db.Actor) error {
	return tickets.Gate(ctx, database, deployment, actor)
}

// open is ensureBoard in its own transaction, committed before the read or write that follows.
func open(ctx context.Context, database *db.DB, actor db.Actor) (tickets.Board, error) {
	var board tickets.Board
	err := database.Tenant(ctx, actor, func(tx pgx.Tx) error {
		var err error
		board, err = tickets.EnsureBoard(ctx, tx, actor.SpaceID)
		return err
	})
	return board, err
}

// List implements boards.list: the Space's board, created on first open.
func List(ctx context.Context, database *db.DB, deployment shared.Deployment, actor db.Actor) (any, *orpc.Error) {
	if err := gate(ctx, database, deployment, actor); err != nil {
		return nil, shared.Failure(err)
	}
	if _, err := open(ctx, database, actor); err != nil {
		return nil, shared.Failure(err)
	}
	list := []Board{}
	err := database.Tenant(ctx, actor, func(tx pgx.Tx) error {
		// writeaudit:dynamic read: the column list is the fixed tickets.BoardColumns; the argument is a filter
		rows, err := tx.Query(ctx, `SELECT `+tickets.BoardColumns+` FROM boards WHERE "spaceId" = $1
			ORDER BY "createdAt" ASC, id ASC`, actor.SpaceID)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			row, err := tickets.ScanBoard(rows)
			if err != nil {
				return err
			}
			list = append(list, dto(row))
		}
		return rows.Err()
	})
	if err != nil {
		return nil, shared.Failure(err)
	}
	return list, nil
}

// Get implements boards.get: the Space's board, created on first open.
func Get(ctx context.Context, database *db.DB, deployment shared.Deployment, actor db.Actor) (any, *orpc.Error) {
	if err := gate(ctx, database, deployment, actor); err != nil {
		return nil, shared.Failure(err)
	}
	board, err := open(ctx, database, actor)
	if err != nil {
		return nil, shared.Failure(err)
	}
	return dto(board), nil
}

type renameInput struct {
	name         *string
	ticketPrefix *string
	// repositories is the normalized list when hasRepositories is set (an empty list clears it).
	hasRepositories bool
	repositories    []BoardRepository
}

// repositoryInput is one BoardRepositoryInputSchema value after its url was normalized.
type repositoryInput struct {
	url       string
	aliases   []string
	isDefault bool
}

// parseAlias is BoardRepositoryAliasSchema: trimmed 1..40 characters with no line break. zod's
// refine runs even after a length check failed, so the line-break check always runs on the trimmed
// text.
func parseAlias(path validate.Path, raw any) (string, []validate.Issue) {
	text, problems := validate.String(path, raw, validate.StringRules{Trim: true, Min: 1, Max: aliasMaxLength})
	if s, ok := raw.(string); ok {
		if trimmed := validate.JSTrim(s); strings.ContainsAny(trimmed, "\r\n\t") {
			problems = append(problems, validate.Issue{
				"code": "custom", "path": path.Raw(), "message": aliasLineMessage,
			})
		}
	}
	return text, problems
}

// parseRepositories is `z.array(BoardRepositoryInputSchema).max(BOARD_MAX_REPOSITORIES).optional()`.
// Each entry's url goes through the repository link rules, its aliases through
// BOARD_REPOSITORY_MAX_ALIASES and parseAlias, and isDefault defaults to false.
func parseRepositories(object *validate.Object, found *[]validate.Issue) (bool, []repositoryInput) {
	v := object.Field("repositories")
	if v == validate.Undefined {
		return false, nil
	}
	path := validate.Path{"repositories"}
	items, problems := validate.AsArray(path, v)
	if problems != nil {
		*found = append(*found, problems...)
		return true, nil
	}
	if len(items) > maxRepositories {
		*found = append(*found, validate.ArrayBounds(path, len(items), 0, maxRepositories)...)
		return true, nil
	}
	out := make([]repositoryInput, 0, len(items))
	for index, item := range items {
		itemPath := path.With(index)
		fields, problems := validate.AsObject(item, itemPath)
		if problems != nil {
			*found = append(*found, problems...)
			continue
		}
		var entry repositoryInput
		rawURL, urlProblems := validate.String(itemPath.With("url"), fields.Field("url"),
			validate.StringRules{Max: linkURLMaxLength})
		*found = append(*found, urlProblems...)
		if urlProblems == nil {
			normalized, ok := tickets.NormalizeRepositoryURL(rawURL)
			if !ok {
				*found = append(*found, validate.Issue{
					"code": "custom", "path": itemPath.With("url").Raw(), "message": tickets.RepositoryURLMessage,
				})
			} else {
				entry.url = normalized
			}
		}
		entry.aliases = []string{}
		if rawAliases := fields.Field("aliases"); rawAliases != validate.Undefined {
			aliasPath := itemPath.With("aliases")
			aliasItems, aliasProblems := validate.AsArray(aliasPath, rawAliases)
			*found = append(*found, aliasProblems...)
			if aliasProblems == nil && len(aliasItems) > maxAliases {
				*found = append(*found, validate.ArrayBounds(aliasPath, len(aliasItems), 0, maxAliases)...)
			} else if aliasProblems == nil {
				for aliasIndex, rawAlias := range aliasItems {
					alias, problems := parseAlias(aliasPath.With(aliasIndex), rawAlias)
					*found = append(*found, problems...)
					if problems == nil {
						entry.aliases = append(entry.aliases, alias)
					}
				}
			}
		}
		if rawDefault := fields.Field("isDefault"); rawDefault != validate.Undefined {
			isDefault, problems := validate.Boolean(itemPath.With("isDefault"), rawDefault)
			*found = append(*found, problems...)
			entry.isDefault = isDefault
		}
		out = append(out, entry)
	}
	return true, out
}

// normalizeRepositories is normalizeBoardRepositories (packages/contracts/src/artifacts/board.ts):
// one entry per URL (the first wins, at most maxRepositories), aliases deduplicated
// case-insensitively with the first casing kept, and only the first default kept.
func normalizeRepositories(input []repositoryInput) []BoardRepository {
	seen := make(map[string]bool, len(input))
	out := make([]BoardRepository, 0, len(input))
	hasDefault := false
	for _, entry := range input {
		if len(out) >= maxRepositories {
			break
		}
		if seen[entry.url] {
			continue
		}
		seen[entry.url] = true
		aliasKeys := make(map[string]bool, len(entry.aliases))
		aliases := make([]string, 0, len(entry.aliases))
		for _, alias := range entry.aliases {
			key := linkLower.String(alias)
			if aliasKeys[key] {
				continue
			}
			aliasKeys[key] = true
			aliases = append(aliases, alias)
		}
		isDefault := entry.isDefault && !hasDefault
		hasDefault = hasDefault || isDefault
		out = append(out, BoardRepository{URL: entry.url, Aliases: aliases, IsDefault: isDefault})
	}
	return out
}

// parse is RenameBoardInput: a trimmed name of 1..80 or a trimmed 1..12 letter-and-digit prefix,
// with at least one of them present.
func parse(raw orpc.Input) (renameInput, *orpc.Error) {
	var result renameInput
	object, issues := validate.Decode(raw.Raw, nil)
	if issues != nil {
		return result, validate.Fail(issues)
	}
	var found []validate.Issue
	if value := object.Field("name"); value != validate.Undefined {
		text, problems := validate.String(validate.Path{"name"}, value, validate.StringRules{Trim: true, Min: 1, Max: 80})
		found = append(found, problems...)
		if problems == nil {
			result.name = &text
		}
	}
	if value := object.Field("ticketPrefix"); value != validate.Undefined {
		text, problems := validate.String(validate.Path{"ticketPrefix"}, value, validate.StringRules{Trim: true, Min: 1, Max: 12})
		found = append(found, problems...)
		// zod runs the regex after the length checks, on the trimmed value, even when one failed.
		if raw, ok := value.(string); ok {
			if trimmed := validate.JSTrim(raw); !prefixPattern.MatchString(trimmed) {
				found = append(found, validate.Issue{
					"origin": "string", "code": "invalid_format", "format": "regex", "pattern": prefixPatternSource,
					"path":    []any{"ticketPrefix"},
					"message": "Prefix must start with a letter and contain only letters and digits",
				})
			}
		}
		if problems == nil {
			result.ticketPrefix = &text
		}
	}
	// The object's refine runs only when its fields parsed.
	if has, entries := parseRepositories(object, &found); has {
		result.hasRepositories = true
		result.repositories = normalizeRepositories(entries)
	}
	if found == nil && result.name == nil && result.ticketPrefix == nil && !result.hasRepositories {
		found = append(found, validate.Issue{
			"code": "custom", "path": []any{}, "message": "Provide a name or ticketPrefix",
		})
	}
	if found != nil {
		return result, validate.Fail(found)
	}
	return result, nil
}

// Rename implements boards.rename.
func Rename(ctx context.Context, database *db.DB, deployment shared.Deployment, actor db.Actor, raw orpc.Input) (any, *orpc.Error) {
	if err := gate(ctx, database, deployment, actor); err != nil {
		return nil, shared.Failure(err)
	}
	input, failure := parse(raw)
	if failure != nil {
		return nil, failure
	}
	board, err := open(ctx, database, actor)
	if err != nil {
		return nil, shared.Failure(err)
	}
	nextPrefix := ""
	if input.ticketPrefix != nil {
		nextPrefix = strings.ToUpper(*input.ticketPrefix)
	}
	changesPrefix := input.ticketPrefix != nil && nextPrefix != board.Prefix
	assignments := []string{}
	args := []any{}
	if input.name != nil {
		args = append(args, *input.name)
		assignments = append(assignments, `name = $`+itoa(len(args)))
	}
	if changesPrefix {
		args = append(args, nextPrefix)
		assignments = append(assignments, `"ticketPrefix" = $`+itoa(len(args)))
	}
	if input.hasRepositories {
		args = append(args, db.JSON(input.repositories))
		assignments = append(assignments, `repositories = $`+itoa(len(args))+`::jsonb`)
	}
	// Nothing to write: Prisma's update with empty data never touches the row, so its updatedAt
	// stays as it was (a case-only or same-case prefix is not a change).
	if !changesPrefix && input.name == nil && !input.hasRepositories {
		return dto(board), nil
	}
	var updated tickets.Board
	err = database.Tenant(ctx, actor, func(tx pgx.Tx) error {
		args = append(args, time.Now().UTC().Truncate(time.Millisecond))
		dataCount := len(args)
		updates := append(append([]string{}, assignments...), `"updatedAt" = $`+itoa(len(args)))
		if !changesPrefix {
			args = append(args, board.ID)
			arguments := append(db.Data(args[:dataCount]...), args[dataCount:]...)
			//writeaudit:dynamic the SET list is built from optional fields; args[:dataCount] is wrapped with db.Data and the suffix holds only filters
			row, err := tickets.ScanBoard(tx.QueryRow(ctx, `UPDATE boards SET `+strings.Join(updates, ", ")+`
				WHERE id = $`+itoa(len(args))+` RETURNING `+tickets.BoardColumns, arguments...))
			updated = row
			return err
		}
		var count int
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM tickets WHERE "boardId" = $1 AND "spaceId" = $2`,
			board.ID, actor.SpaceID).Scan(&count); err != nil {
			return err
		}
		if count > 0 {
			return errPrefix
		}
		args = append(args, board.ID, actor.SpaceID, board.NextNumber)
		arguments := append(db.Data(args[:dataCount]...), args[dataCount:]...)
		//writeaudit:dynamic the SET list is built from optional fields; args[:dataCount] is wrapped with db.Data and the suffix holds only filters
		row, err := tickets.ScanBoard(tx.QueryRow(ctx, `UPDATE boards SET `+strings.Join(updates, ", ")+`
			WHERE id = $`+itoa(len(args)-2)+` AND "spaceId" = $`+itoa(len(args)-1)+`
				AND "nextNumber" = $`+itoa(len(args))+`
				AND NOT EXISTS (SELECT 1 FROM tickets WHERE "boardId" = boards.id)
			RETURNING `+tickets.BoardColumns, arguments...))
		if errors.Is(err, pgx.ErrNoRows) {
			return errPrefix
		}
		updated = row
		return err
	})
	if err != nil {
		return nil, shared.Failure(err)
	}
	return dto(updated), nil
}

func itoa(value int) string {
	return strconv.Itoa(value)
}
