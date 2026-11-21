package taskqueue

import (
	"context"
	"sort"
	"sync"
	"time"
)

type scheduledJob struct {
	job   Job
	dueAt time.Time
}

// MemoryStore is an in-memory QueueStore used for offline tests and deployments
// that do not configure REDIS_URL.
type MemoryStore struct {
	mu    sync.Mutex
	items []scheduledJob
	dead  []Job
	locks map[string]time.Time
	now   func() time.Time
}

// NewMemoryStore creates an in-memory queue store.
func NewMemoryStore(nowFn func() time.Time) *MemoryStore {
	if nowFn == nil {
		nowFn = time.Now
	}
	return &MemoryStore{
		locks: make(map[string]time.Time),
		now:   nowFn,
	}
}

func (m *MemoryStore) Driver() string { return "memory" }

func (m *MemoryStore) Ping(_ context.Context) error { return nil }

func (m *MemoryStore) Enqueue(_ context.Context, job Job, dueAt time.Time) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.items = append(m.items, scheduledJob{job: job, dueAt: dueAt.UTC()})
	sort.SliceStable(m.items, func(i, j int) bool {
		return m.items[i].dueAt.Before(m.items[j].dueAt)
	})
	return nil
}

func (m *MemoryStore) PopDue(_ context.Context, now time.Time, limit int) ([]Job, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if limit <= 0 {
		limit = 10
	}
	cutoff := now.UTC()
	var due []Job
	remaining := m.items[:0]
	for _, entry := range m.items {
		if len(due) < limit && !entry.dueAt.After(cutoff) {
			due = append(due, entry.job)
			continue
		}
		remaining = append(remaining, entry)
	}
	m.items = remaining
	return due, nil
}

func (m *MemoryStore) PushDead(_ context.Context, job Job) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.dead = append([]Job{job}, m.dead...)
	if len(m.dead) > DefaultDeadLetterLimit {
		m.dead = m.dead[:DefaultDeadLetterLimit]
	}
	return nil
}

func (m *MemoryStore) AcquireLock(_ context.Context, key string, ttl time.Duration) (bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	now := m.now().UTC()
	if exp, ok := m.locks[key]; ok && now.Before(exp) {
		return false, nil
	}
	m.locks[key] = now.Add(ttl)
	return true, nil
}

func (m *MemoryStore) Stats(_ context.Context) (QueueStats, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return QueueStats{Pending: int64(len(m.items)), Dead: int64(len(m.dead))}, nil
}

// DeadJobs returns a snapshot of exhausted jobs (useful for tests).
func (m *MemoryStore) DeadJobs() []Job {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]Job, len(m.dead))
	copy(out, m.dead)
	return out
}

func (m *MemoryStore) Close() error { return nil }
