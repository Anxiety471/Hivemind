package secretstore

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/effects"
)

const (
	// ChangeTopic is the realtime topic a changed entry is announced on
	// (secret-store-factory.ts:94-105).
	ChangeTopic = "secret-store-change"
	// PostgresChannel is where the realtime fanout publishes (realtime.ts:7).
	PostgresChannel = "rakazo_events"
	// MaxNotifyBytes is the envelope limit a fanout enforces (realtime.ts:8).
	MaxNotifyBytes = 7_900
)

// Publisher is RealtimeFanout.publish (interfaces.ts:545-550).
type Publisher interface {
	Publish(ctx context.Context, topic, payload string) error
}

// PGPublisher publishes through `SELECT pg_notify('rakazo_events', $1)` on the
// runtime pool, as PostgresRealtimeFanout does through its publisher
// (realtime.ts:70-79).
type PGPublisher struct {
	DB     *db.DB
	Logger *slog.Logger
}

// Publish wraps payload in `{"topic":...,"payload":...}` and refuses an
// envelope over the limit. A fanout failure is returned; Notifier decides
// whether the caller sees it.
func (p *PGPublisher) Publish(ctx context.Context, topic, payload string) error {
	envelope, err := notifyEnvelope(topic, payload)
	if err != nil {
		return err
	}
	if len(envelope) > MaxNotifyBytes {
		return errors.New("Realtime signal exceeds the PostgreSQL NOTIFY payload limit")
	}
	if _, err := p.DB.Pool.Exec(ctx, "SELECT pg_notify($1, $2)", PostgresChannel, string(envelope)); err != nil {
		return err
	}
	return nil
}

// notifyEnvelope is the fanout envelope (realtime.ts:71). A struct keeps the
// field order TypeScript writes, so a byte-comparing relay sees the same bytes.
func notifyEnvelope(topic, payload string) ([]byte, error) {
	return json.Marshal(struct {
		Topic   string `json:"topic"`
		Payload string `json:"payload"`
	}{Topic: topic, Payload: payload})
}

// Notifier is ComposedSecretStore's cross-process change announcement
// (secret-store-factory.ts:58-124): every put and delete tells other API
// processes that the ref changed, so their cached copies and key rings drop it.
type Notifier struct {
	Publisher Publisher
	// Origin identifies this process; the receiver ignores its own events
	// (secret-store-factory.ts:59,100-103).
	Origin string
	Logger *slog.Logger
}

// NewNotifier returns a notifier with a fresh random origin.
func NewNotifier(publisher Publisher) *Notifier {
	return &Notifier{Publisher: publisher, Origin: effects.NewUUID()}
}

// Changed announces ref. A publish failure is logged and swallowed: the write
// already happened and other processes recover on their next read
// (secret-store-factory.ts:106-115). The announcement is not cancellable, as
// TypeScript's fanout publish takes no signal: a client disconnect must not
// leave other processes with a stale cached value.
func (n *Notifier) Changed(ctx context.Context, ref string) {
	if n == nil || n.Publisher == nil {
		return
	}
	payload, err := json.Marshal(map[string]string{"origin": n.Origin, "ref": ref})
	if err != nil {
		return
	}
	if err := n.Publisher.Publish(context.WithoutCancel(ctx), ChangeTopic, string(payload)); err != nil && n.Logger != nil {
		n.Logger.Warn("Secret change notification failed", "error", err)
	}
}

// Writer couples the local store with the change announcement. Consumers use
// it instead of Store so no write or delete forgets to tell the other
// processes (ComposedSecretStore, secret-store-factory.ts:126-160).
type Writer struct {
	Store    *Store
	Notifier *Notifier
}

// NewWriter returns a writer over store. A nil notifier is allowed for tests
// and for a process that has no realtime fanout.
func NewWriter(store *Store, notifier *Notifier) *Writer {
	return &Writer{Store: store, Notifier: notifier}
}

// Put seals and announces a value.
func (w *Writer) Put(ctx context.Context, plaintext string, options PutOptions) (Record, error) {
	record, err := w.Store.Put(ctx, plaintext, options)
	if err != nil {
		return Record{}, err
	}
	w.Notifier.Changed(ctx, record.Ref)
	return record, nil
}

// Load opens a value; it announces nothing.
func (w *Writer) Load(ctx context.Context, ref, recordID string) (string, error) {
	return w.Store.Load(ctx, ref, recordID)
}

// Delete announces the ref. The value lives in the row that held it, so the
// local store has nothing else to remove (secrets.ts:217-219).
func (w *Writer) Delete(ctx context.Context, ref, recordID string) {
	w.Store.Delete(ctx, ref, recordID)
	w.Notifier.Changed(ctx, ref)
}

// IsRemote is false for every ref of the local store.
func (w *Writer) IsRemote(ref string) bool { return w.Store.IsRemote(ref) }

// Held defers change announcements until Flush, mirroring
// holdSecretNotifications (secret-store-factory.ts:71-82): a write inside a
// database transaction must not wait for a second pooled connection to notify
// while its own transaction holds the first.
type Held struct {
	writer *Writer
	refs   []string
}

// Hold starts a deferred-notification scope.
func (w *Writer) Hold() *Held { return &Held{writer: w} }

// Put seals a value and defers its announcement.
func (h *Held) Put(ctx context.Context, plaintext string, options PutOptions) (Record, error) {
	record, err := h.writer.Store.Put(ctx, plaintext, options)
	if err != nil {
		return Record{}, err
	}
	h.refs = append(h.refs, record.Ref)
	return record, nil
}

// Delete announces the ref after Flush.
func (h *Held) Delete(ref string) { h.refs = append(h.refs, ref) }

// Flush announces everything deferred so far.
func (h *Held) Flush(ctx context.Context) {
	for _, ref := range h.refs {
		h.writer.Notifier.Changed(ctx, ref)
	}
	h.refs = nil
}
