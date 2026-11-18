// Package spendinglimit ports spendingLimit.payments and spendingLimit.get.
// spendingLimit.set stays on the TypeScript API: it records a security event and
// takes the per-user spending advisory lock.
package spendinglimit

import (
	"context"
	"errors"
	"log/slog"
	"math"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/orpc"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/shared"
)

const (
	maxSpendingLimit = 100_000_000
	paymentsTake     = 50
)

var currencies = []string{"usd", "eur", "gbp", "ils"}

// Limit is the wire shape of SpendingLimitSchema.
type Limit struct {
	Amount   int64  `json:"amount"`
	Currency string `json:"currency"`
	Period   string `json:"period"`
}

// Status is spendingLimit.get's output.
type Status struct {
	Limit *Limit `json:"limit"`
	Spent int64  `json:"spent"`
	Shown bool   `json:"shown"`
}

// Payment is one row of spendingLimit.payments.
type Payment struct {
	ID        string  `json:"id"`
	Site      string  `json:"site"`
	Amount    int64   `json:"amount"`
	Currency  string  `json:"currency"`
	BotName   *string `json:"botName"`
	CreatedAt string  `json:"createdAt"`
}

// Payments implements spendingLimit.payments: the user's latest counted
// payments across Spaces, newest first, with the bot's name only while the bot
// is in a Space the user belongs to (read as system, as TypeScript does).
func Payments(ctx context.Context, database *db.DB, actor db.Actor) ([]Payment, *orpc.Error) {
	payments := []Payment{}
	err := database.Tenant(ctx, actor, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `SELECT id, site, amount, currency, "botId", "createdAt"
			FROM payments
			WHERE "userId" = $1 AND "releasedAt" IS NULL
			ORDER BY "createdAt" DESC, id DESC
			LIMIT $2`, actor.UserID, paymentsTake)
		if err != nil {
			return err
		}
		var botIDs []string
		var botOf []string
		for rows.Next() {
			var payment Payment
			var botID string
			var createdAt time.Time
			if err := rows.Scan(&payment.ID, &payment.Site, &payment.Amount, &payment.Currency, &botID, &createdAt); err != nil {
				rows.Close()
				return err
			}
			// The router parses the output: a payment's amount must be positive.
			if payment.Amount <= 0 {
				rows.Close()
				return shared.OutputInvalid()
			}
			payment.CreatedAt = createdAt.UTC().Format("2006-01-02T15:04:05.000Z")
			payments = append(payments, payment)
			botOf = append(botOf, botID)
			botIDs = append(botIDs, botID)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}
		if len(botIDs) == 0 {
			return nil
		}
		names := map[string]string{}
		err = database.InSystem(ctx, tx, func() error {
			bots, err := tx.Query(ctx, `SELECT b.id, b.name FROM bots b
				WHERE b.id = ANY($1)
					AND EXISTS (SELECT 1 FROM space_members sm WHERE sm."spaceId" = b."spaceId" AND sm."userId" = $2)`,
				botIDs, actor.UserID)
			if err != nil {
				return err
			}
			defer bots.Close()
			for bots.Next() {
				var id, name string
				if err := bots.Scan(&id, &name); err != nil {
					return err
				}
				names[id] = name
			}
			return bots.Err()
		})
		if err != nil {
			return err
		}
		for index := range payments {
			if name, ok := names[botOf[index]]; ok {
				payments[index].BotName = &name
			}
		}
		return nil
	})
	if err != nil {
		return nil, failure(err)
	}
	return payments, nil
}

// Get implements spendingLimit.get (spendingStatus, packages/db/src/spending.ts:184-220).
func Get(ctx context.Context, database *db.DB, actor db.Actor, logger *slog.Logger) (Status, *orpc.Error) {
	return get(ctx, database, actor, logger, time.Now())
}

