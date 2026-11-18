package pages

import (
	"encoding/base64"
	"encoding/json"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/orpc"
)

func issues(t *testing.T, raw string) []map[string]any {
	t.Helper()
	_, failure := parseList(orpc.Input{Raw: json.RawMessage(raw)})
	if failure == nil {
		return nil
	}
	if failure.Code != "BAD_REQUEST" || failure.Message != "Input validation failed" {
		t.Fatalf("failure = %+v", failure)
	}
	return failure.Data.(map[string]any)["issues"].([]map[string]any)
}

func TestParseListAcceptsValidInputAndTrimsQuery(t *testing.T) {
	input, failure := parseList(orpc.Input{Raw: json.RawMessage(`{"botId":"b","groupId":"g","cursor":"","limit":60,"query":"\u00a0 Hello \n"}`)})
	if failure != nil {
		t.Fatalf("failure = %+v", failure)
	}
	if input.Query != "Hello" || !input.HasLimit || input.Limit != 60 || input.HasCursor || !input.HasBotID || !input.HasGroupID {
		t.Fatalf("input = %+v", input)
	}
	if got := issues(t, `{"limit":2.0}`); got != nil {
		t.Fatalf("2.0 is an integer: %v", got)
	}
}

func TestParseListReportsEveryIssueInSchemaOrder(t *testing.T) {
	got := issues(t, `{"zzz":1,"limit":0,"botId":"","query":"  ","aaa":2}`)
	var messages []string
	for _, issue := range got {
		messages = append(messages, issue["message"].(string))
	}
	want := []string{
		"Too small: expected string to have >=1 characters", // botId
		"Too small: expected number to be >=1",              // limit
		"Too small: expected string to have >=1 characters", // query
		`Unrecognized keys: "zzz", "aaa"`,
	}
	if !reflect.DeepEqual(messages, want) {
		t.Fatalf("messages = %q", messages)
	}
	if got := issues(t, `{"limit":1.5}`); len(got) != 1 || got[0]["expected"] != "int" {
		t.Fatalf("1.5 = %v", got)
	}
	if got := issues(t, `{"limit":1e300}`); len(got) != 2 {
		t.Fatalf("1e300 should be unsafe and too big: %v", got)
	}
	if got := issues(t, `[]`); len(got) != 1 || got[0]["message"] != "Invalid input: expected object, received array" {
		t.Fatalf("array = %v", got)
	}
	if got := issues(t, `{"3":1,"b":1,"1":1}`); got[0]["message"] != `Unrecognized keys: "1", "3", "b"` {
		t.Fatalf("key order = %v", got)
	}
}

