package effects

import (
	"encoding/json"
	"reflect"
	"regexp"
	"strings"
	"testing"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
)

func TestClientIPResolver(t *testing.T) {
	resolver, err := NewClientIPResolver([]string{"127.0.0.1", "::1", "10.0.0.0/8"})
	if err != nil {
		t.Fatal(err)
	}
	cases := []struct{ name, peer, forwarded, want string }{
		{"direct peer", "203.0.113.7", "", "203.0.113.7"},
		{"untrusted peer cannot choose its address", "203.0.113.7", "198.51.100.1", "203.0.113.7"},
		{"trusted peer, client in header", "127.0.0.1", "198.51.100.1", "198.51.100.1"},
		{"hops skipped right to left", "127.0.0.1", "198.51.100.1, 10.1.2.3, 127.0.0.1", "198.51.100.1"},
		{"spoofed left hop is not reached", "127.0.0.1", "1.1.1.1, 198.51.100.1", "198.51.100.1"},
		{"all hops trusted", "127.0.0.1", "10.0.0.1, 10.0.0.2", "10.0.0.1"},
		{"malformed chain falls back to the peer", "127.0.0.1", "198.51.100.1, nonsense", "127.0.0.1"},
		{"port stripped", "127.0.0.1", "198.51.100.1:5555", "198.51.100.1"},
		{"bracketed v6", "::1", "[2001:db8::1]:443", "2001:db8::1"},
		{"mapped v4 peer", "::ffff:127.0.0.1", "198.51.100.1", "198.51.100.1"},
		{"not an address", "unix", "198.51.100.1", ""},
	}
	for _, c := range cases {
		if got := resolver.Resolve(c.peer, c.forwarded); got != c.want {
			t.Errorf("%s: got %q want %q", c.name, got, c.want)
		}
	}
	if _, err := NewClientIPResolver([]string{"10.0.0.0/33"}); err == nil {
		t.Error("a /33 prefix must be refused")
	}
	if _, err := NewClientIPResolver([]string{"not an entry!"}); err == nil {
		t.Error("garbage must be refused")
	}
	none, _ := NewClientIPResolver([]string{"none"})
	if got := none.Resolve("127.0.0.1", "198.51.100.1"); got != "127.0.0.1" {
		t.Errorf("none trusts no proxy, got %q", got)
	}
	if got := ParseTrustedProxies(" 10.0.0.1,\n::1  loopback "); !reflect.DeepEqual(got, []string{"10.0.0.1", "::1", "loopback"}) {
		t.Errorf("parse = %v", got)
	}
}

func TestNewIDHasCuidShape(t *testing.T) {
	shape := regexp.MustCompile(`^c[0-9a-z]{24}$`)
	seen := map[string]bool{}
	for i := 0; i < 2000; i++ {
		id := NewID()
		if !shape.MatchString(id) || seen[id] {
			t.Fatalf("bad or repeated id %q", id)
		}
		seen[id] = true
	}
}

func TestSpendingLimitSetIsAuditedWithTheTypeScriptMetadata(t *testing.T) {
	actor := db.Actor{UserID: "u1", SpaceID: "s1"}
	event, ok := SecurityEventFor("spendingLimit.set", map[string]any{"limit": map[string]any{"amount": 5.0, "currency": "usd", "period": "week"}}, actor)
	if !ok || event.Type != "approval.policy.changed" || event.UserID != "u1" || event.SpaceID != "s1" {
		t.Fatalf("event = %+v", event)
	}
	want := []Meta{{"procedure", "spendingLimit.set"}, {"kind", "spending_limit"}, {"currency", "usd"}, {"period", "week"}}
	if !reflect.DeepEqual(event.Metadata, want) {
		t.Fatalf("metadata = %v", event.Metadata)
	}
	removed, _ := SecurityEventFor("spendingLimit.set", map[string]any{"limit": nil}, actor)
	if !reflect.DeepEqual(removed.Metadata, want[:2]) {
		t.Fatalf("removal metadata = %v", removed.Metadata)
	}
	if _, ok := SecurityEventFor("spendingLimit.get", nil, actor); ok {
		t.Error("get is not audited")
	}
}

