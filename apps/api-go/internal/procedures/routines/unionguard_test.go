package routines

import (
	"testing"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/tsunions"
)

// TestRunTablesMatchTypeScript guards routines.history's status filter and routines.list's
// thinking level, both output-validated copies of contract enums.
func TestRunTablesMatchTypeScript(t *testing.T) {
	root, err := tsunions.Root()
	if err != nil {
		t.Fatal(err)
	}
	statuses, err := tsunions.Values(root, "packages/contracts/src/ids.ts", "RunStatus")
	if err != nil {
		t.Fatal(err)
	}
	if err := tsunions.SetDiff("routines.runStatuses", runStatuses, statuses); err != nil {
		t.Fatalf("%v\n(RunStatus is packages/contracts/src/ids.ts)", err)
	}
	levels, err := tsunions.Values(root, "packages/contracts/src/ids.ts", "ThinkingLevelSchema")
	if err != nil {
		t.Fatal(err)
	}
	if err := tsunions.SetDiff("routines.thinkingLevels", thinkingLevels, levels); err != nil {
		t.Fatalf("%v\n(ThinkingLevelSchema is packages/contracts/src/ids.ts)", err)
	}
}
