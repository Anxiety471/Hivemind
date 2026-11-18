package integration

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/effects"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/orpc"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/spaces"
)

func tokenHash(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

func addUser(t *testing.T, database *db.DB, id string) {
	t.Helper()
	exec(t, database, `INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") VALUES ($1, $2, $3, true, now(), now())`,
		id, "User "+id, id+"@example.test")
}

func addOrgMember(t *testing.T, database *db.DB, organizationID, userID, role string) {
	t.Helper()
	exec(t, database, `INSERT INTO member (id, "organizationId", "userId", role, "createdAt") VALUES ($1, $2, $3, $4, now())`,
		"m-"+organizationID+"-"+userID, organizationID, userID, role)
}

// dropDefaultSpaceRow removes the row the database trigger adds when a member joins an organization.
func dropDefaultSpaceRow(t *testing.T, database *db.DB, organizationID, userID string) {
	t.Helper()
	exec(t, database, `DELETE FROM space_members WHERE id = $1`, "default-space-member:m-"+organizationID+"-"+userID)
}

func addSpaceMemberRow(t *testing.T, database *db.DB, spaceID, organizationID, userID, role string) {
	t.Helper()
	exec(t, database, `INSERT INTO space_members (id, "spaceId", "organizationId", "userId", role, "createdAt") VALUES ($1, $2, $3, $4, $5, now())`,
		"sm-"+spaceID+"-"+userID, spaceID, organizationID, userID, role)
}

func addInvite(t *testing.T, database *db.DB, spaceID, createdBy, token string, expiresAt time.Time) {
	t.Helper()
	exec(t, database, `INSERT INTO space_invites (id, "spaceId", "tokenHash", "createdByUserId", "expiresAt") VALUES ($1, $2, $3, $4, $5)`,
		"inv-"+token, spaceID, tokenHash(token), createdBy, expiresAt)
}

func spaceRows(t *testing.T, database *db.DB, query string, args ...any) int {
	t.Helper()
	return systemScalar[int](t, database, query, args...)
}

func tokenInput(token string) orpc.Input { return raw(`{"token":"` + token + `"}`) }

// A link is used at most once: many people opening it together leave exactly one of them in the Space,
// the link claimed by that person, and every other opener told the link is invalid.
func TestConcurrentAcceptsOfOneLinkAdmitOnePerson(t *testing.T) {
	database := openTestDB(t)
	s := seed(t, database)
	audit := effects.NewRecorder(database, nil)
	ctx := context.Background()
	const openers = 8
	var users []string
	for i := range openers {
		id := fmt.Sprintf("opener%d-%s", i, s.UserID)
		addUser(t, database, id)
		users = append(users, id)
	}
	token := "race-" + s.UserID
	addInvite(t, database, s.Space2, s.UserID, token, time.Now().Add(time.Hour))

	var wg sync.WaitGroup
	start := make(chan struct{})
	results := make(chan string, openers)
	for _, id := range users {
		wg.Add(1)
		go func(id string) {
			defer wg.Done()
			<-start
			_, failure := spaces.InvitesAccept(ctx, database, audit, db.Actor{UserID: id, SpaceID: s.Space1}, tokenInput(token))
			if failure != nil {
				results <- failure.Code + ":" + failure.Message
				return
			}
			results <- "joined:" + id
		}(id)
	}
	close(start)
	wg.Wait()
	close(results)
	joined, refused := 0, 0
	for result := range results {
		switch {
		case strings.HasPrefix(result, "joined:"):
			joined++
		case result == "NOT_FOUND:This invite link is invalid or has expired":
			refused++
		default:
			t.Errorf("unexpected result %q", result)
		}
	}
	if joined != 1 || refused != openers-1 {
		t.Fatalf("joined %d, refused %d; want 1 and %d", joined, refused, openers-1)
	}
	if n := spaceRows(t, database, `SELECT count(*)::int FROM space_members WHERE "spaceId" = $1 AND "userId" = ANY($2)`, s.Space2, users); n != 1 {
		t.Fatalf("%d openers belong to the Space, want 1", n)
	}
	if n := spaceRows(t, database, `SELECT count(*)::int FROM space_invites WHERE "tokenHash" = $1 AND "acceptedByUserId" = ANY($2) AND "acceptedAt" IS NOT NULL`, tokenHash(token), users); n != 1 {
		t.Fatalf("the link is claimed %d times, want 1", n)
	}
}

// One person opening the same link twice at once joins once; the other open finds them a member.
func TestConcurrentAcceptsByOnePersonJoinOnce(t *testing.T) {
	database := openTestDB(t)
	s := seed(t, database)
	audit := effects.NewRecorder(database, nil)
	ctx := context.Background()
	guest := "guest-" + s.UserID
	addUser(t, database, guest)
	token := "twice-" + s.UserID
	addInvite(t, database, s.Space2, s.UserID, token, time.Now().Add(time.Hour))
	var wg sync.WaitGroup
	start := make(chan struct{})
	failures := make(chan string, 4)
	for range 4 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			if _, failure := spaces.InvitesAccept(ctx, database, audit, db.Actor{UserID: guest, SpaceID: s.Space1}, tokenInput(token)); failure != nil {
				failures <- failure.Code + ":" + failure.Message
			}
		}()
	}
	close(start)
	wg.Wait()
	close(failures)
	for message := range failures {
		t.Fatalf("an open failed: %s", message)
	}
	if n := spaceRows(t, database, `SELECT count(*)::int FROM space_members WHERE "spaceId" = $1 AND "userId" = $2 AND role = 'member'`, s.Space2, guest); n != 1 {
		t.Fatalf("%d memberships, want 1", n)
	}
}

