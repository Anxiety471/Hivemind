// Package usage ports usage.list and usage.summary (routes/content.ts). usage.breakdown
// stays on the TypeScript API: it buckets by the member's timezone with core's
// wall-clock helpers; usage.limits reads provider credentials.
package usage

import (
	"context"
	"math"
	"sort"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/orpc"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/shared"
)

// Record is the wire shape of UsageRecordSchema as usage.list fills it.
type Record struct {
	ID                 string   `json:"id"`
	BotID              *string  `json:"botId"`
	RunID              *string  `json:"runId"`
	Provider           string   `json:"provider"`
	Model              string   `json:"model"`
	InputTokens        *int32   `json:"inputTokens"`
	OutputTokens       *int32   `json:"outputTokens"`
	CacheReadTokens    *int32   `json:"cacheReadTokens"`
	CacheWriteTokens   *int32   `json:"cacheWriteTokens"`
	CacheWrite1hTokens *int32   `json:"cacheWrite1hTokens"`
	ReasoningTokens    *int32   `json:"reasoningTokens"`
	TotalTokens        *int32   `json:"totalTokens"`
	CostUSD            *float64 `json:"costUsd"`
	CostSource         *string  `json:"costSource"`
	PricingVersion     *string  `json:"pricingVersion"`
	UsageSource        *string  `json:"usageSource"`
	CallID             *string  `json:"callId"`
	OperationID        *string  `json:"operationId"`
	OperationKind      string   `json:"operationKind"`
	ParentRunID        *string  `json:"parentRunId"`
	AgentID            *string  `json:"agentId"`
	CreatedAt          string   `json:"createdAt"`
}

// List implements usage.list: the member's last 100 records in this Space, newest first.
func List(ctx context.Context, database *db.DB, actor db.Actor) ([]Record, *orpc.Error) {
	records := []Record{}
	err := database.Tenant(ctx, actor, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `SELECT id, "botId", "runId", provider, model, "inputTokens", "outputTokens", "cacheReadTokens",
				"cacheWriteTokens", "cacheWrite1hTokens", "reasoningTokens", "totalTokens", "costUsd", "costSource", "pricingVersion",
				"usageSource", "callId", "operationId", "operationKind", "parentRunId", "agentId", "createdAt"
			FROM usage_records WHERE "spaceId" = $1 AND "userId" = $2 ORDER BY "createdAt" DESC, ctid LIMIT 100`, actor.SpaceID, actor.UserID)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var record Record
			var createdAt time.Time
			if err := rows.Scan(&record.ID, &record.BotID, &record.RunID, &record.Provider, &record.Model, &record.InputTokens,
				&record.OutputTokens, &record.CacheReadTokens, &record.CacheWriteTokens, &record.CacheWrite1hTokens,
				&record.ReasoningTokens, &record.TotalTokens, &record.CostUSD, &record.CostSource, &record.PricingVersion,
				&record.UsageSource, &record.CallID, &record.OperationID, &record.OperationKind, &record.ParentRunID,
				&record.AgentID, &createdAt); err != nil {
				return err
			}
			if !valid(record) {
				return shared.OutputInvalid()
			}
			record.CreatedAt = shared.ISO(createdAt)
			records = append(records, record)
		}
		return rows.Err()
	})
	if err != nil {
		return nil, shared.Failure(err)
	}
	return records, nil
}

// valid is UsageRecordSchema's constraints a stored row can break; the router validates
// the output, so one bad row fails the whole call: botId and runId are ids when present,
// the operation kind is one of five, and a cost is not negative.
func valid(record Record) bool {
	if record.ID == "" || (record.BotID != nil && *record.BotID == "") || (record.RunID != nil && *record.RunID == "") {
		return false
	}
	switch record.OperationKind {
	case "answer", "setup", "retrieval", "subagent", "compaction":
	default:
		return false
	}
	// z.number().nonnegative() also refuses NaN and Infinity.
	return record.CostUSD == nil || (!math.IsNaN(*record.CostUSD) && !math.IsInf(*record.CostUSD, 0) && *record.CostUSD >= 0)
}

func modelTotals(models []ModelTotals) []Totals {
	found := make([]Totals, len(models))
	for index, model := range models {
		found[index] = model.Totals
	}
	return found
}

// Totals are the figures of one group: each is null when any counted call lacks it,
// because a total that skipped rows would understate spend.
type Totals struct {
	InputTokens  *float64 `json:"inputTokens"`
	OutputTokens *float64 `json:"outputTokens"`
	TotalTokens  *float64 `json:"totalTokens"`
	CostUSD      *float64 `json:"costUsd"`
	ModelCalls   int64    `json:"modelCalls"`
}

// ModelTotals is one provider and model's figures.
type ModelTotals struct {
	Provider string `json:"provider"`
	Model    string `json:"model"`
	Totals
}

