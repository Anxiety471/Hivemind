// Package bots ports the bots procedures that touch only the database:
// bots.reorder, bots.restore, bots.removePreview, bots.emailAddress,
// bots.emailAddresses and bots.claimEmailAddress (apps/api/src/routes/bots.ts).
//
// The rest of the group stays on TypeScript: list/get build sidebar previews from
// decrypted message blocks (bot-previews.ts:69), create/update/copy/archive and
// remove run adapters, and the webhook and vault procedures touch the SecretStore.
package bots

import (
	"context"
	"errors"
	"regexp"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/orpc"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/shared"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/validate"
)

// groupMemberMin is GROUP_MEMBER_MIN (packages/contracts/src/domain.ts:194): a group
// with fewer active bots dissolves with the bot whose removal would leave it so small.
const groupMemberMin = 2

var (
	// errIsolation is the IsolationError every route maps to its own NOT_FOUND message.
	errIsolation     = shared.NotFound
	errOwnerRequired = orpc.Forbidden("Only the space owner can do that")
	errNotReceived   = orpc.BadRequest("This server doesn't receive email.")
	errHasAddress    = orpc.Conflict("This bot already has an address.")
	errNameTaken     = orpc.Conflict("That address isn't available")
)

// emailNamePattern is BotEmailNameSchema's regex (packages/contracts/src/bot-email.ts:67).
var emailNamePattern = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$`)

// emailNamePatternSource is how zod prints the pattern in an invalid_format issue.
const emailNamePatternSource = "/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/"

// reservedEmailNames are RESERVED_BOT_EMAIL_NAMES (bot-email.ts:11).
var reservedEmailNames = []string{
	"abuse", "accounts", "admin", "administrator", "billing", "careers", "contact", "elie",
	"help", "hello", "hi", "hostmaster", "info", "jobs", "legal", "mail", "mailer-daemon",
	"marketing", "no-reply", "noc", "noreply", "notifications", "partners", "postmaster",
	"press", "privacy", "rakazo", "root", "sales", "security", "support", "team", "verify",
	"webmaster",
}

func now() time.Time { return time.Now().UTC().Truncate(time.Millisecond) }

type botRow struct {
	ID             string
	UserID         string
	ArchivedAt     *time.Time
	ComputerID     *string
	ComputerUserID *string
}

// loadBot is repos.getBot (packages/db/src/repos.ts:415): a bot of the actor's Space,
// archived included when asked. TypeScript also includes the bot's thread and computer
// rows; the thread's encrypted compaction summary is decrypted on the way and the value
// discarded, so only an unreadable ciphertext tells Go and TypeScript apart
// (hook-audit.md R1).
func loadBot(ctx context.Context, tx pgx.Tx, actor db.Actor, botID string, includeArchived bool) (botRow, error) {
	query := `SELECT b.id, b."userId", b."archivedAt", b."computerId", c."userId"
		FROM bots b
		LEFT JOIN computers c ON c.id = b."computerId"
		WHERE b.id = $1 AND b."spaceId" = $2`
	if !includeArchived {
		query += ` AND b."archivedAt" IS NULL`
	}
	var bot botRow
	err := tx.QueryRow(ctx, query, botID, actor.SpaceID).Scan(&bot.ID, &bot.UserID, &bot.ArchivedAt, &bot.ComputerID, &bot.ComputerUserID)
	if errors.Is(err, pgx.ErrNoRows) {
		return botRow{}, errIsolation
	}
	return bot, err
}

// requireOwner is requireSpaceOwner (packages/db/src/space-members.ts:104).
func requireOwner(ctx context.Context, tx pgx.Tx, actor db.Actor) error {
	var role string
	err := tx.QueryRow(ctx, `SELECT role FROM space_members WHERE "spaceId" = $1 AND "userId" = $2`,
		actor.SpaceID, actor.UserID).Scan(&role)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && !shared.IsOwnerRole(role)) {
		return errOwnerRequired
	}
	return err
}

// parseBotID mirrors z.object({ botId: Id }).
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

// parseGroupID mirrors z.object({ groupId: Id }).
func parseGroupID(raw orpc.Input) (string, *orpc.Error) {
	object, issues := validate.Decode(raw.Raw, nil)
	if issues != nil {
		return "", validate.Fail(issues)
	}
	groupID, problems := validate.String(validate.Path{"groupId"}, object.Field("groupId"), validate.StringRules{Min: 1})
	if problems != nil {
		return "", validate.Fail(problems)
	}
	return groupID, nil
}

// parseEmailName mirrors BotEmailNameSchema: trim, lowercase, then the length, shape,
// dot and reserved-name checks, all of which run in order for a string.
func parseEmailName(raw any) (string, []validate.Issue) {
	if _, ok := raw.(string); !ok {
		return "", []validate.Issue{validate.TypeIssue("string", validate.JSType(raw), validate.Path{"name"})}
	}
	name := shared.NormalizeEmail(raw.(string))
	var issues []validate.Issue
	if length := len([]rune(name)); length < 2 {
		issues = append(issues, validate.Issue{
			"origin": "string", "code": "too_small", "minimum": 2, "inclusive": true,
			"path": []any{"name"}, "message": "Use at least 2 characters",
		})
	} else if length > 64 {
		issues = append(issues, validate.Issue{
			"origin": "string", "code": "too_big", "maximum": 64, "inclusive": true,
			"path": []any{"name"}, "message": "Use at most 64 characters",
		})
	}
	if !emailNamePattern.MatchString(name) {
		issues = append(issues, validate.Issue{
			"origin": "string", "code": "invalid_format", "format": "regex",
			"pattern": emailNamePatternSource, "path": []any{"name"},
			"message": "Use letters, numbers, dots, dashes or underscores",
		})
	}
	if strings.Contains(name, "..") {
		issues = append(issues, validate.Issue{
			"code": "custom", "path": []any{"name"},
			"message": "Use letters, numbers, dots, dashes or underscores",
		})
	}
	if isReservedEmailName(name) {
		issues = append(issues, validate.Issue{
			"code": "custom", "path": []any{"name"}, "message": "That address isn't available",
		})
	}
	return name, issues
}

// isReservedEmailName is isReservedBotEmailName (bot-email.ts:45).
func isReservedEmailName(name string) bool {
	if strings.HasPrefix(name, "rakazo") {
		return true
	}
	for _, reserved := range reservedEmailNames {
		if !strings.HasPrefix(name, reserved) {
			continue
		}
		if len(name) == len(reserved) {
			return true
		}
		switch name[len(reserved)] {
		case '.', '-', '_':
			return true
		}
	}
	return false
}
