// Package memoryroam is the background memory roamer: a separate, low-priority
// process that reads one bot's durable memory at a time, asks its own model for a
// minimal consolidation, validates the answer, and writes it back through the
// memory package. It never touches chats, runs, instructions, or any other table.
package memoryroam

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"regexp"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/contentcrypto"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/effects"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/events"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/orpc"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/memory"
)

const (
	// BotMemoryMaxBytes is BOT_MEMORY_MAX_BYTES (packages/contracts/src/bots/bot-memory.ts).
	BotMemoryMaxBytes = 4 * 1024
	// MaxOtherBytes is a ceiling for one non-index document. The prompt budget for
	// all of a bot's memory is 32 KB; this is a per-document safety cap, not a budget.
	MaxOtherBytes = 64 * 1024
	// UserMemoryPath is the bot's durable profile of its person. It is one of the
	// two documents the roamer may write.
	UserMemoryPath = "USER.md"
	// MaxInstructionsLength is BOT_INSTRUCTIONS_MAX_LENGTH
	// (packages/contracts/src/bots/bot.ts).
	MaxInstructionsLength = 20_000
)

var safePath = regexp.MustCompile(`^[A-Za-z0-9](?:[A-Za-z0-9._/-]{0,198})$`)

// writablePaths are the only documents a roamer pass may change. A bot's
// instructions are not a memory document and are never in this set.
func writablePaths(shared bool) []string {
	if shared {
		return []string{memory.MemoryIndexPath}
	}
	return []string{memory.MemoryIndexPath, UserMemoryPath}
}

func isWritablePath(path string, shared bool) bool {
	if shared {
		return path == memory.MemoryIndexPath
	}
	return path == memory.MemoryIndexPath || path == UserMemoryPath
}

// Config is one roamer pass.
type Config struct {
	// ClientsFor resolves the ordered model connections one bot may use: the
	// owner's live main model first. The roamer tries them in order.
	ClientsFor    func(ctx context.Context, bot Bot) ([]*Client, error)
	MaxInputBytes int
	Delay         time.Duration
	DryRun        bool
	IncludeShared bool
	OnlyBots      []string
	// Force ignores the owner's switch and interval, for a manual run.
	Force bool
}

// Bot is one non-archived bot the roamer may visit.
type Bot struct {
	ID           string
	SpaceID      string
	SpaceName    string
	UserID       string
	Name         string
	Description  string
	Instructions string
	ThreadID     string
}

// Change is one document the pass changed, or would change in a dry run.
type Change struct {
	Scope       string `json:"scope"`
	Path        string `json:"path"`
	Action      string `json:"action"`
	BeforeBytes int    `json:"beforeBytes"`
	AfterBytes  int    `json:"afterBytes"`
	Created     bool   `json:"created,omitempty"`
}

// Report is what one pass did.
type Report struct {
	Bots       int      `json:"bots"`
	ModelCalls int      `json:"modelCalls"`
	Failures   int      `json:"failures"`
	Skipped    int      `json:"skipped"`
	Changes    []Change `json:"changes"`
}

type answer struct {
	Documents    []answerDocument `json:"documents"`
	Delete       []string         `json:"delete"`
	Instructions *string          `json:"instructions"`
}

type answerDocument struct {
	Path    string `json:"path"`
	Content string `json:"content"`
}

type update struct {
	Path    string
	Content string
	Current *memory.Document
}

type validatedChanges struct {
	Updates      []update
	Instructions *string
	Ignored      []string
}

type instructionVersion struct {
	ID           string `json:"id"`
	Instructions string `json:"instructions"`
	Reason       string `json:"reason"`
	CreatedAt    string `json:"createdAt"`
}

