package gateway

import (
	"context"
	"net/http"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/taskqueue"
)

// Internal loopback endpoints backing Redis-powered ticket dispatch, retries,
// and idle-bot bumps.
const (
	TaskQueueDispatchPath = "/internal/task-queue/dispatch"
	TaskQueueBumpPath     = "/internal/task-queue/bump"
	TaskQueueRerunAllPath = "/internal/task-queue/rerun-all"
	TaskQueueHealthPath   = "/internal/task-queue/health"
)

const maxTaskQueueBody = 64 << 10

// TaskQueue is the backend service backing /internal/task-queue/*.
type TaskQueue interface {
	EnqueueAssign(ctx context.Context, req taskqueue.DispatchRequest) (taskqueue.DispatchResponse, error)
	EnqueueBump(ctx context.Context, req taskqueue.BumpRequest) (taskqueue.DispatchResponse, error)
	RerunAllOpen(ctx context.Context) (taskqueue.RerunAllResponse, error)
	Health(ctx context.Context) taskqueue.HealthResponse
}

func (g *Gateway) taskQueueDispatch(w http.ResponseWriter, r *http.Request) {
	if !g.allowInternalPost(w, r) {
		return
	}
	if g.taskQueue == nil {
		writeEnvelope(w, http.StatusServiceUnavailable, "SERVICE_UNAVAILABLE", "Task queue unavailable")
		return
	}
	var request taskqueue.DispatchRequest
	if !decodeInternalJSON(w, r, maxTaskQueueBody, &request) {
		return
	}
	if request.SpaceID == "" || request.TicketID == "" || request.BotID == "" {
		http.Error(w, "Bad Request", http.StatusBadRequest)
		return
	}
	response, err := g.taskQueue.EnqueueAssign(r.Context(), request)
	if err != nil {
		g.logger.Error("task.queue dispatch failed", "ticket.id", request.TicketID, "bot.id", request.BotID, "error", err)
		http.Error(w, "Internal Server Error", http.StatusInternalServerError)
		return
	}
	writeInternalJSON(w, response)
}

func (g *Gateway) taskQueueBump(w http.ResponseWriter, r *http.Request) {
	if !g.allowInternalPost(w, r) {
		return
	}
	if g.taskQueue == nil {
		writeEnvelope(w, http.StatusServiceUnavailable, "SERVICE_UNAVAILABLE", "Task queue unavailable")
		return
	}
	var request taskqueue.BumpRequest
	if !decodeInternalJSON(w, r, maxTaskQueueBody, &request) {
		return
	}
	if request.SpaceID == "" || request.TicketID == "" || request.BotID == "" {
		http.Error(w, "Bad Request", http.StatusBadRequest)
		return
	}
	response, err := g.taskQueue.EnqueueBump(r.Context(), request)
	if err != nil {
		g.logger.Error("task.queue bump failed", "ticket.id", request.TicketID, "bot.id", request.BotID, "error", err)
		http.Error(w, "Internal Server Error", http.StatusInternalServerError)
		return
	}
	writeInternalJSON(w, response)
}

func (g *Gateway) taskQueueRerunAll(w http.ResponseWriter, r *http.Request) {
	if !g.allowInternalPost(w, r) {
		return
	}
	if g.taskQueue == nil {
		writeEnvelope(w, http.StatusServiceUnavailable, "SERVICE_UNAVAILABLE", "Task queue unavailable")
		return
	}
	response, err := g.taskQueue.RerunAllOpen(r.Context())
	if err != nil {
		g.logger.Error("task.queue rerun-all failed", "error", err)
		http.Error(w, "Internal Server Error", http.StatusInternalServerError)
		return
	}
	writeInternalJSON(w, response)
}

func (g *Gateway) taskQueueHealth(w http.ResponseWriter, r *http.Request) {
	if !isLoopback(r.RemoteAddr) || len(r.Header.Values("X-Forwarded-For")) > 0 {
		http.NotFound(w, r)
		return
	}
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", http.MethodGet)
		http.Error(w, "Method Not Allowed", http.StatusMethodNotAllowed)
		return
	}
	if g.taskQueue == nil {
		writeInternalJSON(w, taskqueue.HealthResponse{Enabled: false})
		return
	}
	writeInternalJSON(w, g.taskQueue.Health(r.Context()))
}
