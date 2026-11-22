package spaces

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/orpc"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/bots"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/botsections"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/externalconversations"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/groups"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/shared"
)

// spaceDeletionClaimTimeout is SPACE_DELETION_CLAIM_TIMEOUT_MS (packages/db/src/spaces/
// spaces.ts:73): a deletion claim older than this may be taken over.
const spaceDeletionClaimTimeout = 5 * time.Minute

// guestRole is GUEST_ROLE (packages/db/src/billing/billing.ts:444).
const guestRole = "guest"

// Navigation is SpaceNavigationSchema (packages/contracts/src/spaces/space.ts:111).
type Navigation struct {
	Current     CurrentSpace `json:"current"`
	Spaces      []SpaceEntry `json:"spaces"`
	FirstBotDue bool         `json:"firstBotDue"`
}

// CurrentSpace is the Space the request acts in, with everything the sidebar shows there.
type CurrentSpace struct {
	ID                    string                               `json:"id"`
	Name                  string                               `json:"name"`
	Bots                  []bots.Bot                           `json:"bots"`
	Groups                []groups.Group                       `json:"groups"`
	ExternalConversations []externalconversations.Conversation `json:"externalConversations"`
	BotSections           []botsections.Section                `json:"botSections"`
}

// SpaceEntry is SpaceSchema (packages/contracts/src/spaces/space.ts:49): one Space the
// member belongs to, with the bots and chats another Space may still show.
type SpaceEntry struct {
	ID                    string                               `json:"id"`
	Name                  string                               `json:"name"`
	IsDefault             bool                                 `json:"isDefault"`
	HasContent            bool                                 `json:"hasContent"`
	CanRename             bool                                 `json:"canRename"`
	CanDelete             bool                                 `json:"canDelete"`
	Shared                bool                                 `json:"shared"`
	HasGuests             bool                                 `json:"hasGuests"`
	BotCount              int64                                `json:"botCount"`
	Bots                  []bots.SpaceBot                      `json:"bots"`
	Groups                []groups.SpaceGroup                  `json:"groups"`
	ExternalConversations []externalconversations.Conversation `json:"externalConversations"`
	BotSections           []botsections.Section                `json:"botSections"`
}

type membershipRow struct {
	spaceID     string
	role        string
	name        string
	isDefault   bool
	deletingAt  *time.Time
	memberCount int64
}

// List implements spaces.list: every Space the member belongs to, with each one's bots,
// groups, external chats and sections (memberSpaceNavigation, apps/api/src/routes/
// spaces.ts:355). It reads across Spaces, so it runs as system and limits every query to
// the member's own memberships.
func List(
	ctx context.Context,
	database *db.DB,
	deployment *shared.Deployment,
	actor db.Actor,
) (any, *orpc.Error) {
	var navigation Navigation
	err := database.System(ctx, "space navigation across the member's Spaces", func(tx pgx.Tx) error {
		return navigate(ctx, tx, deployment, actor, &navigation)
	})
	if err != nil {
		return nil, shared.Failure(err)
	}
	if failure := validateNavigation(navigation, actor); failure != nil {
		return nil, failure
	}
	return navigation, nil
}

