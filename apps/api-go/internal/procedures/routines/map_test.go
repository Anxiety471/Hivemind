package routines

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/orpc"
)

func TestMapRoutineShapesTheRow(t *testing.T) {
	created := time.Date(2026, 4, 1, 12, 0, 0, 0, time.UTC)
	next := time.Now().UTC().Add(time.Hour).Truncate(time.Millisecond)
	last := time.Date(2026, 4, 1, 11, 0, 0, 0, time.UTC)
	row := routineRow{
		ID:              "r1",
		BotID:           "b1",
		Name:            "Morning brief",
		Prompt:          "Summarize",
		Crons:           nil, // Postgres returns [] but a scan can hand back nil; the wire is [].
		Timezone:        "UTC",
		Active:          true,
		Notify:          true,
		InChat:          false,
		WebhookEnabled:  false,
		GithubEnabled:   false,
		MessageProvider: new("telegram"),
		EmailSenders:    new("boss"), // not the enum: reads as no trigger.
		ModelProvider:   new("azure-openai-responses"),
		ModelID:         new("gpt-5"),
		ThinkingLevel:   new("high"),
		Watch:           []byte(`{"kind":"http","url":" https://status.example.com/health ","everyMinutes":"15"}`),
		WatchState: []byte(`{"checkedAt":"2026-04-01T11:59:00.000Z","outcome":"changed",
			"fingerprint":"abc","detail":null,"retrying":true,"unknown":1}`),
		LastRunAt: &last,
		NextRunAt: &next,
		CreatedAt: created,
	}
	routine := mapRoutine(row)
	body, err := json.Marshal(routine)
	if err != nil {
		t.Fatal(err)
	}
	// everyMinutes is a string in the column, so the watch no longer fits and reads as null.
	want := `{"id":"r1","botId":"b1","name":"Morning brief","prompt":"Summarize","crons":[],` +
		`"timezone":"UTC","active":true,"notify":true,"inChat":false,"webhookEnabled":false,` +
		`"githubEnabled":false,"messageProvider":"telegram","emailSenders":null,` +
		`"modelProvider":"azure","modelId":"gpt-5","thinkingLevel":"high","watch":null,` +
		`"watchState":{"checkedAt":"2026-04-01T11:59:00.000Z","outcome":"changed","retrying":true,` +
		`"fingerprint":"abc","detail":null},"lastRunAt":"2026-04-01T11:00:00.000Z",` +
		`"nextRunAt":"` + next.Format("2006-01-02T15:04:05.000Z") + `","scheduleDelayed":false,` +
		`"createdAt":"2026-04-01T12:00:00.000Z"}`
	if string(body) != want {
		t.Fatalf("routine = %s", body)
	}

	row.Watch = []byte(`{"kind":"files","paths":["  /tmp/a  "],"track":["x"]}`)
	row.EmailSenders = new("owner")
	row.Active = false
	routine = mapRoutine(row)
	if routine.Watch != nil {
		t.Fatalf("files with track parsed: %+v", routine.Watch)
	}
	if routine.EmailSenders == nil || *routine.EmailSenders != "owner" {
		t.Fatalf("emailSenders = %v", routine.EmailSenders)
	}

	row.Watch = []byte(`{"kind":"command","command":"  df -h  ","unknown":true}`)
	routine = mapRoutine(row)
	if routine.Watch == nil || routine.Watch.Command == nil || *routine.Watch.Command != "df -h" ||
		routine.Watch.EveryMinutes != 15 || routine.Watch.Loud {
		t.Fatalf("watch = %+v", routine.Watch)
	}
	encoded, _ := json.Marshal(routine.Watch)
	if string(encoded) != `{"kind":"command","command":"df -h","everyMinutes":15,"loud":false}` {
		t.Fatalf("watch json = %s", encoded)
	}
}

func TestScheduleDelayed(t *testing.T) {
	now := time.Date(2026, 4, 1, 12, 0, 0, 0, time.UTC)
	late := now.Add(-6 * time.Minute)
	almost := now.Add(-5 * time.Minute)
	if !scheduleDelayed(true, &late, now) {
		t.Error("six minutes late is delayed")
	}
	if scheduleDelayed(true, &almost, now) {
		t.Error("five minutes late is not delayed")
	}
	if scheduleDelayed(false, &late, now) {
		t.Error("a paused routine is not delayed")
	}
	if scheduleDelayed(true, nil, now) {
		t.Error("no next run is not delayed")
	}
}

