package events

import (
	"context"
	"encoding/json"
	"log/slog"
	"net"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
)

const (
	// subscriberBuffer is how many signals one subscriber can hold. A signal says "something
	// changed, read again", so when a slow reader's buffer is full the newest is dropped: a
	// signal it has not read yet already asks for the same read.
	subscriberBuffer = 32
	reconnectBase    = 250 * time.Millisecond
	reconnectMax     = 10 * time.Second
)

// Fanout hands the signals other processes publish with pg_notify to this process's
// subscribers: the receiving half of PostgresRealtimeFanout (packages/adapters/src/notifications/
// realtime.ts). One dedicated connection listens on rakazo_events for every subscriber, opened by
// the first Subscribe and kept until Close. After each (re)connect every subscriber gets one empty
// signal, because anything published while the listener was away is lost.
type Fanout struct {
	config *pgx.ConnConfig
	logger *slog.Logger

	ctx    context.Context
	cancel context.CancelFunc

	mu      sync.Mutex
	topics  map[string]map[*subscriber]struct{}
	started bool
}

// subscriber is one follower of a topic: a buffered channel a reader drains, or a callback the
// listener runs as the signal arrives. A callback must return at once and must not publish: the
// fanout calls it while holding its own lock, which is what keeps a burst from being split across
// deliveries (a coalescing reader such as the Space kinds needs every payload).
type subscriber struct {
	signals  chan string
	onSignal func(string)
}

func (s *subscriber) deliver(payload string) {
	if s.onSignal != nil {
		s.onSignal(payload)
		return
	}
	// A signal says "something changed, read again", so a slow reader's newest is dropped: one
	// already waiting asks for the same read. A reader that cannot lose a payload uses
	// SubscribeFunc and coalesces itself.
	select {
	case s.signals <- payload:
	default:
	}
}

// NewFanout returns a fanout that listens with its own connection made from config.
func NewFanout(config *pgx.ConnConfig, logger *slog.Logger) *Fanout {
	if logger == nil {
		logger = slog.New(slog.DiscardHandler)
	}
	listener := config.Copy()
	listener.RuntimeParams["application_name"] = "rakazo-api-go-realtime"
	// An idle listener never writes, so without probes a failover leaves it deaf.
	listener.DialFunc = (&net.Dialer{
		Timeout: 5 * time.Second,
		KeepAliveConfig: net.KeepAliveConfig{
			Enable: true, Idle: 30 * time.Second, Interval: 10 * time.Second, Count: 3,
		},
	}).DialContext
	ctx, cancel := context.WithCancel(context.Background())
	return &Fanout{
		config: listener, logger: logger, ctx: ctx, cancel: cancel,
		topics: map[string]map[*subscriber]struct{}{},
	}
}

// Subscribe follows one topic. Each signal's payload arrives on the channel; the returned func
// stops following and must be called once.
func (f *Fanout) Subscribe(topic string) (<-chan string, func()) {
	sub := &subscriber{signals: make(chan string, subscriberBuffer)}
	f.mu.Lock()
	if f.topics[topic] == nil {
		f.topics[topic] = map[*subscriber]struct{}{}
	}
	f.topics[topic][sub] = struct{}{}
	if !f.started && f.ctx.Err() == nil {
		f.started = true
		go f.listen()
	}
	f.mu.Unlock()
	return sub.signals, f.unsubscribe(topic, sub)
}

// SubscribeFunc follows one topic with a callback: every signal arrives, in order, with none
// dropped, so a reader that keeps its own coalescing state (a Set of Space kinds) cannot lose one.
// The callback runs on the listener goroutine while the fanout holds its lock: it must be quick
// and must not call back into the fanout.
func (f *Fanout) SubscribeFunc(topic string, onSignal func(string)) func() {
	sub := &subscriber{onSignal: onSignal}
	f.mu.Lock()
	if f.topics[topic] == nil {
		f.topics[topic] = map[*subscriber]struct{}{}
	}
	f.topics[topic][sub] = struct{}{}
	if !f.started && f.ctx.Err() == nil {
		f.started = true
		go f.listen()
	}
	f.mu.Unlock()
	return f.unsubscribe(topic, sub)
}

func (f *Fanout) unsubscribe(topic string, sub *subscriber) func() {
	return func() {
		f.mu.Lock()
		defer f.mu.Unlock()
		delete(f.topics[topic], sub)
		if len(f.topics[topic]) == 0 {
			delete(f.topics, topic)
		}
	}
}

// Close stops listening. Subscribers' channels stay open and quiet; their readers end with
// their own contexts.
func (f *Fanout) Close() { f.cancel() }

func (f *Fanout) listen() {
	for attempt := 0; f.ctx.Err() == nil; {
		conn, err := pgx.ConnectConfig(f.ctx, f.config)
		if err == nil {
			// writeaudit:dynamic LISTEN takes the fixed realtime channel; no bound values
			_, err = conn.Exec(f.ctx, "LISTEN "+RealtimeChannel)
			if err != nil {
				_ = conn.Close(context.WithoutCancel(f.ctx))
			}
		}
		if err == nil {
			attempt = 0
			f.deliverToAll("")
			err = f.receive(conn)
			_ = conn.Close(context.WithoutCancel(f.ctx))
		}
		if f.ctx.Err() != nil {
			return
		}
		f.logger.Warn("realtime listener lost; reconnecting", "error", err)
		select {
		case <-f.ctx.Done():
			return
		case <-time.After(min(reconnectMax, reconnectBase<<min(attempt, 6))):
		}
		attempt++
	}
}

func (f *Fanout) receive(conn *pgx.Conn) error {
	for {
		notification, err := conn.WaitForNotification(f.ctx)
		if err != nil {
			return err
		}
		if notification.Channel != RealtimeChannel || notification.Payload == "" {
			continue
		}
		var envelope struct {
			Topic   *string `json:"topic"`
			Payload *string `json:"payload"`
		}
		// A malformed signal is ignored: durable state stays in the database.
		if json.Unmarshal([]byte(notification.Payload), &envelope) != nil || envelope.Topic == nil || envelope.Payload == nil {
			continue
		}
		f.deliver(*envelope.Topic, *envelope.Payload)
	}
}

func (f *Fanout) deliver(topic, payload string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for sub := range f.topics[topic] {
		sub.deliver(payload)
	}
}

func (f *Fanout) deliverToAll(payload string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, subs := range f.topics {
		for sub := range subs {
			sub.deliver(payload)
		}
	}
}
