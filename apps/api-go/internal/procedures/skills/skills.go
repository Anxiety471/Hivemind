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
	"strconv"
	"strings"
	"time"
	"unicode/utf16"

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

// RecordingEvent is TeachRecordingEventSchema (packages/contracts/src/domain.ts:730-742). The
// output parse keeps only these keys, so an unknown key in the stored JSON is dropped.
type RecordingEvent struct {
	At        string   `json:"at"`
	Kind      string   `json:"kind"`
	X         *float64 `json:"x,omitempty"`
	Y         *float64 `json:"y,omitempty"`
	Button    *string  `json:"button,omitempty"`
	Type      *string  `json:"type,omitempty"`
	Key       *string  `json:"key,omitempty"`
	Text      *string  `json:"text,omitempty"`
	Summary   *string  `json:"summary,omitempty"`
	Sensitive *bool    `json:"sensitive,omitempty"`
}

// RecordingSnapshot is TeachSnapshotSchema (packages/contracts/src/domain.ts:744-748).
type RecordingSnapshot struct {
	At      string  `json:"at"`
	Summary string  `json:"summary"`
	Hash    *string `json:"hash,omitempty"`
}

// Recording is TeachRecordingSchema: parseRecording's view, narrowed by the output parse.
type Recording struct {
	Events         []RecordingEvent    `json:"events"`
	Snapshots      []RecordingSnapshot `json:"snapshots"`
	ControlLeaseID *string             `json:"controlLeaseId,omitempty"`
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
	// errOutputInvalid marks a stored row the router's TaughtSkillSchema parse refuses.
	errOutputInvalid = errors.New("skill output validation failed")
	errNotFinished = orpc.BadRequest("Finish recording before saving")
	// emptyRecording is emptyRecording(): a non-teacher's edit clears the live recording.
	emptyRecording = map[string]any{"events": []any{}, "snapshots": []any{}}
)

func now() time.Time { return time.Now().UTC().Truncate(time.Millisecond) }

// The prompt constants buildPlaybookFromRecording("", []) answers with (teach-playbook.prompt.ts:1-14).
const (
	defaultWhenToUse    = "When the user asks to repeat the demonstrated task."
	defaultStep         = "Repeat the demonstrated workflow using the same navigation pattern."
	defaultHowToCheck   = "Confirm the outcome matches the user's goal before reporting success."
	defaultWhatToReturn = "A short summary of what was completed and where outputs were saved."
	defaultApproval     = "Do not send messages, spend money, publish content, or delete data without explicit user approval."
	defaultFailure      = "If a step fails or the expected screen is not visible, stop and ask the user before retrying."
)

// defaultPlaybook is buildPlaybookFromRecording("", []) (teach-playbook.ts:88-243): what
// parsePlaybook answers for a stored value JavaScript does not see as an object.
func defaultPlaybook() Playbook {
	return Playbook{
		WhenToUse: defaultWhenToUse, Inputs: []string{}, Steps: []string{defaultStep},
		HowToCheck: defaultHowToCheck, WhatToReturn: defaultWhatToReturn,
		ApprovalBoundaries: defaultApproval, FailureHandling: defaultFailure,
	}
}

// parsePlaybook is parsePlaybook: every field coerced, never refused (teaching-session.ts:100-115).
func parsePlaybook(value any) Playbook {
	object, ok := value.(map[string]any)
	if !ok {
		// An array is an object to JavaScript, so its missing fields coerce to the empty values;
		// anything else (null, a string, a number) takes the recording defaults.
		if _, isList := value.([]any); !isList {
			return defaultPlaybook()
		}
		object = map[string]any{}
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
		// Array#join renders null/undefined as an empty field, not as "null".
		parts := make([]string, len(typed))
		for index, item := range typed {
			if item == nil {
				continue
			}
			parts[index] = jsString(item)
		}
		return strings.Join(parts, ",")
	case float64:
		// The database driver decodes JSON numbers as float64, while the wire parser's
		// DecodeAny yields json.Number. Both are JavaScript numbers: render them the way
		// String() does, which validate.Stringify already implements for json.Number.
		return validate.Stringify(json.Number(strconv.FormatFloat(typed, 'g', -1, 64)))
	case map[string]any:
		return "[object Object]"
	}
	return validate.Stringify(value)
}

