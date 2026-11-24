// Package auditevents ports audit.events: one organization's audit log, newest first
// (apps/api/src/routes/account.ts:297-303 over packages/db/src/account/audit-events.ts:231-336).
//
// The listing runs as the system because the reader may be an admin of an organization the
// tenant context does not name. It never touches a secret or an encrypted model: audit_events is
// plain and its metadata is filtered key by key as it is read.
package auditevents

import (
	"context"
	"encoding/json"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/orpc"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/shared"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/validate"
)

var errForbidden = orpc.Forbidden("Forbidden")

// Event is AuditEventSchema (packages/contracts/src/account/audit-events.ts:18-42).
type Event struct {
	ID             string         `json:"id"`
	CreatedAt      string         `json:"createdAt"`
	OrganizationID string         `json:"organizationId"`
	SpaceID        *string        `json:"spaceId"`
	SpaceName      *string        `json:"spaceName"`
	ActorType      string         `json:"actorType"`
	ActorID        *string        `json:"actorId"`
	ActorLabel     *string        `json:"actorLabel"`
	Action         string         `json:"action"`
	TargetType     *string        `json:"targetType"`
	TargetID       *string        `json:"targetId"`
	TargetLabel    *string        `json:"targetLabel"`
	Outcome        string         `json:"outcome"`
	RunID          *string        `json:"runId"`
	ThreadID       *string        `json:"threadId"`
	IP             *string        `json:"ip"`
	UserAgent      *string        `json:"userAgent"`
	Metadata       map[string]any `json:"metadata"`
}

// Page is AuditEventPageSchema.
type Page struct {
	Events     []Event `json:"events"`
	NextCursor *string `json:"nextCursor"`
}

type filter struct {
	from, to, spaceID, actorID, action *string
	cursor                             *string
	limit                              int
}

// parse is AuditEventListInputSchema: five optional filters, cursor and a default limit of 100.
func parse(raw orpc.Input) (filter, *orpc.Error) {
	result := filter{limit: 100}
	object, issues := validate.Decode(raw.Raw, nil)
	if issues != nil {
		return result, validate.Fail(issues)
	}
	var found []validate.Issue
	optional := func(key string) *string {
		value := object.Field(key)
		if value == validate.Undefined {
			return nil
		}
		text, problems := validate.String(validate.Path{key}, value, validate.StringRules{Max: 128})
		found = append(found, problems...)
		if problems != nil {
			return nil
		}
		return &text
	}
	if value := object.Field("from"); value != validate.Undefined {
		text, problems := validate.ISODateTime(validate.Path{"from"}, value, false)
		found = append(found, problems...)
		if problems == nil {
			result.from = text
		}
	}
	if value := object.Field("to"); value != validate.Undefined {
		text, problems := validate.ISODateTime(validate.Path{"to"}, value, false)
		found = append(found, problems...)
		if problems == nil {
			result.to = text
		}
	}
	result.spaceID = optional("spaceId")
	result.actorID = optional("actorId")
	result.action = optional("action")
	result.cursor = optional("cursor")
	if value := object.Field("limit"); value != validate.Undefined {
		number, problems := validate.Integer(validate.Path{"limit"}, value, validate.NumberRules{Min: validate.Float(1), Max: validate.Float(500)})
		found = append(found, problems...)
		if problems == nil {
			result.limit = int(number)
		}
	}
	if found != nil {
		return result, validate.Fail(found)
	}
	return result, nil
}

// access is auditLogAccess: the organization whose log the actor may read, and whether they read
// only their own events (a full member) or everyone's (an owner or admin).
func access(ctx context.Context, tx pgx.Tx, actor db.Actor) (organizationID string, onlyActor *string, failure *orpc.Error) {
	var role string
	err := tx.QueryRow(ctx, `SELECT m."organizationId", m.role FROM member m
		WHERE m."userId" = $1 AND m.role <> $2
			AND EXISTS (SELECT 1 FROM spaces s WHERE s."organizationId" = m."organizationId" AND s.id = $3)
		LIMIT 1`, actor.UserID, shared.GuestRole, actor.SpaceID).Scan(&organizationID, &role)
	if err == pgx.ErrNoRows {
		return "", nil, errForbidden
	}
	if err != nil {
		return "", nil, shared.Failure(err)
	}
	if shared.OrganizationRole(role) == "member" {
		user := actor.UserID
		return organizationID, &user, nil
	}
	return organizationID, nil, nil
}

