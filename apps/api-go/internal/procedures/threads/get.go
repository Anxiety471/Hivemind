package threads

import (
	"context"
	"errors"
	"log/slog"
	"math"
	"slices"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/contentcrypto"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/orpc"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/routines"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/shared"
)

// This file is threads.get: threadSnapshot (apps/api/src/threads/thread-snapshot.ts) behind
// resolveThreadTarget, with the transcript page of loadMessagePage
// (apps/api/src/threads/thread-message-pages.ts). The router's output schema (ThreadSnapshotSchema)
// is applied to the answer: what the schema strips is left out, what breaks it fails the call with
// "Output validation failed", and what Go cannot judge exactly is declined (local.ErrDecline) so
// the gateway asks TypeScript.

// messagePageSize is THREAD_MESSAGE_PAGE_SIZE (apps/api/src/routes/shared.ts).
const messagePageSize = 30

// Background runs (BACKGROUND_RUN_TRIGGERS) and the helper trigger (BACKGROUND_HELPER_TRIGGER).
const (
	backgroundTrigger = "tickets"
	helperTrigger     = "helper"
	peerTrigger       = "bot_message"
)

var (
	activeRunStatusList = []string{"queued", "leased", "running", "waiting_input", "waiting_takeover"}
	activeRunStatuses   = map[string]bool{"queued": true, "leased": true, "running": true, "waiting_input": true, "waiting_takeover": true}
	runStatuses         = append(slices.Clone(activeRunStatusList), "completed", "failed", "cancelled")
	runTriggers         = []string{
		"user", "routine", "resume", "follow_up", "reaction", "call_end", "spawn", "skill", "bot_message", "webhook",
		"messaging", "cloud_agent", "purchase", "media", "created", "tickets", "helper", "helper_result",
	}
	liveEventTypes = []string{
		"thread.progress", "thread.thinking", "thread.subagent", "run.waiting_input",
		"run.checkpointed", "computer.takeover.requested", "agent.tool.called", "agent.tool.completed", "usage.recorded",
	}
)

// Get implements threads.get.
func Get(ctx context.Context, database *db.DB, deployment shared.Deployment, actor db.Actor, raw orpc.Input) (any, *orpc.Error) {
	in, failure := parseWith(raw, nil)
	if failure != nil {
		return nil, failure
	}
	var result map[string]any
	err := locked(ctx, database, actor, func(ctx context.Context, tx pgx.Tx) error {
		snapshot := snapshotReader{ctx: ctx, tx: tx, ring: deployment.Content, viewer: actor.UserID}
		var err error
		if in.BotID != "" {
			result, err = snapshot.bot(actor, in.BotID)
		} else {
			result, err = snapshot.group(actor, in.GroupID)
		}
		return err
	})
	if err != nil {
		var failure *orpc.Error
		if !errors.As(err, &failure) {
			slog.Default().Error("threads.get failed", "error", err)
		}
		return nil, asFailure(err)
	}
	return result, nil
}

type snapshotReader struct {
	ctx    context.Context
	tx     pgx.Tx
	ring   *contentcrypto.KeyRing
	viewer string
}

func (s snapshotReader) open(model string, rows []map[string]any) error {
	if s.ring == nil || len(rows) == 0 {
		return nil
	}
	return s.ring.OpenRows(s.ctx, model, rows)
}

type botTarget struct {
	ID, Name, SpaceID, ThreadID, ComputerID string
}

