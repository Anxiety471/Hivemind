package bots

import (
	"context"

	"github.com/jackc/pgx/v5"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/orpc"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/shared"
)

// templateImportKeyPrefix is BOT_TEMPLATE_IMPORT_KEY_PREFIX (packages/contracts/src/bots/bot-template.ts:78).
const templateImportKeyPrefix = "template:"

// TemplateSkill is one skill of BotTemplateSchema.
type TemplateSkill struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	Body        string `json:"body"`
}

// TemplateRoutine is one routine of BotTemplateSchema.
type TemplateRoutine struct {
	Name   string   `json:"name"`
	Prompt string   `json:"prompt"`
	Crons  []string `json:"crons"`
}

// Template is BotTemplateSchema (packages/contracts/src/bots/bot-template.ts:19-54).
type Template struct {
	ID           string            `json:"id"`
	Version      int               `json:"version"`
	Name         string            `json:"name"`
	Summary      string            `json:"summary"`
	Sample       string            `json:"sample"`
	Description  string            `json:"description"`
	Instructions string            `json:"instructions"`
	Skills       []TemplateSkill   `json:"skills"`
	Routines     []TemplateRoutine `json:"routines"`
	Apps         []string          `json:"apps"`
}

// TemplateListing is BotTemplateListingSchema: the template plus the bot an earlier create made,
// while it exists.
type TemplateListing struct {
	Template
	BotID *string `json:"botId"`
}

// ListTemplates implements bots.templates (apps/api/src/bots/bot-templates.ts:27-46): the static
// catalogue, each entry carrying the live bot an earlier create left for this Space and person.
// A bot that was archived no longer counts, so the template can be made again.
func ListTemplates(ctx context.Context, database *db.DB, actor db.Actor) (any, *orpc.Error) {
	keys := make([]string, len(Templates))
	for index, template := range Templates {
		keys[index] = templateImportKeyPrefix + template.ID
	}
	made := map[string]string{}
	err := database.Tenant(ctx, actor, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `SELECT ai."importKey", ai."botId" FROM agent_imports ai
			JOIN bots b ON b.id = ai."botId"
			WHERE ai."spaceId" = $1 AND ai."userId" = $2 AND ai."source" = 'template'
				AND ai."importKey" = ANY($3) AND b."archivedAt" IS NULL`,
			actor.SpaceID, actor.UserID, keys)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var key, botID string
			if err := rows.Scan(&key, &botID); err != nil {
				return err
			}
			made[key] = botID
		}
		return rows.Err()
	})
	if err != nil {
		return nil, shared.Failure(err)
	}
	list := make([]TemplateListing, len(Templates))
	for index, template := range Templates {
		list[index].Template = template
		if botID, ok := made[templateImportKeyPrefix+template.ID]; ok {
			found := botID
			list[index].BotID = &found
		}
	}
	return list, nil
}