// Someone from outside the organization joins as a guest, in the invited Space alone: the trigger that
// puts every new member in the default Space is undone for any other Space.
func TestAcceptingAnInviteIntoAnotherOrganizationMakesAGuestOfOneSpace(t *testing.T) {
	database := openTestDB(t)
	s := seed(t, database)
	audit := effects.NewRecorder(database, nil)
	ctx := context.Background()
	guest := "guest-" + s.UserID
	addUser(t, database, guest)
	token := "guest-" + s.UserID
	addInvite(t, database, s.Space2, s.UserID, token, time.Now().Add(time.Hour))
	result, failure := spaces.InvitesAccept(ctx, database, audit, db.Actor{UserID: guest, SpaceID: s.Space1}, tokenInput(token))
	if failure != nil {
		t.Fatal(failure)
	}
	if got := result.(map[string]any)["spaceId"]; got != s.Space2 {
		t.Fatalf("spaceId = %v", got)
	}
	// The guest belongs to the organization only through the invited Space: s.Space2 is not the default.
	if got := systemScalar[string](t, database, `SELECT role FROM member WHERE "organizationId" = $1 AND "userId" = $2`, s.OrgID, guest); got != "guest" {
		t.Fatalf("organization role = %q", got)
	}
	if n := spaceRows(t, database, `SELECT count(*)::int FROM space_members WHERE "organizationId" = $1 AND "userId" = $2`, s.OrgID, guest); n != 1 {
		t.Fatalf("the guest belongs to %d Spaces, want only the invited one", n)
	}
	if got := systemScalar[string](t, database, `SELECT role FROM space_members WHERE "spaceId" = $1 AND "userId" = $2`, s.Space2, guest); got != "member" {
		t.Fatalf("space role = %q", got)
	}
	// An invite into the default Space finds the trigger's row, which copied the guest role, and makes it a member's.
	other := "guest2-" + s.UserID
	addUser(t, database, other)
	defaultToken := "default-" + s.UserID
	addInvite(t, database, s.Space1, s.UserID, defaultToken, time.Now().Add(time.Hour))
	if _, failure := spaces.InvitesAccept(ctx, database, audit, db.Actor{UserID: other, SpaceID: s.Space1}, tokenInput(defaultToken)); failure != nil {
		t.Fatal(failure)
	}
	if got := systemScalar[string](t, database, `SELECT role FROM space_members WHERE "spaceId" = $1 AND "userId" = $2`, s.Space1, other); got != "member" {
		t.Fatalf("default Space role = %q", got)
	}
	if n := spaceRows(t, database, `SELECT count(*)::int FROM space_members WHERE "userId" = $1`, other); n != 1 {
		t.Fatalf("%d Space rows for the second guest, want 1", n)
	}
}

