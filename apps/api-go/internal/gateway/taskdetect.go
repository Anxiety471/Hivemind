package gateway

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/taskdetect"
)

// Internal loopback endpoints used by the TypeScript bot run loop and worker
// to load Kanban ticket context and sync detected tasks through the Go backend.
const (
	TaskDetectContextPath = "/internal/task-detect/context"
	TaskDetectPreparePath = "/internal/task-detect/prepare"
	TaskDetectApplyPath   = "/internal/task-detect/apply"
)

const maxTaskDetectBody = 1 << 20

// TaskDetector is the backend service backing /internal/task-detect/*.
type TaskDetector interface {
	LoadContext(ctx context.Context, req taskdetect.ContextRequest) (taskdetect.ContextResponse, error)
	Prepare(ctx context.Context, req taskdetect.PrepareRequest) (taskdetect.PrepareResponse, error)
	Apply(ctx context.Context, req taskdetect.ApplyRequest) (taskdetect.ApplyResponse, error)
}

func (g *Gateway) taskDetectContext(w http.ResponseWriter, r *http.Request) {
	if !g.allowInternalPost(w, r) {
		return
	}
	if g.taskDetect == nil {
		writeEnvelope(w, http.StatusServiceUnavailable, "SERVICE_UNAVAILABLE", "Task detection unavailable")
		return
	}
	var request taskdetect.ContextRequest
	if !decodeInternalJSON(w, r, maxTaskDetectBody, &request) {
		return
	}
	if request.SpaceID == "" || request.UserID == "" || request.BotID == "" {
		http.Error(w, "Bad Request", http.StatusBadRequest)
		return
	}
	response, err := g.taskDetect.LoadContext(r.Context(), request)
	if err != nil {
		g.logger.Error("task.detect context failed", "space.id", request.SpaceID, "bot.id", request.BotID, "error", err)
		http.Error(w, "Internal Server Error", http.StatusInternalServerError)
		return
	}
	writeInternalJSON(w, response)
}

func (g *Gateway) taskDetectPrepare(w http.ResponseWriter, r *http.Request) {
	if !g.allowInternalPost(w, r) {
		return
	}
	if g.taskDetect == nil {
		writeEnvelope(w, http.StatusServiceUnavailable, "SERVICE_UNAVAILABLE", "Task detection unavailable")
		return
	}
	var request taskdetect.PrepareRequest
	if !decodeInternalJSON(w, r, maxTaskDetectBody, &request) {
		return
	}
	if request.RunID == "" || request.SpaceID == "" || request.UserID == "" || request.BotID == "" {
		http.Error(w, "Bad Request", http.StatusBadRequest)
		return
	}
	response, err := g.taskDetect.Prepare(r.Context(), request)
	if err != nil {
		g.logger.Error("task.detect prepare failed", "run.id", request.RunID, "error", err)
		http.Error(w, "Internal Server Error", http.StatusInternalServerError)
		return
	}
	writeInternalJSON(w, response)
}

func (g *Gateway) taskDetectApply(w http.ResponseWriter, r *http.Request) {
	if !g.allowInternalPost(w, r) {
		return
	}
	if g.taskDetect == nil {
		writeEnvelope(w, http.StatusServiceUnavailable, "SERVICE_UNAVAILABLE", "Task detection unavailable")
		return
	}
	var request taskdetect.ApplyRequest
	if !decodeInternalJSON(w, r, maxTaskDetectBody, &request) {
		return
	}
	if request.SpaceID == "" || request.UserID == "" || request.BotID == "" {
		http.Error(w, "Bad Request", http.StatusBadRequest)
		return
	}
	response, err := g.taskDetect.Apply(r.Context(), request)
	if err != nil {
		g.logger.Error("task.detect apply failed", "run.id", request.RunID, "error", err)
		http.Error(w, "Internal Server Error", http.StatusInternalServerError)
		return
	}
	g.logger.Info("task.detect.applied",
		"run.id", request.RunID,
		"space.id", request.SpaceID,
		"bot.id", request.BotID,
		"created", len(response.Created),
		"updated", len(response.Updated),
		"skipped", response.Skipped,
	)
	writeInternalJSON(w, response)
}

func (g *Gateway) allowInternalPost(w http.ResponseWriter, r *http.Request) bool {
	if !isLoopback(r.RemoteAddr) || len(r.Header.Values("X-Forwarded-For")) > 0 {
		http.NotFound(w, r)
		return false
	}
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		http.Error(w, "Method Not Allowed", http.StatusMethodNotAllowed)
		return false
	}
	return true
}

func decodeInternalJSON(w http.ResponseWriter, r *http.Request, maxBytes int64, dst any) bool {
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxBytes)).Decode(dst); err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			http.Error(w, "Request Entity Too Large", http.StatusRequestEntityTooLarge)
			return false
		}
		http.Error(w, "Bad Request", http.StatusBadRequest)
		return false
	}
	return true
}

func writeInternalJSON(w http.ResponseWriter, payload any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(payload)
}
