package local

import (
	"context"
	"net/http"
	"time"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/orpc"
)

// endStream finishes a stream whose sources have all returned: a clean close, one last `error`
// event, or a dropped connection.
func (s *Server) endStream(w http.ResponseWriter, procedure string, stream *Stream, follow *Follow, ctx context.Context) {
	if ctx.Err() != nil {
		// The client left (or the server is shutting down): there is nobody to tell.
		return
	}
	var ending Ending
	if follow.Ending != nil {
		ending = follow.Ending()
	}
	if ending.Abort {
		s.config.Logger.Info("stream.aborted", "procedure", procedure)
		abortStream()
	}
	if ending.Failure != nil {
		body, _ := orpc.ErrorBody(ending.Failure)
		_, _ = w.Write([]byte("event: error\ndata: " + string(body) + "\n\n"))
		if flusher, ok := w.(http.Flusher); ok {
			flusher.Flush()
		}
		s.config.Logger.Info("stream.ended", "procedure", procedure, "code", ending.Failure.Code)
	}
	_ = stream
}

// serveStream answers with an event stream shaped like the one oRPC's server writes: an empty
// comment first, `message` events carrying {"json": frame}, a comment every Keepalive, and an
// `error` event (then the end) when the stream fails. Like withHeartbeats
// (apps/api/src/routes/shared.ts), it sends a frame of its own after Heartbeat of silence and,
// before it sends any frame once Recheck has passed, looks the session up again: a signed-out or
// revoked session, or a person who left the Space, ends the stream with UNAUTHORIZED.
// abortStream drops the connection without net/http's terminating chunk, the TCP-level shape of
// controller.error(err): the client sees a broken stream, not a clean end.
func abortStream() { panic(http.ErrAbortHandler) }

func (s *Server) serveStream(w http.ResponseWriter, r *http.Request, procedure string, stream *Stream, actor db.Actor, input orpc.Input, ctx context.Context) {
	follow, failure := stream.Follow(ctx, actor, input)
	if failure != nil {
		// The follow step runs a procedure's own checks (boards.subscribe's Gate, say) before any
		// frame: a client that went away in that window is a disconnect, not a 5xx.
		s.fail(w, r, procedure, failure)
		return
	}
	defer follow.Stop()
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
	if follow.Failure != nil {
		body, _ := orpc.ErrorBody(follow.Failure)
		write("event: error\ndata: " + string(body) + "\n\n")
		s.config.Logger.Info("stream.ended", "procedure", procedure, "code", follow.Failure.Code)
		return
	}

	// oRPC arms its keepalive timer per pull and clears it when a frame arrives
	// (@orpc/standard-server-fetch toEventStream), so a stream that keeps sending never carries a
	// comment. Resetting a timer after each write is the same rule.
	keepalive := time.NewTimer(timing.Keepalive)
	defer keepalive.Stop()
	quiet := time.NewTimer(timing.Heartbeat)
	defer quiet.Stop()
	authorizedAt := time.Now()
	for {
		var payload string
		quietFrame := false
		select {
		case <-ctx.Done():
			return
		case <-keepalive.C:
			if !write(": \n\n") {
				return
			}
			keepalive.Reset(timing.Keepalive)
			continue
		case next, ok := <-follow.Signals:
			if !ok {
				s.endStream(w, procedure, stream, follow, ctx)
				return
			}
			payload = next
		case <-quiet.C:
			quietFrame = true
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
		frame := stream.Frame(actor, payload)
		if quietFrame && follow.Heartbeat != nil {
			frame = follow.Heartbeat()
		}
		body, err := orpc.Marshal(map[string]any{"json": frame})
		if err != nil {
			// JSON.stringify throwing inside a pull is controller.error: the body is cut off. A
			// frame that cannot be written is no cleaner: nothing after it can be trusted.
			s.config.Logger.Error("stream frame not encodable", "procedure", procedure, "error", err)
			abortStream()
		}
		if !write("event: message\ndata: " + string(body) + "\n\n") {
			return
		}
		quiet.Reset(timing.Heartbeat)
		keepalive.Reset(timing.Keepalive)
	}
}
