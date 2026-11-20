// Package skills ports skills.updateDraft and skills.save: the taught-skill editor's two writes
// (apps/api/src/routes/memory.ts:237-245 over apps/api/src/taught-skills.ts:211-262,448-503).
//
// Both update the taught_skills row and then rewrite the `skill_draft` card in the bot's thread:
// that card lives in messages.blocks, an rkz1 column, and its rewrite is announced by a
// thread.message.updated event. save also appends skill.saved. No adapter is called on either
// path (the computer/sandbox paths of the same service are other procedures).
package skills

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/contentcrypto"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/events"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/orpc"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/messageblocks"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/shared"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/validate"
)

// statuses is TaughtSkillStatusSchema (packages/contracts/src/domain.ts:717).
var statuses = []string{"recording", "drafting", "draft", "saved"}

const draftedMessages = 100

// Playbook is SkillPlaybookSchema (packages/contracts/src/domain.ts:719-727).
type Playbook struct {
	WhenToUse          string   `json:"whenToUse"`
	Inputs             []string `json:"inputs"`
	Steps              []string `json:"steps"`
	HowToCheck         string   `json:"howToCheck"`
	WhatToReturn       string   `json:"whatToReturn"`
	ApprovalBoundaries string   `json:"approvalBoundaries"`
	FailureHandling    string   `json:"failureHandling"`
}

// Recording is TeachRecordingSchema: what parseRecording hands on unchanged.
type Recording struct {
	Events         []any   `json:"events"`
	Snapshots      []any   `json:"snapshots"`
	ControlLeaseID *string `json:"controlLeaseId,omitempty"`
}

// Skill is TaughtSkillSchema (packages/contracts/src/domain.ts:758-771).
type Skill struct {
	ID        string    `json:"id"`
	BotID     string    `json:"botId"`
	Name      string    `json:"name"`
	Goal      string    `json:"goal"`
	Status    string    `json:"status"`
	Playbook  Playbook  `json:"playbook"`
	Recording Recording `json:"recording"`
	StartedAt *string   `json:"startedAt"`
	ExpiresAt *string   `json:"expiresAt"`
	StoppedAt *string   `json:"stoppedAt"`
	CreatedAt string    `json:"createdAt"`
	UpdatedAt string    `json:"updatedAt"`
}

// row is one taught_skills row as these procedures read it.
type row struct {
	ID, SpaceID, BotID, UserID, Name, Goal, Status string
	Playbook, Recording                            any
	StartedAt, ExpiresAt, StoppedAt                *time.Time
	CreatedAt, UpdatedAt                           time.Time
}

const columns = `id, "spaceId", "botId", "userId", name, goal, status, playbook, recording,
	"startedAt", "expiresAt", "stoppedAt", "createdAt", "updatedAt"`

func scan(row pgx.Row) (value row, err error) {
	err = row.Scan(&value.ID, &value.SpaceID, &value.BotID, &value.UserID, &value.Name, &value.Goal, &value.Status,
		&value.Playbook, &value.Recording, &value.StartedAt, &value.ExpiresAt, &value.StoppedAt,
		&value.CreatedAt, &value.UpdatedAt)
	return value, err
}

var (
	errNotEditable = orpc.BadRequest("Skill is not editable yet")
	errNotFinished = orpc.BadRequest("Finish recording before saving")
	// emptyRecording is emptyRecording(): a non-teacher's edit clears the live recording.
	emptyRecording = map[string]any{"events": []any{}, "snapshots": []any{}}
)

func now() time.Time { return time.Now().UTC().Truncate(time.Millisecond) }

// parsePlaybook is parsePlaybook: every field coerced, never refused (teaching-session.ts:86-100).
func parsePlaybook(value any) Playbook {
	object, ok := value.(map[string]any)
	if !ok {
		return Playbook{Inputs: []string{}, Steps: []string{}}
	}
	text := func(key string) string {
		field, present := object[key]
		if !present || field == nil {
			return ""
		}
		return jsString(field)
	}
	list := func(key string) []string {
		field, ok := object[key].([]any)
		if !ok {
			return []string{}
		}
		values := make([]string, len(field))
		for index, item := range field {
			values[index] = jsString(item)
		}
		return values
	}
	return Playbook{
		WhenToUse: text("whenToUse"), Inputs: list("inputs"), Steps: list("steps"),
		HowToCheck: text("howToCheck"), WhatToReturn: text("whatToReturn"),
		ApprovalBoundaries: text("approvalBoundaries"), FailureHandling: text("failureHandling"),
	}
}

