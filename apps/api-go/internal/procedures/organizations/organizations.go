// Package organizations ports the organization procedures that touch only the database:
// organizations.list|rename, members.list and invitations.preview
// (apps/api/src/routes/organizations.ts over packages/db/src/organizations.ts and
// organization-members.ts).
//
// create seeds an encrypted memory document, remove runs account-deletion teardown,
// members.setRole|remove and invitations.cancel publish organization changes (a product
// event Go has no publisher for), invitations.create sends email, and invitations.accept
// syncs billing seats: all stay on TypeScript.
package organizations

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/effects"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/orpc"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/shared"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/validate"
)

// maxOrganizationNameLength is the length normalizeSpaceName allows, in UTF-16 units.
const maxOrganizationNameLength = 60

var (
	errInvalidName        = orpc.BadRequest("Organization name must be readable and between 1 and 60 characters")
	errInvitationNotFound = orpc.NotFound("This invitation is invalid or has expired")
	errInvitationMismatch = orpc.New("INVITATION_EMAIL_MISMATCH", 403, "Sign in with the email address this invitation was sent to")
	errEmailNotVerified   = orpc.New("EMAIL_NOT_VERIFIED", 403, "Verify your email address to accept this invitation")
)

// live is LIVE_ORGANIZATION for the organization id the SQL expression names.
func live(organization string) string {
	return `EXISTS (SELECT 1 FROM spaces ls WHERE ls."organizationId" = ` + organization + ` AND ls."isDefault" AND ls."deletingAt" IS NULL)`
}

func now() time.Time { return time.Now().UTC().Truncate(time.Millisecond) }

// homeOrganizationID is homeOrganizationId: the member's own organization, plus none
// from someone else's: for a guest in the current Space, their oldest own organization.
func homeOrganizationID(ctx context.Context, tx pgx.Tx, actor db.Actor) (string, error) {
	var organization, role string
	err := tx.QueryRow(ctx, `SELECT sm."organizationId", m.role FROM space_members sm
		JOIN member m ON m."organizationId" = sm."organizationId" AND m."userId" = sm."userId"
		WHERE sm."spaceId" = $1 AND sm."userId" = $2`, actor.SpaceID, actor.UserID).Scan(&organization, &role)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", shared.NotFound
	}
	if err != nil {
		return "", err
	}
	if role != shared.GuestRole {
		return organization, nil
	}
	return ownedOrganizationID(ctx, tx, actor.UserID)
}

// ownedOrganizationID is ownedOrganizationId: the oldest live organization the user owns.
func ownedOrganizationID(ctx context.Context, tx pgx.Tx, userID string) (string, error) {
	rows, err := tx.Query(ctx, `SELECT m."organizationId", m.role FROM member m
		WHERE m."userId" = $1 AND `+live(`m."organizationId"`)+` ORDER BY m."createdAt" ASC`, userID)
	if err != nil {
		return "", err
	}
	defer rows.Close()
	for rows.Next() {
		var organization, role string
		if err := rows.Scan(&organization, &role); err != nil {
			return "", err
		}
		if shared.IsOwnerRole(role) {
			return organization, nil
		}
	}
	if err := rows.Err(); err != nil {
		return "", err
	}
	return "", shared.NotFound
}

// Listed is one organization of OrganizationListSchema.
type Listed struct {
	ID             string   `json:"id"`
	Name           string   `json:"name"`
	DefaultSpaceID string   `json:"defaultSpaceId"`
	CanManage      bool     `json:"canManage"`
	Role           string   `json:"role"`
	MemberCount    int      `json:"memberCount"`
	SpaceIDs       []string `json:"spaceIds"`
}

// List is OrganizationListSchema.
type List struct {
	ActiveOrganizationID string   `json:"activeOrganizationId"`
	Organizations        []Listed `json:"organizations"`
}

type membership struct {
	SpaceID, OrganizationID, Role, MemberRole string
}

