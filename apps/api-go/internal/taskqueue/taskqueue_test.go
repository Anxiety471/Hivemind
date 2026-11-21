package taskqueue

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestRetryDelayBackoff(t *testing.T) {
	if RetryDelay(1) != 5*time.Second {
		t.Fatalf("attempt 1 = %v", RetryDelay(1))
	}
	if RetryDelay(2) != 15*time.Second {
		t.Fatalf("attempt 2 = %v", RetryDelay(2))
	}
	if RetryDelay(5) != 5*time.Minute {
		t.Fatalf("attempt 5 = %v", RetryDelay(5))
	}
	if RetryDelay(99) != 5*time.Minute {
		t.Fatalf("attempt 99 = %v", RetryDelay(99))
	}
}

func TestServiceRetriesWithBackoffAndDeadLetters(t *testing.T) {
	now := time.Date(2026, 11, 21, 10, 0, 0, 0, time.UTC)
	store := NewMemoryStore(func() time.Time { return now })
	attempts := 0
	svc := New(Config{
		Store:       store,
		MaxAttempts: 3,
		Now:         func() time.Time { return now },
		WakeFunc: func(_ context.Context, _ Job) (WakeResult, error) {
			attempts++
			return WakeResult{}, errors.New("transient database failure")
		},
	})

	ctx := context.Background()
	resp, err := svc.EnqueueAssign(ctx, DispatchRequest{SpaceID: "s1", TicketID: "t1", BotID: "b1"})
	if err != nil || !resp.Queued {
		t.Fatalf("enqueue = %+v err = %v", resp, err)
	}

	// Duplicate enqueue within inflight window is coalesced.
	dup, err := svc.EnqueueAssign(ctx, DispatchRequest{SpaceID: "s1", TicketID: "t1", BotID: "b1"})
	if err != nil || dup.Queued || dup.Reason != "coalesced" {
		t.Fatalf("expected coalesced duplicate, got %+v err=%v", dup, err)
	}

	// Attempt 1 fails -> rescheduled for +5s.
	if got := svc.ProcessDue(ctx, 10); got != 1 || attempts != 1 {
		t.Fatalf("attempt 1: processed=%d attempts=%d", got, attempts)
	}
	// Not due yet at +4s.
	now = now.Add(4 * time.Second)
	if got := svc.ProcessDue(ctx, 10); got != 0 {
		t.Fatalf("expected 0 due at +4s, got %d", got)
	}

	// Attempt 2 fails at +5s -> rescheduled for +15s.
	now = now.Add(2 * time.Second)
	if got := svc.ProcessDue(ctx, 10); got != 1 || attempts != 2 {
		t.Fatalf("attempt 2: processed=%d attempts=%d", got, attempts)
	}

	// Attempt 3 fails at +15s -> moves to dead-letter list.
	now = now.Add(16 * time.Second)
	if got := svc.ProcessDue(ctx, 10); got != 1 || attempts != 3 {
		t.Fatalf("attempt 3: processed=%d attempts=%d", got, attempts)
	}

	stats, _ := store.Stats(ctx)
	if stats.Pending != 0 || stats.Dead != 1 {
		t.Fatalf("expected pending=0 dead=1, got %+v", stats)
	}
	dead := store.DeadJobs()
	if len(dead) != 1 || dead[0].Attempt != 3 || dead[0].LastError == "" {
		t.Fatalf("unexpected dead job: %+v", dead)
	}
}

