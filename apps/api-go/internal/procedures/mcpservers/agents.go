package mcpservers

// mcp.servers.agents (apps/api/src/routes/mcp.ts:323-383): which agents may use a server. Setting
// allBots keeps the existing assignments, because choosing agents again restores them; choosing
// agents replaces the list, and a bot that loses the server has its connected cards in that bot's
// chats painted back to pending inside the same transaction.

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/effects"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/events"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/orpc"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/mcpassignments"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/shared"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/validate"
)

// agentIDsMaximum is `.max(500)` on botIds.
const agentIDsMaximum = 500

type agentsInput struct {
	id      string
	allBots bool
	botIDs  []string
}

// parseAgents validates z.object({ id: Id, allBots: z.boolean(), botIds: z.array(Id).max(500)
// .default([]) }); the default applies only when the key is absent.
func parseAgents(raw orpc.Input) (agentsInput, *orpc.Error) {
	object, issues := validate.Decode(raw.Raw, nil)
	if issues != nil {
		return agentsInput{}, validate.Fail(issues)
	}
	var found []validate.Issue
	input := agentsInput{botIDs: []string{}}
	input.id, issues = validate.String(validate.Path{"id"}, object.Field("id"), validate.StringRules{Min: 1})
	found = append(found, issues...)
	input.allBots, issues = validate.Boolean(validate.Path{"allBots"}, object.Field("allBots"))
	found = append(found, issues...)
	if value := object.Field("botIds"); value != validate.Undefined {
		items, problems := validate.AsArray(validate.Path{"botIds"}, value)
		found = append(found, problems...)
		for index, item := range items {
			text, problems := validate.String(validate.Path{"botIds", index}, item, validate.StringRules{Min: 1})
			found = append(found, problems...)
			if problems == nil {
				input.botIDs = append(input.botIDs, text)
			}
		}
		found = append(found, validate.ArrayBounds(validate.Path{"botIds"}, len(items), 0, agentIDsMaximum)...)
	}
	if found != nil {
		return agentsInput{}, validate.Fail(found)
	}
	return input, nil
}

type agentsOutput struct {
	Server      Server                      `json:"server"`
	Assignments []mcpassignments.Assignment `json:"assignments"`
}

