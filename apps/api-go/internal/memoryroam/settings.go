package memoryroam

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
)

// Settings is one owner's memory-roamer switch and last result.
type Settings struct {
	UserID          string
	Enabled         bool
	IntervalMinutes int
	LastRunAt       *time.Time
}

// loadSettings reads the selected owners' rows. A missing row means disabled.
func loadSettings(ctx context.Context, database *db.DB, userIDs []string) (map[string]Settings, error) {
	settings := map[string]Settings{}
	if len(userIDs) == 0 {
		return settings, nil
	}
	err := database.System(ctx, "memory roamer reads its settings", func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `SELECT "userId", enabled, "intervalMinutes", "lastRunAt"
			FROM memory_roamer_settings WHERE "userId" = ANY($1)`, userIDs)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var value Settings
			if err := rows.Scan(&value.UserID, &value.Enabled, &value.IntervalMinutes, &value.LastRunAt); err != nil {
				return err
			}
			settings[value.UserID] = value
		}
		return rows.Err()
	})
	return settings, err
}

// due reports whether an enabled owner's interval has elapsed.
func due(settings Settings, now time.Time) bool {
	if !settings.Enabled {
		return false
	}
	if settings.LastRunAt == nil {
		return true
	}
	interval := time.Duration(settings.IntervalMinutes) * time.Minute
	if interval <= 0 {
		interval = 6 * time.Hour
	}
	return now.Sub(*settings.LastRunAt) >= interval
}

// recordRun records the end of a pass. It never creates a row: a disabled owner
// has no status to update.
func recordRun(ctx context.Context, database *db.DB, userID string, changes int, model string, failure string) error {
	return database.System(ctx, "memory roamer records its pass", func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `UPDATE memory_roamer_settings SET
			"lastRunAt" = now(),
			"lastError" = NULLIF($2, ''),
			"lastChanges" = $3,
			"lastModel" = NULLIF($4, ''),
			"updatedAt" = now()
			WHERE "userId" = $1`, userID, failure, changes, model)
		return err
	})
}
