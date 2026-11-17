package spendinglimit

import (
	"context"
	"errors"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/orpc"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/validate"
)

// parseSet mirrors z.object({ limit: SpendingLimitSchema.nullable() }).strict(),
// with SpendingLimitSchema strict too. A nil limit removes the limit.
func parseSet(raw orpc.Input) (*Limit, *orpc.Error) {
	object, issues := validate.Decode(raw.Raw, nil)
	if issues != nil {
		return nil, validate.Fail(issues)
	}
	var found []validate.Issue
	var limit *Limit
	value := object.Field("limit")
	if value != nil {
		path := validate.Path{"limit"}
		inner, problems := validate.AsObject(value, path)
		if problems != nil {
			// A missing key and a wrong type both fail as the object the schema expects.
			if value == validate.Undefined {
				problems = []validate.Issue{validate.TypeIssue("object", "undefined", path)}
			}
			found = append(found, problems...)
		} else {
			parsed := Limit{}
			amount, problems := validate.Integer(path.With("amount"), inner.Field("amount"),
				validate.NumberRules{Gt: validate.Float(0), Max: validate.Float(maxSpendingLimit)})
			found = append(found, problems...)
			parsed.Amount = amount
			currency, problems := validate.Enum(path.With("currency"), inner.Field("currency"), currencies...)
			found = append(found, problems...)
			parsed.Currency = currency
			period, problems := validate.Enum(path.With("period"), inner.Field("period"), "day", "week", "month", "none")
			found = append(found, problems...)
			parsed.Period = period
			found = append(found, inner.Unrecognized(path, "amount", "currency", "period")...)
			limit = &parsed
		}
	}
	found = append(found, object.Unrecognized(nil, "limit")...)
	if found != nil {
		return nil, validate.Fail(found)
	}
	return limit, nil
}

// Set implements spendingLimit.set (routes/spending-limit.ts: saveSpendingLimit,
// then spendingStatus). The change is made under the user's spending lock, so a
// payment checked against the old limit is recorded before the new one is saved.
func Set(ctx context.Context, database *db.DB, actor db.Actor, raw orpc.Input, logger *slog.Logger) (Status, *orpc.Error) {
	limit, failure := parseSet(raw)
	if failure != nil {
		return Status{}, failure
	}
	err := database.Tenant(ctx, actor, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, "spending:"+actor.UserID); err != nil {
			return err
		}
		if limit == nil {
			_, err := tx.Exec(ctx, `DELETE FROM spending_limits WHERE "userId" = $1`, actor.UserID)
			return err
		}
		var current string
		err := tx.QueryRow(ctx, `SELECT period FROM spending_limits WHERE "userId" = $1`, actor.UserID).Scan(&current)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		// A limit that never resets starts counting again when it is set, or switched to
		// from one that resets.
		restart := limit.Period == "none" && current != "none"
		at := time.Now().UTC().Truncate(time.Millisecond)
		_, err = tx.Exec(ctx, `INSERT INTO spending_limits ("userId", amount, currency, period, "startsAt", "updatedAt")
			VALUES ($1, $2, $3, $4, $5, $5)
			ON CONFLICT ("userId") DO UPDATE SET amount = EXCLUDED.amount, currency = EXCLUDED.currency,
				period = EXCLUDED.period, "updatedAt" = EXCLUDED."updatedAt",
				"startsAt" = CASE WHEN $6 THEN EXCLUDED."startsAt" ELSE spending_limits."startsAt" END`,
			actor.UserID, limit.Amount, limit.Currency, limit.Period, at, restart)
		return err
	})
	if err != nil {
		return Status{}, failure2(err)
	}
	return Get(ctx, database, actor, logger)
}

func failure2(err error) *orpc.Error {
	if db.IsUnavailable(err) {
		return orpc.Unavailable()
	}
	return orpc.Internal()
}
