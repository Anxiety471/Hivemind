package mcpservers

// DB-free tests for the MCP server DTO, the OAuth summary and the material edits
// mcp.oauth.disconnect performs: JavaScript key order, generation arithmetic and the
// output-schema checks the router applies.

import (
	"testing"
	"time"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/orpc"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/validate"
)

func decode(t *testing.T, text string) any {
	t.Helper()
	value, err := validate.DecodeAny([]byte(text))
	if err != nil {
		t.Fatalf("decode %q: %v", text, err)
	}
	return value
}

func TestSummarizeOAuthStates(t *testing.T) {
	for _, testCase := range []struct {
		name   string
		text   string
		status string
		client *string
	}{
		{"none", `{}`, "none", nil},
		{"connected", `{"oauth":{"tokens":{"access_token":"a"}}}`, "connected", nil},
		{"reconnect", `{"oauth":{"clientInformation":{}}}`, "reconnect", nil},
		{"empty-tokens-reconnect", `{"oauth":{"tokens":""}}`, "reconnect", nil},
		{"primitive-oauth-reconnect", `{"oauth":true}`, "reconnect", nil},
		{"client", `{"oauthClient":{"client_id":"c1"}}`, "none", ptr("c1")},
		{"null-client", `{"oauthClient":{"client_id":null}}`, "none", nil},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			summary, failure := Summarize(decode(t, testCase.text))
			if failure != nil {
				t.Fatalf("summarize failed: %+v", failure)
			}
			if summary.Status != testCase.status {
				t.Errorf("status = %q, want %q", summary.Status, testCase.status)
			}
			if !sameText(summary.ClientID, testCase.client) {
				t.Errorf("client = %v, want %v", summary.ClientID, testCase.client)
			}
		})
	}
}

func TestSummarizeNonStringClientIsAnOutputFailure(t *testing.T) {
	_, failure := Summarize(decode(t, `{"oauthClient":{"client_id":5}}`))
	if failure == nil || failure.Error() != "INTERNAL_SERVER_ERROR: Output validation failed" {
		t.Fatalf("failure = %v, want Output validation failed", failure)
	}
}

func TestSummarizeCredential(t *testing.T) {
	for _, testCase := range []struct {
		text string
		want bool
	}{
		{`{}`, false},
		{`{"secret":"s"}`, true},
		{`{"secret":""}`, false},
		{`{"args":["a"]}`, true},
		{`{"args":""}`, false},
		{`{"env":{"A":"1"}}`, true},
		{`{"files":{}}`, false},
		{`{"headers":{"X":"1"}}`, true},
		{`{"oauthClient":{}}`, true},
		{`{"oauth":{}}`, true},
		{`{"oauthGeneration":3}`, false},
		{`{"args":{"length":"x"}}`, true},
		{`{"args":{"length":-1}}`, true},
		{`{"args":{"length":1e999}}`, true},
		{`{"args":{"length":-1e999}}`, true},
		{`{"args":{"length":0e999}}`, false},
		{`{"args":{"length":1e-999}}`, false},
		{`{"args":{"length":0}}`, false},
		{`{"args":{"length":null}}`, false},
		{`{"args":{"length":""}}`, false},
	} {
		summary, failure := Summarize(decode(t, testCase.text))
		if failure != nil {
			t.Fatalf("%s: %+v", testCase.text, failure)
		}
		if summary.Credential != testCase.want {
			t.Errorf("%s: credential = %v, want %v", testCase.text, summary.Credential, testCase.want)
		}
	}
}

