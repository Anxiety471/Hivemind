// Package spaces ports the Space procedures that touch only the database:
// spaces.rename, spaces.members.list|add and spaces.invites.preview|accept|cancel
// (apps/api/src/routes/spaces.ts over packages/db/src/space-members.ts and spaces.ts).
//
// spaces.create|remove, members.remove|leave and invites.create stay on TypeScript:
// create seeds an encrypted memory document, remove and the departures run teardown,
// run cancellation and product events, and invites.create sends email.
package spaces

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/effects"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/orpc"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/shared"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/validate"
)

// maxSpacesPerMember is MAX_SPACES_PER_MEMBER (packages/db/src/spaces.ts:15).
const maxSpacesPerMember = 32

// maxSpaceNameLength is the length normalizeSpaceName allows, in UTF-16 units.
const maxSpaceNameLength = 60

// The ClientErrors these procedures can raise, answered as the API answers them
// (rpc-errors.ts: the error's own message under its kind's status).
var (
	errSpaceNotFound      = orpc.NotFound("Space not found")
	errOwnerRequired      = orpc.Forbidden("Only the space owner can do that")
	errCannotRename       = orpc.Forbidden("Only the space owner can rename it")
	errDeletionInProgress = orpc.Conflict("Space deletion is already in progress")
	errInvalidName        = orpc.BadRequest("Space name must be readable and between 1 and 60 characters")
	errSpaceLimit         = orpc.BadRequest("Space limit reached")
	errMemberNotFound     = orpc.NotFound("Member not found")
	errInviteNotFound     = orpc.NotFound("This invite link is invalid or has expired")
)

func now() time.Time { return time.Now().UTC().Truncate(time.Millisecond) }

// lockSpace is lockSpaceDeletion: a transaction-scoped lock a deletion and a handover also take.
func lockSpace(ctx context.Context, tx pgx.Tx, spaceID string) error {
	_, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, spaceID)
	return err
}

// requireOwner is requireSpaceOwner: the caller must hold an owner role in the Space.
func requireOwner(ctx context.Context, tx pgx.Tx, spaceID, userID string) error {
	var role string
	err := tx.QueryRow(ctx, `SELECT role FROM space_members WHERE "spaceId" = $1 AND "userId" = $2`, spaceID, userID).Scan(&role)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && !shared.IsOwnerRole(role)) {
		return errOwnerRequired
	}
	return err
}

// requireMember is asMemberOf's membership check: a client-supplied Space id never
// opens that Space's rows on its own.
func requireMember(ctx context.Context, tx pgx.Tx, spaceID, userID string) error {
	var present int
	err := tx.QueryRow(ctx, `SELECT 1 FROM space_members WHERE "spaceId" = $1 AND "userId" = $2 LIMIT 1`, spaceID, userID).Scan(&present)
	if errors.Is(err, pgx.ErrNoRows) {
		return errSpaceNotFound
	}
	return err
}

// inSpace is asMemberOf: membership is checked first (in the caller's own scope), then fn
// runs scoped to that Space.
func inSpace(ctx context.Context, database *db.DB, actor db.Actor, spaceID string, fn func(tx pgx.Tx) error) error {
	if err := database.Tenant(ctx, actor, func(tx pgx.Tx) error {
		return requireMember(ctx, tx, spaceID, actor.UserID)
	}); err != nil {
		return err
	}
	return database.Tenant(ctx, db.Actor{UserID: actor.UserID, SpaceID: spaceID}, fn)
}

// normalizeName is normalizeSpaceName: readable, at most 60 UTF-16 units once trimmed.
func normalizeName(name string) (string, error) {
	trimmed := validate.JSTrim(name)
	if shared.DisplayName(&trimmed, "") == "" || shared.UTF16Length(trimmed) > maxSpaceNameLength {
		return "", errInvalidName
	}
	return trimmed, nil
}

// Renamed is spaces.rename's output. The name is echoed as typed (trimmed), not as stored.
type Renamed struct {
	ID   string `json:"id"`
	Name any    `json:"name"`
}

type renameInput struct{ SpaceID, Name string }

