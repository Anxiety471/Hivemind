// Package agentskills ports agentSkills.list, agentSkills.get and agentSkills.remove
// (apps/api/src/routes/memory.ts:253 over apps/api/src/agent-skills.ts).
//
// create and update stay on TypeScript: they need YAML frontmatter parity with the
// `yaml` library (next-slices.md section 6). None of these procedures reads or writes an
// rkz1-encrypted column, runs an adapter or publishes a product event.
package agentskills

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/orpc"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/shared"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/validate"
)

// epoch is `new Date(0).toISOString()`, the times builtin skills carry.
const epoch = "1970-01-01T00:00:00.000Z"

var errIsolation = shared.NotFound

var errReadOnly = orpc.BadRequest("Builtin and plugin skills are read-only.")

// Availability is SpaceAvailabilitySchema.
type Availability struct {
	AllSpaces bool     `json:"allSpaces"`
	SpaceIDs  []string `json:"spaceIds"`
}

// Skill is AgentSkillSchema.
type Skill struct {
	ID           string        `json:"id"`
	Name         string        `json:"name"`
	Description  string        `json:"description"`
	Content      string        `json:"content"`
	Source       string        `json:"source"`
	ReadOnly     bool          `json:"readOnly"`
	Availability *Availability `json:"availability,omitempty"`
	CreatedAt    string        `json:"createdAt"`
	UpdatedAt    string        `json:"updatedAt"`
}

// CatalogEntry is AgentSkillCatalogEntrySchema: the list omits the content.
type CatalogEntry struct {
	ID           string        `json:"id"`
	Name         string        `json:"name"`
	Description  string        `json:"description"`
	Source       string        `json:"source"`
	ReadOnly     bool          `json:"readOnly"`
	Availability *Availability `json:"availability,omitempty"`
}

// asSource is asSource (agent-skills.ts:31): a source this build does not know reads as
// a user skill.
func asSource(value string) string {
	switch value {
	case "builtin", "plugin", "user":
		return value
	}
	return "user"
}

// isSkillReadOnly is isSkillReadOnly (packages/core/src/agent-skill.ts:64).
func isSkillReadOnly(source string) bool { return source == "builtin" || source == "plugin" }

// spaceAvailability is spaceAvailability (packages/db/src/availability.ts:29): the
// Spaces an item is available in, starting with the one it was added in.
func spaceAvailability(spaceID string, allSpaces bool, extra []string) *Availability {
	spaceIDs := []string{spaceID}
	for _, id := range extra {
		if id != spaceID {
			spaceIDs = append(spaceIDs, id)
		}
	}
	return &Availability{AllSpaces: allSpaces, SpaceIDs: spaceIDs}
}

func builtinCatalog() []Skill {
	catalog := make([]Skill, 0, len(builtinSkills))
	for _, skill := range builtinSkills {
		catalog = append(catalog, Skill{
			ID:          "builtin:" + skill.Name,
			Name:        skill.Name,
			Description: skill.Description,
			Content:     skill.Content,
			Source:      "builtin",
			ReadOnly:    true,
			CreatedAt:   epoch,
			UpdatedAt:   epoch,
		})
	}
	return catalog
}

// findSkillByName is findSkillByName (packages/core/src/agent-skill.ts:346): trimmed,
// case-insensitive on the full Unicode mapping.
func findSkillByName(skills []Skill, name string) *Skill {
	needle := shared.NormalizeEmail(name)
	if needle == "" {
		return nil
	}
	for index := range skills {
		if shared.NormalizeEmail(skills[index].Name) == needle {
			return &skills[index]
		}
	}
	return nil
}

// mergeBuiltinSkills is mergeBuiltinSkills (agent-skill.ts:339): the built-ins a user
// skill does not shadow, then the user's skills.
func mergeBuiltinSkills(builtins, userSkills []Skill) []Skill {
	merged := make([]Skill, 0, len(builtins)+len(userSkills))
	for _, builtin := range builtins {
		if findSkillByName(userSkills, builtin.Name) == nil {
			merged = append(merged, builtin)
		}
	}
	return append(merged, userSkills...)
}

type skillRow struct {
	ID          string
	SpaceID     string
	AllSpaces   bool
	Name        string
	Description string
	Content     string
	Source      string
	CreatedAt   time.Time
	UpdatedAt   time.Time
	extra       []string
}

func (row skillRow) skill() Skill {
	source := asSource(row.Source)
	return Skill{
		ID:           row.ID,
		Name:         row.Name,
		Description:  row.Description,
		Content:      row.Content,
		Source:       source,
		ReadOnly:     isSkillReadOnly(source),
		Availability: spaceAvailability(row.SpaceID, row.AllSpaces, row.extra),
		CreatedAt:    shared.ISO(row.CreatedAt),
		UpdatedAt:    shared.ISO(row.UpdatedAt),
	}
}

