// Package routines ports the routines procedures that touch only the database:
// routines.list, routines.listForMentions, routines.history and routines.remove
// (apps/api/src/routes/routines.ts). create, update and testRun stay on the TypeScript
// API: they validate watches against a computer, read model catalogs, expand skill
// references and wake runs.
//
// routines.remove stays on TypeScript too: its chat notice writes sealed message and
// event content (packages/db/src/encryption/content-encryption.ts).
package routines

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/shared"
)

// Routine is the wire shape of RoutineSchema (packages/contracts/src/routines/routine.ts:45),
// in the schema's declaration order.
type Routine struct {
	ID              string      `json:"id"`
	BotID           string      `json:"botId"`
	Name            string      `json:"name"`
	Prompt          string      `json:"prompt"`
	Crons           []string    `json:"crons"`
	Timezone        string      `json:"timezone"`
	Active          bool        `json:"active"`
	Notify          bool        `json:"notify"`
	InChat          bool        `json:"inChat"`
	WebhookEnabled  bool        `json:"webhookEnabled"`
	GithubEnabled   bool        `json:"githubEnabled"`
	MessageProvider *string     `json:"messageProvider"`
	EmailSenders    *string     `json:"emailSenders"`
	ModelProvider   *string     `json:"modelProvider"`
	ModelID         *string     `json:"modelId"`
	ThinkingLevel   *string     `json:"thinkingLevel"`
	Watch           *Watch      `json:"watch"`
	WatchState      *WatchState `json:"watchState"`
	LastRunAt       *string     `json:"lastRunAt"`
	NextRunAt       *string     `json:"nextRunAt"`
	ScheduleDelayed bool        `json:"scheduleDelayed"`
	CreatedAt       string      `json:"createdAt"`

	// cronsInvalid marks a stored text[] holding a NULL, which text[] allows and the output
	// schema does not.
	cronsInvalid bool
}

// routineRow is the stored row mapRoutine reads.
type routineRow struct {
	ID              string
	BotID           string
	Name            string
	Prompt          string
	Crons           []*string
	Timezone        string
	Active          bool
	Notify          bool
	InChat          bool
	WebhookEnabled  bool
	GithubEnabled   bool
	MessageProvider *string
	EmailSenders    *string
	ModelProvider   *string
	ModelID         *string
	ThinkingLevel   *string
	Watch           []byte
	WatchState      []byte
	LastRunAt       *time.Time
	NextRunAt       *time.Time
	CreatedAt       time.Time
}

// routineColumns is every column mapRoutine reads, in routineRow's order.
const routineColumns = `id, "botId", name, prompt, crons, timezone, active, notify, "inChat",
	"webhookEnabled", "githubEnabled", "messageProvider", "emailSenders", "modelProvider",
	"modelId", "thinkingLevel", watch, "watchState", "lastRunAt", "nextRunAt", "createdAt"`

func scanRoutine(source pgx.Row) (routineRow, error) {
	var row routineRow
	err := source.Scan(&row.ID, &row.BotID, &row.Name, &row.Prompt, &row.Crons, &row.Timezone,
		&row.Active, &row.Notify, &row.InChat, &row.WebhookEnabled, &row.GithubEnabled,
		&row.MessageProvider, &row.EmailSenders, &row.ModelProvider, &row.ModelID,
		&row.ThinkingLevel, &row.Watch, &row.WatchState, &row.LastRunAt, &row.NextRunAt, &row.CreatedAt)
	return row, err
}