// parseRename mirrors z.object({ spaceId: Id, name: z.string().trim().min(1).max(60) }).
func parseRename(raw orpc.Input) (renameInput, *orpc.Error) {
	object, issues := validate.Decode(raw.Raw, nil)
	if issues != nil {
		return renameInput{}, validate.Fail(issues)
	}
	var found []validate.Issue
	spaceID, problems := validate.String(validate.Path{"spaceId"}, object.Field("spaceId"), validate.StringRules{Min: 1})
	found = append(found, problems...)
	name, problems := validate.String(validate.Path{"name"}, object.Field("name"), validate.StringRules{Trim: true, Min: 1, Max: maxSpaceNameLength})
	found = append(found, problems...)
	if found != nil {
		return renameInput{}, validate.Fail(found)
	}
	return renameInput{SpaceID: spaceID, Name: name}, nil
}

// Rename implements spaces.rename: the owner renames one of their Spaces from another of
// the organization's. Serializable under the Space's deletion lock, rerun on a conflict.
func Rename(ctx context.Context, database *db.DB, audit *effects.Recorder, actor db.Actor, raw orpc.Input) (any, *orpc.Error) {
	input, failure := parseRename(raw)
	if failure != nil {
		return nil, failure
	}
	if err := database.Tenant(ctx, actor, func(tx pgx.Tx) error {
		return requireMember(ctx, tx, input.SpaceID, actor.UserID)
	}); err != nil {
		return nil, shared.Failure(err)
	}
	name, err := normalizeName(input.Name)
	if err != nil {
		return nil, shared.Failure(err)
	}
	target := db.Actor{UserID: actor.UserID, SpaceID: input.SpaceID}
	err = shared.Serializable(ctx, database, target, func(tx pgx.Tx) error {
		return rename(ctx, tx, actor, input.SpaceID, name)
	})
	if err != nil {
		return nil, shared.Failure(err)
	}
	audit.RecordAudit(ctx, effects.AuditEvent{
		Action: "space.renamed", ActorID: actor.UserID, SpaceID: input.SpaceID,
		TargetType: "space", TargetID: input.SpaceID, TargetLabel: name,
	})
	var echoed any = name
	if exact, unpaired := shared.EchoText(raw.Raw, "name"); unpaired {
		echoed = exact
	}
	return Renamed{ID: input.SpaceID, Name: echoed}, nil
}

// rename is renameSpaceForMember's transaction body.
func rename(ctx context.Context, tx pgx.Tx, actor db.Actor, spaceID, name string) error {
	if err := lockSpace(ctx, tx, spaceID); err != nil {
		return err
	}
	// loadActorSpace: the caller's current Space and the one renamed must share an organization.
	var currentOrganization string
	err := tx.QueryRow(ctx, `SELECT "organizationId" FROM space_members WHERE "spaceId" = $1 AND "userId" = $2`,
		actor.SpaceID, actor.UserID).Scan(&currentOrganization)
	if errors.Is(err, pgx.ErrNoRows) {
		return shared.NotFound
	}
	if err != nil {
		return err
	}
	var organization, role string
	var deletingAt *time.Time
	err = tx.QueryRow(ctx, `SELECT sm."organizationId", sm.role, s."deletingAt"
		FROM space_members sm JOIN spaces s ON s.id = sm."spaceId"
		WHERE sm."spaceId" = $1 AND sm."userId" = $2`, spaceID, actor.UserID).Scan(&organization, &role, &deletingAt)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && organization != currentOrganization) {
		return errSpaceNotFound
	}
	if err != nil {
		return err
	}
	if role != "owner" {
		return errCannotRename
	}
	if deletingAt != nil {
		return errDeletionInProgress
	}
	_, err = tx.Exec(ctx, `UPDATE spaces SET name = $1 WHERE id = $2`, shared.StoredText(name), spaceID)
	return err
}

// Person is one account listed beside a Space or organization.
type Person struct {
	UserID string  `json:"userId"`
	Name   string  `json:"name"`
	Email  string  `json:"email"`
	Image  *string `json:"image"`
}

// SpaceMember is SpaceMemberSchema.
type SpaceMember struct {
	UserID string  `json:"userId"`
	Name   string  `json:"name"`
	Email  string  `json:"email"`
	Image  *string `json:"image"`
	Role   string  `json:"role"`
	Guest  bool    `json:"guest"`
}