// recordingKinds is the TeachRecordingEventSchema kind enum (domain.ts:732).
var recordingKinds = []string{"pointer", "key", "clipboard", "snapshot", "scroll"}

// parseRecording is parseRecording (teaching-session.ts:73-81), narrowed by the output parse:
// the stored arrays keep only the schema's keys (zod strips the rest), and a value the schema
// refuses reports false so the procedure answers Output validation failed. A recording that is
// not an object reads as an empty one, as parseRecording's `record.events` is then undefined.
func parseRecording(value any) (Recording, bool) {
	recording := Recording{Events: []RecordingEvent{}, Snapshots: []RecordingSnapshot{}}
	object, ok := value.(map[string]any)
	if !ok {
		return recording, true
	}
	if lease, ok := object["controlLeaseId"].(string); ok {
		recording.ControlLeaseID = &lease
	}
	if list, ok := object["events"].([]any); ok {
		events := make([]RecordingEvent, 0, len(list))
		for _, entry := range list {
			event, ok := narrowEvent(entry)
			if !ok {
				return recording, false
			}
			events = append(events, event)
		}
		recording.Events = events
	}
	if list, ok := object["snapshots"].([]any); ok {
		snapshots := make([]RecordingSnapshot, 0, len(list))
		for _, entry := range list {
			snapshot, ok := narrowSnapshot(entry)
			if !ok {
				return recording, false
			}
			snapshots = append(snapshots, snapshot)
		}
		recording.Snapshots = snapshots
	}
	return recording, true
}

// narrowEvent is one TeachRecordingEventSchema parse. A present key that is null or of another
// type fails: zod's .optional() admits an absent key or a value, never null.
func narrowEvent(value any) (RecordingEvent, bool) {
	entry, ok := value.(map[string]any)
	if !ok {
		return RecordingEvent{}, false
	}
	at, ok := entry["at"].(string)
	if !ok {
		return RecordingEvent{}, false
	}
	kind, ok := entry["kind"].(string)
	if !ok {
		return RecordingEvent{}, false
	}
	known := false
	for _, candidate := range recordingKinds {
		if kind == candidate {
			known = true
		}
	}
	if !known {
		return RecordingEvent{}, false
	}
	event := RecordingEvent{At: at, Kind: kind}
	for key, target := range map[string]**float64{"x": &event.X, "y": &event.Y} {
		if raw, present := entry[key]; present {
			number, ok := recordingNumber(raw)
			if !ok {
				return RecordingEvent{}, false
			}
			*target = number
		}
	}
	for key, target := range map[string]**string{
		"button": &event.Button, "type": &event.Type, "key": &event.Key,
		"text": &event.Text, "summary": &event.Summary,
	} {
		if raw, present := entry[key]; present {
			text, ok := raw.(string)
			if !ok {
				return RecordingEvent{}, false
			}
			*target = &text
		}
	}
	if raw, present := entry["sensitive"]; present {
		flag, ok := raw.(bool)
		if !ok {
			return RecordingEvent{}, false
		}
		event.Sensitive = &flag
	}
	return event, true
}

// recordingNumber is z.number(): any finite JSON number.
func recordingNumber(value any) (*float64, bool) {
	switch typed := value.(type) {
	case float64:
		return &typed, true
	case json.Number:
		parsed, err := typed.Float64()
		if err != nil {
			return nil, false
		}
		return &parsed, true
	case int64:
		parsed := float64(typed)
		return &parsed, true
	case int:
		parsed := float64(typed)
		return &parsed, true
	}
	return nil, false
}

