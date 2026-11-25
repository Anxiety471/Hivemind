// Package livestream ports the account-level live-update streams: notifications.subscribe and
// notifications.subscribeCalls (apps/api/src/routes/account.ts:383-465). It also carries the
// runner the thread streams share (internal/procedures/threads/subscribe.go).
//
// The TypeScript streams are async generators merged by arrival (mergeStreams) and paced by
// withHeartbeats (apps/api/src/routes/shared.ts:190-250); local.Stream owns the same pacing and
// the session re-check, so each source here only produces frames.
package livestream

import (
	"context"
	"encoding/json"
	"sync"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/orpc"
)

// Frame is local.Stream.Frame for a source that already produced its wire JSON: the payload is
// the frame itself, spliced into the {"json":…} envelope unchanged. It is the same encoder
// orpc.Marshal uses for ordinary answers, so a frame's bytes match JSON.stringify.
func Frame(_ db.Actor, payload string) any { return json.RawMessage(payload) }

// HeartbeatFrame is the frame sent after a quiet spell on the account streams: liveness only, so
// the client tells it apart from a change and reads nothing for it.
func HeartbeatFrame() any { return map[string]any{"type": "heartbeat"} }

// Encode writes one frame the way JSON.stringify would.
func Encode(value any) (string, bool) {
	body, err := orpc.Marshal(value)
	if err != nil {
		return "", false
	}
	return string(body), true
}

// Runner owns the goroutines a stream's sources run on. Frames from every source share one
// unbuffered channel: a source hands over its next frame only when the stream takes it, which is
// how mergeStreams keeps one read in flight per source, so a burst cannot reorder a source's own
// frames or run ahead of a slow client.
type Runner struct {
	ctx    context.Context
	cancel context.CancelFunc
	out    chan string
	wg     sync.WaitGroup
}

// New starts a stream's sources under ctx.
func New(ctx context.Context) *Runner {
	streamCtx, cancel := context.WithCancel(ctx)
	return &Runner{ctx: streamCtx, cancel: cancel, out: make(chan string)}
}

// Go runs one source until ctx ends. Every source must use Send for its frames, which also ends
// on cancellation, so a stream whose client left never blocks a source forever.
func (r *Runner) Go(source func(ctx context.Context)) {
	r.wg.Add(1)
	go func() {
		defer r.wg.Done()
		source(r.ctx)
	}()
}

// Send hands one frame to the stream. False means the stream is over.
func (r *Runner) Send(frame string) bool {
	select {
	case <-r.ctx.Done():
		return false
	case r.out <- frame:
		return true
	}
}

// Frames is what local.Stream.Follow returns: the frames every source produces, and the stop
// that ends them. stop waits for the sources, so their fanout subscriptions are gone before the
// stream is reported closed (no goroutine or LISTEN subscriber survives a dropped stream).
func (r *Runner) Frames() (<-chan string, func()) {
	once := sync.Once{}
	return r.out, func() {
		once.Do(func() {
			r.cancel()
			r.wg.Wait()
		})
	}
}

// contextOf exposes the stream's own context to sources that need it outside the callback.
func (r *Runner) contextOf() context.Context { return r.ctx }

// latch mirrors ChangeLatch (packages/db/src/threads/event-stream.ts:175-202): a monotonic
// generation and one wake, so a burst of signals becomes one re-read.
type latch struct {
	mu         sync.Mutex
	generation int
	wake       chan struct{}
}

func newLatch() *latch { return &latch{wake: make(chan struct{}, 1)} }

func (l *latch) notify() {
	l.mu.Lock()
	l.generation++
	l.mu.Unlock()
	select {
	case l.wake <- struct{}{}:
	default:
	}
}

func (l *latch) snapshot() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.generation
}

func (l *latch) changed(seen int) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.generation != seen
}
