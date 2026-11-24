// Package auth validates the existing better-auth session (cookie or signed
// bearer), applies the same lookup authorization the TypeScript API applies,
// renews the session cookie on the same schedule, and resolves the actor.
package auth

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/orpc"
)

const (
	sessionLifetime = 7 * 24 * time.Hour
	renewAfter      = 6 * 24 * time.Hour
	messagingSuffix = "@messaging.invalid"
)

// Config is what the session checks need.
type Config struct {
	Secret          []byte
	AuthURL         string
	SignupAllowlist []string
	// OIDCBypass mirrors OIDC_ALLOW_SIGNUP_BYPASS for a configured OIDC issuer.
	OIDCBypass bool
	// CookieDomain mirrors COOKIE_DOMAIN: a renewed session cookie keeps the domain it was set for.
	CookieDomain string
	// AfterDeleteSession mirrors env.afterDeleteSession
	// (apps/api/src/app.ts:616-624, called from packages/auth/src/index.ts:899-912):
	// better-auth runs it after it deletes a session row, and a cleanup failure
	// must not fail the request.
	AfterDeleteSession func(ctx context.Context, userID, sessionID string)
}

// Service validates sessions against the API's own tables.
type Service struct {
	database *db.DB
	config   Config
	names    []string
}

// New builds the service. The cookie is __Secure- prefixed when the auth URL
// is HTTPS, and the unprefixed name is accepted too, as better-auth does.
func New(database *db.DB, config Config) *Service {
	base := "better-auth.session_token"
	names := []string{base}
	if strings.HasPrefix(strings.ToLower(config.AuthURL), "https://") {
		names = []string{"__Secure-" + base, base}
	}
	return &Service{database: database, config: config, names: names}
}

// Session is one authenticated request.
type Session struct {
	ID                   string
	UserID               string
	Email                string
	Token                string
	ExpiresAt            time.Time
	ActiveOrganizationID *string
	CookieName           string
	ViaCookie            bool
}

// Authenticate resolves the session and, when due, renews it exactly as
// better-auth would: same token, new expiry, one Set-Cookie for the cookie the
// caller actually sent.
func (s *Service) Authenticate(ctx context.Context, r *http.Request) (*Session, *http.Cookie, *orpc.Error) {
	session, failure := s.session(ctx, r)
	if failure != nil {
		return nil, nil, failure
	}
	var renewal *http.Cookie
	if session.ViaCookie && time.Until(session.ExpiresAt) <= renewAfter {
		if cookie, err := s.renew(ctx, session); err == nil {
			renewal = cookie
		} else if db.IsUnavailable(err) {
			return nil, nil, orpc.Unavailable()
		}
	}
	return session, renewal, nil
}

// Recheck is the authorization a stream repeats while it stays open: the session and the Space
// are resolved again without renewing the cookie, as requestSession(request, true) does. A
// session that has ended, or a person who left the Space, comes back as Unauthorized.
func (s *Service) Recheck(ctx context.Context, r *http.Request) (db.Actor, *orpc.Error) {
	session, failure := s.session(ctx, r)
	if failure != nil {
		return db.Actor{}, failure
	}
	return s.Actor(ctx, session, r.Header.Get("x-rakazo-space-id"))
}

// session finds and authorizes the request's session.
func (s *Service) session(ctx context.Context, r *http.Request) (*Session, *orpc.Error) {
	token, cookieName, viaCookie, signed := credentials(r, s.names)
	if token == "" {
		return nil, orpc.Unauthorized()
	}
	raw, ok := s.verify(token)
	if !ok || !signed {
		return nil, orpc.Unauthorized()
	}
	session, failure := s.load(ctx, raw)
	if failure != nil {
		return nil, failure
	}
	session.CookieName = cookieName
	session.ViaCookie = viaCookie
	if failure := s.authorized(ctx, session); failure != nil {
		return nil, failure
	}
	return session, nil
}

func (s *Service) load(ctx context.Context, token string) (*Session, *orpc.Error) {
	var session Session
	err := s.database.Pool.QueryRow(ctx, `SELECT s.id, s.token, s."expiresAt", s."activeOrganizationId",
			u.id, u.email
		FROM session s JOIN "user" u ON u.id = s."userId"
		WHERE s.token = $1`, token).
		Scan(&session.ID, &session.Token, &session.ExpiresAt, &session.ActiveOrganizationID,
			&session.UserID, &session.Email)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, orpc.Unauthorized()
	}
	if err != nil {
		if db.IsUnavailable(err) {
			return nil, orpc.Unavailable()
		}
		return nil, orpc.Internal()
	}
	return &session, nil
}