func TestRosterAndSpaceChangeTables(t *testing.T) {
	actor := db.Actor{UserID: "u1", SpaceID: "s1"}
	check := func(procedure string, input map[string]any, output any, want RosterChange) {
		t.Helper()
		got, ok := RosterChangeFor(procedure, actor, input, output)
		if !ok || !reflect.DeepEqual(got, want) {
			t.Errorf("%s = %+v ok=%v, want %+v", procedure, got, ok, want)
		}
	}
	check("botSections.create", nil, nil, RosterChange{SpaceIDs: []string{"s1"}})
	check("organizations.create", nil, nil, RosterChange{UserIDs: []string{"u1"}})
	check("spaces.rename", map[string]any{"spaceId": "s9"}, nil, RosterChange{SpaceIDs: []string{"s9"}, UserIDs: []string{"u1"}})
	check("spaces.members.add", map[string]any{"spaceId": "s9", "userId": "u2"}, nil, RosterChange{SpaceIDs: []string{"s9"}, UserIDs: []string{"u1", "u2"}})
	check("spaces.invites.accept", nil, map[string]any{"spaceId": "s7"}, RosterChange{SpaceIDs: []string{"s7"}, UserIDs: []string{"u1"}})
	check("spaces.invites.accept", nil, struct {
		SpaceID string `json:"spaceId"`
	}{"s8"}, RosterChange{SpaceIDs: []string{"s8"}, UserIDs: []string{"u1"}})
	if _, ok := RosterChangeFor("botSections.list", actor, nil, nil); ok {
		t.Error("list is not a roster change")
	}
	if !reflect.DeepEqual(SpaceChangesFor("bots.remove"), []string{"runs", "routines"}) || SpaceChangesFor("botSections.create") != nil {
		t.Error("space change table")
	}
}

func TestMetadataKeepsOnlyWhatTypeScriptKeeps(t *testing.T) {
	long := strings.Repeat("a", 250)
	got, err := securityEventMetadata([]Meta{
		{"procedure", "x.y"}, {"email", "a"}, {"promptText", "a"}, {"nothing", nil}, {"flag", true},
		{"count", int64(3)}, {"long", long}, {strings.Repeat("k", 65), "v"}, {"query", "plain"},
	})
	if err == nil {
		// "long" is 250 safe characters, cut to 200 before redaction; nothing here needs the TS redactor.
		if got["long"] != long[:200] || got["email"] != nil || got["promptText"] != nil || got["nothing"] != nil || got["flag"] != true || got["count"] != int64(3) {
			t.Fatalf("metadata = %v", got)
		}
		if got["query"] != "[Redacted]" {
			t.Errorf("a redacted key's value is replaced: %v", got["query"])
		}
		if _, present := got[strings.Repeat("k", 65)]; present {
			t.Error("a key over 64 characters is dropped")
		}
	} else {
		t.Fatal(err)
	}
	var many []Meta
	for i := 0; i < 20; i++ {
		many = append(many, Meta{Key: "k" + string(rune('a'+i)), Value: "v"})
	}
	if got, _ := securityEventMetadata(many); len(got) != 16 {
		t.Errorf("the first sixteen keys are kept, got %d", len(got))
	}
}

func TestRedactionGateRefusesWhatItCannotProve(t *testing.T) {
	for _, safe := range []string{"", "usd", "spendingLimit.set", "spending_limit", "week", "ckabc123", "a-b.c_d"} {
		if got, err := redactText(safe); err != nil || got != safe {
			t.Errorf("%q should pass: %v", safe, err)
		}
	}
	for _, risky := range []string{"a@b.co", "sk-abcdefghijkl", "SK_abc", "ak_1", "ck_x", "eyJhbGci", "has space", "x:y", "a/b", "my-token", "Password1", "emailish"} {
		if _, err := redactText(risky); err == nil {
			t.Errorf("%q must be refused", risky)
		}
	}
}

