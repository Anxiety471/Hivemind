// Package messaging ports the account-side messaging procedures: linking a chat
// app to a bot, the linked identities, channel invitations and agent connections.
// installations.* and connections.respond need Slack and the delivery outbox, and
// status/installations.list read deployment configuration; they stay on TypeScript.
package messaging

import (
	"context"
	"crypto/rand"
	"errors"
	"math/big"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/effects"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/orpc"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/shared"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/validate"
)

const (
	linkCodeAlphabet = "ABCDEFGHJKMNPQRSTVWXYZ23456789"
	linkCodeLength   = 8
	linkCodeTTL      = 10 * time.Minute
	isoMillis        = "2006-01-02T15:04:05.000Z"
)

var errNotFound = orpc.NotFound("Not Found")

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

func now() time.Time { return time.Now().UTC().Truncate(time.Millisecond) }

// inSystem is acrossChatIdentities: chat identities belong to the account and
// link to bots in any of its Spaces, and an agent connection joins two accounts'
// bots, so these reads run as system.
func inSystem(ctx context.Context, database *db.DB, tx pgx.Tx, fn func() error) error {
	return database.InSystem(ctx, tx, fn)
}

type identityRef struct{ ID, BotID string }

// identitiesFor is messagingIdentitiesFor: every linked chat app of the account.
func identitiesFor(ctx context.Context, database *db.DB, tx pgx.Tx, userID string) ([]identityRef, error) {
	var found []identityRef
	err := inSystem(ctx, database, tx, func() error {
		rows, err := tx.Query(ctx, `SELECT id, "botId" FROM messaging_identities WHERE "userId" = $1 ORDER BY "createdAt" ASC`, userID)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var identity identityRef
			if err := rows.Scan(&identity.ID, &identity.BotID); err != nil {
				return err
			}
			found = append(found, identity)
		}
		return rows.Err()
	})
	return found, err
}

func identityIDs(identities []identityRef) []string {
	ids := make([]string, len(identities))
	for index, identity := range identities {
		ids[index] = identity.ID
	}
	return ids
}

func botIDs(identities []identityRef) []string {
	ids := make([]string, len(identities))
	for index, identity := range identities {
		ids[index] = identity.BotID
	}
	return ids
}

// LinkStarted is messaging.link.start's output.
type LinkStarted struct {
	Code      string `json:"code"`
	ExpiresAt string `json:"expiresAt"`
	Shared    *bool  `json:"shared,omitempty"`
}

// LinkStart implements messaging.link.start: issue the user's single active code
// for one of their bots, superseding the previous one.
func LinkStart(ctx context.Context, database *db.DB, actor db.Actor, raw orpc.Input) (any, *orpc.Error) {
	values, failure := shared.IDFields(raw, "botId")
	if failure != nil {
		return nil, failure
	}
	var result LinkStarted
	err := database.Tenant(ctx, actor, func(tx pgx.Tx) error {
		// Any of the user's bots, so a workspace's DMs link from whichever space is open.
		var botID, spaceID string
		var found bool
		if err := inSystem(ctx, database, tx, func() error {
			err := tx.QueryRow(ctx, `SELECT b.id, b."spaceId" FROM bots b
				WHERE b.id = $1 AND b."userId" = $2 AND b."archivedAt" IS NULL
					AND EXISTS (SELECT 1 FROM space_members sm WHERE sm."spaceId" = b."spaceId" AND sm."userId" = $2)`,
				values["botId"], actor.UserID).Scan(&botID, &spaceID)
			found = err == nil
			if err != nil && !errors.Is(err, pgx.ErrNoRows) {
				return err
			}
			return nil
		}); err != nil {
			return err
		}
		if !found {
			return errNotFound
		}
		// One chat identity per bot: delivery mirrors a bot's replies to exactly one conversation.
		var linked bool
		if err := inSystem(ctx, database, tx, func() error {
			return tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM messaging_identities WHERE "botId" = $1)`, botID).Scan(&linked)
		}); err != nil {
			return err
		}
		if linked {
			return orpc.BadRequest("That bot is already linked to a chat app; unlink it first.")
		}
		code, err := newLinkCode()
		if err != nil {
			return err
		}
		expiresAt := now().Add(linkCodeTTL)
		// One active code per user: a fresh request supersedes the previous one.
		// writeaudit:dynamic transaction-scoped advisory lock; no row payload
		if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, "messaging-link-code:"+actor.UserID); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `DELETE FROM messaging_link_codes WHERE "userId" = $1`, actor.UserID); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `INSERT INTO messaging_link_codes (id, code, "userId", "spaceId", "botId", "expiresAt", "createdAt")
			VALUES ($1, $2, $3, $4, $5, $6, $7)`, db.Data(effects.NewID(), code, actor.UserID, spaceID, botID, expiresAt, now())...); err != nil {
			return err
		}
		var members int
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM (SELECT 1 FROM space_members WHERE "spaceId" = $1 LIMIT 2) s`, spaceID).Scan(&members); err != nil {
			return err
		}
		result = LinkStarted{Code: code[:4] + "-" + code[4:], ExpiresAt: expiresAt.Format(isoMillis)}
		if members > 1 {
			shared := true
			result.Shared = &shared
		}
		return nil
	})
	if err != nil {
		return nil, asFailure(err)
	}
	return result, nil
}