// ListMine implements organizations.list: every organization the user belongs to as more
// than a guest, with the Spaces shared with them beside the active organization's.
func ListMine(ctx context.Context, database *db.DB, actor db.Actor) (any, *orpc.Error) {
	result := List{Organizations: []Listed{}}
	err := database.System(ctx, "list the organizations a user belongs to", func(tx pgx.Tx) error {
		active, err := homeOrganizationID(ctx, tx, actor)
		if err != nil {
			return err
		}
		result.ActiveOrganizationID = active
		type row struct {
			id, name, defaultSpace, role string
			members                      int
		}
		rows, err := tx.Query(ctx, `SELECT o.id, o.name,
				(SELECT s.id FROM spaces s WHERE s."organizationId" = o.id AND s."isDefault" LIMIT 1),
				(SELECT m.role FROM member m WHERE m."organizationId" = o.id AND m."userId" = $1 LIMIT 1),
				(SELECT count(*) FROM member m WHERE m."organizationId" = o.id AND m.role <> 'guest')
			FROM organization o
			WHERE EXISTS (SELECT 1 FROM member mm WHERE mm."organizationId" = o.id AND mm."userId" = $1 AND mm.role <> 'guest')
				AND `+live("o.id")+`
			ORDER BY o."createdAt" ASC, o.id ASC`, actor.UserID)
		if err != nil {
			return err
		}
		var organizations []row
		for rows.Next() {
			var found row
			var role *string
			if err := rows.Scan(&found.id, &found.name, &found.defaultSpace, &role, &found.members); err != nil {
				rows.Close()
				return err
			}
			found.role = "member"
			if role != nil {
				found.role = *role
			}
			organizations = append(organizations, found)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}
		memberRows, err := tx.Query(ctx, `SELECT sm."spaceId", sm."organizationId", sm.role, m.role
			FROM space_members sm
			JOIN member m ON m."organizationId" = sm."organizationId" AND m."userId" = sm."userId"
			JOIN spaces s ON s.id = sm."spaceId"
			WHERE sm."userId" = $1 AND s."deletingAt" IS NULL
			ORDER BY sm."createdAt" ASC, sm.id ASC`, actor.UserID)
		if err != nil {
			return err
		}
		var memberships []membership
		for memberRows.Next() {
			var found membership
			if err := memberRows.Scan(&found.SpaceID, &found.OrganizationID, &found.Role, &found.MemberRole); err != nil {
				memberRows.Close()
				return err
			}
			memberships = append(memberships, found)
		}
		memberRows.Close()
		if err := memberRows.Err(); err != nil {
			return err
		}
		for _, organization := range organizations {
			var own []membership
			for _, found := range memberships {
				if found.OrganizationID == organization.id {
					own = append(own, found)
				}
			}
			role := shared.OrganizationRole(organization.role)
			defaultSpace := organization.defaultSpace
			switch {
			case hasSpace(own, organization.defaultSpace):
			case firstOwned(own) != "":
				defaultSpace = firstOwned(own)
			case len(own) > 0:
				defaultSpace = own[0].SpaceID
			}
			// Spaces shared with them as a guest show beside the active organization's.
			spaceIDs := []string{}
			for _, found := range memberships {
				if found.MemberRole == shared.GuestRole {
					if organization.id == active {
						spaceIDs = append(spaceIDs, found.SpaceID)
					}
				} else if found.OrganizationID == organization.id {
					spaceIDs = append(spaceIDs, found.SpaceID)
				}
			}
			result.Organizations = append(result.Organizations, Listed{
				ID: organization.id, Name: organization.name, DefaultSpaceID: defaultSpace, SpaceIDs: spaceIDs,
				CanManage: role == "owner", Role: role, MemberCount: organization.members,
			})
		}
		return nil
	})
	if err != nil {
		return nil, shared.Failure(err)
	}
	return result, nil
}

func hasSpace(memberships []membership, spaceID string) bool {
	for _, found := range memberships {
		if found.SpaceID == spaceID {
			return true
		}
	}
	return false
}

func firstOwned(memberships []membership) string {
	for _, found := range memberships {
		if shared.IsOwnerRole(found.Role) {
			return found.SpaceID
		}
	}
	return ""
}

// Renamed is organizations.rename's output. The name is echoed as typed (trimmed), not as stored.
type Renamed struct {
	ID   string `json:"id"`
	Name any    `json:"name"`
}

