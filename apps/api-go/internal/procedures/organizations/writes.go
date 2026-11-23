// organizations.members.setRole and organizations.invitations.cancel: the two organization
// writes whose only remaining side effect is publishOrganizationChange
// (apps/api/src/routes/organizations.ts:107-121,215-229 over
// packages/db/src/organization-members.ts:372-385,529-566).
//
// Both take the organization's membership lock first, so each check holds until the transaction
// commits, then record their audit event and tell every member their organization may have
// changed. Neither touches a secret, sends email, hands a Space over or syncs billing seats:
// members.remove and invitations.accept, which do, stay on TypeScript.
package organizations

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/effects"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/orpc"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/shared"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/validate"
)

var (
	errAdminRequired     = orpc.Forbidden("Only the organization's owner and admins can do that")
	errMemberMissing     = orpc.NotFound("Member not found")
	errOwnerUnchangeable = orpc.BadRequest("The organization's owner cannot be removed or given another role")
)

// lockMembers is lockOrganizationMembers: one transaction-scoped advisory lock per organization.
func lockMembers(ctx context.Context, tx pgx.Tx, organizationID string) error {
	// writeaudit:dynamic transaction-scoped advisory lock; no row payload
	_, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, "organization-members:"+organizationID)
	return err
}

// memberRole is memberRole: a full member of a live organization, else nothing.
func memberRole(ctx context.Context, tx pgx.Tx, organizationID, userID string) (string, error) {
	var storedRole string
	// writeaudit:dynamic read: live() is a fixed fragment; the arguments are filters
	err := tx.QueryRow(ctx, `SELECT m.role FROM member m
		WHERE m."organizationId" = $1 AND m."userId" = $2 AND m.role <> 'guest' AND `+live(`m."organizationId"`)+` LIMIT 1`,
		organizationID, userID).Scan(&storedRole)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	return shared.OrganizationRole(storedRole), nil
}

// requireManager is requireManager: a non-member sees the isolation error, a plain member is
// refused, and the owner or an admin may go on.
func requireManager(ctx context.Context, tx pgx.Tx, organizationID, userID string) error {
	role, err := memberRole(ctx, tx, organizationID, userID)
	if err != nil {
		return err
	}
	if role == "" {
		return shared.NotFound
	}
	if role == "member" {
		return errAdminRequired
	}
	return nil
}

type roleInput struct {
	OrganizationID string
	UserID         string
	Role           string
}

// parseRole is z.object({ organizationId: Id, userId: Id, role:
// OrganizationRoleSchema.exclude(["owner"]) }).
func parseRole(raw orpc.Input) (roleInput, *orpc.Error) {
	object, issues := validate.Decode(raw.Raw, nil)
	if issues != nil {
		return roleInput{}, validate.Fail(issues)
	}
	var found []validate.Issue
	organizationID, problems := validate.String(validate.Path{"organizationId"}, object.Field("organizationId"), validate.StringRules{Min: 1})
	found = append(found, problems...)
	userID, problems := validate.String(validate.Path{"userId"}, object.Field("userId"), validate.StringRules{Min: 1})
	found = append(found, problems...)
	role, problems := validate.Enum(validate.Path{"role"}, object.Field("role"), "admin", "member")
	found = append(found, problems...)
	if found != nil {
		return roleInput{}, validate.Fail(found)
	}
	return roleInput{OrganizationID: organizationID, UserID: userID, Role: role}, nil
}

