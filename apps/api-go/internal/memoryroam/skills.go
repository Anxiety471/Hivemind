package memoryroam

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/contentcrypto"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/effects"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/agentskills"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/memory"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/wtf8"
)

// The skills pass turns procedures a Space's bots have already worked out into
// reusable skills, and upgrades the skills it wrote earlier. It follows the rule
// the bots' own skill tools follow (packages/adapters/src/tools/skill-tools.ts):
// it only changes user skills that live in this one Space, never a skill other
// Spaces read, never a built-in or plugin skill, and never deletes.
const (
	// Bounds match CreateAgentSkillInput (packages/contracts/src/skills/agent-skills.ts).
	MaxSkillNameChars        = 80
	MaxSkillDescriptionChars = 2000
	MaxSkillContentChars     = 100_000
	// maxSkillCommands bounds how much one pass can change in one Space.
	maxSkillCommands = 5
	// maxSkillsPerSpace stops a Space from collecting skills without limit.
	maxSkillsPerSpace = 50
	// skillRevisionsKept bounds the undo history of one skill.
	skillRevisionsKept  = 10
	skillRevisionReason = "Memory roamer"
)

var (
	skillNamePattern   = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9 _.-]{0,79}$`)
	skillFrontmatter   = regexp.MustCompile(`^---\r?\n[\s\S]*?\r?\n---\r?\n?`)
	plainYAMLScalar    = regexp.MustCompile(`^[A-Za-z]([A-Za-z0-9 _.-]*[A-Za-z0-9])?$`)
	reservedYAMLScalar = map[string]bool{
		"true": true, "false": true, "null": true, "yes": true, "no": true,
		"on": true, "off": true, "y": true, "n": true,
	}
)

// skillRecord is one skill the owner can use in the Space.
type skillRecord struct {
	ID          string
	Name        string
	Description string
	Content     string
	// Writable is true only for the user skills this pass may change.
	Writable bool
}

type skillCreate struct {
	Name, Description, Content string
}

type skillUpdate struct {
	Current skillRecord
	Content string
}

type skillPlan struct {
	Creates []skillCreate
	Updates []skillUpdate
	Ignored []string
}

type evidenceDocument struct {
	Label   string
	Content string
}

func skillsSystemPrompt() string {
	return fmt.Sprintf(`You maintain the skills of one Rakazo Space. A skill is a reusable how-to recipe a bot reads before doing a kind of work. You can read the Space's skills and its bots' memory below and return a minimal change set.