// parseRename mirrors z.object({ organizationId: Id, name: z.string().trim().min(1).max(60) }).
func parseRename(raw orpc.Input) (string, string, *orpc.Error) {
	object, issues := validate.Decode(raw.Raw, nil)
	if issues != nil {
		return "", "", validate.Fail(issues)
	}
	var found []validate.Issue
	id, problems := validate.String(validate.Path{"organizationId"}, object.Field("organizationId"), validate.StringRules{Min: 1})
	found = append(found, problems...)
	name, problems := validate.String(validate.Path{"name"}, object.Field("name"), validate.StringRules{Trim: true, Min: 1, Max: maxOrganizationNameLength})
	found = append(found, problems...)
	if found != nil {
		return "", "", validate.Fail(found)
	}
	return id, name, nil
}

// Rename implements organizations.rename: only the owner of a live organization renames it.
func Rename(ctx context.Context, database *db.DB, audit *effects.Recorder, actor db.Actor, raw orpc.Input) (any, *orpc.Error) {
	organizationID, name, failure := parseRename(raw)
	if failure != nil {
		return nil, failure
	}
	// normalizeSpaceName: readable, at most 60 UTF-16 units once trimmed.
	trimmed := validate.JSTrim(name)
	if shared.DisplayName(&trimmed, "") == "" || shared.UTF16Length(trimmed) > maxOrganizationNameLength {
		return nil, errInvalidName
	}
	err := database.System(ctx, "rename an organization for its owner", func(tx pgx.Tx) error {
		renamed, err := tx.Exec(ctx, `UPDATE organization SET name = $1
			WHERE id = $2 AND EXISTS (SELECT 1 FROM member m WHERE m."organizationId" = organization.id AND m."userId" = $3 AND m.role LIKE '%owner%')
				AND `+live("organization.id"), shared.StoredText(trimmed), organizationID, actor.UserID)
		if err != nil {
			return err
		}
		if renamed.RowsAffected() == 0 {
			return shared.NotFound
		}
		return nil
	})
	if err != nil {
		return nil, shared.Failure(err)
	}
	audit.RecordAudit(ctx, effects.AuditEvent{
		Action: "organization.renamed", ActorID: actor.UserID, OrganizationID: organizationID,
		TargetType: "organization", TargetID: organizationID, TargetLabel: trimmed,
	})
	var echoed any = trimmed
	if exact, unpaired := shared.EchoText(raw.Raw, "name"); unpaired {
		echoed = exact
	}
	return Renamed{ID: organizationID, Name: echoed}, nil
}

// Member is OrganizationMemberSchema.
type Member struct {
	UserID         string  `json:"userId"`
	Name           string  `json:"name"`
	Email          string  `json:"email"`
	Image          *string `json:"image"`
	Role           string  `json:"role"`
	Manageable     bool    `json:"manageable"`
	RoleChangeable bool    `json:"roleChangeable"`
}

// Invitation is OrganizationInvitationSchema.
type Invitation struct {
	ID        string `json:"id"`
	Email     string `json:"email"`
	URL       string `json:"url"`
	ExpiresAt string `json:"expiresAt"`
}

// Members is OrganizationMembersSchema.
type Members struct {
	Members     []Member     `json:"members"`
	Invitations []Invitation `json:"invitations"`
	CanManage   bool         `json:"canManage"`
}

