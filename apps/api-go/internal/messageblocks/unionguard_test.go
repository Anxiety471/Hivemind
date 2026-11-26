package messageblocks

import (
	"testing"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/tsunions"
)

// TestBlockSchemasMatchTypeScriptKinds guards MessageBlock: every kind TypeScript's discriminated
// union declares must be in blockSchemas, and blockSchemas may declare nothing else.
//
// This is the check whose absence let production break: packages/contracts/src/threads/
// message-blocks.ts gained the `job` card (fe86e0fcd), a thread carried one, and threads.get
// answered 500 "Output validation failed" from threads/messages.go's ParseBlocks because this map
// did not know the kind. A new variant — inline, or behind a referenced schema such as
// ToolCardSchema — fails here with the exact name, before a deploy.
func TestBlockSchemasMatchTypeScriptKinds(t *testing.T) {
	root, err := tsunions.Root()
	if err != nil {
		t.Fatal(err)
	}
	file, err := tsunions.Open(root, "packages/contracts/src/threads/message-blocks.ts")
	if err != nil {
		t.Fatal(err)
	}
	kinds, err := file.Union("MessageBlock", "kind")
	if err != nil {
		t.Fatal(err)
	}
	if err := tsunions.SetDiff("messageblocks.blockSchemas", tsunions.Keys(blockSchemas), kinds); err != nil {
		t.Fatalf("%v\n(MessageBlock is packages/contracts/src/threads/message-blocks.ts)", err)
	}
}

// TestNestedUnionsMatchTypeScriptKinds guards the discriminated unions a block carries. They are
// validated by the same ParseBlocks, so a variant TS adds there is the same 500 this guard exists
// to prevent; the tables are what the parsers read, not a copy of them.
func TestNestedUnionsMatchTypeScriptKinds(t *testing.T) {
	root, err := tsunions.Root()
	if err != nil {
		t.Fatal(err)
	}
	tests := []struct {
		table       string
		file        string
		union       string
		discriminer string
		goNames     []string
	}{
		{
			table: "messageblocks.importNeeds", file: "packages/contracts/src/integrations/agent-import-setup.ts",
			union: "AgentImportNeedSchema", discriminer: "kind", goNames: tsunions.Keys(importNeeds),
		},
		{
			table: "messageblocks.importItems", file: "packages/contracts/src/integrations/agent-import-setup.ts",
			union: "AgentImportSetupItemSchema", discriminer: "kind", goNames: tsunions.Keys(importItems),
		},
		{
			table: "messageblocks.botSecretAuths", file: "packages/contracts/src/bots/bot-secrets.ts",
			union: "BotSecretAuth", discriminer: "type", goNames: tsunions.Keys(botSecretAuths),
		},
	}
	for _, test := range tests {
		t.Run(test.union, func(t *testing.T) {
			file, err := tsunions.Open(root, test.file)
			if err != nil {
				t.Fatal(err)
			}
			kinds, err := file.Union(test.union, test.discriminer)
			if err != nil {
				t.Fatal(err)
			}
			if err := tsunions.SetDiff(test.table, test.goNames, kinds); err != nil {
				t.Fatalf("%v\n(%s is %s)", err, test.union, test.file)
			}
		})
	}
}

// TestMcpTransportsMatchTypeScript guards McpTransportSchema, which mcp_approval validates on
// output. A transport TS adds would fail Go's parse of every card naming it.
func TestMcpTransportsMatchTypeScript(t *testing.T) {
	root, err := tsunions.Root()
	if err != nil {
		t.Fatal(err)
	}
	file, err := tsunions.Open(root, "packages/contracts/src/integrations/mcp.ts")
	if err != nil {
		t.Fatal(err)
	}
	values, err := file.Strings("McpTransportSchema")
	if err != nil {
		t.Fatal(err)
	}
	if err := tsunions.SetDiff("messageblocks.mcpTransports", mcpTransports, values); err != nil {
		t.Fatalf("%v\n(McpTransportSchema is packages/contracts/src/integrations/mcp.ts)", err)
	}
}

// TestIntentsMatchTypeScript guards `intents`, BotMessageIntent (packages/contracts/src/threads/
// message-blocks.ts:13): an intent added there and missed here fails every message carrying it.
func TestIntentsMatchTypeScript(t *testing.T) {
	root, err := tsunions.Root()
	if err != nil {
		t.Fatal(err)
	}
	file, err := tsunions.Open(root, "packages/contracts/src/threads/message-blocks.ts")
	if err != nil {
		t.Fatal(err)
	}
	intentNames, err := file.Strings("BotMessageIntent")
	if err != nil {
		t.Fatal(err)
	}
	if err := tsunions.SetDiff("messageblocks.intents", intents, intentNames); err != nil {
		t.Fatalf("%v\n(BotMessageIntent is packages/contracts/src/threads/message-blocks.ts)", err)
	}
}

// TestJobCardMatchesTypeScript guards the card's own enum and string caps. blockSchemas' keys pin
// the kind; these pin what a card of that kind must satisfy — a seventh state or a raised reply cap
// in TS is the same 500 this branch fixes.
func TestJobCardMatchesTypeScript(t *testing.T) {
	root, err := tsunions.Root()
	if err != nil {
		t.Fatal(err)
	}
	const card = "packages/contracts/src/integrations/tool-card.ts"
	states, err := tsunions.Values(root, card, "JobCardStateSchema")
	if err != nil {
		t.Fatal(err)
	}
	if err := tsunions.SetDiff("messageblocks.jobStates", jobStates, states); err != nil {
		t.Fatalf("%v\n(JobCardStateSchema is %s)", err, card)
	}
	file, err := tsunions.Open(root, card)
	if err != nil {
		t.Fatal(err)
	}
	fields := tsunions.Keys(jobCaps)
	caps, err := file.FieldCaps("ToolCardSchema", fields)
	if err != nil {
		t.Fatal(err)
	}
	for _, field := range fields {
		if caps[field] != jobCaps[field] {
			t.Errorf("messageblocks.jobCaps[%q] = %d, ToolCardSchema caps it at %d (%s)",
				field, jobCaps[field], caps[field], card)
		}
	}
}

// TestThinkingLevelsMatchTypeScript guards ThinkingLevelSchema, copied in five packages.
func TestThinkingLevelsMatchTypeScript(t *testing.T) {
	root, err := tsunions.Root()
	if err != nil {
		t.Fatal(err)
	}
	levels, err := tsunions.Values(root, "packages/contracts/src/ids.ts", "ThinkingLevelSchema")
	if err != nil {
		t.Fatal(err)
	}
	if err := tsunions.SetDiff("messageblocks.thinkingLevels", thinkingLevels, levels); err != nil {
		t.Fatalf("%v\n(ThinkingLevelSchema is packages/contracts/src/ids.ts)", err)
	}
}
