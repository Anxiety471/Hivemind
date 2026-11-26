package livestream

import (
	"context"
	"testing"
	"time"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/orpc"
)

// drained reads a channel to its close, returning every value it carried.
func drained(t *testing.T, frames <-chan string, wait time.Duration) []string {
	t.Helper()
	var out []string
	deadline := time.After(wait)
	for {
		select {
		case <-deadline:
			t.Fatalf("the channel did not close; saw %v", out)
		case frame, ok := <-frames:
			if !ok {
				return out
			}
			out = append(out, frame)
		}
	}
}

// TestRunnerClosesWhenEverySourceReturns: oRPC's controller.close() — a stream whose sources are
// gone ends; before this the channel stayed open and the response heartbeated forever.
func TestRunnerClosesWhenEverySourceReturns(t *testing.T) {
	r := New(context.Background())
	r.Go(func(ctx context.Context) {
		if !r.Send(`{"type":"one"}`) {
			t.Error("the first frame was refused")
		}
	})
	r.Go(func(ctx context.Context) {})
	frames, stop := r.Frames()
	defer stop()
	if got := drained(t, frames, 2*time.Second); len(got) != 1 || got[0] != `{"type":"one"}` {
		t.Fatalf("frames = %v", got)
	}
	if ending := r.Ending(); ending.Failure != nil || ending.Abort {
		t.Fatalf("ending = %+v", ending)
	}
}

// TestRunnerFailEndsTheRest: one failing source ends the stream — mergeStreams' "one that fails
// ends the rest" — and the ending carries the error the server writes last.
func TestRunnerFailEndsTheRest(t *testing.T) {
	r := New(context.Background())
	blocked := make(chan struct{})
	r.Go(func(ctx context.Context) {
		close(blocked)
		// A source that only ends on cancellation, like a fanout follower.
		<-ctx.Done()
	})
	<-blocked
	r.Go(func(ctx context.Context) { r.Fail(orpc.Internal()) })
	frames, stop := r.Frames()
	defer stop()
	drained(t, frames, 2*time.Second)
	ending := r.Ending()
	if ending.Failure == nil || ending.Failure.Code != "INTERNAL_SERVER_ERROR" || ending.Abort {
		t.Fatalf("ending = %+v", ending)
	}
}

// TestRunnerAbort: a frame that cannot be written is controller.error — the connection drops.
func TestRunnerAbort(t *testing.T) {
	r := New(context.Background())
	r.Go(func(ctx context.Context) { r.Abort() })
	frames, stop := r.Frames()
	defer stop()
	drained(t, frames, 2*time.Second)
	if ending := r.Ending(); !ending.Abort || ending.Failure != nil {
		t.Fatalf("ending = %+v", ending)
	}
}

// TestRunnerStopWaitsForItsSources: nothing may outlive the stream's own stop — a fanout
// subscription is released before the handler returns.
func TestRunnerStopWaitsForItsSources(t *testing.T) {
	r := New(context.Background())
	done := make(chan struct{})
	r.Go(func(ctx context.Context) {
		<-ctx.Done()
		time.Sleep(20 * time.Millisecond)
		close(done)
	})
	_, stop := r.Frames()
	stop()
	select {
	case <-done:
	default:
		t.Fatal("stop returned before its source did")
	}
}
