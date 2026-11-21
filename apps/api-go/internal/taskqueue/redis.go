package taskqueue

import (
	"bufio"
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

const popDueLua = `
local items = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1], 'LIMIT', 0, tonumber(ARGV[2]))
if #items > 0 then
  redis.call('ZREM', KEYS[1], unpack(items))
end
return items
`

// RedisStore is a minimal, zero-dependency RESP2 Redis client backing the
// task dispatch queue, retry schedule, atomic cooldown locks, and dead-letter list.
type RedisStore struct {
	addr     string
	username string
	password string
	dbIndex  int
	useTLS   bool
	prefix   string

	mu   sync.Mutex
	conn net.Conn
	rw   *bufio.ReadWriter
}

// OpenRedis parses a redis:// or rediss:// URL and verifies connectivity with PING.
func OpenRedis(ctx context.Context, rawURL, keyPrefix string) (*RedisStore, error) {
	parsed, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil {
		return nil, fmt.Errorf("parse REDIS_URL: %w", err)
	}
	if parsed.Scheme != "redis" && parsed.Scheme != "rediss" {
		return nil, fmt.Errorf("unsupported REDIS_URL scheme %q", parsed.Scheme)
	}
	host := parsed.Hostname()
	if host == "" {
		return nil, errors.New("REDIS_URL missing host")
	}
	port := parsed.Port()
	if port == "" {
		port = "6379"
	}
	dbIndex := 0
	if path := strings.TrimPrefix(parsed.Path, "/"); path != "" {
		n, err := strconv.Atoi(path)
		if err != nil || n < 0 {
			return nil, fmt.Errorf("invalid REDIS_URL database %q", path)
		}
		dbIndex = n
	}
	var username, password string
	if parsed.User != nil {
		username = parsed.User.Username()
		password, _ = parsed.User.Password()
	}
	if keyPrefix == "" {
		keyPrefix = DefaultKeyPrefix
	}
	store := &RedisStore{
		addr:     net.JoinHostPort(host, port),
		username: username,
		password: password,
		dbIndex:  dbIndex,
		useTLS:   parsed.Scheme == "rediss",
		prefix:   strings.TrimRight(keyPrefix, ":"),
	}
	if err := store.Ping(ctx); err != nil {
		_ = store.Close()
		return nil, err
	}
	return store, nil
}

func (r *RedisStore) Driver() string { return "redis" }

func (r *RedisStore) delayedKey() string { return r.prefix + ":delayed" }
func (r *RedisStore) deadKey() string    { return r.prefix + ":dead" }
func (r *RedisStore) lockKey(k string) string {
	return r.prefix + ":lock:" + k
}

func (r *RedisStore) Ping(ctx context.Context) error {
	resp, err := r.do(ctx, "PING")
	if err != nil {
		return err
	}
	if s, ok := resp.(string); ok && strings.EqualFold(s, "PONG") {
		return nil
	}
	return fmt.Errorf("unexpected PING response: %v", resp)
}

func (r *RedisStore) Enqueue(ctx context.Context, job Job, dueAt time.Time) error {
	payload, err := json.Marshal(job)
	if err != nil {
		return err
	}
	score := strconv.FormatInt(dueAt.UTC().UnixMilli(), 10)
	_, err = r.do(ctx, "ZADD", r.delayedKey(), score, string(payload))
	return err
}

func (r *RedisStore) PopDue(ctx context.Context, now time.Time, limit int) ([]Job, error) {
	if limit <= 0 {
		limit = 10
	}
	resp, err := r.do(
		ctx,
		"EVAL",
		popDueLua,
		"1",
		r.delayedKey(),
		strconv.FormatInt(now.UTC().UnixMilli(), 10),
		strconv.Itoa(limit),
	)
	if err != nil {
		return nil, err
	}
	items, ok := resp.([]any)
	if !ok || len(items) == 0 {
		return nil, nil
	}
	out := make([]Job, 0, len(items))
	for _, raw := range items {
		text, ok := raw.(string)
		if !ok || text == "" {
			continue
		}
		var job Job
		if err := json.Unmarshal([]byte(text), &job); err != nil {
			continue
		}
		out = append(out, job)
	}
	return out, nil
}

func (r *RedisStore) PushDead(ctx context.Context, job Job) error {
	payload, err := json.Marshal(job)
	if err != nil {
		return err
	}
	if _, err := r.do(ctx, "LPUSH", r.deadKey(), string(payload)); err != nil {
		return err
	}
	_, err = r.do(ctx, "LTRIM", r.deadKey(), "0", strconv.Itoa(DefaultDeadLetterLimit-1))
	return err
}

func (r *RedisStore) AcquireLock(ctx context.Context, key string, ttl time.Duration) (bool, error) {
	seconds := max(int64(ttl/time.Second), 1)
	resp, err := r.do(ctx, "SET", r.lockKey(key), "1", "NX", "EX", strconv.FormatInt(seconds, 10))
	if err != nil {
		return false, err
	}
	s, ok := resp.(string)
	return ok && strings.EqualFold(s, "OK"), nil
}

func (r *RedisStore) Stats(ctx context.Context) (QueueStats, error) {
	pendingRaw, err := r.do(ctx, "ZCARD", r.delayedKey())
	if err != nil {
		return QueueStats{}, err
	}
	deadRaw, err := r.do(ctx, "LLEN", r.deadKey())
	if err != nil {
		return QueueStats{}, err
	}
	pending, _ := pendingRaw.(int64)
	dead, _ := deadRaw.(int64)
	return QueueStats{Pending: pending, Dead: dead}, nil
}

func (r *RedisStore) Close() error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.conn != nil {
		err := r.conn.Close()
		r.conn = nil
		r.rw = nil
		return err
	}
	return nil
}

