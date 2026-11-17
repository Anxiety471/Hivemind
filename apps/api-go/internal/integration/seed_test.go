package integration

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"net/url"
	"os"
	"strconv"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
)

const testSecret = "integration-test-secret-0123456789abcdef"

func openTestDB(t *testing.T) *db.DB {
	t.Helper()
	connectionString := os.Getenv("RAKAZO_TEST_DATABASE_URL")
	if connectionString == "" {
		t.Skip("set RAKAZO_TEST_DATABASE_URL to the fixture database to run integration tests")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	database, err := db.Open(ctx, connectionString, "rakazo-api-go-tests")
	if err != nil {
		t.Fatalf("open fixture database: %v", err)
	}
	t.Cleanup(database.Close)
	if err := database.StartupCheck(ctx); err != nil {
		t.Fatalf("fixture database is not safe for RLS: %v", err)
	}
	return database
}

type seeded struct {
	UserID, Email           string
	User2ID                 string
	SessionID, SessionToken string
	OrgID                   string
	Space1, Space2, Space3  string
	SkillID, SkillName      string
	ServerID, ServerSlug    string
	InstallID               string
	ChildSkillID            string
	ChildServerID           string
	SecretID                string
}

func seed(t *testing.T, database *db.DB) seeded {
	t.Helper()
	suffix := strconv.FormatInt(time.Now().UnixNano(), 36)
	s := seeded{
		UserID:        "u-" + suffix,
		Email:         "u-" + suffix + "@example.test",
		User2ID:       "u2-" + suffix,
		SessionID:     "s-" + suffix,
		SessionToken:  "tok-" + suffix + "-0123456789abcdef0123456789abcdef",
		OrgID:         "o-" + suffix,
		Space1:        "sp1-" + suffix,
		Space2:        "sp2-" + suffix,
		Space3:        "sp3-" + suffix,
		SkillID:       "sk-" + suffix,
		SkillName:     "Alpha skill " + suffix,
		ServerID:      "sv-" + suffix,
		ServerSlug:    "alpha-server-" + suffix,
		InstallID:     "in-" + suffix,
		ChildSkillID:  "csk-" + suffix,
		ChildServerID: "csv-" + suffix,
		SecretID:      "sec-" + suffix,
	}
	ctx := context.Background()
	err := database.System(ctx, "seed availability fixture", func(tx pgx.Tx) error {
		steps := []struct {
			sql  string
			args []any
		}{
			{`INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") VALUES ($1, $2, $3, true, now(), now())`,
				[]any{s.UserID, "Test User", s.Email}},
			{`INSERT INTO organization (id, name, slug, "createdAt") VALUES ($1, $2, $3, now())`,
				[]any{s.OrgID, "Test Org " + suffix, "org-" + suffix}},
			{`INSERT INTO member (id, "organizationId", "userId", role, "createdAt") VALUES ($1, $2, $3, 'owner', now())`,
				[]any{"m-" + suffix, s.OrgID, s.UserID}},
			{`INSERT INTO spaces (id, "organizationId", name, "isDefault", "createdAt") VALUES ($1, $2, $3, true, now())`,
				[]any{s.Space1, s.OrgID, "Space one"}},
			{`INSERT INTO spaces (id, "organizationId", name, "isDefault", "createdAt") VALUES ($1, $2, $3, false, now())`,
				[]any{s.Space2, s.OrgID, "Space two"}},
			{`INSERT INTO spaces (id, "organizationId", name, "isDefault", "createdAt") VALUES ($1, $2, $3, false, now())`,
				[]any{s.Space3, s.OrgID, "Space three"}},
			{`INSERT INTO space_members (id, "spaceId", "organizationId", "userId", role, "createdAt") VALUES ($1, $2, $3, $4, 'owner', now())`,
				[]any{"sm1-" + suffix, s.Space1, s.OrgID, s.UserID}},
			{`INSERT INTO space_members (id, "spaceId", "organizationId", "userId", role, "createdAt") VALUES ($1, $2, $3, $4, 'owner', now())`,
				[]any{"sm2-" + suffix, s.Space2, s.OrgID, s.UserID}},
			{`INSERT INTO space_members (id, "spaceId", "organizationId", "userId", role, "createdAt") VALUES ($1, $2, $3, $4, 'owner', now())`,
				[]any{"sm3-" + suffix, s.Space3, s.OrgID, s.UserID}},
			{`INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") VALUES ($1, $2, $3, true, now(), now())`,
				[]any{s.User2ID, "Other User", "u2-" + suffix + "@example.test"}},
			{`INSERT INTO member (id, "organizationId", "userId", role, "createdAt") VALUES ($1, $2, $3, 'member', now())`,
				[]any{"m2-" + suffix, s.OrgID, s.User2ID}},
			{`INSERT INTO space_members (id, "spaceId", "organizationId", "userId", role, "createdAt") VALUES ($1, $2, $3, $4, 'member', now())`,
				[]any{"sm2u2-" + suffix, s.Space2, s.OrgID, s.User2ID}},
			{`INSERT INTO session (id, "expiresAt", token, "userId", "createdAt", "updatedAt") VALUES ($1, now() + interval '7 days', $2, $3, now(), now())`,
				[]any{s.SessionID, s.SessionToken, s.UserID}},
			{`INSERT INTO agent_skills (id, "spaceId", "userId", name, description, content, source, "allSpaces", "createdAt", "updatedAt") VALUES ($1, $2, $3, $4, '', 'body', 'user', false, now(), now())`,
				[]any{s.SkillID, s.Space1, s.UserID, s.SkillName}},
			{`INSERT INTO secrets (id, "userId", "spaceId", kind, ciphertext, "createdAt") VALUES ($1, $2, $3, 'mcp', 'sealed', now())`,
				[]any{s.SecretID, s.UserID, s.Space1}},
			{`INSERT INTO mcp_servers (id, "spaceId", "userId", slug, name, transport, command, "secretId", "createdAt", "updatedAt") VALUES ($1, $2, $3, $4, $5, 'stdio', 'true', $6, now(), now())`,
				[]any{s.ServerID, s.Space1, s.UserID, s.ServerSlug, "Alpha server", s.SecretID}},
			{`INSERT INTO capability_installs (id, "spaceId", "userId", kind, name, source, config, "allSpaces", "createdAt") VALUES ($1, $2, $3, 'plugin', 'Alpha plugin', 'test', '{}', false, now())`,
				[]any{s.InstallID, s.Space1, s.UserID}},
			{`INSERT INTO agent_skills (id, "spaceId", "userId", name, description, content, source, "installId", "allSpaces", "createdAt", "updatedAt") VALUES ($1, $2, $3, $4, '', 'body', 'plugin', $5, false, now(), now())`,
				[]any{s.ChildSkillID, s.Space1, s.UserID, "Child skill " + suffix, s.InstallID}},
			{`INSERT INTO mcp_servers (id, "spaceId", "userId", slug, name, transport, command, "installId", "createdAt", "updatedAt") VALUES ($1, $2, $3, $4, $5, 'stdio', 'true', $6, now(), now())`,
				[]any{s.ChildServerID, s.Space1, s.UserID, "child-server-" + suffix, "Child server", s.InstallID}},
		}
		for _, step := range steps {
			if _, err := tx.Exec(ctx, step.sql, step.args...); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		t.Fatalf("seed fixture: %v", err)
	}
	return s
}

func signedRaw(secret, token string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(token))
	signature := base64.StdEncoding.EncodeToString(mac.Sum(nil))
	return token + "." + signature
}

func signedCookie(secret, token string) string {
	return url.QueryEscape(signedRaw(secret, token))
}

func testAuthConfig() (secret []byte, authURL string) {
	return []byte(testSecret), "http://127.0.0.1:5173"
}

func expiresIn(t *testing.T, database *db.DB, sessionID string) time.Time {
	t.Helper()
	var expires time.Time
	if err := database.Pool.QueryRow(context.Background(), `SELECT "expiresAt" FROM session WHERE id = $1`, sessionID).Scan(&expires); err != nil {
		t.Fatalf("read session expiry: %v", err)
	}
	return expires
}
