package effects

import (
	"context"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/wtf8"
	"strings"
	"time"

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
	Metadata    []Meta
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
// (who may see the item's name, and which organizations receive the row).
// That branching is not ported; a procedure that records one is not served.
var vaultTargets = map[string]bool{"vault_credential": true, "bot_secret": true}

func (r *Recorder) recordAudit(ctx context.Context, event AuditEvent) error {
	if vaultTargets[event.TargetType] {
		return ErrUnsupportedAudit
	}
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
		var spaceOrg, spaceName *string
		if event.SpaceID != "" {
			var org, name string
			err := tx.QueryRow(ctx, `SELECT "organizationId", name FROM spaces WHERE id = $1`, event.SpaceID).Scan(&org, &name)
			if err == nil {
				spaceOrg, spaceName = &org, &name
			} else if err != pgx.ErrNoRows {
				return err
			}
		}
		var email *string
		var found string
		switch err := tx.QueryRow(ctx, `SELECT email FROM "user" WHERE id = $1`, event.ActorID).Scan(&found); err {
		case nil:
			email = &found
		case pgx.ErrNoRows:
		default:
			return err
		}
		// With a Space, the row goes to its organization. Without one, to every
		// organization the person belongs to as more than a guest.
		var organizations []string
		switch {
		case event.OrganizationID != "":
			organizations = []string{event.OrganizationID}
		case spaceOrg != nil:
			organizations = []string{*spaceOrg}
		case event.SpaceID == "":
			rows, err := tx.Query(ctx, `SELECT "organizationId" FROM member WHERE "userId" = $1 AND role <> 'guest'`, event.ActorID)
			if err != nil {
				return err
			}
			for rows.Next() {
				var organization string
				if err := rows.Scan(&organization); err != nil {
					rows.Close()
					return err
				}
				organizations = append(organizations, organization)
			}
			rows.Close()
			if err := rows.Err(); err != nil {
				return err
			}
		}
		for _, organization := range organizations {
			var actorLabel any
			if email != nil {
				actorLabel = bounded(*email, 200)
			}
			var name any
			if spaceName != nil {
				name = bounded(*spaceName, 200)
			}
			if _, err := tx.Exec(ctx, `INSERT INTO audit_events
				(id, "organizationId", "spaceId", "spaceName", "actorType", "actorId", "actorLabel", action,
				 "targetType", "targetId", "targetLabel", outcome, "runId", "threadId", ip, "userAgent", metadata, "createdAt")
				VALUES ($1, $2, $3, $4, 'user', $5, $6, $7, $8, $9, $10, 'success', NULL, NULL, $11, $12, $13::jsonb, $14)`,
				db.Data(NewID(), organization, nullable(bounded(event.SpaceID, 128)), name,
					nullable(bounded(event.ActorID, 128)), actorLabel, bounded(event.Action, 128),
					nullable(bounded(event.TargetType, 64)), nullable(bounded(event.TargetID, 200)),
					nullable(strings.ReplaceAll(bounded(event.TargetLabel, 200), "\x00", "\uFFFD")),
					nullable(bounded(caller.IP, 64)), nullable(bounded(caller.UserAgent, 512)),
					db.JSONText(string(body)),
					time.Now().UTC().Truncate(time.Millisecond))...); err != nil {
				return err
			}
		}
		return nil
	})
}