// loadRoutines is prisma.routine.findMany({ where: { botId, spaceId } }): the API sets no
// order, so neither does this query.
func loadRoutines(ctx context.Context, tx pgx.Tx, spaceID string, botIDs []string) ([]Routine, error) {
	rows, err := tx.Query(ctx, `SELECT `+routineColumns+` FROM routines
		WHERE "botId" = ANY($1) AND "spaceId" = $2`, botIDs, spaceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	// A list the API builds with .map() is [] and never null.
	loaded := []Routine{}
	for rows.Next() {
		row, err := scanRoutine(rows)
		if err != nil {
			return nil, err
		}
		loaded = append(loaded, mapRoutine(row))
	}
	return loaded, rows.Err()
}

// mapRoutine is mapRoutine (apps/api/src/routines/routines.ts:85). The JSON columns go
// through their schemas on every read (parseRoutineWatch and parseRoutineWatchState), so a
// value that no longer fits answers null instead of surfacing later as a missing field.
func mapRoutine(row routineRow) Routine {
	crons, cronsInvalid := cronStrings(row.Crons)
	return Routine{
		ID:              row.ID,
		BotID:           row.BotID,
		Name:            row.Name,
		Prompt:          row.Prompt,
		Crons:           crons,
		Timezone:        row.Timezone,
		Active:          row.Active,
		Notify:          row.Notify,
		InChat:          row.InChat,
		WebhookEnabled:  row.WebhookEnabled,
		GithubEnabled:   row.GithubEnabled,
		MessageProvider: row.MessageProvider,
		EmailSenders:    emailSenders(row.EmailSenders),
		ModelProvider:   modelProvider(row.ModelProvider),
		ModelID:         row.ModelID,
		ThinkingLevel:   row.ThinkingLevel,
		Watch:           parseWatch(row.Watch),
		WatchState:      parseWatchState(row.WatchState),
		LastRunAt:       isoOptional(row.LastRunAt),
		NextRunAt:       isoOptional(row.NextRunAt),
		ScheduleDelayed: scheduleDelayed(row.Active, row.NextRunAt, time.Now()),
		CreatedAt:       shared.ISOString(row.CreatedAt),
		cronsInvalid:    cronsInvalid,
	}
}

// cronStrings is the row's text[]; a NULL element it cannot hold is reported so the output
// schema refuses the row, as RouteSchema's z.array(z.string()) does.
func cronStrings(stored []*string) ([]string, bool) {
	crons := make([]string, 0, len(stored))
	invalid := false
	for _, cron := range stored {
		if cron == nil {
			invalid = true
			continue
		}
		crons = append(crons, *cron)
	}
	return crons, invalid
}

// emailSenders is RoutineEmailSendersSchema.safeParse(row.emailSenders).data ?? null: an
// unknown value reads as no email trigger.
func emailSenders(stored *string) *string {
	if stored == nil {
		return nil
	}
	if *stored == "owner" || *stored == "domain" {
		return stored
	}
	return nil
}

// modelProvider is `row.modelProvider ? canonicalPiProviderId(row.modelProvider) : null`
// (canonicalPiProviderId, packages/contracts/src/models/model-provider.ts:17).
func modelProvider(stored *string) *string {
	if stored == nil || *stored == "" {
		return nil
	}
	if *stored == "azure-openai-responses" {
		canonical := "azure"
		return &canonical
	}
	return stored
}

// scheduleDelayed is routineScheduleDelayed (packages/core/src/routines/routine-dispatch.ts:2):
// a live routine whose next occurrence is more than five minutes past is running late.
func scheduleDelayed(active bool, nextRunAt *time.Time, now time.Time) bool {
	if !active || nextRunAt == nil {
		return false
	}
	return now.UnixMilli()-nextRunAt.UnixMilli() > 5*60_000
}

func isoOptional(at *time.Time) *string {
	if at == nil {
		return nil
	}
	value := shared.ISOString(*at)
	return &value
}

// messageProviderPattern is the RoutineSchema regex /^[a-z0-9._-]+$/i.
func messageProviderPattern(text string) bool {
	if text == "" {
		return false
	}
	for _, character := range text {
		switch {
		case character >= 'a' && character <= 'z',
			character >= 'A' && character <= 'Z',
			character >= '0' && character <= '9',
			character == '.', character == '_', character == '-':
		default:
			return false
		}
	}
	return true
}

// thinkingLevels is ThinkingLevelSchema (packages/contracts/src/ids.ts:27).
var thinkingLevels = []string{"off", "minimal", "low", "medium", "high", "xhigh", "max"}

// valid is the part of RoutineSchema a stored row can still break: mapRoutine passes
// thinkingLevel through as written and leaves messageProvider to the column, so the
// router's output check can refuse them. A refused routine fails the whole call with
// "Output validation failed".
func (r Routine) valid() bool {
	if r.ID == "" || r.BotID == "" {
		return false
	}
	if r.ThinkingLevel != nil && !contains(thinkingLevels, *r.ThinkingLevel) {
		return false
	}
	if r.MessageProvider != nil {
		if runeCount(*r.MessageProvider) > 50 || !messageProviderPattern(*r.MessageProvider) {
			return false
		}
	}
	return !r.cronsInvalid
}