func TestServiceBumpCooldownAndForce(t *testing.T) {
	now := time.Date(2026, 11, 21, 10, 0, 0, 0, time.UTC)
	store := NewMemoryStore(func() time.Time { return now })
	var dispatched []Job
	svc := New(Config{
		Store:        store,
		BumpCooldown: 10 * time.Minute,
		Now:          func() time.Time { return now },
		WakeFunc: func(_ context.Context, job Job) (WakeResult, error) {
			dispatched = append(dispatched, job)
			return WakeResult{RunID: "run-1"}, nil
		},
	})

	ctx := context.Background()
	first, err := svc.EnqueueBump(ctx, BumpRequest{SpaceID: "s1", TicketID: "t1", BotID: "b1"})
	if err != nil || !first.Queued {
		t.Fatalf("first bump failed: %+v %v", first, err)
	}
	second, err := svc.EnqueueBump(ctx, BumpRequest{SpaceID: "s1", TicketID: "t1", BotID: "b1"})
	if err != nil || second.Queued || second.Reason != "cooldown" {
		t.Fatalf("expected cooldown refusal, got %+v %v", second, err)
	}
	forced, err := svc.EnqueueBump(ctx, BumpRequest{SpaceID: "s1", TicketID: "t1", BotID: "b1", Force: true})
	if err != nil || !forced.Queued {
		t.Fatalf("expected forced bump to bypass cooldown, got %+v %v", forced, err)
	}
	if processed := svc.ProcessDue(ctx, 10); processed != 2 || len(dispatched) != 2 {
		t.Fatalf("processed=%d dispatched=%d", processed, len(dispatched))
	}
	if dispatched[0].Kind != KindBump || dispatched[1].Kind != KindBump {
		t.Fatalf("expected KindBump jobs, got %+v", dispatched)
	}
}

func TestRedisStoreRoundTripAgainstRESPServer(t *testing.T) {
	addr, stop := startFakeRedis(t, "secret-pw")
	defer stop()

	ctx := context.Background()
	store, err := OpenRedis(ctx, fmt.Sprintf("redis://:secret-pw@%s/2", addr), "test:tq")
	if err != nil {
		t.Fatalf("OpenRedis: %v", err)
	}
	defer func() { _ = store.Close() }()

	if store.Driver() != "redis" {
		t.Fatalf("driver = %q, want redis", store.Driver())
	}

	ok, err := store.AcquireLock(ctx, "bump:t1:b1", 60*time.Second)
	if err != nil || !ok {
		t.Fatalf("first lock = %v err = %v", ok, err)
	}
	ok2, err := store.AcquireLock(ctx, "bump:t1:b1", 60*time.Second)
	if err != nil || ok2 {
		t.Fatalf("second lock = %v err = %v, want false", ok2, err)
	}

	base := time.Date(2026, 11, 21, 12, 0, 0, 0, time.UTC)
	if err := store.Enqueue(ctx, Job{ID: "j1", Kind: KindAssign, SpaceID: "s1", TicketID: "t1", BotID: "b1"}, base); err != nil {
		t.Fatalf("Enqueue j1: %v", err)
	}
	if err := store.Enqueue(ctx, Job{ID: "j2", Kind: KindBump, SpaceID: "s1", TicketID: "t2", BotID: "b2"}, base.Add(30*time.Second)); err != nil {
		t.Fatalf("Enqueue j2: %v", err)
	}

	due, err := store.PopDue(ctx, base.Add(5*time.Second), 10)
	if err != nil || len(due) != 1 || due[0].ID != "j1" {
		t.Fatalf("PopDue = %+v err = %v", due, err)
	}

	if err := store.PushDead(ctx, due[0]); err != nil {
		t.Fatalf("PushDead: %v", err)
	}
	stats, err := store.Stats(ctx)
	if err != nil || stats.Pending != 1 || stats.Dead != 1 {
		t.Fatalf("Stats = %+v err = %v, want pending=1 dead=1", stats, err)
	}
}

