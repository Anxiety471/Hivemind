// Package approvalrules ports approvalRules.list and approvalRules.set
// (packages/db/src/approval-settings.ts). approvalRules.remove stays on the
// TypeScript API: it is audited with the caller's `id`, an arbitrary string the
// Go redaction gate cannot prove the TypeScript redactor leaves alone.
package approvalrules

import (
	"context"
	"errors"
	"time"
	"unicode"

	"github.com/jackc/pgx/v5"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/effects"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/orpc"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/shared"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/spacesettings"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/validate"
)

const isoMillis = "2006-01-02T15:04:05.000Z"

// Rule is the wire shape of ActionApprovalRuleSchema.
type Rule struct {
	ID         string `json:"id"`
	Effect     string `json:"effect"`
	MatchKind  string `json:"matchKind"`
	MatchValue string `json:"matchValue"`
	CreatedAt  string `json:"createdAt"`
}

func scanRule(row pgx.Row) (Rule, error) {
	var rule Rule
	var createdAt time.Time
	if err := row.Scan(&rule.ID, &rule.Effect, &rule.MatchKind, &rule.MatchValue, &createdAt); err != nil {
		return Rule{}, err
	}
	rule.CreatedAt = createdAt.UTC().Format(isoMillis)
	return rule, nil
}

// parseList mirrors settingsScopeInput.optional().
func parseList(raw orpc.Input) (string, *orpc.Error) {
	if len(raw.Raw) == 0 {
		return "", nil
	}
	object, issues := validate.Decode(raw.Raw, nil)
	if issues != nil {
		return "", validate.Fail(issues)
	}
	scope, issues := spacesettings.ParseScope(object)
	if issues != nil {
		return "", validate.Fail(issues)
	}
	return scope, nil
}

// List implements approvalRules.list: the rules of the copy that applies (or the
// one asked for), oldest first.
func List(ctx context.Context, database *db.DB, actor db.Actor, raw orpc.Input) (any, *orpc.Error) {
	requested, failure := parseList(raw)
	if failure != nil {
		return nil, failure
	}
	rules := []Rule{}
	err := database.Tenant(ctx, actor, func(tx pgx.Tx) error {
		target, err := spacesettings.Target(ctx, tx, actor, "confirmations", requested)
		if err != nil {
			return err
		}
		var rows pgx.Rows
		if target == "account" {
			rows, err = tx.Query(ctx, `SELECT id, effect, "matchKind", "matchValue", "createdAt" FROM user_action_approval_rules
				WHERE "userId" = $1 ORDER BY "createdAt" ASC`, actor.UserID)
		} else {
			rows, err = tx.Query(ctx, `SELECT id, effect, "matchKind", "matchValue", "createdAt" FROM action_approval_rules
				WHERE "spaceId" = $1 AND "createdByUserId" = $2 ORDER BY "createdAt" ASC`, actor.SpaceID, actor.UserID)
		}
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			rule, err := scanRule(rows)
			if err != nil {
				return err
			}
			// The router parses the output against ActionApprovalRuleSchema: the
			// effect and the match kind are enums a legacy row could sit outside.
			switch rule.Effect {
			case "always_allow", "require_approval", "deny":
			default:
				return shared.OutputInvalid()
			}
			switch rule.MatchKind {
			case "tool", "connector", "site", "category":
			default:
				return shared.OutputInvalid()
			}
			rules = append(rules, rule)
		}
		return rows.Err()
	})
	if err != nil {
		return nil, spacesettings.Failure(err)
	}
	return rules, nil
}

type setInput struct{ Scope, Effect, MatchKind, MatchValue string }

