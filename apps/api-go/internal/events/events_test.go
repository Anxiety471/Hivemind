package events

import (
	"errors"
	"reflect"
	"testing"
	"time"
)

func TestSanitizeJSONRepairsPostgresUnsafeText(t *testing.T) {
	value := map[string]any{
		"nul":   "a\x00b",
		"bad":   string([]byte{0xff, 'x'}),
		"ok":    "İ 😀",
		"nests": []any{map[string]any{"deep": "x\x00"}},
	}
	sanitized := SanitizeJSON(value).(map[string]any)
	if sanitized["nul"] != "a\uFFFDb" {
		t.Fatalf("nul = %q", sanitized["nul"])
	}
	if sanitized["bad"] != "\uFFFDx" {
		t.Fatalf("bad = %q", sanitized["bad"])
	}
	if sanitized["ok"] != "İ 😀" {
		t.Fatalf("ok = %q", sanitized["ok"])
	}
	nested := sanitized["nests"].([]any)[0].(map[string]any)
	if nested["deep"] != "x\uFFFD" {
		t.Fatalf("nested = %q", nested["deep"])
	}
}

func TestSanitizeJSONSuffixesCollidingKeys(t *testing.T) {
	value := map[string]any{"a\x00": 1, "a\uFFFD": 2}
	sanitized := SanitizeJSON(value).(map[string]any)
	if len(sanitized) != 2 {
		t.Fatalf("keys = %#v", sanitized)
	}
	if sanitized["a\uFFFD"] == nil || sanitized["a\uFFFD#2"] == nil {
		t.Fatalf("keys = %#v", sanitized)
	}
}

func TestIsRunResponse(t *testing.T) {
	progress := func(payload map[string]any) bool { return IsRunResponse("thread.progress", payload) }
	if !progress(map[string]any{"streaming": true, "text": "hello"}) {
		t.Fatal("streaming text is a response")
	}
	if progress(map[string]any{"streaming": true, "text": "   "}) {
		t.Fatal("whitespace-only text is not a response")
	}
	if progress(map[string]any{"streaming": true, "text": "\u0085"}) != true {
		t.Fatal("U+0085 is not ECMAScript whitespace and must count as text")
	}
	if progress(map[string]any{"streaming": true, "text": "\uFEFF"}) {
		t.Fatal("U+FEFF is ECMAScript whitespace and must not count as text")
	}
	if progress(map[string]any{"streaming": true, "text": "hi", "activity": true}) {
		t.Fatal("activity progress is not a response")
	}
	if progress(map[string]any{"text": "hi"}) {
		t.Fatal("non-streaming progress is not a response")
	}
	message := func(payload map[string]any) bool { return IsRunResponse("thread.message.created", payload) }
	if !message(map[string]any{"role": "bot", "blocks": []any{map[string]any{"kind": "text", "text": "hi"}}}) {
		t.Fatal("bot text reply is a response")
	}
	if message(map[string]any{"role": "bot", "blocks": []any{map[string]any{"kind": "text", "text": " "}}}) {
		t.Fatal("empty bot text reply is not a response")
	}
	if !message(map[string]any{"role": "bot", "blocks": []any{map[string]any{"kind": "card"}}}) {
		t.Fatal("card block is a response")
	}
	if message(map[string]any{"role": "user", "blocks": []any{map[string]any{"kind": "text", "text": "hi"}}}) {
		t.Fatal("user message is not a response")
	}
	if message(map[string]any{"role": "bot", "blocks": "nope"}) {
		t.Fatal("non-array blocks are not a response")
	}
}

func TestIsActivityEventRequiresTheExactSchema(t *testing.T) {
	lease := &Lease{Owner: "worker-1", Fence: 1}
	valid := Input{
		Type:    "thread.meta",
		Payload: map[string]any{"activity": map[string]any{"thinking": true}},
		RunID:   "run-1",
		Lease:   lease,
	}
	activity, err := isActivityEvent(valid)
	if err != nil || !activity {
		t.Fatalf("valid activity = %v, %v", activity, err)
	}
	if activity, err := isActivityEvent(Input{Type: "thread.meta", Payload: map[string]any{}}); err != nil || activity {
		t.Fatalf("plain meta = %v, %v", activity, err)
	}
	extra := valid
	extra.Payload = map[string]any{
		"activity": map[string]any{"thinking": true},
		"other":    1,
	}
	if _, err := isActivityEvent(extra); err == nil || errors.Is(err, ErrRunHistoryWrite) {
		t.Fatalf("extra payload key error = %v", err)
	}
	notBool := valid
	notBool.Payload = map[string]any{"activity": map[string]any{"thinking": "yes"}}
	if _, err := isActivityEvent(notBool); err == nil {
		t.Fatal("non-boolean thinking accepted")
	}
	noLease := valid
	noLease.Lease = nil
	if _, err := isActivityEvent(noLease); !errors.Is(err, ErrRunHistoryWrite) {
		t.Fatalf("activity without lease = %v", err)
	}
}

func TestRunTimingFields(t *testing.T) {
	created := time.Date(2026, 11, 19, 0, 0, 0, 0, time.UTC)
	started := created.Add(2 * time.Second)
	first := started.Add(500 * time.Millisecond)
	completed := first.Add(1500 * time.Millisecond)
	source := created.Add(-time.Second)
	fields := RunTimingFields(TimingRun{
		Trigger: "user", CreatedAt: created, StartedAt: &started,
		FirstResponseAt: &first, CompletedAt: &completed, SourceCreatedAt: &source,
	})
	want := map[string]any{
		"run.trigger":           "user",
		"run.pre_run_wait_ms":   int64(1000),
		"run.queue_wait_ms":     int64(2000),
		"run.first_response_ms": int64(3500),
		"run.total_ms":          int64(5000),
		"run.execution_wall_ms": int64(2000),
	}
	if !reflect.DeepEqual(fields, want) {
		t.Fatalf("fields = %#v", fields)
	}
	// Never negative when the origin is later than the milestone.
	late := created.Add(time.Hour)
	fields = RunTimingFields(TimingRun{Trigger: "user", CreatedAt: created, SourceCreatedAt: &late})
	if fields["run.pre_run_wait_ms"] != int64(0) {
		t.Fatalf("negative wait = %#v", fields["run.pre_run_wait_ms"])
	}
}

// notifyRealtime (event-stream.ts:41-43) stringifies { cursor, ...(type ? { type } : {}) }: the
// cursor first, and no type key at all when the publisher names none.
func TestThreadEnvelopePinsExactBytes(t *testing.T) {
	cases := []struct{ name, eventType, want string }{
		{"without type", "", `{"topic":"thread:thread-1","payload":"{\"cursor\":7}"}`},
		{"with type", "skill.saved", `{"topic":"thread:thread-1","payload":"{\"cursor\":7,\"type\":\"skill.saved\"}"}`},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			envelope, err := threadEnvelope("thread-1", 7, testCase.eventType)
			if err != nil {
				t.Fatalf("envelope: %v", err)
			}
			if string(envelope) != testCase.want {
				t.Fatalf("envelope = %s, want %s", envelope, testCase.want)
			}
		})
	}
}
