package effects

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/wtf8"

	"github.com/jackc/pgx/v5"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
)

// AuditEvent is an account's own action, appended to its organization's audit
// log (recordAuditEvent in audit-events.ts, for a user actor).
type AuditEvent struct {
	Action  string
	ActorID string
	SpaceID string
	// OrganizationID names the organization that owns the event when no Space does
	// (an organization's own rename); without it and without a Space the row goes to
	// every organization the actor belongs to.
	OrganizationID string
	TargetType     string
	TargetID       string
	// TargetLabel is shown beside the target; free text, stored as typed (NUL replaced).
	TargetLabel string
	// UserID is the person whose vault holds the item the event names, for a vault target
	// (audit-events.ts:140-144); it decides whether the event may name the item.
	UserID   string
	Metadata []Meta
}

// RecordAudit is recordAuditEvent: it appends the event and never fails the caller,
// since the action already happened. A failed write is logged with the event.
func (r *Recorder) RecordAudit(ctx context.Context, event AuditEvent) {
	// An aborted request still records what it did.
	ctx = context.WithoutCancel(ctx)
	if err := r.recordAudit(ctx, event); err != nil {
		r.logger.Error("audit.event.write_failed", "audit.event.action", event.Action, "audit.event.actor", "user:"+event.ActorID,
			"audit.event.target", event.TargetType+":"+event.TargetID, "error", err)
	}
}

// Targets whose events follow the vault-visibility rules in audit-events.ts
// (auditRows, :100-235): who may see the item's name, and which organizations receive the row.
var vaultTargets = map[string]bool{"vault_credential": true, "bot_secret": true}

// withheldMetadataKeys are the only metadata keys a row withheld from an outsider keeps.
var withheldMetadataKeys = map[string]bool{"procedure": true, "kind": true, "scope": true, "tool": true}

// auditRow is one row auditRows produces; the fields every row shares are added at insert.
type auditRow struct {
	organizationID string
	spaceName      any
	targetLabel    any
	metadata       string
	createdAt      time.Time
	sharedTime     bool
}

func (r *Recorder) recordAudit(ctx context.Context, event AuditEvent) error {
	caller, _ := CallerFrom(ctx)
	metadata, err := securityEventMetadata(event.Metadata)
	if err != nil {
		return err
	}
	body, err := wtf8.Marshal(metadata)
	if err != nil {
		return err
	}
	return r.db.System(ctx, "append an audit event", func(tx pgx.Tx) error {
		rows, err := auditRows(ctx, tx, event, caller, metadata, string(body))
		if err != nil {
			return err
		}
		for _, row := range rows {
			createdAt := time.Now().UTC().Truncate(time.Millisecond)
			if row.sharedTime {
				createdAt = row.createdAt
			}
			if _, err := tx.Exec(ctx, `INSERT INTO audit_events
				(id, "organizationId", "spaceId", "spaceName", "actorType", "actorId", "actorLabel", action,
				 "targetType", "targetId", "targetLabel", outcome, "runId", "threadId", ip, "userAgent", metadata, "createdAt")
				VALUES ($1, $2, $3, $4, 'user', $5, $6, $7, $8, $9, $10, 'success', NULL, NULL, $11, $12, $13::jsonb, $14)`,
				db.Data(NewID(), row.organizationID, nullable(bounded(event.SpaceID, 128)), row.spaceName,
					nullable(bounded(event.ActorID, 128)), actorLabelOf(ctx, tx, event.ActorID),
					bounded(event.Action, 128),
					nullable(bounded(event.TargetType, 64)), nullable(bounded(event.TargetID, 200)),
					row.targetLabel,
					nullable(bounded(caller.IP, 64)), nullable(bounded(caller.UserAgent, 512)),
					db.JSONText(row.metadata), createdAt)...); err != nil {
				return err
			}
		}
		return nil
	})
}

// guestRole is GUEST_ROLE (packages/db/src/billing/billing.ts:444): a member who belongs to
// an organization only through Spaces they were invited to.
const guestRole = "guest"

// ownedOrganizationID is ownedOrganizationId (billing.ts:447-462): the oldest live
// organization the user owns, or "" when they own none.
func ownedOrganizationID(ctx context.Context, tx pgx.Tx, userID string) (string, error) {
	// writeaudit:dynamic read: the EXISTS is a fixed fragment; the argument is a filter
	rows, err := tx.Query(ctx, `SELECT m."organizationId", m.role FROM member m
		WHERE m."userId" = $1 AND EXISTS (
			SELECT 1 FROM spaces s WHERE s."organizationId" = m."organizationId"
				AND s."isDefault" AND s."deletingAt" IS NULL)
		ORDER BY m."createdAt" ASC`, userID)
	if err != nil {
		return "", err
	}
	defer rows.Close()
	for rows.Next() {
		var organization, role string
		if err := rows.Scan(&organization, &role); err != nil {
			return "", err
		}
		if isOwnerRole(role) {
			return organization, nil
		}
	}
	if err := rows.Err(); err != nil {
		return "", err
	}
	return "", nil
}