// parseSet mirrors settingsScopeInput.extend({ effect, matchKind, matchValue }).
func parseSet(raw orpc.Input) (setInput, *orpc.Error) {
	var input setInput
	object, issues := validate.Decode(raw.Raw, nil)
	if issues != nil {
		return input, validate.Fail(issues)
	}
	var found []validate.Issue
	scope, problems := spacesettings.ParseScope(object)
	found = append(found, problems...)
	effect, problems := validate.Enum(validate.Path{"effect"}, object.Field("effect"), "always_allow", "require_approval", "deny")
	found = append(found, problems...)
	kind, problems := validate.Enum(validate.Path{"matchKind"}, object.Field("matchKind"), "tool", "connector", "site")
	found = append(found, problems...)
	value, problems := validate.String(validate.Path{"matchValue"}, object.Field("matchValue"), validate.StringRules{Trim: true, Min: 1})
	found = append(found, problems...)
	if found != nil {
		return setInput{}, validate.Fail(found)
	}
	return setInput{Scope: scope, Effect: effect, MatchKind: kind, MatchValue: value}, nil
}

// Set implements approvalRules.set (saveApprovalRule): save a rule once, dropping any
// other effect on the same match in the same copy. Matching ignores case, compared
// here with JavaScript's toLowerCase; the lock keeps concurrent saves of different
// effects from both landing.
func Set(ctx context.Context, database *db.DB, actor db.Actor, raw orpc.Input) (any, *orpc.Error) {
	input, failure := parseSet(raw)
	if failure != nil {
		return nil, failure
	}
	var saved Rule
	err := database.Tenant(ctx, actor, func(tx pgx.Tx) error {
		var err error
		saved, err = save(ctx, tx, actor, input)
		return err
	})
	if err != nil {
		return nil, spacesettings.Failure(err)
	}
	return saved, nil
}

