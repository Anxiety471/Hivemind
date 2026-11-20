// Package db owns the Postgres connection and the row-level-security settings
// every transaction carries.
package db

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"net/url"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Actor is the signed-in user acting in one Space.
type Actor struct {
	UserID  string
	SpaceID string
	Email   string
	// Deprecated wire field; app accounts have no deployment role.
	IsDeploymentOwner bool
}

// DB is the runtime pool. The login is the constrained runtime role, so the
// policies apply unless an explicit system context proves the bypass.
type DB struct {
	Pool      *pgxpool.Pool
	bypassKey string
	// connectionString lets a sibling pool (content-key loads) reuse the same
	// login without callers re-reading the environment.
	connectionString string
}

// Open connects with UTC and the API's application name.
func Open(ctx context.Context, connectionString, applicationName string) (*DB, error) {
	config, err := pgxpool.ParseConfig(connectionString)
	if err != nil {
		return nil, fmt.Errorf("parse DATABASE_URL: %w", err)
	}
	config.MaxConns = 4
	config.MinConns = 0
	config.MaxConnLifetime = 30 * time.Minute
	config.MaxConnIdleTime = 0
	config.ConnConfig.RuntimeParams["timezone"] = "UTC"
	config.ConnConfig.RuntimeParams["application_name"] = applicationName
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		return nil, fmt.Errorf("open database: %w", err)
	}
	database := &DB{Pool: pool, bypassKey: bypassKey(connectionString), connectionString: connectionString}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("ping database: %w", err)
	}
	return database, nil
}

// Close releases the pool.
func (d *DB) Close() { d.Pool.Close() }

// NewPool opens a second, independently sized pool with the same login and
// bypass key. The content key ring uses one so a key lookup never waits on the
// caller's pool: TypeScript gives keys their own two-connection pool for the
// same reason (packages/db/src/client.ts:98-106).
func (d *DB) NewPool(ctx context.Context, maxConns int32, applicationName string) (*DB, error) {
	config, err := pgxpool.ParseConfig(d.connectionString)
	if err != nil {
		return nil, fmt.Errorf("parse DATABASE_URL: %w", err)
	}
	config.MaxConns = maxConns
	config.MinConns = 0
	config.MaxConnLifetime = 30 * time.Minute
	config.MaxConnIdleTime = 0
	config.ConnConfig.RuntimeParams["timezone"] = "UTC"
	config.ConnConfig.RuntimeParams["application_name"] = applicationName
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		return nil, fmt.Errorf("open %s database pool: %w", applicationName, err)
	}
	sibling := &DB{Pool: pool, bypassKey: d.bypassKey, connectionString: d.connectionString}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("ping %s database pool: %w", applicationName, err)
	}
	return sibling, nil
}

// Tenant runs fn in a transaction whose connection is scoped to the actor's
// Space and user. The settings are transaction-local, so a pooled connection
// never carries them into the next request.
func (d *DB) Tenant(ctx context.Context, actor Actor, fn func(pgx.Tx) error) error {
	return d.inTx(ctx, []string{actor.SpaceID, actor.UserID, "off", ""}, fn)
}

// TenantSerializable is Tenant at the SERIALIZABLE isolation level; the caller
// reruns it on a serialization failure.
func (d *DB) TenantSerializable(ctx context.Context, actor Actor, fn func(pgx.Tx) error) error {
	return d.inTxWith(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable}, []string{actor.SpaceID, actor.UserID, "off", ""}, fn)
}

// System runs fn across tenants, with the named reason kept for logs. The
// bypass needs both the setting and the key derived from the login password.
func (d *DB) System(ctx context.Context, reason string, fn func(pgx.Tx) error) error {
	_ = reason
	return d.inTx(ctx, []string{"", "", "on", d.bypassKey}, fn)
}

func (d *DB) inTx(ctx context.Context, settings []string, fn func(pgx.Tx) error) error {
	return d.inTxWith(ctx, pgx.TxOptions{}, settings, fn)
}

