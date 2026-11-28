package gentables

import (
	"testing"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/tsunions"
)

// TestThinkingOrdersMatchTypeScript guards the level list the generator filters pi-ai's provider
// data over: a level TS adds and this list misses silently drops it from every generated table.
func TestThinkingOrdersMatchTypeScript(t *testing.T) {
	root, err := tsunions.Root()
	if err != nil {
		t.Fatal(err)
	}
	levels, err := tsunions.Values(root, "packages/contracts/src/ids.ts", "ThinkingLevelSchema")
	if err != nil {
		t.Fatal(err)
	}
	if err := tsunions.SetDiff("gentables.thinkingOrders", thinkingOrders, levels); err != nil {
		t.Fatalf("%v\n(ThinkingLevelSchema is packages/contracts/src/ids.ts)", err)
	}
}