// availableInSpace is availableInSpace (packages/db/src/availability.ts:7): the user's
// own items, in this Space, in every Space, or listed for this Space.
const availableInSpace = `s."userId" = $1 AND (s."spaceId" = $2 OR s."allSpaces"
	OR EXISTS (SELECT 1 FROM agent_skill_spaces a WHERE a."skillId" = s.id AND a."spaceId" = $2))`

const skillColumns = `s.id, s."spaceId", s."allSpaces", s.name, s.description, s.content, s.source, s."createdAt", s."updatedAt"`

const skillOrder = ` ORDER BY s.name ASC, s.id ASC`

// loadAvailability reads the extra Spaces each skill is listed for. Prisma's relation
// loader returns them in the primary key's order (skillId, spaceId).
func loadAvailability(ctx context.Context, tx pgx.Tx, ids []string) (map[string][]string, error) {
	extra := map[string][]string{}
	if len(ids) == 0 {
		return extra, nil
	}
	rows, err := tx.Query(ctx, `SELECT "skillId", "spaceId" FROM agent_skill_spaces
		WHERE "skillId" = ANY($1) ORDER BY "skillId" ASC, "spaceId" ASC`, ids)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var skillID, spaceID string
		if err := rows.Scan(&skillID, &spaceID); err != nil {
			return nil, err
		}
		extra[skillID] = append(extra[skillID], spaceID)
	}
	return extra, rows.Err()
}

func scanSkill(row pgx.Row) (skillRow, error) {
	var skill skillRow
	err := row.Scan(&skill.ID, &skill.SpaceID, &skill.AllSpaces, &skill.Name, &skill.Description,
		&skill.Content, &skill.Source, &skill.CreatedAt, &skill.UpdatedAt)
	return skill, err
}

// listRows reads every skill the caller can use, with the Spaces each is listed for.
func listRows(ctx context.Context, tx pgx.Tx, actor db.Actor) ([]skillRow, error) {
	cursor, err := tx.Query(ctx, `SELECT `+skillColumns+` FROM agent_skills s WHERE `+availableInSpace+skillOrder,
		actor.UserID, actor.SpaceID)
	if err != nil {
		return nil, err
	}
	defer cursor.Close()
	rows := []skillRow{}
	for cursor.Next() {
		skill, err := scanSkill(cursor)
		if err != nil {
			return nil, err
		}
		rows = append(rows, skill)
	}
	if err := cursor.Err(); err != nil {
		return nil, err
	}
	ids := make([]string, 0, len(rows))
	for _, row := range rows {
		ids = append(ids, row.ID)
	}
	extra, err := loadAvailability(ctx, tx, ids)
	if err != nil {
		return nil, err
	}
	for index := range rows {
		rows[index].extra = extra[rows[index].ID]
	}
	return rows, nil
}

// List implements agentSkills.list: every skill the caller can use, the built-ins
// first, without their content.
func List(ctx context.Context, database *db.DB, actor db.Actor) (any, *orpc.Error) {
	var rows []skillRow
	err := database.Tenant(ctx, actor, func(tx pgx.Tx) error {
		found, err := listRows(ctx, tx, actor)
		rows = found
		return err
	})
	if err != nil {
		return nil, shared.Failure(err)
	}
	userSkills := make([]Skill, 0, len(rows))
	for _, row := range rows {
		userSkills = append(userSkills, row.skill())
	}
	merged := mergeBuiltinSkills(builtinCatalog(), userSkills)
	catalog := make([]CatalogEntry, 0, len(merged))
	for _, skill := range merged {
		catalog = append(catalog, CatalogEntry{
			ID: skill.ID, Name: skill.Name, Description: skill.Description,
			Source: skill.Source, ReadOnly: skill.ReadOnly, Availability: skill.Availability,
		})
	}
	return catalog, nil
}

// GetInput is agentSkills.get's input.
type GetInput struct {
	SkillID string
	Name    string
}

// ParseGet mirrors the skillId-or-name input, including its superRefine: both are
// optional strings, and at least one must name something. A type failure stops the
// refinement, as zod does.
func ParseGet(raw orpc.Input) (GetInput, *orpc.Error) {
	object, issues := validate.Decode(raw.Raw, nil)
	if issues != nil {
		return GetInput{}, validate.Fail(issues)
	}
	var input GetInput
	var found []validate.Issue
	aborted := false
	// The refinement sees the strings as sent, even when a length check failed on them.
	var skillIDText, nameText string
	if value, present := object.Get("skillId"); present {
		text, problems := validate.String(validate.Path{"skillId"}, value, validate.StringRules{Min: 1})
		if raw, ok := value.(string); ok {
			skillIDText = raw
		} else {
			aborted = true
		}
		input.SkillID = text
		found = append(found, problems...)
	}
	if value, present := object.Get("name"); present {
		text, problems := validate.String(validate.Path{"name"}, value, validate.StringRules{Min: 1, Max: 80})
		if raw, ok := value.(string); ok {
			nameText = raw
		} else {
			aborted = true
		}
		input.Name = text
		found = append(found, problems...)
	}
	if !aborted && skillIDText == "" && validate.JSTrim(nameText) == "" {
		found = append(found, validate.Issue{
			"code": "custom", "message": "Provide skillId or name", "path": []any{"skillId"},
		})
	}
	if found != nil {
		return GetInput{}, validate.Fail(found)
	}
	return input, nil
}