// Run visits every selected bot whose owner enabled the roamer and whose interval
// elapsed, then optionally each Space's shared memory. A failed pass records its
// targets and retries only those on the next check, with a bounded backoff; a
// successful retry clears the failure. One bot's failure is logged and does not
// stop the pass.
func Run(ctx context.Context, logger *slog.Logger, database *db.DB, ring *contentcrypto.KeyRing, config Config) (Report, error) {
	report := Report{Changes: []Change{}}
	bots, err := listBots(ctx, database, config.OnlyBots)
	if err != nil {
		return report, err
	}
	report.Bots = len(bots)

	owners := []string{}
	byOwner := map[string][]Bot{}
	for _, bot := range bots {
		if _, seen := byOwner[bot.UserID]; !seen {
			owners = append(owners, bot.UserID)
		}
		byOwner[bot.UserID] = append(byOwner[bot.UserID], bot)
	}
	settings, err := loadSettings(ctx, database, owners)
	if err != nil {
		return report, err
	}
	now := time.Now().UTC()

	for _, owner := range owners {
		if err := ctx.Err(); err != nil {
			return report, err
		}
		setting, found := settings[owner]
		run := mode(setting, now, config.Force)
		if !config.Force && (!found || run == modeSkip) {
			report.Skipped += len(byOwner[owner])
			logger.Debug("memory.roamer.skip", "userId", owner, "reason", skipReason(found, setting, now))
			continue
		}

		selected := byOwner[owner]
		sharedSpaces := map[string]bool{}
		retryAttempt := 1
		if run == modeRetry {
			failedBots, failedSpaces := retryTargets(setting.LastFailures)
			selected = selectFailedBots(byOwner[owner], failedBots)
			sharedSpaces = failedSpaces
			retryAttempt = setting.RetryAttempt + 1
			logger.Info("memory.roamer.retry", "userId", owner, "attempt", retryAttempt,
				"bots", len(selected), "shared", len(sharedSpaces))
		} else {
			for _, bot := range byOwner[owner] {
				sharedSpaces[bot.SpaceID] = true
			}
		}

		ownerChanges := 0
		ownerModel := ""
		failures := []Failure{}
		for _, bot := range selected {
			if err := ctx.Err(); err != nil {
				return report, err
			}
			clients, err := config.ClientsFor(ctx, bot)
			if err != nil {
				failures = append(failures, botFailure(bot, err))
				report.Failures++
				logger.Error("memory.roamer.model_unavailable", "botId", bot.ID, "error", err.Error())
				continue
			}
			madeCall, changes, model, err := roamBot(ctx, logger, database, ring, config, bot, clients)
			if madeCall {
				report.ModelCalls++
			}
			if model != "" && ownerModel == "" {
				ownerModel = model
			}
			if err != nil {
				failures = append(failures, botFailure(bot, err))
				report.Failures++
				logger.Error("memory.roamer.bot_failed", "botId", bot.ID, "error", err.Error())
			} else {
				ownerChanges += len(changes)
				report.Changes = append(report.Changes, changes...)
			}
			if err := wait(ctx, config.Delay); err != nil {
				return report, err
			}
		}

		if config.IncludeShared {
			visited := map[string]bool{}
			for _, bot := range byOwner[owner] {
				if !sharedSpaces[bot.SpaceID] || visited[bot.SpaceID] {
					continue
				}
				visited[bot.SpaceID] = true
				if err := ctx.Err(); err != nil {
					return report, err
				}
				clients, err := config.ClientsFor(ctx, bot)
				if err != nil {
					failures = append(failures, sharedFailure(bot, err))
					report.Failures++
					logger.Error("memory.roamer.model_unavailable", "spaceId", bot.SpaceID, "error", err.Error())
					continue
				}
				madeCall, changes, model, err := roamShared(ctx, logger, database, ring, config, bot, clients)
				if madeCall {
					report.ModelCalls++
				}
				if model != "" && ownerModel == "" {
					ownerModel = model
				}
				if err != nil {
					failures = append(failures, sharedFailure(bot, err))
					report.Failures++
					logger.Error("memory.roamer.shared_failed", "spaceId", bot.SpaceID, "error", err.Error())
				} else {
					ownerChanges += len(changes)
					report.Changes = append(report.Changes, changes...)
				}
				if err := wait(ctx, config.Delay); err != nil {
					return report, err
				}
			}
		}

		var retryAt *time.Time
		attempt := 0
		if len(failures) > 0 {
			attempt = retryAttempt
			if attempt <= maxRetryAttempts {
				next := now.Add(retryDelay(attempt))
				retryAt = &next
			}
		}
		if !config.DryRun {
			if err := recordRun(ctx, database, owner, ownerChanges, ownerModel,
				failures, retryAt, attempt); err != nil {
				return report, err
			}
		}
	}

	return report, nil
}

