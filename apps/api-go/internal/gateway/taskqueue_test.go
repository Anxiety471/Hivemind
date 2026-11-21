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
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/taskqueue"
)

type stubTaskQueue struct {
	lastDispatch taskqueue.DispatchRequest
	lastBump     taskqueue.BumpRequest
	health       taskqueue.HealthResponse
}

func (s *stubTaskQueue) EnqueueAssign(_ context.Context, req taskqueue.DispatchRequest) (taskqueue.DispatchResponse, error) {
	s.lastDispatch = req
	return taskqueue.DispatchResponse{Queued: true, Driver: "redis"}, nil
}

func (s *stubTaskQueue) EnqueueBump(_ context.Context, req taskqueue.BumpRequest) (taskqueue.DispatchResponse, error) {
	s.lastBump = req
	return taskqueue.DispatchResponse{Queued: true, Driver: "redis"}, nil
}

func (s *stubTaskQueue) RerunAllOpen(_ context.Context) (taskqueue.RerunAllResponse, error) {
	return taskqueue.RerunAllResponse{Found: 3, Queued: 3, Driver: "redis"}, nil
}

func (s *stubTaskQueue) Health(_ context.Context) taskqueue.HealthResponse {
	return s.health
}

func newTaskQueueGateway(t *testing.T, q TaskQueue) *Gateway {
	t.Helper()
	upstream, err := url.Parse("http://127.0.0.1:3100")
	if err != nil {
		t.Fatalf("parse upstream: %v", err)
	}
	return New(Options{
		Upstream:  upstream,
		Routes:    routes.NewStore(""),
		Logger:    discardLogger(),
		TaskQueue: q,
	})
}

func TestTaskQueueEndpointsRejectNonLoopbackAndForwarded(t *testing.T) {
	gw := newTaskQueueGateway(t, &stubTaskQueue{})
	for _, tc := range []struct {
		method string
		path   string
	}{
		{http.MethodPost, TaskQueueDispatchPath},
		{http.MethodPost, TaskQueueBumpPath},
		{http.MethodGet, TaskQueueHealthPath},
	} {
		req := httptest.NewRequest(tc.method, tc.path, strings.NewReader(`{}`))
		req.RemoteAddr = "203.0.113.10:12345"
		rec := httptest.NewRecorder()
		gw.ServeHTTP(rec, req)
		if rec.Code != http.StatusNotFound {
			t.Errorf("%s non-loopback: got %d, want 404", tc.path, rec.Code)
		}

		req = httptest.NewRequest(tc.method, tc.path, strings.NewReader(`{}`))
		req.RemoteAddr = "127.0.0.1:12345"
		req.Header.Set("X-Forwarded-For", "127.0.0.1")
		rec = httptest.NewRecorder()
		gw.ServeHTTP(rec, req)
		if rec.Code != http.StatusNotFound {
			t.Errorf("%s forwarded: got %d, want 404", tc.path, rec.Code)
		}
	}
}

func TestTaskQueueEndpointsRoundTrip(t *testing.T) {
	stub := &stubTaskQueue{
		health: taskqueue.HealthResponse{Enabled: true, Driver: "redis", Connected: true, Pending: 2, Dead: 0},
	}
	gw := newTaskQueueGateway(t, stub)

	t.Run("dispatch", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodPost, TaskQueueDispatchPath, strings.NewReader(`{"spaceId":"s1","ticketId":"t1","botId":"b1"}`))
		req.RemoteAddr = "127.0.0.1:12345"
		rec := httptest.NewRecorder()
		gw.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200", rec.Code)
		}
		var got taskqueue.DispatchResponse
		if err := json.NewDecoder(rec.Body).Decode(&got); err != nil {
			t.Fatalf("decode: %v", err)
		}
		if !got.Queued || got.Driver != "redis" || stub.lastDispatch.BotID != "b1" {
			t.Fatalf("unexpected dispatch response: %+v req=%+v", got, stub.lastDispatch)
		}
	})

	t.Run("bump", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodPost, TaskQueueBumpPath, strings.NewReader(`{"spaceId":"s1","ticketId":"t1","botId":"b1","force":true}`))
		req.RemoteAddr = "127.0.0.1:12345"
		rec := httptest.NewRecorder()
		gw.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200", rec.Code)
		}
		if !stub.lastBump.Force || stub.lastBump.TicketID != "t1" {
			t.Fatalf("unexpected bump req: %+v", stub.lastBump)
		}
	})

	t.Run("health", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, TaskQueueHealthPath, nil)
		req.RemoteAddr = "127.0.0.1:12345"
		rec := httptest.NewRecorder()
		gw.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200", rec.Code)
		}
		var got taskqueue.HealthResponse
		if err := json.NewDecoder(rec.Body).Decode(&got); err != nil {
			t.Fatalf("decode: %v", err)
		}
		if !got.Connected || got.Driver != "redis" || got.Pending != 2 {
			t.Fatalf("unexpected health response: %+v", got)
		}
	})
}
