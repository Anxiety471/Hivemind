// Package artifactlist ports artifacts.list, listSpace and listVersions (routes/content.ts,
// artifacts.ts). They read the metadata columns of artifacts, a table the API's Prisma client
// has no hook on: the files themselves live in the artifact store and are never touched.
//
// The package is not called artifacts because the repository's .gitignore (line 34) ignores
// every path with that name; callers import it under that alias.
package artifactlist

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/orpc"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/shared"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/validate"
)

const (
	defaultSpaceLimit = 30
	maxSpaceLimit     = 60
	cursorPrefix      = "v1."
)

// stepScreenshotMimeTypes is STEP_SCREENSHOT_MIME_TYPES (packages/contracts/src/attachments.ts:27):
// the screenshots a reply keeps for its own later turns.
var stepScreenshotMimeTypes = []string{
	"image/jpeg;profile=step-screenshot",
	"image/png;profile=step-screenshot",
	"image/webp;profile=step-screenshot",
	"image/gif;profile=step-screenshot",
}

// hiddenMimeTypes is HIDDEN_ARTIFACT_MIME_TYPES (packages/db/src/artifact-versions.ts:10): an MCP
// app's HTML, kept for its chat card, and the step screenshots. Files people and bots see leave
// them out.
var hiddenMimeTypes = append([]string{"text/html;profile=mcp-app"}, stepScreenshotMimeTypes...)

// Artifact is the wire shape of ArtifactSchema.
type Artifact struct {
	ID          string  `json:"id"`
	BotID       *string `json:"botId"`
	GroupID     *string `json:"groupId"`
	RunID       *string `json:"runId"`
	Name        string  `json:"name"`
	Description *string `json:"description"`
	MimeType    string  `json:"mimeType"`
	Size        int32   `json:"size"`
	Version     int32   `json:"version"`
	CreatedAt   string  `json:"createdAt"`
}

// SpaceArtifact is ArtifactSchema.extend({ versionCount }): zod writes the added key last.
type SpaceArtifact struct {
	Artifact
	VersionCount int32 `json:"versionCount"`
}

// Version is the wire shape of ArtifactVersionSchema.
type Version struct {
	ID        string `json:"id"`
	Version   int32  `json:"version"`
	Name      string `json:"name"`
	CreatedAt string `json:"createdAt"`
}

// SpacePage is listSpace's output.
type SpacePage struct {
	Items      []SpaceArtifact `json:"items"`
	NextCursor *string         `json:"nextCursor"`
}

// invalid is whether the router would refuse the row against ArtifactSchema: its ids are Id
// (non-empty; runId has no foreign key to keep it so) and its times plain strings.
func (a Artifact) invalid() bool {
	empty := func(id *string) bool { return id != nil && *id == "" }
	return a.ID == "" || empty(a.BotID) || empty(a.GroupID) || empty(a.RunID)
}

func isoOf(at time.Time) string { return shared.ISOString(at) }

// parseList mirrors z.object({ botId: Id }), which ignores other keys.
func parseList(raw orpc.Input) (string, *orpc.Error) {
	object, issues := validate.Decode(raw.Raw, nil)
	if issues != nil {
		return "", validate.Fail(issues)
	}
	botID, issues := validate.String(validate.Path{"botId"}, object.Field("botId"), validate.StringRules{Min: 1})
	if issues != nil {
		return "", validate.Fail(issues)
	}
	return botID, nil
}

const artifactColumns = `id, "botId", "groupId", "runId", name, description, "mimeType", size, version, "createdAt"`

func scanArtifact(source pgx.Row) (Artifact, error) {
	var item Artifact
	var createdAt time.Time
	if err := source.Scan(&item.ID, &item.BotID, &item.GroupID, &item.RunID, &item.Name, &item.Description,
		&item.MimeType, &item.Size, &item.Version, &createdAt); err != nil {
		return Artifact{}, err
	}
	item.CreatedAt = isoOf(createdAt)
	return item, nil
}