// startFakeRedis runs a minimal RESP2 server in-process so RedisStore's wire
// protocol, auth, select, ZADD, EVAL pop, SET NX EX, LPUSH/LTRIM, and ZCARD/LLEN
// are tested deterministically without an external Redis daemon.
func startFakeRedis(t *testing.T, wantPassword string) (string, func()) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	var (
		mu    sync.Mutex
		zset  = make(map[string]map[string]int64)
		lists = make(map[string][]string)
		locks = make(map[string]bool)
	)
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			go func(c net.Conn) {
				defer func() { _ = c.Close() }()
				rd := bufio.NewReader(c)
				authed := wantPassword == ""
				for {
					cmd, err := readFakeCommand(rd)
					if err != nil {
						return
					}
					if len(cmd) == 0 {
						continue
					}
					op := strings.ToUpper(cmd[0])
					if op == "AUTH" {
						if len(cmd) >= 2 && cmd[len(cmd)-1] == wantPassword {
							authed = true
							_, _ = c.Write([]byte("+OK\r\n"))
						} else {
							_, _ = c.Write([]byte("-ERR invalid password\r\n"))
						}
						continue
					}
					if !authed {
						_, _ = c.Write([]byte("-NOAUTH Authentication required\r\n"))
						continue
					}
					mu.Lock()
					switch op {
					case "PING":
						_, _ = c.Write([]byte("+PONG\r\n"))
					case "SELECT":
						_, _ = c.Write([]byte("+OK\r\n"))
					case "SET":
						key := cmd[1]
						if locks[key] {
							_, _ = c.Write([]byte("$-1\r\n"))
						} else {
							locks[key] = true
							_, _ = c.Write([]byte("+OK\r\n"))
						}
					case "ZADD":
						key := cmd[1]
						score, _ := strconv.ParseInt(cmd[2], 10, 64)
						member := cmd[3]
						if zset[key] == nil {
							zset[key] = make(map[string]int64)
						}
						zset[key][member] = score
						_, _ = c.Write([]byte(":1\r\n"))
					case "EVAL":
						key := cmd[3]
						cutoff, _ := strconv.ParseInt(cmd[4], 10, 64)
						limit, _ := strconv.Atoi(cmd[5])
						var popped []string
						for member, score := range zset[key] {
							if score <= cutoff && len(popped) < limit {
								popped = append(popped, member)
							}
						}
						for _, m := range popped {
							delete(zset[key], m)
						}
						var out strings.Builder
						out.WriteString(fmt.Sprintf("*%d\r\n", len(popped)))
						for _, m := range popped {
							out.WriteString(fmt.Sprintf("$%d\r\n%s\r\n", len(m), m))
						}
						_, _ = c.Write([]byte(out.String()))
					case "LPUSH":
						key := cmd[1]
						lists[key] = append([]string{cmd[2]}, lists[key]...)
						_, _ = c.Write([]byte(fmt.Sprintf(":%d\r\n", len(lists[key]))))
					case "LTRIM":
						key := cmd[1]
						end, _ := strconv.Atoi(cmd[3])
						if end+1 < len(lists[key]) {
							lists[key] = lists[key][:end+1]
						}
						_, _ = c.Write([]byte("+OK\r\n"))
					case "ZCARD":
						_, _ = c.Write([]byte(fmt.Sprintf(":%d\r\n", len(zset[cmd[1]]))))
					case "LLEN":
						_, _ = c.Write([]byte(fmt.Sprintf(":%d\r\n", len(lists[cmd[1]]))))
					default:
						_, _ = c.Write([]byte("-ERR unsupported command\r\n"))
					}
					mu.Unlock()
				}
			}(conn)
		}
	}()
	return ln.Addr().String(), func() { _ = ln.Close() }
}

func readFakeCommand(rd *bufio.Reader) ([]string, error) {
	line, err := rd.ReadString('\n')
	if err != nil {
		return nil, err
	}
	line = strings.TrimSuffix(line, "\r\n")
	if len(line) == 0 || line[0] != '*' {
		return nil, io.EOF
	}
	n, err := strconv.Atoi(line[1:])
	if err != nil {
		return nil, err
	}
	out := make([]string, 0, n)
	for range n {
		hdr, err := rd.ReadString('\n')
		if err != nil {
			return nil, err
		}
		hdr = strings.TrimSuffix(hdr, "\r\n")
		length, err := strconv.Atoi(hdr[1:])
		if err != nil {
			return nil, err
		}
		buf := make([]byte, length+2)
		if _, err := io.ReadFull(rd, buf); err != nil {
			return nil, err
		}
		out = append(out, string(buf[:length]))
	}
	return out, nil
}
