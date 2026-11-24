package externalconversations

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/orpc"
)

func parseText(t *testing.T, text string) (policy, string, *orpc.Error) {
	t.Helper()
	return parse(orpc.Input{Raw: json.RawMessage(text)})
}

func issueMessages(failure *orpc.Error) []string {
	var messages []string
	for _, issue := range failure.Data.(map[string]any)["issues"].([]map[string]any) {
		messages = append(messages, issue["message"].(string))
	}
	return messages
}

func TestParseOutputTrimsKeysAndNamesAndMergesCollisions(t *testing.T) {
	got, id, failure := parseText(t, `{"externalConversationId":"c","teamChatAmbientEnabled":null,"teamChatRules":"r\u0000",
		"automatedSenderPolicies":{" a ":{"name":" n ","mode":"ignore","extra":1},"a":{"name":"m","mode":"rollup","rollupHours":3},"__proto__":{"name":"x","mode":"ignore"},"2":{"name":"two","mode":"user"}}}`)
	if failure != nil || id != "c" {
		t.Fatalf("failure = %v", failure)
	}
	if got.Ambient != nil || got.Rules == nil || *got.Rules != "r\x00" {
		t.Fatalf("policy = %+v", got)
	}
	want := `{"2":{"name":"two","mode":"user"},"a":{"name":"m","mode":"rollup","rollupHours":3}}`
	if text := policiesJSON(got.Policies, false); text != want {
		t.Fatalf("policies = %s want %s", text, want)
	}
	// The stored copy has NUL replaced and colliding keys told apart.
	stored := policiesJSON([]policyEntry{{"\x00a", senderPolicy{"n\x00", "ignore", nil}}, {"\uFFFDa", senderPolicy{"m", "user", nil}}}, true)
	if stored != `{"�a":{"name":"n�","mode":"ignore"},"�a#2":{"name":"m","mode":"user"}}` {
		t.Fatalf("stored = %s", stored)
	}
	// A raw key that equals a generated suffix overwrites that entry in place, as
	// sanitizeJsonValue's own-property assignment does (Node output for this vector).
	collision := policiesJSON([]policyEntry{
		{"a\x00", senderPolicy{"one", "ignore", nil}},
		{"a\uFFFD", senderPolicy{"two", "ignore", nil}},
		{"a\uFFFD#2", senderPolicy{"three", "ignore", nil}},
	}, true)
	if collision != `{"a�":{"name":"one","mode":"ignore"},"a�#2":{"name":"three","mode":"ignore"}}` {
		t.Fatalf("collision = %s", collision)
	}
}

func TestParseReportsTheSameIssuesAsZod(t *testing.T) {
	for name, tc := range map[string]struct {
		input string
		want  []string
	}{
		"types": {`{"externalConversationId":"","teamChatAmbientEnabled":"y","teamChatRules":5,"automatedSenderPolicies":{}}`, []string{
			"Invalid input: expected boolean, received string", "Invalid input: expected string, received number", "Too small: expected string to have >=1 characters"}},
		"missing": {`{"externalConversationId":"c","teamChatRules":null,"automatedSenderPolicies":[]}`, []string{
			"Invalid input: expected boolean, received undefined", "Invalid input: expected record, received array"}},
		"rollup": {`{"externalConversationId":"c","teamChatAmbientEnabled":true,"teamChatRules":null,"automatedSenderPolicies":{"a":{"name":"n","mode":"rollup"}}}`, []string{rollupNeedsHours}},
		"rollup type error stops the refinement": {`{"externalConversationId":"c","teamChatAmbientEnabled":true,"teamChatRules":null,"automatedSenderPolicies":{"a":{"name":5,"mode":"rollup"}}}`, []string{
			"Invalid input: expected string, received number"}},
		"hours": {`{"externalConversationId":"c","teamChatAmbientEnabled":true,"teamChatRules":null,"automatedSenderPolicies":{"a":{"name":"n","mode":"ignore","rollupHours":721}}}`, []string{
			"Too big: expected number to be <=720"}},
		"empty key": {`{"externalConversationId":"c","teamChatAmbientEnabled":true,"teamChatRules":null,"automatedSenderPolicies":{"  ":{"name":"n","mode":"ignore"}}}`, []string{"Invalid key in record"}},
	} {
		_, _, failure := parseText(t, tc.input)
		if failure == nil {
			t.Fatalf("%s: accepted", name)
		}
		got := issueMessages(failure)
		if strings.Join(got, "|") != strings.Join(tc.want, "|") {
			t.Errorf("%s: %q want %q", name, got, tc.want)
		}
	}
	var many strings.Builder
	many.WriteString(`{"externalConversationId":"c","teamChatAmbientEnabled":true,"teamChatRules":null,"automatedSenderPolicies":{`)
	for i := 0; i < 51; i++ {
		if i > 0 {
			many.WriteByte(',')
		}
		many.WriteString(`"k` + string(rune('a'+i%26)) + string(rune('a'+i/26)) + `":{"name":"n","mode":"ignore"}`)
	}
	many.WriteString(`}}`)
	if _, _, failure := parseText(t, many.String()); failure == nil || issueMessages(failure)[0] != policiesTooMany {
		t.Fatalf("51 entries = %v", failure)
	}
}
