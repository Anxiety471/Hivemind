// Package externalconversations ports externalConversations.updatePolicy: the
// linking member's rules for when the bot acts in an external chat.
package externalconversations

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/orpc"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/validate"
)

const (
	rulesMaxLength   = 4000
	maxPolicies      = 50
	keyMaxLength     = 200
	nameMaxLength    = 120
	maxRollupHours   = 720
	policiesTooMany  = "At most 50 automated sender policies are allowed"
	rollupNeedsHours = "Rollup policies require a frequency"
)

type senderPolicy struct {
	Name        string
	Mode        string
	RollupHours *int64
}

type policyEntry struct {
	Key    string
	Policy senderPolicy
}

// policy is the parsed input, in the order the schema writes it.
type policy struct {
	Ambient  *bool
	Rules    *string
	Policies []policyEntry
}

// parse mirrors UpdateExternalConversationPolicyInput:
// ExternalConversationPolicySchema.extend({ externalConversationId: Id }), a plain
// z.object, so unknown keys are ignored and every issue is reported in schema order.
func parse(raw orpc.Input) (policy, string, *orpc.Error) {
	var result policy
	object, issues := validate.Decode(raw.Raw, nil)
	if issues != nil {
		return result, "", validate.Fail(issues)
	}
	var found []validate.Issue

	ambient := object.Field("teamChatAmbientEnabled")
	if ambient != nil {
		value, problems := validate.Boolean(validate.Path{"teamChatAmbientEnabled"}, ambient)
		found = append(found, problems...)
		if problems == nil {
			result.Ambient = &value
		}
	}
	rules := object.Field("teamChatRules")
	if rules != nil {
		value, problems := validate.String(validate.Path{"teamChatRules"}, rules, validate.StringRules{Max: rulesMaxLength})
		found = append(found, problems...)
		if problems == nil {
			result.Rules = &value
		}
	}
	entries, problems := parsePolicies(object.Field("automatedSenderPolicies"))
	found = append(found, problems...)
	result.Policies = entries
	conversationID, problems := validate.String(validate.Path{"externalConversationId"}, object.Field("externalConversationId"), validate.StringRules{Min: 1})
	found = append(found, problems...)
	if found != nil {
		return policy{}, "", validate.Fail(found)
	}
	return result, conversationID, nil
}

// aborts reports whether an issue stops the checks that follow it (zod's `continue`
// is unset for type and enum failures and true for length and range ones).
func aborts(issue validate.Issue) bool {
	switch issue["code"] {
	case "too_small", "too_big", "custom", "unrecognized_keys":
		return false
	}
	return true
}

func anyAborts(issues []validate.Issue) bool {
	for _, issue := range issues {
		if aborts(issue) {
			return true
		}
	}
	return false
}

// parsePolicies is z.record(z.string().trim().min(1).max(200), AutomatedSenderPolicySchema)
// refined to at most 50 entries.
func parsePolicies(raw any) ([]policyEntry, []validate.Issue) {
	path := validate.Path{"automatedSenderPolicies"}
	record, ok := raw.(*validate.Object)
	if !ok {
		return nil, []validate.Issue{validate.TypeIssue("record", validate.JSType(raw), path)}
	}
	var found []validate.Issue
	var entries []policyEntry
	positions := map[string]int{}
	for _, key := range record.Keys {
		if key == "__proto__" {
			continue
		}
		trimmed := validate.JSTrim(key)
		count := len([]rune(trimmed))
		var keyIssues []validate.Issue
		if count < 1 {
			keyIssues = append(keyIssues, validate.Issue{
				"origin": "string", "code": "too_small", "minimum": 1, "inclusive": true, "path": []any{},
				"message": "Too small: expected string to have >=1 characters",
			})
		}
		if count > keyMaxLength {
			keyIssues = append(keyIssues, validate.Issue{
				"origin": "string", "code": "too_big", "maximum": keyMaxLength, "inclusive": true, "path": []any{},
				"message": "Too big: expected string to have <=200 characters",
			})
		}
		if keyIssues != nil {
			found = append(found, validate.Issue{
				"code": "invalid_key", "origin": "record", "issues": keyIssues, "path": path.With(key).Raw(),
				"message": "Invalid key in record",
			})
			continue
		}
		if trimmed == "__proto__" {
			continue
		}
		value, problems := parseSenderPolicy(path.With(key), record.Values[key])
		found = append(found, problems...)
		// An invalid value is still written under its key, as the record does.
		if index, seen := positions[trimmed]; seen {
			entries[index].Policy = value
		} else {
			positions[trimmed] = len(entries)
			entries = append(entries, policyEntry{Key: trimmed, Policy: value})
		}
	}
	// The refinement runs unless a type or key failure aborted the record.
	if !anyAborts(found) && len(entries) > maxPolicies {
		found = append(found, validate.Issue{"code": "custom", "path": path.Raw(), "message": policiesTooMany})
	}
	if found != nil {
		return nil, found
	}
	return entries, nil
}

