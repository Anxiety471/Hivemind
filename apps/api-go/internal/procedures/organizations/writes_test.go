package organizations

import (
	"encoding/json"
	"testing"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/orpc"
)

func rawInput(text string) orpc.Input { return orpc.Input{Raw: json.RawMessage(text)} }

func TestParseRoleAcceptsEveryNonOwnerRole(t *testing.T) {
	for _, role := range []string{"admin", "member"} {
		parsed, failure := parseRole(rawInput(`{"organizationId":"o","userId":"u","role":"` + role + `"}`))
		if failure != nil || parsed.Role != role || parsed.OrganizationID != "o" || parsed.UserID != "u" {
			t.Fatalf("%s: %+v %v", role, parsed, failure)
		}
	}
	// OrganizationRoleSchema.exclude(["owner"]): the owner's role never changes through this route.
	for _, bad := range []string{
		`{"organizationId":"o","userId":"u","role":"owner"}`,
		`{"organizationId":"o","userId":"u","role":"guest"}`,
		`{"organizationId":"o","userId":"","role":"admin"}`,
		`{"organizationId":"","userId":"u","role":"admin"}`,
		`{"organizationId":"o","userId":"u"}`,
		`{"organizationId":"o","userId":"u","role":1}`,
		`[]`,
	} {
		if _, failure := parseRole(rawInput(bad)); failure == nil || failure.Code != "BAD_REQUEST" {
			t.Errorf("%s must be refused", bad)
		}
	}
}

func TestParseCancelInvitationNeedsBothIds(t *testing.T) {
	parsed, failure := parseCancelInvitation(rawInput(`{"organizationId":"o","invitationId":"i"}`))
	if failure != nil || parsed.OrganizationID != "o" || parsed.InvitationID != "i" {
		t.Fatalf("%+v %v", parsed, failure)
	}
	for _, bad := range []string{`{"organizationId":"o"}`, `{"invitationId":"i"}`, `{"organizationId":"","invitationId":"i"}`, `null`} {
		if _, failure := parseCancelInvitation(rawInput(bad)); failure == nil {
			t.Errorf("%s must be refused", bad)
		}
	}
}

func TestManagerRulesAnswerLikeTypeScript(t *testing.T) {
	// The three answers requireManager and setRole can give (organization-members.ts:28-60,132-140).
	if errAdminRequired.Status != 403 || errAdminRequired.Message != "Only the organization's owner and admins can do that" {
		t.Fatalf("admin required = %+v", errAdminRequired)
	}
	if errMemberMissing.Status != 404 || errMemberMissing.Message != "Member not found" {
		t.Fatalf("member missing = %+v", errMemberMissing)
	}
	if errOwnerUnchangeable.Status != 400 || errOwnerUnchangeable.Message != "The organization's owner cannot be removed or given another role" {
		t.Fatalf("owner unchangeable = %+v", errOwnerUnchangeable)
	}
}
