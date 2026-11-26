package events

import (
	"testing"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/tsunions"
)

// TestResponseBlockKindsMatchTypeScript guards RESPONSE_BLOCK_KINDS (packages/db/src/runs/
// run-timing.ts:4), the block kinds that count as a run's first reply. A kind TS adds there and
// Go misses makes run timing (firstResponseAt, and every read built on it) differ silently: no
// error, just a row whose first response is later than TypeScript's.
func TestResponseBlockKindsMatchTypeScript(t *testing.T) {
	root, err := tsunions.Root()
	if err != nil {
		t.Fatal(err)
	}
	file, err := tsunions.Open(root, "packages/db/src/runs/run-timing.ts")
	if err != nil {
		t.Fatal(err)
	}
	kinds, err := file.Strings("RESPONSE_BLOCK_KINDS")
	if err != nil {
		t.Fatal(err)
	}
	if err := tsunions.SetDiff("events.responseBlockKinds", tsunions.Keys(responseBlockKinds), kinds); err != nil {
		t.Fatalf("%v\n(RESPONSE_BLOCK_KINDS is packages/db/src/runs/run-timing.ts)", err)
	}
}