func (d *DB) inTxWith(ctx context.Context, options pgx.TxOptions, settings []string, fn func(pgx.Tx) error) error {
	tx, err := d.Pool.BeginTx(ctx, options)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()
	if err := setSettings(ctx, tx, settings); err != nil {
		return err
	}
	if err := fn(tx); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// InSystem runs fn inside an open transaction with the bypass turned on, then
// restores the tenant settings the caller opened it with.
func (d *DB) InSystem(ctx context.Context, tx pgx.Tx, fn func() error) error {
	var space, user, bypass, key string
	if err := tx.QueryRow(ctx, `SELECT coalesce(current_setting('app.space_id', true), ''),
		coalesce(current_setting('app.user_id', true), ''),
		coalesce(current_setting('app.rls_bypass', true), ''),
		coalesce(current_setting('app.rls_bypass_key', true), '')`).Scan(&space, &user, &bypass, &key); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `SELECT set_config('app.rls_bypass', 'on', true),
		set_config('app.rls_bypass_key', $1, true)`, d.bypassKey); err != nil {
		return err
	}
	restore := func() error {
		_, err := tx.Exec(ctx, `SELECT set_config('app.space_id', $1, true),
			set_config('app.user_id', $2, true),
			set_config('app.rls_bypass', $3, true),
			set_config('app.rls_bypass_key', $4, true),
			set_config('app.vault_access_version', '1', true)`, space, user, bypass, key)
		return err
	}
	if err := fn(); err != nil {
		_ = restore()
		return err
	}
	return restore()
}

func setSettings(ctx context.Context, tx pgx.Tx, settings []string) error {
	_, err := tx.Exec(ctx, `SELECT set_config('app.space_id', $1, true),
		set_config('app.user_id', $2, true),
		set_config('app.rls_bypass', $3, true),
		set_config('app.rls_bypass_key', $4, true),
		set_config('app.vault_access_version', '1', true)`,
		settings[0], settings[1], settings[2], settings[3])
	return err
}

// StartupCheck fails when the login bypasses policies or cannot prove the
// system bypass. A silent empty result set is worse than refusing to start.
func (d *DB) StartupCheck(ctx context.Context) error {
	var role string
	var super, bypassRLS, owns bool
	err := d.Pool.QueryRow(ctx, `SELECT current_user, r.rolsuper, r.rolbypassrls,
		pg_has_role(current_user, c.relowner, 'USAGE')
		FROM pg_roles r, pg_class c
		WHERE r.rolname = current_user AND c.oid = 'public.messages'::regclass`).
		Scan(&role, &super, &bypassRLS, &owns)
	if err != nil {
		return fmt.Errorf("row-level security check: %w", err)
	}
	if super || bypassRLS || owns {
		return fmt.Errorf("row-level security is not enforced for login %q (superuser=%t bypassrls=%t owns_tables=%t)",
			role, super, bypassRLS, owns)
	}
	var proved bool
	if err := d.System(ctx, "startup rls check", func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, "SELECT app_rls_bypass()").Scan(&proved)
	}); err != nil {
		return fmt.Errorf("row-level security bypass check: %w", err)
	}
	if !proved {
		return errors.New("row-level security bypass key is not registered for this login")
	}
	return nil
}

// BypassKey derives the key packages/db sends, from the login password in the
// connection string. Query parameters win over userinfo, as pg-connection-string.
func bypassKey(connectionString string) string {
	parsed, err := url.Parse(connectionString)
	if err != nil {
		return ""
	}
	password := parsed.Query().Get("password")
	if password == "" && parsed.User != nil {
		password, _ = parsed.User.Password()
	}
	if password == "" {
		return ""
	}
	mac := hmac.New(sha256.New, []byte(password))
	mac.Write([]byte("rakazo rls bypass"))
	return hex.EncodeToString(mac.Sum(nil))
}

// IsUnavailable reports whether err means Postgres is unreachable or refusing
// connections, which the API answers as 503 with Retry-After.
func IsUnavailable(err error) bool {
	if err == nil {
		return false
	}
	var pgErr interface{ SQLState() string }
	if errors.As(err, &pgErr) {
		switch pgErr.SQLState() {
		case "57P01", "57P02", "57P03", "53300", "08000", "08001", "08003", "08004", "08006":
			return true
		}
	}
	return errors.Is(err, context.DeadlineExceeded)
}