// jsString is JavaScript's String(): a string as itself, a number or boolean in its own form, a
// list joined with commas, and an object as "[object Object]".
func jsString(value any) string {
	switch typed := value.(type) {
	case string:
		return typed
	case nil:
		return "null"
	case bool:
		if typed {
			return "true"
		}
		return "false"
	case []any:
		parts := make([]string, len(typed))
		for index, item := range typed {
			parts[index] = jsString(item)
		}
		return strings.Join(parts, ",")
	case map[string]any:
		return "[object Object]"
	}
	return validate.Stringify(value)
}

// parseRecording is parseRecording: the stored arrays pass through as they are.
func parseRecording(value any) Recording {
	recording := Recording{Events: []any{}, Snapshots: []any{}}
	object, ok := value.(map[string]any)
	if !ok {
		return recording
	}
	if list, ok := object["events"].([]any); ok {
		recording.Events = list
	}
	if list, ok := object["snapshots"].([]any); ok {
		recording.Snapshots = list
	}
	if lease, ok := object["controlLeaseId"].(string); ok {
		recording.ControlLeaseID = &lease
	}
	return recording
}

// mapSkill is mapTaughtSkill (packages/adapters/src/teaching-session.ts:102-117).
func mapSkill(value row) Skill {
	skill := Skill{
		ID: value.ID, BotID: value.BotID, Name: value.Name, Goal: value.Goal, Status: value.Status,
		Playbook: parsePlaybook(value.Playbook), Recording: parseRecording(value.Recording),
		CreatedAt: shared.ISO(value.CreatedAt), UpdatedAt: shared.ISO(value.UpdatedAt),
	}
	if value.StartedAt != nil {
		at := shared.ISO(*value.StartedAt)
		skill.StartedAt = &at
	}
	if value.ExpiresAt != nil {
		at := shared.ISO(*value.ExpiresAt)
		skill.ExpiresAt = &at
	}
	if value.StoppedAt != nil {
		at := shared.ISO(*value.StoppedAt)
		skill.StoppedAt = &at
	}
	return skill
}

// skillFor is skillFor: the caller's own recording, or an empty one to others.
func skillFor(actor db.Actor, value row) Skill {
	skill := mapSkill(value)
	if value.UserID != actor.UserID {
		skill.Recording = parseRecording(emptyRecording)
	}
	return skill
}

// outputValid is the router's TaughtSkillSchema parse: the status enum, the recording entries
// (teach event kinds and snapshot fields), and the playbook fields that parsePlaybook fabricated.
func outputValid(skill Skill) bool {
	known := false
	for _, status := range statuses {
		if skill.Status == status {
			known = true
		}
	}
	if !known || skill.ID == "" || skill.BotID == "" {
		return false
	}
	for _, event := range skill.Recording.Events {
		entry, ok := event.(map[string]any)
		if !ok {
			return false
		}
		if _, ok := entry["at"].(string); !ok {
			return false
		}
		kind, ok := entry["kind"].(string)
		if !ok {
			return false
		}
		switch kind {
		case "pointer", "key", "clipboard", "snapshot", "scroll":
		default:
			return false
		}
		for _, key := range []string{"x", "y"} {
			if value, present := entry[key]; present && value != nil {
				if _, ok := value.(json.Number); !ok {
					if _, isFloat := value.(float64); !isFloat {
						return false
					}
				}
			}
		}
		for _, key := range []string{"button", "type", "key", "text", "summary"} {
			if value, present := entry[key]; present && value != nil {
				if _, ok := value.(string); !ok {
					return false
				}
			}
		}
		if value, present := entry["sensitive"]; present && value != nil {
			if _, ok := value.(bool); !ok {
				return false
			}
		}
	}
	for _, snapshot := range skill.Recording.Snapshots {
		entry, ok := snapshot.(map[string]any)
		if !ok {
			return false
		}
		if _, ok := entry["at"].(string); !ok {
			return false
		}
		if _, ok := entry["summary"].(string); !ok {
			return false
		}
		if hash, present := entry["hash"]; present && hash != nil {
			if _, ok := hash.(string); !ok {
				return false
			}
		}
	}
	return true
}