// List implements artifacts.list: the files of one bot's own chat (not a group's), without the
// hidden types, in the order Postgres returns them (the API sets none).
func List(ctx context.Context, database *db.DB, actor db.Actor, raw orpc.Input) (any, *orpc.Error) {
	botID, failure := parseList(raw)
	if failure != nil {
		return nil, failure
	}
	items := []Artifact{}
	err := database.Tenant(ctx, actor, func(tx pgx.Tx) error {
		if err := shared.RequireBot(ctx, tx, actor, botID); err != nil {
			return err
		}
		rows, err := tx.Query(ctx, `SELECT `+artifactColumns+` FROM artifacts
			WHERE "botId" = $1 AND "groupId" IS NULL AND "spaceId" = $2 AND "trashedAt" IS NULL AND "mimeType" <> ALL($3)`,
			botID, actor.SpaceID, hiddenMimeTypes)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			item, err := scanArtifact(rows)
			if err != nil {
				return err
			}
			items = append(items, item)
		}
		return rows.Err()
	})
	if err != nil {
		return nil, shared.Failure(err)
	}
	for _, item := range items {
		if item.invalid() {
			return nil, shared.OutputInvalid()
		}
	}
	return items, nil
}

// SpaceInput is listSpace's validated input.
type SpaceInput struct {
	BotID      *string
	MadeByBots bool
	Cursor     string
	Limit      int
}

// parseSpace mirrors z.object({ botId: Id.optional(), madeByBots: z.boolean().optional(),
// cursor: z.string().optional(), limit: z.number().int().min(1).max(60).optional() }).
func parseSpace(raw orpc.Input) (SpaceInput, *orpc.Error) {
	input := SpaceInput{Limit: defaultSpaceLimit}
	object, issues := validate.Decode(raw.Raw, nil)
	if issues != nil {
		return input, validate.Fail(issues)
	}
	var found []validate.Issue
	if value := object.Field("botId"); value != validate.Undefined {
		text, problems := validate.String(validate.Path{"botId"}, value, validate.StringRules{Min: 1})
		found = append(found, problems...)
		input.BotID = &text
	}
	if value := object.Field("madeByBots"); value != validate.Undefined {
		flag, problems := validate.Boolean(validate.Path{"madeByBots"}, value)
		found = append(found, problems...)
		input.MadeByBots = flag
	}
	if value := object.Field("cursor"); value != validate.Undefined {
		text, problems := validate.String(validate.Path{"cursor"}, value, validate.StringRules{})
		found = append(found, problems...)
		input.Cursor = text
	}
	if value := object.Field("limit"); value != validate.Undefined {
		limit, problems := validate.Integer(validate.Path{"limit"}, value, validate.NumberRules{Min: validate.Float(1), Max: validate.Float(maxSpaceLimit)})
		found = append(found, problems...)
		input.Limit = int(limit)
	}
	if found != nil {
		return SpaceInput{}, validate.Fail(found)
	}
	return input, nil
}

// listCursor is the position of a page sequence: the last row returned, the scope the sequence
// started with, and asOf, which freezes the set of versions it walks.
type listCursor struct {
	CreatedAt  time.Time
	ID         string
	BotID      *string
	MadeByBots bool
	AsOf       time.Time
}

func badCursor() *orpc.Error { return orpc.BadRequest("Invalid artifact cursor") }

// encode is "v1." + base64url(JSON.stringify({ createdAt, id, botId, madeByBots, asOf })).
func (c listCursor) encode() (string, error) {
	body, err := orpc.Marshal(struct {
		CreatedAt  string  `json:"createdAt"`
		ID         string  `json:"id"`
		BotID      *string `json:"botId"`
		MadeByBots bool    `json:"madeByBots"`
		AsOf       string  `json:"asOf"`
	}{isoOf(c.CreatedAt), c.ID, c.BotID, c.MadeByBots, isoOf(c.AsOf)})
	if err != nil {
		return "", err
	}
	return cursorPrefix + base64.RawURLEncoding.EncodeToString(body), nil
}

