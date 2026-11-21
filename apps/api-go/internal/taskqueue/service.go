package taskqueue

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/effects"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/shared"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/tickets"
)

// WakeResult describes the outcome of executing one ticket wake or bump job.
type WakeResult struct {
	RunID   string
	Skipped bool
	Reason  string
}

// Config configures the task dispatch queue and idle-bot bumper.
type Config struct {
	Store        QueueStore
	DB           *db.DB
	Signals      *effects.Notifier
	BoardLab     bool
	Logger       *slog.Logger
	MaxAttempts  int
	BumpInterval time.Duration
	BumpIdle     time.Duration
	BumpCooldown time.Duration
	Now          func() time.Time
	// WakeFunc overrides Postgres wake execution in unit tests.
	WakeFunc func(ctx context.Context, job Job) (WakeResult, error)
}

// Service coordinates Redis-backed ticket wake dispatch, retries with backoff,
// and periodic bumping of idle worker bots that still have open todo/doing tasks.
type Service struct {
	store        QueueStore
	db           *db.DB
	signals      *effects.Notifier
	boardLab     bool
	logger       *slog.Logger
	maxAttempts  int
	bumpInterval time.Duration
	bumpIdle     time.Duration
	bumpCooldown time.Duration
	nowFn        func() time.Time
	wakeFn       func(ctx context.Context, job Job) (WakeResult, error)

	notifyCh chan struct{}
	wg       sync.WaitGroup
}

// New builds a taskqueue Service.
func New(cfg Config) *Service {
	nowFn := cfg.Now
	if nowFn == nil {
		nowFn = time.Now
	}
	store := cfg.Store
	if store == nil {
		store = NewMemoryStore(nowFn)
	}
	maxAttempts := cfg.MaxAttempts
	if maxAttempts <= 0 {
		maxAttempts = DefaultMaxAttempts
	}
	bumpInterval := cfg.BumpInterval
	if bumpInterval < 30*time.Second {
		bumpInterval = DefaultBumpInterval
	}
	bumpIdle := cfg.BumpIdle
	if bumpIdle <= 0 {
		bumpIdle = DefaultBumpIdle
	}
	bumpCooldown := cfg.BumpCooldown
	if bumpCooldown <= 0 {
		bumpCooldown = DefaultBumpCooldown
	}
	svc := &Service{
		store:        store,
		db:           cfg.DB,
		signals:      cfg.Signals,
		boardLab:     cfg.BoardLab,
		logger:       cfg.Logger,
		maxAttempts:  maxAttempts,
		bumpInterval: bumpInterval,
		bumpIdle:     bumpIdle,
		bumpCooldown: bumpCooldown,
		nowFn:        nowFn,
		notifyCh:     make(chan struct{}, 1),
	}
	if cfg.WakeFunc != nil {
		svc.wakeFn = cfg.WakeFunc
	} else {
		svc.wakeFn = svc.wakeBotForTicket
	}
	return svc
}

func (s *Service) now() time.Time {
	return s.nowFn().UTC().Truncate(time.Millisecond)
}

func (s *Service) signalDispatch() {
	select {
	case s.notifyCh <- struct{}{}:
	default:
	}
}

// EnqueueAssign schedules a ticket assignment wake on the queue with coalescing.
func (s *Service) EnqueueAssign(ctx context.Context, req DispatchRequest) (DispatchResponse, error) {
	if req.SpaceID == "" || req.TicketID == "" || req.BotID == "" {
		return DispatchResponse{}, errors.New("spaceId, ticketId, and botId are required")
	}
	lockKey := fmt.Sprintf("inflight:%s:%s", req.TicketID, req.BotID)
	acquired, err := s.store.AcquireLock(ctx, lockKey, DefaultInflightTTL)
	if err != nil {
		return DispatchResponse{}, err
	}
	if !acquired {
		return DispatchResponse{Queued: false, Driver: s.store.Driver(), Reason: "coalesced"}, nil
	}
	job := Job{
		ID:          effects.NewID(),
		Kind:        KindAssign,
		SpaceID:     req.SpaceID,
		TicketID:    req.TicketID,
		BotID:       req.BotID,
		Attempt:     0,
		MaxAttempts: s.maxAttempts,
		Note:        req.Note,
		EnqueuedAt:  shared.ISO(s.now()),
	}
	if err := s.store.Enqueue(ctx, job, s.now()); err != nil {
		return DispatchResponse{}, err
	}
	s.signalDispatch()
	return DispatchResponse{Queued: true, Driver: s.store.Driver()}, nil
}