func get(ctx context.Context, database *db.DB, actor db.Actor, logger *slog.Logger, now time.Time) (Status, *orpc.Error) {
	var status Status
	err := database.Tenant(ctx, actor, func(tx pgx.Tx) error {
		stored, startsAt, err := loadLimit(ctx, tx, actor.UserID, logger)
		if err != nil {
			return err
		}
		status.Limit = stored
		if stored != nil {
			spent, err := spentIn(ctx, tx, actor.UserID, *stored, startsAt, now)
			if err != nil {
				return err
			}
			status.Spent = spent
			// The router parses the output: spent is a nonnegative count of minor units.
			if spent < 0 {
				return shared.OutputInvalid()
			}
			status.Shown = true
			return nil
		}
		shown, err := canPay(ctx, tx, actor.UserID)
		status.Shown = shown
		return err
	})
	if err != nil {
		return Status{}, failure(err)
	}
	return status, nil
}

// loadLimit reads the stored limit. One this release cannot read still limits:
// each unreadable part becomes the strictest valid one (loadSpendingLimit).
func loadLimit(ctx context.Context, tx pgx.Tx, userID string, logger *slog.Logger) (*Limit, time.Time, error) {
	var amount int32
	var currency, period string
	var startsAt time.Time
	err := tx.QueryRow(ctx, `SELECT amount, currency, period, "startsAt" FROM spending_limits WHERE "userId" = $1`, userID).
		Scan(&amount, &currency, &period, &startsAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, time.Time{}, nil
	}
	if err != nil {
		return nil, time.Time{}, err
	}
	startsAt = startsAt.UTC()
	if amount > 0 && amount <= maxSpendingLimit && validCurrency(currency) && validPeriod(period) {
		return &Limit{Amount: int64(amount), Currency: currency, Period: period}, startsAt, nil
	}
	if logger != nil {
		logger.Warn("stored spending limit is invalid; enforcing the strictest reading")
	}
	strict := Limit{Amount: int64(amount), Currency: "usd", Period: "none"}
	if strict.Amount < 1 {
		strict.Amount = 1
	}
	strict.Amount = int64(math.Min(float64(strict.Amount), maxSpendingLimit))
	if validCurrency(currency) {
		strict.Currency = currency
	}
	if validPeriod(period) {
		strict.Period = period
	}
	return &strict, startsAt, nil
}

func spentIn(ctx context.Context, tx pgx.Tx, userID string, limit Limit, startsAt, now time.Time) (int64, error) {
	var timezone *string
	err := tx.QueryRow(ctx, `SELECT timezone FROM "user" WHERE id = $1`, userID).Scan(&timezone)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return 0, err
	}
	since := periodStart(limit.Period, startsAt, timezone, now)
	var spent int64
	err = tx.QueryRow(ctx, `SELECT coalesce(sum(amount), 0)::bigint FROM payments
		WHERE "userId" = $1 AND currency = $2 AND "releasedAt" IS NULL AND "createdAt" >= $3`,
		userID, limit.Currency, since.UTC()).Scan(&spent)
	return spent, err
}

// canPay: the limit matters once a bot has a way to pay (a saved card or a
// connected wallet) or has paid. vault_credentials is plaintext metadata here
// (`auth` JSON, never the sealed `ciphertext` column).
func canPay(ctx context.Context, tx pgx.Tx, userID string) (bool, error) {
	var shown bool
	err := tx.QueryRow(ctx, `SELECT
		EXISTS (SELECT 1 FROM vault_credentials WHERE "userId" = $1 AND auth #> '{type}' = '"card"'::jsonb)
		OR EXISTS (SELECT 1 FROM payment_wallets WHERE "userId" = $1 AND status = 'connected')
		OR EXISTS (SELECT 1 FROM payments WHERE "userId" = $1 AND "releasedAt" IS NULL)`, userID).Scan(&shown)
	return shown, err
}

func validCurrency(value string) bool {
	for _, candidate := range currencies {
		if candidate == value {
			return true
		}
	}
	return false
}

func validPeriod(value string) bool {
	return value == "day" || value == "week" || value == "month" || value == "none"
}

func failure(err error) *orpc.Error {
	var answer *orpc.Error
	if errors.As(err, &answer) {
		return answer
	}
	if db.IsUnavailable(err) {
		return orpc.Unavailable()
	}
	return orpc.Internal()
}