func navigate(
	ctx context.Context,
	tx pgx.Tx,
	deployment *shared.Deployment,
	actor db.Actor,
	navigation *Navigation,
) error {
	organizationID, err := homeOrganization(ctx, tx, actor)
	if err != nil {
		return err
	}
	memberships, err := memberSpaces(ctx, tx, actor, organizationID)
	if err != nil {
		return err
	}
	current := -1
	spaceIDs := make([]string, 0, len(memberships))
	inactiveIDs := make([]string, 0, len(memberships))
	for index, membership := range memberships {
		spaceIDs = append(spaceIDs, membership.spaceID)
		if membership.spaceID == actor.SpaceID {
			current = index
			continue
		}
		inactiveIDs = append(inactiveIDs, membership.spaceID)
	}
	if current < 0 {
		// IsolationError: the actor is not a member of the Space the session names.
		return shared.NotFound
	}

	currentBots, err := bots.BotRows(ctx, tx, *deployment, []string{actor.SpaceID}, actor.UserID)
	if err != nil {
		return err
	}
	currentGroups, err := groups.GroupRows(ctx, tx, *deployment, []string{actor.SpaceID}, actor.UserID)
	if err != nil {
		return err
	}
	inactiveBots, err := bots.SpaceBotRows(ctx, tx, *deployment, inactiveIDs, actor.UserID)
	if err != nil {
		return err
	}
	inactiveGroups, err := groups.SpaceGroupRows(ctx, tx, *deployment, inactiveIDs, actor.UserID)
	if err != nil {
		return err
	}
	sections, err := botsections.ListForSpaces(ctx, tx, spaceIDs)
	if err != nil {
		return err
	}
	external, err := externalconversations.ListForSpaces(ctx, tx, deployment.Content, spaceIDs, actor.UserID)
	if err != nil {
		return err
	}

	botCounts, err := countBots(ctx, tx, spaceIDs)
	if err != nil {
		return err
	}
	groupSpaces, err := distinctSpaces(ctx, tx, `SELECT DISTINCT "spaceId" FROM chat_groups WHERE "spaceId" = ANY($1)`, spaceIDs)
	if err != nil {
		return err
	}
	deletionSpaces, err := distinctSpaces(ctx, tx, `SELECT DISTINCT "spaceId" FROM bot_deletions WHERE "spaceId" = ANY($1)`, spaceIDs)
	if err != nil {
		return err
	}
	guestSpaces, err := distinctSpaces(ctx, tx, `SELECT DISTINCT sm."spaceId" FROM space_members sm
		JOIN member m ON m."organizationId" = sm."organizationId" AND m."userId" = sm."userId"
		WHERE sm."spaceId" = ANY($1) AND m.role = $2`, spaceIDs, guestRole)
	if err != nil {
		return err
	}

	withGuests := setOf(guestSpaces)
	spacesWithContent := map[string]bool{}
	for spaceID := range botCounts {
		spacesWithContent[spaceID] = true
	}
	for _, spaceID := range append(groupSpaces, deletionSpaces...) {
		spacesWithContent[spaceID] = true
	}

	firstBotDue := len(spacesWithContent) == 0
	if firstBotDue {
		firstBotDue, err = noChatHistory(ctx, tx, actor)
		if err != nil {
			return err
		}
	}

	botsBySpace := map[string][]bots.SpaceBot{}
	for _, bot := range currentBots {
		botsBySpace[bot.SpaceID] = append(botsBySpace[bot.SpaceID], spaceBotOf(bot))
	}
	for _, bot := range inactiveBots {
		botsBySpace[bot.SpaceID] = append(botsBySpace[bot.SpaceID], bot)
	}
	groupsBySpace := map[string][]groups.SpaceGroup{}
	for _, group := range currentGroups {
		groupsBySpace[group.SpaceID] = append(groupsBySpace[group.SpaceID], spaceGroupOf(group))
	}
	for _, group := range inactiveGroups {
		groupsBySpace[group.SpaceID] = append(groupsBySpace[group.SpaceID], group)
	}
	sectionsBySpace := map[string][]botsections.Section{}
	for _, section := range sections {
		sectionsBySpace[section.SpaceID] = append(sectionsBySpace[section.SpaceID], section.Section)
	}

	staleClaimBefore := time.Now().UTC().Add(-spaceDeletionClaimTimeout)
	entries := make([]SpaceEntry, 0, len(memberships))
	for _, membership := range memberships {
		owner := shared.IsOwnerRole(membership.role)
		spaceBots := botsBySpace[membership.spaceID]
		if spaceBots == nil {
			spaceBots = []bots.SpaceBot{}
		}
		spaceGroups := groupsBySpace[membership.spaceID]
		if spaceGroups == nil {
			spaceGroups = []groups.SpaceGroup{}
		}
		spaceSections := sectionsBySpace[membership.spaceID]
		if spaceSections == nil {
			spaceSections = []botsections.Section{}
		}
		spaceExternal := []externalconversations.Conversation{}
		for _, conversation := range external {
			if conversation.SpaceID == membership.spaceID {
				spaceExternal = append(spaceExternal, conversation)
			}
		}
		count := botCounts[membership.spaceID]
		entry := SpaceEntry{
			ID:         membership.spaceID,
			Name:       membership.name,
			IsDefault:  membership.isDefault && owner,
			HasContent: spacesWithContent[membership.spaceID],
			CanRename:  owner && membership.deletingAt == nil,
			CanDelete: owner && !membership.isDefault && len(memberships) > 1 &&
				(membership.deletingAt == nil || membership.deletingAt.Before(staleClaimBefore)),
			Shared:                membership.memberCount > 1,
			HasGuests:             withGuests[membership.spaceID],
			BotCount:              count,
			Bots:                  spaceBots,
			Groups:                spaceGroups,
			ExternalConversations: spaceExternal,
			BotSections:           spaceSections,
		}
		entries = append(entries, entry)
	}

	currentExternal := []externalconversations.Conversation{}
	for _, conversation := range external {
		if conversation.SpaceID == actor.SpaceID {
			currentExternal = append(currentExternal, conversation)
		}
	}
	currentSections := sectionsBySpace[actor.SpaceID]
	if currentSections == nil {
		currentSections = []botsections.Section{}
	}
	navigation.Spaces = entries
	navigation.FirstBotDue = firstBotDue
	navigation.Current = CurrentSpace{
		ID:                    memberships[current].spaceID,
		Name:                  memberships[current].name,
		Bots:                  currentBots,
		Groups:                currentGroups,
		ExternalConversations: currentExternal,
		BotSections:           currentSections,
	}
	return nil
}

