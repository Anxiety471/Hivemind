package local

import (
	"context"
	"net/http"
	"time"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/orpc"
)

// serveStream answers with an event stream shaped like the one oRPC's server writes: an empty
// comment first, `message` events carrying {"json": frame}, a comment every Keepalive, and an
// `error` event (then the end) when the stream fails. Like withHeartbeats
// (apps/api/src/routes/shared.ts), it sends a frame of its own after Heartbeat of silence and,
// before it sends any frame once Recheck has passed, looks the session up again: a signed-out or
// revoked session, or a person who left the Space, ends the stream with UNAUTHORIZED.
func (s *Server) serveStream(w http.ResponseWriter, r *http.Request, procedure string, stream *Stream, actor db.Actor, input orpc.Input, ctx context.Context) {
	signals, stop, failure := stream.Follow(ctx, actor, input)
	if failure != nil {
		orpc.WriteError(w, failure)
		return
	}
	defer stop()
	timing := s.config.Stream.withDefaults()

	w.Header().Set("Content-Type", "text/event-stream")
	w.WriteHeader(http.StatusOK)
	flusher, _ := w.(http.Flusher)
	write := func(frame string) bool {
		if _, err := w.Write([]byte(frame)); err != nil {
			return false
		}
		if flusher != nil {
			flusher.Flush()
		}
		return true
	}
	if !write(": \n\n") {
		return
	}

	keepalive := time.NewTicker(timing.Keepalive)
	defer keepalive.Stop()
	quiet := time.NewTimer(timing.Heartbeat)
	defer quiet.Stop()
	authorizedAt := time.Now()
	for {
		var payload string
		select {
		case <-ctx.Done():
			return
		case <-keepalive.C:
			if !write(": \n\n") {
				return
			}
			continue
		case payload = <-signals:
		case <-quiet.C:
		}
		if time.Since(authorizedAt) >= timing.Recheck {
			current, failure := s.auth.Recheck(ctx, r)
			if failure == nil && (current.UserID != actor.UserID || current.SpaceID != actor.SpaceID) {
				failure = orpc.Unauthorized()
			}
			if failure != nil {
				if ctx.Err() != nil {
					return
				}
				body, _ := orpc.ErrorBody(failure)
				write("event: error\ndata: " + string(body) + "\n\n")
				s.config.Logger.Info("stream.ended", "procedure", procedure, "code", failure.Code)
				return
			}
			authorizedAt = time.Now()
		}
		body, err := orpc.Marshal(map[string]any{"json": stream.Frame(actor, payload)})
		if err != nil {
			s.config.Logger.Error("stream frame not encodable", "procedure", procedure, "error", err)
			return
		}
		if !write("event: message\ndata: " + string(body) + "\n\n") {
			return
		}
		quiet.Reset(timing.Heartbeat)
	}
}
