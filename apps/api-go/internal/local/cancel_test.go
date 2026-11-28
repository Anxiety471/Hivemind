package local

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/orpc"
)

type capturedLog struct {
	mu      sync.Mutex
	records []map[string]any
}

func (c *capturedLog) Write(payload []byte) (int, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, line := range strings.Split(string(payload), "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		var record map[string]any
		if err := json.Unmarshal([]byte(line), &record); err != nil {
			continue
		}
		c.records = append(c.records, record)
	}
	return len(payload), nil
}

func (c *capturedLog) matching(msg string) []map[string]any {
	c.mu.Lock()
	defer c.mu.Unlock()
	var found []map[string]any
	for _, record := range c.records {
		if record["msg"] == msg {
			found = append(found, record)
		}
	}
	return found
}

func (c *capturedLog) count(level string) int {
	c.mu.Lock()
	defer c.mu.Unlock()
	count := 0
	for _, record := range c.records {
		if record["level"] == level {
			count++
		}
	}
	return count
}

// TestFailOnClientDisconnect is rpc-errors.ts:147-155: a failure under a canceled request is a
// warn, a 499, and no body — never a 5xx.
func TestFailOnClientDisconnect(t *testing.T) {
	sink := &capturedLog{}
	server := &Server{config: Config{Logger: slog.New(slog.NewJSONHandler(sink, nil))}}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	request := httptest.NewRequest(http.MethodPost, "/rpc/tickets/list", nil).WithContext(ctx)
	recorder := httptest.NewRecorder()

	server.fail(recorder, request, "tickets.list", orpc.Internal())

	if recorder.Code != StatusClientClosedRequest {
		t.Fatalf("status = %d, want %d", recorder.Code, StatusClientClosedRequest)
	}
	if recorder.Body.Len() != 0 {
		t.Fatalf("body = %q, want none for a client that is gone", recorder.Body.String())
	}
	disconnects := sink.matching("client disconnected")
	if len(disconnects) != 1 || disconnects[0]["level"] != "WARN" || disconnects[0]["procedure"] != "tickets.list" {
		t.Fatalf("disconnect lines = %v", sink.records)
	}
	if level := sink.count("ERROR"); level != 0 {
		t.Fatalf("ERROR lines = %d, want 0", level)
	}
}

// TestFailWithLiveContextIsUnchanged: the same failure while the client still waits is answered
// exactly as before, and a 5xx names its cause.
func TestFailWithLiveContextIsUnchanged(t *testing.T) {
	sink := &capturedLog{}
	server := &Server{config: Config{Logger: slog.New(slog.NewJSONHandler(sink, nil))}}
	request := httptest.NewRequest(http.MethodPost, "/rpc/tickets/list", nil)
	recorder := httptest.NewRecorder()
	failure := orpc.Internal()
	failure.Cause = errors.New("context canceled")

	server.fail(recorder, request, "tickets.list", failure)

	if recorder.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", recorder.Code)
	}
	var envelope struct {
		JSON struct {
			Code string `json:"code"`
		} `json:"json"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &envelope); err != nil || envelope.JSON.Code != "INTERNAL_SERVER_ERROR" {
		t.Fatalf("body = %q (%v)", recorder.Body.String(), err)
	}
	failures := sink.matching("tickets.list failed")
	if len(failures) != 1 || failures[0]["level"] != "ERROR" {
		t.Fatalf("failure lines = %v", sink.records)
	}
	if cause, _ := failures[0]["error"].(string); cause != "context canceled" {
		t.Fatalf("logged cause = %q, want the failure's cause", cause)
	}
	if level := sink.count("WARN"); level != 0 {
		t.Fatalf("WARN lines = %d, want 0", level)
	}

	// A 503 keeps its status, and is logged with its cause too.
	unavailable := orpc.Unavailable()
	unavailable.Cause = errors.New("connection refused")
	recorder = httptest.NewRecorder()
	server.fail(recorder, request, "spaces.list", unavailable)
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("503 status = %d", recorder.Code)
	}
	if failures := sink.matching("spaces.list failed"); len(failures) != 1 {
		t.Fatalf("503 line = %v", sink.records)
	}
}

// TestFailUnderCancelKeepsA4xx: only a failure that would be a 5xx becomes a disconnect. A 4xx
// keeps its status and envelope, as TypeScript's own oRPC errors do (rpc-errors.ts:147-155).
func TestFailUnderCancelKeepsA4xx(t *testing.T) {
	sink := &capturedLog{}
	server := &Server{config: Config{Logger: slog.New(slog.NewJSONHandler(sink, nil))}}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	request := httptest.NewRequest(http.MethodPost, "/rpc/threads/get", nil).WithContext(ctx)
	recorder := httptest.NewRecorder()

	server.fail(recorder, request, "threads.get", orpc.NotFound("Not Found"))

	if recorder.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want the 4xx kept", recorder.Code)
	}
	if !strings.Contains(recorder.Body.String(), `"code":"NOT_FOUND"`) {
		t.Fatalf("body = %q, want the not-found envelope", recorder.Body.String())
	}
	if lines := sink.matching("client disconnected"); len(lines) != 0 {
		t.Fatalf("a 4xx was recorded as a disconnect: %v", lines)
	}
	if level := sink.count("ERROR"); level != 0 {
		t.Fatalf("ERROR lines = %d, want 0", level)
	}
}
