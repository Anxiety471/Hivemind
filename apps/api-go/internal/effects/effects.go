package effects

import (
	"context"
	"encoding/json"
	"log/slog"
	"strings"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
)

// Runner does what the TypeScript `authed` middleware does once a procedure has
// returned (routes/context.ts:455-464): record its security event, then signal
// roster and Space changes. Failures in any of it never fail the procedure.
type Runner struct {
	recorder *Recorder
	notifier *Notifier
}

// NewRunner builds a runner over database.
func NewRunner(database *db.DB, logger *slog.Logger) *Runner {
	return &Runner{recorder: NewRecorder(database, logger), notifier: NewNotifier(database, logger)}
}

// Wait blocks until every background signal has been delivered or dropped.
func (r *Runner) Wait() { r.notifier.Wait() }

// Recorder is the audit and security-event writer the procedures share, so one process does
// not build several recorders over the same database.
func (r *Runner) Recorder() *Recorder { return r.recorder }

// Signals is the realtime notifier the procedures publish through: thread cursors, organization
// changes and board changes all reach subscribers through it.
func (r *Runner) Signals() *Notifier { return r.notifier }

// After runs the effects of a procedure that succeeded. The security event is
// written before it returns; roster and Space signals go out in the background.
func (r *Runner) After(ctx context.Context, procedure string, actor db.Actor, input json.RawMessage, output any) {
	fields := decodeFields(input)
	if event, ok := SecurityEventFor(procedure, fields, actor); ok {
		_ = r.recorder.Record(ctx, event)
	}
	if change, ok := RosterChangeFor(procedure, actor, fields, output); ok {
		r.notifier.PublishRoster(change)
	}
	for _, kind := range SpaceChangesFor(procedure) {
		r.notifier.PublishSpaceChange(actor.SpaceID, kind)
	}
}

func decodeFields(input json.RawMessage) map[string]any {
	if len(input) == 0 {
		return nil
	}
	var fields map[string]any
	if err := json.Unmarshal(input, &fields); err != nil {
		return nil
	}
	return fields
}

type audited struct {
	Type   string
	Kind   string
	Fields []string
}

// auditedProcedures is the part of AUDITED_PROCEDURES (security-audit.ts) whose
// procedures this build serves. Each entry added later must have its metadata
// values checked against the redaction gate (redact.go) and a contract case.
var auditedProcedures = map[string]audited{
	"spendingLimit.set": {Type: "approval.policy.changed", Kind: "spending_limit", Fields: []string{"limit.currency", "limit.period"}},
	// approvalRules.remove is not served: it records the caller's own `id`, free text.
	"approvalRules.set":         {Type: "approval.policy.changed", Fields: []string{"effect", "matchKind"}},
	"spaceSettings.setOverride": {Type: "approval.policy.changed", Fields: []string{"setting", "enabled"}},
	"bots.rotateWebhookSecret":  {Type: "credential.changed", Kind: "webhook", Fields: []string{"botId"}},
	"mcp.assignments.approve":   {Type: "approval.decided", Kind: "mcp", Fields: []string{"botId", "serverId"}},
	"mcp.assignments.dismiss":   {Type: "approval.decided", Kind: "mcp", Fields: []string{"botId", "serverId"}},
	"mcp.servers.remove":        {Type: "credential.deleted", Kind: "mcp", Fields: []string{"id"}},
	"mcp.oauth.disconnect":      {Type: "credential.deleted", Kind: "mcp_oauth", Fields: []string{"serverId"}},
}

// SecurityEventFor is procedureSecurityEvent: the event for a procedure that just
// succeeded, or false when it is not audited.
func SecurityEventFor(procedure string, input map[string]any, actor db.Actor) (SecurityEvent, bool) {
	entry, ok := auditedProcedures[procedure]
	if !ok {
		return SecurityEvent{}, false
	}
	metadata := []Meta{{Key: "procedure", Value: procedure}}
	if entry.Kind != "" {
		metadata = append(metadata, Meta{Key: "kind", Value: entry.Kind})
	}
	for _, field := range entry.Fields {
		var value any = input
		for _, key := range strings.Split(field, ".") {
			parent, isRecord := value.(map[string]any)
			if !isRecord {
				value = nil
				break
			}
			value = parent[key]
		}
		name := field[strings.LastIndex(field, ".")+1:]
		switch typed := value.(type) {
		case string, bool:
			metadata = append(metadata, Meta{Key: name, Value: typed})
		case nil:
			// null is kept, undefined is not; a missing key and a null both read nil here, so check.
			if hasField(input, field) {
				metadata = append(metadata, Meta{Key: name, Value: nil})
			}
		}
	}
	// auth-audit.ts pins the decision the procedure made (security-audit.ts:161).
	if procedure == "mcp.assignments.approve" {
		metadata = append(metadata, Meta{Key: "decision", Value: "allow"})
	}
	return SecurityEvent{Type: entry.Type, UserID: actor.UserID, SpaceID: actor.SpaceID, Metadata: metadata}, true
}

// hasField reports whether a dotted path exists in input (so null can be told from undefined).
func hasField(input map[string]any, field string) bool {
	var value any = input
	for _, key := range strings.Split(field, ".") {
		parent, isRecord := value.(map[string]any)
		if !isRecord {
			return false
		}
		next, present := parent[key]
		if !present {
			return false
		}
		value = next
	}
	return true
}

