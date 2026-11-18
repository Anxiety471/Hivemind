package integration

import (
	"context"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/local"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/approvalrules"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/scratchpad"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/spacesettings"
)

func ruleCount(t *testing.T, database *db.DB, query string, args ...any) int {
	t.Helper()
	return systemScalar[int](t, database, query, args...)
}

// Concurrent saves of different effects (and spellings) for one match leave exactly one rule: the
// advisory lock, keyed as the TypeScript keys it, serializes them.
func TestApprovalRuleSavesOfOneMatchNeverBothLand(t *testing.T) {
	database := openTestDB(t)
	s := seed(t, database)
	actor := db.Actor{UserID: s.UserID, SpaceID: s.Space1}
	variants := []string{
		`{"effect":"deny","matchKind":"tool","matchValue":"Shell"}`,
		`{"effect":"always_allow","matchKind":"tool","matchValue":"shell"}`,
		`{"effect":"require_approval","matchKind":"tool","matchValue":"SHELL"}`,
		`{"effect":"deny","matchKind":"tool","matchValue":"sHELL"}`,
	}
	const rounds = 6
	var wg sync.WaitGroup
	failures := make(chan string, len(variants)*rounds)
	start := make(chan struct{})
	for range rounds {
		for _, variant := range variants {
			wg.Add(1)
			go func(variant string) {
				defer wg.Done()
				<-start
				if _, failure := approvalrules.Set(context.Background(), database, actor, raw(variant)); failure != nil {
					failures <- failure.Message
				}
			}(variant)
		}
	}
	close(start)
	wg.Wait()
	close(failures)
	for message := range failures {
		t.Fatalf("a save failed: %s", message)
	}
	if n := ruleCount(t, database, `SELECT count(*)::int FROM user_action_approval_rules WHERE "userId" = $1 AND lower("matchValue") = 'shell'`, s.UserID); n != 1 {
		t.Fatalf("%d rules for one match, want 1", n)
	}
	// An override changes the copy the next save lands in, and never leaves a rule in the wrong one.
	if _, failure := spacesettings.SetOverride(context.Background(), database, actor, raw(`{"setting":"confirmations","enabled":true}`)); failure != nil {
		t.Fatal(failure)
	}
	if n := ruleCount(t, database, `SELECT count(*)::int FROM action_approval_rules WHERE "spaceId" = $1 AND "createdByUserId" = $2`, s.Space1, s.UserID); n != 1 {
		t.Fatalf("the override copied %d rules, want the account's 1", n)
	}
}

// Rules saved while the override is switched on and off at the same time always land in the copy that
// was in force, and the membership lock keeps the two from interleaving.
func TestOverrideChangesAndRuleSavesSerialize(t *testing.T) {
	database := openTestDB(t)
	s := seed(t, database)
	actor := db.Actor{UserID: s.UserID, SpaceID: s.Space1}
	exec(t, database, `INSERT INTO user_action_approval_rules (id, "userId", effect, "matchKind", "matchValue") VALUES ($1, $2, 'deny', 'tool', 'seed')`, "r-"+s.UserID, s.UserID)
	var wg sync.WaitGroup
	start := make(chan struct{})
	errors := make(chan string, 64)
	for i := range 16 {
		wg.Add(2)
		go func(i int) {
			defer wg.Done()
			<-start
			enabled := "true"
			if i%2 == 1 {
				enabled = "false"
			}
			if _, failure := spacesettings.SetOverride(context.Background(), database, actor, raw(`{"setting":"confirmations","enabled":`+enabled+`}`)); failure != nil {
				errors <- "override: " + failure.Message
			}
		}(i)
		go func() {
			defer wg.Done()
			<-start
			if _, failure := approvalrules.Set(context.Background(), database, actor, raw(`{"effect":"deny","matchKind":"tool","matchValue":"x"}`)); failure != nil {
				errors <- "rule: " + failure.Message
			}
		}()
	}
	close(start)
	wg.Wait()
	close(errors)
	for message := range errors {
		t.Fatal(message)
	}
	overridden := ruleCount(t, database, `SELECT count(*)::int FROM space_setting_overrides WHERE "spaceId" = $1 AND "userId" = $2 AND setting = 'confirmations'`, s.Space1, s.UserID)
	spaceRules := ruleCount(t, database, `SELECT count(*)::int FROM action_approval_rules WHERE "spaceId" = $1 AND "createdByUserId" = $2`, s.Space1, s.UserID)
	if overridden == 0 && spaceRules != 0 {
		t.Fatalf("no override, yet %d Space rules were left behind", spaceRules)
	}
	if overridden == 1 && spaceRules == 0 {
		t.Fatal("an override with no copy of the account's rules")
	}
	for _, value := range []string{"x"} {
		if n := ruleCount(t, database, `SELECT count(*)::int FROM (SELECT 1 FROM user_action_approval_rules WHERE "userId" = $1 AND "matchValue" = $2
			UNION ALL SELECT 1 FROM action_approval_rules WHERE "spaceId" = $3 AND "createdByUserId" = $1 AND "matchValue" = $2) t`, s.UserID, value, s.Space1); n > 2 {
			t.Fatalf("%d copies of one rule", n)
		}
	}
}

