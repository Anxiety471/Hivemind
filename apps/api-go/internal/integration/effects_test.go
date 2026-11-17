package integration

import (
	"context"
	"encoding/json"
	"sort"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/effects"
)

// listen subscribes to the realtime channel; collect returns what arrived within the wait.
func listen(t *testing.T, database *db.DB) func(wait time.Duration) []string {
	t.Helper()
	ctx := context.Background()
	conn, err := database.Pool.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(conn.Release)
	if _, err := conn.Exec(ctx, "LISTEN rakazo_events"); err != nil {
		t.Fatal(err)
	}
	return func(wait time.Duration) []string {
		var payloads []string
		for {
			waitCtx, cancel := context.WithTimeout(ctx, wait)
			notification, err := conn.Conn().WaitForNotification(waitCtx)
			cancel()
			if err != nil {
				sort.Strings(payloads)
				return payloads
			}
			payloads = append(payloads, notification.Payload)
		}
	}
}

func TestRunnerRecordsSecurityAndAuditRowsForAuditedProcedures(t *testing.T) {
	database := openTestDB(t)
	s := seed(t, database)
	runner := effects.NewRunner(database, nil)
	actor := db.Actor{UserID: s.UserID, SpaceID: s.Space1}
	ctx := effects.WithCaller(context.Background(), effects.Caller{IP: "198.51.100.9", UserAgent: "contract-agent/1"})

	runner.After(ctx, "spendingLimit.set", actor, json.RawMessage(`{"limit":{"amount":500,"currency":"eur","period":"month"}}`), nil)
	runner.After(ctx, "spendingLimit.set", actor, json.RawMessage(`{"limit":null}`), nil)
	runner.After(ctx, "spendingLimit.get", actor, nil, nil) // not audited
	runner.Wait()

	type securityRow struct {
		Type, UserID, SpaceID, IP, UserAgent string
		Metadata                             map[string]any
	}
	var security []securityRow
	if err := database.System(context.Background(), "test read", func(tx pgx.Tx) error {
		rows, err := tx.Query(context.Background(), `SELECT type, "userId", "spaceId", ip, "userAgent", metadata FROM security_events WHERE "userId" = $1 ORDER BY "createdAt", metadata->>'currency' NULLS LAST`, s.UserID)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var row securityRow
			if err := rows.Scan(&row.Type, &row.UserID, &row.SpaceID, &row.IP, &row.UserAgent, &row.Metadata); err != nil {
				return err
			}
			security = append(security, row)
		}
		return rows.Err()
	}); err != nil {
		t.Fatal(err)
	}
	if len(security) != 2 {
		t.Fatalf("security events = %+v", security)
	}
	for _, row := range security {
		if row.Type != "approval.policy.changed" || row.SpaceID != s.Space1 || row.IP != "198.51.100.9" || row.UserAgent != "contract-agent/1" {
			t.Errorf("row = %+v", row)
		}
		if row.Metadata["procedure"] != "spendingLimit.set" || row.Metadata["kind"] != "spending_limit" {
			t.Errorf("metadata = %v", row.Metadata)
		}
	}

	audit := systemScalar[int](t, database, `SELECT count(*)::int FROM audit_events WHERE "actorId" = $1 AND action = 'approval.policy.changed'
		AND "organizationId" = $2 AND "spaceId" = $3 AND "spaceName" = 'Space one' AND "actorLabel" = $4 AND "actorType" = 'user'
		AND "targetType" = 'spending_limit' AND "targetId" IS NULL AND "targetLabel" IS NULL AND outcome = 'success'
		AND ip = '198.51.100.9' AND "userAgent" = 'contract-agent/1'`, s.UserID, s.OrgID, s.Space1, s.Email)
	if audit != 2 {
		t.Fatalf("audit rows = %d, want 2", audit)
	}
}

func TestRunnerSignalsRosterAndSpaceChanges(t *testing.T) {
	database := openTestDB(t)
	s := seed(t, database)
	runner := effects.NewRunner(database, nil)
	collect := listen(t, database)
	actor := db.Actor{UserID: s.UserID, SpaceID: s.Space1}

	runner.After(context.Background(), "botSections.create", actor, nil, nil)
	runner.After(context.Background(), "bots.remove", actor, nil, nil)
	runner.After(context.Background(), "botSections.list", actor, nil, nil) // no signal
	runner.Wait()

	got := collect(500 * time.Millisecond)
	want := []string{
		`{"topic":"roster-space:` + s.Space1 + `","payload":""}`,
		`{"topic":"roster-space:` + s.Space1 + `","payload":""}`,
		`{"topic":"space-changes:` + s.Space1 + `","payload":"routines"}`,
		`{"topic":"space-changes:` + s.Space1 + `","payload":"runs"}`,
	}
	sort.Strings(want)
	if len(got) != len(want) {
		t.Fatalf("notifications = %q", got)
	}
	for index := range want {
		if got[index] != want[index] {
			t.Fatalf("notifications = %q, want %q", got, want)
		}
	}
}
