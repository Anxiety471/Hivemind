package runs

import (
	"testing"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/tsunions"
)

// TestRunTablesMatchTypeScript guards every TypeScript table runs.list validates a row against: a
// status, trigger, intent or agent-message kind TS adds and Go misses fails the whole list with
// "Output validation failed".
func TestRunTablesMatchTypeScript(t *testing.T) {
	root, err := tsunions.Root()
	if err != nil {
		t.Fatal(err)
	}
	statuses, err := tsunions.Values(root, "packages/contracts/src/ids.ts", "RunStatus")
	if err != nil {
		t.Fatal(err)
	}
	if err := tsunions.SetDiff("runs.runStatuses", tsunions.Keys(runStatuses), statuses); err != nil {
		t.Fatalf("%v\n(RunStatus is packages/contracts/src/ids.ts)", err)
	}
	triggers, err := tsunions.Values(root, "packages/contracts/src/runs/runs.ts", "RUN_TRIGGERS")
	if err != nil {
		t.Fatal(err)
	}
	if err := tsunions.SetDiff("runs.runTriggers", tsunions.Keys(runTriggers), triggers); err != nil {
		t.Fatalf("%v\n(RUN_TRIGGERS is packages/contracts/src/runs/runs.ts)", err)
	}
	intentNames, err := tsunions.Values(root, "packages/contracts/src/threads/message-blocks.ts", "BotMessageIntent")
	if err != nil {
		t.Fatal(err)
	}
	if err := tsunions.SetDiff("runs.intents", tsunions.Keys(intents), intentNames); err != nil {
		t.Fatalf("%v\n(BotMessageIntent is packages/contracts/src/threads/message-blocks.ts)", err)
	}
	const schema = "packages/contracts/src/runs/runs.ts"
	file, err := tsunions.Open(root, schema)
	if err != nil {
		t.Fatal(err)
	}
	agentKinds, err := file.FieldUnion("RunActivityRowSchema", "agentMessage", "kind")
	if err != nil {
		t.Fatal(err)
	}
	if err := tsunions.SetDiff("runs.agentMessageKinds", tsunions.Keys(agentMessageKinds), agentKinds); err != nil {
		t.Fatalf("%v\n(RunActivityRowSchema.agentMessage is %s)", err, schema)
	}
}
