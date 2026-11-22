package mcpassignments

// DB-free tests for mcp.assignments.approve: the assignment DTO, the approval-card selection, the
// decision a card race produces, and the pure guards queueMcpConnectedRun applies.

import (
	"fmt"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/orpc"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/messageblocks"
)

// fakeRows serves fixed values to collect and scan, so the DTO shaping runs without a database.
type fakeRows struct {
	rows  [][]any
	index int
}

func (f *fakeRows) Close()                                       {}
func (f *fakeRows) Err() error                                   { return nil }
func (f *fakeRows) CommandTag() pgconn.CommandTag                { return pgconn.CommandTag{} }
func (f *fakeRows) FieldDescriptions() []pgconn.FieldDescription { return nil }
func (f *fakeRows) Next() bool {
	if f.index >= len(f.rows) {
		return false
	}
	f.index++
	return true
}
func (f *fakeRows) Scan(dest ...any) error {
	values := f.rows[f.index-1]
	if len(dest) != len(values) {
		return fmt.Errorf("scan %d fields into %d values", len(values), len(dest))
	}
	for index, target := range dest {
		pointer := reflect.ValueOf(target)
		if pointer.Kind() != reflect.Pointer || pointer.IsNil() {
			return fmt.Errorf("scan target %d is not a pointer", index)
		}
		pointer.Elem().Set(reflect.ValueOf(values[index]))
	}
	return nil
}
func (f *fakeRows) Values() ([]any, error) { return f.rows[f.index-1], nil }
func (f *fakeRows) RawValues() [][]byte    { return nil }
func (f *fakeRows) Conn() *pgx.Conn        { return nil }
func (f *fakeRows) TypeMap() *pgtype.Map   { return nil }

// TestAssignmentDTOShape is BotMcpServerSchema (integrations/mcp.ts:335-343): exactly these keys,
// in mcpAssignmentDto's order, allowedTools as a list of strings, and toISOString timestamps.
func TestAssignmentDTOShape(t *testing.T) {
	at := time.Date(2026, 11, 23, 1, 2, 3, 400_000_000, time.FixedZone("late", 3600))
	found, err := collect(&fakeRows{rows: [][]any{{
		"a1", "b1", "s1", true, []byte(`["search", 7, null, "read"]`), at, at,
	}}})
	if err != nil {
		t.Fatal(err)
	}
	body, err := orpc.Marshal(found[0])
	if err != nil {
		t.Fatal(err)
	}
	want := `{"id":"a1","botId":"b1","serverId":"s1","allowAllTools":true,` +
		`"allowedTools":["search","read"],` +
		`"createdAt":"2026-11-23T00:02:03.400Z","updatedAt":"2026-11-23T00:02:03.400Z"}`
	if string(body) != want {
		t.Fatalf("assignment = %s, want %s", body, want)
	}
}

func TestAssignmentDTOEmptyAllowedTools(t *testing.T) {
	at := time.Date(2026, 11, 23, 0, 0, 0, 0, time.UTC)
	for _, tools := range []string{`null`, `{}`, `"search"`, `[]`} {
		found, err := collect(&fakeRows{rows: [][]any{{"a1", "b1", "s1", true, []byte(tools), at, at}}})
		if err != nil {
			t.Fatal(err)
		}
		body, err := orpc.Marshal(found[0])
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(string(body), `"allowedTools":[]`) {
			t.Errorf("allowedTools %s = %s, want []", tools, body)
		}
	}
}

// TestAssignmentDTOOutputInvalid is the router's output parse: a tool name the schema refuses
// (1 to 200 characters) fails the whole call instead of being written to the wire.
func TestAssignmentDTOOutputInvalid(t *testing.T) {
	at := time.Date(2026, 11, 23, 0, 0, 0, 0, time.UTC)
	for _, tools := range []string{`[""]`, `["` + strings.Repeat("x", 201) + `"]`} {
		_, err := collect(&fakeRows{rows: [][]any{{"a1", "b1", "s1", true, []byte(tools), at, at}}})
		failure, ok := err.(*orpc.Error)
		if !ok || failure.Code != "INTERNAL_SERVER_ERROR" || failure.Message != "Output validation failed" {
			t.Errorf("allowedTools %s = %v, want the output-validation failure", tools, err)
		}
	}
}