// authorized applies the live lookup filter from packages/auth/src/index.ts:
// no internal messaging accounts, no deactivated accounts, and unverified
// accounts only while the signup allowlist is empty (or OIDC provisioning
// admits them).
func (s *Service) authorized(ctx context.Context, session *Session) *orpc.Error {
	if time.Now().After(session.ExpiresAt) {
		// better-auth deletes the row on a POST read; a failure here is harmless.
		if _, err := s.database.Pool.Exec(ctx, `DELETE FROM session WHERE token = $1`, session.Token); err == nil && s.config.AfterDeleteSession != nil {
			// The session change already happened, so a cleanup failure must not
			// fail the request (afterDeleteSession's .catch in app.ts:617-619).
			s.config.AfterDeleteSession(ctx, session.UserID, session.ID)
		}
		return orpc.Unauthorized()
	}
	if strings.HasSuffix(strings.ToLower(strings.TrimSpace(session.Email)), messagingSuffix) {
		return orpc.Unauthorized()
	}
	var verified bool
	var deactivated *time.Time
	err := s.database.Pool.QueryRow(ctx, `SELECT "emailVerified", "deactivatedAt" FROM "user" WHERE id = $1`, session.UserID).
		Scan(&verified, &deactivated)
	if errors.Is(err, pgx.ErrNoRows) {
		return orpc.Unauthorized()
	}
	if err != nil {
		if db.IsUnavailable(err) {
			return orpc.Unavailable()
		}
		return orpc.Internal()
	}
	if deactivated != nil {
		return orpc.Unauthorized()
	}
	if verified {
		return nil
	}
	if s.config.OIDCBypass {
		var exists bool
		if err := s.database.Pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM account WHERE "userId" = $1 AND "providerId" = 'oidc')`, session.UserID).Scan(&exists); err != nil {
			if db.IsUnavailable(err) {
				return orpc.Unavailable()
			}
			return orpc.Internal()
		}
		if exists {
			return nil
		}
	}
	if len(s.config.SignupAllowlist) == 0 {
		return nil
	}
	return orpc.Unauthorized()
}

func (s *Service) renew(ctx context.Context, session *Session) (*http.Cookie, error) {
	expires := time.Now().Add(sessionLifetime)
	if _, err := s.database.Pool.Exec(ctx, `UPDATE session SET "expiresAt" = $2, "updatedAt" = now() WHERE token = $1`, append([]any{session.Token}, db.Data(expires)...)...); err != nil {
		return nil, err
	}
	session.ExpiresAt = expires
	value := url.QueryEscape(session.Token + "." + s.signature(session.Token))
	return &http.Cookie{
		Name:     session.CookieName,
		Value:    value,
		Path:     "/",
		Domain:   s.config.CookieDomain,
		MaxAge:   int(sessionLifetime.Seconds()),
		HttpOnly: true,
		Secure:   strings.HasPrefix(session.CookieName, "__Secure-"),
		SameSite: http.SameSiteLaxMode,
	}, nil
}

// Actor resolves the Space the request acts in, mirroring requireMembership:
// the named Space header, else the session's pinned organization, else the
// organization of the latest finished run, else the first membership.
func (s *Service) Actor(ctx context.Context, session *Session, requestedSpace string) (db.Actor, *orpc.Error) {
	actor := db.Actor{UserID: session.UserID, SpaceID: "", Email: session.Email, SessionID: session.ID}
	spaceID := ""
	var failure *orpc.Error
	if requestedSpace != "" {
		err := s.database.Pool.QueryRow(ctx, `SELECT "spaceId" FROM space_members WHERE "userId" = $1 AND "spaceId" = $2 LIMIT 1`,
			session.UserID, requestedSpace).Scan(&spaceID)
		if errors.Is(err, pgx.ErrNoRows) {
			return db.Actor{}, orpc.Unauthorized()
		}
		if err != nil {
			return s.actorFailure(err)
		}
		actor.SpaceID = spaceID
		return actor, nil
	}

	var opened string
	err := s.database.System(ctx, "pick the organization a session opens", func(tx pgx.Tx) error {
		pinned := ""
		if session.ActiveOrganizationID != nil {
			pinned = *session.ActiveOrganizationID
		}
		if pinned != "" {
			if id, err := firstMembership(ctx, tx, session.UserID, pinned); err != nil {
				return err
			} else if id != "" {
				opened = id
				return nil
			}
		}
		chosen, err := recentOrganizationID(ctx, tx, session.UserID)
		if err != nil {
			return err
		}
		if session.ID == "" || chosen == "" {
			id, err := firstMembership(ctx, tx, session.UserID, chosen)
			opened = id
			return err
		}
		tag, err := tx.Exec(ctx, `UPDATE session SET "activeOrganizationId" = $2
			WHERE id = $1 AND "userId" = $3 AND "activeOrganizationId" IS NOT DISTINCT FROM NULLIF($4, '')`,
			append(append([]any{session.ID}, db.Data(chosen)...), session.UserID, pinned)...)
		if err != nil {
			return err
		}
		if tag.RowsAffected() > 0 {
			id, err := firstMembership(ctx, tx, session.UserID, chosen)
			opened = id
			return err
		}
		var winner *string
		if err := tx.QueryRow(ctx, `SELECT "activeOrganizationId" FROM session WHERE id = $1`, session.ID).Scan(&winner); err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		if winner != nil && *winner != "" && opensInOrganization(ctx, tx, session.UserID, *winner) {
			id, err := firstMembership(ctx, tx, session.UserID, *winner)
			opened = id
			return err
		}
		id, err := firstMembership(ctx, tx, session.UserID, chosen)
		opened = id
		return err
	})
	if err != nil {
		_, failure = s.actorFailure(err)
		return db.Actor{}, failure
	}
	if opened == "" {
		return db.Actor{}, orpc.Unauthorized()
	}
	actor.SpaceID = opened
	return actor, nil
}

func (s *Service) actorFailure(err error) (db.Actor, *orpc.Error) {
	if db.IsUnavailable(err) {
		return db.Actor{}, orpc.Unavailable()
	}
	return db.Actor{}, orpc.Internal()
}

func firstMembership(ctx context.Context, tx pgx.Tx, userID, organizationID string) (string, error) {
	query := `SELECT sm."spaceId"
		FROM space_members sm JOIN spaces sp ON sp.id = sm."spaceId"
		WHERE sm."userId" = $1 AND sp."deletingAt" IS NULL`
	args := []any{userID}
	if organizationID != "" {
		query += ` AND sm."organizationId" = $2`
		args = append(args, organizationID)
	}
	query += ` ORDER BY sp."isDefault" DESC, sm."createdAt" ASC, sm."id" ASC LIMIT 1`
	var spaceID string
	err := tx.QueryRow(ctx, query, args...).Scan(&spaceID)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", nil
	}
	return spaceID, err
}

func opensInOrganization(ctx context.Context, tx pgx.Tx, userID, organizationID string) bool {
	var exists bool
	err := tx.QueryRow(ctx, `SELECT EXISTS (
		SELECT 1 FROM space_members sm JOIN spaces sp ON sp.id = sm."spaceId"
		WHERE sm."userId" = $1 AND sm."organizationId" = $2 AND sp."deletingAt" IS NULL)`,
		userID, organizationID).Scan(&exists)
	return err == nil && exists
}

func recentOrganizationID(ctx context.Context, tx pgx.Tx, userID string) (string, error) {
	var spaceID string
	err := tx.QueryRow(ctx, `SELECT member."spaceId"
		FROM "space_members" AS member
		JOIN "spaces" AS space ON space."id" = member."spaceId" AND space."deletingAt" IS NULL
		CROSS JOIN LATERAL (
			SELECT run."completedAt"
			FROM "runs" AS run
			WHERE run."spaceId" = member."spaceId"
				AND run."userId" = member."userId"
				AND run."status" IN ('completed', 'failed', 'cancelled')
				AND run."trigger" NOT IN ('tickets', 'helper', 'helper_result')
				AND run."completedAt" IS NOT NULL
			ORDER BY run."completedAt" DESC
			LIMIT 1
		) AS latest
		WHERE member."userId" = $1
		ORDER BY latest."completedAt" DESC
		LIMIT 1`, userID).Scan(&spaceID)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return "", err
	}
	if spaceID != "" {
		var organizationID *string
		if err := tx.QueryRow(ctx, `SELECT "organizationId" FROM spaces WHERE id = $1`, spaceID).Scan(&organizationID); err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return "", err
		}
		if organizationID != nil {
			return *organizationID, nil
		}
	}
	var first *string
	err = tx.QueryRow(ctx, `SELECT sm."organizationId"
		FROM space_members sm JOIN spaces sp ON sp.id = sm."spaceId"
		WHERE sm."userId" = $1 AND sp."deletingAt" IS NULL
		ORDER BY sp."isDefault" DESC, sm."createdAt" ASC, sm."id" ASC LIMIT 1`, userID).Scan(&first)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	if first == nil {
		return "", nil
	}
	return *first, nil
}

// credentials returns the raw signed value and which cookie carried it, or the
// bearer value. Only signed values are accepted.
func credentials(r *http.Request, names []string) (token, cookieName string, viaCookie, signed bool) {
	for _, cookie := range r.Cookies() {
		for _, name := range names {
			if cookie.Name != name {
				continue
			}
			value, err := url.PathUnescape(cookie.Value)
			if err != nil {
				value = cookie.Value
			}
			return value, cookie.Name, true, true
		}
	}
	header := r.Header.Get("Authorization")
	if len(header) > 7 && strings.EqualFold(header[:7], "Bearer ") {
		value := strings.TrimSpace(header[7:])
		if strings.Contains(value, ".") {
			return value, "", false, true
		}
	}
	return "", "", false, false
}

func (s *Service) verify(signed string) (string, bool) {
	dot := strings.LastIndexByte(signed, '.')
	if dot < 1 {
		return "", false
	}
	raw, signature := signed[:dot], signed[dot+1:]
	if len(signature) != 44 || !strings.HasSuffix(signature, "=") {
		return "", false
	}
	decoded, err := base64.StdEncoding.DecodeString(signature)
	if err != nil || len(decoded) != sha256.Size {
		return "", false
	}
	expected := s.mac(raw)
	return raw, hmac.Equal(expected, decoded)
}

func (s *Service) signature(raw string) string {
	return base64.StdEncoding.EncodeToString(s.mac(raw))
}

func (s *Service) mac(raw string) []byte {
	mac := hmac.New(sha256.New, s.config.Secret)
	mac.Write([]byte(raw))
	return mac.Sum(nil)
}