func newLinkCode() (string, error) {
	var code strings.Builder
	limit := big.NewInt(int64(len(linkCodeAlphabet)))
	for i := 0; i < linkCodeLength; i++ {
		index, err := rand.Int(rand.Reader, limit)
		if err != nil {
			return "", err
		}
		code.WriteByte(linkCodeAlphabet[index.Int64()])
	}
	return code.String(), nil
}

// Identity is the wire shape of MessagingLinkedIdentitySchema.
type Identity struct {
	ID       string `json:"id"`
	Provider string `json:"provider"`
	Address  string `json:"address"`
	BotID    string `json:"botId"`
	BotName  string `json:"botName"`
}

// SetBot implements messaging.identities.setBot: point one of the user's linked
// chat apps at a bot in the active Space.
func SetBot(ctx context.Context, database *db.DB, actor db.Actor, raw orpc.Input) (any, *orpc.Error) {
	values, failure := shared.IDFields(raw, "identityId", "botId")
	if failure != nil {
		return nil, failure
	}
	var result Identity
	err := database.Tenant(ctx, actor, func(tx pgx.Tx) error {
		var installationID *string
		var identitySpace string
		if err := inSystem(ctx, database, tx, func() error {
			err := tx.QueryRow(ctx, `SELECT "installationId", "spaceId" FROM messaging_identities WHERE id = $1 AND "userId" = $2`,
				values["identityId"], actor.UserID).Scan(&installationID, &identitySpace)
			if errors.Is(err, pgx.ErrNoRows) {
				return errNotFound
			}
			return err
		}); err != nil {
			return err
		}
		// A workspace install delivers DMs only into its own space, so moving the link elsewhere would silently drop them.
		if installationID != nil && identitySpace != actor.SpaceID {
			return orpc.BadRequest("Pick a bot in the space this Slack workspace is connected to.")
		}
		var botID, botName string
		err := tx.QueryRow(ctx, `SELECT id, name FROM bots WHERE id = $1 AND "spaceId" = $2 AND "userId" = $3 AND "archivedAt" IS NULL`,
			values["botId"], actor.SpaceID, actor.UserID).Scan(&botID, &botName)
		if errors.Is(err, pgx.ErrNoRows) {
			return errNotFound
		}
		if err != nil {
			return err
		}
		// The identity must live in the bot's space: runs resolve credentials, memory, and approval rules from run.spaceId.
		return inSystem(ctx, database, tx, func() error {
			// A unique violation aborts the transaction in Postgres, so it is taken in a savepoint.
			inner, err := tx.Begin(ctx)
			if err != nil {
				return err
			}
			err = inner.QueryRow(ctx, `UPDATE messaging_identities SET "botId" = $1, "spaceId" = $2, "updatedAt" = $3 WHERE id = $4
				RETURNING id, provider, address, "botId"`,
				append(db.Data(botID, actor.SpaceID, now()), values["identityId"])...).
				Scan(&result.ID, &result.Provider, &result.Address, &result.BotID)
			if err != nil {
				_ = inner.Rollback(ctx)
				var pgErr *pgconn.PgError
				if errors.As(err, &pgErr) && pgErr.Code == "23505" {
					// botId is unique: the target bot is already linked elsewhere.
					return orpc.BadRequest("That bot is already linked to a chat app.")
				}
				return err
			}
			if err := inner.Commit(ctx); err != nil {
				return err
			}
			var name *string
			if err := tx.QueryRow(ctx, `SELECT name FROM bots WHERE id = $1`, result.BotID).Scan(&name); err != nil && !errors.Is(err, pgx.ErrNoRows) {
				return err
			}
			if name != nil {
				result.BotName = *name
			}
			return nil
		})
	})
	if err != nil {
		return nil, asFailure(err)
	}
	return result, nil
}