// Members is SpaceMembersSchema; addable and organizationName are the owner's view.
type Members struct {
	SpaceName        string        `json:"spaceName"`
	Members          []SpaceMember `json:"members"`
	CanManage        bool          `json:"canManage"`
	OpenInvites      int           `json:"openInvites"`
	Addable          *[]Person     `json:"addable,omitempty"`
	OrganizationName *string       `json:"organizationName,omitempty"`
}

// MembersList implements spaces.members.list.
func MembersList(ctx context.Context, database *db.DB, actor db.Actor, raw orpc.Input) (any, *orpc.Error) {
	values, failure := shared.IDFields(raw, "spaceId")
	if failure != nil {
		return nil, failure
	}
	spaceID := values["spaceId"]
	var result Members
	err := database.Tenant(ctx, db.Actor{UserID: actor.UserID, SpaceID: spaceID}, func(tx pgx.Tx) error {
		if err := requireMember(ctx, tx, spaceID, actor.UserID); err != nil {
			return err
		}
		var err error
		result, err = listMembers(ctx, tx, spaceID, actor.UserID)
		return err
	})
	if err != nil {
		return nil, shared.Failure(err)
	}
	return result, nil
}

// listMembers is listSpaceMembers.
func listMembers(ctx context.Context, tx pgx.Tx, spaceID, userID string) (Members, error) {
	rows, err := tx.Query(ctx, `SELECT sm."userId", sm.role, s.name, s."organizationId", o.name, m.role, u.name, u.email, u.image
		FROM space_members sm
		JOIN spaces s ON s.id = sm."spaceId"
		JOIN organization o ON o.id = s."organizationId"
		JOIN member m ON m."organizationId" = sm."organizationId" AND m."userId" = sm."userId"
		JOIN "user" u ON u.id = sm."userId"
		WHERE sm."spaceId" = $1
		ORDER BY sm."createdAt" ASC, sm.id ASC`, spaceID)
	if err != nil {
		return Members{}, err
	}
	defer rows.Close()
	var owners, others []SpaceMember
	var selfRole, selfMemberRole, spaceName, organizationID, organizationName string
	var found bool
	for rows.Next() {
		var row SpaceMember
		var role, memberRole, space, organization, organizationLabel string
		if err := rows.Scan(&row.UserID, &role, &space, &organization, &organizationLabel, &memberRole, &row.Name, &row.Email, &row.Image); err != nil {
			return Members{}, err
		}
		if row.UserID == userID && !found {
			found = true
			selfRole, selfMemberRole, spaceName, organizationID, organizationName = role, memberRole, space, organization, organizationLabel
		}
		row.Guest = memberRole == shared.GuestRole
		if shared.IsOwnerRole(role) {
			row.Role = "owner"
			owners = append(owners, row)
		} else {
			row.Role = "member"
			others = append(others, row)
		}
	}
	if err := rows.Err(); err != nil {
		return Members{}, err
	}
	rows.Close()
	if !found {
		return Members{}, errSpaceNotFound
	}
	// Owners first, the rest keeping their creation order (a stable sort).
	members := append(append([]SpaceMember{}, owners...), others...)
	if !shared.IsOwnerRole(selfRole) {
		return Members{SpaceName: spaceName, Members: members, CanManage: false, OpenInvites: 0}, nil
	}
	var open int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM space_invites WHERE "spaceId" = $1 AND "acceptedAt" IS NULL AND "expiresAt" > $2`,
		spaceID, now()).Scan(&open); err != nil {
		return Members{}, err
	}
	addable := []Person{}
	// Only a full member of the organization sees who else is in it.
	if selfMemberRole != shared.GuestRole {
		people, err := tx.Query(ctx, `SELECT m."userId", u.name, u.email, u.image FROM member m JOIN "user" u ON u.id = m."userId"
			WHERE m."organizationId" = $1 AND m.role <> 'guest'
				AND NOT EXISTS (SELECT 1 FROM space_members sm WHERE sm."userId" = m."userId" AND sm."organizationId" = m."organizationId" AND sm."spaceId" = $2)
			ORDER BY m."createdAt" ASC, m.id ASC`, organizationID, spaceID)
		if err != nil {
			return Members{}, err
		}
		defer people.Close()
		for people.Next() {
			var person Person
			if err := people.Scan(&person.UserID, &person.Name, &person.Email, &person.Image); err != nil {
				return Members{}, err
			}
			addable = append(addable, person)
		}
		if err := people.Err(); err != nil {
			return Members{}, err
		}
	}
	return Members{
		SpaceName: spaceName, Members: members, CanManage: true, OpenInvites: open,
		Addable: &addable, OrganizationName: &organizationName,
	}, nil
}

// MembersAdd implements spaces.members.add: the owner adds someone who is already a full
// member of the Space's organization. A repeat answers ok without a second audit row.
func MembersAdd(ctx context.Context, database *db.DB, audit *effects.Recorder, actor db.Actor, raw orpc.Input) (any, *orpc.Error) {
	values, failure := shared.IDFields(raw, "spaceId", "userId")
	if failure != nil {
		return nil, failure
	}
	spaceID, memberID := values["spaceId"], values["userId"]
	var added bool
	err := inSpace(ctx, database, actor, spaceID, func(tx pgx.Tx) error {
		var err error
		added, err = addMember(ctx, tx, spaceID, actor.UserID, memberID)
		return err
	})
	if err != nil {
		return nil, shared.Failure(err)
	}
	if added {
		audit.RecordAudit(ctx, effects.AuditEvent{
			Action: "space.member.added", ActorID: actor.UserID, SpaceID: spaceID,
			TargetType: "user", TargetID: memberID,
		})
	}
	return map[string]any{"ok": true}, nil
}

// addMember is addSpaceMember. False when they already belonged to the Space.
func addMember(ctx context.Context, tx pgx.Tx, spaceID, userID, memberUserID string) (bool, error) {
	// Under the lock a deletion and a handover take, so the owner and the Space are current.
	if err := lockSpace(ctx, tx, spaceID); err != nil {
		return false, err
	}
	if err := requireOwner(ctx, tx, spaceID, userID); err != nil {
		return false, err
	}
	var organization string
	var deletingAt *time.Time
	err := tx.QueryRow(ctx, `SELECT "organizationId", "deletingAt" FROM spaces WHERE id = $1`, spaceID).Scan(&organization, &deletingAt)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && deletingAt != nil) {
		return false, errSpaceNotFound
	}
	if err != nil {
		return false, err
	}
	// Locked, so a removal from the organization either finishes first or waits for this. Both
	// people must still be full members: an owner whose removal is finishing adds nobody.
	rows, err := tx.Query(ctx, `SELECT "userId", role FROM member
		WHERE "organizationId" = $1 AND "userId" IN ($2, $3) ORDER BY "userId" FOR UPDATE`, organization, memberUserID, userID)
	if err != nil {
		return false, err
	}
	full := map[string]bool{}
	for rows.Next() {
		var id, role string
		if err := rows.Scan(&id, &role); err != nil {
			rows.Close()
			return false, err
		}
		if role != shared.GuestRole {
			full[id] = true
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return false, err
	}
	if !full[userID] {
		return false, errOwnerRequired
	}
	if !full[memberUserID] {
		return false, errMemberNotFound
	}
	var already int
	err = tx.QueryRow(ctx, `SELECT 1 FROM space_members WHERE "spaceId" = $1 AND "userId" = $2`, spaceID, memberUserID).Scan(&already)
	if err == nil {
		return false, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return false, err
	}
	var count int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM space_members WHERE "organizationId" = $1 AND "userId" = $2`, organization, memberUserID).Scan(&count); err != nil {
		return false, err
	}
	if count >= maxSpacesPerMember {
		return false, errSpaceLimit
	}
	_, err = tx.Exec(ctx, `INSERT INTO space_members (id, "spaceId", "organizationId", "userId", role, "createdAt")
		VALUES ($1, $2, $3, $4, 'member', $5) ON CONFLICT ("spaceId", "userId") DO NOTHING`,
		effects.NewUUID(), spaceID, organization, memberUserID, now())
	return err == nil, err
}