// bot is resolveThreadTarget with includeArchived, then the bot variant of threadSnapshot.
func (s snapshotReader) bot(actor db.Actor, botID string) (map[string]any, error) {
	var target botTarget
	var threadID, computerID *string
	err := s.tx.QueryRow(s.ctx, `SELECT b.id, b.name, b."spaceId", b."computerId", t.id
		FROM bots b LEFT JOIN threads t ON t."botId" = b.id
		WHERE b.id = $1 AND b."spaceId" = $2`, botID, actor.SpaceID).Scan(&target.ID, &target.Name, &target.SpaceID, &computerID, &threadID)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && threadID == nil) {
		return nil, errIsolation
	}
	if err != nil {
		return nil, err
	}
	target.ThreadID = *threadID
	if computerID != nil {
		target.ComputerID = *computerID
	}
	if err := s.lock(target.ThreadID); err != nil {
		return nil, err
	}
	page, err := s.messagePage(target.ThreadID)
	if err != nil {
		return nil, err
	}
	cursor, err := s.lastSeq(target.ThreadID)
	if err != nil {
		return nil, err
	}
	activeRuns, err := s.runs(`r."botId" = $1 AND r.status = ANY($2)
		AND (r.trigger <> $3 OR r.status IN ('waiting_input', 'waiting_takeover'))
		AND (r."threadId" = $4 OR (`+startedHelpers("$4")+` AND r.status = 'waiting_input'))
		ORDER BY r."createdAt" DESC, r.id DESC`, target.ID, activeRunStatusList, backgroundTrigger, target.ThreadID)
	if err != nil {
		return nil, err
	}
	busyOrFailed, err := s.runs(`r."botId" = $1 AND r."threadId" = $2 AND r.trigger <> $3 AND r.status = ANY($4)
		ORDER BY r."createdAt" DESC, r.id DESC LIMIT 1`, target.ID, target.ThreadID, backgroundTrigger,
		append(slices.Clone(activeRunStatusList), "failed"))
	if err != nil {
		return nil, err
	}
	isShared, err := s.spaceIsShared(target.SpaceID)
	if err != nil {
		return nil, err
	}
	var computer *computerRow
	if target.ComputerID != "" {
		if computer, err = loadComputer(s.ctx, s.tx, target.ComputerID); err != nil {
			return nil, err
		}
	}
	work, err := resolveComputerWork(s.ctx, s.tx, target.ComputerID, target.ID, target.Name)
	if err != nil {
		return nil, err
	}
	current := pickPrimaryPrivateActiveRun(activeRuns)
	// Active runs carry their routine's name; the busy-or-failed fallback row does not.
	withRoutine := current != nil
	if current == nil && len(busyOrFailed) > 0 {
		current = &busyOrFailed[0]
	}
	if current != nil && current.Status == "failed" {
		newest, err := s.runs(`r."botId" = $1 AND r."threadId" = $2 AND r.trigger <> $3
			AND r.status IN ('failed', 'completed', 'cancelled') ORDER BY r."createdAt" DESC, r.id DESC LIMIT 1`,
			target.ID, target.ThreadID, backgroundTrigger)
		if err != nil {
			return nil, err
		}
		if len(newest) == 0 || newest[0].ID != current.ID {
			current = nil
		}
	}
	var live []runRow
	for _, run := range activeRuns {
		if run.Trigger != peerTrigger {
			live = append(live, run)
		}
	}
	messages, err := s.withLive(target.ThreadID, page.messages, live, activeRuns)
	if err != nil {
		return nil, err
	}
	costs, err := s.runCosts(collectRunIDs(activeRuns, current))
	if err != nil {
		return nil, err
	}
	applyRunCosts(activeRuns, current, costs)
	run, err := optionalRun(current, withRoutine)
	if err != nil {
		return nil, err
	}
	active, err := runViews(activeRuns, true)
	if err != nil {
		return nil, err
	}
	status, ok := computerStatus(target.ID, computer, work, isShared, s.viewer)
	if !ok {
		return nil, outputInvalid()
	}
	return map[string]any{
		"botId": target.ID, "threadId": target.ThreadID, "cursor": cursor, "messages": messages,
		"olderCursor": page.olderCursor, "run": run, "activeRuns": active, "computer": status,
	}, nil
}

func outputInvalid() *orpc.Error { return shared.OutputInvalid() }

type groupMember struct {
	BotID, Name, Color, AvatarSet string
}