type rosterScope func(actor db.Actor, input map[string]any, output any) RosterChange

func stringField(value any, key string) string {
	if record, ok := value.(map[string]any); ok {
		found, _ := record[key].(string)
		return found
	}
	if value == nil {
		return ""
	}
	body, err := json.Marshal(value)
	if err != nil {
		return ""
	}
	var record map[string]any
	if json.Unmarshal(body, &record) != nil {
		return ""
	}
	found, _ := record[key].(string)
	return found
}

func ids(values ...string) []string {
	var kept []string
	for _, value := range values {
		if value != "" {
			kept = append(kept, value)
		}
	}
	return kept
}

var (
	actorSpace rosterScope = func(actor db.Actor, _ map[string]any, _ any) RosterChange {
		return RosterChange{SpaceIDs: []string{actor.SpaceID}}
	}
	actorOnly rosterScope = func(actor db.Actor, _ map[string]any, _ any) RosterChange {
		return RosterChange{UserIDs: []string{actor.UserID}}
	}
	namedSpace rosterScope = func(actor db.Actor, input map[string]any, _ any) RosterChange {
		return RosterChange{SpaceIDs: ids(stringField(input, "spaceId")), UserIDs: []string{actor.UserID}}
	}
)

// rosterProcedures is ROSTER_PROCEDURES (roster-procedures.ts): what changes
// `spaces.list`, and who sees the change.
var rosterProcedures = map[string]rosterScope{
	"bots.create": actorSpace, "bots.importCreate": actorSpace, "bots.createFromTemplate": actorSpace,
	"bots.duplicate": actorSpace, "bots.reorder": actorSpace, "bots.update": actorSpace,
	"bots.restoreInstructions": actorSpace, "bots.setComputer": actorSpace, "bots.archive": actorSpace,
	"bots.restore": actorSpace, "bots.remove": actorSpace, "bots.rotateWebhookSecret": actorSpace,
	"groups.create": actorSpace, "groups.duplicate": actorSpace, "groups.update": actorSpace,
	"groups.archive": actorSpace, "groups.restore": actorSpace, "groups.remove": actorSpace,
	"botSections.create": actorSpace, "botSections.update": actorSpace, "botSections.remove": actorSpace,
	"externalConversations.updatePolicy": actorSpace,
	"organizations.create":               actorOnly, "organizations.remove": actorOnly,
	"threads.markRead": actorOnly, "threads.markUnread": actorOnly, "threads.snooze": actorOnly,
	"spaces.create": actorOnly,
	"spaces.rename": namedSpace, "spaces.remove": namedSpace, "spaces.members.leave": namedSpace,
	"spaces.members.add": func(actor db.Actor, input map[string]any, _ any) RosterChange {
		return RosterChange{SpaceIDs: ids(stringField(input, "spaceId")), UserIDs: ids(actor.UserID, stringField(input, "userId"))}
	},
	"organizations.members.remove": func(actor db.Actor, input map[string]any, _ any) RosterChange {
		return RosterChange{UserIDs: ids(actor.UserID, stringField(input, "userId"))}
	},
	"organizations.invitations.accept": actorOnly,
	"spaces.members.remove": func(actor db.Actor, input map[string]any, _ any) RosterChange {
		return RosterChange{SpaceIDs: ids(stringField(input, "spaceId")), UserIDs: ids(actor.UserID, stringField(input, "userId"))}
	},
	"spaces.invites.accept": func(actor db.Actor, _ map[string]any, output any) RosterChange {
		return RosterChange{SpaceIDs: ids(stringField(output, "spaceId")), UserIDs: []string{actor.UserID}}
	},
}

// RosterChangeFor is rosterChangeFor.
func RosterChangeFor(procedure string, actor db.Actor, input map[string]any, output any) (RosterChange, bool) {
	scope, ok := rosterProcedures[procedure]
	if !ok {
		return RosterChange{}, false
	}
	return scope(actor, input, output), true
}

// spaceChangeProcedures is SPACE_CHANGE_PROCEDURES (space-change-procedures.ts).
var spaceChangeProcedures = map[string][]string{
	"routines.create": {"routines"}, "routines.update": {"routines"}, "routines.remove": {"routines"},
	"routines.testRun":         {"runs"},
	"threads.sendWithRoutines": {"runs"}, "threads.react": {"runs"}, "threads.endCall": {"runs"},
	"threads.followUp": {"runs"}, "skills.testRun": {"runs"},
	"bots.restore": {"runs", "routines"}, "bots.remove": {"runs", "routines"},
	"files.createFolder": {"files"}, "files.renameFolder": {"files"}, "files.moveFolder": {"files"},
	"files.trashFolder": {"files"}, "files.restoreFolder": {"files"}, "files.deleteFolder": {"files"},
	"files.rename": {"files"}, "files.update": {"files"}, "files.move": {"files"}, "files.trash": {"files"},
	"files.restore": {"files"}, "files.deletePermanent": {"files"}, "files.emptyTrash": {"files"},
	"artifacts.create": {"files"}, "artifacts.remove": {"files"},
}

// SpaceChangesFor is spaceChangesFor.
func SpaceChangesFor(procedure string) []string { return spaceChangeProcedures[procedure] }