// InvitesCancel implements spaces.invites.cancel: every unused link stops working.
func InvitesCancel(ctx context.Context, database *db.DB, audit *effects.Recorder, actor db.Actor, raw orpc.Input) (any, *orpc.Error) {
	values, failure := shared.IDFields(raw, "spaceId")
	if failure != nil {
		return nil, failure
	}
	spaceID := values["spaceId"]
	err := inSpace(ctx, database, actor, spaceID, func(tx pgx.Tx) error {
		if err := lockSpace(ctx, tx, spaceID); err != nil {
			return err
		}
		if err := requireOwner(ctx, tx, spaceID, actor.UserID); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, `DELETE FROM space_invites WHERE "spaceId" = $1 AND "acceptedAt" IS NULL`, spaceID)
		return err
	})
	if err != nil {
		return nil, shared.Failure(err)
	}
	audit.RecordAudit(ctx, effects.AuditEvent{Action: "space.invites.cancelled", ActorID: actor.UserID, SpaceID: spaceID})
	return map[string]any{"ok": true}, nil
}

// parseToken mirrors z.object({ token: z.string().min(1).max(200) }).
func parseToken(raw orpc.Input) (string, *orpc.Error) {
	object, issues := validate.Decode(raw.Raw, nil)
	if issues != nil {
		return "", validate.Fail(issues)
	}
	token, problems := validate.String(validate.Path{"token"}, object.Field("token"), validate.StringRules{Min: 1, Max: 200})
	if problems != nil {
		return "", validate.Fail(problems)
	}
	return token, nil
}