// spaceBotOf maps a full Bot row to SpaceBotSchema's fields, as spaces.ts:455 does.
func spaceBotOf(bot bots.Bot) bots.SpaceBot {
	return bots.SpaceBot{
		ID:             bot.ID,
		SpaceID:        bot.SpaceID,
		Name:           bot.Name,
		Title:          bot.Title,
		Color:          bot.Color,
		AvatarSet:      bot.AvatarSet,
		NotifyOnFinish: bot.NotifyOnFinish,
		Pinned:         bot.Pinned,
		SectionID:      bot.SectionID,
		Unread:         bot.Unread,
		SnoozedUntil:   bot.SnoozedUntil,
		ParentBotID:    bot.ParentBotID,
		Preview:        bot.Preview,
		Status:         bot.Status,
		ThreadStatus:   bot.ThreadStatus,
		RunErrorID:     bot.RunErrorID,
		UpdatedAt:      bot.UpdatedAt,
	}
}

// spaceGroupOf maps a full Group row to SpaceGroupSchema's fields (spaces.ts:470).
func spaceGroupOf(group groups.Group) groups.SpaceGroup {
	return groups.SpaceGroup{
		ID:           group.ID,
		SpaceID:      group.SpaceID,
		Name:         group.Name,
		Pinned:       group.Pinned,
		SectionID:    group.SectionID,
		Members:      group.Members,
		Preview:      group.Preview,
		Unread:       group.Unread,
		SnoozedUntil: group.SnoozedUntil,
		UpdatedAt:    group.UpdatedAt,
	}
}

// homeOrganization is homeOrganizationId (packages/db/src/spaces/spaces.ts:218): the
// organization whose Spaces the member sees around this one, or for a guest their oldest
// own.
func homeOrganization(ctx context.Context, tx pgx.Tx, actor db.Actor) (string, error) {
	var organizationID, memberRole string
	err := tx.QueryRow(ctx, `SELECT sm."organizationId", m.role
		FROM space_members sm
		JOIN member m ON m."organizationId" = sm."organizationId" AND m."userId" = sm."userId"
		WHERE sm."spaceId" = $1 AND sm."userId" = $2`, actor.SpaceID, actor.UserID).
		Scan(&organizationID, &memberRole)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", shared.NotFound
	}
	if err != nil {
		return "", err
	}
	if memberRole != guestRole {
		return organizationID, nil
	}
	// ownedOrganizationId (packages/db/src/billing/billing.ts:447): the oldest LIVE
	// organization whose membership role is owner. LIVE_ORGANIZATION means it still has a
	// default Space that is not being deleted.
	rows, err := tx.Query(ctx, `SELECT m."organizationId", m.role FROM member m
		WHERE m."userId" = $1 AND EXISTS (
			SELECT 1 FROM spaces s WHERE s."organizationId" = m."organizationId"
				AND s."isDefault" AND s."deletingAt" IS NULL)
		ORDER BY m."createdAt" ASC`, actor.UserID)
	if err != nil {
		return "", err
	}
	defer rows.Close()
	for rows.Next() {
		var owned, role string
		if err := rows.Scan(&owned, &role); err != nil {
			return "", err
		}
		if shared.IsOwnerRole(role) {
			return owned, nil
		}
	}
	if err := rows.Err(); err != nil {
		return "", err
	}
	return "", shared.NotFound
}