func TestParseWatchAcceptsTheSchema(t *testing.T) {
	for name, stored := range map[string]string{
		"files":      `{"kind":"files","paths":[" a ","b"],"loud":true,"everyMinutes":5}`,
		"command":    `{"kind":"command","command":"date"}`,
		"tool":       `{"kind":"tool","tool":"gmail.list","args":{"q":"is:unread"},"track":[" id "]}`,
		"http":       `{"kind":"http","url":"https://example.com/x?y=1"}`,
		"empty-args": `{"kind":"http","url":"https://example.com","args":{}}`,
	} {
		if watch := parseWatch([]byte(stored)); watch == nil {
			t.Errorf("%s did not parse", name)
		}
	}
	watch := parseWatch([]byte(`{"kind":"tool","tool":" gmail.list ","args":{"n":1.0}}`))
	if watch == nil || *watch.Tool != "gmail.list" {
		t.Fatalf("trimmed tool = %+v", watch)
	}
	encoded, _ := json.Marshal(watch)
	if string(encoded) != `{"kind":"tool","tool":"gmail.list","args":{"n":1},"everyMinutes":15,"loud":false}` {
		t.Fatalf("watch json = %s", encoded)
	}
}

func TestParseWatchRejectsWhatTheSchemaRejects(t *testing.T) {
	for name, stored := range map[string]string{
		"null":             `null`,
		"array":            `[]`,
		"no-kind":          `{}`,
		"bad-kind":         `{"kind":"email"}`,
		"files-no-paths":   `{"kind":"files"}`,
		"files-empty":      `{"kind":"files","paths":[]}`,
		"files-null":       `{"kind":"files","paths":null}`,
		"files-track":      `{"kind":"files","paths":["a"],"track":["b"]}`,
		"command-missing":  `{"kind":"command"}`,
		"tool-missing":     `{"kind":"tool"}`,
		"http-http":        `{"kind":"http","url":"http://example.com"}`,
		"http-creds":       `{"kind":"http","url":"https://u:p@example.com"}`,
		"http-user":        `{"kind":"http","url":"https://u@example.com"}`,
		"http-port":        `{"kind":"http","url":"https://example.com:8443"}`,
		"http-fragment":    `{"kind":"http","url":"https://example.com/#x"}`,
		"http-relative":    `{"kind":"http","url":"/health"}`,
		"minutes-low":      `{"kind":"http","url":"https://example.com","everyMinutes":4}`,
		"minutes-high":     `{"kind":"http","url":"https://example.com","everyMinutes":1441}`,
		"minutes-fraction": `{"kind":"http","url":"https://example.com","everyMinutes":15.5}`,
		"minutes-string":   `{"kind":"http","url":"https://example.com","everyMinutes":"15"}`,
		"loud-string":      `{"kind":"http","url":"https://example.com","loud":"yes"}`,
		"paths-string":     `{"kind":"files","paths":"a"}`,
		"path-too-long":    `{"kind":"files","paths":["` + strings.Repeat("a", 501) + `"]}`,
		"path-empty":       `{"kind":"files","paths":["   "]}`,
		"args-array":       `{"kind":"http","url":"https://example.com","args":[]}`,
		"track-empty":      `{"kind":"tool","tool":"x","track":[]}`,
	} {
		if watch := parseWatch([]byte(stored)); watch != nil {
			t.Errorf("%s parsed as %+v", name, watch)
		}
	}
	if watch := parseWatch(nil); watch != nil {
		t.Error("an empty column is not a watch")
	}
	// The scheme's default port is not a port of its own.
	if watch := parseWatch([]byte(`{"kind":"http","url":"https://example.com:443/"}`)); watch == nil {
		t.Error("https on :443 is a valid endpoint")
	}
	// Counts are code points: 500 astral characters are 1000 UTF-16 units but still 500.
	if watch := parseWatch([]byte(`{"kind":"files","paths":["` + strings.Repeat("😀", 500) + `"]}`)); watch == nil {
		t.Error("500 code points fit the 500-character limit")
	}
	if watch := parseWatch([]byte(`{"kind":"files","paths":["` + strings.Repeat("😀", 501) + `"]}`)); watch != nil {
		t.Error("501 code points do not fit")
	}
}