// decodeCursor is decodeArtifactListCursor in artifacts.ts; every rejection is the same error.
func decodeCursor(value string) (listCursor, *orpc.Error) {
	var cursor listCursor
	if !strings.HasPrefix(value, cursorPrefix) {
		return cursor, badCursor()
	}
	// A map, not a struct: JSON.parse matches keys exactly, encoding/json ignores case.
	var record map[string]json.RawMessage
	if err := json.Unmarshal([]byte(shared.UTF8(shared.Base64URL(value[len(cursorPrefix):]))), &record); err != nil {
		return cursor, badCursor()
	}
	// typeof value === "string": a JSON null, which Unmarshal would leave as "", is not one.
	text := func(key string) (string, bool) {
		var out string
		raw := record[key]
		return out, string(raw) != "null" && json.Unmarshal(raw, &out) == nil
	}
	createdAt, ok := text("createdAt")
	if !ok {
		return cursor, badCursor()
	}
	if cursor.ID, ok = text("id"); !ok || cursor.ID == "" {
		return cursor, badCursor()
	}
	asOf, ok := text("asOf")
	if !ok {
		return cursor, badCursor()
	}
	switch botID, present := record["botId"]; {
	case present && string(botID) == "null":
	case present:
		var id string
		if json.Unmarshal(botID, &id) != nil {
			return cursor, badCursor()
		}
		cursor.BotID = &id
	default:
		return cursor, badCursor()
	}
	// madeByBots is record.madeByBots ?? false: absent and null read as false.
	if raw, present := record["madeByBots"]; present && string(raw) != "null" {
		if json.Unmarshal(raw, &cursor.MadeByBots) != nil {
			return cursor, badCursor()
		}
	}
	if cursor.CreatedAt, ok = shared.ParseDate(createdAt); !ok {
		return cursor, badCursor()
	}
	if cursor.AsOf, ok = shared.ParseDate(asOf); !ok {
		return cursor, badCursor()
	}
	return cursor, nil
}

// spaceRow is a row of listSpace's query: the newest version of a file and how many it has.
type spaceRow struct {
	familyID     string
	versionCount int32
	artifact     Artifact
	id           string
	createdAt    time.Time
}

// ListSpace implements artifacts.listSpace (listSpaceArtifacts): one entry per file family
// in the Space, newest version first by creation time, with versionCount. A cursor carries the
// time the sequence started, so files made while paging do not shift the pages.
func ListSpace(ctx context.Context, database *db.DB, actor db.Actor, raw orpc.Input) (any, *orpc.Error) {
	input, failure := parseSpace(raw)
	if failure != nil {
		return nil, failure
	}
	var rows []spaceRow
	var scope listCursor
	err := database.Tenant(ctx, actor, func(tx pgx.Tx) error {
		if input.BotID != nil {
			if err := shared.RequireBot(ctx, tx, actor, *input.BotID); err != nil {
				return err
			}
		}
		scope = listCursor{BotID: input.BotID, MadeByBots: input.MadeByBots, AsOf: time.Now().UTC().Truncate(time.Millisecond)}
		args := []any{actor.SpaceID}
		arg := func(value any) string {
			args = append(args, value)
			return "$" + strconv.Itoa(len(args))
		}
		botFilter, cursorFilter, madeByBotsFilter := "", "", ""
		if input.BotID != nil {
			botFilter = `AND "botId" = ` + arg(*input.BotID)
		}
		if input.MadeByBots {
			madeByBotsFilter = `AND latest."runId" IS NOT NULL`
		}
		var after *listCursor
		if input.Cursor != "" {
			decoded, failure := decodeCursor(input.Cursor)
			if failure != nil {
				return failure
			}
			if !sameScope(decoded.BotID, input.BotID) || decoded.MadeByBots != input.MadeByBots {
				return badCursor()
			}
			after = &decoded
			scope.AsOf = decoded.AsOf
		}
		asOf := arg(scope.AsOf)
		hidden := arg(hiddenMimeTypes)
		if after != nil {
			cursorFilter = `AND (latest."createdAt", latest.id) < (` + arg(after.CreatedAt) + `, ` + arg(after.ID) + `)`
		}
		result, err := tx.Query(ctx, `
			WITH scoped AS (
				SELECT * FROM "artifacts"
				WHERE "spaceId" = $1 `+botFilter+`
					AND "trashedAt" IS NULL AND "createdAt" <= `+asOf+` AND "mimeType" <> ALL(`+hidden+`)
			),
			latest AS (
				SELECT DISTINCT ON (COALESCE("rootArtifactId", id))
					id, "botId", "groupId", "runId", name, description, "mimeType", size, version, "createdAt", "rootArtifactId"
				FROM scoped
				ORDER BY COALESCE("rootArtifactId", id), version DESC
			),
			counts AS (
				SELECT COALESCE("rootArtifactId", id) AS "familyId", COUNT(*)::int AS "versionCount"
				FROM scoped
				GROUP BY COALESCE("rootArtifactId", id)
			)
			SELECT latest.id, COALESCE(latest."rootArtifactId", latest.id) AS "familyId",
				latest."botId", latest."groupId", latest."runId", latest.name,
				latest.description, latest."mimeType", latest.size, latest.version, latest."createdAt",
				counts."versionCount"
			FROM latest
			JOIN counts ON counts."familyId" = COALESCE(latest."rootArtifactId", latest.id)
			WHERE true `+madeByBotsFilter+` `+cursorFilter+`
			ORDER BY latest."createdAt" DESC, latest.id DESC
			LIMIT `+arg(input.Limit+1), args...)
		if err != nil {
			return err
		}
		defer result.Close()
		for result.Next() {
			var item spaceRow
			if err := result.Scan(&item.id, &item.familyID, &item.artifact.BotID, &item.artifact.GroupID, &item.artifact.RunID,
				&item.artifact.Name, &item.artifact.Description, &item.artifact.MimeType, &item.artifact.Size,
				&item.artifact.Version, &item.createdAt, &item.versionCount); err != nil {
				return err
			}
			item.artifact.ID = item.familyID
			item.artifact.CreatedAt = isoOf(item.createdAt)
			rows = append(rows, item)
		}
		return result.Err()
	})
	if err != nil {
		return nil, shared.Failure(err)
	}

	page := rows
	if len(page) > input.Limit {
		page = page[:input.Limit]
	}
	output := SpacePage{Items: []SpaceArtifact{}}
	for _, item := range page {
		// The router parses the output, which holds the page and not the extra row.
		if item.artifact.invalid() {
			return nil, shared.OutputInvalid()
		}
		output.Items = append(output.Items, SpaceArtifact{Artifact: item.artifact, VersionCount: item.versionCount})
	}
	if len(rows) > input.Limit && len(page) > 0 {
		last := page[len(page)-1]
		next, err := listCursor{CreatedAt: last.createdAt, ID: last.id, BotID: scope.BotID, MadeByBots: scope.MadeByBots, AsOf: scope.AsOf}.encode()
		if err != nil {
			return nil, orpc.Internal()
		}
		output.NextCursor = &next
	}
	return output, nil
}

