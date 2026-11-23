package messageblocks

// import_setup and AgentImportSetupItemSchema are ported from
// packages/contracts/src/integrations/agent-import-setup.ts:3-15,43-60 and
// packages/contracts/src/threads/message-blocks.ts:336-342. Every item and need is a
// discriminated union on `kind`; z.object strips unknown keys.

func importNeed(value any) (any, bool) {
	objectValue, ok := value.(map[string]any)
	if !ok {
		return nil, false
	}
	kind, _ := objectValue["kind"].(string)
	switch kind {
	case "api_key":
		return object(required("kind", literal("api_key")), required("provider", str))(value)
	case "credentials":
		return object(required("kind", literal("credentials")), required("names", array(str)))(value)
	case "env":
		return object(required("kind", literal("env")), required("names", array(str)))(value)
	case "program":
		return object(required("kind", literal("program")), required("name", str))(value)
	case "local_paths", "turn_on", "bundled_files":
		return object(required("kind", literal(kind)))(value)
	case "requires":
		return object(required("kind", literal("requires")), required("names", array(str)))(value)
	default:
		return nil, false
	}
}

func importItem(value any) (any, bool) {
	objectValue, ok := value.(map[string]any)
	if !ok {
		return nil, false
	}
	kind, _ := objectValue["kind"].(string)
	switch kind {
	case "model":
		return object(
			required("kind", literal("model")),
			required("title", str),
			required("provider", str),
			optional("providerName", str),
		)(value)
	case "mcp":
		return object(
			required("kind", literal("mcp")),
			required("serverId", str),
			required("name", str),
			required("needs", array(importNeed)),
		)(value)
	case "routine":
		return object(required("kind", literal("routine")), required("routineId", str), required("name", str))(value)
	case "skill":
		return object(required("kind", literal("skill")), required("name", str), required("needs", array(importNeed)))(value)
	default:
		return nil, false
	}
}

var importSetup = object(
	required("kind", literal("import_setup")),
	required("items", array(importItem)),
	optional("undone", boolean),
)