// parseSenderPolicy is AutomatedSenderPolicySchema: name (trimmed 1..120), mode, an
// optional whole rollupHours 1..720, and a rollup needs its hours.
func parseSenderPolicy(path validate.Path, raw any) (senderPolicy, []validate.Issue) {
	var result senderPolicy
	object, issues := validate.AsObject(raw, path)
	if issues != nil {
		return result, issues
	}
	var found []validate.Issue
	name, problems := validate.String(path.With("name"), object.Field("name"), validate.StringRules{Trim: true, Min: 1, Max: nameMaxLength})
	found = append(found, problems...)
	result.Name = name
	mode, problems := validate.Enum(path.With("mode"), object.Field("mode"), "ignore", "rollup", "action", "user")
	found = append(found, problems...)
	result.Mode = mode
	if hours, present := object.Get("rollupHours"); present {
		value, problems := validate.Integer(path.With("rollupHours"), hours, validate.NumberRules{Min: validate.Float(1), Max: validate.Float(maxRollupHours)})
		found = append(found, problems...)
		if problems == nil {
			result.RollupHours = &value
		}
	}
	if !anyAborts(found) && mode == "rollup" && result.RollupHours == nil {
		found = append(found, validate.Issue{"code": "custom", "message": rollupNeedsHours, "path": path.With("rollupHours").Raw()})
	}
	return result, found
}

func stringJSON(value string) string {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	_ = encoder.Encode(value)
	return strings.TrimSuffix(buffer.String(), "\n")
}

// policiesJSON is JSON.stringify of the parsed policies, in JavaScript key order
// (whole-number keys first, ascending). sanitize applies the write-time clean-up:
// NUL becomes U+FFFD in keys and text, and keys that collide afterwards are told apart.
func policiesJSON(entries []policyEntry, sanitize bool) string {
	ordered := make([]policyEntry, 0, len(entries))
	var indexed, named []policyEntry
	for _, entry := range entries {
		if n, err := strconv.ParseUint(entry.Key, 10, 64); err == nil && strconv.FormatUint(n, 10) == entry.Key && n < 4294967295 {
			indexed = append(indexed, entry)
		} else {
			named = append(named, entry)
		}
	}
	for i := 1; i < len(indexed); i++ {
		for j := i; j > 0; j-- {
			a, _ := strconv.ParseUint(indexed[j-1].Key, 10, 64)
			b, _ := strconv.ParseUint(indexed[j].Key, 10, 64)
			if a <= b {
				break
			}
			indexed[j-1], indexed[j] = indexed[j], indexed[j-1]
		}
	}
	ordered = append(append(ordered, indexed...), named...)
	clean := func(text string) string {
		if sanitize {
			return strings.ReplaceAll(text, "\x00", "\uFFFD")
		}
		return text
	}
	var out strings.Builder
	out.WriteByte('{')
	used := map[string]int{}
	for index, entry := range ordered {
		key := clean(entry.Key)
		seen := used[key]
		used[key] = seen + 1
		if sanitize && seen > 0 {
			key = key + "#" + strconv.Itoa(seen+1)
		}
		if index > 0 {
			out.WriteByte(',')
		}
		out.WriteString(stringJSON(key))
		out.WriteString(`:{"name":`)
		out.WriteString(stringJSON(clean(entry.Policy.Name)))
		out.WriteString(`,"mode":`)
		out.WriteString(stringJSON(entry.Policy.Mode))
		if entry.Policy.RollupHours != nil {
			out.WriteString(`,"rollupHours":`)
			out.WriteString(strconv.FormatInt(*entry.Policy.RollupHours, 10))
		}
		out.WriteByte('}')
	}
	out.WriteByte('}')
	return out.String()
}

// Output is the response: the policy as saved (unsanitized, as TypeScript echoes it).
type Output struct{ policy policy }

// MarshalJSON writes the fields in schema order.
func (o Output) MarshalJSON() ([]byte, error) {
	ambient, rules := "null", "null"
	if o.policy.Ambient != nil {
		ambient = strconv.FormatBool(*o.policy.Ambient)
	}
	if o.policy.Rules != nil {
		rules = stringJSON(*o.policy.Rules)
	}
	return []byte(`{"teamChatAmbientEnabled":` + ambient + `,"teamChatRules":` + rules + `,"automatedSenderPolicies":` + policiesJSON(o.policy.Policies, false) + `}`), nil
}

// UpdatePolicy implements externalConversations.updatePolicy: only the member who
// linked the conversation changes it, though the whole Space can see it.
func UpdatePolicy(ctx context.Context, database *db.DB, actor db.Actor, raw orpc.Input) (any, *orpc.Error) {
	parsed, conversationID, failure := parse(raw)
	if failure != nil {
		return nil, failure
	}
	var rules any
	if parsed.Rules != nil {
		rules = strings.ReplaceAll(*parsed.Rules, "\x00", "\uFFFD")
	}
	var ambient any
	if parsed.Ambient != nil {
		ambient = *parsed.Ambient
	}
	err := database.Tenant(ctx, actor, func(tx pgx.Tx) error {
		tag, err := tx.Exec(ctx, `UPDATE external_conversations
			SET "teamChatAmbientEnabled" = $1, "teamChatRules" = $2, "automatedSenderPolicies" = $3::jsonb, "updatedAt" = $4
			WHERE id = $5 AND "spaceId" = $6 AND "userId" = $7`,
			ambient, rules, policiesJSON(parsed.Policies, true), time.Now().UTC().Truncate(time.Millisecond),
			conversationID, actor.SpaceID, actor.UserID)
		if err != nil {
			return err
		}
		if tag.RowsAffected() != 1 {
			return orpc.NotFound("Resource not found")
		}
		return nil
	})
	if err != nil {
		var failure *orpc.Error
		if errors.As(err, &failure) {
			return nil, failure
		}
		if db.IsUnavailable(err) {
			return nil, orpc.Unavailable()
		}
		return nil, orpc.Internal()
	}
	return Output{policy: parsed}, nil
}