// TestParseApprove is z.object({ botId: Id, serverId: Id, threadId: Id.optional() }): the chat is
// optional, but a sent threadId is a non-empty string and null is not "absent".
func TestParseApprove(t *testing.T) {
	cases := []struct {
		body    string
		thread  *string
		failure bool
	}{
		{`{"botId":"b","serverId":"s"}`, nil, false},
		{`{"botId":"b","serverId":"s","threadId":"t","extra":1}`, new("t"), false},
		{`{"botId":"b","serverId":"s","threadId":null}`, nil, true},
		{`{"botId":"b","serverId":"s","threadId":""}`, nil, true},
		{`{"botId":"","serverId":"s"}`, nil, true},
		{`{"botId":"b"}`, nil, true},
		{`{}`, nil, true},
	}
	for _, testCase := range cases {
		input, failure := parseApprove(orpc.Input{Raw: []byte(testCase.body)})
		if testCase.failure {
			if failure == nil || failure.Code != "BAD_REQUEST" || failure.Message != "Input validation failed" {
				t.Errorf("%s = %v, want a validation failure", testCase.body, failure)
			}
			continue
		}
		if failure != nil {
			t.Errorf("%s failed: %v", testCase.body, failure)
			continue
		}
		if input.botID != "b" || input.serverID != "s" {
			t.Errorf("%s = %+v", testCase.body, input)
		}
		if testCase.thread == nil {
			if input.threadID != nil {
				t.Errorf("%s threadId = %q, want absent", testCase.body, *input.threadID)
			}
		} else if input.threadID == nil || *input.threadID != *testCase.thread {
			t.Errorf("%s threadId = %v, want %q", testCase.body, input.threadID, *testCase.thread)
		}
	}
}

func TestApprovalCardSelection(t *testing.T) {
	card := func(status any) map[string]any {
		block := map[string]any{"kind": "mcp_approval", "serverId": "s1"}
		if status != nil {
			block["status"] = status
		}
		return block
	}
	cases := []struct {
		name      string
		blocks    []map[string]any
		present   bool
		connected bool
		dismissed bool
		// threadScoped is the card decision (threadId passed); settings is the surface approval.
		threadScoped bool
		settings     bool
	}{
		{"not a card", []map[string]any{{"kind": "text", "text": "hi"}}, false, false, false, false, false},
		{"another server", []map[string]any{{"kind": "mcp_approval", "serverId": "s2"}}, false, false, false, false, false},
		{"pending", []map[string]any{card("pending")}, true, false, false, true, true},
		{"missing status reads as pending", []map[string]any{card(nil)}, true, false, false, true, true},
		{"unknown status still open", []map[string]any{card("waiting")}, true, false, false, true, true},
		{"connected", []map[string]any{card("connected")}, true, true, false, false, false},
		{"dismissed", []map[string]any{card("dismissed")}, true, false, true, false, true},
		{
			"connected beside dismissed", []map[string]any{card("connected"), card("dismissed")},
			true, true, true, false, true,
		},
	}
	for _, testCase := range cases {
		for _, scoped := range []struct {
			label             string
			threadScopedValue bool
			want              bool
		}{{"thread", true, testCase.threadScoped}, {"settings", false, testCase.settings}} {
			cards := readCards(testCase.blocks, "s1", selectableFor(scoped.threadScopedValue))
			if cards.present != testCase.present || cards.connected != testCase.connected ||
				cards.dismissed != testCase.dismissed || cards.selectable != scoped.want {
				t.Errorf("%s (%s) = %+v, want present=%v connected=%v dismissed=%v selectable=%v",
					testCase.name, scoped.label, cards, testCase.present, testCase.connected,
					testCase.dismissed, scoped.want)
			}
		}
	}
}

// TestDecide is resolveMcpApprovalCards' decision: a dismissal that already won a card race must
// not assign, but a connected card (an earlier approval) is not a dismissal.
func TestDecide(t *testing.T) {
	cases := []struct {
		name         string
		threadScoped bool
		resolution   painted
		assign       bool
		resolved     bool
	}{
		{"dismissal won the card race", true, painted{dismissed: true}, false, false},
		{"connected card is a repeat decision", true, painted{connected: true, dismissed: true}, true, false},
		{"settings approval still assigns", false, painted{dismissed: true}, true, false},
		{"flipped a card", true, painted{flipped: 1}, true, true},
		{"flipped beside a dismissal", true, painted{flipped: 2, dismissed: true}, true, true},
		{"nothing seen, nothing to assign", false, painted{}, true, false},
	}
	for _, testCase := range cases {
		decision := decide(testCase.threadScoped, testCase.resolution)
		if decision.assign != testCase.assign || decision.resolved != testCase.resolved {
			t.Errorf("%s = %+v, want assign=%v resolved=%v",
				testCase.name, decision, testCase.assign, testCase.resolved)
		}
	}
}

// TestQueueThreadScope is queueMcpConnectedRun's thread predicate: the bot's own chat, or a group
// that is not archived and still has the bot as a member.
func TestQueueThreadScope(t *testing.T) {
	cases := []struct {
		name   string
		thread queueThread
		want   bool
	}{
		{"own chat", queueThread{BotID: new("b1")}, true},
		{"another bot's chat", queueThread{BotID: new("b2")}, false},
		{"live group with the bot", queueThread{GroupID: new("g1"), live: true, member: true}, true},
		{"archived group", queueThread{GroupID: new("g1"), live: false, member: true}, false},
		{"group without the bot", queueThread{GroupID: new("g1"), live: true, member: false}, false},
		{"neither chat nor group", queueThread{}, false},
		{"stray group state", queueThread{live: true, member: true}, false},
	}
	for _, testCase := range cases {
		if got := inThreadScope(testCase.thread, "b1"); got != testCase.want {
			t.Errorf("%s = %v, want %v", testCase.name, got, testCase.want)
		}
	}
}

