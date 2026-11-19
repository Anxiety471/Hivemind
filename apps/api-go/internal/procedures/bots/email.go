package bots

import (
	"context"

	"github.com/jackc/pgx/v5"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/orpc"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/shared"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/validate"
)

// Address is bots.emailAddress's wire shape: null for a server without email.
type Address struct {
	Domain  string  `json:"domain"`
	Address *string `json:"address"`
}

// AddressEntry is one address in bots.emailAddresses.
type AddressEntry struct {
	BotID   string `json:"botId"`
	BotName string `json:"botName"`
	Address string `json:"address"`
}

// AddressList is bots.emailAddresses' wire shape: null for a server without email.
type AddressList struct {
	Domain    string         `json:"domain"`
	Addresses []AddressEntry `json:"addresses"`
}

// EmailAddress implements bots.emailAddress: the address of the actor's own bot, once
// claimed. The address and its inbox are the owner's, so another member of the Space
// sees null (routes/bots.ts:641).
func EmailAddress(ctx context.Context, database *db.DB, actor db.Actor, deployment shared.Deployment, raw orpc.Input) (any, *orpc.Error) {
	botID, failure := parseBotID(raw)
	if failure != nil {
		return nil, failure
	}
	var result *Address
	err := database.Tenant(ctx, actor, func(tx pgx.Tx) error {
		bot, err := loadBot(ctx, tx, actor, botID, false)
		if err != nil {
			return err
		}
		if bot.UserID != actor.UserID || deployment.InboundEmailDomain == "" {
			return nil
		}
		var name *string
		err = tx.QueryRow(ctx, `SELECT name FROM bot_email_addresses WHERE "botId" = $1`, bot.ID).Scan(&name)
		if err != nil && err != pgx.ErrNoRows {
			return err
		}
		result = &Address{Domain: deployment.InboundEmailDomain}
		if name != nil {
			address := *name + "@" + deployment.InboundEmailDomain
			result.Address = &address
		}
		return nil
	})
	if err != nil {
		return nil, shared.Failure(err)
	}
	if result == nil {
		return nil, nil
	}
	return result, nil
}

// EmailAddresses implements bots.emailAddresses: the addresses of the actor's own live
// bots in this Space, by name (bot-email-address.ts:24). Archived bots receive no mail.
func EmailAddresses(ctx context.Context, database *db.DB, actor db.Actor, deployment shared.Deployment) (any, *orpc.Error) {
	var result *AddressList
	err := database.Tenant(ctx, actor, func(tx pgx.Tx) error {
		if deployment.InboundEmailDomain == "" {
			return nil
		}
		rows, err := tx.Query(ctx, `SELECT a.name, b.id, b.name
			FROM bot_email_addresses a JOIN bots b ON b.id = a."botId"
			WHERE b."spaceId" = $1 AND b."userId" = $2 AND b."archivedAt" IS NULL
			ORDER BY a.name ASC`, actor.SpaceID, actor.UserID)
		if err != nil {
			return err
		}
		defer rows.Close()
		result = &AddressList{Domain: deployment.InboundEmailDomain, Addresses: []AddressEntry{}}
		for rows.Next() {
			var name, botID, botName string
			if err := rows.Scan(&name, &botID, &botName); err != nil {
				return err
			}
			result.Addresses = append(result.Addresses, AddressEntry{
				BotID: botID, BotName: botName, Address: name + "@" + deployment.InboundEmailDomain,
			})
		}
		return rows.Err()
	})
	if err != nil {
		return nil, shared.Failure(err)
	}
	if result == nil {
		return nil, nil
	}
	return result, nil
}

// ClaimEmailAddress implements bots.claimEmailAddress: give the bot `name`@domain for
// good. Only the bot's creator may claim (routes/bots.ts:650). A name is never
// reissued, so mail meant for one bot never reaches another (claimBotEmailName,
// packages/db/src/bot-email-address.ts:8).
func ClaimEmailAddress(ctx context.Context, database *db.DB, actor db.Actor, deployment shared.Deployment, raw orpc.Input) (any, *orpc.Error) {
	object, issues := validate.Decode(raw.Raw, nil)
	if issues != nil {
		return nil, validate.Fail(issues)
	}
	var found []validate.Issue
	botID, problems := validate.String(validate.Path{"botId"}, object.Field("botId"), validate.StringRules{Min: 1})
	found = append(found, problems...)
	name, nameIssues := parseEmailName(object.Field("name"))
	found = append(found, nameIssues...)
	if found != nil {
		return nil, validate.Fail(found)
	}
	var claimed string
	err := database.Tenant(ctx, actor, func(tx pgx.Tx) error {
		bot, err := loadBot(ctx, tx, actor, botID, false)
		if err != nil {
			return err
		}
		if bot.UserID != actor.UserID {
			return orpc.New("FORBIDDEN", 403, "Forbidden")
		}
		if deployment.InboundEmailDomain == "" {
			return errNotReceived
		}
		var existing *string
		err = tx.QueryRow(ctx, `SELECT name FROM bot_email_addresses WHERE "botId" = $1`, bot.ID).Scan(&existing)
		if err != nil && err != pgx.ErrNoRows {
			return err
		}
		if existing != nil {
			if *existing != name {
				return errHasAddress
			}
		} else {
			// A concurrent claim for the same name or bot is decided by the unique indexes:
			// the insert does nothing, and the re-read below reports which one won.
			tag, err := tx.Exec(ctx, `INSERT INTO bot_email_addresses (name, "botId", "createdAt")
				VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, name, bot.ID, now())
			if err != nil {
				return err
			}
			if tag.RowsAffected() == 0 {
				var current *string
				if err := tx.QueryRow(ctx, `SELECT name FROM bot_email_addresses WHERE "botId" = $1`, bot.ID).Scan(&current); err != nil && err != pgx.ErrNoRows {
					return err
				}
				if current == nil {
					return errNameTaken
				}
				if *current != name {
					return errHasAddress
				}
			}
		}
		claimed = name + "@" + deployment.InboundEmailDomain
		return nil
	})
	if err != nil {
		return nil, shared.Failure(err)
	}
	return map[string]any{"address": claimed}, nil
}