// Unlink implements messaging.identities.unlink.
func Unlink(ctx context.Context, database *db.DB, actor db.Actor, raw orpc.Input) (any, *orpc.Error) {
	values, failure := shared.IDFields(raw, "identityId")
	if failure != nil {
		return nil, failure
	}
	err := database.Tenant(ctx, actor, func(tx pgx.Tx) error {
		return inSystem(ctx, database, tx, func() error {
			tag, err := tx.Exec(ctx, `DELETE FROM messaging_identities WHERE id = $1 AND "userId" = $2`, values["identityId"], actor.UserID)
			if err != nil {
				return err
			}
			if tag.RowsAffected() == 0 {
				return errNotFound
			}
			return nil
		})
	})
	if err != nil {
		return nil, asFailure(err)
	}
	return map[string]any{"ok": true}, nil
}

// Membership is the wire shape of MessagingChannelMembershipSchema.
type Membership struct {
	ID          string  `json:"id"`
	ChannelID   string  `json:"channelId"`
	IdentityID  string  `json:"identityId"`
	Provider    string  `json:"provider"`
	Name        *string `json:"name"`
	Status      string  `json:"status"`
	MemberCount int64   `json:"memberCount"`
}

const membershipSelect = `SELECT m.id, m."channelId", m."identityId", c.provider, c.name, m.status,
	(SELECT count(*) FROM messaging_channel_members x WHERE x."channelId" = m."channelId" AND x.status IN ('invited', 'approved'))
	FROM messaging_channel_members m JOIN messaging_channels c ON c.id = m."channelId"`

func scanMembership(row pgx.Row) (Membership, error) {
	var membership Membership
	var identityID *string
	err := row.Scan(&membership.ID, &membership.ChannelID, &identityID, &membership.Provider, &membership.Name, &membership.Status, &membership.MemberCount)
	if identityID != nil {
		membership.IdentityID = *identityID
	}
	return membership, err
}

// ChannelsList implements messaging.channels.list.
func ChannelsList(ctx context.Context, database *db.DB, actor db.Actor, _ orpc.Input) (any, *orpc.Error) {
	memberships := []Membership{}
	err := database.Tenant(ctx, actor, func(tx pgx.Tx) error {
		identities, err := identitiesFor(ctx, database, tx, actor.UserID)
		if err != nil || len(identities) == 0 {
			return err
		}
		rows, err := tx.Query(ctx, membershipSelect+` WHERE m."identityId" = ANY($1) ORDER BY m."updatedAt" DESC`, identityIDs(identities))
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			membership, err := scanMembership(rows)
			if err != nil {
				return err
			}
			// The router parses the list against the schema: a membership's status is one of
			// four. (respond answers 404 for any status but "invited" before it gets here, and
			// its reload can only be approved or declined, so it needs no check.)
			switch membership.Status {
			case "invited", "approved", "declined", "left":
			default:
				return shared.OutputInvalid()
			}
			memberships = append(memberships, membership)
		}
		return rows.Err()
	})
	if err != nil {
		return nil, asFailure(err)
	}
	return memberships, nil
}