func selectFailedBots(bots []Bot, failed map[string]bool) []Bot {
	selected := make([]Bot, 0, len(failed))
	for _, bot := range bots {
		if failed[bot.ID] {
			selected = append(selected, bot)
		}
	}
	return selected
}

func botFailure(bot Bot, err error) Failure {
	return Failure{Kind: "bot", ID: bot.ID, Name: bot.Name, Error: failureText(err)}
}

func sharedFailure(bot Bot, err error) Failure {
	name := bot.SpaceName
	if name == "" {
		name = "Shared memory"
	}
	return Failure{Kind: "shared", ID: bot.SpaceID, Name: name, Error: failureText(err)}
}

func failureText(err error) string {
	text := strings.TrimSpace(err.Error())
	if text == "" {
		return "Unknown error"
	}
	const limit = 300
	runes := []rune(text)
	if len(runes) > limit {
		return string(runes[:limit])
	}
	return text
}

func wait(ctx context.Context, delay time.Duration) error {
	if delay <= 0 {
		return nil
	}
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-timer.C:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func listBots(ctx context.Context, database *db.DB, only []string) ([]Bot, error) {
	selected := map[string]bool{}
	for _, id := range only {
		selected[id] = true
	}
	var bots []Bot
	err := database.System(ctx, "memory roamer lists bots", func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `SELECT b.id, b."spaceId", COALESCE(s.name, ''), b."userId",
				b.name, b.description, b.instructions, COALESCE(t.id, '')
			FROM bots b
			LEFT JOIN threads t ON t."botId" = b.id
			LEFT JOIN spaces s ON s.id = b."spaceId"
			WHERE b."archivedAt" IS NULL ORDER BY b."createdAt"`)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var bot Bot
			if err := rows.Scan(&bot.ID, &bot.SpaceID, &bot.SpaceName, &bot.UserID, &bot.Name,
				&bot.Description, &bot.Instructions, &bot.ThreadID); err != nil {
				return err
			}
			if len(selected) == 0 || selected[bot.ID] {
				bots = append(bots, bot)
			}
		}
		return rows.Err()
	})
	return bots, err
}

func actorFor(bot Bot) db.Actor {
	return db.Actor{SpaceID: bot.SpaceID, UserID: bot.UserID}
}

func listDocuments(ctx context.Context, database *db.DB, ring *contentcrypto.KeyRing, bot Bot, shared bool) ([]memory.Document, error) {
	input := map[string]string{"scope": "user"}
	if !shared {
		input = map[string]string{"scope": "bot", "botId": bot.ID}
	}
	raw, err := json.Marshal(input)
	if err != nil {
		return nil, err
	}
	result, failure := memory.List(ctx, database, actorFor(bot), ring, orpc.Input{Raw: raw})
	if failure != nil {
		return nil, failure
	}
	documents, ok := result.([]memory.Document)
	if !ok {
		return nil, fmt.Errorf("memory.list returned %T", result)
	}
	return documents, nil
}

func initialMemory(name string) string {
	name = strings.NewReplacer("\r", " ", "\n", " ").Replace(strings.TrimSpace(name))
	if name == "" {
		name = "Bot"
	}
	return "# " + name + "\n\n"
}

