package gateway

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/routes"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/taskdetect"
)

type stubTaskDetector struct {
	contextResp taskdetect.ContextResponse
	prepareResp taskdetect.PrepareResponse
	applyResp   taskdetect.ApplyResponse
	lastApply   taskdetect.ApplyRequest
}

func (s *stubTaskDetector) LoadContext(_ context.Context, _ taskdetect.ContextRequest) (taskdetect.ContextResponse, error) {
	return s.contextResp, nil
}

func (s *stubTaskDetector) Prepare(_ context.Context, _ taskdetect.PrepareRequest) (taskdetect.PrepareResponse, error) {
	return s.prepareResp, nil
}

func (s *stubTaskDetector) Apply(_ context.Context, req taskdetect.ApplyRequest) (taskdetect.ApplyResponse, error) {
	s.lastApply = req
	return s.applyResp, nil
}

func newTaskDetectGateway(t *testing.T, detector TaskDetector) *Gateway {
	t.Helper()
	upstream, err := url.Parse("http://127.0.0.1:3100")
	if err != nil {
		t.Fatalf("parse upstream: %v", err)
	}
	store := routes.NewStore("")
	return New(Options{
		Upstream:     upstream,
		Routes:       store,
		Logger:       discardLogger(),
		TaskDetector: detector,
	})
}

func TestTaskDetectEndpointsRejectForwardedAndNonLoopback(t *testing.T) {
	gw := newTaskDetectGateway(t, &stubTaskDetector{})
	for _, path := range []string{TaskDetectContextPath, TaskDetectPreparePath, TaskDetectApplyPath} {
		req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(`{}`))
		req.RemoteAddr = "203.0.113.10:12345"
		rec := httptest.NewRecorder()
		gw.ServeHTTP(rec, req)
		if rec.Code != http.StatusNotFound {
			t.Errorf("%s non-loopback: got %d, want 404", path, rec.Code)
		}

		req = httptest.NewRequest(http.MethodPost, path, strings.NewReader(`{}`))
		req.RemoteAddr = "127.0.0.1:12345"
		req.Header.Set("X-Forwarded-For", "127.0.0.1")
		rec = httptest.NewRecorder()
		gw.ServeHTTP(rec, req)
		if rec.Code != http.StatusNotFound {
			t.Errorf("%s forwarded: got %d, want 404", path, rec.Code)
		}
	}
}

func TestTaskDetectEndpointsRoundTrip(t *testing.T) {
	stub := &stubTaskDetector{
		contextResp: taskdetect.ContextResponse{
			Enabled:         true,
			AssignedContext: "<assigned_tickets>\n- RAK-1 [doing/normal] Build API (id: t1)\n</assigned_tickets>",
			OpenTickets:     []taskdetect.OpenTicket{{ID: "t1", Ref: "RAK-1", Title: "Build API", Status: "doing", Priority: "normal"}},
		},
		prepareResp: taskdetect.PrepareResponse{
			Inspect:      true,
			SystemPrompt: "sys",
			UserPrompt:   "usr",
		},
		applyResp: taskdetect.ApplyResponse{
			Created: []taskdetect.AppliedTicket{{ID: "t2", Ref: "RAK-2", Title: "Ship sync", Status: "todo", Priority: "normal", Op: "create"}},
			Updated: []taskdetect.AppliedTicket{},
		},
	}
	gw := newTaskDetectGateway(t, stub)

	t.Run("context", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodPost, TaskDetectContextPath, strings.NewReader(`{"spaceId":"s1","userId":"u1","botId":"b1","promptText":"hi"}`))
		req.RemoteAddr = "127.0.0.1:12345"
		rec := httptest.NewRecorder()
		gw.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200", rec.Code)
		}
		var got taskdetect.ContextResponse
		if err := json.NewDecoder(rec.Body).Decode(&got); err != nil {
			t.Fatalf("decode: %v", err)
		}
		if !got.Enabled || len(got.OpenTickets) != 1 || got.OpenTickets[0].Ref != "RAK-1" {
			t.Fatalf("unexpected context response: %+v", got)
		}
	})

	t.Run("prepare", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodPost, TaskDetectPreparePath, strings.NewReader(`{"runId":"r1","spaceId":"s1","userId":"u1","botId":"b1"}`))
		req.RemoteAddr = "127.0.0.1:12345"
		rec := httptest.NewRecorder()
		gw.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200", rec.Code)
		}
		var got taskdetect.PrepareResponse
		if err := json.NewDecoder(rec.Body).Decode(&got); err != nil {
			t.Fatalf("decode: %v", err)
		}
		if !got.Inspect || got.SystemPrompt != "sys" {
			t.Fatalf("unexpected prepare response: %+v", got)
		}
	})

	t.Run("apply", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodPost, TaskDetectApplyPath, strings.NewReader(`{"runId":"r1","spaceId":"s1","userId":"u1","botId":"b1","rawOutput":"{\"actions\":[]}"}`))
		req.RemoteAddr = "127.0.0.1:12345"
		rec := httptest.NewRecorder()
		gw.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200", rec.Code)
		}
		var got taskdetect.ApplyResponse
		if err := json.NewDecoder(rec.Body).Decode(&got); err != nil {
			t.Fatalf("decode: %v", err)
		}
		if len(got.Created) != 1 || got.Created[0].Ref != "RAK-2" {
			t.Fatalf("unexpected apply response: %+v", got)
		}
		if stub.lastApply.RunID != "r1" {
			t.Fatalf("expected runId r1, got %q", stub.lastApply.RunID)
		}
	})
}

func TestTaskDetectUnavailableWithoutService(t *testing.T) {
	gw := newTaskDetectGateway(t, nil)
	req := httptest.NewRequest(http.MethodPost, TaskDetectPreparePath, strings.NewReader(`{"runId":"r1","spaceId":"s1","userId":"u1","botId":"b1"}`))
	req.RemoteAddr = "127.0.0.1:12345"
	rec := httptest.NewRecorder()
	gw.ServeHTTP(rec, req)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", rec.Code)
	}
}
