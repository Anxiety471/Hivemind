package integration

import (
	"bufio"
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/effects"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/events"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/local"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/shared"
)

// sseFrame is one block of a server-sent event stream.
type sseFrame struct{ event, data string }

// openStream posts to the procedure and returns the frames as they arrive.
func openStream(t *testing.T, url, cookie, space string) (*http.Response, <-chan sseFrame) {
	t.Helper()
	request, err := http.NewRequest(http.MethodPost, url, strings.NewReader(""))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("cookie", cookie)
	request.Header.Set("origin", "https://app.example.test")
	request.Header.Set("x-rakazo-space-id", space)
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	response, err := http.DefaultClient.Do(request.WithContext(ctx))
	if err != nil {
		t.Fatalf("open stream: %v", err)
	}
	t.Cleanup(func() { response.Body.Close() })
	frames := make(chan sseFrame, 64)
	go func() {
		defer close(frames)
		reader := bufio.NewReader(response.Body)
		var frame sseFrame
		for {
			line, err := reader.ReadString('\n')
			if err != nil {
				return
			}
			line = strings.TrimSuffix(line, "\n")
			switch {
			case line == "":
				frames <- frame
				frame = sseFrame{}
			case strings.HasPrefix(line, "event: "):
				frame.event = strings.TrimPrefix(line, "event: ")
			case strings.HasPrefix(line, "data: "):
				frame.data = strings.TrimPrefix(line, "data: ")
			}
		}
	}()
	return response, frames
}

func nextFrame(t *testing.T, frames <-chan sseFrame) (sseFrame, bool) {
	t.Helper()
	select {
	case frame, ok := <-frames:
		return frame, ok
	case <-time.After(5 * time.Second):
		t.Fatal("no frame within 5s")
		return sseFrame{}, false
	}
}

// nextMessage skips comments and returns the next message event's frame payload.
func nextMessage(t *testing.T, frames <-chan sseFrame) map[string]any {
	t.Helper()
	for {
		frame, ok := nextFrame(t, frames)
		if !ok {
			t.Fatal("stream ended")
		}
		if frame.event != "message" {
			continue
		}
		var envelope struct {
			JSON map[string]any `json:"json"`
		}
		if err := json.Unmarshal([]byte(frame.data), &envelope); err != nil {
			t.Fatalf("frame %q: %v", frame.data, err)
		}
		return envelope.JSON
	}
}

func TestBoardStreamDeliversSignalsHeartbeatsAndEndsWhenTheSessionDoes(t *testing.T) {
	database := openTestDB(t)
	s := seed(t, database)
	ctx := context.Background()
	fanout := events.NewFanout(database.Pool.Config().ConnConfig, nil)
	t.Cleanup(fanout.Close)
	server := testServerDeployed(t, database, local.Config{
		Stream: local.StreamTiming{Keepalive: 50 * time.Millisecond, Heartbeat: 400 * time.Millisecond, Recheck: 300 * time.Millisecond},
	}, nil, shared.Deployment{BoardLab: true, Realtime: fanout})
	cookie := "better-auth.session_token=" + signedCookie(testSecret, s.SessionToken)
	url := server.URL + "/rpc/boards/subscribe"

	response, frames := openStream(t, url, cookie, s.Space1)
	if response.StatusCode != 200 || response.Header.Get("Content-Type") != "text/event-stream" {
		t.Fatalf("status %d type %q", response.StatusCode, response.Header.Get("Content-Type"))
	}
	if first, _ := nextFrame(t, frames); first.event != "" || first.data != "" {
		t.Fatalf("the stream opens with an empty comment, got %+v", first)
	}

	// A board signal for this Space arrives with the ids it names; another Space's does not.
	notifier := effects.NewNotifier(database, nil)
	time.Sleep(300 * time.Millisecond) // the listener is up and has sent its catch-up frame
	notifier.PublishBoard(s.Space2, "board-other", "ticket-other")
	notifier.PublishBoard(s.Space1, "board-1", "ticket-1")
	notifier.Wait()
	for {
		frame := nextMessage(t, frames)
		if frame["ticketId"] == nil {
			continue
		}
		if frame["spaceId"] != s.Space1 || frame["boardId"] != "board-1" || frame["ticketId"] != "ticket-1" || frame["createdAt"] == nil {
			t.Fatalf("board frame = %v", frame)
		}
		break
	}

	// After a quiet spell the stream sends a frame of its own.
	beat := nextMessage(t, frames)
	if beat["spaceId"] != s.Space1 || beat["ticketId"] != nil {
		t.Fatalf("heartbeat = %v", beat)
	}

	// Ending the session ends the stream with UNAUTHORIZED at the next frame.
	if err := database.System(ctx, "end session", func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `DELETE FROM session WHERE id = $1`, s.SessionID)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	deadline := time.After(5 * time.Second)
	for {
		select {
		case frame, ok := <-frames:
			if !ok {
				t.Fatal("the stream closed without an error event")
			}
			if frame.event != "error" {
				continue
			}
			if !strings.Contains(frame.data, `"code":"UNAUTHORIZED"`) || !strings.Contains(frame.data, `"status":401`) {
				t.Fatalf("error event = %s", frame.data)
			}
			if _, ok := <-frames; ok {
				t.Fatal("the stream continues after its error")
			}
			return
		case <-deadline:
			t.Fatal("the stream outlived its session")
		}
	}
}

func TestBoardStreamIsRefusedWithoutTheBoardLab(t *testing.T) {
	database := openTestDB(t)
	s := seed(t, database)
	server := testServerDeployed(t, database, local.Config{}, nil, shared.Deployment{})
	cookie := "better-auth.session_token=" + signedCookie(testSecret, s.SessionToken)
	response, body := do(t, http.MethodPost, server.URL+"/rpc/boards/subscribe", cookie, "", map[string]string{"x-rakazo-space-id": s.Space1})
	if response.StatusCode != 404 || envelopeCode(t, body) != "NOT_FOUND" {
		t.Fatalf("status %d body %s", response.StatusCode, body)
	}
}