// invite is the link's row with what findInvite reads beside it.
type invite struct {
	ID, SpaceID, SpaceName, InviterName, OrganizationID string
	IsDefault                                           bool
}

// findInvite is findInvite: one answer for an unknown, expired or used link and for a
// Space being deleted. Whoever used a link may reopen it while they still belong.
func findInvite(ctx context.Context, tx pgx.Tx, token, userID string) (invite, bool, error) {
	digest := sha256.Sum256([]byte(token))
	var found invite
	var expiresAt time.Time
	var acceptedAt *time.Time
	var acceptedBy *string
	var deletingAt *time.Time
	err := tx.QueryRow(ctx, `SELECT i.id, i."spaceId", i."expiresAt", i."acceptedAt", i."acceptedByUserId", u.name,
			s.name, s."organizationId", s."isDefault", s."deletingAt"
		FROM space_invites i
		JOIN "user" u ON u.id = i."createdByUserId"
		JOIN spaces s ON s.id = i."spaceId"
		WHERE i."tokenHash" = $1`, hex.EncodeToString(digest[:])).
		Scan(&found.ID, &found.SpaceID, &expiresAt, &acceptedAt, &acceptedBy, &found.InviterName,
			&found.SpaceName, &found.OrganizationID, &found.IsDefault, &deletingAt)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && deletingAt != nil) {
		return invite{}, false, errInviteNotFound
	}
	if err != nil {
		return invite{}, false, err
	}
	var present int
	err = tx.QueryRow(ctx, `SELECT 1 FROM space_members WHERE "spaceId" = $1 AND "userId" = $2`, found.SpaceID, userID).Scan(&present)
	alreadyMember := err == nil
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return invite{}, false, err
	}
	open := acceptedAt == nil && expiresAt.After(now())
	usedBySelf := acceptedBy != nil && *acceptedBy == userID && alreadyMember
	if !open && !usedBySelf {
		return invite{}, false, errInviteNotFound
	}
	return found, alreadyMember, nil
}

// InvitePreview is SpaceInvitePreviewSchema.
type InvitePreview struct {
	SpaceID       string `json:"spaceId"`
	SpaceName     string `json:"spaceName"`
	InviterName   string `json:"inviterName"`
	AlreadyMember bool   `json:"alreadyMember"`
}