// Ending a credentials override deletes only that Space's own credentials, and never reads or
// rewrites what any credential holds.
func TestCredentialsOverrideDeletesOnlyTheSpacesOwn(t *testing.T) {
	database := openTestDB(t)
	s := seed(t, database)
	actor := db.Actor{UserID: s.UserID, SpaceID: s.Space1}
	insert := func(id string, spaceID *string, userID string) {
		exec(t, database, `INSERT INTO vault_credentials (id, "userId", "spaceId", name, origin, auth, ciphertext, "updatedAt")
			VALUES ($1, $2, $3, $1, 'https://x.test', '{}'::jsonb, 'sealed-'||$1, now())`, id+s.UserID, userID, spaceID)
	}
	insert("own", &s.Space1, s.UserID)
	insert("elsewhere", &s.Space2, s.UserID)
	insert("account", nil, s.UserID)
	exec(t, database, `INSERT INTO space_setting_overrides ("spaceId", "userId", setting) VALUES ($1, $2, 'credentials')`, s.Space1, s.UserID)
	before := systemScalar[string](t, database, `SELECT string_agg(id||ciphertext||"updatedAt"::text, ',' ORDER BY id) FROM vault_credentials WHERE "userId" = $1 AND "spaceId" IS DISTINCT FROM $2`, s.UserID, s.Space1)
	if _, failure := spacesettings.SetOverride(context.Background(), database, actor, raw(`{"setting":"credentials","enabled":false}`)); failure != nil {
		t.Fatal(failure)
	}
	if n := ruleCount(t, database, `SELECT count(*)::int FROM vault_credentials WHERE "userId" = $1`, s.UserID); n != 2 {
		t.Fatalf("%d credentials left, want the other Space's and the account's", n)
	}
	after := systemScalar[string](t, database, `SELECT string_agg(id||ciphertext||"updatedAt"::text, ',' ORDER BY id) FROM vault_credentials WHERE "userId" = $1`, s.UserID)
	if before != after {
		t.Fatalf("surviving credentials changed:\n%s\n%s", before, after)
	}
	// Enabling again copies nothing: a Space's own vault starts empty.
	if _, failure := spacesettings.SetOverride(context.Background(), database, actor, raw(`{"setting":"credentials","enabled":true}`)); failure != nil {
		t.Fatal(failure)
	}
	if n := ruleCount(t, database, `SELECT count(*)::int FROM vault_credentials WHERE "userId" = $1 AND "spaceId" = $2`, s.UserID, s.Space1); n != 0 {
		t.Fatalf("%d credentials copied into the Space", n)
	}
}