func indexOf(documents []memory.Document, path string) *memory.Document {
	for index := range documents {
		if documents[index].Path == path {
			return &documents[index]
		}
	}
	return nil
}

// roamBot seeds a missing index, asks the model for changes, and applies them.
// The bool reports whether the model was called (for the pass's cost line).
func roamBot(ctx context.Context, logger *slog.Logger, database *db.DB, ring *contentcrypto.KeyRing, config Config, bot Bot, clients []*Client) (bool, []Change, string, error) {
	documents, err := listDocuments(ctx, database, ring, bot, false)
	if err != nil {
		return false, nil, "", err
	}
	var changes []Change
	if indexOf(documents, memory.MemoryIndexPath) == nil {
		content := initialMemory(bot.Name)
		changes = append(changes, Change{
			Scope: "bot", Path: memory.MemoryIndexPath, Action: "seed-index",
			BeforeBytes: 0, AfterBytes: len([]byte(content)),
		})
		zero := int64(0)
		if !config.DryRun {
			if _, err := memory.Commit(ctx, database, actorFor(bot), ring, memory.CommitInput{
				Scope: "bot", BotID: &bot.ID, Path: memory.MemoryIndexPath,
				Content: content, ExpectedRevision: &zero,
			}); err != nil {
				return false, nil, "", err
			}
		}
		documents, err = listDocuments(ctx, database, ring, bot, false)
		if err != nil {
			return false, nil, "", err
		}
	}
	if len(nonEmpty(documents)) == 0 {
		return false, changes, "", nil
	}
	return roamDocuments(ctx, logger, database, ring, config, bot, documents, false, changes, clients)
}

func roamShared(ctx context.Context, logger *slog.Logger, database *db.DB, ring *contentcrypto.KeyRing, config Config, bot Bot, clients []*Client) (bool, []Change, string, error) {
	documents, err := listDocuments(ctx, database, ring, bot, true)
	if err != nil {
		return false, nil, "", err
	}
	var changes []Change
	if indexOf(documents, memory.MemoryIndexPath) == nil {
		content := initialMemory("Shared memory")
		changes = append(changes, Change{
			Scope: "user", Path: memory.MemoryIndexPath, Action: "seed-index",
			BeforeBytes: 0, AfterBytes: len([]byte(content)),
		})
		zero := int64(0)
		if !config.DryRun {
			if _, err := memory.Commit(ctx, database, actorFor(bot), ring, memory.CommitInput{
				Scope: "user", Path: memory.MemoryIndexPath, Content: content, ExpectedRevision: &zero,
			}); err != nil {
				return false, changes, "", err
			}
		}
		documents, err = listDocuments(ctx, database, ring, bot, true)
		if err != nil {
			return false, changes, "", err
		}
	}
	return roamDocuments(ctx, logger, database, ring, config, bot, documents, true, changes, clients)
}