// WakeWorkers queues a wake for each bot on a ticket the caller just changed. A failed enqueue is
// logged, not returned: the write that caused it has already committed.
func (s *Service) WakeWorkers(ctx context.Context, spaceID, ticketID string, botIDs []string, note string) {
	for _, botID := range botIDs {
		if _, err := s.EnqueueAssign(ctx, DispatchRequest{SpaceID: spaceID, TicketID: ticketID, BotID: botID, Note: note}); err != nil && s.logger != nil {
			s.logger.Warn("ticket worker wake not queued", "ticket", ticketID, "bot", botID, "error", err)
		}
	}
}

// EnqueueBump schedules a nudge for an idle worker bot on an open ticket.
func (s *Service) EnqueueBump(ctx context.Context, req BumpRequest) (DispatchResponse, error) {
	if req.SpaceID == "" || req.TicketID == "" || req.BotID == "" {
		return DispatchResponse{}, errors.New("spaceId, ticketId, and botId are required")
	}
	if !req.Force {
		lockKey := fmt.Sprintf("bump:%s:%s", req.TicketID, req.BotID)
		acquired, err := s.store.AcquireLock(ctx, lockKey, s.bumpCooldown)
		if err != nil {
			return DispatchResponse{}, err
		}
		if !acquired {
			return DispatchResponse{Queued: false, Driver: s.store.Driver(), Reason: "cooldown"}, nil
		}
	}
	job := Job{
		ID:          effects.NewID(),
		Kind:        KindBump,
		SpaceID:     req.SpaceID,
		TicketID:    req.TicketID,
		BotID:       req.BotID,
		Attempt:     0,
		MaxAttempts: s.maxAttempts,
		EnqueuedAt:  shared.ISO(s.now()),
	}
	if err := s.store.Enqueue(ctx, job, s.now()); err != nil {
		return DispatchResponse{}, err
	}
	s.signalDispatch()
	return DispatchResponse{Queued: true, Driver: s.store.Driver()}, nil
}

// Health reports queue connectivity and backlog counts.
func (s *Service) Health(ctx context.Context) HealthResponse {
	resp := HealthResponse{
		Enabled: true,
		Driver:  s.store.Driver(),
	}
	if err := s.store.Ping(ctx); err != nil {
		return resp
	}
	resp.Connected = true
	if stats, err := s.store.Stats(ctx); err == nil {
		resp.Pending = stats.Pending
		resp.Dead = stats.Dead
	}
	return resp
}

// Start runs the dispatch loop and the periodic idle-bot bump sweeper until ctx is cancelled.
func (s *Service) Start(ctx context.Context) {
	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		s.dispatchLoop(ctx)
	}()
	if s.db != nil {
		s.wg.Add(1)
		go func() {
			defer s.wg.Done()
			s.bumpLoop(ctx)
		}()
	}
}

// Wait blocks until background loops finish after ctx cancellation.
func (s *Service) Wait() {
	s.wg.Wait()
}

// Close closes the underlying QueueStore.
func (s *Service) Close() error {
	return s.store.Close()
}

func (s *Service) dispatchLoop(ctx context.Context) {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-s.notifyCh:
			s.ProcessDue(ctx, 20)
		case <-ticker.C:
			s.ProcessDue(ctx, 20)
		}
	}
}

func (s *Service) bumpLoop(ctx context.Context) {
	ticker := time.NewTicker(s.bumpInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if bumped, err := s.SweepStalledTickets(ctx); err != nil {
				if s.logger != nil {
					s.logger.Warn("taskqueue bump sweep failed", "error", err)
				}
			} else if bumped > 0 && s.logger != nil {
				s.logger.Info("taskqueue bumped idle bots", "count", bumped, "driver", s.store.Driver())
			}
		}
	}
}

