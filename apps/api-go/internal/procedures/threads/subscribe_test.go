package threads

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/validate"
)

// A jsonb number is read as an IEEE double on the TypeScript side and printed by JSON.stringify:
// 1.0 and -0 become 1 and 0, 1e21 stays an exponent, 1e-7 loses the padded zero, and a value
// beyond a double becomes null. eventFrame must write exactly those bytes.
func TestEventFramePrintsNumbersLikeJSONStringify(t *testing.T) {
	// The wire order of the two objects the harness compares against TypeScript: Postgres returns
	// jsonb keys byte-ordered by length first, and JavaScript brings integer-like keys to the front.
	payloadText := `{"n":[1.0,1e21,-0,1e-7,0.30000000000000004,1000.0,1e400,-1e400,5e-324,0.1],` +
		`"s":"text","bb":1,"aa":2,"deep":{"b":2.500,"a":[-12.0,"x"],"9":"nine","10":"ten"},` +
		`"10":"ten","9":"nine","a":"ay"}`
	decoded, err := validate.DecodeAny([]byte(payloadText))
	if err != nil {
		t.Fatal(err)
	}
	payload := decoded.(*validate.Object)
	frame, ok := eventFrame(storedEvent{
		id: "e1", spaceID: "s1", threadID: "t1", botID: "b1", seq: 3,
		eventType: "thread.progress", payload: payload,
		createdAt: time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC),
	})
	if !ok {
		t.Fatal("frame rejected")
	}
	// JSON.stringify of the same text: numbers as IEEE doubles, integer-like keys first in ascending
	// numeric order, then the rest in the order the text had them (Postgres returns a jsonb object
	// with its keys byte-ordered by length first, so "bb" precedes "aa").
	want := `{"id":"e1","spaceId":"s1","threadId":"t1","botId":"b1","seq":3,` +
		`"type":"thread.progress","createdAt":"2026-01-02T03:04:05.000Z","payload":{` +
		`"9":"nine","10":"ten",` +
		`"n":[1,1e+21,0,1e-7,0.30000000000000004,1000,null,null,5e-324,0.1],` +
		`"s":"text","bb":1,"aa":2,` +
		`"deep":{"9":"nine","10":"ten","b":2.5,"a":[-12,"x"]},"a":"ay"}}`
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
		botID: "b1", eventType: "legacy.thing", payload: &validate.Object{},
		createdAt: time.Now()}); ok {
		t.Fatal("an unknown type was sent")
	}
	if _, ok := eventFrame(storedEvent{id: "", spaceID: "s1", threadID: "t1",
		botID: "b1", eventType: "thread.progress", payload: &validate.Object{},
		createdAt: time.Now()}); ok {
		t.Fatal("an event without an id was sent")
	}
}

// Reasoning and the activity marker are the payloads a client applies blind: an invalid one, or
// one without the run it belongs to, fails the frame.
func TestEventFrameChecksThinkingAndActivityPayloads(t *testing.T) {
	now := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	object := func(text string) *validate.Object {
		value, err := validate.DecodeAny([]byte(text))
		if err != nil {
			t.Fatal(err)
		}
		return value.(*validate.Object)
	}
	thinking := object(`{"segment":0,"durationMs":1200,"lines":["a"]}`)
	frame, ok := eventFrame(storedEvent{id: "e1", spaceID: "s1", threadID: "t1", botID: "b1",
		runID: new("r1"), eventType: "thread.thinking", payload: thinking, createdAt: now})
	if !ok || frame == "" {
		t.Fatal("valid reasoning rejected")
	}
	if _, ok := eventFrame(storedEvent{id: "e1", spaceID: "s1", threadID: "t1", botID: "b1",
		eventType: "thread.thinking", payload: thinking, createdAt: now}); ok {
		t.Fatal("reasoning without a run was sent")
	}
	extra := object(`{"segment":0,"durationMs":1,"lines":[],"note":"x"}`)
	if _, ok := eventFrame(storedEvent{id: "e1", spaceID: "s1", threadID: "t1", botID: "b1",
		runID: new("r1"), eventType: "thread.thinking", payload: extra, createdAt: now}); ok {
		t.Fatal("reasoning with an extra key was sent")
	}
	activity := object(`{"activity":{"thinking":true}}`)
	if _, ok := eventFrame(storedEvent{id: "e1", spaceID: "s1", threadID: "t1", botID: "b1",
		runID: new("r1"), eventType: "thread.meta", payload: activity, createdAt: now}); !ok {
		t.Fatal("valid activity marker rejected")
	}
	bad := object(`{"activity":{"thinking":1}}`)
	if _, ok := eventFrame(storedEvent{id: "e1", spaceID: "s1", threadID: "t1", botID: "b1",
		runID: new("r1"), eventType: "thread.meta", payload: bad, createdAt: now}); ok {
		t.Fatal("a non-boolean thinking marker was sent")
	}
}

// TestPayloadMatchesTypeRejectsAnEmptyRunID: ProductEventSchema's superRefine tests !event.runId,
// so an empty string fails it like a missing run — a frame Go must not send.
func TestPayloadMatchesTypeRejectsAnEmptyRunID(t *testing.T) {
	payload, err := validate.DecodeAny([]byte(`{"segment":0,"durationMs":5,"lines":["x"]}`))
	if err != nil {
		t.Fatal(err)
	}
	object, ok := payload.(*validate.Object)
	if !ok {
		t.Fatalf("payload = %T", payload)
	}
	empty := ""
	if payloadMatchesType("thread.thinking", &empty, object) {
		t.Fatal("an empty runId passed the thinking schema")
	}
	run := "run-1"
	if !payloadMatchesType("thread.thinking", &run, object) {
		t.Fatal("a valid thinking frame was rejected")
	}
	activity, err := validate.DecodeAny([]byte(`{"activity":{"thinking":true}}`))
	if err != nil {
		t.Fatal(err)
	}
	marked, ok := activity.(*validate.Object)
	if !ok {
		t.Fatalf("activity = %T", activity)
	}
	if payloadMatchesType("thread.meta", &empty, marked) {
		t.Fatal("an empty runId passed the activity marker")
	}
}
