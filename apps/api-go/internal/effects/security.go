package effects

import (
	"context"
	"errors"
	"log/slog"
	"math"
	"regexp"
	"strings"
	"time"
	"unicode/utf16"

	"github.com/jackc/pgx/v5"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/wtf8"
)

// SecurityEvent is one event to record (SecurityEventInput in security-events.ts).
type SecurityEvent struct {
	Type      string
	UserID    string
	SpaceID   string
	IP        string
	UserAgent string
	// Metadata keeps insertion order: the 16-key cap keeps the first sixteen.
	Metadata []Meta
}

// Meta is one metadata entry; Value is a string, bool, nil, int64 or float64.
type Meta struct {
	Key   string
	Value any
}

const (
	maxMetadataKeys   = 16
	maxMetadataString = 200
)

// Content-like keys are never stored, whatever the value.
var contentKey = regexp.MustCompile(`(?i)content|message|prompt|body|text|answer|instruction|password|passwd|secret|token|cookie|authorization|credential|api_?key|code|email`)

// notAudited are deployment-wide signals with no account to attribute them to.
var notAudited = map[string]bool{
	"auth.sign_in.failed": true, "auth.sign_up.failed": true, "egress.refused": true,
	"rate_limit.hit": true, "deployment.settings.changed": true,
}

var failureTypes = map[string]bool{
	"auth.sign_in.failed": true, "auth.sign_up.failed": true, "egress.refused": true, "rate_limit.hit": true,
}

// Recorder appends security and audit events.
type Recorder struct {
	db     *db.DB
	logger *slog.Logger
}

// NewRecorder returns a recorder writing through database.
func NewRecorder(database *db.DB, logger *slog.Logger) *Recorder {
	if logger == nil {
		logger = slog.New(slog.NewJSONHandler(discard{}, nil))
	}
	return &Recorder{db: database, logger: logger}
}

type discard struct{}

func (discard) Write(p []byte) (int, error) { return len(p), nil }

// Record is recordSecurityEvent: a log line, an append-only security_events row
// and, for an account's own action, the organization's audit_events row. It never
// returns an error for a failed write (the action already happened); an error is
// returned only for metadata this port refuses to redact.
func (r *Recorder) Record(ctx context.Context, input SecurityEvent) error {
	caller, _ := CallerFrom(ctx)
	metadata, err := securityEventMetadata(input.Metadata)
	if err != nil {
		r.logger.Error("security.event.unsupported_metadata", "type", input.Type, "error", err)
		return err
	}
	event := struct {
		Type, UserID, SpaceID, IP, UserAgent string
	}{
		Type:      input.Type,
		UserID:    bounded(first(input.UserID, ""), 128),
		SpaceID:   bounded(first(input.SpaceID, ""), 128),
		IP:        bounded(first(input.IP, caller.IP), 64),
		UserAgent: bounded(first(input.UserAgent, caller.UserAgent), 512),
	}
	level := slog.LevelInfo
	if failureTypes[event.Type] {
		level = slog.LevelWarn
	}
	r.logger.Log(ctx, level, "security.event",
		"security.event.type", event.Type, "user.id", event.UserID, "space.id", event.SpaceID,
		"client.ip", event.IP, "user_agent.original", event.UserAgent, "security.event.metadata", metadata)

	body, err := wtf8.Marshal(metadata)
	if err != nil {
		return err
	}
	if err := r.db.System(ctx, "append a security event", func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `INSERT INTO security_events (id, type, "userId", "spaceId", ip, "userAgent", metadata, "createdAt")
			VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
			db.Data(NewID(), event.Type, nullable(event.UserID), nullable(event.SpaceID), nullable(event.IP),
				nullable(event.UserAgent), db.JSONText(string(body)),
				time.Now().UTC().Truncate(time.Millisecond))...)
		return err
	}); err != nil {
		r.logger.Error("security.event.write_failed", "error", err)
	}

	if event.UserID != "" && !notAudited[event.Type] {
		kind, _ := metadata["kind"].(string)
		audit := AuditEvent{
			Action:   event.Type,
			ActorID:  event.UserID,
			SpaceID:  event.SpaceID,
			Metadata: input.Metadata,
		}
		if kind != "" {
			audit.TargetType = kind
		}
		// Every vault item is its person's own; see the vault rule in audit-events.ts.
		if kind == "vault_credential" {
			audit.UserID = event.UserID
		}
		if err := r.recordAudit(WithCaller(ctx, Caller{IP: event.IP, UserAgent: event.UserAgent}), audit); err != nil {
			r.logger.Error("audit.event.write_failed", "audit.event.action", audit.Action, "error", err)
		}
	}
	return nil
}

// securityEventMetadata keeps what is safe to store: scalar values under keys that
// cannot carry content, at most sixteen keys, strings cut to 200 UTF-16 units.
func securityEventMetadata(metadata []Meta) (map[string]any, error) {
	kept := map[string]any{}
	for _, entry := range metadata {
		if len(kept) >= maxMetadataKeys {
			break
		}
		if contentKey.MatchString(entry.Key) || utf16Length(entry.Key) > 64 {
			continue
		}
		var value any
		switch typed := entry.Value.(type) {
		case nil:
			value = nil
		case string:
			value = sliceUTF16(typed, maxMetadataString)
		case bool:
			value = typed
		case int64:
			value = typed
		case float64:
			if math.IsNaN(typed) || math.IsInf(typed, 0) {
				continue
			}
			value = typed
		default:
			continue
		}
		kept[entry.Key] = value
	}
	// redactBindings, for the values this port can prove it leaves alone.
	for key, value := range kept {
		if shouldRedactKey(key, value) {
			kept[key] = "[Redacted]"
			continue
		}
		if text, ok := value.(string); ok {
			redacted, err := redactText(text)
			if err != nil {
				return nil, err
			}
			kept[key] = redacted
		}
	}
	return kept, nil
}

func first(value, fallback string) string {
	if value != "" {
		return value
	}
	return fallback
}

func nullable(value string) any {
	if value == "" {
		return nil
	}
	return value
}

func bounded(value string, max int) string {
	return sliceUTF16(value, max)
}

func utf16Length(value string) int { return len(wtf8.Units(value)) }

// sliceUTF16 is value.slice(0, max) in UTF-16 code units, then the write hook's
// sanitizeUtf16ForJson (packages/db/src/security-events.ts:134, text-sanitization.ts:58): a cut
// that lands inside a surrogate pair leaves one lone half, which becomes U+FFFD.
func sliceUTF16(value string, max int) string {
	units := wtf8.Units(value)
	if max < 0 {
		max = 0
	}
	if max > len(units) {
		max = len(units)
	}
	var out strings.Builder
	for index := 0; index < max; index++ {
		unit := units[index]
		if unit >= 0xD800 && unit <= 0xDBFF && index+1 < max && units[index+1] >= 0xDC00 && units[index+1] <= 0xDFFF {
			out.WriteRune(utf16.DecodeRune(rune(unit), rune(units[index+1])))
			index++
			continue
		}
		if unit >= 0xD800 && unit <= 0xDFFF {
			out.WriteRune('\uFFFD')
			continue
		}
		out.WriteRune(rune(unit))
	}
	return out.String()
}

// ErrUnsupportedAudit marks an audit event shape this port does not cover.
var ErrUnsupportedAudit = errors.New("audit event shape is not ported")