func TestCursorRoundTripAndRejection(t *testing.T) {
	pinned := time.Date(2026, 5, 1, 10, 0, 0, 5_000_000, time.UTC)
	updated := time.Date(2026, 5, 2, 11, 30, 15, 999_000_000, time.UTC)
	for _, pin := range []*time.Time{nil, &pinned} {
		encoded := encodeCursor(pin, updated, `id-"quoted"`)
		if strings.ContainsAny(encoded, "=+/") {
			t.Fatalf("not base64url: %s", encoded)
		}
		decoded, ok := decodeCursor(encoded)
		if !ok || decoded.ID != `id-"quoted"` || !decoded.UpdatedAt.Equal(updated) || (pin == nil) != (decoded.PinnedAt == nil) {
			t.Fatalf("round trip = %+v ok=%v", decoded, ok)
		}
		if pin != nil && !decoded.PinnedAt.Equal(pinned) {
			t.Fatalf("pinned = %v", decoded.PinnedAt)
		}
	}
	encode := func(text string) string { return base64.RawURLEncoding.EncodeToString([]byte(text)) }
	for name, bad := range map[string]string{
		"not json":         "!!!",
		"empty":            "",
		"object no id":     encode(`{"pinnedAt":null,"updatedAt":"2026-05-01T00:00:00.000Z"}`),
		"id not string":    encode(`{"pinnedAt":null,"updatedAt":"2026-05-01T00:00:00.000Z","id":5}`),
		"missing pinnedAt": encode(`{"updatedAt":"2026-05-01T00:00:00.000Z","id":"a"}`),
		"bad updatedAt":    encode(`{"pinnedAt":null,"updatedAt":"yesterday","id":"a"}`),
		"bad pinnedAt":     encode(`{"pinnedAt":"x","updatedAt":"2026-05-01T00:00:00.000Z","id":"a"}`),
		"null document":    encode(`null`),
		"id null":          encode(`{"pinnedAt":null,"updatedAt":"2026-05-01T00:00:00.000Z","id":null}`),
		"hour 25":          encode(`{"pinnedAt":null,"updatedAt":"2026-05-01T25:00:00.000Z","id":"a"}`),
		"array":            encode(`[]`),
		"id key in caps":   encode(`{"pinnedAt":null,"updatedAt":"2026-05-01T00:00:00.000Z","ID":"a"}`),
		"updatedAt caps":   encode(`{"pinnedAt":null,"UpdatedAt":"2026-05-01T00:00:00.000Z","id":"a"}`),
		"pinnedAt caps":    encode(`{"PinnedAt":null,"updatedAt":"2026-05-01T00:00:00.000Z","id":"a"}`),
	} {
		if _, ok := decodeCursor(bad); ok {
			t.Errorf("%s accepted", name)
		}
	}
}

func TestLenientBase64URLMatchesNode(t *testing.T) {
	for input, want := range map[string]string{
		"eyJhIjoxfQ":         `{"a":1}`,
		"eyJhIjoxfQ==":       `{"a":1}`,
		"ey Jh Ijox fQ":      `{"a":1}`,
		"eyJhIjox*fQ":        `{"a":1}`,
		"*eyJhIjoxfQ":        `{"a":1}`,
		"e":                  ``,
		"eyJhIjoxfQx":        "{\"a\":1}\f",
		"eyJhIjoxfQ*garbage": "{\"a\":1}\b\x1a\xad\xb6\xa0",
	} {
		if got := string(lenientBase64URL(input)); got != want {
			t.Errorf("%q = %q, want %q", input, got, want)
		}
	}
}

func TestParseJSDate(t *testing.T) {
	utc := func(y int, m time.Month, d, h, mi, s, ms int) int64 {
		return time.Date(y, m, d, h, mi, s, ms*1_000_000, time.UTC).UnixMilli()
	}
	for text, want := range map[string]int64{
		"2026-05-01":                   utc(2026, 5, 1, 0, 0, 0, 0),
		"2026-05":                      utc(2026, 5, 1, 0, 0, 0, 0),
		"2026":                         utc(2026, 1, 1, 0, 0, 0, 0),
		"2026-05-01T10:00:00.000Z":     utc(2026, 5, 1, 10, 0, 0, 0),
		"2026-05-01T10:00:00z":         utc(2026, 5, 1, 10, 0, 0, 0),
		"2026-05-01T10:00:00.1234567Z": utc(2026, 5, 1, 10, 0, 0, 123),
		"2026-05-01T10:00:00+05:30":    utc(2026, 5, 1, 4, 30, 0, 0),
		"2026-05-01T24:00:00Z":         utc(2026, 5, 2, 0, 0, 0, 0),
		"+020000-01-01T00:00:00Z":      utc(20000, 1, 1, 0, 0, 0, 0),
	} {
		got, ok := parseJSDate(text)
		if !ok || got.UnixMilli() != want {
			t.Errorf("%q = %v ok=%v, want %d", text, got.UnixMilli(), ok, want)
		}
	}
	for _, text := range []string{"", "yesterday", "2026-13-01", "2026-05-32", "2026-05-01T10:60", "2026-05-01T24:00:01Z", "May 1 2026"} {
		if _, ok := parseJSDate(text); ok {
			t.Errorf("%q accepted", text)
		}
	}
}
