package effects

import (
	"context"
	"encoding/json"
	"time"

	"github.com/jackc/pgx/v5"
)

// AuditEvent is an account's own action, appended to its organization's audit
// log (recordAuditEvent in audit-events.ts, for a user actor).
type AuditEvent struct {
	Action     string
	ActorID    string
	SpaceID    string
	TargetType string
	TargetID   string
	Metadata   []Meta
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
	body, err := json.Marshal(metadata)
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
				VALUES ($1, $2, $3, $4, 'user', $5, $6, $7, $8, $9, NULL, 'success', NULL, NULL, $10, $11, $12::jsonb, $13)`,
				NewID(), organization, nullable(bounded(event.SpaceID, 128)), name,
				nullable(bounded(event.ActorID, 128)), actorLabel, bounded(event.Action, 128),
				nullable(bounded(event.TargetType, 64)), nullable(bounded(event.TargetID, 200)),
				nullable(bounded(caller.IP, 64)), nullable(bounded(caller.UserAgent, 512)),
				string(body), time.Now().UTC().Truncate(time.Millisecond)); err != nil {
				return err
			}
		}
		return nil
	})
}