func roamDocuments(ctx context.Context, logger *slog.Logger, database *db.DB, ring *contentcrypto.KeyRing, config Config, bot Bot, documents []memory.Document, shared bool, changes []Change, clients []*Client) (bool, []Change, string, error) {
	payload, omitted := promptFor(bot, documents, config.MaxInputBytes, shared)
	if payload == "" {
		return false, changes, "", nil
	}
	started := time.Now()
	var (
		text    string
		usage   json.RawMessage
		used    string
		lastErr error
	)
	for _, client := range clients {
		text, usage, lastErr = client.Complete(ctx, systemPrompt(shared), payload)
		if lastErr == nil {
			used = client.Model()
			break
		}
	}
	if lastErr != nil {
		return true, changes, "", lastErr
	}
	logger.Info("memory.roamer.model", "botId", bot.ID, "shared", shared, "model", used,
		"durationMs", time.Since(started).Milliseconds(), "usage", string(usage))
	parsed, err := parseAnswer(text)
	if err != nil {
		return true, changes, used, err
	}
	validated, err := validateChanges(parsed, documents, omitted, shared, bot.Instructions)
	if err != nil {
		return true, changes, used, err
	}
	for _, path := range validated.Ignored {
		logger.Info("memory.roamer.document_skipped", "botId", bot.ID, "shared", shared, "path", path,
			"reason", "outside writable memory")
	}

	for _, change := range validated.Updates {
		before := 0
		if change.Current != nil {
			before = len([]byte(change.Current.Content))
		}
		changes = append(changes, Change{
			Scope: scopeFor(shared), Path: change.Path, Action: "update",
			BeforeBytes: before, AfterBytes: len([]byte(change.Content)), Created: change.Current == nil,
		})
		if config.DryRun {
			continue
		}
		expected := int64(0)
		if change.Current != nil {
			expected = int64(change.Current.Revision)
		}
		_, err := memory.Commit(ctx, database, actorFor(bot), ring, memory.CommitInput{
			Scope: scopeFor(shared), BotID: botIDFor(shared, bot.ID), Path: change.Path,
			Content: change.Content, ExpectedRevision: &expected,
		})
		if err != nil {
			if isConflict(err) {
				logger.Warn("memory.roamer.conflict", "botId", bot.ID, "path", change.Path)
				continue
			}
			return true, changes, used, err
		}
	}

	if validated.Instructions != nil {
		if config.DryRun {
			changes = append(changes, Change{
				Scope: "bot", Path: "Instructions", Action: "update",
				BeforeBytes: len([]byte(bot.Instructions)), AfterBytes: len([]byte(*validated.Instructions)),
			})
		} else {
			updated, err := commitInstructions(ctx, logger, database, ring, bot, *validated.Instructions)
			if err != nil {
				return true, changes, used, err
			}
			if !updated {
				logger.Warn("memory.roamer.instructions_changed", "botId", bot.ID)
			} else {
				changes = append(changes, Change{
					Scope: "bot", Path: "Instructions", Action: "update",
					BeforeBytes: len([]byte(bot.Instructions)), AfterBytes: len([]byte(*validated.Instructions)),
				})
			}
		}
	}

	return true, changes, used, nil
}

// commitInstructions uses the same row lock, bounded history, and bot.updated
// event as a manual instruction edit. A save from the person wins; the pass then
// reports no change. The realtime notify stays best-effort after commit.
func commitInstructions(ctx context.Context, logger *slog.Logger, database *db.DB, ring *contentcrypto.KeyRing, bot Bot, content string) (bool, error) {
	if bot.ThreadID == "" {
		return false, nil
	}
	var applied bool
	var seq int32
	err := database.System(ctx, "memory roamer updates bot instructions", func(tx pgx.Tx) error {
		// Event appends also lock the thread; all instruction writers take it first.
		var threadID string
		err := tx.QueryRow(ctx, `SELECT id FROM threads WHERE id = $1 FOR UPDATE`, bot.ThreadID).Scan(&threadID)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		if err != nil {
			return err
		}
		var current string
		var historyRaw []byte
		err = tx.QueryRow(ctx, `SELECT instructions, "instructionHistory" FROM bots
			WHERE id = $1 AND "spaceId" = $2 AND "userId" = $3 AND "archivedAt" IS NULL
			FOR UPDATE`, bot.ID, bot.SpaceID, bot.UserID).Scan(&current, &historyRaw)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		if err != nil {
			return err
		}
		if current != bot.Instructions {
			return nil
		}
		history, err := prependInstructionVersion(historyRaw, current)
		if err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `UPDATE bots SET instructions = $1, "instructionHistory" = $2,
			"updatedAt" = now() WHERE id = $3 AND "spaceId" = $4`,
			content, history, bot.ID, bot.SpaceID); err != nil {
			return err
		}
		event, err := events.AppendTx(ctx, tx, ring, events.Input{
			SpaceID: bot.SpaceID, ThreadID: bot.ThreadID, BotID: bot.ID, Type: "bot.updated",
			Payload: map[string]any{
				"botId": bot.ID, "name": bot.Name, "description": bot.Description,
			},
		})
		if err != nil {
			return err
		}
		seq = event.Seq
		applied = true
		return nil
	})
	if err != nil {
		return false, err
	}
	if !applied {
		return false, nil
	}
	// bot-update.ts:102 notifies through the untyped options.notify, so no type is named here.
	events.NotifyCommitted(ctx, &events.PGPublisher{Pool: database.Pool}, logger, database,
		bot.ThreadID, seq, "", "")
	return true, nil
}