// builtinByID answers a `builtin:` id, or nil for any other id.
func builtinByID(skillID string) *Skill {
	if !strings.HasPrefix(skillID, "builtin:") {
		return nil
	}
	for _, skill := range builtinCatalog() {
		if skill.ID == skillID {
			return &skill
		}
	}
	return nil
}

// Get implements agentSkills.get: a built-in by `builtin:` id or by name, or one of
// the caller's own skills by id or name.
func Get(ctx context.Context, database *db.DB, actor db.Actor, raw orpc.Input) (any, *orpc.Error) {
	input, failure := ParseGet(raw)
	if failure != nil {
		return nil, failure
	}
	if builtin := builtinByID(input.SkillID); builtin != nil {
		return builtin, nil
	}
	var result Skill
	found := false
	err := database.Tenant(ctx, actor, func(tx pgx.Tx) error {
		if input.SkillID != "" {
			skill, err := scanSkill(tx.QueryRow(ctx, `SELECT `+skillColumns+` FROM agent_skills s
				WHERE s.id = $3 AND `+availableInSpace, actor.UserID, actor.SpaceID, input.SkillID))
			if errors.Is(err, pgx.ErrNoRows) {
				return nil
			}
			if err != nil {
				return err
			}
			extra, err := loadAvailability(ctx, tx, []string{skill.ID})
			if err != nil {
				return err
			}
			skill.extra = extra[skill.ID]
			result = skill.skill()
			found = true
			return nil
		}
		rows, err := listRows(ctx, tx, actor)
		if err != nil {
			return err
		}
		userSkills := make([]Skill, 0, len(rows))
		for _, row := range rows {
			userSkills = append(userSkills, row.skill())
		}
		if match := findSkillByName(userSkills, input.Name); match != nil {
			result = *match
			found = true
		}
		return nil
	})
	if err != nil {
		return nil, shared.Failure(err)
	}
	if found {
		return result, nil
	}
	if input.SkillID == "" {
		// A built-in can be named instead of addressed by id.
		if builtin := findSkillByName(builtinCatalog(), input.Name); builtin != nil {
			return *builtin, nil
		}
	}
	return nil, errIsolation
}

// parseSkillID mirrors z.object({ skillId: Id }).
func parseSkillID(raw orpc.Input) (string, *orpc.Error) {
	object, issues := validate.Decode(raw.Raw, nil)
	if issues != nil {
		return "", validate.Fail(issues)
	}
	skillID, problems := validate.String(validate.Path{"skillId"}, object.Field("skillId"), validate.StringRules{Min: 1})
	if problems != nil {
		return "", validate.Fail(problems)
	}
	return skillID, nil
}

// Remove implements agentSkills.remove: delete one of the caller's own user skills.
// Builtin and plugin skills, and rows a tampered source hides from the delete, are
// refused exactly as the TypeScript route refuses them.
func Remove(ctx context.Context, database *db.DB, actor db.Actor, raw orpc.Input) (any, *orpc.Error) {
	skillID, failure := parseSkillID(raw)
	if failure != nil {
		return nil, failure
	}
	err := database.Tenant(ctx, actor, func(tx pgx.Tx) error {
		var source string
		err := tx.QueryRow(ctx, `SELECT s.source FROM agent_skills s WHERE s.id = $3 AND `+availableInSpace,
			actor.UserID, actor.SpaceID, skillID).Scan(&source)
		if errors.Is(err, pgx.ErrNoRows) {
			return errIsolation
		}
		if err != nil {
			return err
		}
		if isSkillReadOnly(asSource(source)) {
			return errReadOnly
		}
		tag, err := tx.Exec(ctx, `DELETE FROM agent_skills s WHERE s.id = $3 AND s.source = 'user' AND `+availableInSpace,
			actor.UserID, actor.SpaceID, skillID)
		if err != nil {
			return err
		}
		if tag.RowsAffected() != 1 {
			return errIsolation
		}
		return nil
	})
	if err != nil {
		return nil, shared.Failure(err)
	}
	return map[string]any{"ok": true}, nil
}