Only skills are in scope. Never change memory, Instructions, settings, tasks, chats, secrets, or any other record.
Create a skill only for a procedure that is repeatable, stated clearly enough in the memory to follow, and not already covered by a skill. Upgrade a writable skill only when the memory shows a corrected or clearly better way to do what it describes. Keep each skill about one job, in numbered steps, written for the bot that will follow it.
A skill must never contain a secret, credential, token, personal detail about a person, or the state of a task. Describe where a secret lives, never its value.
Only the writable skills below can be upgraded; every other skill is read-only context. A skill.update sends the complete new body, without the frontmatter, and keeps the existing name and description. A skill name is at most %d characters of letters, digits, spaces, dots, dashes, and underscores; a description is one line of at most %d characters that says when to use the skill.
Never delete a skill. Send at most %d commands. Prefer no change: when unsure, send {"commands":[]}.
%s`, MaxSkillNameChars, MaxSkillDescriptionChars, maxSkillCommands, commandFooter(passSkills))
}

// loadSkills reads every skill the owner can use in the bot's Space. It reads as
// the system so the owner's all-Spaces skills from other Spaces are visible to
// the name check; every predicate names the owner and the Space explicitly.
func loadSkills(ctx context.Context, database *db.DB, bot Bot) ([]skillRecord, error) {
	var skills []skillRecord
	err := database.System(ctx, "memory roamer reads skills", func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `SELECT s.id, s.name, s.description, s.content,
				(s.source = 'user' AND s."spaceId" = $2 AND NOT s."allSpaces"
					AND NOT EXISTS (SELECT 1 FROM agent_skill_spaces a WHERE a."skillId" = s.id)) AS writable
			FROM agent_skills s
			WHERE s."userId" = $1 AND (s."spaceId" = $2 OR s."allSpaces"
				OR EXISTS (SELECT 1 FROM agent_skill_spaces a WHERE a."skillId" = s.id AND a."spaceId" = $2))
			ORDER BY s.name ASC, s.id ASC`, bot.UserID, bot.SpaceID)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var skill skillRecord
			if err := rows.Scan(&skill.ID, &skill.Name, &skill.Description, &skill.Content, &skill.Writable); err != nil {
				return err
			}
			skills = append(skills, skill)
		}
		return rows.Err()
	})
	return skills, err
}

// skillEvidence is what the bots of one Space wrote down: the shared index,
// each bot's own MEMORY.md, and bloated Instructions (for procedure extraction).
func skillEvidence(ctx context.Context, database *db.DB, ring *contentcrypto.KeyRing, bots []Bot, compact bool) ([]evidenceDocument, error) {
	var evidence []evidenceDocument
	shared, err := listDocuments(ctx, database, ring, bots[0], true)
	if err != nil {
		return nil, err
	}
	if document := indexOf(shared, memory.MemoryIndexPath); document != nil && hasFacts(document.Content) {
		evidence = append(evidence, evidenceDocument{Label: "Shared memory " + memory.MemoryIndexPath, Content: document.Content})
	}
	for _, bot := range bots {
		documents, err := listDocuments(ctx, database, ring, bot, false)
		if err != nil {
			return nil, err
		}
		if document := indexOf(documents, memory.MemoryIndexPath); document != nil && hasFacts(document.Content) {
			evidence = append(evidence, evidenceDocument{Label: bot.Name + " " + memory.MemoryIndexPath, Content: document.Content})
		}
		if strings.TrimSpace(bot.Instructions) != "" && (compact || wtf8.Length(bot.Instructions) > InstructionsSoftChars) {
			evidence = append(evidence, evidenceDocument{
				Label:   bot.Name + " Instructions (extract repeatable procedures to skills)",
				Content: bot.Instructions,
			})
		}
	}
	return evidence, nil
}

// hasFacts is false for an index that holds only its heading.
func hasFacts(content string) bool {
	for _, line := range strings.Split(content, "\n") {
		line = strings.TrimSpace(line)
		if line != "" && !strings.HasPrefix(line, "# ") {
			return true
		}
	}
	return false
}

// skillsPrompt lists the skills, then the evidence, within the input budget. A
// writable skill that does not fit is left out of the prompt and of the set the
// answer may change.
func skillsPrompt(spaceName string, skills []skillRecord, evidence []evidenceDocument, maxBytes int) (string, []skillRecord) {
	var sections []string
	var writable []skillRecord
	var readOnly []string
	used := 0
	for _, skill := range skills {
		if !skill.Writable {
			readOnly = append(readOnly, fmt.Sprintf("- %s: %s", skill.Name, skill.Description))
			continue
		}
		size := len([]byte(skill.Content))
		if len(writable) > 0 && used+size > maxBytes {
			continue
		}
		used += size
		writable = append(writable, skill)
		sections = append(sections, fmt.Sprintf("--- Skill: %s (writable, %d bytes) ---\n%s", skill.Name, size, skill.Content))
	}
	for _, document := range evidence {
		size := len([]byte(document.Content))
		if used > 0 && used+size > maxBytes {
			continue
		}
		used += size
		sections = append(sections, fmt.Sprintf("--- Memory: %s (read-only, %d bytes) ---\n%s", document.Label, size, document.Content))
	}
	if len(sections) == 0 || len(evidence) == 0 {
		return "", nil
	}
	if len(readOnly) == 0 {
		readOnly = []string{"(none)"}
	}
	payload := fmt.Sprintf("Space: %s\nWritable skills: %d\n\nRead-only skills (never change these, never duplicate them):\n%s\n\n%s",
		spaceName, len(writable), strings.Join(readOnly, "\n"), strings.Join(sections, "\n\n"))
	return payload, writable
}

func normalizeSkillName(name string) string {
	return strings.ToLower(strings.TrimSpace(name))
}

// splitSkill separates a SKILL.md's frontmatter from its body without parsing the
// YAML, so an update keeps every key the person or an installer put there.
func splitSkill(content string) (string, string, bool) {
	head := skillFrontmatter.FindString(content)
	if head == "" {
		return "", "", false
	}
	body := content[len(head):]
	if !strings.HasSuffix(head, "\n") {
		head += "\n"
	}
	return head, body, true
}

func yamlScalar(value string) string {
	if plainYAMLScalar.MatchString(value) && !reservedYAMLScalar[strings.ToLower(value)] {
		return value
	}
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	_ = encoder.Encode(value)
	return strings.TrimSuffix(buffer.String(), "\n")
}

func skillBody(body string) string {
	return strings.TrimRight(strings.TrimLeft(strings.ReplaceAll(body, "\r\n", "\n"), "\n"), " \t\n") + "\n"
}

// buildSkillContent is buildSkillMd (packages/core/src/skills/agent-skill.ts) for a
// name and description with no extra frontmatter keys.
func buildSkillContent(name, description, body string) string {
	return "---\nname: " + yamlScalar(name) + "\ndescription: " + yamlScalar(description) + "\n---\n\n" + skillBody(body)
}

// validateSkillCommands checks a skills pass's commands. Unknown or ungranted
// commands, a skill the pass may not change, and a name that is taken are ignored;
// a malformed command it may run fails the whole answer.
func validateSkillCommands(parsed answer, writable []skillRecord, all []skillRecord) (skillPlan, error) {
	plan := skillPlan{}
	taken := map[string]bool{}
	for _, name := range agentskills.BuiltinNames() {
		taken[normalizeSkillName(name)] = true
	}
	for _, skill := range all {
		taken[normalizeSkillName(skill.Name)] = true
	}
	writableByName := map[string]skillRecord{}
	for _, skill := range writable {
		writableByName[normalizeSkillName(skill.Name)] = skill
	}
	owned := 0
	for _, skill := range all {
		if skill.Writable {
			owned++
		}
	}
	seen := map[string]bool{}
	count := 0
	for _, item := range parsed.Commands {
		spec, known := lookupCommand(strings.TrimSpace(item.Name))
		if !known || !spec.allows(passSkills) {
			plan.Ignored = append(plan.Ignored, strings.TrimSpace(item.Name))
			continue
		}
		count++
		if count > maxSkillCommands {
			plan.Ignored = append(plan.Ignored, spec.Name+" (over the command limit)")
			continue
		}
		name := strings.TrimSpace(item.Skill)
		key := normalizeSkillName(name)
		if name == "" {
			return skillPlan{}, fmt.Errorf("%s needs a skill name", spec.Name)
		}
		if spec.Name == CmdSkillCreate && !skillNamePattern.MatchString(name) {
			return skillPlan{}, fmt.Errorf("%s skill name is invalid", spec.Name)
		}
		if seen[key] {
			return skillPlan{}, fmt.Errorf("model sent two commands for skill %s", name)
		}
		seen[key] = true
		switch spec.Name {
		case CmdSkillCreate:
			description := strings.Join(strings.Fields(item.Description), " ")
			if description == "" || utf8.RuneCountInString(description) > MaxSkillDescriptionChars {
				return skillPlan{}, fmt.Errorf("%s description must be 1 to %d characters", spec.Name, MaxSkillDescriptionChars)
			}
			if strings.TrimSpace(item.Body) == "" {
				return skillPlan{}, fmt.Errorf("model sent an empty body for skill %s", name)
			}
			content := buildSkillContent(name, description, item.Body)
			if utf8.RuneCountInString(content) > MaxSkillContentChars {
				return skillPlan{}, fmt.Errorf("skill %s exceeds the size cap", name)
			}
			if taken[key] || owned >= maxSkillsPerSpace {
				plan.Ignored = append(plan.Ignored, spec.Name+" "+name)
				continue
			}
			owned++
			plan.Creates = append(plan.Creates, skillCreate{Name: name, Description: description, Content: content})
		case CmdSkillUpdate:
			current, found := writableByName[key]
			if !found {
				plan.Ignored = append(plan.Ignored, spec.Name+" "+name)
				continue
			}
			if strings.TrimSpace(item.Body) == "" {
				return skillPlan{}, fmt.Errorf("model blanked skill %s", name)
			}
			head, oldBody, ok := splitSkill(current.Content)
			if !ok {
				plan.Ignored = append(plan.Ignored, spec.Name+" "+name+" (no frontmatter)")
				continue
			}
			content := head + "\n" + skillBody(item.Body)
			if utf8.RuneCountInString(content) > MaxSkillContentChars {
				return skillPlan{}, fmt.Errorf("skill %s exceeds the size cap", name)
			}
			if strings.TrimSpace(oldBody) == strings.TrimSpace(item.Body) {
				continue
			}
			plan.Updates = append(plan.Updates, skillUpdate{Current: current, Content: content})
		}
	}
	return plan, nil
}

// roamSkills runs the skills pass for one Space. bots are the owner's bots in it.
func roamSkills(ctx context.Context, logger *slog.Logger, database *db.DB, ring *contentcrypto.KeyRing, config Config, bots []Bot, clients []*Client) (bool, []Change, string, error) {
	if len(bots) == 0 {
		return false, nil, "", nil
	}
	lead := bots[0]
	skills, err := loadSkills(ctx, database, lead)
	if err != nil {
		return false, nil, "", err
	}
	evidence, err := skillEvidence(ctx, database, ring, bots, config.Compact)
	if err != nil {
		return false, nil, "", err
	}
	payload, writable := skillsPrompt(sharedTargetName(lead), skills, evidence, config.MaxInputBytes)
	if payload == "" {
		return false, nil, "", nil
	}
	started := time.Now()
	text, usage, used, err := complete(ctx, clients, systemPrompt(passSkills, config.Compact, false), payload)
	if err != nil {
		return true, nil, "", err
	}
	logger.Info("memory.roamer.model", "spaceId", lead.SpaceID, "skills", true, "model", used,
		"durationMs", time.Since(started).Milliseconds(), "usage", string(usage))
	parsed, err := parseAnswer(text)
	if err != nil {
		return true, nil, used, err
	}
	plan, err := validateSkillCommands(parsed, writable, skills)
	if err != nil {
		return true, nil, used, err
	}
	for _, name := range plan.Ignored {
		logger.Info("memory.roamer.command_skipped", "spaceId", lead.SpaceID, "skills", true, "command", name,
			"reason", "outside this pass's writable scope")
	}

	var changes []Change
	for _, update := range plan.Updates {
		change := Change{
			Command: CmdSkillUpdate, Scope: "skill", Path: update.Current.Name, Action: "update",
			BeforeBytes: len([]byte(update.Current.Content)), AfterBytes: len([]byte(update.Content)),
		}
		if !config.DryRun {
			applied, err := applySkillUpdate(ctx, database, lead, update)
			if err != nil {
				return true, changes, used, err
			}
			if !applied {
				logger.Warn("memory.roamer.conflict", "spaceId", lead.SpaceID, "skill", update.Current.Name)
				continue
			}
		}
		changes = append(changes, change)
	}
	for _, create := range plan.Creates {
		change := Change{
			Command: CmdSkillCreate, Scope: "skill", Path: create.Name, Action: "create",
			AfterBytes: len([]byte(create.Content)), Created: true,
		}
		if !config.DryRun {
			applied, err := applySkillCreate(ctx, database, lead, create)
			if err != nil {
				return true, changes, used, err
			}
			if !applied {
				logger.Warn("memory.roamer.conflict", "spaceId", lead.SpaceID, "skill", create.Name)
				continue
			}
		}
		changes = append(changes, change)
	}
	return true, changes, used, nil
}

// applySkillCreate adds one user skill that exists only in the bot's Space. The
// owner lock is the one the API takes before it claims a skill name, so two writers
// cannot both take it. It reports false when the name was taken in the meantime.
func applySkillCreate(ctx context.Context, database *db.DB, bot Bot, create skillCreate) (bool, error) {
	created := false
	err := database.System(ctx, "memory roamer creates a skill", func(tx pgx.Tx) error {
		//writeaudit:dynamic transaction-scoped advisory lock; the skill name is a filter
		if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
			"names:skill:"+bot.UserID); err != nil {
			return err
		}
		var clash bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM agent_skills s
				WHERE s."userId" = $1 AND lower(s.name) = lower($3)
					AND (s."spaceId" = $2 OR s."allSpaces"
						OR EXISTS (SELECT 1 FROM agent_skill_spaces a WHERE a."skillId" = s.id AND a."spaceId" = $2)))`,
			bot.UserID, bot.SpaceID, create.Name).Scan(&clash); err != nil {
			return err
		}
		if clash {
			return nil
		}
		if _, err := tx.Exec(ctx, `INSERT INTO agent_skills
				(id, "spaceId", "userId", name, description, content, source, "allSpaces", "createdAt", "updatedAt")
			VALUES ($1, $2, $3, $4, $5, $6, 'user', false, now(), now())`,
			db.Data(effects.NewID(), bot.SpaceID, bot.UserID, create.Name, create.Description, create.Content)...); err != nil {
			return err
		}
		created = true
		return nil
	})
	return created, err
}

