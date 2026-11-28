package messageblocks

// import_setup and AgentImportSetupItemSchema are ported from
// packages/contracts/src/integrations/agent-import-setup.ts:3-15,43-60 and
// packages/contracts/src/threads/message-blocks.ts:336-342. Every item and need is a
// discriminated union on `kind`; z.object strips unknown keys.

// importNeeds is AgentImportNeedSchema (agent-import-setup.ts:3-15): one thing an import needs
// before it works.
var importNeeds = map[string]parser{
	"api_key":     object(required("kind", literal("api_key")), required("provider", str)),
	"credentials": object(required("kind", literal("credentials")), required("names", array(str))),
	"env":         object(required("kind", literal("env")), required("names", array(str))),
	"program":     object(required("kind", literal("program")), required("name", str)),
	"local_paths": object(required("kind", literal("local_paths"))),
	"requires":    object(required("kind", literal("requires")), required("names", array(str))),
	"turn_on":     object(required("kind", literal("turn_on"))),
	"bundled_files": object(
		required("kind", literal("bundled_files")),
	),
}

// importItems is AgentImportSetupItemSchema (agent-import-setup.ts:43-60): one row of the
// checklist an agent import shows.
var importItems = map[string]parser{
	"model": object(
		required("kind", literal("model")),
		required("title", str),
		required("provider", str),
		optional("providerName", str),
	),
	"mcp": object(
		required("kind", literal("mcp")),
		required("serverId", str),
		required("name", str),
		required("needs", array(importNeed)),
	),
	"routine": object(required("kind", literal("routine")), required("routineId", str), required("name", str)),
	"skill":   object(required("kind", literal("skill")), required("name", str), required("needs", array(importNeed))),
}

func importNeed(value any) (any, bool) {
	return discriminated(value, "kind", importNeeds)
}

func importItem(value any) (any, bool) {
	return discriminated(value, "kind", importItems)
}

var importSetup = object(
	required("kind", literal("import_setup")),
	required("items", array(importItem)),
	optional("undone", boolean),
)
