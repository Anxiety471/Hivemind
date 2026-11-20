package gateway

import (
	"encoding/json"
	"errors"
	"net"
	"net/http"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/modelretry"
)

// ModelRetryPath answers the TypeScript runtime's question of what to do with a
// failed model call, from the Go rules in internal/modelretry. The bot run loop
// still runs in TypeScript; this is how it uses the Go rules until the loop
// moves here.
const ModelRetryPath = "/internal/model-retry/decide"

// maxModelRetryBody bounds the provider error a caller may send. A longer one
// is refused and the caller falls back to its own rules.
const maxModelRetryBody = 1 << 20

type modelRetryRequest struct {
	Message              string `json:"message"`
	Provider             string `json:"provider"`
	RequestLimitTooSmall bool   `json:"requestLimitTooSmall"`
	// RunID and Model are only logged, so a decision can be matched to the
	// runtime's own log lines.
	RunID string `json:"runId"`
	Model string `json:"model"`
}

type modelRetryResponse struct {
	SwitchToBackup bool `json:"switchToBackup"`
	RetrySameModel bool `json:"retrySameModel"`
	// Unrecognized is null unless no rule placed the failure; its status is null
	// when the provider answered without one.
	Unrecognized *modelRetryUnrecognized `json:"unrecognized"`
}

type modelRetryUnrecognized struct {
	Status *int `json:"status"`
}

func (g *Gateway) modelRetry(w http.ResponseWriter, r *http.Request) {
	// The web server forwards only /rpc here and always names the hop it saw in
	// X-Forwarded-For. A loopback caller without that header is a process on this
	// host; anyone else is told the path does not exist.
	if !isLoopback(r.RemoteAddr) || len(r.Header.Values("X-Forwarded-For")) > 0 {
		http.NotFound(w, r)
		return
	}
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		http.Error(w, "Method Not Allowed", http.StatusMethodNotAllowed)
		return
	}
	var request modelRetryRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxModelRetryBody)).Decode(&request); err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			http.Error(w, "Request Entity Too Large", http.StatusRequestEntityTooLarge)
			return
		}
		http.Error(w, "Bad Request", http.StatusBadRequest)
		return
	}
	decision := modelretry.Decide(request.Message, request.Provider, request.RequestLimitTooSmall)
	response := modelRetryResponse{
		SwitchToBackup: decision.SwitchToBackup,
		RetrySameModel: decision.RetrySameModel,
	}
	if decision.Unexplained != nil {
		response.Unrecognized = &modelRetryUnrecognized{}
		if decision.Unexplained.HasStatus {
			status := decision.Unexplained.Status
			response.Unrecognized.Status = &status
		}
	}
	// The provider's message is not logged: it can quote the request.
	attributes := []any{
		"run.id", request.RunID,
		"provider", request.Provider,
		"model", request.Model,
		"retry.class", modelretry.Failure(request.Message, request.Provider, request.Provider, false).String(),
		"retry.switch_to_backup", decision.SwitchToBackup,
		"retry.same_model", decision.RetrySameModel,
		"retry.unrecognized", decision.Unexplained != nil,
		"retry.request_limit_too_small", request.RequestLimitTooSmall,
	}
	if status, ok := modelretry.Status(request.Message); ok {
		attributes = append(attributes, "error.status", status)
	}
	g.logger.Info("model.retry.decided", attributes...)
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(response)
}

func isLoopback(remoteAddr string) bool {
	ip := net.ParseIP(peerIP(remoteAddr))
	return ip != nil && ip.IsLoopback()
}