// InvitesPreview implements spaces.invites.preview. The invitee is not a member yet, so
// the Space is looked up by the link alone.
func InvitesPreview(ctx context.Context, database *db.DB, actor db.Actor, raw orpc.Input) (any, *orpc.Error) {
	token, failure := parseToken(raw)
	if failure != nil {
		return nil, failure
	}
	var result InvitePreview
	err := database.Tenant(ctx, actor, func(tx pgx.Tx) error {
		found, already, err := findInvite(ctx, tx, token, actor.UserID)
		if err != nil {
			return err
		}
		result = InvitePreview{SpaceID: found.SpaceID, SpaceName: found.SpaceName, InviterName: found.InviterName, AlreadyMember: already}
		return nil
	})
	if err != nil {
		return nil, shared.Failure(err)
	}
	return result, nil
}

// InvitesAccept implements spaces.invites.accept: claiming the link and adding the
// member commit together, so a link is used at most once. Someone from outside the
// organization joins it as a guest, in this Space alone.
func InvitesAccept(ctx context.Context, database *db.DB, audit *effects.Recorder, actor db.Actor, raw orpc.Input) (any, *orpc.Error) {
	token, failure := parseToken(raw)
	if failure != nil {
		return nil, failure
	}
	var spaceID string
	var joined bool
	err := shared.Serializable(ctx, database, actor, func(tx pgx.Tx) error {
		var err error
		spaceID, joined, err = acceptInvite(ctx, tx, token, actor.UserID)
		return err
	})
	if err != nil {
		return nil, shared.Failure(err)
	}
	if joined {
		audit.RecordAudit(ctx, effects.AuditEvent{Action: "space.member.joined", ActorID: actor.UserID, SpaceID: spaceID})
	}
	return map[string]any{"spaceId": spaceID}, nil
}

// acceptInvite is acceptSpaceInvite's transaction body.
func acceptInvite(ctx context.Context, tx pgx.Tx, token, userID string) (string, bool, error) {
	found, alreadyMember, err := findInvite(ctx, tx, token, userID)
	if err != nil {
		return "", false, err
	}
	if alreadyMember {
		return found.SpaceID, false, nil
	}
	if err := lockSpace(ctx, tx, found.SpaceID); err != nil {
		return "", false, err
	}
	at := now()
	claimed, err := tx.Exec(ctx, `UPDATE space_invites SET "acceptedAt" = $1, "acceptedByUserId" = $2
		WHERE id = $3 AND "acceptedAt" IS NULL AND "expiresAt" > $1`, at, userID, found.ID)
	if err != nil {
		return "", false, err
	}
	var deletingAt *time.Time
	err = tx.QueryRow(ctx, `SELECT "deletingAt" FROM spaces WHERE id = $1`, found.SpaceID).Scan(&deletingAt)
	gone := errors.Is(err, pgx.ErrNoRows)
	if err != nil && !gone {
		return "", false, err
	}
	if claimed.RowsAffected() != 1 || gone || deletingAt != nil {
		return "", false, errInviteNotFound
	}
	var memberID string
	err = tx.QueryRow(ctx, `SELECT id FROM member WHERE "organizationId" = $1 AND "userId" = $2`, found.OrganizationID, userID).Scan(&memberID)
	if errors.Is(err, pgx.ErrNoRows) {
		memberID = effects.NewUUID()
		if _, err := tx.Exec(ctx, `INSERT INTO member (id, "organizationId", "userId", role, "createdAt") VALUES ($1, $2, $3, $4, $5)`,
			memberID, found.OrganizationID, userID, shared.GuestRole, at); err != nil {
			return "", false, err
		}
		// A database trigger adds every new organization member to its default Space. An
		// invite opens one Space only, so undo that for any other.
		if !found.IsDefault {
			if _, err := tx.Exec(ctx, `DELETE FROM space_members WHERE id = $1 AND "userId" = $2`, "default-space-member:"+memberID, userID); err != nil {
				return "", false, err
			}
		}
	} else if err != nil {
		return "", false, err
	}
	// An invite into the default Space finds the trigger's row, which copied the organization role.
	if _, err := tx.Exec(ctx, `INSERT INTO space_members (id, "spaceId", "organizationId", "userId", role, "createdAt")
		VALUES ($1, $2, $3, $4, 'member', $5)
		ON CONFLICT ("spaceId", "userId") DO UPDATE SET role = 'member'`,
		effects.NewUUID(), found.SpaceID, found.OrganizationID, userID, at); err != nil {
		return "", false, err
	}
	return found.SpaceID, true, nil
}