// prependInstructionVersion keeps the previous text for undo, exactly as
// writeBotInstructions does, and preserves unknown history fields.
func prependInstructionVersion(raw []byte, current string) ([]byte, error) {
	var history []json.RawMessage
	if len(strings.TrimSpace(string(raw))) > 0 {
		if err := json.Unmarshal(raw, &history); err != nil {
			return nil, fmt.Errorf("stored instruction history is invalid: %w", err)
		}
	}
	version, err := json.Marshal(instructionVersion{
		ID: effects.NewID(), Instructions: current, Reason: "Memory roamer",
		CreatedAt: time.Now().UTC().Format(time.RFC3339Nano),
	})
	if err != nil {
		return nil, err
	}
	history = append([]json.RawMessage{version}, history...)
	if len(history) > 20 {
		history = history[:20]
	}
	return json.Marshal(history)
}

func scopeFor(shared bool) string {
	if shared {
		return "user"
	}
	return "bot"
}

func botIDFor(shared bool, botID string) *string {
	if shared {
		return nil
	}
	return &botID
}

func nonEmpty(documents []memory.Document) []memory.Document {
	var result []memory.Document
	for _, document := range documents {
		if strings.TrimSpace(document.Content) != "" {
			result = append(result, document)
		}
	}
	return result
}

func systemPrompt(shared bool) string {
	if shared {
		return fmt.Sprintf(`You maintain the shared durable memory that every bot in one Rakazo Space reads. You can read its documents below and return a minimal change set.

Only memory is in scope. Never change a bot's Instructions, settings, tasks, chats, secrets, or any other document.
Only ONE document is writable: %s. It holds durable facts every bot in the Space needs, such as shared people, conventions, resources, and Space-wide decisions. Bot-specific work stays in each bot's own memory; do not move it here.
Every other shared memory document is read-only context. Do not include a read-only path in "documents". Never delete a document.
%s must keep its first "# " heading and must stay at or under %d bytes. Preserve every unique fact, merge duplicates, drop lines that a newer note contradicts, and keep one fact per line.
Do not invent facts. When unsure, leave the note alone. Prefer the smallest change set.
Return JSON only: {"documents":[{"path":"%s","content":"complete new content"}]}
Include a document only when you change it, and send its complete new content. Do not change an omitted document. No other keys.`,
			memory.MemoryIndexPath, memory.MemoryIndexPath, MaxOtherBytes, memory.MemoryIndexPath)
	}
	return fmt.Sprintf(`You maintain the durable memory and Instructions of one Rakazo bot. You can read its memory documents and Instructions below and return a minimal change set.

Only four surfaces are in scope for this bot: %s, %s, its Instructions, and the Space's shared %s (a separate pass). Never change settings, tasks, chats, secrets, skills, or any other document.
Writable surfaces:
- %s: the bot's working memory. It holds facts, decisions, project state, and what worked or failed for this bot, one fact per line.
- %s: durable facts about the person this bot works with, such as their name, role, language, and stable preferences. Do not put task state or secrets here.
- Instructions: the bot's stable role, responsibilities, behavioral rules, tone, and working style.
Route each fact to the surface it belongs in. Move a misplaced fact rather than duplicating it. If %s does not exist, create it only when you have a durable fact about the person.
Every other memory document is read-only context. Do not include a read-only path in "documents". Never delete a document.
%s must keep its first "# <bot name>" heading and must stay at or under %d bytes.
%s may be up to %d bytes.
Instructions are high authority. Change them only for a clear, durable correction or consolidation supported by the memory. Preserve the existing role, responsibilities, safety rules, tone, and formatting. Do not add capabilities, permissions, autonomy, secrets, or tools; do not weaken a safety rule. Prefer leaving Instructions unchanged.
Preserve every unique fact, merge duplicates, drop lines that a newer note contradicts, and keep one fact per line.
Do not invent facts. When unsure, leave the note alone. Prefer the smallest change set.
Return JSON only: {"documents":[{"path":"%s","content":"complete new content"}],"instructions":"complete new instructions"}
Include a document only when you change it, and send its complete new content. Include "instructions" only when you change them, as the complete new text of at most %d characters. Do not change an omitted document. No other keys.`,
		memory.MemoryIndexPath, UserMemoryPath, memory.MemoryIndexPath,
		memory.MemoryIndexPath, UserMemoryPath, UserMemoryPath, memory.MemoryIndexPath, BotMemoryMaxBytes,
		UserMemoryPath, MaxOtherBytes, memory.MemoryIndexPath, MaxInstructionsLength)
}

