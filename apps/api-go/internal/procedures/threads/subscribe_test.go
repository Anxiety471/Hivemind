package threads

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

// A jsonb number is read as an IEEE double on the TypeScript side and printed by JSON.stringify:
// 1.0 and -0 become 1 and 0, 1e21 stays an exponent, 1e-7 loses the padded zero, and a value
// beyond a double becomes null. eventFrame must write exactly those bytes.
func TestEventFramePrintsNumbersLikeJSONStringify(t *testing.T) {
	payload := map[string]any{
		"n": []any{
			json.Number("1.0"), json.Number("1e21"), json.Number("-0"),
			json.Number("1e-7"), json.Number("0.30000000000000004"),
			json.Number("1000.0"), json.Number("1e400"), json.Number("-1e400"),
			json.Number("5e-324"), json.Number("0.1"),
		},
		"s": "text",
		"deep": map[string]any{
			"b": json.Number("2.500"), "a": []any{json.Number("-12.0"), "x"},
		},
	}
	frame, ok := eventFrame(storedEvent{
		id: "e1", spaceID: "s1", threadID: "t1", botID: "b1", seq: 3,
		eventType: "thread.progress", payload: payload,
		createdAt: time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC),
	})
	if !ok {
		t.Fatal("frame rejected")
	}
	want := `{"id":"e1","spaceId":"s1","threadId":"t1","botId":"b1","seq":3,` +
		`"type":"thread.progress","createdAt":"2026-01-02T03:04:05.000Z","payload":{` +
		`"deep":{"a":[-12,"x"],"b":2.5},` +
		`"n":[1,1e+21,0,1e-7,0.30000000000000004,1000,null,null,5e-324,0.1],"s":"text"}}`
	if frame != want {
		t.Fatalf("frame =\n%s\nwant\n%s", frame, want)
	}
}

// A payload that is not an object becomes {} (readJsonColumn's fallback), and an event whose type
// or identity the schema rejects ends the stream instead of sending a frame.
func TestEventFrameFallsBackAndRejectsUnknownShapes(t *testing.T) {
	base := storedEvent{id: "e1", spaceID: "s1", threadID: "t1", botID: "b1",
		eventType: "thread.progress", payload: []any{json.Number("1")},
		createdAt: time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)}
	frame, ok := eventFrame(base)
	if !ok || !strings.HasSuffix(frame, `"payload":{}}`) {
		t.Fatalf("non-object payload = %q", frame)
	}
	if _, ok := eventFrame(storedEvent{id: "e1", spaceID: "s1", threadID: "t1",
		botID: "b1", eventType: "legacy.thing", payload: map[string]any{},
		createdAt: time.Now()}); ok {
		t.Fatal("an unknown type was sent")
	}
	if _, ok := eventFrame(storedEvent{id: "", spaceID: "s1", threadID: "t1",
		botID: "b1", eventType: "thread.progress", payload: map[string]any{},
		createdAt: time.Now()}); ok {
		t.Fatal("an event without an id was sent")
	}
}

// Reasoning and the activity marker are the payloads a client applies blind: an invalid one, or
// one without the run it belongs to, fails the frame.
func TestEventFrameChecksThinkingAndActivityPayloads(t *testing.T) {
	now := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	thinking := map[string]any{
		"segment": json.Number("0"), "durationMs": json.Number("1200"),
		"lines": []any{"a"},
	}
	frame, ok := eventFrame(storedEvent{id: "e1", spaceID: "s1", threadID: "t1", botID: "b1",
		runID: new("r1"), eventType: "thread.thinking", payload: thinking, createdAt: now})
	if !ok || frame == "" {
		t.Fatal("valid reasoning rejected")
	}
	if _, ok := eventFrame(storedEvent{id: "e1", spaceID: "s1", threadID: "t1", botID: "b1",
		eventType: "thread.thinking", payload: thinking, createdAt: now}); ok {
		t.Fatal("reasoning without a run was sent")
	}
	extra := map[string]any{"segment": json.Number("0"), "durationMs": json.Number("1"),
		"lines": []any{}, "note": "x"}
	if _, ok := eventFrame(storedEvent{id: "e1", spaceID: "s1", threadID: "t1", botID: "b1",
		runID: new("r1"), eventType: "thread.thinking", payload: extra, createdAt: now}); ok {
		t.Fatal("reasoning with an extra key was sent")
	}
	activity := map[string]any{"activity": map[string]any{"thinking": true}}
	if _, ok := eventFrame(storedEvent{id: "e1", spaceID: "s1", threadID: "t1", botID: "b1",
		runID: new("r1"), eventType: "thread.meta", payload: activity, createdAt: now}); !ok {
		t.Fatal("valid activity marker rejected")
	}
	bad := map[string]any{"activity": map[string]any{"thinking": json.Number("1")}}
	if _, ok := eventFrame(storedEvent{id: "e1", spaceID: "s1", threadID: "t1", botID: "b1",
		runID: new("r1"), eventType: "thread.meta", payload: bad, createdAt: now}); ok {
		t.Fatal("a non-boolean thinking marker was sent")
	}
}