// memberSpaces is the memberships query: the member's own organization's Spaces plus every
// Space shared with them from someone else's, oldest first.
func memberSpaces(ctx context.Context, tx pgx.Tx, actor db.Actor, organizationID string) ([]membershipRow, error) {
	rows, err := tx.Query(ctx, `SELECT sm."spaceId", sm.role, s.name, s."isDefault", s."deletingAt",
			(SELECT count(*) FROM space_members x WHERE x."spaceId" = sm."spaceId")
		FROM space_members sm
		JOIN member m ON m."organizationId" = sm."organizationId" AND m."userId" = sm."userId"
		JOIN spaces s ON s.id = sm."spaceId"
		WHERE sm."userId" = $1 AND (sm."organizationId" = $2 OR m.role = $3)
		ORDER BY sm."createdAt" ASC`, actor.UserID, organizationID, guestRole)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	memberships := []membershipRow{}
	for rows.Next() {
		var row membershipRow
		if err := rows.Scan(&row.spaceID, &row.role, &row.name, &row.isDefault, &row.deletingAt,
			&row.memberCount); err != nil {
			return nil, err
		}
		memberships = append(memberships, row)
	}
	return memberships, rows.Err()
}

func countBots(ctx context.Context, tx pgx.Tx, spaceIDs []string) (map[string]int64, error) {
	counts := map[string]int64{}
	rows, err := tx.Query(ctx, `SELECT "spaceId", count(*) FROM bots WHERE "spaceId" = ANY($1) GROUP BY "spaceId"`, spaceIDs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var spaceID string
		var count int64
		if err := rows.Scan(&spaceID, &count); err != nil {
			return nil, err
		}
		counts[spaceID] = count
	}
	return counts, rows.Err()
}

func distinctSpaces(ctx context.Context, tx pgx.Tx, query string, args ...any) ([]string, error) {
	rows, err := tx.Query(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	found := []string{}
	for rows.Next() {
		var spaceID string
		if err := rows.Scan(&spaceID); err != nil {
			return nil, err
		}
		found = append(found, spaceID)
	}
	return found, rows.Err()
}

func setOf(values []string) map[string]bool {
	set := make(map[string]bool, len(values))
	for _, value := range values {
		set[value] = true
	}
	return set
}

// noChatHistory is hasChatHistory (apps/api/src/account/first-bot.ts:88): whether the
// person's own Spaces, the current one included, hold a bot, group, or deleted bot.
func noChatHistory(ctx context.Context, tx pgx.Tx, actor db.Actor) (bool, error) {
	rows, err := tx.Query(ctx, `SELECT id FROM spaces WHERE "createdByUserId" = $1
		AND EXISTS (SELECT 1 FROM space_members x WHERE x."spaceId" = spaces.id AND x."userId" = $1)`,
		actor.UserID)
	if err != nil {
		return false, err
	}
	spaceIDs := []string{actor.SpaceID}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return false, err
		}
		spaceIDs = append(spaceIDs, id)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return false, err
	}
	var found bool
	err = tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM bots WHERE "spaceId" = ANY($1))
		OR EXISTS (SELECT 1 FROM chat_groups WHERE "spaceId" = ANY($1))
		OR EXISTS (SELECT 1 FROM bot_deletions WHERE "spaceId" = ANY($1))`, spaceIDs).Scan(&found)
	if err != nil {
		return false, err
	}
	return !found, nil
}

// validateNavigation is the router's parse of SpaceNavigationSchema for the stored values
// the DTO echoes.
func validateNavigation(navigation Navigation, actor db.Actor) *orpc.Error {
	if navigation.Current.ID == "" || navigation.Current.ID != actor.SpaceID {
		return shared.OutputInvalid()
	}
	if failure := bots.ValidateRows(navigation.Current.Bots); failure != nil {
		return failure
	}
	for _, entry := range navigation.Spaces {
		if entry.ID == "" || entry.BotCount < 0 {
			return shared.OutputInvalid()
		}
	}
	return nil
}