// isOwnerRole is isOwnerRole: a member row whose role list includes "owner".
func isOwnerRole(role string) bool {
	for _, value := range strings.Split(role, ",") {
		if strings.TrimSpace(value) == "owner" {
			return true
		}
	}
	return false
}

// actorLabelOf is the actor's email; one row's actor never changes, so it is looked up once.
func actorLabelOf(ctx context.Context, tx pgx.Tx, actorID string) any {
	if actorID == "" {
		return nil
	}
	var email string
	switch err := tx.QueryRow(ctx, `SELECT email FROM "user" WHERE id = $1`, actorID).Scan(&email); {
	case err == nil:
		return bounded(email, 200)
	case errors.Is(err, pgx.ErrNoRows):
		return nil
	default:
		return nil
	}
}

// auditRows is auditRows (audit-events.ts:100-235): where an event lands and what it says there.
func auditRows(
	ctx context.Context,
	tx pgx.Tx,
	event AuditEvent,
	caller Caller,
	metadata map[string]any,
	body string,
) ([]auditRow, error) {
	var spaceOrg, spaceName string
	hasSpace := false
	if event.SpaceID != "" {
		switch err := tx.QueryRow(ctx, `SELECT "organizationId", name FROM spaces WHERE id = $1`,
			event.SpaceID).Scan(&spaceOrg, &spaceName); {
		case err == nil:
			hasSpace = true
		case errors.Is(err, pgx.ErrNoRows):
		default:
			return nil, err
		}
	}
	// The person the event is about: the acting user, or a user something was done to.
	personID := event.ActorID
	// The person whose vault holds the item, when the event is about one.
	owner := ""
	if vaultTargets[event.TargetType] && event.OrganizationID == "" {
		owner = event.UserID
		if owner == "" {
			owner = personID
		}
	}
	// Only an account vault item is its person's own, to follow them to their own organization.
	scope, _ := metadata["scope"].(string)
	ownItem := owner != "" && scope == "account"
	// Whether that person is only a guest of the space's organization, or no longer in it.
	outsider := false
	if hasSpace && owner != "" {
		var role string
		switch err := tx.QueryRow(ctx, `SELECT role FROM member
			WHERE "organizationId" = $1 AND "userId" = $2`, spaceOrg, owner).Scan(&role); {
		case errors.Is(err, pgx.ErrNoRows):
			outsider = true
		case err != nil:
			return nil, err
		default:
			outsider = role == guestRole
		}
	}
	// Their own organization, computed only for an account vault item. Every event this port
	// records has a user actor, so an own item always follows its person.
	personal := ""
	if owner != "" && ownItem {
		personal, _ = ownedOrganizationID(ctx, tx, owner)
	}
	type landing struct {
		organization string
		withheld     bool
		personal     bool
	}
	var landings []landing
	switch {
	case event.OrganizationID != "":
		landings = []landing{{organization: event.OrganizationID}}
	case hasSpace:
		// Their own action on an account vault item happened in no space, so it is theirs alone.
		ownTrail := personal != ""
		if !ownTrail {
			landings = append(landings, landing{
				organization: spaceOrg,
				withheld:     outsider || ownItem,
			})
		}
		if personal != "" {
			landings = append(landings, landing{organization: personal, personal: true})
		}
	case personID != "":
		// A guest's own account events are not the business of the organizations that invited them.
		rows, err := tx.Query(ctx, `SELECT "organizationId" FROM member
			WHERE "userId" = $1 AND role <> $2`, personID, guestRole)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		for rows.Next() {
			var organization string
			if err := rows.Scan(&organization); err != nil {
				return nil, err
			}
			landings = append(landings, landing{organization: organization})
		}
		if err := rows.Err(); err != nil {
			return nil, err
		}
	}
	var label any
	if event.TargetLabel != "" {
		label = bounded(strings.ReplaceAll(bounded(event.TargetLabel, 200), "\x00", "\uFFFD"), 200)
	}
	var space any
	if spaceName != "" {
		space = bounded(spaceName, 200)
	}
	withheldBody := body
	if owner != "" {
		filtered := make([]Meta, 0, len(event.Metadata))
		for _, entry := range event.Metadata {
			if withheldMetadataKeys[entry.Key] {
				filtered = append(filtered, entry)
			}
		}
		kept, err := securityEventMetadata(filtered)
		if err != nil {
			return nil, err
		}
		withheld, err := wtf8.Marshal(kept)
		if err != nil {
			return nil, err
		}
		withheldBody = string(withheld)
	}
	shared := owner != "" && len(landings) > 1
	sharedAt := time.Now().UTC().Truncate(time.Millisecond)
	out := make([]auditRow, 0, len(landings))
	for _, place := range landings {
		// The shared space's name is its organization's; the person's own keeps only its id.
		rowSpace := space
		if place.personal {
			rowSpace = nil
		}
		if place.withheld {
			out = append(out, auditRow{organizationID: place.organization, spaceName: rowSpace,
				targetLabel: nil, metadata: withheldBody, createdAt: sharedAt, sharedTime: shared})
			continue
		}
		out = append(out, auditRow{organizationID: place.organization, spaceName: rowSpace,
			targetLabel: label, metadata: body, createdAt: sharedAt, sharedTime: shared})
	}
	return out, nil
}