// ProcessDue pops and dispatches up to limit due jobs, scheduling retries on transient errors.
func (s *Service) ProcessDue(ctx context.Context, limit int) int {
	jobs, err := s.store.PopDue(ctx, s.now(), limit)
	if err != nil {
		if s.logger != nil && ctx.Err() == nil {
			s.logger.Warn("taskqueue pop failed", "driver", s.store.Driver(), "error", err)
		}
		return 0
	}
	processed := 0
	for _, job := range jobs {
		processed++
		s.handleOne(ctx, job)
	}
	return processed
}

func (s *Service) handleOne(ctx context.Context, job Job) {
	res, err := s.wakeFn(ctx, job)
	if err == nil {
		if s.logger != nil && !res.Skipped {
			s.logger.Info("taskqueue dispatched bot run",
				"job.id", job.ID,
				"kind", job.Kind,
				"ticket.id", job.TicketID,
				"bot.id", job.BotID,
				"run.id", res.RunID,
				"attempt", job.Attempt+1,
				"driver", s.store.Driver(),
			)
		}
		return
	}

	job.Attempt++
	job.LastError = err.Error()
	maxAttempts := job.MaxAttempts
	if maxAttempts <= 0 {
		maxAttempts = s.maxAttempts
	}
	if job.Attempt >= maxAttempts {
		if pushErr := s.store.PushDead(ctx, job); pushErr != nil && s.logger != nil {
			s.logger.Error("taskqueue dead-letter push failed", "job.id", job.ID, "error", pushErr)
		}
		if s.logger != nil {
			s.logger.Error("taskqueue job exhausted retries",
				"job.id", job.ID,
				"kind", job.Kind,
				"ticket.id", job.TicketID,
				"bot.id", job.BotID,
				"attempts", job.Attempt,
				"error", err,
			)
		}
		return
	}

	delay := RetryDelay(job.Attempt)
	if reErr := s.store.Enqueue(ctx, job, s.now().Add(delay)); reErr != nil {
		if s.logger != nil {
			s.logger.Error("taskqueue retry enqueue failed", "job.id", job.ID, "error", reErr)
		}
		return
	}
	if s.logger != nil {
		s.logger.Warn("taskqueue delivery failed; retry scheduled",
			"job.id", job.ID,
			"kind", job.Kind,
			"ticket.id", job.TicketID,
			"bot.id", job.BotID,
			"attempt", job.Attempt,
			"retry_in_ms", delay.Milliseconds(),
			"error", err,
		)
	}
}

// SweepStalledTickets finds open todo/doing tickets whose worker bot is idle
// (no active run) and enqueues a bump with per-(ticket,bot) cooldown.
func (s *Service) SweepStalledTickets(ctx context.Context) (int, error) {
	if s.db == nil {
		return 0, nil
	}
	idleCutoff := s.now().Add(-s.bumpIdle)
	recentCutoff := s.now().Add(-s.bumpCooldown)

	type candidate struct {
		spaceID  string
		ticketID string
		botID    string
	}
	var candidates []candidate

	err := s.db.System(ctx, "sweep stalled tickets for idle worker bots", func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `
			SELECT DISTINCT t."spaceId", t.id, w.bot_id
			FROM tickets t
			CROSS JOIN LATERAL (
				SELECT unnest(
					CASE
						WHEN cardinality(t."workerBotIds") > 0 THEN t."workerBotIds"
						WHEN t."assigneeBotId" IS NOT NULL THEN ARRAY[t."assigneeBotId"]
						ELSE ARRAY[]::text[]
					END
				) AS bot_id
			) w
			JOIN bots b ON b.id = w.bot_id AND b."spaceId" = t."spaceId" AND b."archivedAt" IS NULL
			JOIN threads th ON th."botId" = b.id
			WHERE t.status IN ('todo', 'doing')
			  AND t."updatedAt" <= $1
			  AND NOT EXISTS (
			      SELECT 1 FROM runs r
			      WHERE r."botId" = b.id
			        AND r.status IN ('queued', 'running', 'waiting_input', 'waiting_approval', 'waiting_takeover')
			  )
			  AND NOT EXISTS (
			      SELECT 1 FROM runs r
			      WHERE r."botId" = b.id
			        AND r.trigger = 'tickets'
			        AND r."createdAt" >= $2
			  )
			ORDER BY t.id ASC
			LIMIT 50
		`, idleCutoff, recentCutoff)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var c candidate
			if err := rows.Scan(&c.spaceID, &c.ticketID, &c.botID); err != nil {
				return err
			}
			candidates = append(candidates, c)
		}
		return rows.Err()
	})
	if err != nil {
		return 0, err
	}

	bumped := 0
	for _, c := range candidates {
		res, err := s.EnqueueBump(ctx, BumpRequest{
			SpaceID:  c.spaceID,
			TicketID: c.ticketID,
			BotID:    c.botID,
		})
		if err != nil {
			return bumped, err
		}
		if res.Queued {
			bumped++
		}
	}
	return bumped, nil
}