// getOwned is getOwnedSkill: the skill of the actor's Space (not necessarily theirs).
func getOwned(ctx context.Context, tx pgx.Tx, actor db.Actor, skillID string) (row, error) {
	value, err := scan(tx.QueryRow(ctx, `SELECT `+columns+` FROM taught_skills WHERE id = $1 AND "spaceId" = $2`,
		skillID, actor.SpaceID))
	if errors.Is(err, pgx.ErrNoRows) {
		return row{}, shared.NotFound
	}
	return value, err
}

// botThread is bot.findUnique({ include: { thread: true } }) for a skill's bot: the bot's id and,
// when it has one, its thread (with the summary opened, as the Prisma read decrypts it).
type botThread struct {
	BotID    string
	ThreadID *string
}

func botWithThread(ctx context.Context, tx pgx.Tx, ring *contentcrypto.KeyRing, botID string) (botThread, error) {
	var found botThread
	var threadID, spaceID, userID *string
	var summary *string
	err := tx.QueryRow(ctx, `SELECT b.id, t.id, t."spaceId", t."userId", t."historyCompactionSummary"
		FROM bots b LEFT JOIN threads t ON t."botId" = b.id WHERE b.id = $1 LIMIT 1`, botID).
		Scan(&found.BotID, &threadID, &spaceID, &userID, &summary)
	if errors.Is(err, pgx.ErrNoRows) {
		return botThread{}, nil
	}
	if err != nil {
		return botThread{}, err
	}
	if threadID == nil {
		return found, nil
	}
	found.ThreadID = threadID
	if spaceID != nil && userID != nil {
		var stored any
		if summary != nil {
			stored = *summary
		}
		if err := ring.OpenRows(ctx, "Thread", []map[string]any{{
			"id": *threadID, "spaceId": *spaceID, "userId": *userID, "historyCompactionSummary": stored,
		}}); err != nil {
			return botThread{}, err
		}
	}
	return found, nil
}

// sameBlock is `block === existing`: the exact map the read produced, not an equal one.
func sameBlock(left, right map[string]any) bool {
	return reflect.ValueOf(left).UnsafePointer() == reflect.ValueOf(right).UnsafePointer()
}