// Agents implements mcp.servers.agents.
func Agents(
	ctx context.Context,
	database *db.DB,
	deployment shared.Deployment,
	actor db.Actor,
	raw orpc.Input,
) (any, *orpc.Error) {
	input, failure := parseAgents(raw)
	if failure != nil {
		return nil, failure
	}
	vault, err := shared.VaultDeps(deployment.Vault)
	if err != nil {
		return nil, shared.Failure(err)
	}
	ring := deployment.Content
	if ring == nil {
		return nil, shared.Failure(errors.New("encryption is not configured"))
	}
	var record Record
	var spaceIDs []string
	var assignments []mcpassignments.Assignment
	var seqs []mcpassignments.Seq
	err = database.Tenant(ctx, actor, func(tx pgx.Tx) error {
		var visible string
		err := tx.QueryRow(ctx, `SELECT id FROM mcp_servers WHERE id = $3 AND `+serverAvailable,
			actor.SpaceID, actor.UserID, input.id).Scan(&visible)
		if errors.Is(err, pgx.ErrNoRows) {
			return shared.NotFound
		}
		if err != nil {
			return err
		}
		// tx.mcpServer.update({ where: { id }, data: { allBots } }): @updatedAt moves too.
		rows, err := tx.Query(ctx, `UPDATE mcp_servers SET "allBots" = $2, "updatedAt" = $3
			WHERE id = $1 RETURNING `+serverColumns,
			input.id, input.allBots, time.Now().UTC().Truncate(time.Millisecond))
		if err != nil {
			return err
		}
		if !rows.Next() {
			rows.Close()
			return errors.New("mcp server disappeared during agents update")
		}
		record, err = scanRecord(rows)
		rows.Close()
		if err != nil {
			return err
		}
		if !input.allBots {
			// [...new Set(input.botIds)]: a repeated id is one bot, at its first position.
			botIDs := []string{}
			seen := map[string]bool{}
			for _, botID := range input.botIDs {
				if seen[botID] {
					continue
				}
				seen[botID] = true
				botIDs = append(botIDs, botID)
			}
			var found int
			err = tx.QueryRow(ctx, `SELECT count(*)::int FROM bots
				WHERE "spaceId" = $1 AND "userId" = $2 AND id = ANY($3)`,
				actor.SpaceID, actor.UserID, botIDs).Scan(&found)
			if err != nil {
				return err
			}
			if found != len(botIDs) {
				return shared.NotFound
			}
			previousRows, err := tx.Query(ctx, `SELECT "botId" FROM bot_mcp_servers
				WHERE "spaceId" = $1 AND "userId" = $2 AND "serverId" = $3`,
				actor.SpaceID, actor.UserID, record.id)
			if err != nil {
				return err
			}
			previous := []string{}
			for previousRows.Next() {
				var botID string
				if err := previousRows.Scan(&botID); err != nil {
					previousRows.Close()
					return err
				}
				previous = append(previous, botID)
			}
			previousRows.Close()
			if err := previousRows.Err(); err != nil {
				return err
			}
			removed := []string{}
			for _, botID := range previous {
				if !seen[botID] {
					removed = append(removed, botID)
				}
			}
			if len(removed) > 0 {
				if _, err := tx.Exec(ctx, `DELETE FROM bot_mcp_servers
					WHERE "spaceId" = $1 AND "userId" = $2 AND "serverId" = $3 AND "botId" = ANY($4)`,
					actor.SpaceID, actor.UserID, record.id, removed); err != nil {
					return err
				}
			}
			// createMany({ skipDuplicates: true }): an existing row stays as it is.
			at := time.Now().UTC().Truncate(time.Millisecond)
			for _, botID := range botIDs {
				if _, err := tx.Exec(ctx, `INSERT INTO bot_mcp_servers
					(id, "spaceId", "userId", "botId", "serverId", "allowAllTools", "allowedTools", "createdAt", "updatedAt")
					VALUES ($1, $2, $3, $4, $5, true, '[]'::jsonb, $6, $6)
					ON CONFLICT ("botId", "serverId") DO NOTHING`,
					effects.NewID(), actor.SpaceID, actor.UserID, botID, record.id, at); err != nil {
					return err
				}
			}
			// The shipped handler runs these repaints with Promise.all on one connection, so
			// they commit in this order; a sequential loop appends the same events.
			for _, botID := range removed {
				seq, err := mcpassignments.RevertConnected(ctx, tx, ring, actor, botID, record.id)
				if err != nil {
					return err
				}
				seqs = append(seqs, seq...)
			}
		}
		assignments, err = mcpassignments.ListServer(ctx, tx, actor, input.id, record.id)
		if err != nil {
			return err
		}
		spaceIDs, err = spaceIDsFor(ctx, tx, record)
		return err
	})
	if err != nil {
		return nil, shared.Failure(err)
	}
	for _, cursor := range seqs {
		// deps.events.notify names no event type in mcp-approval.ts.
		events.NotifyCommitted(ctx, deployment.Events, nil, nil, cursor.ThreadID, cursor.Seq, "", "")
	}
	summary, err := summaryFor(ctx, database, vault, actor, record.secretID)
	if err != nil {
		return nil, shared.Failure(err)
	}
	server, failure := ServerDTO(record, spaceIDs, summary)
	if failure != nil {
		return nil, failure
	}
	return agentsOutput{Server: server, Assignments: assignments}, nil
}

// summaryFor is mcpOAuth.summaryFor: the material of the server's own credential, or an empty
// one when it has none (or a row this Space cannot read).
func summaryFor(
	ctx context.Context,
	database *db.DB,
	vault *shared.SecretVault,
	actor db.Actor,
	secretID *string,
) (OAuthSummary, error) {
	if secretID == nil {
		return Summarize(EmptyMaterial())
	}
	var ciphertext string
	found := false
	err := database.Tenant(ctx, actor, func(tx pgx.Tx) error {
		err := tx.QueryRow(ctx, `SELECT ciphertext FROM secrets
			WHERE id = $1 AND "userId" = $2 AND ("spaceId" = $3 OR "spaceId" IS NULL)`,
			*secretID, actor.UserID, actor.SpaceID).Scan(&ciphertext)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		found = err == nil
		return err
	})
	if err != nil {
		return OAuthSummary{}, err
	}
	if !found {
		return Summarize(EmptyMaterial())
	}
	return SummarizeMaterial(vault, ctx, ciphertext, *secretID)
}