// List implements audit.events.
func List(ctx context.Context, database *db.DB, actor db.Actor, raw orpc.Input) (any, *orpc.Error) {
	input, failure := parse(raw)
	if failure != nil {
		return nil, failure
	}
	result := Page{Events: []Event{}}
	err := database.System(ctx, "read the organization's audit log", func(tx pgx.Tx) error {
		organizationID, onlyActor, failure := access(ctx, tx, actor)
		if failure != nil {
			return failure
		}
		// A full member reads only their own events, whatever filter they asked for: the caller's
		// actorId replaces it (auditLogScope).
		if onlyActor != nil {
			input.actorID = onlyActor
		}
		var after time.Time
		var afterID string
		hasAfter := false
		if input.cursor != nil && *input.cursor != "" {
			err := tx.QueryRow(ctx, `SELECT id, "createdAt" FROM audit_events
				WHERE id = $1 AND "organizationId" = $2`, *input.cursor, organizationID).Scan(&afterID, &after)
			if err == pgx.ErrNoRows {
				return nil
			}
			if err != nil {
				return err
			}
			hasAfter = true
		}
		where := `"organizationId" = $1`
		args := []any{organizationID}
		add := func(clause string, value any) {
			args = append(args, value)
			where += " AND " + clause + " = $" + itoa(len(args))
		}
		if input.spaceID != nil && *input.spaceID != "" {
			add(`"spaceId"`, *input.spaceID)
		}
		if input.actorID != nil && *input.actorID != "" {
			add(`"actorId"`, *input.actorID)
		}
		if input.action != nil && *input.action != "" {
			add("action", *input.action)
		}
		if input.from != nil {
			at, err := instant(*input.from)
			if err != nil {
				return err
			}
			// new Date(text) is an absolute instant truncated to milliseconds; TIMESTAMP(3) has
			// no zone, so bind the UTC wall clock at the same precision.
			args = append(args, at.UTC().Truncate(time.Millisecond))
			where += " AND \"createdAt\" >= $" + itoa(len(args))
		}
		if input.to != nil {
			at, err := instant(*input.to)
			if err != nil {
				return err
			}
			args = append(args, at.UTC().Truncate(time.Millisecond))
			where += " AND \"createdAt\" < $" + itoa(len(args))
		}
		if hasAfter {
			args = append(args, after, afterID)
			where += " AND (\"createdAt\" < $" + itoa(len(args)-1) + ` OR ("createdAt" = $` + itoa(len(args)-1) + ` AND id < $` + itoa(len(args)) + "))"
		}
		args = append(args, input.limit+1)
		// writeaudit:dynamic read: the WHERE clause is built from fixed fragments; args are filters
		rows, err := tx.Query(ctx, `SELECT id, "spaceId", "spaceName", "actorType", "actorId", "actorLabel",
			action, "targetType", "targetId", "targetLabel", outcome, "runId", "threadId", ip, "userAgent",
			metadata, "createdAt" FROM audit_events WHERE `+where+`
			ORDER BY "createdAt" DESC, id DESC LIMIT $`+itoa(len(args)), args...)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			event, err := scan(rows, organizationID)
			if err != nil {
				return err
			}
			result.Events = append(result.Events, event)
		}
		if err := rows.Err(); err != nil {
			return err
		}
		if len(result.Events) > input.limit {
			result.Events = result.Events[:input.limit]
			last := result.Events[len(result.Events)-1].ID
			result.NextCursor = &last
		}
		return nil
	})
	if err != nil {
		return nil, shared.Failure(err)
	}
	return result, nil
}

func scan(row pgx.Row, organizationID string) (Event, error) {
	var value Event
	var createdAt time.Time
	var rawMetadata json.RawMessage
	err := row.Scan(&value.ID, &value.SpaceID, &value.SpaceName, &value.ActorType, &value.ActorID,
		&value.ActorLabel, &value.Action, &value.TargetType, &value.TargetID, &value.TargetLabel,
		&value.Outcome, &value.RunID, &value.ThreadID, &value.IP, &value.UserAgent,
		&rawMetadata, &createdAt)
	if err != nil {
		return Event{}, err
	}
	value.CreatedAt = shared.ISO(createdAt)
	value.OrganizationID = organizationID
	value.ActorType = actorType(value.ActorType)
	value.Outcome = outcome(value.Outcome)
	value.Metadata = metadata(rawMetadata)
	return value, nil
}

// actorType is AuditActorTypeSchema.catch("system").parse(value): an unknown stored value reads as
// a system event.
func actorType(value string) string {
	switch value {
	case "user", "bot", "system":
		return value
	}
	return "system"
}

// outcome is AuditOutcomeSchema.catch("success").parse(value).
func outcome(value string) string {
	switch value {
	case "success", "failure", "denied":
		return value
	}
	return "success"
}

// metadata is storedAuditMetadata: a stored object's keys with a scalar value are kept one by one;
// a value in another shape (an object, a list) is dropped without blanking the rest, and a column
// that is not an object reads as empty.
func metadata(raw json.RawMessage) map[string]any {
	kept := map[string]any{}
	var value any
	if len(raw) > 0 {
		_ = json.Unmarshal(raw, &value)
	}
	object, ok := value.(map[string]any)
	if !ok {
		return kept
	}
	for key, item := range object {
		switch typed := item.(type) {
		case string, bool, nil, float64, json.Number:
			kept[key] = typed
		}
	}
	return kept
}

// instant is `new Date(text)` for an ISO datetime validate already accepted.
func instant(text string) (time.Time, error) {
	return time.Parse(time.RFC3339Nano, text)
}

func itoa(value int) string {
	return strconv.Itoa(value)
}