// RerunAllOpen immediately enqueues a forced bump for every open todo/doing
// ticket whose worker bot is non-archived and not currently running, bypassing
// both the idle age threshold and cooldown window.
func (s *Service) RerunAllOpen(ctx context.Context) (RerunAllResponse, error) {
	resp := RerunAllResponse{Driver: s.store.Driver()}
	if s.db == nil {
		return resp, nil
	}
	type candidate struct {
		spaceID  string
		ticketID string
		botID    string
	}
	var candidates []candidate

	err := s.db.System(ctx, "rerun all open ticket tasks", func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `
			SELECT DISTINCT ON (b.id) t."spaceId", t.id, b.id
			FROM tickets t
			CROSS JOIN LATERAL (
				SELECT unnest(
					CASE
						WHEN cardinality(t."workerBotIds") > 0 THEN t."workerBotIds"
						WHEN t."assigneeBotId" IS NOT NULL THEN ARRAY[t."assigneeBotId"]
						ELSE ARRAY[]::text[]
					END
				) AS bot_id
			) w
			JOIN bots b ON b.id = w.bot_id AND b."spaceId" = t."spaceId" AND b."archivedAt" IS NULL
			JOIN threads th ON th."botId" = b.id
			WHERE t.status IN ('todo', 'doing')
			  AND NOT EXISTS (
			      SELECT 1 FROM runs r
			      WHERE r."botId" = b.id
			        AND r.status IN ('queued', 'running', 'waiting_input', 'waiting_approval', 'waiting_takeover')
			  )
			ORDER BY b.id, CASE WHEN t.status = 'doing' THEN 0 ELSE 1 END, t."updatedAt" DESC
		`)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var c candidate
			if err := rows.Scan(&c.spaceID, &c.ticketID, &c.botID); err != nil {
				return err
			}
			candidates = append(candidates, c)
		}
		return rows.Err()
	})
	if err != nil {
		return resp, err
	}

	resp.Found = len(candidates)
	for _, c := range candidates {
		queued, err := s.EnqueueBump(ctx, BumpRequest{
			SpaceID:  c.spaceID,
			TicketID: c.ticketID,
			BotID:    c.botID,
			Force:    true,
		})
		if err != nil {
			return resp, err
		}
		if queued.Queued {
			resp.Queued++
		}
	}
	return resp, nil
}