// Over HTTP: no roster signal for any of these procedures, one approval.policy.changed event for each
// audited write with the TypeScript metadata, and the audit row of its organization.
func TestHTTPSettingsWritesAreAuditedAndSilent(t *testing.T) {
	database := openTestDB(t)
	s := seed(t, database)
	server := testServer(t, database, local.Config{})
	cookie := "better-auth.session_token=" + signedCookie(testSecret, s.SessionToken)
	bot := "b-" + s.UserID
	addBot(t, database, bot, s.Space1, s.UserID, "Bot")
	collect := listen(t, database, s.UserID, s.Space1, s.Space2)
	headers := map[string]string{"x-rakazo-space-id": s.Space1}
	call := func(procedure, body string) (int, string) {
		response, out := do(t, http.MethodPost, server.URL+"/rpc/"+procedure, cookie, `{"json":`+body+`}`, headers)
		return response.StatusCode, string(out)
	}
	if status, body := call("scratchpad/create", `{"botId":"`+bot+`","title":"  note  "}`); status != 200 || !strings.Contains(body, `"title":"note"`) {
		t.Fatalf("create = %d %s", status, body)
	}
	if status, body := call("approvalRules/set", `{"effect":"deny","matchKind":"site","matchValue":"x.example"}`); status != 200 || !strings.Contains(body, `"matchValue":"x.example"`) {
		t.Fatalf("set = %d %s", status, body)
	}
	// setOverride is not served here (it deletes vault credentials); the gateway proxies it.
	if status, _ := call("spaceSettings/setOverride", `{"setting":"models","enabled":true}`); status == 200 {
		t.Fatal("setOverride must not be served locally")
	}
	if status, body := call("approvalRules/set", `{"effect":"deny","matchKind":"category","matchValue":"x"}`); status != 400 {
		t.Fatalf("an invalid rule = %d %s", status, body)
	}
	if got := collect(500 * time.Millisecond); len(got) != 0 {
		t.Fatalf("signals = %q", got)
	}
	rows := systemScalar[string](t, database, `SELECT string_agg(metadata::text, ' | ' ORDER BY metadata::text) FROM security_events WHERE "userId" = $1 AND type = 'approval.policy.changed'`, s.UserID)
	want := `{"effect": "deny", "matchKind": "site", "procedure": "approvalRules.set"}`
	if rows != want {
		t.Fatalf("security events = %s", rows)
	}
	if n := systemScalar[int](t, database, `SELECT count(*)::int FROM audit_events WHERE "actorId" = $1 AND action = 'approval.policy.changed'`, s.UserID); n != 1 {
		t.Fatalf("%d audit rows, want 1", n)
	}
}

// An update that names no field writes nothing, a change moves the change time, and items are the
// Space's, not the writer's.
func TestScratchpadUpdateTouchesTheTimeOnlyWithAChange(t *testing.T) {
	database := openTestDB(t)
	s := seed(t, database)
	actor := db.Actor{UserID: s.UserID, SpaceID: s.Space1}
	bot := "b-" + s.UserID
	addBot(t, database, bot, s.Space1, s.UserID, "Bot")
	exec(t, database, `INSERT INTO scratchpad_items (id, "spaceId", "botId", "userId", title, status, notes, "createdAt", "updatedAt")
		VALUES ($1, $2, $3, $4, 'T', 'open', 'n', '2020-01-01', '2020-01-01')`, "i-"+s.UserID, s.Space1, bot, s.User2ID)
	recent := func() bool {
		return systemScalar[bool](t, database, `SELECT "updatedAt" > now() - interval '1 minute' FROM scratchpad_items WHERE id = $1`, "i-"+s.UserID)
	}
	if _, failure := scratchpad.Update(context.Background(), database, actor, raw(`{"itemId":"i-`+s.UserID+`"}`)); failure != nil {
		t.Fatal(failure)
	}
	if recent() {
		t.Fatal("an update with no fields wrote the row")
	}
	if _, failure := scratchpad.Update(context.Background(), database, actor, raw(`{"itemId":"i-`+s.UserID+`","status":"done"}`)); failure != nil {
		t.Fatal(failure)
	}
	if !recent() {
		t.Fatal("updatedAt did not move")
	}
	if owner := systemScalar[string](t, database, `SELECT "userId" FROM scratchpad_items WHERE id = $1`, "i-"+s.UserID); owner != s.User2ID {
		t.Fatalf("owner = %s", owner)
	}
}