// ChannelsRespond implements messaging.channels.respond: accept or decline an invitation.
func ChannelsRespond(ctx context.Context, database *db.DB, actor db.Actor, raw orpc.Input) (any, *orpc.Error) {
	object, issues := validate.Decode(raw.Raw, nil)
	if issues != nil {
		return nil, validate.Fail(issues)
	}
	var found []validate.Issue
	membershipID, problems := validate.String(validate.Path{"membershipId"}, object.Field("membershipId"), validate.StringRules{Min: 1})
	found = append(found, problems...)
	accept, problems := validate.Boolean(validate.Path{"accept"}, object.Field("accept"))
	found = append(found, problems...)
	if found != nil {
		return nil, validate.Fail(found)
	}
	var result Membership
	err := database.Tenant(ctx, actor, func(tx pgx.Tx) error {
		identities, err := identitiesFor(ctx, database, tx, actor.UserID)
		if err != nil {
			return err
		}
		if len(identities) == 0 {
			return errNotFound
		}
		membership, err := scanMembership(tx.QueryRow(ctx, membershipSelect+` WHERE m.id = $1 AND m."identityId" = ANY($2)`, membershipID, identityIDs(identities)))
		if errors.Is(err, pgx.ErrNoRows) || (err == nil && membership.Status != "invited") {
			return errNotFound
		}
		if err != nil {
			return err
		}
		status := "declined"
		if accept {
			status = "approved"
		}
		tag, err := tx.Exec(ctx, `UPDATE messaging_channel_members SET status = $1, "updatedAt" = $2 WHERE id = $3 AND status = 'invited'`,
			append(db.Data(status, now()), membership.ID)...)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			// Lost a race with leave/sweep: approval must not resurrect a departed member.
			return errNotFound
		}
		result, err = scanMembership(tx.QueryRow(ctx, membershipSelect+` WHERE m.id = $1`, membership.ID))
		return err
	})
	if err != nil {
		return nil, asFailure(err)
	}
	return result, nil
}

// ChannelsLeave implements messaging.channels.leave.
func ChannelsLeave(ctx context.Context, database *db.DB, actor db.Actor, raw orpc.Input) (any, *orpc.Error) {
	values, failure := shared.IDFields(raw, "membershipId")
	if failure != nil {
		return nil, failure
	}
	err := database.Tenant(ctx, actor, func(tx pgx.Tx) error {
		identities, err := identitiesFor(ctx, database, tx, actor.UserID)
		if err != nil {
			return err
		}
		if len(identities) == 0 {
			return errNotFound
		}
		var id string
		err = tx.QueryRow(ctx, `SELECT id FROM messaging_channel_members WHERE id = $1 AND "identityId" = ANY($2)`,
			values["membershipId"], identityIDs(identities)).Scan(&id)
		if errors.Is(err, pgx.ErrNoRows) {
			return errNotFound
		}
		if err != nil {
			return err
		}
		_, err = tx.Exec(ctx, `UPDATE messaging_channel_members SET status = 'left', "updatedAt" = $1 WHERE id = $2`,
			append(db.Data(now()), id)...)
		return err
	})
	if err != nil {
		return nil, asFailure(err)
	}
	return map[string]any{"ok": true}, nil
}

// Connection is the wire shape of MessagingAgentConnectionSchema.
type Connection struct {
	ID             string `json:"id"`
	PeerBotName    string `json:"peerBotName"`
	PeerOwnerLabel string `json:"peerOwnerLabel"`
	Status         string `json:"status"`
	Incoming       bool   `json:"incoming"`
}

// ConnectionsList implements messaging.connections.list.
func ConnectionsList(ctx context.Context, database *db.DB, actor db.Actor, _ orpc.Input) (any, *orpc.Error) {
	connections := []Connection{}
	err := database.Tenant(ctx, actor, func(tx pgx.Tx) error {
		identities, err := identitiesFor(ctx, database, tx, actor.UserID)
		if err != nil || len(identities) == 0 {
			return err
		}
		mine := botIDs(identities)
		myBots := map[string]bool{}
		for _, id := range mine {
			myBots[id] = true
		}
		type row struct{ id, requester, target, status string }
		var rows []row
		if err := inSystem(ctx, database, tx, func() error {
			result, err := tx.Query(ctx, `SELECT id, "requesterBotId", "targetBotId", status FROM agent_connections
				WHERE "requesterBotId" = ANY($1) OR "targetBotId" = ANY($1) ORDER BY "updatedAt" DESC`, mine)
			if err != nil {
				return err
			}
			defer result.Close()
			for result.Next() {
				var item row
				if err := result.Scan(&item.id, &item.requester, &item.target, &item.status); err != nil {
					return err
				}
				rows = append(rows, item)
			}
			return result.Err()
		}); err != nil {
			return err
		}
		for _, item := range rows {
			connection, err := connectionDTO(ctx, database, tx, myBots, item.id, item.requester, item.target, item.status)
			if err != nil {
				return err
			}
			connections = append(connections, connection)
		}
		return nil
	})
	if err != nil {
		return nil, asFailure(err)
	}
	return connections, nil
}