func TestParseWatchStateAcceptsTheSchema(t *testing.T) {
	state := parseWatchState([]byte(`{"checkedAt":"2026-04-01T00:00:00.000Z","outcome":"unchanged",
		"fingerprint":null,"detail":"same","entries":{"a":"1:2"},"extra":1}`))
	if state == nil || state.Outcome != "unchanged" || state.Fingerprint != nil || state.Detail == nil ||
		*state.Detail != "same" || state.Entries == nil || (*state.Entries)["a"] != "1:2" {
		t.Fatalf("state = %+v", state)
	}
	for name, stored := range map[string]string{
		"null":             `null`,
		"no-checked":       `{"outcome":"unchanged","fingerprint":null,"detail":null}`,
		"bad-outcome":      `{"checkedAt":"x","outcome":"waiting","fingerprint":null,"detail":null}`,
		"missing-detail":   `{"checkedAt":"x","outcome":"unchanged","fingerprint":null}`,
		"fingerprint-type": `{"checkedAt":"x","outcome":"unchanged","fingerprint":1,"detail":null}`,
		"entries-array":    `{"checkedAt":"x","outcome":"unchanged","fingerprint":null,"detail":null,"entries":[]}`,
		"entries-value":    `{"checkedAt":"x","outcome":"unchanged","fingerprint":null,"detail":null,"entries":{"a":1}}`,
		"retrying-type":    `{"checkedAt":"x","outcome":"unchanged","fingerprint":null,"detail":null,"retrying":"yes"}`,
	} {
		if state := parseWatchState([]byte(stored)); state != nil {
			t.Errorf("%s parsed as %+v", name, state)
		}
	}
}

func TestRunFailureError(t *testing.T) {
	if got := runFailureError("completed", new("boom")); got != nil {
		t.Fatalf("completed = %s", *got)
	}
	if got := runFailureError("failed", nil); got != nil {
		t.Fatalf("no error = %s", *got)
	}
	if got := runFailureError("failed", new("   ")); got != nil {
		t.Fatalf("blank = %s", *got)
	}
	got := runFailureError("failed", new("  provider exploded  "))
	if string(*got) != `"provider exploded"` {
		t.Fatalf("trimmed = %s", *got)
	}
	// 300 code units is the limit; one more gets an ellipsis.
	short := strings.Repeat("a", 300)
	got = runFailureError("failed", new(short))
	if string(*got) != `"`+short+`"` {
		t.Fatalf("300 = %s", *got)
	}
	got = runFailureError("failed", new(short+"b"))
	if string(*got) != `"`+short+`…"` {
		t.Fatalf("301 = %s", *got)
	}
	// A cut inside a surrogate pair keeps the high half, written as JSON.stringify writes it.
	got = runFailureError("failed", new(strings.Repeat("a", 299)+"😀x"))
	if string(*got) != `"`+strings.Repeat("a", 299)+`\ud83d…"` {
		t.Fatalf("split pair = %s", *got)
	}
}

func TestParseModelFallbackFailureRoundTrip(t *testing.T) {
	details := `{"modelFallbackVersion":1,"primaryError":"first failed","backups":[` +
		`{"provider":"openai","modelId":"gpt-5","status":"failed","reason":"timeout","extra":[1,2]},` +
		`{"provider":"anthropic","modelId":"claude","status":"skipped","reason":" no key "}]}`
	parsed, ok := parseModelFallbackFailure(details)
	if !ok {
		t.Fatal("did not parse")
	}
	got := string(encodeFallback(parsed))
	want := `{"modelFallbackVersion":1,"primaryError":"first failed","backups":[` +
		`{"provider":"openai","modelId":"gpt-5","status":"failed","reason":"timeout","extra":[1,2]},` +
		`{"provider":"anthropic","modelId":"claude","status":"skipped","reason":" no key "}]}`
	if got != want {
		t.Fatalf("encoded = %s", got)
	}
	for name, text := range map[string]string{
		"plain":         "boom",
		"not-json":      "{",
		"array":         `[1]`,
		"version":       `{"modelFallbackVersion":2,"primaryError":"x","backups":[{"provider":"p","modelId":"m","status":"failed","reason":"r"}]}`,
		"version-text":  `{"modelFallbackVersion":"1","primaryError":"x","backups":[{"provider":"p","modelId":"m","status":"failed","reason":"r"}]}`,
		"no-primary":    `{"modelFallbackVersion":1,"backups":[{"provider":"p","modelId":"m","status":"failed","reason":"r"}]}`,
		"empty-backups": `{"modelFallbackVersion":1,"primaryError":"x","backups":[]}`,
		"bad-status":    `{"modelFallbackVersion":1,"primaryError":"x","backups":[{"provider":"p","modelId":"m","status":"done","reason":"r"}]}`,
		"no-reason":     `{"modelFallbackVersion":1,"primaryError":"x","backups":[{"provider":"p","modelId":"m","status":"failed"}]}`,
	} {
		if _, ok := parseModelFallbackFailure(text); ok {
			t.Errorf("%s parsed", name)
		}
	}
}