// SetRole implements organizations.members.setRole: a manager changes someone's role (never the
// owner's); demoting to member withdraws that person's pending invitations.
func SetRole(ctx context.Context, database *db.DB, deployment shared.Deployment, audit *effects.Recorder, actor db.Actor, raw orpc.Input) (any, *orpc.Error) {
	input, failure := parseRole(raw)
	if failure != nil {
		return nil, failure
	}
	err := database.System(ctx, "change an organization member's role", func(tx pgx.Tx) error {
		if err := lockMembers(ctx, tx, input.OrganizationID); err != nil {
			return err
		}
		if err := requireManager(ctx, tx, input.OrganizationID, actor.UserID); err != nil {
			return err
		}
		target, err := memberRole(ctx, tx, input.OrganizationID, input.UserID)
		if err != nil {
			return err
		}
		if target == "" {
			return errMemberMissing
		}
		if target == "owner" {
			return errOwnerUnchangeable
		}
		if _, err := tx.Exec(ctx, `UPDATE member SET role = $3 WHERE "organizationId" = $1 AND "userId" = $2`,
			append([]any{input.OrganizationID, input.UserID}, db.Data(input.Role)...)...); err != nil {
			return err
		}
		if input.Role == "member" {
			return cancelInvitationsBy(ctx, tx, input.OrganizationID, input.UserID)
		}
		return nil
	})
	if err != nil {
		return nil, shared.Failure(err)
	}
	if audit != nil {
		audit.RecordAudit(ctx, effects.AuditEvent{
			Action: "organization.member.role_changed", ActorID: actor.UserID,
			OrganizationID: input.OrganizationID,
			TargetType:     "user", TargetID: input.UserID, TargetLabel: input.Role,
		})
	}
	if deployment.Signals != nil {
		deployment.Signals.PublishOrganization(input.OrganizationID)
	}
	return map[string]any{"ok": true}, nil
}

// cancelInvitationsBy is cancelInvitationsBy: whatever that person still has pending.
func cancelInvitationsBy(ctx context.Context, tx pgx.Tx, organizationID, inviterUserID string) error {
	_, err := tx.Exec(ctx, `UPDATE invitation SET status = 'canceled'
		WHERE "organizationId" = $1 AND "inviterId" = $2 AND status = 'pending'`, organizationID, inviterUserID)
	return err
}

type cancelInvitationInput struct{ OrganizationID, InvitationID string }

// parseCancelInvitation is z.object({ organizationId: Id, invitationId: Id }).
func parseCancelInvitation(raw orpc.Input) (cancelInvitationInput, *orpc.Error) {
	values, failure := shared.IDFields(raw, "organizationId", "invitationId")
	if failure != nil {
		return cancelInvitationInput{}, failure
	}
	return cancelInvitationInput{values["organizationId"], values["invitationId"]}, nil
}

// CancelInvitation implements organizations.invitations.cancel: a manager cancels a pending
// invitation; anything else changes nothing and is not recorded.
func CancelInvitation(ctx context.Context, database *db.DB, deployment shared.Deployment, audit *effects.Recorder, actor db.Actor, raw orpc.Input) (any, *orpc.Error) {
	input, failure := parseCancelInvitation(raw)
	if failure != nil {
		return nil, failure
	}
	var cancelled bool
	err := database.System(ctx, "cancel an organization invitation", func(tx pgx.Tx) error {
		if err := lockMembers(ctx, tx, input.OrganizationID); err != nil {
			return err
		}
		if err := requireManager(ctx, tx, input.OrganizationID, actor.UserID); err != nil {
			return err
		}
		tag, err := tx.Exec(ctx, `UPDATE invitation SET status = 'canceled'
			WHERE id = $1 AND "organizationId" = $2 AND status = 'pending'`,
			input.InvitationID, input.OrganizationID)
		if err != nil {
			return err
		}
		cancelled = tag.RowsAffected() > 0
		return nil
	})
	if err != nil {
		return nil, shared.Failure(err)
	}
	// Only a pending invitation of this organization's is recorded and announced.
	if cancelled {
		if audit != nil {
			audit.RecordAudit(ctx, effects.AuditEvent{
				Action: "organization.invitation.cancelled", ActorID: actor.UserID,
				OrganizationID: input.OrganizationID,
				TargetType:     "invitation", TargetID: input.InvitationID,
			})
		}
		if deployment.Signals != nil {
			deployment.Signals.PublishOrganization(input.OrganizationID)
		}
	}
	return map[string]any{"ok": true}, nil
}