func narrowSnapshot(value any) (RecordingSnapshot, bool) {
	entry, ok := value.(map[string]any)
	if !ok {
		return RecordingSnapshot{}, false
	}
	at, ok := entry["at"].(string)
	if !ok {
		return RecordingSnapshot{}, false
	}
	summary, ok := entry["summary"].(string)
	if !ok {
		return RecordingSnapshot{}, false
	}
	snapshot := RecordingSnapshot{At: at, Summary: summary}
	if raw, present := entry["hash"]; present {
		hash, ok := raw.(string)
		if !ok {
			return RecordingSnapshot{}, false
		}
		snapshot.Hash = &hash
	}
	return snapshot, true
}

// mapSkill is mapTaughtSkill (packages/adapters/src/teaching-session.ts:117-132). The bool is the
// output parse of the recording: false means a stored entry the schema refuses.
func mapSkill(value row) (Skill, bool) {
	recording, ok := parseRecording(value.Recording)
	skill := Skill{
		ID: value.ID, BotID: value.BotID, Name: value.Name, Goal: value.Goal, Status: value.Status,
		Playbook: parsePlaybook(value.Playbook), Recording: recording,
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
	return skill, ok
}

// skillFor is skillFor: the caller's own recording, or an empty one to others. A recording the
// schema refuses is only their own problem: the replacement is parsed, so it is valid.
func skillFor(actor db.Actor, value row) (Skill, bool) {
	skill, ok := mapSkill(value)
	if value.UserID != actor.UserID {
		skill.Recording, _ = parseRecording(emptyRecording)
		ok = true
	}
	return skill, ok
}

// outputValid is the rest of the router's TaughtSkillSchema parse: the status enum and the ids.
// The recording was already narrowed and checked by parseRecording.
func outputValid(skill Skill) bool {
	known := false
	for _, status := range statuses {
		if skill.Status == status {
			known = true
		}
	}
	return known && skill.ID != "" && skill.BotID != ""
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
func updateDraftMessage(ctx context.Context, database *db.DB, ring *contentcrypto.KeyRing, deployment shared.Deployment,
	actor db.Actor, skill row, name string, playbook Playbook, status string) error {
	var card cardUpdate
	err := database.Tenant(ctx, actor, func(tx pgx.Tx) error {
		update, err := findAndRewriteCard(ctx, tx, ring, actor, skill, name, playbook, status)
		card = update
		return err
	})
	if err != nil || !card.written {
		return err
	}
	var appended *events.Event
	err = database.Tenant(ctx, actor, func(tx pgx.Tx) error {
		event, err := events.Append(ctx, tx, ring, events.Input{
			SpaceID: actor.SpaceID, ThreadID: card.ThreadID, BotID: card.BotID,
			Type: "thread.message.updated",
			Payload: map[string]any{
				"messageId": card.MessageID, "role": "bot", "blocks": messageblocks.JSONValue(card.Blocks),
			},
		})
		if err != nil {
			return err
		}
		appended = &event
		return nil
	})
	if err != nil {
		return err
	}
	notify(ctx, deployment, *appended)
	return nil
}

// cardUpdate is what the message-rewrite transaction found and wrote.
type cardUpdate struct {
	written   bool
	ThreadID  string
	BotID     string
	MessageID string
	Blocks    []map[string]any
}

func findAndRewriteCard(ctx context.Context, tx pgx.Tx, ring *contentcrypto.KeyRing, actor db.Actor,
	skill row, name string, playbook Playbook, status string) (cardUpdate, error) {
	bot, err := botWithThread(ctx, tx, ring, skill.BotID)
	if err != nil {
		return cardUpdate{}, err
	}
	if bot.ThreadID == nil {
		return cardUpdate{}, nil
	}
	threadID := *bot.ThreadID
	rows, err := tx.Query(ctx, `SELECT id, blocks FROM messages WHERE "threadId" = $1 AND role = 'bot'
		ORDER BY seq DESC LIMIT $2`, threadID, draftedMessages)
	if err != nil {
		return cardUpdate{}, err
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
			return cardUpdate{}, err
		}
		messages = append(messages, message)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return cardUpdate{}, err
	}
	opened := make([]map[string]any, len(messages))
	for index, message := range messages {
		opened[index] = map[string]any{"id": message.ID, "threadId": threadID, "blocks": message.Blocks}
	}
	if len(opened) > 0 {
		if err := ring.OpenRows(ctx, "Message", opened); err != nil {
			return cardUpdate{}, err
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
			return cardUpdate{}, nil
		}
		sealed, err := ring.SealRow(ctx, "Message", map[string]any{
			"id": message.ID, "threadId": threadID, "blocks": stored,
		})
		if err != nil {
			return cardUpdate{}, err
		}
		body, err := json.Marshal(sealed["blocks"])
		if err != nil {
			return cardUpdate{}, fmt.Errorf("store message blocks: %w", err)
		}
		if ring.EncryptWrites {
			if _, err := tx.Exec(ctx, `UPDATE messages SET blocks = $1::jsonb, "searchTokens" = $3 WHERE id = $2`,
				string(body), message.ID, sealed["searchTokens"]); err != nil {
				return cardUpdate{}, err
			}
		} else if _, err := tx.Exec(ctx, `UPDATE messages SET blocks = $1::jsonb, "searchTokens" = '{}' WHERE id = $2`,
			string(body), message.ID); err != nil {
			return cardUpdate{}, err
		}
		return cardUpdate{written: true, ThreadID: threadID, BotID: bot.BotID, MessageID: message.ID,
			Blocks: shown}, nil
	}
	return cardUpdate{}, nil
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
	var updated row
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
		updated, err = updateSkill(ctx, tx, current.ID, actor.UserID, name, playbookValue(input.Playbook), status, recording)
		return err
	})
	if err != nil {
		return nil, shared.Failure(err)
	}
	// Each of these is its own statement in TypeScript: a failure leaves the row update committed.
	if err := updateDraftMessage(ctx, database, ring, deployment, actor, updated, updated.Name,
		parsePlaybook(updated.Playbook), updated.Status); err != nil {
		return nil, shared.Failure(err)
	}
	skill, recordingOK := skillFor(actor, updated)
	if !recordingOK || !outputValid(skill) {
		return nil, shared.OutputInvalid()
	}
	return skill, nil
}

