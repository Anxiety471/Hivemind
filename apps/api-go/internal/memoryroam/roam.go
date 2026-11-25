// Package memoryroam is the background memory roamer: a separate, low-priority
// process that reads one bot's durable memory at a time, asks its own model for a
// minimal consolidation, validates the answer, and writes it back through the
// memory package. It never touches chats, runs, instructions, or any other table.
package memoryroam

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/contentcrypto"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/effects"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/events"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/orpc"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/memory"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/wtf8"
)

const (
	// BotMemoryMaxBytes is BOT_MEMORY_MAX_BYTES (packages/contracts/src/bots/bot-memory.ts).
	BotMemoryMaxBytes     = 4 * 1024
	BotMemoryTriggerBytes = 3200
	BotMemorySoftBytes    = 2560
	// UserMemoryMaxBytes is USER_MEMORY_MAX_BYTES (packages/contracts/src/bots/bot-memory.ts).
	UserMemoryMaxBytes     = 2 * 1024
	UserMemoryTriggerBytes = 1750
	UserMemorySoftBytes    = 1536
	// SharedMemoryMaxBytes is SHARED_MEMORY_MAX_BYTES (packages/contracts/src/bots/bot-memory.ts).
	SharedMemoryMaxBytes     = 6 * 1024
	SharedMemoryTriggerBytes = 4800
	SharedMemorySoftBytes    = 4096
	// InstructionsTriggerChars and InstructionsSoftChars provide hysteresis so
	// compacted bots stay idle until they meaningfully bloat again.
	InstructionsTriggerChars = 5000
	InstructionsSoftChars    = 4000
	// MaxOtherBytes is a ceiling for archive documents. The prompt budget for
	// all of a bot's memory is 32 KB; this is a per-document safety cap, not a budget.
	MaxOtherBytes = 64 * 1024
	// UserMemoryPath is the Space's consolidated profile of the person.
	UserMemoryPath = memory.UserMemoryPath
	// MaxInstructionsLength is BOT_INSTRUCTIONS_MAX_LENGTH
	// (packages/contracts/src/bots/bot.ts).
	MaxInstructionsLength = 20_000
)

var (
	safePath       = regexp.MustCompile(`^[A-Za-z0-9](?:[A-Za-z0-9._/-]{0,198})$`)
	errArchiveFull = errors.New("archive document is full")
)

// writablePaths are the only documents a roamer pass may replace with memory.write.
// Space-level USER.md lives in shared memory; bot passes write only bot MEMORY.md.
func writablePaths(shared bool) []string {
	if shared {
		return []string{memory.MemoryIndexPath, UserMemoryPath}
	}
	return []string{memory.MemoryIndexPath}
}

func isWritablePath(path string, shared bool) bool {
	if shared {
		return path == memory.MemoryIndexPath || path == UserMemoryPath
	}
	return path == memory.MemoryIndexPath
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
	// IncludeSkills lets each Space's skills pass create and upgrade skills.
	IncludeSkills bool
	OnlyBots      []string
	// Force ignores the owner's switch and interval, for a manual run.
	Force bool
	// Compact actively compacts MEMORY.md, USER.md, and Instructions toward soft
	// targets and archives stale history under archive/.
	Compact bool
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
	// Command is the named command that made the change (commands.go).
	Command     string `json:"command,omitempty"`
	Scope       string `json:"scope"`
	Path        string `json:"path"`
	Action      string `json:"action"`
	BeforeBytes int    `json:"beforeBytes"`
	AfterBytes  int    `json:"afterBytes"`
	Created     bool   `json:"created,omitempty"`
}

// Target is one bot or Space's result in the latest run. The report keeps every
// visited target, not only failures, so Settings can show what happened to each.
type Target struct {
	Kind      string    `json:"kind"`
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	Status    string    `json:"status"`
	Error     string    `json:"error,omitempty"`
	Model     string    `json:"model,omitempty"`
	InputHash string    `json:"inputHash,omitempty"`
	Changes   []Change  `json:"changes"`
	CheckedAt time.Time `json:"checkedAt"`
}

// Report is what one pass did.
type Report struct {
	Bots             int      `json:"bots"`
	ModelCalls       int      `json:"modelCalls"`
	Failures         int      `json:"failures"`
	Skipped          int      `json:"skipped"`
	SkippedUnchanged int      `json:"skippedUnchanged,omitempty"`
	Changes          []Change `json:"changes"`
}

type update struct {
	Path    string
	Content string
	Current *memory.Document
}

type archiveAppend struct {
	Path    string
	Content string
}

type openWorkItem struct {
	Title     string
	Status    string
	Notes     string
	UpdatedAt time.Time
}

type skillSummary struct {
	Name        string
	Description string
}

type botContext struct {
	Now            time.Time
	Compact        bool
	SharedMemory   string
	SharedUser     string
	OpenWork       []openWorkItem
	Skills         []skillSummary
	LegacyUserDocs []evidenceDocument
}