// applySkillUpdate replaces one skill's content, keeping what it said before as a
// revision. It reports false when the skill changed, moved to another Space, or
// disappeared since the pass read it, so a person's edit is never overwritten.
func applySkillUpdate(ctx context.Context, database *db.DB, bot Bot, update skillUpdate) (bool, error) {
	applied := false
	err := database.System(ctx, "memory roamer upgrades a skill", func(tx pgx.Tx) error {
		var name, description, content string
		err := tx.QueryRow(ctx, `SELECT s.name, s.description, s.content FROM agent_skills s
			WHERE s.id = $1 AND s."userId" = $2 AND s."spaceId" = $3 AND s.source = 'user' AND NOT s."allSpaces"
				AND NOT EXISTS (SELECT 1 FROM agent_skill_spaces a WHERE a."skillId" = s.id)
			FOR UPDATE`, update.Current.ID, bot.UserID, bot.SpaceID).Scan(&name, &description, &content)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		if err != nil {
			return err
		}
		if content != update.Current.Content {
			return nil
		}
		if _, err := tx.Exec(ctx, `INSERT INTO agent_skill_revisions
				(id, "skillId", "userId", name, description, content, reason, "createdAt")
			VALUES ($1, $2, $3, $4, $5, $6, $7, now())`,
			db.Data(effects.NewID(), update.Current.ID, bot.UserID, name, description, content, skillRevisionReason)...); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `DELETE FROM agent_skill_revisions WHERE "skillId" = $1 AND id NOT IN (
				SELECT id FROM agent_skill_revisions WHERE "skillId" = $1
				ORDER BY "createdAt" DESC, id DESC LIMIT $2)`, update.Current.ID, skillRevisionsKept); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `UPDATE agent_skills SET content = $2, "updatedAt" = now() WHERE id = $1`,
			append([]any{update.Current.ID}, db.Data(update.Content)...)...); err != nil {
			return err
		}
		applied = true
		return nil
	})
	return applied, err
}