// updateSkill is updateDraft's taught_skills update: the editor's playbook replaces the stored one,
// and `recording` is nil when the caller owns the session, so the stored recording stays.
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
		return nil, shared.Failure(errors.New("encryption is not configured"))
	}
	var updated row
	var bot botThread
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
		updated, err = saveSkill(ctx, tx, current.ID, actor.UserID, name, "saved", recording)
		return err
	})
	if err != nil {
		return nil, shared.Failure(err)
	}
	// The bot lookup and the card rewrite are separate statements in TypeScript as well.
	err = database.Tenant(ctx, actor, func(tx pgx.Tx) error {
		found, err := botWithThread(ctx, tx, ring, updated.BotID)
		bot = found
		return err
	})
	if err != nil {
		return nil, shared.Failure(err)
	}
	if err := updateDraftMessage(ctx, database, ring, deployment, actor, updated, updated.Name,
		parsePlaybook(updated.Playbook), "saved"); err != nil {
		return nil, shared.Failure(err)
	}
	if bot.ThreadID != nil {
		var appended *events.Event
		err := database.Tenant(ctx, actor, func(tx pgx.Tx) error {
			event, err := events.Append(ctx, tx, ring, events.Input{
				SpaceID: actor.SpaceID, ThreadID: *bot.ThreadID, BotID: bot.BotID,
				Type:    "skill.saved",
				Payload: map[string]any{"skillId": updated.ID, "name": updated.Name},
			})
			if err != nil {
				return err
			}
			appended = &event
			return nil
		})
		if err != nil {
			return nil, shared.Failure(err)
		}
		notify(ctx, deployment, *appended)
	}
	skill, recordingOK := skillFor(actor, updated)
	if !recordingOK || !outputValid(skill) {
		return nil, shared.OutputInvalid()
	}
	return skill, nil
}

