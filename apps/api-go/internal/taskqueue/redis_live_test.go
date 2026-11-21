package taskqueue

import (
	"context"
	"fmt"
	"os"
	"sync"
	"testing"
	"time"
)

// openLiveRedis connects to the Redis the test run names, under a prefix of its own so runs
// never meet. It skips when none is configured, like the database tests.
func openLiveRedis(t *testing.T) *RedisStore {
	t.Helper()
	url := os.Getenv("RAKAZO_TEST_REDIS_URL")
	if url == "" {
		t.Skip("set RAKAZO_TEST_REDIS_URL to a disposable Redis to run the live queue tests")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	store, err := OpenRedis(ctx, url, fmt.Sprintf("rakazo:test:%d", time.Now().UnixNano()))
	if err != nil {
		t.Fatalf("open redis: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })
	return store
}

func TestLiveRedisHoldsJobsUntilDueAndHandsEachOutOnce(t *testing.T) {
	store := openLiveRedis(t)
	ctx := context.Background()
	base := time.Date(2026, 11, 21, 10, 0, 0, 0, time.UTC)
	for i, due := range []time.Duration{0, time.Second, time.Hour} {
		job := Job{ID: fmt.Sprintf("job-%d", i), Kind: KindAssign, SpaceID: "s", TicketID: "t", BotID: "b", Note: "line one\nline \"two\""}
		if err := store.Enqueue(ctx, job, base.Add(due)); err != nil {
			t.Fatalf("enqueue: %v", err)
		}
	}
	if stats, err := store.Stats(ctx); err != nil || stats.Pending != 3 || stats.Dead != 0 {
		t.Fatalf("stats = %+v, %v", stats, err)
	}
	// Nothing is due before the first job's time; later, the earlier two come out in order.
	if jobs, err := store.PopDue(ctx, base.Add(-time.Second), 10); err != nil || len(jobs) != 0 {
		t.Fatalf("early pop = %v, %v", jobs, err)
	}
	jobs, err := store.PopDue(ctx, base.Add(time.Minute), 10)
	if err != nil || len(jobs) != 2 || jobs[0].ID != "job-0" || jobs[1].ID != "job-1" || jobs[0].Note != "line one\nline \"two\"" {
		t.Fatalf("pop = %+v, %v", jobs, err)
	}
	if again, _ := store.PopDue(ctx, base.Add(time.Minute), 10); len(again) != 0 {
		t.Fatalf("a job came out twice: %+v", again)
	}
	if stats, _ := store.Stats(ctx); stats.Pending != 1 {
		t.Fatalf("pending after pop = %d", stats.Pending)
	}
}

func TestLiveRedisNeverHandsOneJobToTwoPoppers(t *testing.T) {
	store := openLiveRedis(t)
	ctx := context.Background()
	base := time.Date(2026, 11, 21, 10, 0, 0, 0, time.UTC)
	const total = 200
	for i := range total {
		if err := store.Enqueue(ctx, Job{ID: fmt.Sprintf("job-%03d", i), Kind: KindAssign}, base); err != nil {
			t.Fatal(err)
		}
	}
	var (
		mu   sync.Mutex
		seen = map[string]int{}
		wg   sync.WaitGroup
	)
	for range 4 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			// Each popper has its own connection, as separate gateway processes would.
			own := &RedisStore{addr: store.addr, prefix: store.prefix}
			defer own.Close()
			for {
				jobs, err := own.PopDue(ctx, base, 7)
				if err != nil {
					t.Errorf("pop: %v", err)
					return
				}
				if len(jobs) == 0 {
					return
				}
				mu.Lock()
				for _, job := range jobs {
					seen[job.ID]++
				}
				mu.Unlock()
			}
		}()
	}
	wg.Wait()
	if len(seen) != total {
		t.Fatalf("handed out %d of %d jobs", len(seen), total)
	}
	for id, count := range seen {
		if count != 1 {
			t.Fatalf("%s handed out %d times", id, count)
		}
	}
}

func TestLiveRedisLocksAndDeadLetters(t *testing.T) {
	store := openLiveRedis(t)
	ctx := context.Background()
	if ok, err := store.AcquireLock(ctx, "bot-1:ticket-1", time.Minute); err != nil || !ok {
		t.Fatalf("first lock = %v, %v", ok, err)
	}
	if ok, err := store.AcquireLock(ctx, "bot-1:ticket-1", time.Minute); err != nil || ok {
		t.Fatalf("a held lock was granted again: %v, %v", ok, err)
	}
	if ok, _ := store.AcquireLock(ctx, "bot-2:ticket-1", time.Minute); !ok {
		t.Fatal("locks are per key")
	}
	if ok, _ := store.AcquireLock(ctx, "short", time.Second); !ok {
		t.Fatal("short lock")
	}
	time.Sleep(1200 * time.Millisecond)
	if ok, _ := store.AcquireLock(ctx, "short", time.Second); !ok {
		t.Fatal("a lock must expire after its ttl")
	}

	for i := range DefaultDeadLetterLimit + 5 {
		if err := store.PushDead(ctx, Job{ID: fmt.Sprintf("dead-%d", i), Kind: KindBump}); err != nil {
			t.Fatal(err)
		}
	}
	if stats, _ := store.Stats(ctx); stats.Dead != DefaultDeadLetterLimit {
		t.Fatalf("dead letters = %d, want the cap %d", stats.Dead, DefaultDeadLetterLimit)
	}
}

func TestLiveRedisReconnectsAfterTheServerDropsTheConnection(t *testing.T) {
	store := openLiveRedis(t)
	ctx := context.Background()
	if err := store.Ping(ctx); err != nil {
		t.Fatal(err)
	}
	// A second client kills every normal connection, this store's included.
	killer := &RedisStore{addr: store.addr, prefix: store.prefix}
	defer killer.Close()
	if _, err := killer.do(ctx, "CLIENT", "KILL", "TYPE", "normal", "SKIPME", "yes"); err != nil {
		t.Fatalf("kill: %v", err)
	}
	if err := store.Ping(ctx); err != nil {
		t.Fatalf("the store did not reconnect: %v", err)
	}
	if err := store.Enqueue(ctx, Job{ID: "after", Kind: KindAssign}, time.Now()); err != nil {
		t.Fatal(err)
	}
}

func TestLiveRedisServesTheService(t *testing.T) {
	store := openLiveRedis(t)
	ctx := context.Background()
	now := time.Date(2026, 11, 21, 10, 0, 0, 0, time.UTC)
	var woken []string
	svc := New(Config{
		Store: store,
		Now:   func() time.Time { return now },
		WakeFunc: func(_ context.Context, job Job) (WakeResult, error) {
			woken = append(woken, job.BotID+"/"+job.TicketID)
			return WakeResult{RunID: "run-1"}, nil
		},
	})
	if _, err := svc.EnqueueAssign(ctx, DispatchRequest{SpaceID: "s", TicketID: "t-1", BotID: "bot-1"}); err != nil {
		t.Fatalf("enqueue: %v", err)
	}
	if health := svc.Health(ctx); health.Driver != "redis" || !health.Connected || health.Pending != 1 {
		t.Fatalf("health = %+v", health)
	}
	if n := svc.ProcessDue(ctx, 10); n != 1 || len(woken) != 1 || woken[0] != "bot-1/t-1" {
		t.Fatalf("processed %d, woken %v", n, woken)
	}
	if health := svc.Health(ctx); health.Pending != 0 || health.Dead != 0 {
		t.Fatalf("health after = %+v", health)
	}
}