// MembersList implements organizations.members.list: the people and, for a manager, the
// pending invitations with the link each is accepted by.
func MembersList(ctx context.Context, database *db.DB, deployment shared.Deployment, actor db.Actor, raw orpc.Input) (any, *orpc.Error) {
	values, failure := shared.IDFields(raw, "organizationId")
	if failure != nil {
		return nil, failure
	}
	organizationID := values["organizationId"]
	var result Members
	err := database.System(ctx, "list an organization's members for one of them", func(tx pgx.Tx) error {
		// memberRole: a full member of a live organization, else the same answer as a stranger.
		var storedRole string
		err := tx.QueryRow(ctx, `SELECT m.role FROM member m
			WHERE m."organizationId" = $1 AND m."userId" = $2 AND m.role <> 'guest' AND `+live("m.\"organizationId\"")+` LIMIT 1`,
			organizationID, actor.UserID).Scan(&storedRole)
		if errors.Is(err, pgx.ErrNoRows) {
			return shared.NotFound
		}
		if err != nil {
			return err
		}
		canManage := shared.OrganizationRole(storedRole) != "member"
		rows, err := tx.Query(ctx, `SELECT m."userId", m.role, u.name, u.email, u.image
			FROM member m JOIN "user" u ON u.id = m."userId"
			WHERE m."organizationId" = $1
				AND (m.role <> 'guest' OR EXISTS (SELECT 1 FROM space_members sm
					WHERE sm."userId" = m."userId" AND sm."organizationId" = m."organizationId" AND sm.role LIKE '%owner%'))
			ORDER BY m."createdAt" ASC, m.id ASC`, organizationID)
		if err != nil {
			return err
		}
		ranked := [3][]Member{}
		for rows.Next() {
			var member Member
			var role string
			if err := rows.Scan(&member.UserID, &role, &member.Name, &member.Email, &member.Image); err != nil {
				rows.Close()
				return err
			}
			member.Role = shared.OrganizationRole(role)
			member.Manageable = canManage && member.Role != "owner" && member.UserID != actor.UserID
			// A guest listed here is a removal that stopped part way: removing again finishes it.
			member.RoleChangeable = member.Manageable && role != shared.GuestRole
			rank := map[string]int{"owner": 0, "admin": 1, "member": 2}[member.Role]
			ranked[rank] = append(ranked[rank], member)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}
		result = Members{Members: []Member{}, Invitations: []Invitation{}, CanManage: canManage}
		for _, group := range ranked {
			result.Members = append(result.Members, group...)
		}
		if !canManage {
			return nil
		}
		invitations, err := tx.Query(ctx, `SELECT id, email, "expiresAt" FROM invitation
			WHERE "organizationId" = $1 AND status = 'pending' AND "expiresAt" > $2 ORDER BY "createdAt" ASC`, organizationID, now())
		if err != nil {
			return err
		}
		defer invitations.Close()
		for invitations.Next() {
			var invitation Invitation
			var expiresAt time.Time
			if err := invitations.Scan(&invitation.ID, &invitation.Email, &expiresAt); err != nil {
				return err
			}
			link, err := shared.JoinURL(deployment.WebOrigin, "/join/"+invitation.ID)
			if err != nil {
				return err
			}
			invitation.URL, invitation.ExpiresAt = link, shared.ISO(expiresAt)
			result.Invitations = append(result.Invitations, invitation)
		}
		return invitations.Err()
	})
	if err != nil {
		return nil, shared.Failure(err)
	}
	return result, nil
}

// InvitationPreview is OrganizationInvitationPreviewSchema.
type InvitationPreview struct {
	OrganizationName string `json:"organizationName"`
	InviterName      string `json:"inviterName"`
}

// InvitationsPreview implements organizations.invitations.preview: the invitee, signed in
// with the address it went to, sees who invited them to what. One answer for an unknown,
// expired, cancelled or used invitation.
func InvitationsPreview(ctx context.Context, database *db.DB, deployment shared.Deployment, actor db.Actor, raw orpc.Input) (any, *orpc.Error) {
	values, failure := shared.IDFields(raw, "invitationId")
	if failure != nil {
		return nil, failure
	}
	var result InvitationPreview
	err := database.System(ctx, "preview an invitation for its invitee", func(tx pgx.Tx) error {
		var email, organizationName, inviterName string
		err := tx.QueryRow(ctx, `SELECT i.email, o.name, u.name FROM invitation i
			JOIN organization o ON o.id = i."organizationId"
			JOIN "user" u ON u.id = i."inviterId"
			WHERE i.id = $1 AND i.status = 'pending' AND i."expiresAt" > $2 AND `+live(`i."organizationId"`),
			values["invitationId"], now()).Scan(&email, &organizationName, &inviterName)
		if errors.Is(err, pgx.ErrNoRows) {
			return errInvitationNotFound
		}
		if err != nil {
			return err
		}
		var userEmail string
		var verified bool
		err = tx.QueryRow(ctx, `SELECT email, "emailVerified" FROM "user" WHERE id = $1`, actor.UserID).Scan(&userEmail, &verified)
		if errors.Is(err, pgx.ErrNoRows) || (err == nil && shared.NormalizeEmail(userEmail) != email) {
			return errInvitationMismatch
		}
		if err != nil {
			return err
		}
		// Whether the account must have proved it receives the address's mail: set when the
		// server sends email, so every account could have; otherwise the unguessable link
		// sent to that address stands in for the proof.
		if deployment.EmailDelivery && !verified {
			return errEmailNotVerified
		}
		result = InvitationPreview{OrganizationName: organizationName, InviterName: inviterName}
		return nil
	})
	if err != nil {
		return nil, shared.Failure(err)
	}
	return result, nil
}