func promptFor(bot Bot, documents []memory.Document, maxBytes int, shared bool) (string, []string) {
	ordered := append([]memory.Document(nil), documents...)
	sort.SliceStable(ordered, func(left, right int) bool {
		leftIndex := ordered[left].Path == memory.MemoryIndexPath
		rightIndex := ordered[right].Path == memory.MemoryIndexPath
		if leftIndex || rightIndex {
			return leftIndex && !rightIndex
		}
		leftWritable := isWritablePath(ordered[left].Path, shared)
		rightWritable := isWritablePath(ordered[right].Path, shared)
		if leftWritable != rightWritable {
			return leftWritable
		}
		if ordered[left].Revision != ordered[right].Revision {
			return ordered[left].Revision > ordered[right].Revision
		}
		return ordered[left].Path < ordered[right].Path
	})
	included := []memory.Document{}
	omitted := []string{}
	used := 0
	var sections []string
	writable := writablePaths(shared)
	if !shared {
		instructions := bot.Instructions
		if strings.TrimSpace(instructions) == "" {
			instructions = "(empty)"
		}
		sections = append(sections, fmt.Sprintf("--- Instructions (writable; complete replacement if changed; %d characters) ---\n%s",
			utf8.RuneCountInString(bot.Instructions), instructions))
		used += len([]byte(bot.Instructions))
		writable = append(writable, "Instructions")
	}
	for _, document := range ordered {
		size := len([]byte(document.Content))
		if len(included) > 0 && used+size > maxBytes {
			omitted = append(omitted, document.Path)
			continue
		}
		included = append(included, document)
		used += size
	}
	for _, document := range included {
		access := ""
		if !isWritablePath(document.Path, shared) {
			access = ", read-only"
		}
		sections = append(sections, fmt.Sprintf("--- %s (revision %d, %d bytes%s) ---\n%s",
			document.Path, document.Revision, len([]byte(document.Content)), access, document.Content))
	}
	label := bot.Name
	if shared {
		label = "Shared memory"
	}
	payload := fmt.Sprintf("Memory owner: %s\nWritable surfaces: %s\n\n%s",
		label, strings.Join(writable, ", "), strings.Join(sections, "\n\n"))
	if len(omitted) > 0 {
		payload += "\n\nOmitted from this request; do not change them: " + strings.Join(omitted, ", ")
	}
	return payload, omitted
}

func parseAnswer(text string) (answer, error) {
	start := strings.Index(text, "{")
	end := strings.LastIndex(text, "}")
	if start == -1 || end <= start {
		return answer{}, errors.New("model answer has no JSON object")
	}
	var parsed answer
	if err := json.Unmarshal([]byte(text[start:end+1]), &parsed); err != nil {
		return answer{}, fmt.Errorf("model answer is not valid JSON: %w", err)
	}
	return parsed, nil
}