// do sends one Redis command, reconnecting once if a pooled socket went stale.
func (r *RedisStore) do(ctx context.Context, args ...string) (any, error) {
	r.mu.Lock()
	defer r.mu.Unlock()

	for attempt := 0; attempt < 2; attempt++ {
		if r.conn == nil {
			if err := r.dialLocked(ctx); err != nil {
				return nil, err
			}
		}
		if deadline, ok := ctx.Deadline(); ok {
			_ = r.conn.SetDeadline(deadline)
		} else {
			_ = r.conn.SetDeadline(time.Now().Add(5 * time.Second))
		}
		resp, err := r.execLocked(args...)
		if err == nil {
			return resp, nil
		}
		var redisErr *respError
		if errors.As(err, &redisErr) {
			return nil, err
		}
		// Transport error: close and retry once on a fresh connection.
		_ = r.conn.Close()
		r.conn = nil
		r.rw = nil
		if attempt == 1 {
			return nil, err
		}
	}
	return nil, errors.New("redis command failed")
}

func (r *RedisStore) dialLocked(ctx context.Context) error {
	dialer := &net.Dialer{Timeout: 5 * time.Second, KeepAlive: 30 * time.Second}
	var (
		conn net.Conn
		err  error
	)
	if r.useTLS {
		host, _, _ := net.SplitHostPort(r.addr)
		conn, err = (&tls.Dialer{
			NetDialer: dialer,
			Config:    &tls.Config{ServerName: host, MinVersion: tls.VersionTLS12},
		}).DialContext(ctx, "tcp", r.addr)
	} else {
		conn, err = dialer.DialContext(ctx, "tcp", r.addr)
	}
	if err != nil {
		return fmt.Errorf("dial redis %s: %w", r.addr, err)
	}
	r.conn = conn
	r.rw = bufio.NewReadWriter(bufio.NewReader(conn), bufio.NewWriter(conn))
	if deadline, ok := ctx.Deadline(); ok {
		_ = r.conn.SetDeadline(deadline)
	} else {
		_ = r.conn.SetDeadline(time.Now().Add(5 * time.Second))
	}
	if r.password != "" {
		var authErr error
		if r.username != "" {
			_, authErr = r.execLocked("AUTH", r.username, r.password)
		} else {
			_, authErr = r.execLocked("AUTH", r.password)
		}
		if authErr != nil {
			_ = r.conn.Close()
			r.conn = nil
			r.rw = nil
			return fmt.Errorf("redis auth: %w", authErr)
		}
	}
	if r.dbIndex > 0 {
		if _, err := r.execLocked("SELECT", strconv.Itoa(r.dbIndex)); err != nil {
			_ = r.conn.Close()
			r.conn = nil
			r.rw = nil
			return fmt.Errorf("redis select %d: %w", r.dbIndex, err)
		}
	}
	return nil
}

func (r *RedisStore) execLocked(args ...string) (any, error) {
	var b strings.Builder
	b.WriteByte('*')
	b.WriteString(strconv.Itoa(len(args)))
	b.WriteString("\r\n")
	for _, arg := range args {
		b.WriteByte('$')
		b.WriteString(strconv.Itoa(len(arg)))
		b.WriteString("\r\n")
		b.WriteString(arg)
		b.WriteString("\r\n")
	}
	if _, err := r.rw.WriteString(b.String()); err != nil {
		return nil, err
	}
	if err := r.rw.Flush(); err != nil {
		return nil, err
	}
	return readRESP(r.rw.Reader)
}

type respError struct {
	msg string
}

func (e *respError) Error() string { return "redis: " + e.msg }

func readRESP(rd *bufio.Reader) (any, error) {
	line, err := rd.ReadString('\n')
	if err != nil {
		return nil, err
	}
	line = strings.TrimSuffix(line, "\r\n")
	if len(line) == 0 {
		return nil, errors.New("empty RESP reply")
	}
	switch line[0] {
	case '+':
		return line[1:], nil
	case '-':
		return nil, &respError{msg: line[1:]}
	case ':':
		return strconv.ParseInt(line[1:], 10, 64)
	case '$':
		length, err := strconv.Atoi(line[1:])
		if err != nil {
			return nil, err
		}
		if length < 0 {
			return nil, nil
		}
		buf := make([]byte, length+2)
		if _, err := io.ReadFull(rd, buf); err != nil {
			return nil, err
		}
		return string(buf[:length]), nil
	case '*':
		count, err := strconv.Atoi(line[1:])
		if err != nil {
			return nil, err
		}
		if count < 0 {
			return nil, nil
		}
		items := make([]any, count)
		for i := range count {
			item, err := readRESP(rd)
			if err != nil {
				return nil, err
			}
			items[i] = item
		}
		return items, nil
	default:
		return nil, fmt.Errorf("unexpected RESP prefix %q", line[0])
	}
}
