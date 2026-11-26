package bots

import (
	"testing"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/tsunions"
)

// TestThinkingLevelsMatchTypeScript guards the thinking level bots.list validates a bot against.
func TestThinkingLevelsMatchTypeScript(t *testing.T) {
	root, err := tsunions.Root()
	if err != nil {
		t.Fatal(err)
	}
	levels, err := tsunions.Values(root, "packages/contracts/src/ids.ts", "ThinkingLevelSchema")
	if err != nil {
		t.Fatal(err)
	}
	if err := tsunions.SetDiff("bots.thinkingLevels", tsunions.Keys(thinkingLevels), levels); err != nil {
		t.Fatalf("%v\n(ThinkingLevelSchema is packages/contracts/src/ids.ts)", err)
	}
}
