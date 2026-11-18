package usage

import "testing"

// A total is reported only when every counted call has the figure; otherwise it is unknown.
func TestTotalsAreUnknownWhenAnyCallLacksTheFigure(t *testing.T) {
	complete := aggregate{calls: 2, inputCount: 2, outputCount: 2, totalCount: 2, costCount: 2,
		inputSum: new(int64(5_000_000_000)), outputSum: new(int64(3)), totalSum: new(int64(8)), costSum: new(0.25)}
	got := complete.totals()
	if got.InputTokens == nil || *got.InputTokens != 5_000_000_000 || got.CostUSD == nil || *got.CostUSD != 0.25 || got.ModelCalls != 2 {
		t.Fatalf("complete = %+v", got)
	}
	partial := aggregate{calls: 3, inputCount: 2, outputCount: 3, totalCount: 0, costCount: 3, inputSum: new(int64(1)), outputSum: new(int64(2)), costSum: new(1.0)}
	got = partial.totals()
	if got.InputTokens != nil || got.TotalTokens != nil || got.OutputTokens == nil || *got.OutputTokens != 2 {
		t.Fatalf("partial = %+v", got)
	}
	// No calls at all: every count matches, every sum is empty, so the totals read 0.
	empty := aggregate{}.totals()
	if empty.InputTokens == nil || *empty.InputTokens != 0 || empty.CostUSD == nil || *empty.CostUSD != 0 || empty.ModelCalls != 0 {
		t.Fatalf("empty = %+v", empty)
	}
}