func sameScope(left, right *string) bool {
	if left == nil || right == nil {
		return left == right
	}
	return *left == *right
}

// parseVersions mirrors z.object({ familyId: Id }).
func parseVersions(raw orpc.Input) (string, *orpc.Error) {
	object, issues := validate.Decode(raw.Raw, nil)
	if issues != nil {
		return "", validate.Fail(issues)
	}
	familyID, issues := validate.String(validate.Path{"familyId"}, object.Field("familyId"), validate.StringRules{Min: 1})
	if issues != nil {
		return "", validate.Fail(issues)
	}
	return familyID, nil
}

// ListVersions implements artifacts.listVersions (listArtifactVersions): every version of the
// file family the id belongs to (any version's id will do), newest first. Step screenshots are
// not files a person manages, so they anchor nothing; an MCP app's HTML does.
func ListVersions(ctx context.Context, database *db.DB, actor db.Actor, raw orpc.Input) (any, *orpc.Error) {
	familyID, failure := parseVersions(raw)
	if failure != nil {
		return nil, failure
	}
	versions := []Version{}
	err := database.Tenant(ctx, actor, func(tx pgx.Tx) error {
		var anchorID string
		var rootID *string
		err := tx.QueryRow(ctx, `SELECT id, "rootArtifactId" FROM artifacts WHERE id = $1 AND "spaceId" = $2 AND "trashedAt" IS NULL AND "mimeType" <> ALL($3)`,
			familyID, actor.SpaceID, stepScreenshotMimeTypes).Scan(&anchorID, &rootID)
		if errors.Is(err, pgx.ErrNoRows) {
			return shared.NotFound
		}
		if err != nil {
			return err
		}
		root := anchorID
		if rootID != nil {
			root = *rootID
		}
		rows, err := tx.Query(ctx, `SELECT id, version, name, "createdAt" FROM artifacts
			WHERE "spaceId" = $1 AND (id = $2 OR "rootArtifactId" = $2) ORDER BY version DESC`, actor.SpaceID, root)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var item Version
			var createdAt time.Time
			if err := rows.Scan(&item.ID, &item.Version, &item.Name, &createdAt); err != nil {
				return err
			}
			item.CreatedAt = isoOf(createdAt)
			versions = append(versions, item)
		}
		return rows.Err()
	})
	if err != nil {
		return nil, shared.Failure(err)
	}
	for _, item := range versions {
		if item.ID == "" {
			return nil, shared.OutputInvalid()
		}
	}
	return versions, nil
}