// wakeBotForTicket creates the hidden ticket task + run in Postgres and publishes
// runs:ready so rakazo-worker starts the bot immediately.
func (s *Service) wakeBotForTicket(ctx context.Context, job Job) (WakeResult, error) {
	if s.db == nil {
		return WakeResult{Skipped: true, Reason: "no_db"}, nil
	}
	var result WakeResult
	err := s.db.System(ctx, "dispatch ticket wake", func(tx pgx.Tx) error {
		var (
			number        int64
			title         string
			status        string
			prefix        string
			assigneeBotID *string
			workerBotIDs  []string
		)
		err := tx.QueryRow(ctx, `
			SELECT t.number, t.title, t.status, bd."ticketPrefix", t."assigneeBotId", t."workerBotIds"
			FROM tickets t
			JOIN boards bd ON bd.id = t."boardId"
			WHERE t.id = $1
			  AND t."spaceId" = $2
		`, job.TicketID, job.SpaceID).Scan(&number, &title, &status, &prefix, &assigneeBotID, &workerBotIDs)
		if errors.Is(err, pgx.ErrNoRows) {
			result = WakeResult{Skipped: true, Reason: "ticket_unassigned"}
			return nil
		}
		if err != nil {
			return err
		}

		if job.Kind == KindBump {
			assigned := assigneeBotID != nil && *assigneeBotID == job.BotID
			for _, id := range workerBotIDs {
				if id == job.BotID {
					assigned = true
					break
				}
			}
			if !assigned {
				result = WakeResult{Skipped: true, Reason: "ticket_unassigned"}
				return nil
			}
			if status != "todo" && status != "doing" {
				result = WakeResult{Skipped: true, Reason: "ticket_not_active"}
				return nil
			}
		} else {
			if status == "done" || status == "closed" {
				result = WakeResult{Skipped: true, Reason: "ticket_completed"}
				return nil
			}
		}

		var (
			botUserID string
			threadID  string
		)
		err = tx.QueryRow(ctx, `
			SELECT b."userId", th.id
			FROM bots b
			JOIN threads th ON th."botId" = b.id
			WHERE b.id = $1 AND b."spaceId" = $2 AND b."archivedAt" IS NULL
			LIMIT 1
		`, job.BotID, job.SpaceID).Scan(&botUserID, &threadID)
		if errors.Is(err, pgx.ErrNoRows) {
			result = WakeResult{Skipped: true, Reason: "bot_unavailable"}
			return nil
		}
		if err != nil {
			return err
		}

		enabled, err := tickets.Enabled(ctx, tx, shared.Deployment{BoardLab: s.boardLab}, botUserID)
		if err != nil {
			return err
		}
		if !enabled {
			result = WakeResult{Skipped: true, Reason: "board_disabled"}
			return nil
		}

		if job.Kind == KindBump {
			var busy bool
			err = tx.QueryRow(ctx, `
				SELECT EXISTS(
					SELECT 1 FROM runs
					WHERE "botId" = $1
					  AND status IN ('queued', 'running', 'waiting_input', 'waiting_approval', 'waiting_takeover')
				)
			`, job.BotID).Scan(&busy)
			if err != nil {
				return err
			}
			if busy {
				result = WakeResult{Skipped: true, Reason: "bot_busy"}
				return nil
			}
		}

		ref := fmt.Sprintf("%s-%d", prefix, number)
		prompt := TicketWakePrompt(ref, job.Note)
		if job.Kind == KindBump {
			prompt = TicketBumpPrompt(ref, title, status)
		}

		at := s.now()
		taskID := effects.NewID()
		runID := effects.NewID()

		if _, err := tx.Exec(ctx, `
			INSERT INTO tasks (id, "spaceId", "botId", "threadId", "userId", prompt, status, "createdAt", "updatedAt")
			VALUES ($1, $2, $3, $4, $5, $6, 'queued', $7, $7)
		`, taskID, job.SpaceID, job.BotID, threadID, botUserID, prompt, at); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO runs (id, "spaceId", "botId", "threadId", "userId", "taskId", trigger, status, "wakeAt", "createdAt", "updatedAt")
			VALUES ($1, $2, $3, $4, $5, $6, 'tickets', 'queued', $7, $7, $7)
		`, runID, job.SpaceID, job.BotID, threadID, botUserID, taskID, at); err != nil {
			return err
		}

		result = WakeResult{RunID: runID}
		return nil
	})
	if err != nil {
		return WakeResult{}, err
	}
	if result.RunID != "" && s.signals != nil {
		s.signals.PublishRunReady(result.RunID)
		s.signals.PublishSpaceChange(job.SpaceID, "runs")
	}
	return result, nil
}