func validateChanges(parsed answer, documents []memory.Document, omitted []string, shared bool, instructions string) (validatedChanges, error) {
	result := validatedChanges{}
	current := map[string]memory.Document{}
	for _, document := range documents {
		current[document.Path] = document
	}
	omittedSet := map[string]bool{}
	for _, path := range omitted {
		omittedSet[path] = true
	}
	touched := map[string]bool{}
	for _, item := range parsed.Documents {
		path := strings.TrimSpace(item.Path)
		if path == "" || !safePath.MatchString(path) || strings.Contains(path, "..") || strings.HasSuffix(path, "/") {
			return validatedChanges{}, fmt.Errorf("documents path is invalid")
		}
		if path != memory.MemoryIndexPath && !strings.HasSuffix(path, ".md") {
			return validatedChanges{}, fmt.Errorf("only .md memory documents can be written")
		}
		if !isWritablePath(path, shared) {
			result.Ignored = append(result.Ignored, path)
			continue
		}
		if omittedSet[path] {
			return validatedChanges{}, fmt.Errorf("model changed omitted document %s", path)
		}
		content := strings.ReplaceAll(item.Content, "\r\n", "\n")
		if strings.TrimSpace(content) == "" {
			return validatedChanges{}, fmt.Errorf("model blanked %s", path)
		}
		existing, found := current[path]
		limit := MaxOtherBytes
		if path == memory.MemoryIndexPath {
			limit = BotMemoryMaxBytes
			if shared {
				limit = MaxOtherBytes
			}
			// Keep the index's identity: a model may return a different heading or
			// drop it, but the document keeps the first line it already had.
			if found {
				oldHeading := firstLine(existing.Content)
				newHeading := firstLine(content)
				if oldHeading != "" && newHeading != oldHeading {
					if strings.HasPrefix(content, "# ") {
						content = oldHeading + content[len(newHeading):]
					} else {
						content = oldHeading + "\n\n" + content
					}
				}
			}
			if !strings.HasPrefix(content, "# ") {
				return validatedChanges{}, fmt.Errorf("model removed the index heading")
			}
		}
		if len([]byte(content)) > limit {
			return validatedChanges{}, fmt.Errorf("model exceeded the size cap for %s", path)
		}
		if touched[path] {
			return validatedChanges{}, fmt.Errorf("model returned %s twice", path)
		}
		touched[path] = true
		if found && existing.Content == content {
			continue
		}
		var currentDoc *memory.Document
		if found {
			copied := existing
			currentDoc = &copied
		}
		result.Updates = append(result.Updates, update{Path: path, Content: content, Current: currentDoc})
	}

	if shared {
		if parsed.Instructions != nil {
			result.Ignored = append(result.Ignored, "Instructions")
		}
	} else if parsed.Instructions != nil {
		content := strings.TrimSpace(strings.ReplaceAll(*parsed.Instructions, "\r\n", "\n"))
		current := strings.TrimSpace(instructions)
		if content == "" {
			if current != "" {
				return validatedChanges{}, fmt.Errorf("model blanked instructions")
			}
		} else {
			if utf8.RuneCountInString(content) > MaxInstructionsLength {
				return validatedChanges{}, fmt.Errorf("model exceeded the instructions cap")
			}
			if content != current {
				result.Instructions = &content
			}
		}
	}

	// Deletion is outside every writable memory set. Ignore the request rather than
	// letting a model remove a note the person still needs.
	for _, raw := range parsed.Delete {
		path := strings.TrimSpace(raw)
		if path != "" {
			result.Ignored = append(result.Ignored, path)
		}
	}
	return result, nil
}

func firstLine(content string) string {
	if index := strings.IndexByte(content, '\n'); index >= 0 {
		return content[:index]
	}
	return content
}

func isConflict(err error) bool {
	var failure *orpc.Error
	return errors.As(err, &failure) && failure.Code == "CONFLICT"
}