// updateDraftMessage is updateSkillDraftMessage (taught-skills.ts:211-262): the newest bot message
// holding this skill's draft card is rewritten, then the thread hears the update.
func updateDraftMessage(ctx context.Context, tx pgx.Tx, ring *contentcrypto.KeyRing, deployment shared.Deployment,
	actor db.Actor, skill row, name string, playbook Playbook, status string) error {
	bot, err := botWithThread(ctx, tx, ring, skill.BotID)
	if err != nil {
		return err
	}
	if bot.ThreadID == nil {
		return nil
	}
	threadID := *bot.ThreadID
	rows, err := tx.Query(ctx, `SELECT id, blocks FROM messages WHERE "threadId" = $1 AND role = 'bot'
		ORDER BY seq DESC LIMIT $2`, threadID, draftedMessages)
	if err != nil {
		return err
	}
	type storedMessage struct {
		ID     string
		Blocks any
	}
	var messages []storedMessage
	for rows.Next() {
		var message storedMessage
		if err := rows.Scan(&message.ID, &message.Blocks); err != nil {
			rows.Close()
			return err
		}
		messages = append(messages, message)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	opened := make([]map[string]any, len(messages))
	for index, message := range messages {
		opened[index] = map[string]any{"id": message.ID, "threadId": threadID, "blocks": message.Blocks}
	}
	if len(opened) > 0 {
		if err := ring.OpenRows(ctx, "Message", opened); err != nil {
			return err
		}
	}
	for index, message := range messages {
		var existing map[string]any
		for _, block := range messageblocks.Stored(opened[index]["blocks"]) {
			if block["kind"] == "skill_draft" && block["skillId"] == skill.ID {
				existing = block
				break
			}
		}
		if existing == nil {
			continue
		}
		draft := map[string]any{
			"kind": "skill_draft", "skillId": skill.ID, "name": name, "goal": skill.Goal,
			"playbook": playbookValue(playbook), "status": status,
		}
		stored, shown, changed, ok := messageblocks.Rewrite(opened[index]["blocks"], func(block map[string]any) (map[string]any, bool) {
			if sameBlock(block, existing) {
				return draft, true
			}
			return block, false
		})
		if !ok || !changed {
			return nil
		}
		sealed, err := ring.SealRow(ctx, "Message", map[string]any{
			"id": message.ID, "threadId": threadID, "blocks": stored,
		})
		if err != nil {
			return err
		}
		body, err := json.Marshal(sealed["blocks"])
		if err != nil {
			return fmt.Errorf("store message blocks: %w", err)
		}
		if ring.EncryptWrites {
			if _, err := tx.Exec(ctx, `UPDATE messages SET blocks = $1::jsonb, "searchTokens" = $3 WHERE id = $2`,
				string(body), message.ID, sealed["searchTokens"]); err != nil {
				return err
			}
		} else if _, err := tx.Exec(ctx, `UPDATE messages SET blocks = $1::jsonb, "searchTokens" = '{}' WHERE id = $2`,
			string(body), message.ID); err != nil {
			return err
		}
		event, err := events.Append(ctx, tx, ring, events.Input{
			SpaceID: actor.SpaceID, ThreadID: threadID, BotID: bot.BotID,
			Type: "thread.message.updated",
			Payload: map[string]any{
				"messageId": message.ID, "role": "bot", "blocks": messageblocks.JSONValue(shown),
			},
		})
		if err != nil {
			return err
		}
		notify(ctx, deployment, event)
		return nil
	}
	return nil
}

// playbookValue is the stored JSON of a playbook: its seven fields, in schema order.
func playbookValue(playbook Playbook) map[string]any {
	return map[string]any{
		"whenToUse": playbook.WhenToUse, "inputs": stringsToAny(playbook.Inputs), "steps": stringsToAny(playbook.Steps),
		"howToCheck": playbook.HowToCheck, "whatToReturn": playbook.WhatToReturn,
		"approvalBoundaries": playbook.ApprovalBoundaries, "failureHandling": playbook.FailureHandling,
	}
}

func stringsToAny(values []string) []any {
	list := make([]any, len(values))
	for index, value := range values {
		list[index] = value
	}
	return list
}

// notify is deps.events.notify after the append committed.
func notify(ctx context.Context, deployment shared.Deployment, event events.Event) {
	firstResponse := ""
	if event.FirstResponse && event.RunID != nil {
		firstResponse = *event.RunID
	}
	events.NotifyCommitted(ctx, deployment.Events, nil, nil, event.ThreadID, event.Seq, firstResponse)
}

type draftInput struct {
	SkillID  string
	Name     *string
	Playbook Playbook
}

// parseDraft is z.object({ skillId: Id, name: z.string().optional(), playbook: SkillPlaybookSchema }).
func parseDraft(raw orpc.Input) (draftInput, *orpc.Error) {
	object, issues := validate.Decode(raw.Raw, nil)
	if issues != nil {
		return draftInput{}, validate.Fail(issues)
	}
	var found []validate.Issue
	skillID, problems := validate.String(validate.Path{"skillId"}, object.Field("skillId"), validate.StringRules{Min: 1})
	found = append(found, problems...)
	var name *string
	if value := object.Field("name"); value != validate.Undefined {
		text, problems := validate.String(validate.Path{"name"}, value, validate.StringRules{})
		found = append(found, problems...)
		if problems == nil {
			name = &text
		}
	}
	playbook, problems := parsePlaybookInput(object.Field("playbook"), validate.Path{"playbook"})
	found = append(found, problems...)
	if found != nil {
		return draftInput{}, validate.Fail(found)
	}
	return draftInput{SkillID: skillID, Name: name, Playbook: playbook}, nil
}

// parsePlaybookInput is SkillPlaybookSchema: seven fields, every one required.
func parsePlaybookInput(raw any, path validate.Path) (Playbook, []validate.Issue) {
	var playbook Playbook
	object, issues := validate.AsObject(raw, path)
	if issues != nil {
		return playbook, issues
	}
	var found []validate.Issue
	fields := []struct {
		key    string
		target *string
	}{{"whenToUse", &playbook.WhenToUse}, {"howToCheck", &playbook.HowToCheck},
		{"whatToReturn", &playbook.WhatToReturn}, {"approvalBoundaries", &playbook.ApprovalBoundaries},
		{"failureHandling", &playbook.FailureHandling}}
	for _, field := range fields {
		text, problems := validate.String(path.With(field.key), object.Field(field.key), validate.StringRules{})
		found = append(found, problems...)
		*field.target = text
	}
	for _, list := range []struct {
		key    string
		target *[]string
	}{{"inputs", &playbook.Inputs}, {"steps", &playbook.Steps}} {
		values, problems := validate.AsArray(path.With(list.key), object.Field(list.key))
		found = append(found, problems...)
		if problems != nil {
			continue
		}
		texts := make([]string, len(values))
		for index, value := range values {
			text, problems := validate.String(path.With(list.key).With(index), value, validate.StringRules{})
			found = append(found, problems...)
			texts[index] = text
		}
		*list.target = texts
	}
	return playbook, found
}

// UpdateDraft implements skills.updateDraft: the editor owns the playbook, so its next run uses
// the editor's accounts; the thread's draft card follows.
func UpdateDraft(ctx context.Context, database *db.DB, deployment shared.Deployment, actor db.Actor, raw orpc.Input) (any, *orpc.Error) {
	input, failure := parseDraft(raw)
	if failure != nil {
		return nil, failure
	}
	ring := deployment.Content
	if ring == nil {
		return nil, shared.Failure(errors.New("content encryption is not configured"))
	}
	var skill Skill
	err := database.Tenant(ctx, actor, func(tx pgx.Tx) error {
		current, err := getOwned(ctx, tx, actor, input.SkillID)
		if err != nil {
			return err
		}
		if current.Status != "draft" && current.Status != "saved" {
			return errNotEditable
		}
		name := current.Name
		if input.Name != nil {
			name = *input.Name
		}
		status := "draft"
		if current.Status == "saved" {
			status = "saved"
		}
		recording := any(nil)
		if current.UserID != actor.UserID {
			recording = emptyRecording
		}
		updated, err := updateSkill(ctx, tx, current.ID, actor.UserID, name, playbookValue(input.Playbook), status, recording)
		if err != nil {
			return err
		}
		if err := updateDraftMessage(ctx, tx, ring, deployment, actor, updated, updated.Name,
			parsePlaybook(updated.Playbook), status); err != nil {
			return err
		}
		skill = skillFor(actor, updated)
		return nil
	})
	if err != nil {
		return nil, shared.Failure(err)
	}
	if !outputValid(skill) {
		return nil, shared.OutputInvalid()
	}
	return skill, nil
}

// updateSkill is the taught_skills update both procedures make; `recording` is nil when the
// caller owns the session and the stored recording stays.
func updateSkill(ctx context.Context, tx pgx.Tx, id, userID, name string, playbook map[string]any, status string, recording any) (row, error) {
	if recording == nil {
		value, err := scan(tx.QueryRow(ctx, `UPDATE taught_skills SET "userId" = $2, name = $3, playbook = $4::jsonb,
			status = $5, "updatedAt" = $6 WHERE id = $1 RETURNING `+columns,
			id, userID, shared.StoredText(name), mustJSON(playbook), status, now()))
		return value, err
	}
	value, err := scan(tx.QueryRow(ctx, `UPDATE taught_skills SET "userId" = $2, name = $3, playbook = $4::jsonb,
		status = $5, recording = $6::jsonb, "updatedAt" = $7 WHERE id = $1 RETURNING `+columns,
		id, userID, shared.StoredText(name), mustJSON(playbook), status, mustJSON(recording), now()))
	return value, err
}

func mustJSON(value any) string {
	body, err := json.Marshal(value)
	if err != nil {
		return "{}"
	}
	return string(body)
}

type saveInput struct {
	SkillID string
	Name    *string
}

// parseSave is z.object({ skillId: Id, name: z.string().optional() }).
func parseSave(raw orpc.Input) (saveInput, *orpc.Error) {
	object, issues := validate.Decode(raw.Raw, nil)
	if issues != nil {
		return saveInput{}, validate.Fail(issues)
	}
	var found []validate.Issue
	skillID, problems := validate.String(validate.Path{"skillId"}, object.Field("skillId"), validate.StringRules{Min: 1})
	found = append(found, problems...)
	var name *string
	if value := object.Field("name"); value != validate.Undefined {
		text, problems := validate.String(validate.Path{"name"}, value, validate.StringRules{})
		found = append(found, problems...)
		if problems == nil {
			name = &text
		}
	}
	if found != nil {
		return saveInput{}, validate.Fail(found)
	}
	return saveInput{SkillID: skillID, Name: name}, nil
}

// Save implements skills.save: the draft becomes a saved skill, the card follows, and the thread
// hears skill.saved.
func Save(ctx context.Context, database *db.DB, deployment shared.Deployment, actor db.Actor, raw orpc.Input) (any, *orpc.Error) {
	input, failure := parseSave(raw)
	if failure != nil {
		return nil, failure
	}
	ring := deployment.Content
	if ring == nil {
		return nil, shared.Failure(errors.New("content encryption is not configured"))
	}
	var skill Skill
	err := database.Tenant(ctx, actor, func(tx pgx.Tx) error {
		current, err := getOwned(ctx, tx, actor, input.SkillID)
		if err != nil {
			return err
		}
		if current.Status != "draft" && current.Status != "saved" {
			return errNotFinished
		}
		name := ""
		if input.Name != nil {
			name = *input.Name
		} else if current.Name != "" {
			name = current.Name
		} else {
			name = sliceUTF16(current.Goal, 0, 80)
		}
		recording := any(nil)
		if current.UserID != actor.UserID {
			recording = emptyRecording
		}
		updated, err := updateSkill(ctx, tx, current.ID, actor.UserID, name, parsePlaybookJSON(current.Playbook), "saved", recording)
		if err != nil {
			return err
		}
		bot, err := botWithThread(ctx, tx, ring, updated.BotID)
		if err != nil {
			return err
		}
		if err := updateDraftMessage(ctx, tx, ring, deployment, actor, updated, updated.Name,
			parsePlaybook(updated.Playbook), "saved"); err != nil {
			return err
		}
		if bot.ThreadID != nil {
			event, err := events.Append(ctx, tx, ring, events.Input{
				SpaceID: actor.SpaceID, ThreadID: *bot.ThreadID, BotID: bot.BotID,
				Type:    "skill.saved",
				Payload: map[string]any{"skillId": updated.ID, "name": updated.Name},
			})
			if err != nil {
				return err
			}
			notify(ctx, deployment, event)
		}
		skill = skillFor(actor, updated)
		return nil
	})
	if err != nil {
		return nil, shared.Failure(err)
	}
	if !outputValid(skill) {
		return nil, shared.OutputInvalid()
	}
	return skill, nil
}

// parsePlaybookJSON keeps the stored playbook as written for the save path, where updateDraft
// would have replaced it: `playbook` is not in save's input.
func parsePlaybookJSON(value any) map[string]any {
	object, ok := value.(map[string]any)
	if !ok {
		return playbookValue(Playbook{Inputs: []string{}, Steps: []string{}})
	}
	return object
}

// sliceUTF16 is goal.slice(0, 80): UTF-16 code units, so a surrogate pair counts twice.
func sliceUTF16(text string, start, end int) string {
	units := 0
	from := -1
	for index, character := range text {
		if units == start && from < 0 {
			from = index
		}
		step := 1
		if character > 0xFFFF {
			step = 2
		}
		if units+step > end {
			if from < 0 {
				return ""
			}
			return text[from:index]
		}
		units += step
	}
	if from < 0 {
		return text
	}
	return text[from:]
}