// Cancelling every unused link while one is being opened: the opener either got in with a claimed link
// or finds none; never a member of a Space through a link that no longer exists, and the claimed link
// of someone already in survives the cancellation.
func TestCancelAndAcceptRaceNeverLeaveAMemberWithoutAClaimedLink(t *testing.T) {
	database := openTestDB(t)
	s := seed(t, database)
	audit := effects.NewRecorder(database, nil)
	ctx := context.Background()
	for round := range 6 {
		guest := fmt.Sprintf("racer%d-%s", round, s.UserID)
		addUser(t, database, guest)
		token := fmt.Sprintf("cancel%d-%s", round, s.UserID)
		addInvite(t, database, s.Space3, s.UserID, token, time.Now().Add(time.Hour))
		var wg sync.WaitGroup
		start := make(chan struct{})
		wg.Add(2)
		go func() {
			defer wg.Done()
			<-start
			_, _ = spaces.InvitesAccept(ctx, database, audit, db.Actor{UserID: guest, SpaceID: s.Space1}, tokenInput(token))
		}()
		go func() {
			defer wg.Done()
			<-start
			if _, failure := spaces.InvitesCancel(ctx, database, audit, db.Actor{UserID: s.UserID, SpaceID: s.Space1}, raw(`{"spaceId":"`+s.Space3+`"}`)); failure != nil {
				t.Errorf("cancel: %v", failure)
			}
		}()
		close(start)
		wg.Wait()
		member := spaceRows(t, database, `SELECT count(*)::int FROM space_members WHERE "spaceId" = $1 AND "userId" = $2`, s.Space3, guest)
		claimed := spaceRows(t, database, `SELECT count(*)::int FROM space_invites WHERE "tokenHash" = $1 AND "acceptedByUserId" = $2`, tokenHash(token), guest)
		if member != claimed {
			t.Fatalf("round %d: member rows %d but claimed links %d", round, member, claimed)
		}
	}
}