// Summary is the wire shape of UsageSummarySchema.
type Summary struct {
	Totals
	Runs   int           `json:"runs"`
	Models []ModelTotals `json:"models"`
}

// aggregate is `_count` and `_sum` of the four figures for one group.
type aggregate struct {
	calls                                          int64
	inputCount, outputCount, totalCount, costCount int64
	inputSum, outputSum, totalSum                  *int64
	costSum                                        *float64
}

const aggregateColumns = `count(*), count("inputTokens"), count("outputTokens"), count("totalTokens"), count("costUsd"),
	sum("inputTokens")::bigint, sum("outputTokens")::bigint, sum("totalTokens")::bigint, sum("costUsd")`

func (a *aggregate) targets() []any {
	return []any{&a.calls, &a.inputCount, &a.outputCount, &a.totalCount, &a.costCount, &a.inputSum, &a.outputSum, &a.totalSum, &a.costSum}
}

// totals is completeSums: a sum is reported only when every call has the figure.
func (a aggregate) totals() Totals {
	whole := func(count int64, sum *int64) *float64 {
		if count != a.calls {
			return nil
		}
		value := 0.0
		if sum != nil {
			value = float64(*sum)
		}
		return &value
	}
	cost := func() *float64 {
		if a.costCount != a.calls {
			return nil
		}
		value := 0.0
		if a.costSum != nil {
			value = *a.costSum
		}
		return &value
	}
	return Totals{
		InputTokens:  whole(a.inputCount, a.inputSum),
		OutputTokens: whole(a.outputCount, a.outputSum),
		TotalTokens:  whole(a.totalCount, a.totalSum),
		CostUSD:      cost(),
		ModelCalls:   a.calls,
	}
}

// SummaryOf implements usage.summary: totals over all of the member's records in this
// Space, the distinct runs (a subagent run counts as its parent's), and each model.
func SummaryOf(ctx context.Context, database *db.DB, actor db.Actor) (any, *orpc.Error) {
	var summary Summary
	err := database.Tenant(ctx, actor, func(tx pgx.Tx) error {
		var whole aggregate
		if err := tx.QueryRow(ctx, `SELECT `+aggregateColumns+` FROM usage_records WHERE "spaceId" = $1 AND "userId" = $2`,
			actor.SpaceID, actor.UserID).Scan(whole.targets()...); err != nil {
			return err
		}
		rows, err := tx.Query(ctx, `SELECT provider, model, `+aggregateColumns+` FROM usage_records
			WHERE "spaceId" = $1 AND "userId" = $2 GROUP BY provider, model`, actor.SpaceID, actor.UserID)
		if err != nil {
			return err
		}
		models := []ModelTotals{}
		for rows.Next() {
			var group aggregate
			var provider, model string
			if err := rows.Scan(append([]any{&provider, &model}, group.targets()...)...); err != nil {
				rows.Close()
				return err
			}
			models = append(models, ModelTotals{Provider: provider, Model: model, Totals: group.totals()})
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}
		runRows, err := tx.Query(ctx, `SELECT "runId", "parentRunId" FROM usage_records WHERE "spaceId" = $1 AND "userId" = $2 GROUP BY "runId", "parentRunId"`,
			actor.SpaceID, actor.UserID)
		if err != nil {
			return err
		}
		defer runRows.Close()
		runs := map[string]bool{}
		for runRows.Next() {
			var runID, parentID *string
			if err := runRows.Scan(&runID, &parentID); err != nil {
				return err
			}
			// parentRunId ?? runId, and an empty or missing id is no run.
			id := ""
			if parentID != nil {
				id = *parentID
			} else if runID != nil {
				id = *runID
			}
			if id != "" {
				runs[id] = true
			}
		}
		if err := runRows.Err(); err != nil {
			return err
		}
		weight := func(totals Totals) float64 {
			if totals.TotalTokens == nil {
				return 0
			}
			return *totals.TotalTokens
		}
		sort.SliceStable(models, func(a, b int) bool {
			if weight(models[a].Totals) != weight(models[b].Totals) {
				return weight(models[a].Totals) > weight(models[b].Totals)
			}
			return models[a].ModelCalls > models[b].ModelCalls
		})
		// z.number() refuses a non-finite figure (a cost of NaN or Infinity, or a sum that overflows).
		for _, totals := range append([]Totals{whole.totals()}, modelTotals(models)...) {
			if totals.CostUSD != nil && (math.IsNaN(*totals.CostUSD) || math.IsInf(*totals.CostUSD, 0)) {
				return shared.OutputInvalid()
			}
		}
		summary = Summary{Totals: whole.totals(), Runs: len(runs), Models: models}
		return nil
	})
	if err != nil {
		return nil, shared.Failure(err)
	}
	return summary, nil
}
