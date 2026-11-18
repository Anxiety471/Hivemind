package organizations

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/orpc"
)

func input(text string) orpc.Input { return orpc.Input{Raw: json.RawMessage(text)} }

func TestParseRenameTrimsAndReportsEveryIssue(t *testing.T) {
	id, name, failure := parseRename(input(`{"organizationId":"o1","name":"  Acme  ","more":true}`))
	if failure != nil || id != "o1" || name != "Acme" {
		t.Fatalf("parsed = %q %q %v", id, name, failure)
	}
	_, _, failure = parseRename(input(`{"organizationId":"","name":"` + strings.Repeat("x", 61) + `"}`))
	if failure == nil || failure.Code != "BAD_REQUEST" || failure.Message != "Input validation failed" {
		t.Fatalf("failure = %+v", failure)
	}
	body, _ := orpc.Marshal(failure.Data)
	text := string(body)
	if !strings.Contains(text, `"path":["organizationId"]`) || !strings.Contains(text, `"code":"too_big"`) ||
		strings.Index(text, `"organizationId"`) > strings.Index(text, `"path":["name"]`) {
		t.Fatalf("issues = %s", text)
	}
}

func TestInvitationErrorsAnswerAsTheTypeScriptErrorsDo(t *testing.T) {
	for _, c := range []struct {
		failure *orpc.Error
		code    string
		status  int
	}{
		{errInvitationNotFound, "NOT_FOUND", 404},
		{errInvitationMismatch, "INVITATION_EMAIL_MISMATCH", 403},
		{errEmailNotVerified, "EMAIL_NOT_VERIFIED", 403},
		{errInvalidName, "BAD_REQUEST", 400},
	} {
		if c.failure.Code != c.code || c.failure.Status != c.status {
			t.Errorf("%s = %d %s", c.code, c.failure.Status, c.failure.Code)
		}
	}
}