// TestRepaintKeepsTheRowsOwnList is changeMessageBlocks over a stored list: only this server's
// selectable cards are repainted, the row's entries that are not blocks survive the write-back,
// and the stored block is not mutated.
func TestRepaintKeepsTheRowsOwnList(t *testing.T) {
	pending := map[string]any{"kind": "mcp_approval", "serverId": "s1", "status": "pending"}
	dismissed := map[string]any{"kind": "mcp_approval", "serverId": "s1", "status": "dismissed"}
	other := map[string]any{"kind": "mcp_approval", "serverId": "s2", "status": "pending"}
	text := map[string]any{"kind": "text", "text": "before"}
	raw := []any{"not-a-block", text, other, pending, dismissed}
	stored, shown, changed, ok := messageblocks.Rewrite(raw, repaint("s1", selectableFor(true)))
	if !ok || !changed {
		t.Fatalf("rewrite = ok %v changed %v, want a change", ok, changed)
	}
	if stored[0] != "not-a-block" {
		t.Errorf("stored[0] = %v, want the row's non-block entry kept", stored[0])
	}
	if len(shown) != 4 || shown[0]["kind"] != "text" {
		t.Fatalf("shown = %v, want the four blocks", shown)
	}
	if shown[2]["status"] != "connected" {
		t.Errorf("pending card = %v, want connected", shown[2])
	}
	if shown[3]["status"] != "dismissed" {
		t.Errorf("dismissed card = %v, want the dismissal kept", shown[3])
	}
	if pending["status"] != "pending" {
		t.Errorf("stored card was mutated: %v", pending)
	}
	// The settings approval repaints a dismissed card too.
	_, settings, changed, ok := messageblocks.Rewrite(raw, repaint("s1", selectableFor(false)))
	if !ok || !changed || settings[3]["status"] != "connected" {
		t.Errorf("settings rewrite = ok %v changed %v shown %v", ok, changed, settings)
	}
	connected := []any{map[string]any{"kind": "mcp_approval", "serverId": "s1", "status": "connected"}}
	if _, _, changed, ok := messageblocks.Rewrite(connected, repaint("s1", selectableFor(true))); !ok || changed {
		t.Errorf("a connected card changed = %v (ok %v), want no change", changed, ok)
	}
	if _, _, _, ok := messageblocks.Rewrite("not-a-list", repaint("s1", selectableFor(true))); ok {
		t.Error("a row whose blocks are not a list must not be written")
	}
}

func TestBotLive(t *testing.T) {
	if !botLive(nil) {
		t.Error("an unarchived bot must take the connected run")
	}
	archived := time.Date(2026, 11, 23, 0, 0, 0, 0, time.UTC)
	if botLive(&archived) {
		t.Error("an archived bot must not take the connected run")
	}
}

// TestChatHolding is runHoldsChat: ticket work and a routine running beside its chat never hold
// the chat; every other queue-holding run does.
func TestChatHolding(t *testing.T) {
	cases := []struct {
		trigger string
		inChat  *bool
		want    bool
	}{
		{"user", nil, true},
		{"follow_up", nil, true},
		{"webhook", nil, true},
		{"tickets", nil, false},
		{"routine", new(false), false},
		{"routine", new(true), true},
		{"routine", nil, true},
	}
	for _, testCase := range cases {
		if got := chatHolding(testCase.trigger, testCase.inChat); got != testCase.want {
			t.Errorf("chatHolding(%q, %v) = %v, want %v", testCase.trigger, testCase.inChat, got, testCase.want)
		}
	}
}

// TestMcpConnectedPrompt is mcpConnectedPrompt: the server name is JSON.stringify'd into the
// hidden prompt.
func TestMcpConnectedPrompt(t *testing.T) {
	prefix := "The user just connected the MCP server "
	suffix := " from its approval card, so its tools are available now. Carry on with what they asked for." +
		" If nothing is left to do, confirm in one short sentence."
	cases := []struct{ name, quoted string }{
		{"plain", `"plain"`},
		{`He said "hi"`, `"He said \"hi\""`},
		{"line\nbreak", `"line\nbreak"`},
		{"tab\there", `"tab\there"`},
		{"below\u0001control", `"below\u0001control"`},
		{"back\\slash", `"back\\slash"`},
		{"😀", `"😀"`},
	}
	for _, testCase := range cases {
		want := prefix + testCase.quoted + suffix
		if got := mcpConnectedPrompt(testCase.name); got != want {
			t.Errorf("mcpConnectedPrompt(%q) = %q, want %q", testCase.name, got, want)
		}
	}
}