// The Space's deletion lock is the one a deletion and a handover take, keyed as the TypeScript keys it, so
// every write here waits for a holder of that lock.
func TestSpaceWritesWaitForTheDeletionLock(t *testing.T) {
	database := openTestDB(t)
	s := seed(t, database)
	audit := effects.NewRecorder(database, nil)
	member := "member-" + s.UserID
	addUser(t, database, member)
	addOrgMember(t, database, s.OrgID, member, "member")
	dropDefaultSpaceRow(t, database, s.OrgID, member)
	writes := map[string]func() *orpc.Error{
		"rename": func() *orpc.Error {
			_, failure := spaces.Rename(context.Background(), database, audit, db.Actor{UserID: s.UserID, SpaceID: s.Space1}, raw(`{"spaceId":"`+s.Space2+`","name":"Locked"}`))
			return failure
		},
		"members.add": func() *orpc.Error {
			_, failure := spaces.MembersAdd(context.Background(), database, audit, db.Actor{UserID: s.UserID, SpaceID: s.Space1}, raw(`{"spaceId":"`+s.Space2+`","userId":"`+member+`"}`))
			return failure
		},
		"invites.cancel": func() *orpc.Error {
			_, failure := spaces.InvitesCancel(context.Background(), database, audit, db.Actor{UserID: s.UserID, SpaceID: s.Space1}, raw(`{"spaceId":"`+s.Space2+`"}`))
			return failure
		},
	}
	for name, write := range writes {
		holding := make(chan struct{})
		release := make(chan struct{})
		held := make(chan error, 1)
		go func() {
			held <- database.System(context.Background(), "hold the deletion lock", func(tx pgx.Tx) error {
				if _, err := tx.Exec(context.Background(), `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, s.Space2); err != nil {
					return err
				}
				close(holding)
				<-release
				return nil
			})
		}()
		<-holding
		done := make(chan *orpc.Error, 1)
		go func() { done <- write() }()
		select {
		case failure := <-done:
			t.Fatalf("%s finished while the deletion lock was held: %v", name, failure)
		case <-time.After(400 * time.Millisecond):
		}
		close(release)
		if err := <-held; err != nil {
			t.Fatal(err)
		}
		select {
		case failure := <-done:
			if failure != nil {
				t.Fatalf("%s after the lock was released: %v", name, failure)
			}
		case <-time.After(5 * time.Second):
			t.Fatalf("%s never finished once the lock was released", name)
		}
	}
}

// Renaming one Space from three requests at once never surfaces a serialization failure: each is
// rerun, as withTransactionRetry reruns it, and the last one to commit names the Space. (Every
// failed attempt means another request committed, so three attempts cover three requests; with more
// the last would run out of tries, in TypeScript as here.)
func TestConcurrentRenamesAllSucceed(t *testing.T) {
	database := openTestDB(t)
	s := seed(t, database)
	audit := effects.NewRecorder(database, nil)
	var wg sync.WaitGroup
	start := make(chan struct{})
	failures := make(chan string, 3)
	for i := range 3 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			if _, failure := spaces.Rename(context.Background(), database, audit, db.Actor{UserID: s.UserID, SpaceID: s.Space1},
				raw(fmt.Sprintf(`{"spaceId":"%s","name":"Name %d"}`, s.Space2, i))); failure != nil {
				failures <- failure.Message
			}
		}()
	}
	close(start)
	wg.Wait()
	close(failures)
	for message := range failures {
		t.Fatalf("a rename failed: %s", message)
	}
	if got := systemScalar[string](t, database, `SELECT name FROM spaces WHERE id = $1`, s.Space2); !strings.HasPrefix(got, "Name ") {
		t.Fatalf("name = %q", got)
	}
	// One audit row per rename: each is recorded after its own commit.
	if n := spaceRows(t, database, `SELECT count(*)::int FROM audit_events WHERE "spaceId" = $1 AND action = 'space.renamed'`, s.Space2); n != 3 {
		t.Fatalf("%d audit rows, want 3", n)
	}
}

// Adding one person to two Spaces at once while they have room for one more: the row lock on their
// organization membership makes the second wait and then see the limit.
func TestConcurrentAddsRespectTheSpaceLimit(t *testing.T) {
	database := openTestDB(t)
	s := seed(t, database)
	audit := effects.NewRecorder(database, nil)
	member := "limited-" + s.UserID
	addUser(t, database, member)
	addOrgMember(t, database, s.OrgID, member, "member")
	// The trigger already put them in the default Space; 30 more bring them to 31 of 32.
	for i := range 30 {
		id := fmt.Sprintf("fill%d-%s", i, s.UserID)
		exec(t, database, `INSERT INTO spaces (id, "organizationId", name, "isDefault", "createdAt") VALUES ($1, $2, 'Fill', false, now())`, id, s.OrgID)
		addSpaceMemberRow(t, database, id, s.OrgID, member, "member")
	}
	if n := spaceRows(t, database, `SELECT count(*)::int FROM space_members WHERE "organizationId" = $1 AND "userId" = $2`, s.OrgID, member); n != 31 {
		t.Fatalf("setup left %d memberships", n)
	}
	var wg sync.WaitGroup
	start := make(chan struct{})
	outcomes := make(chan string, 2)
	for _, space := range []string{s.Space2, s.Space3} {
		wg.Add(1)
		go func(space string) {
			defer wg.Done()
			<-start
			_, failure := spaces.MembersAdd(context.Background(), database, audit, db.Actor{UserID: s.UserID, SpaceID: s.Space1},
				raw(`{"spaceId":"`+space+`","userId":"`+member+`"}`))
			if failure != nil {
				outcomes <- failure.Message
				return
			}
			outcomes <- "added"
		}(space)
	}
	close(start)
	wg.Wait()
	close(outcomes)
	added, limited := 0, 0
	for outcome := range outcomes {
		switch outcome {
		case "added":
			added++
		case "Space limit reached":
			limited++
		default:
			t.Errorf("unexpected outcome %q", outcome)
		}
	}
	if added != 1 || limited != 1 {
		t.Fatalf("added %d, limited %d; want one of each", added, limited)
	}
	if n := spaceRows(t, database, `SELECT count(*)::int FROM space_members WHERE "organizationId" = $1 AND "userId" = $2`, s.OrgID, member); n != 32 {
		t.Fatalf("%d memberships, want exactly the limit", n)
	}
}

// Adding the same person to a Space from several requests records the addition once: the repeats find
// them a member.
func TestConcurrentAddsOfOnePersonAuditOnce(t *testing.T) {
	database := openTestDB(t)
	s := seed(t, database)
	audit := effects.NewRecorder(database, nil)
	member := "once-" + s.UserID
	addUser(t, database, member)
	addOrgMember(t, database, s.OrgID, member, "member")
	dropDefaultSpaceRow(t, database, s.OrgID, member)
	var wg sync.WaitGroup
	start := make(chan struct{})
	for range 6 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			if _, failure := spaces.MembersAdd(context.Background(), database, audit, db.Actor{UserID: s.UserID, SpaceID: s.Space1},
				raw(`{"spaceId":"`+s.Space2+`","userId":"`+member+`"}`)); failure != nil {
				t.Errorf("add: %v", failure)
			}
		}()
	}
	close(start)
	wg.Wait()
	if n := spaceRows(t, database, `SELECT count(*)::int FROM space_members WHERE "spaceId" = $1 AND "userId" = $2`, s.Space2, member); n != 1 {
		t.Fatalf("%d memberships", n)
	}
	if n := spaceRows(t, database, `SELECT count(*)::int FROM audit_events WHERE "spaceId" = $1 AND action = 'space.member.added' AND "targetId" = $2`, s.Space2, member); n != 1 {
		t.Fatalf("%d audit rows, want 1", n)
	}
}