// group is the group variant: the group's thread, its active members and their statuses.
func (s snapshotReader) group(actor db.Actor, groupID string) (map[string]any, error) {
	var name string
	var threadID *string
	err := s.tx.QueryRow(s.ctx, `SELECT g.name, t.id FROM chat_groups g LEFT JOIN threads t ON t."groupId" = g.id
		WHERE g.id = $1 AND g."spaceId" = $2 AND g."archivedAt" IS NULL`, groupID, actor.SpaceID).Scan(&name, &threadID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, errIsolation
	}
	if err != nil {
		return nil, err
	}
	rows, err := s.tx.Query(s.ctx, `SELECT b.id, b.name, b.color, b."avatarSet" FROM chat_group_members m
		JOIN bots b ON b.id = m."botId" WHERE m."groupId" = $1 AND b."archivedAt" IS NULL
		ORDER BY m."createdAt", m."botId"`, groupID)
	if err != nil {
		return nil, err
	}
	var members []groupMember
	for rows.Next() {
		var member groupMember
		var avatarSet *string
		if err := rows.Scan(&member.BotID, &member.Name, &member.Color, &avatarSet); err != nil {
			rows.Close()
			return nil, err
		}
		member.AvatarSet = "organic"
		if avatarSet != nil && *avatarSet == "rakazo" {
			member.AvatarSet = "rakazo"
		}
		members = append(members, member)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(members) < groupMemberMin || threadID == nil {
		return nil, errIsolation
	}
	if err := s.lock(*threadID); err != nil {
		return nil, err
	}
	page, err := s.messagePage(*threadID)
	if err != nil {
		return nil, err
	}
	cursor, err := s.lastSeq(*threadID)
	if err != nil {
		return nil, err
	}
	activeRuns, err := s.runs(`(r."threadId" = $1 OR (`+startedHelpers("$1")+` AND r.status = 'waiting_input'))
		AND r.status = ANY($2) AND (r.trigger NOT IN ($3, $4) OR r.status IN ('waiting_input', 'waiting_takeover'))
		ORDER BY r."createdAt" DESC`, *threadID, activeRunStatusList, peerTrigger, backgroundTrigger)
	if err != nil {
		return nil, err
	}
	terminals, err := s.runs(`r."threadId" = $1 AND r.trigger NOT IN ($2, $3) AND r.status IN ('failed', 'completed', 'cancelled')
		ORDER BY r."updatedAt" DESC, r.id DESC LIMIT 50`, *threadID, peerTrigger, backgroundTrigger)
	if err != nil {
		return nil, err
	}
	memberIDs := make([]string, len(members))
	for index, member := range members {
		memberIDs[index] = member.BotID
	}
	statuses, err := s.botRunStatuses(memberIDs)
	if err != nil {
		return nil, err
	}
	messages, err := s.withLive(*threadID, page.messages, activeRuns, activeRuns)
	if err != nil {
		return nil, err
	}
	var current *runRow
	var withRoutine bool
	if terminal := pickLatestTerminalRun(terminals); terminal != nil && terminal.Status == "failed" {
		current = terminal
	} else if primary := pickPrimaryActiveRun(activeRuns); primary != nil {
		current, withRoutine = primary, true
	}
	costs, err := s.runCosts(collectRunIDs(activeRuns, current))
	if err != nil {
		return nil, err
	}
	applyRunCosts(activeRuns, current, costs)
	run, err := optionalRun(current, withRoutine)
	if err != nil {
		return nil, err
	}
	active, err := runViews(activeRuns, true)
	if err != nil {
		return nil, err
	}
	views := make([]any, len(members))
	for index, member := range members {
		views[index] = map[string]any{
			"botId": member.BotID, "name": member.Name, "color": member.Color,
			"avatarSet": member.AvatarSet, "status": statuses[member.BotID],
		}
		if member.BotID == "" {
			return nil, outputInvalid()
		}
	}
	return map[string]any{
		"groupId": groupID, "groupName": name, "members": views, "threadId": *threadID, "cursor": cursor,
		"messages": messages, "olderCursor": page.olderCursor, "run": run, "activeRuns": active,
	}, nil
}

// lock is the SELECT ... FOR SHARE that makes the event cursor and every field a thread event
// can change one consistent commit.
func (s snapshotReader) lock(threadID string) error {
	var id string
	return s.tx.QueryRow(s.ctx, `SELECT id FROM threads WHERE id = $1 FOR SHARE`, threadID).Scan(&id)
}

func (s snapshotReader) lastSeq(threadID string) (int32, error) {
	var seq int32
	err := s.tx.QueryRow(s.ctx, `SELECT seq FROM events WHERE "threadId" = $1 ORDER BY seq DESC LIMIT 1`, threadID).Scan(&seq)
	if errors.Is(err, pgx.ErrNoRows) {
		return -1, nil
	}
	return seq, err
}

func (s snapshotReader) spaceIsShared(spaceID string) (bool, error) {
	var count int
	err := s.tx.QueryRow(s.ctx, `SELECT count(*) FROM (SELECT 1 FROM space_members WHERE "spaceId" = $1 LIMIT 2) m`, spaceID).Scan(&count)
	return count > 1, err
}

// startedHelpers is startedHelpersWhere(threadId): the background helpers the thread started, and
// the helpers those started in turn.
func startedHelpers(thread string) string {
	card := `(SELECT id FROM messages WHERE "threadId" = ` + thread + `)`
	return `(r.trigger = '` + helperTrigger + `' AND (r."sourceMessageId" IN ` + card + `
		OR EXISTS (SELECT 1 FROM messages sm JOIN runs h ON h."threadId" = sm."threadId"
			WHERE sm.id = r."sourceMessageId" AND h.trigger = '` + helperTrigger + `' AND h."sourceMessageId" IN ` + card + `)))`
}

type runRow struct {
	ID, UserID, BotID, ThreadID, TaskID, Status, Trigger string
	RoutineID, RoutineName                               *string
	ModelProvider, ModelID, Error                        *string
	CostUSD                                              *float64
	StartedAt, CompletedAt                               *time.Time
	CreatedAt, UpdatedAt                                 time.Time
}

func collectRunIDs(runs []runRow, extra *runRow) []string {
	seen := map[string]bool{}
	var ids []string
	for _, run := range runs {
		if run.ID != "" && !seen[run.ID] {
			seen[run.ID] = true
			ids = append(ids, run.ID)
		}
	}
	if extra != nil && extra.ID != "" && !seen[extra.ID] {
		ids = append(ids, extra.ID)
	}
	return ids
}

func (s snapshotReader) runCosts(runIDs []string) (map[string]float64, error) {
	costs := map[string]float64{}
	if len(runIDs) == 0 {
		return costs, nil
	}
	rows, err := s.tx.Query(s.ctx, `SELECT "runId", SUM("costUsd")::double precision FROM usage_records WHERE "runId" = ANY($1) GROUP BY "runId"`, runIDs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var runID *string
		var sum *float64
		if err := rows.Scan(&runID, &sum); err != nil {
			return nil, err
		}
		if runID != nil && sum != nil && !math.IsNaN(*sum) && !math.IsInf(*sum, 0) && *sum >= 0 {
			costs[*runID] = *sum
		}
	}
	return costs, rows.Err()
}

func applyRunCosts(runs []runRow, extra *runRow, costs map[string]float64) {
	for index := range runs {
		if cost, ok := costs[runs[index].ID]; ok {
			val := cost
			runs[index].CostUSD = &val
		}
	}
	if extra != nil {
		if cost, ok := costs[extra.ID]; ok {
			val := cost
			extra.CostUSD = &val
		}
	}
}

// runs reads runs matching where (which may use alias r and the routine as ro).
func (s snapshotReader) runs(where string, args ...any) ([]runRow, error) {
	rows, err := s.tx.Query(s.ctx, `SELECT r.id, r."userId", r."botId", r."threadId", r."taskId", r.status, r.trigger,
		r."routineId", ro.name, r."modelProvider", r."modelId", r.error, r."startedAt", r."completedAt", r."createdAt", r."updatedAt"
		FROM runs r LEFT JOIN routines ro ON ro.id = r."routineId" WHERE `+where, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var found []runRow
	for rows.Next() {
		var run runRow
		if err := rows.Scan(&run.ID, &run.UserID, &run.BotID, &run.ThreadID, &run.TaskID, &run.Status, &run.Trigger,
			&run.RoutineID, &run.RoutineName, &run.ModelProvider, &run.ModelID, &run.Error, &run.StartedAt,
			&run.CompletedAt, &run.CreatedAt, &run.UpdatedAt); err != nil {
			return nil, err
		}
		found = append(found, run)
	}
	return found, rows.Err()
}

// botRunStatuses is botRunStatuses: each bot's status from its active runs in any thread.
func (s snapshotReader) botRunStatuses(botIDs []string) (map[string]string, error) {
	rows, err := s.tx.Query(s.ctx, `SELECT "botId", status FROM runs WHERE "botId" = ANY($1) AND status = ANY($2)
		AND trigger NOT IN ($3, $4) ORDER BY "createdAt" DESC`, botIDs, activeRunStatusList, backgroundTrigger, helperTrigger)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	byBot := map[string][]string{}
	for rows.Next() {
		var botID, status string
		if err := rows.Scan(&botID, &status); err != nil {
			return nil, err
		}
		byBot[botID] = append(byBot[botID], status)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	statuses := make(map[string]string, len(botIDs))
	for _, botID := range botIDs {
		statuses[botID] = primaryStatus(byBot[botID])
	}
	return statuses, nil
}

// primaryStatus is primaryActiveRun's status over statuses newest first: the newest waiting run,
// then running, then leased, then the newest; idle without a run.
func primaryStatus(statuses []string) string {
	for _, status := range statuses {
		if status == "waiting_takeover" || status == "waiting_input" {
			return status
		}
	}
	for _, status := range statuses {
		if status == "running" || status == "leased" {
			return status
		}
	}
	if len(statuses) > 0 {
		return statuses[0]
	}
	return "idle"
}

func firstWithStatus(runs []runRow, statuses ...string) *runRow {
	for index := range runs {
		if slices.Contains(statuses, runs[index].Status) {
			return &runs[index]
		}
	}
	return nil
}

// pickPrimaryPrivateActiveRun: takeover, then live work, while pending cards stay active.
func pickPrimaryPrivateActiveRun(runs []runRow) *runRow {
	for _, status := range []string{"waiting_takeover", "running", "leased"} {
		if run := firstWithStatus(runs, status); run != nil {
			return run
		}
	}
	if len(runs) > 0 {
		return &runs[0]
	}
	return nil
}

// pickPrimaryActiveRun keeps waiting asks and takeovers in the group headline ahead of newer busy runs.
func pickPrimaryActiveRun(runs []runRow) *runRow {
	if run := firstWithStatus(runs, "waiting_input", "waiting_takeover"); run != nil {
		return run
	}
	if len(runs) > 0 {
		return &runs[0]
	}
	return nil
}

// pickLatestTerminalRun ranks by completedAt ?? createdAt, then createdAt, then id.
func pickLatestTerminalRun(runs []runRow) *runRow {
	if len(runs) == 0 {
		return nil
	}
	end := func(run runRow) time.Time {
		if run.CompletedAt != nil {
			return *run.CompletedAt
		}
		return run.CreatedAt
	}
	best := runs[0]
	for _, run := range runs[1:] {
		switch {
		case !end(run).Equal(end(best)):
			if end(run).After(end(best)) {
				best = run
			}
		case !run.CreatedAt.Equal(best.CreatedAt):
			if run.CreatedAt.After(best.CreatedAt) {
				best = run
			}
		case run.ID > best.ID:
			best = run
		}
	}
	return &best
}

func optionalRun(run *runRow, withRoutine bool) (any, error) {
	if run == nil {
		return nil, nil
	}
	view, ok := runView(*run, withRoutine)
	if !ok {
		return nil, outputInvalid()
	}
	return view, nil
}

func runViews(runs []runRow, withRoutine bool) ([]any, error) {
	views := make([]any, 0, len(runs))
	for _, run := range runs {
		view, ok := runView(run, withRoutine)
		if !ok {
			return nil, outputInvalid()
		}
		views = append(views, view)
	}
	return views, nil
}

// runView is mapRun, checked against RunSchema. ok is false when the row breaks the schema.
func runView(run runRow, withRoutine bool) (map[string]any, bool) {
	if run.ID == "" || run.UserID == "" || run.BotID == "" || run.ThreadID == "" || run.TaskID == "" ||
		!slices.Contains(runStatuses, run.Status) || !slices.Contains(runTriggers, run.Trigger) ||
		(run.RoutineID != nil && *run.RoutineID == "") {
		return nil, false
	}
	view := map[string]any{
		"id": run.ID, "userId": run.UserID, "botId": run.BotID, "threadId": run.ThreadID, "taskId": run.TaskID,
		"status": run.Status, "trigger": run.Trigger, "routineId": run.RoutineID,
	}
	if withRoutine && run.RoutineName != nil {
		view["routineName"] = *run.RoutineName
	}
	view["modelProvider"] = run.ModelProvider
	view["modelId"] = run.ModelID
	if run.CostUSD != nil {
		view["costUsd"] = *run.CostUSD
	}
	// The same display clamp as live run.failed events, so a huge stored error cannot bypass it.
	if run.Status == "failed" {
		view["error"] = routines.RunFailureError(run.Status, run.Error)
	} else {
		view["error"] = run.Error
	}
	view["startedAt"] = isoPointer(run.StartedAt)
	view["completedAt"] = isoPointer(run.CompletedAt)
	view["createdAt"] = shared.ISO(run.CreatedAt)
	return view, true
}

func isoPointer(at *time.Time) any {
	if at == nil {
		return nil
	}
	return shared.ISO(*at)
}