func TestSliceUTF16(t *testing.T) {
	if got := sliceUTF16("abcdef", 3); got != "abc" {
		t.Error(got)
	}
	// slice(0, 2) of "a😀b" keeps 'a' and the pair's high half; the write sanitizer turns that
	// lone half into U+FFFD (text-sanitization.ts:58).
	if got := sliceUTF16("a😀b", 2); got != "a\uFFFD" {
		t.Errorf("a split pair becomes U+FFFD: %q", got)
	}
	if got := sliceUTF16("a😀b", 3); got != "a😀" {
		t.Errorf("got %q", got)
	}
}

func TestEnvelopeMatchesJSONStringify(t *testing.T) {
	body, err := Envelope("roster-space:s1", "")
	if err != nil || string(body) != `{"topic":"roster-space:s1","payload":""}` {
		t.Fatalf("%s %v", body, err)
	}
	if _, err := Envelope(strings.Repeat("t", 8000), ""); err == nil {
		t.Error("an oversized signal must be refused")
	}
}

func TestSettingsProceduresAreAuditedWithTheTypeScriptMetadata(t *testing.T) {
	actor := db.Actor{UserID: "u1", SpaceID: "s1"}
	rule, ok := SecurityEventFor("approvalRules.set", map[string]any{"effect": "deny", "matchKind": "tool", "matchValue": "bash", "scope": "space"}, actor)
	want := []Meta{{"procedure", "approvalRules.set"}, {"effect", "deny"}, {"matchKind", "tool"}}
	if !ok || rule.Type != "approval.policy.changed" || !reflect.DeepEqual(rule.Metadata, want) {
		t.Fatalf("approvalRules.set = %+v", rule)
	}
	override, ok := SecurityEventFor("spaceSettings.setOverride", map[string]any{"setting": "credentials", "enabled": false}, actor)
	want = []Meta{{"procedure", "spaceSettings.setOverride"}, {"setting", "credentials"}, {"enabled", false}}
	if !ok || !reflect.DeepEqual(override.Metadata, want) {
		t.Fatalf("spaceSettings.setOverride = %+v", override)
	}
	// Every value an enum can produce passes the gate; the one its word list would refuse is
	// listed as known safe, and nothing else containing the word is.
	kept, err := securityEventMetadata(override.Metadata)
	if err != nil || kept["setting"] != "credentials" {
		t.Fatalf("credentials must be recorded as is: %v %v", kept, err)
	}
	for _, value := range []string{"models", "voice", "confirmations", "always_allow", "require_approval", "deny", "tool", "connector", "site"} {
		if _, err := redactText(value); err != nil {
			t.Errorf("%s must pass the gate: %v", value, err)
		}
	}
	for _, value := range []string{"credentials2", "my-credentials", "Credentials"} {
		if _, err := redactText(value); err == nil {
			t.Errorf("%s must stay refused", value)
		}
	}
	// approvalRules.remove records the caller's own id, which the gate cannot prove safe: not served.
	if _, ok := SecurityEventFor("approvalRules.remove", map[string]any{"id": "x"}, actor); ok {
		t.Error("approvalRules.remove is not served here")
	}
}

func TestBoardEventCarriesOnlyTheNamedIds(t *testing.T) {
	// BoardEventSchema (packages/contracts/src/board.ts:155-161): the optional ids are absent when
	// the change has none, in this key order, as JSON.stringify writes them.
	event := BoardEvent{SpaceID: "space", TicketID: "ticket", CreatedAt: "2026-01-02T03:04:05.678Z"}
	body, err := json.Marshal(event)
	if err != nil {
		t.Fatal(err)
	}
	want := `{"spaceId":"space","ticketId":"ticket","createdAt":"2026-01-02T03:04:05.678Z"}`
	if string(body) != want {
		t.Fatalf("board event = %s", body)
	}
	both, _ := json.Marshal(BoardEvent{SpaceID: "space", BoardID: "board", TicketID: "ticket", CreatedAt: "x"})
	if string(both) != `{"spaceId":"space","boardId":"board","ticketId":"ticket","createdAt":"x"}` {
		t.Fatalf("board event with both ids = %s", both)
	}
}