// saveSkill is save's taught_skills update. TypeScript's data has userId, the recording handed
// over, status and name only: the stored playbook is left as written (taught-skills.ts:475-482).
func saveSkill(ctx context.Context, tx pgx.Tx, id, userID, name, status string, recording any) (row, error) {
	if recording == nil {
		value, err := scan(tx.QueryRow(ctx, `UPDATE taught_skills SET "userId" = $2, name = $3,
			status = $4, "updatedAt" = $5 WHERE id = $1 RETURNING `+columns,
			id, userID, shared.StoredText(name), status, now()))
		return value, err
	}
	value, err := scan(tx.QueryRow(ctx, `UPDATE taught_skills SET "userId" = $2, name = $3,
		status = $4, recording = $5::jsonb, "updatedAt" = $6 WHERE id = $1 RETURNING `+columns,
		id, userID, shared.StoredText(name), status, mustJSON(recording), now()))
	return value, err
}

// sliceUTF16 is text.slice(start, end) in UTF-16 code units, then the write hook's
// sanitizeUtf16ForJson (text-sanitization.ts:58, packages/core/src/events.ts:772-777): a cut that
// lands inside a surrogate pair leaves one lone half, and each lone half becomes U+FFFD.
func sliceUTF16(text string, start, end int) string {
	units := utf16.Encode([]rune(text))
	if start < 0 {
		start = 0
	}
	if start > len(units) {
		start = len(units)
	}
	if end > len(units) {
		end = len(units)
	}
	if end < start {
		end = start
	}
	var out strings.Builder
	for index := start; index < end; index++ {
		unit := units[index]
		if unit >= 0xD800 && unit <= 0xDBFF && index+1 < end && units[index+1] >= 0xDC00 && units[index+1] <= 0xDFFF {
			out.WriteRune(utf16.DecodeRune(rune(unit), rune(units[index+1])))
			index++
			continue
		}
		if unit >= 0xD800 && unit <= 0xDFFF {
			out.WriteRune('\uFFFD')
			continue
		}
		out.WriteRune(rune(unit))
	}
	return out.String()
}

// List implements skills.list (apps/api/src/routes/memory.ts:217-220 over
// apps/api/src/bots/taught-skills.ts:321-327): the Space's taught skills for a bot, newest edit
// first. The bot is not looked up, so an id the caller cannot see simply lists nothing; another
// person's recording is replaced by an empty one. A stored row the output schema refuses (an odd
// status, or a recording a value breaks) answers the router's Output validation failed.
func List(ctx context.Context, database *db.DB, actor db.Actor, raw orpc.Input) (any, *orpc.Error) {
	object, issues := validate.Decode(raw.Raw, nil)
	if issues != nil {
		return nil, validate.Fail(issues)
	}
	botID, problems := validate.String(validate.Path{"botId"}, object.Field("botId"), validate.StringRules{Min: 1})
	if problems != nil {
		return nil, validate.Fail(problems)
	}
	list := []Skill{}
	err := database.Tenant(ctx, actor, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `SELECT `+columns+` FROM taught_skills
			WHERE "spaceId" = $1 AND "botId" = $2 ORDER BY "updatedAt" DESC`, actor.SpaceID, botID)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			value, err := scan(rows)
			if err != nil {
				return err
			}
			skill, recordingOK := skillFor(actor, value)
			if !recordingOK || !outputValid(skill) {
				return errOutputInvalid
			}
			list = append(list, skill)
		}
		return rows.Err()
	})
	if err != nil {
		if errors.Is(err, errOutputInvalid) {
			return nil, shared.OutputInvalid()
		}
		return nil, shared.Failure(err)
	}
	return list, nil
}