func TestServerDTOShapeAndChecks(t *testing.T) {
	at := time.Date(2026, 11, 23, 1, 2, 3, 400_000_000, time.UTC)
	record := Record{
		id: "s1", spaceID: "sp1", slug: "slug", name: "Server", description: "",
		transport: "stdio", command: ptr("run"), args: []byte(`["a"]`), env: []byte(`{"B":true,"A":true}`),
		files: []byte(`{}`), headers: []byte(`{}`), revision: 2, enabled: true,
		healthStatus: "error", healthMessage: ptr(dynamicRegistrationUnsupported),
		createdAt: at, updatedAt: at,
	}
	summary := OAuthSummary{Status: "none", Credential: false}
	server, failure := ServerDTO(record, []string{"sp1"}, summary)
	if failure != nil {
		t.Fatalf("dto failed: %+v", failure)
	}
	body, err := orpc.Marshal(server)
	if err != nil {
		t.Fatal(err)
	}
	want := `{"id":"s1","spaceId":"sp1","installId":null,"slug":"slug","name":"Server",` +
		`"description":"","transport":"stdio","endpoint":null,"command":"run","hasArgs":true,` +
		`"envKeys":["B","A"],"fileKeys":[],"headerKeys":[],"hasSecret":false,"oauthStatus":"none",` +
		`"oauthClientId":null,"health":{"status":"error","message":"` + dynamicRegistrationUnsupported +
		`","code":"MCP_OAUTH_CLIENT_REQUIRED","toolCount":null,"checkedAt":null},"enabled":true,` +
		`"verbatimResults":false,"sendCallerIdentity":false,"revision":2,"availability":{"allSpaces":false,"spaceIds":["sp1"]},` +
		`"allBots":false,"createdAt":"2026-11-23T01:02:03.400Z","updatedAt":"2026-11-23T01:02:03.400Z"}`
	if string(body) != want {
		t.Fatalf("dto = %s\nwant  %s", body, want)
	}
	for name, mutate := range map[string]func(*Record){
		"transport":     func(value *Record) { value.transport = "weird" },
		"revision":      func(value *Record) { value.revision = 0 },
		"endpoint":      func(value *Record) { value.endpoint = ptr("not a url") },
		"tool-count":    func(value *Record) { count := int32(-1); value.healthToolCount = &count },
		"install-id":    func(value *Record) { value.installID = ptr("") },
		"id":            func(value *Record) { value.id = "" },
		"space-id":      func(value *Record) { value.spaceID = "" },
		"endpoint-port": func(value *Record) { value.endpoint = ptr("http://x:99999/") },
	} {
		copied := record
		mutate(&copied)
		if _, failure := ServerDTO(copied, []string{"sp1"}, summary); failure == nil ||
			failure.Message != "Output validation failed" {
			t.Errorf("%s: failure = %+v, want Output validation failed", name, failure)
		}
	}
	// z.string().url() accepts scheme-only values and stores the trimmed input.
	for _, testCase := range []struct{ stored, want string }{
		{"urn:foo:bar", "urn:foo:bar"},
		{"mailto:x@y", "mailto:x@y"},
		{"file:///tmp/a", "file:///tmp/a"},
		{" http://example.test ", "http://example.test"},
	} {
		copied := record
		copied.endpoint = &testCase.stored
		server, failure := ServerDTO(copied, []string{"sp1"}, summary)
		if failure != nil || server.Endpoint == nil || *server.Endpoint != testCase.want {
			t.Errorf("endpoint %q: %+v %v", testCase.stored, server.Endpoint, failure)
		}
	}
}

func TestDeleteMaterialKeyKeepsOrder(t *testing.T) {
	material := decode(t, `{"a":1,"oauth":{"tokens":{}},"b":2}`)
	deleteMaterialKey(material, "oauth")
	if got := validate.Stringify(material); got != `{"a":1,"b":2}` {
		t.Fatalf("material = %s", got)
	}
	// A key that is not there changes nothing.
	deleteMaterialKey(material, "oauth")
	if got := validate.Stringify(material); got != `{"a":1,"b":2}` {
		t.Fatalf("material = %s", got)
	}
}

func TestRaiseGenerationPositionAndArithmetic(t *testing.T) {
	for _, testCase := range []struct{ text, want string }{
		{`{"a":1}`, `{"a":1,"oauthGeneration":1}`},
		{`{"oauthGeneration":2,"a":1}`, `{"oauthGeneration":3,"a":1}`},
		{`{"oauthGeneration":null}`, `{"oauthGeneration":1}`},
		{`{"oauthGeneration":"x"}`, `{"oauthGeneration":"x1"}`},
		{`{"oauthGeneration":true}`, `{"oauthGeneration":2}`},
		{`{"oauthGeneration":1.5}`, `{"oauthGeneration":2.5}`},
		{`[]`, `[]`},
	} {
		material := decode(t, testCase.text)
		raiseGeneration(material)
		if got := validate.Stringify(material); got != testCase.want {
			t.Errorf("raiseGeneration(%s) = %s, want %s", testCase.text, got, testCase.want)
		}
	}
}

func TestParseAgents(t *testing.T) {
	input, failure := parseAgents(orpc.Input{Raw: []byte(`{"id":"s1","allBots":false}`)})
	if failure != nil {
		t.Fatalf("parse failed: %+v", failure)
	}
	if input.id != "s1" || input.allBots || input.botIDs == nil || len(input.botIDs) != 0 {
		t.Fatalf("input = %+v, want an empty default bot list", input)
	}
	_, failure = parseAgents(orpc.Input{Raw: []byte(`{"id":"s1"}`)})
	if failure == nil {
		t.Fatal("a missing allBots passed")
	}
	_, failure = parseAgents(orpc.Input{Raw: []byte(`{"id":"s1","allBots":true,"botIds":[""]}`)})
	if failure == nil {
		t.Fatal("an empty bot id passed")
	}
	tooMany := `{"id":"s1","allBots":true,"botIds":[` + repeat("a", agentIDsMaximum+1) + `]}`
	if _, failure := parseAgents(orpc.Input{Raw: []byte(tooMany)}); failure == nil {
		t.Fatal("501 bot ids passed")
	}
}

func repeat(value string, count int) string {
	parts := make([]byte, 0, count*3)
	for index := 0; index < count; index++ {
		if index > 0 {
			parts = append(parts, ',')
		}
		parts = append(parts, '"')
		parts = append(parts, value...)
		parts = append(parts, '"')
	}
	return string(parts)
}

func ptr(text string) *string { return &text }