func TestParseHistoryInput(t *testing.T) {
	input, failure := parseHistory(orpc.Input{Raw: json.RawMessage(`{"routineId":"r1"}`)})
	if failure != nil || input.RoutineID != "r1" || input.Before != nil || input.Limit != historyPageSize {
		t.Fatalf("plain = %+v %v", input, failure)
	}
	input, failure = parseHistory(orpc.Input{Raw: json.RawMessage(`{"routineId":"r1","limit":1,
		"before":{"id":"run1","createdAt":"2026-05-01T12:00:00.000+05:30"},"more":true}`)})
	if failure != nil || input.Limit != 1 || input.Before == nil ||
		input.Before.ID != "run1" || input.Before.CreatedAt != "2026-05-01T12:00:00.000+05:30" {
		t.Fatalf("cursor = %+v %v", input, failure)
	}
	for name, raw := range map[string]string{
		"no-input":         ``,
		"null":             `null`,
		"array":            `[]`,
		"no-routine":       `{}`,
		"empty-routine":    `{"routineId":""}`,
		"limit-zero":       `{"routineId":"r1","limit":0}`,
		"limit-high":       `{"routineId":"r1","limit":21}`,
		"limit-fraction":   `{"routineId":"r1","limit":1.5}`,
		"limit-text":       `{"routineId":"r1","limit":"5"}`,
		"before-null":      `{"routineId":"r1","before":null}`,
		"before-array":     `{"routineId":"r1","before":[]}`,
		"before-no-id":     `{"routineId":"r1","before":{"createdAt":"2026-05-01T12:00:00Z"}}`,
		"before-no-date":   `{"routineId":"r1","before":{"id":"run1"}}`,
		"before-bad-date":  `{"routineId":"r1","before":{"id":"run1","createdAt":"yesterday"}}`,
		"before-date-only": `{"routineId":"r1","before":{"id":"run1","createdAt":"2026-05-01"}}`,
	} {
		_, failure := parseHistory(orpc.Input{Raw: json.RawMessage(raw)})
		if failure == nil || failure.Code != "BAD_REQUEST" {
			t.Errorf("%s = %v", name, failure)
		}
	}
	// Every failing field is reported in zod's order.
	_, failure = parseHistory(orpc.Input{Raw: json.RawMessage(`{"routineId":"","limit":99,
		"before":{"id":"","createdAt":"x"}}`)})
	if failure == nil {
		t.Fatal("no failure")
	}
	issues, _ := failure.Data.(map[string]any)["issues"].([]map[string]any)
	if len(issues) != 4 {
		t.Fatalf("issues = %v", issues)
	}
}

func TestParseMentions(t *testing.T) {
	ids, failure := parseMentions(orpc.Input{Raw: json.RawMessage(`{"botIds":["a","b"],"more":1}`)})
	if failure != nil || len(ids) != 2 || ids[0] != "a" || ids[1] != "b" {
		t.Fatalf("mentions = %v %v", ids, failure)
	}
	for name, raw := range map[string]string{
		"no-input":   ``,
		"null":       `null`,
		"no-botids":  `{}`,
		"empty":      `{"botIds":[]}`,
		"not-array":  `{"botIds":"a"}`,
		"empty-item": `{"botIds":["a",""]}`,
		"number":     `{"botIds":["a",5]}`,
	} {
		if _, failure := parseMentions(orpc.Input{Raw: json.RawMessage(raw)}); failure == nil {
			t.Errorf("%s passed", name)
		}
	}
	tooMany := make([]string, mentionBatchMax+1)
	for index := range tooMany {
		tooMany[index] = `"b"`
	}
	if _, failure := parseMentions(orpc.Input{Raw: json.RawMessage(`{"botIds":[` + strings.Join(tooMany, ",") + `]}`)}); failure == nil {
		t.Error("101 bots passed")
	}
}
