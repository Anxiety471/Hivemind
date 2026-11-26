package models

import (
	"testing"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/tsunions"
)

// TestThinkingLevelsMatchTypeScript guards the thinking level models reads validate.
func TestThinkingLevelsMatchTypeScript(t *testing.T) {
	root, err := tsunions.Root()
	if err != nil {
		t.Fatal(err)
	}
	levels, err := tsunions.Values(root, "packages/contracts/src/ids.ts", "ThinkingLevelSchema")
	if err != nil {
		t.Fatal(err)
	}
	if err := tsunions.SetDiff("models.thinkingLevels", thinkingLevels, levels); err != nil {
		t.Fatalf("%v\n(ThinkingLevelSchema is packages/contracts/src/ids.ts)", err)
	}
}