type validatedChanges struct {
	Updates      []update
	Archives     []archiveAppend
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
		skillSpaces := map[string]bool{}
		retryAttempt := 1
		if run == modeRetry {
			failedBots, failedSpaces, failedSkills := retryTargets(setting.LastFailures)
			selected = selectFailedBots(byOwner[owner], failedBots)
			sharedSpaces = failedSpaces
			skillSpaces = failedSkills
			retryAttempt = setting.RetryAttempt + 1
			logger.Info("memory.roamer.retry", "userId", owner, "attempt", retryAttempt,
				"bots", len(selected), "shared", len(sharedSpaces), "skills", len(skillSpaces))
		} else {
			for _, bot := range byOwner[owner] {
				sharedSpaces[bot.SpaceID] = true
				skillSpaces[bot.SpaceID] = true
			}
		}

		ownerChanges := 0
		ownerModel := ""
		failures := []Failure{}
		targets := []Target{}
		// A retry or a single-bot manual run updates the bots it touched and keeps
		// the other bots' last results. A full pass replaces the whole report.
		if run == modeRetry || len(config.OnlyBots) > 0 {
			targets = append(targets, setting.LastReport...)
		}
		prevHashes := map[string]string{}
		for _, prev := range setting.LastReport {
			if prev.Status == "ok" && prev.InputHash != "" {
				prevHashes[prev.Kind+"\x00"+prev.ID] = prev.InputHash
			}
		}

		visit := func(kind, name string, lead Bot, roam func([]*Client) (bool, bool, []Change, string, string, error)) error {
			if err := ctx.Err(); err != nil {
				return err
			}
			clients, err := config.ClientsFor(ctx, lead)
			if err != nil {
				failures = append(failures, Failure{Kind: kind, ID: lead.SpaceID, Name: name, Error: failureText(err)})
				report.Failures++
				targets = upsertTarget(targets, targetFor(kind, lead.SpaceID, name, nil, "", err))
				logger.Error("memory.roamer.model_unavailable", "spaceId", lead.SpaceID, "kind", kind, "error", err.Error())
				return nil
			}
			madeCall, skippedUnchanged, changes, model, nextHash, err := roam(clients)
			if madeCall {
				report.ModelCalls++
			}
			if skippedUnchanged {
				report.SkippedUnchanged++
			}
			if model != "" && ownerModel == "" {
				ownerModel = model
			}
			target := targetFor(kind, lead.SpaceID, name, changes, model, err)
			if err == nil && len(changes) == 0 && nextHash != "" {
				target.InputHash = nextHash
			}
			targets = upsertTarget(targets, target)
			if err != nil {
				failures = append(failures, Failure{Kind: kind, ID: lead.SpaceID, Name: name, Error: failureText(err)})
				report.Failures++
				logger.Error("memory.roamer."+kind+"_failed", "spaceId", lead.SpaceID, "error", err.Error())
			} else {
				ownerChanges += len(changes)
				report.Changes = append(report.Changes, changes...)
			}
			if !madeCall {
				return nil
			}
			return wait(ctx, config.Delay)
		}

		// Group bots by Space so each Space runs Shared -> Skills -> Bots in order:
		// Space USER.md and Skills settle first, then each bot deduplicates against them.
		spaceOrder := []string{}
		spaceBotsMap := map[string][]Bot{}
		for _, bot := range byOwner[owner] {
			if _, seen := spaceBotsMap[bot.SpaceID]; !seen {
				spaceOrder = append(spaceOrder, bot.SpaceID)
			}
			spaceBotsMap[bot.SpaceID] = append(spaceBotsMap[bot.SpaceID], bot)
		}
		selectedBySpace := map[string][]Bot{}
		for _, bot := range selected {
			selectedBySpace[bot.SpaceID] = append(selectedBySpace[bot.SpaceID], bot)
		}

		for _, spaceID := range spaceOrder {
			spaceBots := spaceBotsMap[spaceID]
			lead := spaceBots[0]
			if config.IncludeShared && sharedSpaces[spaceID] {
				prevHash := prevHashes["shared\x00"+spaceID]
				err := visit("shared", sharedTargetName(lead), lead, func(clients []*Client) (bool, bool, []Change, string, string, error) {
					return roamShared(ctx, logger, database, ring, config, spaceBots, prevHash, clients)
				})
				if err != nil {
					return report, err
				}
			}
			if config.IncludeSkills && skillSpaces[spaceID] {
				prevHash := prevHashes["skills\x00"+spaceID]
				err := visit("skills", skillsTargetName(lead), lead, func(clients []*Client) (bool, bool, []Change, string, string, error) {
					return roamSkills(ctx, logger, database, ring, config, spaceBots, prevHash, clients)
				})
				if err != nil {
					return report, err
				}
			}
			for _, bot := range selectedBySpace[spaceID] {
				if err := ctx.Err(); err != nil {
					return report, err
				}
				clients, err := config.ClientsFor(ctx, bot)
				if err != nil {
					failures = append(failures, botFailure(bot, err))
					report.Failures++
					targets = upsertTarget(targets, targetFor("bot", bot.ID, bot.Name, nil, "", err))
					logger.Error("memory.roamer.model_unavailable", "botId", bot.ID, "error", err.Error())
					continue
				}
				prevHash := prevHashes["bot\x00"+bot.ID]
				madeCall, skippedUnchanged, changes, model, nextHash, err := roamBot(ctx, logger, database, ring, config, bot, prevHash, clients)
				if madeCall {
					report.ModelCalls++
				}
				if skippedUnchanged {
					report.SkippedUnchanged++
				}
				if model != "" && ownerModel == "" {
					ownerModel = model
				}
				target := targetFor("bot", bot.ID, bot.Name, changes, model, err)
				if err == nil && len(changes) == 0 && nextHash != "" {
					target.InputHash = nextHash
				}
				targets = upsertTarget(targets, target)
				if err != nil {
					failures = append(failures, botFailure(bot, err))
					report.Failures++
					logger.Error("memory.roamer.bot_failed", "botId", bot.ID, "error", err.Error())
				} else {
					ownerChanges += len(changes)
					report.Changes = append(report.Changes, changes...)
				}
				if madeCall {
					if err := wait(ctx, config.Delay); err != nil {
						return report, err
					}
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
				failures, targets, retryAt, attempt); err != nil {
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

func targetFor(kind, id, name string, changes []Change, model string, err error) Target {
	target := Target{
		Kind: kind, ID: id, Name: name, Status: "ok", Model: model,
		Changes: append([]Change{}, changes...), CheckedAt: time.Now().UTC(),
	}
	if target.Changes == nil {
		target.Changes = []Change{}
	}
	if err != nil {
		target.Status = "failed"
		target.Error = failureText(err)
	}
	return target
}

func sharedTargetName(bot Bot) string {
	if bot.SpaceName != "" {
		return bot.SpaceName
	}
	return "Shared memory"
}

func upsertTarget(targets []Target, target Target) []Target {
	for index := range targets {
		if targets[index].Kind == target.Kind && targets[index].ID == target.ID {
			targets[index] = target
			return targets
		}
	}
	return append(targets, target)
}

func botFailure(bot Bot, err error) Failure {
	return Failure{Kind: "bot", ID: bot.ID, Name: bot.Name, Error: failureText(err)}
}

func skillsTargetName(bot Bot) string {
	if bot.SpaceName != "" {
		return bot.SpaceName
	}
	return "Skills"
}

func botsInSpace(bots []Bot, spaceID string) []Bot {
	var inSpace []Bot
	for _, bot := range bots {
		if bot.SpaceID == spaceID {
			inSpace = append(inSpace, bot)
		}
	}
	return inSpace
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

func loadOpenWork(ctx context.Context, database *db.DB, bot Bot) ([]openWorkItem, error) {
	var items []openWorkItem
	err := database.System(ctx, "memory roamer reads open work", func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `SELECT title, status, notes, "updatedAt"
			FROM scratchpad_items
			WHERE "spaceId" = $1 AND "botId" = $2 AND status <> 'done'
			ORDER BY "updatedAt" DESC, id DESC LIMIT 20`, bot.SpaceID, bot.ID)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var item openWorkItem
			if err := rows.Scan(&item.Title, &item.Status, &item.Notes, &item.UpdatedAt); err != nil {
				return err
			}
			items = append(items, item)
		}
		return rows.Err()
	})
	return items, err
}

// roamBot seeds a missing index, asks the model for changes, and applies them.
// The first bool reports whether the model was called; the second reports
// whether the target was skipped because its inputs matched the last clean pass.
func roamBot(ctx context.Context, logger *slog.Logger, database *db.DB, ring *contentcrypto.KeyRing, config Config, bot Bot, prevHash string, clients []*Client) (bool, bool, []Change, string, string, error) {
	documents, err := listDocuments(ctx, database, ring, bot, false)
	if err != nil {
		return false, false, nil, "", "", err
	}
	var changes []Change
	if indexOf(documents, memory.MemoryIndexPath) == nil {
		content := initialMemory(bot.Name)
		changes = append(changes, Change{
			Command: CmdMemoryWrite, Scope: "bot", Path: memory.MemoryIndexPath, Action: "seed-index",
			BeforeBytes: 0, AfterBytes: len([]byte(content)),
		})
		zero := int64(0)
		if !config.DryRun {
			if _, err := memory.Commit(ctx, database, actorFor(bot), ring, memory.CommitInput{
				Scope: "bot", BotID: &bot.ID, Path: memory.MemoryIndexPath,
				Content: content, ExpectedRevision: &zero,
			}); err != nil {
				return false, false, nil, "", "", err
			}
		}
		documents, err = listDocuments(ctx, database, ring, bot, false)
		if err != nil {
			return false, false, nil, "", "", err
		}
	}
	if len(nonEmpty(documents)) == 0 && wtf8.Length(bot.Instructions) <= InstructionsTriggerChars {
		return false, false, changes, "", "", nil
	}
	extra := botContext{Now: time.Now().UTC(), Compact: config.Compact}
	if sharedDocs, err := listDocuments(ctx, database, ring, bot, true); err == nil {
		if doc := indexOf(sharedDocs, memory.MemoryIndexPath); doc != nil {
			extra.SharedMemory = doc.Content
		}
		if doc := indexOf(sharedDocs, UserMemoryPath); doc != nil {
			extra.SharedUser = doc.Content
		}
	} else {
		logger.Warn("memory.roamer.shared_context_failed", "botId", bot.ID, "error", err.Error())
	}
	if openWork, err := loadOpenWork(ctx, database, bot); err == nil {
		extra.OpenWork = openWork
	} else {
		logger.Warn("memory.roamer.open_work_failed", "botId", bot.ID, "error", err.Error())
	}
	if skills, err := loadSkills(ctx, database, bot); err == nil {
		for _, skill := range skills {
			extra.Skills = append(extra.Skills, skillSummary{Name: skill.Name, Description: skill.Description})
		}
	} else {
		logger.Warn("memory.roamer.skills_context_failed", "botId", bot.ID, "error", err.Error())
	}
	return roamDocuments(ctx, logger, database, ring, config, bot, documents, false, extra, prevHash, changes, clients)
}

func roamShared(ctx context.Context, logger *slog.Logger, database *db.DB, ring *contentcrypto.KeyRing, config Config, spaceBots []Bot, prevHash string, clients []*Client) (bool, bool, []Change, string, string, error) {
	if len(spaceBots) == 0 {
		return false, false, nil, "", "", nil
	}
	bot := spaceBots[0]
	documents, err := listDocuments(ctx, database, ring, bot, true)
	if err != nil {
		return false, false, nil, "", "", err
	}
	var changes []Change
	if indexOf(documents, memory.MemoryIndexPath) == nil {
		content := initialMemory("Shared memory")
		changes = append(changes, Change{
			Command: CmdMemoryWrite, Scope: "user", Path: memory.MemoryIndexPath, Action: "seed-index",
			BeforeBytes: 0, AfterBytes: len([]byte(content)),
		})
		zero := int64(0)
		if !config.DryRun {
			if _, err := memory.Commit(ctx, database, actorFor(bot), ring, memory.CommitInput{
				Scope: "user", Path: memory.MemoryIndexPath, Content: content, ExpectedRevision: &zero,
			}); err != nil {
				return false, false, changes, "", "", err
			}
		}
		documents, err = listDocuments(ctx, database, ring, bot, true)
		if err != nil {
			return false, false, changes, "", "", err
		}
	}
	extra := botContext{Now: time.Now().UTC(), Compact: config.Compact}
	for _, member := range spaceBots {
		memberDocs, err := listDocuments(ctx, database, ring, member, false)
		if err != nil {
			logger.Warn("memory.roamer.legacy_user_read_failed", "botId", member.ID, "error", err.Error())
			continue
		}
		if doc := indexOf(memberDocs, UserMemoryPath); doc != nil && strings.TrimSpace(doc.Content) != "" {
			extra.LegacyUserDocs = append(extra.LegacyUserDocs, evidenceDocument{
				Label:   member.Name + " " + UserMemoryPath,
				Content: doc.Content,
			})
		}
	}
	return roamDocuments(ctx, logger, database, ring, config, bot, documents, true, extra, prevHash, changes, clients)
}

func roamDocuments(ctx context.Context, logger *slog.Logger, database *db.DB, ring *contentcrypto.KeyRing, config Config, bot Bot, documents []memory.Document, shared bool, extra botContext, prevHash string, changes []Change, clients []*Client) (bool, bool, []Change, string, string, error) {
	payload, omitted := promptFor(bot, documents, config.MaxInputBytes, shared, extra)
	if payload == "" {
		return false, false, changes, "", "", nil
	}
	currentHash := stableInputHash(payload)
	compactMode := isCompactPass(bot, documents, shared, extra)
	if !config.Compact && !config.Force && prevHash != "" && prevHash == currentHash && !compactMode {
		logger.Debug("memory.roamer.unchanged", "botId", bot.ID, "shared", shared, "inputHash", currentHash)
		return false, true, changes, "", currentHash, nil
	}
	started := time.Now()
	pass := passBot
	if shared {
		pass = passShared
	}
	compactInstructions := !shared && shouldCompactInstructions(bot, documents, config.Compact)
	text, usage, used, err := complete(ctx, logger, clients, systemPrompt(pass, compactMode, compactInstructions), payload)
	if err != nil {
		return true, false, changes, "", "", err
	}
	logger.Info("memory.roamer.model", "botId", bot.ID, "shared", shared, "model", used,
		"durationMs", time.Since(started).Milliseconds(), "usage", string(usage))
	parsed, err := parseAnswer(text)
	if err != nil {
		return true, false, changes, used, "", err
	}
	validated, err := validateChanges(parsed, documents, omitted, shared, bot.Instructions, config.Compact)
	if err != nil {
		return true, false, changes, used, "", err
	}
	for _, name := range validated.Ignored {
		logger.Info("memory.roamer.command_skipped", "botId", bot.ID, "shared", shared, "command", name,
			"reason", "outside this pass's writable scope")
	}

	for _, change := range validated.Updates {
		before := 0
		if change.Current != nil {
			before = len([]byte(change.Current.Content))
		}
		changes = append(changes, Change{
			Command: CmdMemoryWrite, Scope: scopeFor(shared), Path: change.Path, Action: "update",
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
			return true, false, changes, used, "", err
		}
	}

	for _, arch := range validated.Archives {
		targetPath, merged, existingDoc, changed, err := resolveArchiveTarget(documents, arch.Path, arch.Content)
		if err != nil {
			return true, false, changes, used, "", err
		}
		if !changed {
			continue
		}
		before := 0
		var expected int64
		if existingDoc != nil {
			before = len([]byte(existingDoc.Content))
			expected = int64(existingDoc.Revision)
		}
		changes = append(changes, Change{
			Command: CmdMemoryArchive, Scope: scopeFor(shared), Path: targetPath, Action: "archive",
			BeforeBytes: before, AfterBytes: len([]byte(merged)), Created: existingDoc == nil,
		})
		if config.DryRun {
			continue
		}
		_, err = memory.Commit(ctx, database, actorFor(bot), ring, memory.CommitInput{
			Scope: scopeFor(shared), BotID: botIDFor(shared, bot.ID), Path: targetPath,
			Content: merged, ExpectedRevision: &expected,
		})
		if err != nil {
			if isConflict(err) {
				logger.Warn("memory.roamer.conflict", "botId", bot.ID, "path", targetPath)
				continue
			}
			return true, false, changes, used, "", err
		}
	}

	if validated.Instructions != nil {
		if config.DryRun {
			changes = append(changes, Change{
				Command: CmdInstructionsSet, Scope: "bot", Path: "Instructions", Action: "update",
				BeforeBytes: len([]byte(bot.Instructions)), AfterBytes: len([]byte(*validated.Instructions)),
			})
		} else {
			updated, err := commitInstructions(ctx, logger, database, ring, bot, *validated.Instructions)
			if err != nil {
				return true, false, changes, used, "", err
			}
			if !updated {
				logger.Warn("memory.roamer.instructions_changed", "botId", bot.ID)
			} else {
				changes = append(changes, Change{
					Command: CmdInstructionsSet, Scope: "bot", Path: "Instructions", Action: "update",
					BeforeBytes: len([]byte(bot.Instructions)), AfterBytes: len([]byte(*validated.Instructions)),
				})
			}
		}
	}

	return true, false, changes, used, currentHash, nil
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
			append(db.Data(content, db.JSONText(string(history))), bot.ID, bot.SpaceID)...); err != nil {
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
	version, err := wtf8.Marshal(instructionVersion{
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
	return wtf8.Marshal(history)
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

// commandFooter ends every prompt the same way: the commands the pass may use,
// copied from the registry, and the one JSON envelope they travel in.
func commandFooter(pass passKind) string {
	return fmt.Sprintf(`You act only through these named commands. There is no shell, no tool call, and no other way to write:
%s
Return JSON only: {"commands":[ ...commands in the exact shapes above... ]}. Send a command only when it changes something, with the complete new content. Send {"commands":[]} when nothing should change. A command not listed above, or aimed at a path you cannot write, is ignored. No other keys.`, commandHelp(pass))
}

func systemPrompt(pass passKind, compactMode, compactInstructions bool) string {
	switch pass {
	case passShared:
		compactClause := ""
		if compactMode {
			compactClause = fmt.Sprintf("\nCOMPACTION ACTIVE: One or more shared surfaces exceed their soft target (%d bytes for %s, %d bytes for %s). Actively shrink bloated files by collapsing verbose logs into crisp 1-line rules, removing stale/completed history into archive/YYYY-MM.md via %s, and eliminating redundancy.",
				SharedMemorySoftBytes, memory.MemoryIndexPath, UserMemorySoftBytes, UserMemoryPath, CmdMemoryArchive)
		}
		return fmt.Sprintf(`You maintain the shared durable memory and consolidated Space user profile that every bot in one Rakazo Space reads. You can read its documents below and return a minimal change set.

Only shared memory is in scope. Never change a bot's Instructions, settings, tasks, chats, secrets, skills, or any other record.
Writable surfaces:
- %s (target <=%d bytes, hard max %d bytes): Space-wide durable facts every bot needs (shared people, conventions, architecture, active Space resources). Bot-specific task state stays out.
- %s (target <=%d bytes, hard max %d bytes): consolidated profile of the person(s) this Space serves (name, role, timezone, language, stable communication/tool preferences). Never put project logs, task state, or secrets here. Migrate durable person facts from any Legacy bot USER.md shown below into this Space %s.
- %s: append concise, dated 1-line summaries of completed milestones, resolved incidents, or retired context to archive/YYYY-MM.md so hot files stay lean without losing accuracy.
Every other shared memory document is read-only context. Never delete a document.
%s must keep its first "# " heading.
Context-rot policy:
- Keep hot files structured and scannable (e.g. "## Current State" with [YYYY-MM-DD] tags, "## Conventions & Decisions" for durable rules).
- Collapse multi-step trial-and-error logs into a single outcome/rule line.
- Move completed or historical items out of hot files via %s rather than hoarding them.
- Drop items that are redundant, superseded, or contradicted by newer notes.
Do not invent facts. When unsure, leave a current fact alone.%s
%s`, memory.MemoryIndexPath, SharedMemorySoftBytes, SharedMemoryMaxBytes,
			UserMemoryPath, UserMemorySoftBytes, UserMemoryMaxBytes, UserMemoryPath,
			CmdMemoryArchive, memory.MemoryIndexPath, CmdMemoryArchive, compactClause, commandFooter(passShared))
	case passSkills:
		return skillsSystemPrompt()
	}

	instructionsGuidance := fmt.Sprintf("Instructions are high authority. Change them only for a clear, durable correction or consolidation supported by memory. Preserve the existing role, responsibilities, safety rules, tone, and formatting. Do not add capabilities, permissions, autonomy, secrets, or tools; do not weaken a safety rule. Prefer leaving Instructions unchanged. instructions.set takes at most %d characters.", MaxInstructionsLength)
	if compactInstructions {
		instructionsGuidance = fmt.Sprintf(`INSTRUCTIONS COMPACTION ACTIVE (target <=%d characters, hard max %d):
- Strip inline step-by-step runbooks/procedures already covered by an Available Skill and replace them with a 1-line pointer ("Use skill: <name>").
- Move project state/history out of Instructions into %s (or %s for completed history).
- Remove facts already covered by Space %s or Space %s.
- Merge duplicate or overly wordy rules into crisp directives.
- STRICT INVARIANT: preserve the bot's core role, responsibilities, safety rules, authority boundaries, tone, and output contract. Never add capabilities, permissions, autonomy, secrets, or tools; never weaken a safety rule; never expand Instructions.`,
			InstructionsSoftChars, MaxInstructionsLength, memory.MemoryIndexPath, CmdMemoryArchive, UserMemoryPath, memory.MemoryIndexPath)
	}
	compactClause := ""
	if compactMode {
		compactClause = fmt.Sprintf("\nCOMPACTION ACTIVE: Hot memory exceeds its %d-byte soft target. Aggressively archive completed/stale items via %s, collapse logs into 1-line outcomes, and offload skill-covered procedures.",
			BotMemorySoftBytes, CmdMemoryArchive)
	}
	return fmt.Sprintf(`You maintain the durable memory and Instructions of one Rakazo bot. You can read its memory, Space shared context, Open work, Available Skills, and Instructions below and return a minimal change set.

Only three write operations are in scope for this bot: %s (via %s), %s (cold archive), and Instructions (via %s). Never change settings, tasks, chats, secrets, skills, or Space shared documents.
Writable surfaces:
- %s (target <=%d bytes, hard max %d bytes): the bot's hot working memory. Organize into "## Current State" (prefix active items with [YYYY-MM-DD]), "## Decisions & Lessons" (1-line durable rules/outcomes), and optional "## Pointers" (names of relevant Skills/archives).
- %s (archive/YYYY-MM.md): cold archive excluded from auto-prompt, searchable on demand. Move completed projects, resolved incidents, and historical logs here as concise dated 1-line entries.
- Instructions: the bot's stable role, responsibilities, behavioral rules, tone, and working style.
Deduplication & routing:
- Person facts belong in Space %s (read-only here) and Space facts belong in Space %s (read-only here); do not duplicate them in bot %s.
- Cross-check Open work and Today's date: archive items that are already finished or stale past recent relevance.
- When an Available Skill already covers a repeatable procedure in %s or Instructions, replace the inline steps with a 1-line skill pointer.
%s must keep its first "# <bot name>" heading.
%s
Do not invent facts. When unsure about an active item, keep it; when something is clearly historical or duplicated in Space memory/Skills, compact or archive it.%s
%s`,
		memory.MemoryIndexPath, CmdMemoryWrite, CmdMemoryArchive, CmdInstructionsSet,
		memory.MemoryIndexPath, BotMemorySoftBytes, BotMemoryMaxBytes,
		CmdMemoryArchive,
		UserMemoryPath, memory.MemoryIndexPath, memory.MemoryIndexPath,
		memory.MemoryIndexPath,
		memory.MemoryIndexPath,
		instructionsGuidance,
		compactClause,
		commandFooter(passBot))
}

// complete asks the pass's clients in order and returns the first answer.
// If a client truncates empty output due to finish_reason=length below 32,768 tokens,
// it retries once at 32,768 tokens before falling back to the next connection.
func complete(ctx context.Context, logger *slog.Logger, clients []*Client, system, payload string) (string, json.RawMessage, string, error) {
	var lastErr error
	for _, client := range clients {
		text, usage, err := client.Complete(ctx, system, payload)
		if err != nil && isLengthTruncated(err) && client.MaxTokens() < 32_768 {
			if logger != nil {
				logger.Warn("memory.roamer.retry_max_tokens", "model", client.Model(),
					"from", client.MaxTokens(), "to", 32_768)
			}
			text, usage, err = client.CompleteWithMaxTokens(ctx, system, payload, 32_768)
		}
		if err == nil {
			return text, usage, client.Model(), nil
		}
		lastErr = err
	}
	if lastErr == nil {
		lastErr = errors.New("no model connection")
	}
	return "", nil, "", lastErr
}

func stableInputHash(payload string) string {
	lines := strings.Split(payload, "\n")
	kept := make([]string, 0, len(lines))
	for _, line := range lines {
		if strings.HasPrefix(line, "Today (UTC): ") {
			continue
		}
		kept = append(kept, line)
	}
	sum := sha256.Sum256([]byte(strings.Join(kept, "\n")))
	return hex.EncodeToString(sum[:8])
}

func docBytes(documents []memory.Document, path string) int {
	if doc := indexOf(documents, path); doc != nil {
		return len([]byte(doc.Content))
	}
	return 0
}

func isMemoryOverTrigger(documents []memory.Document, shared bool) bool {
	if shared {
		return docBytes(documents, memory.MemoryIndexPath) > SharedMemoryTriggerBytes ||
			docBytes(documents, UserMemoryPath) > UserMemoryTriggerBytes
	}
	return docBytes(documents, memory.MemoryIndexPath) > BotMemoryTriggerBytes
}

func shouldCompactInstructions(bot Bot, documents []memory.Document, compact bool) bool {
	if compact {
		return wtf8.Length(bot.Instructions) > InstructionsSoftChars
	}
	return wtf8.Length(bot.Instructions) > InstructionsTriggerChars && !isMemoryOverTrigger(documents, false)
}

func isCompactPass(bot Bot, documents []memory.Document, shared bool, extra botContext) bool {
	if extra.Compact {
		return true
	}
	if isMemoryOverTrigger(documents, shared) {
		return true
	}
	return !shared && shouldCompactInstructions(bot, documents, false)
}

func promptDate(updatedAt string) string {
	if len(updatedAt) >= 10 {
		return ", updated " + updatedAt[:10]
	}
	return ""
}

func docBudgetNote(path string, shared bool) string {
	if shared {
		switch path {
		case memory.MemoryIndexPath:
			return fmt.Sprintf(", target <=%d, max %d bytes", SharedMemorySoftBytes, SharedMemoryMaxBytes)
		case UserMemoryPath:
			return fmt.Sprintf(", target <=%d, max %d bytes", UserMemorySoftBytes, UserMemoryMaxBytes)
		}
		return ""
	}
	if path == memory.MemoryIndexPath {
		return fmt.Sprintf(", target <=%d, max %d bytes", BotMemorySoftBytes, BotMemoryMaxBytes)
	}
	return ""
}

func promptFor(bot Bot, documents []memory.Document, maxBytes int, shared bool, extra botContext) (string, []string) {
	hasSharedUser := strings.TrimSpace(extra.SharedUser) != ""
	var hot []memory.Document
	for _, document := range documents {
		// Cold archive documents live out of hot context and are appended via memory.archive.
		if memory.IsArchivePath(document.Path) {
			continue
		}
		if !shared && hasSharedUser && document.Path == UserMemoryPath {
			continue
		}
		hot = append(hot, document)
	}

	ordered := append([]memory.Document(nil), hot...)
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
		instrChars := wtf8.Length(bot.Instructions)
		if shouldCompactInstructions(bot, documents, extra.Compact) {
			sections = append(sections, fmt.Sprintf("--- Instructions (writable; complete replacement if changed; %d chars — OVER %d-char target; compact toward <=%d chars) ---\n%s",
				instrChars, InstructionsSoftChars, InstructionsSoftChars, instructions))
		} else {
			sections = append(sections, fmt.Sprintf("--- Instructions (writable; complete replacement if changed; %d characters) ---\n%s",
				instrChars, instructions))
		}
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
		access := docBudgetNote(document.Path, shared)
		if !isWritablePath(document.Path, shared) {
			access = ", read-only"
		}
		sections = append(sections, fmt.Sprintf("--- %s (revision %d, %d bytes%s%s) ---\n%s",
			document.Path, document.Revision, len([]byte(document.Content)), promptDate(document.UpdatedAt), access, document.Content))
	}

	appendReadOnly := func(heading, body string) {
		if strings.TrimSpace(body) == "" {
			return
		}
		block := fmt.Sprintf("--- %s ---\n%s", heading, strings.TrimSpace(body))
		if used+len([]byte(block)) > maxBytes {
			return
		}
		used += len([]byte(block))
		sections = append(sections, block)
	}

	if !shared {
		appendReadOnly("Space "+UserMemoryPath+" (read-only; do not duplicate in bot memory)", extra.SharedUser)
		appendReadOnly("Space "+memory.MemoryIndexPath+" (read-only; do not duplicate in bot memory)", extra.SharedMemory)
		if len(extra.OpenWork) > 0 {
			var lines []string
			for _, item := range extra.OpenWork {
				line := fmt.Sprintf("- [%s] %s (updated %s)", item.Status, item.Title, item.UpdatedAt.UTC().Format("2006-01-02"))
				if notes := strings.TrimSpace(item.Notes); notes != "" {
					if len(notes) > 120 {
						notes = notes[:120] + "..."
					}
					line += " — " + strings.ReplaceAll(notes, "\n", " ")
				}
				lines = append(lines, line)
			}
			appendReadOnly("Open work (read-only; live tasks)", strings.Join(lines, "\n"))
		}
		if len(extra.Skills) > 0 {
			var lines []string
			for _, skill := range extra.Skills {
				desc := strings.Join(strings.Fields(skill.Description), " ")
				if len(desc) > 120 {
					desc = desc[:117] + "..."
				}
				lines = append(lines, fmt.Sprintf("- %s: %s", skill.Name, desc))
			}
			appendReadOnly("Available Skills (read-only; replace inline procedures with pointers)", strings.Join(lines, "\n"))
		}
	} else {
		for _, legacy := range extra.LegacyUserDocs {
			appendReadOnly("Legacy bot "+legacy.Label+" (read-only; migrate durable person facts to Space "+UserMemoryPath+")", legacy.Content)
		}
	}

	if len(sections) == 0 {
		return "", nil
	}
	now := extra.Now
	if now.IsZero() {
		now = time.Now().UTC()
	}
	modeLabel := "maintain"
	if isCompactPass(bot, documents, shared, extra) {
		modeLabel = "compact"
	}
	label := bot.Name
	if shared {
		label = "Shared memory"
	}
	writableList := append(append([]string{}, writable...), "archive/*.md (append via "+CmdMemoryArchive+")")
	payload := fmt.Sprintf("Memory owner: %s\nToday (UTC): %s\nMode: %s\nWritable surfaces: %s\n\n%s",
		label, now.UTC().Format("2006-01-02"), modeLabel, strings.Join(writableList, ", "), strings.Join(sections, "\n\n"))
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

// validateChanges checks a memory pass's commands. A command that is unknown,
// not granted to this pass, or aimed at a path the pass cannot write is ignored;
// a malformed or unsafe command it may run fails the whole answer, so a broken
// model is not half-applied.
func validateChanges(parsed answer, documents []memory.Document, omitted []string, shared bool, instructions string, compact bool) (validatedChanges, error) {
	pass := passBot
	if shared {
		pass = passShared
	}
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
	archived := map[string]bool{}
	instructionsSet := false
	for _, item := range parsed.Commands {
		spec, known := lookupCommand(strings.TrimSpace(item.Name))
		if !known || !spec.allows(pass) {
			result.Ignored = append(result.Ignored, strings.TrimSpace(item.Name))
			continue
		}
		switch spec.Name {
		case CmdMemoryWrite:
			if err := validateMemoryWrite(item, current, omittedSet, touched, shared, &result); err != nil {
				return validatedChanges{}, err
			}
		case CmdMemoryArchive:
			if err := validateMemoryArchive(item, archived, &result); err != nil {
				return validatedChanges{}, err
			}
		case CmdInstructionsSet:
			if instructionsSet {
				return validatedChanges{}, fmt.Errorf("model sent %s twice", CmdInstructionsSet)
			}
			instructionsSet = true
			content := strings.TrimSpace(strings.ReplaceAll(item.Content, "\r\n", "\n"))
			existing := strings.TrimSpace(instructions)
			if content == "" {
				if existing != "" {
					return validatedChanges{}, fmt.Errorf("model blanked instructions")
				}
				continue
			}
			if wtf8.Length(content) > MaxInstructionsLength {
				return validatedChanges{}, fmt.Errorf("model exceeded the instructions cap")
			}
			if wtf8.Length(existing) > InstructionsSoftChars && wtf8.Length(content) > wtf8.Length(existing) {
				return validatedChanges{}, fmt.Errorf("model expanded already-oversized instructions")
			}
			if !compact && wtf8.Length(existing) >= 500 && wtf8.Length(content)*10 < wtf8.Length(existing)*6 {
				return validatedChanges{}, fmt.Errorf("model dropped more than 40%% of instructions outside --compact mode")
			}
			if content != existing {
				result.Instructions = &content
			}
		}
	}
	return result, nil
}

func validateMemoryArchive(item command, archived map[string]bool, result *validatedChanges) error {
	path := strings.TrimSpace(item.Path)
	if path == "" || !safePath.MatchString(path) || strings.Contains(path, "..") || strings.HasSuffix(path, "/") {
		return fmt.Errorf("%s path is invalid", CmdMemoryArchive)
	}
	if !memory.IsArchivePath(path) || !strings.HasSuffix(path, ".md") {
		return fmt.Errorf("%s must target an archive/*.md path", CmdMemoryArchive)
	}
	content := strings.TrimSpace(strings.ReplaceAll(item.Content, "\r\n", "\n"))
	if content == "" {
		return fmt.Errorf("model sent blank %s content", CmdMemoryArchive)
	}
	if len([]byte(content)) > MaxOtherBytes {
		return fmt.Errorf("model exceeded the size cap for %s", path)
	}
	if archived[path] {
		return fmt.Errorf("model archived to %s twice", path)
	}
	archived[path] = true
	result.Archives = append(result.Archives, archiveAppend{Path: path, Content: content})
	return nil
}

func appendArchive(existingContent, path, addition string) (string, bool, error) {
	base := existingContent
	if strings.TrimSpace(base) == "" {
		stem := strings.TrimSuffix(strings.TrimPrefix(path, memory.MemoryArchivePrefix), ".md")
		if stem == "" {
			stem = "Memory"
		}
		base = "# Archive " + stem + "\n\n"
	}
	existingLines := map[string]bool{}
	for _, line := range strings.Split(strings.ReplaceAll(base, "\r\n", "\n"), "\n") {
		if trimmed := strings.TrimSpace(line); trimmed != "" {
			existingLines[trimmed] = true
		}
	}
	var added []string
	for _, line := range strings.Split(strings.ReplaceAll(addition, "\r\n", "\n"), "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || existingLines[trimmed] {
			continue
		}
		existingLines[trimmed] = true
		added = append(added, trimmed)
	}
	if len(added) == 0 {
		return existingContent, false, nil
	}
	sep := ""
	if base != "" && !strings.HasSuffix(base, "\n") {
		sep = "\n"
	}
	merged := base + sep + strings.Join(added, "\n") + "\n"
	if len([]byte(merged)) > MaxOtherBytes {
		return "", false, fmt.Errorf("%w: %s exceeds %d bytes", errArchiveFull, path, MaxOtherBytes)
	}
	return merged, true, nil
}

func resolveArchiveTarget(documents []memory.Document, basePath, addition string) (string, string, *memory.Document, bool, error) {
	stem := strings.TrimSuffix(basePath, ".md")
	const maxRollovers = 20
	for index := 1; index <= maxRollovers; index++ {
		candidate := basePath
		if index > 1 {
			candidate = fmt.Sprintf("%s-%d.md", stem, index)
		}
		existingDoc := indexOf(documents, candidate)
		existingContent := ""
		if existingDoc != nil {
			existingContent = existingDoc.Content
		}
		merged, changed, err := appendArchive(existingContent, candidate, addition)
		if err == nil {
			return candidate, merged, existingDoc, changed, nil
		}
		if !errors.Is(err, errArchiveFull) {
			return "", "", nil, false, err
		}
	}
	return "", "", nil, false, fmt.Errorf("archive %s and rollover files are full", basePath)
}

func validateMemoryWrite(item command, current map[string]memory.Document, omitted, touched map[string]bool, shared bool, result *validatedChanges) error {
	path := strings.TrimSpace(item.Path)
	if path == "" || !safePath.MatchString(path) || strings.Contains(path, "..") || strings.HasSuffix(path, "/") {
		return fmt.Errorf("%s path is invalid", CmdMemoryWrite)
	}
	if path != memory.MemoryIndexPath && !strings.HasSuffix(path, ".md") {
		return fmt.Errorf("only .md memory documents can be written")
	}
	if !isWritablePath(path, shared) {
		result.Ignored = append(result.Ignored, CmdMemoryWrite+" "+path)
		return nil
	}
	if omitted[path] {
		return fmt.Errorf("model changed omitted document %s", path)
	}
	content := strings.ReplaceAll(item.Content, "\r\n", "\n")
	if strings.TrimSpace(content) == "" {
		return fmt.Errorf("model blanked %s", path)
	}
	existing, found := current[path]
	limit := MaxOtherBytes
	if shared && path == UserMemoryPath {
		limit = UserMemoryMaxBytes
	}
	if path == memory.MemoryIndexPath {
		limit = BotMemoryMaxBytes
		if shared {
			limit = SharedMemoryMaxBytes
		}
		// Keep the index's identity: a model may return a different heading or
		// drop it, but the document keeps the first line it already had.
		if found {
			oldHeading := firstLine(existing.Content)
			newHeading := firstLine(content)
			if strings.HasPrefix(oldHeading, "# ") && newHeading != oldHeading {
				if strings.HasPrefix(content, "# ") {
					content = oldHeading + content[len(newHeading):]
				} else {
					content = oldHeading + "\n\n" + content
				}
			}
		}
		if !strings.HasPrefix(content, "# ") {
			return fmt.Errorf("model removed the index heading")
		}
	}
	if len([]byte(content)) > limit {
		return fmt.Errorf("model exceeded the size cap for %s", path)
	}
	if touched[path] {
		return fmt.Errorf("model returned %s twice", path)
	}
	touched[path] = true
	if found && existing.Content == content {
		return nil
	}
	var currentDoc *memory.Document
	if found {
		copied := existing
		currentDoc = &copied
	}
	result.Updates = append(result.Updates, update{Path: path, Content: content, Current: currentDoc})
	return nil
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