// connectionDTO is messagingConnectionDto: the peer stays opaque until they approve.
func connectionDTO(ctx context.Context, database *db.DB, tx pgx.Tx, mine map[string]bool, id, requester, target, status string) (Connection, error) {
	// The router parses the output: a connection's status is one of four.
	switch status {
	case "pending", "approved", "declined", "revoked":
	default:
		return Connection{}, shared.OutputInvalid()
	}
	incoming := mine[target]
	if !incoming && status != "approved" {
		return Connection{ID: id, PeerBotName: "agent", PeerOwnerLabel: "owner", Status: status, Incoming: incoming}, nil
	}
	peer := target
	if incoming {
		peer = requester
	}
	result := Connection{ID: id, Status: status, Incoming: incoming}
	var ownerID *string
	if err := inSystem(ctx, database, tx, func() error {
		var name *string
		if err := tx.QueryRow(ctx, `SELECT name FROM bots WHERE id = $1`, peer).Scan(&name); err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		if name != nil {
			result.PeerBotName = *name
		}
		if err := tx.QueryRow(ctx, `SELECT "userId" FROM messaging_identities WHERE "botId" = $1`, peer).Scan(&ownerID); err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		return nil
	}); err != nil {
		return Connection{}, err
	}
	var ownerName *string
	if ownerID != nil {
		if err := tx.QueryRow(ctx, `SELECT name FROM "user" WHERE id = $1`, *ownerID).Scan(&ownerName); err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return Connection{}, err
		}
	}
	result.PeerOwnerLabel = firstWord(shared.DisplayName(ownerName, ""))
	return result, nil
}

// ConnectionsRevoke implements messaging.connections.revoke: end a connection
// and cancel the invite DM that was never delivered, in one transaction.
func ConnectionsRevoke(ctx context.Context, database *db.DB, actor db.Actor, raw orpc.Input) (any, *orpc.Error) {
	values, failure := shared.IDFields(raw, "connectionId")
	if failure != nil {
		return nil, failure
	}
	err := database.Tenant(ctx, actor, func(tx pgx.Tx) error {
		identities, err := identitiesFor(ctx, database, tx, actor.UserID)
		if err != nil {
			return err
		}
		if len(identities) == 0 {
			return errNotFound
		}
		mine := botIDs(identities)
		var requester, target, status string
		if err := inSystem(ctx, database, tx, func() error {
			err := tx.QueryRow(ctx, `SELECT "requesterBotId", "targetBotId", status FROM agent_connections
				WHERE id = $1 AND ("requesterBotId" = ANY($2) OR "targetBotId" = ANY($2))`, values["connectionId"], mine).Scan(&requester, &target, &status)
			if errors.Is(err, pgx.ErrNoRows) {
				return errNotFound
			}
			return err
		}); err != nil {
			return err
		}
		// The status update holds the connection row lock through commit, so a concurrent
		// reconnect waits until both the revoke and the invite delete finish.
		return inSystem(ctx, database, tx, func() error {
			tag, err := tx.Exec(ctx, `UPDATE agent_connections SET status = 'revoked', "updatedAt" = $1 WHERE id = $2 AND status = $3`,
				append(db.Data(now()), values["connectionId"], status)...)
			if err != nil {
				return err
			}
			if tag.RowsAffected() == 0 {
				return errNotFound
			}
			// Cancel undelivered invites, including one a sender already claimed.
			_, err = tx.Exec(ctx, `DELETE FROM messaging_outbound WHERE "idempotencyKey" = $1
				AND (status IN ('pending', 'retry') OR (status = 'sent' AND "providerHandle" IS NULL))`,
				"connect:"+requester+":"+target)
			return err
		})
	})
	if err != nil {
		return nil, asFailure(err)
	}
	return map[string]any{"ok": true}, nil
}

// firstWord is `text.split(/\s+/)[0]` with JavaScript's whitespace.
func firstWord(text string) string {
	for index, character := range text {
		if isJSSpace(character) {
			return text[:index]
		}
	}
	return text
}

func isJSSpace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ', 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff:
		return true
	}
	return r >= 0x2000 && r <= 0x200a
}
