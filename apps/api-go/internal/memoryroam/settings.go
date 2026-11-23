package memoryroam

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
)

const (
	// maxRetryAttempts bounds the automatic retries of one failed pass. The last
	// delay is four hours, so a broken provider is not called every quarter hour
	// forever.
	maxRetryAttempts = 5
	// maxStoredFailures keeps one pass's detail list bounded even for a large account.
	maxStoredFailures = 50
	// maxStoredTargets bounds the per-bot report stored on the settings row.
	maxStoredTargets = 200
)

var retryDelays = [...]time.Duration{
	15 * time.Minute,
	30 * time.Minute,
	time.Hour,
	2 * time.Hour,
	4 * time.Hour,
}

// Failure is one bot or one Space whose last attempt did not finish. It is
// stored with the settings row so Settings can name what failed and the next
// check knows which targets to retry.
type Failure struct {
	Kind  string `json:"kind"`
	ID    string `json:"id"`
	Name  string `json:"name"`
	Error string `json:"error"`
}

// Settings is one owner's memory-roamer switch and last result.
type Settings struct {
	UserID          string
	Enabled         bool
	IntervalMinutes int
	LastRunAt       *time.Time
	LastFailures    []Failure
	LastReport      []Target
	RetryAt         *time.Time
	RetryAttempt    int
}

type runMode int

const (
	modeSkip runMode = iota
	modeFull
	modeRetry
)

// loadSettings reads the selected owners' rows. A missing row means disabled.
func loadSettings(ctx context.Context, database *db.DB, userIDs []string) (map[string]Settings, error) {
	settings := map[string]Settings{}
	if len(userIDs) == 0 {
		return settings, nil
	}
	err := database.System(ctx, "memory roamer reads its settings", func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `SELECT "userId", enabled, "intervalMinutes", "lastRunAt",
				"lastFailures", "lastReport", "retryAt", "retryAttempt"
			FROM memory_roamer_settings WHERE "userId" = ANY($1)`, userIDs)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var value Settings
			var failures, report []byte
			if err := rows.Scan(&value.UserID, &value.Enabled, &value.IntervalMinutes, &value.LastRunAt,
				&failures, &report, &value.RetryAt, &value.RetryAttempt); err != nil {
				return err
			}
			value.LastFailures = decodeFailures(failures)
			value.LastReport = decodeReport(report)
			settings[value.UserID] = value
		}
		return rows.Err()
	})
	return settings, err
}

func decodeReport(raw []byte) []Target {
	if len(raw) == 0 {
		return nil
	}
	var targets []Target
	if err := json.Unmarshal(raw, &targets); err != nil {
		return nil
	}
	if len(targets) > maxStoredTargets {
		targets = targets[:maxStoredTargets]
	}
	return targets
}

func decodeFailures(raw []byte) []Failure {
	if len(raw) == 0 {
		return nil
	}
	var failures []Failure
	if err := json.Unmarshal(raw, &failures); err != nil {
		return nil
	}
	if len(failures) > maxStoredFailures {
		failures = failures[:maxStoredFailures]
	}
	return failures
}

// mode says what the next check should do. A full pass wins over a retry because
// it visits the failed targets anyway and is what the interval asks for.
func mode(setting Settings, now time.Time, force bool) runMode {
	if force {
		return modeFull
	}
	if !setting.Enabled {
		return modeSkip
	}
	if fullDue(setting, now) {
		return modeFull
	}
	if setting.RetryAt != nil && !now.Before(*setting.RetryAt) {
		return modeRetry
	}
	return modeSkip
}

func fullDue(setting Settings, now time.Time) bool {
	if setting.LastRunAt == nil {
		return true
	}
	interval := time.Duration(setting.IntervalMinutes) * time.Minute
	if interval <= 0 {
		interval = 6 * time.Hour
	}
	return now.Sub(*setting.LastRunAt) >= interval
}

// due reports whether an enabled owner's interval elapsed or a retry is waiting.
func due(setting Settings, now time.Time) bool {
	return mode(setting, now, false) != modeSkip
}

func skipReason(found bool, setting Settings, now time.Time) string {
	if !found || !setting.Enabled {
		return "disabled"
	}
	if mode(setting, now, false) == modeFull {
		return "due"
	}
	if mode(setting, now, false) == modeRetry {
		return "retry-due"
	}
	return "not-due"
}

func retryDelay(attempt int) time.Duration {
	if attempt < 1 {
		attempt = 1
	}
	if attempt > len(retryDelays) {
		attempt = len(retryDelays)
	}
	return retryDelays[attempt-1]
}

func retryTargets(failures []Failure) (map[string]bool, map[string]bool) {
	bots := map[string]bool{}
	spaces := map[string]bool{}
	for _, failure := range failures {
		switch failure.Kind {
		case "bot":
			bots[failure.ID] = true
		case "shared":
			spaces[failure.ID] = true
		}
	}
	return bots, spaces
}

func failureSummary(failures []Failure) string {
	bots := 0
	shared := 0
	for _, failure := range failures {
		switch failure.Kind {
		case "bot":
			bots++
		case "shared":
			shared++
		}
	}
	switch {
	case bots > 0 && shared > 0:
		return fmt.Sprintf("%s and shared memory failed", countLabel(bots, "bot", "bots"))
	case shared > 0:
		return "Shared memory failed"
	case bots > 0:
		return fmt.Sprintf("%s failed", countLabel(bots, "bot", "bots"))
	default:
		return ""
	}
}

func countLabel(count int, singular, plural string) string {
	if count == 1 {
		return fmt.Sprintf("1 %s", singular)
	}
	return fmt.Sprintf("%d %s", count, plural)
}

// recordRun records the end of a pass. It never creates a row: a disabled owner
// has no status to update. A nil retryAt clears any pending retry.
func recordRun(ctx context.Context, database *db.DB, userID string, changes int, model string,
	failures []Failure, report []Target, retryAt *time.Time, retryAttempt int) error {
	if len(failures) > maxStoredFailures {
		failures = failures[:maxStoredFailures]
	}
	if len(report) > maxStoredTargets {
		report = report[:maxStoredTargets]
	}
	var failuresJSON, reportJSON any
	if len(failures) > 0 {
		raw, err := json.Marshal(failures)
		if err != nil {
			return err
		}
		failuresJSON = string(raw)
	}
	if len(report) > 0 {
		raw, err := json.Marshal(report)
		if err != nil {
			return err
		}
		reportJSON = string(raw)
	}
	return database.System(ctx, "memory roamer records its pass", func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `UPDATE memory_roamer_settings SET
			"lastRunAt" = now(),
			"lastError" = NULLIF($2, ''),
			"lastChanges" = $3,
			"lastModel" = NULLIF($4, ''),
			"lastFailures" = $5::jsonb,
			"lastReport" = $6::jsonb,
			"retryAt" = $7,
			"retryAttempt" = $8,
			"updatedAt" = now()
			WHERE "userId" = $1`, userID, failureSummary(failures), changes, model,
			failuresJSON, reportJSON, retryAt, retryAttempt)
		return err
	})
}