func save(ctx context.Context, tx pgx.Tx, actor db.Actor, input setInput) (Rule, error) {
	if err := spacesettings.Lock(ctx, tx, actor); err != nil {
		return Rule{}, err
	}
	target, err := spacesettings.Target(ctx, tx, actor, "confirmations", input.Scope)
	if err != nil {
		return Rule{}, err
	}
	account := target == "account"
	owner := actor.SpaceID + ":" + actor.UserID
	if account {
		owner = "account:" + actor.UserID
	}
	value := jsLower(input.MatchValue)
	var lock string
	// writeaudit:dynamic transaction-scoped advisory lock; no row payload
	if err := tx.QueryRow(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))::text AS "lock"`,
		"approval-rule:"+owner+":"+input.MatchKind+":"+value).Scan(&lock); err != nil {
		return Rule{}, err
	}
	// One rule per match, whatever its effect or spelling.
	var rows pgx.Rows
	if account {
		rows, err = tx.Query(ctx, `SELECT id, effect, "matchValue" FROM user_action_approval_rules WHERE "userId" = $1 AND "matchKind" = $2`,
			actor.UserID, input.MatchKind)
	} else {
		rows, err = tx.Query(ctx, `SELECT id, effect, "matchValue" FROM action_approval_rules
			WHERE "spaceId" = $1 AND "createdByUserId" = $2 AND "matchKind" = $3`, actor.SpaceID, actor.UserID, input.MatchKind)
	}
	if err != nil {
		return Rule{}, err
	}
	var replaced []string
	for rows.Next() {
		var id, effect, matchValue string
		if err := rows.Scan(&id, &effect, &matchValue); err != nil {
			rows.Close()
			return Rule{}, err
		}
		if jsLower(matchValue) == value && (effect != input.Effect || matchValue != input.MatchValue) {
			replaced = append(replaced, id)
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return Rule{}, err
	}
	table := "action_approval_rules"
	if account {
		table = "user_action_approval_rules"
	}
	if len(replaced) > 0 {
		if _, err := tx.Exec(ctx, `DELETE FROM `+table+` WHERE id = ANY($1)`, replaced); err != nil {
			return Rule{}, err
		}
	}
	// The upsert: the rule that is already there is returned as it is.
	const columns = `id, effect, "matchKind", "matchValue", "createdAt"`
	var rule Rule
	if account {
		rule, err = scanRule(tx.QueryRow(ctx, `INSERT INTO user_action_approval_rules (id, "userId", effect, "matchKind", "matchValue", "createdAt")
			VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT ("userId", effect, "matchKind", "matchValue") DO NOTHING RETURNING `+columns,
			db.Data(effects.NewID(), actor.UserID, input.Effect, input.MatchKind, input.MatchValue, time.Now().UTC().Truncate(time.Millisecond))...))
		if errors.Is(err, pgx.ErrNoRows) {
			rule, err = scanRule(tx.QueryRow(ctx, `SELECT `+columns+` FROM user_action_approval_rules
				WHERE "userId" = $1 AND effect = $2 AND "matchKind" = $3 AND "matchValue" = $4`,
				actor.UserID, input.Effect, input.MatchKind, input.MatchValue))
		}
	} else {
		rule, err = scanRule(tx.QueryRow(ctx, `INSERT INTO action_approval_rules (id, "spaceId", "createdByUserId", effect, "matchKind", "matchValue", "createdAt")
			VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT ("spaceId", "createdByUserId", effect, "matchKind", "matchValue") DO NOTHING RETURNING `+columns,
			db.Data(effects.NewID(), actor.SpaceID, actor.UserID, input.Effect, input.MatchKind, input.MatchValue, time.Now().UTC().Truncate(time.Millisecond))...))
		if errors.Is(err, pgx.ErrNoRows) {
			rule, err = scanRule(tx.QueryRow(ctx, `SELECT `+columns+` FROM action_approval_rules
				WHERE "spaceId" = $1 AND "createdByUserId" = $2 AND effect = $3 AND "matchKind" = $4 AND "matchValue" = $5`,
				actor.SpaceID, actor.UserID, input.Effect, input.MatchKind, input.MatchValue))
		}
	}
	return rule, err
}

// jsLower is String.prototype.toLowerCase: the full Unicode lowercase mapping, which
// differs from the simple one in two places: U+0130 becomes "i" and a combining dot,
// and a capital sigma at the end of a word becomes the final sigma.
func jsLower(text string) string {
	runes := []rune(text)
	out := make([]rune, 0, len(runes))
	for index, character := range runes {
		switch {
		case character == 0x130:
			out = append(out, 'i', 0x307)
		case character == 0x3A3:
			if finalSigma(runes, index) {
				out = append(out, 0x3C2)
			} else {
				out = append(out, 0x3C3)
			}
		default:
			out = append(out, unicode.ToLower(character))
		}
	}
	return string(out)
}

// finalSigma is the Final_Sigma condition: a cased letter before (skipping
// case-ignorable characters) and none after.
func finalSigma(runes []rune, index int) bool {
	before := false
	for i := index - 1; i >= 0; i-- {
		if caseIgnorable(runes[i]) {
			continue
		}
		before = cased(runes[i])
		break
	}
	if !before {
		return false
	}
	for i := index + 1; i < len(runes); i++ {
		if caseIgnorable(runes[i]) {
			continue
		}
		return !cased(runes[i])
	}
	return true
}

func cased(r rune) bool {
	return unicode.IsUpper(r) || unicode.IsLower(r) || unicode.IsTitle(r) ||
		unicode.Is(unicode.Other_Lowercase, r) || unicode.Is(unicode.Other_Uppercase, r)
}

// caseIgnorable is Case_Ignorable: nonspacing and enclosing marks, format characters,
// modifier letters and symbols, and the word-boundary punctuation.
func caseIgnorable(r rune) bool {
	if unicode.In(r, unicode.Mn, unicode.Me, unicode.Cf, unicode.Lm, unicode.Sk) {
		return true
	}
	switch r {
	case '\'', '.', ':', 0xB7, 0x387, 0x55F, 0x5F4, 0x2018, 0x2019, 0x2024, 0x2027, 0xFE13, 0xFE52, 0xFE55, 0xFF07, 0xFF0E, 0xFF1A:
		return true
	}
	return false
}
