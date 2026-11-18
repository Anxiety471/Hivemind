package shared

import (
	"context"
	"errors"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/orpc"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/validate"
)

// IDFields validates z.object({ <key>: Id, ... }) for string id fields (Id is
// z.string().min(1)); extra keys are ignored, as z.object does.
func IDFields(raw orpc.Input, keys ...string) (map[string]string, *orpc.Error) {
	object, issues := validate.Decode(raw.Raw, nil)
	if issues != nil {
		return nil, validate.Fail(issues)
	}
	var found []validate.Issue
	values := map[string]string{}
	for _, key := range keys {
		value, problems := validate.String(validate.Path{key}, object.Field(key), validate.StringRules{Min: 1})
		found = append(found, problems...)
		values[key] = value
	}
	if found != nil {
		return nil, validate.Fail(found)
	}
	return values, nil
}

// StoredText is the text as the API's Prisma client stores it: withTextSanitization
// replaces NUL with U+FFFD (an unpaired surrogate never survives Go's JSON decoding).
func StoredText(text string) string { return strings.ReplaceAll(text, "\x00", "\uFFFD") }

// TransactionConflict is a serialization failure or deadlock, which withTransactionRetry reruns.
func TransactionConflict(err error) bool {
	var pgErr interface{ SQLState() string }
	if errors.As(err, &pgErr) {
		switch pgErr.SQLState() {
		case "40001", "40P01":
			return true
		}
	}
	return false
}

const maxTransactionTries = 3

// Serializable is withTransactionRetry around a serializable transaction: fn runs
// in a tenant transaction at SERIALIZABLE and is run again, up to three times in
// all, when it lost a serialization or deadlock conflict.
func Serializable(ctx context.Context, database *db.DB, actor db.Actor, fn func(pgx.Tx) error) error {
	for attempt := 1; ; attempt++ {
		err := database.TenantSerializable(ctx, actor, fn)
		if err == nil || !TransactionConflict(err) || attempt >= maxTransactionTries {
			return err
		}
	}
}
