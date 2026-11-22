package messageblocks

import (
	"bytes"
	"encoding/json"
	"math"
	"slices"
	"strconv"

	"golang.org/x/text/cases"
	"golang.org/x/text/language"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/validate"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/wtf8"
)

// This file is MessageBlock (packages/contracts/src/threads/message-blocks.ts) as the router
// applies it to an output: zod's parse result, not the stored value. An object keeps only the keys
// its schema names (z.object strips the rest), a missing key with a default gets it, and any value
// outside the schema fails the whole call ("Output validation failed").
//
// Every MessageBlock variant, including the nested credential, oneTimeCode and
// import_setup schemas, is decided here (see secrets.go and importsetup.go).

// JSLower is String.prototype.toLowerCase (the Unicode default mapping, not strings.ToLower).
var JSLower = cases.Lower(language.Und)

// parser is one zod schema: the cleaned value and whether the input satisfied it.
type parser func(any) (any, bool)

type field struct {
	name     string
	parse    parser
	optional bool
	// def is the .default() value, used when the key is absent.
	def    any
	hasDef bool
}

func required(name string, parse parser) field { return field{name: name, parse: parse} }
func optional(name string, parse parser) field {
	return field{name: name, parse: parse, optional: true}
}

func object(fields ...field) parser {
	return func(value any) (any, bool) {
		input, ok := value.(map[string]any)
		if !ok {
			return nil, false
		}
		out := make(map[string]any, len(fields))
		for _, f := range fields {
			raw, present := input[f.name]
			if !present {
				switch {
				case f.hasDef:
					out[f.name] = f.def
				case f.optional:
				default:
					return nil, false
				}
				continue
			}
			cleaned, ok := f.parse(raw)
			if !ok {
				return nil, false
			}
			out[f.name] = cleaned
		}
		return out, true
	}
}

func str(value any) (any, bool) {
	text, ok := value.(string)
	return text, ok
}

// strMax is z.string().max(n): zod counts code points.
func strMax(limit int) parser {
	return func(value any) (any, bool) {
		text, ok := value.(string)
		return text, ok && wtf8.Length(text) <= limit
	}
}

// id is Id: a non-empty string.
func id(value any) (any, bool) {
	text, ok := value.(string)
	return text, ok && text != ""
}

func boolean(value any) (any, bool) {
	flag, ok := value.(bool)
	return flag, ok
}

func literal(want any) parser {
	return func(value any) (any, bool) { return value, value == want }
}

func enum(values ...string) parser {
	return func(value any) (any, bool) {
		text, ok := value.(string)
		return text, ok && slices.Contains(values, text)
	}
}

func nullable(inner parser) parser {
	return func(value any) (any, bool) {
		if value == nil {
			return nil, true
		}
		return inner(value)
	}
}

func array(inner parser) parser {
	return func(value any) (any, bool) {
		items, ok := value.([]any)
		if !ok {
			return nil, false
		}
		out := make([]any, len(items))
		for index, item := range items {
			cleaned, ok := inner(item)
			if !ok {
				return nil, false
			}
			out[index] = cleaned
		}
		return out, true
	}
}

// integer is z.number().int() with an optional lower bound: nonnegative (min 0) or positive (gt 0).
func integer(rules validate.NumberRules) parser {
	return func(value any) (any, bool) {
		if _, issues := validate.Integer(nil, value, rules); issues != nil {
			return nil, false
		}
		return value, true
	}
}

var (
	nonNegative = integer(validate.NumberRules{Min: validate.Float(0)})
	positive    = integer(validate.NumberRules{Gt: validate.Float(0)})
)

func nonNegativeFloat(value any) (any, bool) {
	number, ok := value.(json.Number)
	if !ok {
		return nil, false
	}
	parsed, err := strconv.ParseFloat(number.String(), 64)
	if err != nil || math.IsNaN(parsed) || math.IsInf(parsed, 0) || parsed < 0 {
		return nil, false
	}
	return number, true
}

// anyValue is z.any(): the stored value as it is.
func anyValue(value any) (any, bool) { return value, true }

// record is z.record(z.string(), z.any()).
func record(value any) (any, bool) {
	input, ok := value.(map[string]any)
	if !ok {
		return nil, false
	}
	return input, true
}

// trimmedMinMax is z.string().trim().min(1).max(limit): the trimmed text is the output.
func trimmedMinMax(limit int) parser {
	return func(value any) (any, bool) {
		text, issues := validate.String(nil, value, validate.StringRules{Trim: true, Min: 1, Max: limit})
		if issues != nil {
			return nil, false
		}
		return text, true
	}
}

var thinkingLevels = []string{"off", "minimal", "low", "medium", "high", "xhigh", "max"}

// botSettingsValues is BotSettingsValuesSchema.
var botSettingsValues = object(
	optional("modelProvider", nullable(trimmedMinMax(80))),
	optional("modelId", nullable(trimmedMinMax(200))),
	optional("thinkingLevel", nullable(enum(thinkingLevels...))),
	optional("autoSpeak", boolean),
	optional("voiceId", nullable(strMax(120))),
)

// askReceipt is AskReceipt.
var askReceipt = object(
	optional("button", strMax(200)),
	required("items", func(value any) (any, bool) {
		cleaned, ok := array(object(required("name", strMax(200)), required("amount", strMax(100))))(value)
		return cleaned, ok && len(cleaned.([]any)) <= 30
	}),
	optional("more", object(required("count", positive), required("atLeast", boolean))),
	optional("amount", strMax(100)),
	required("amountSource", enum("button", "page")),
	optional("total", strMax(100)),
)

// loginFieldLabels is LoginFieldLabels: 1 to 8 labels, each trimmed 1 to 64, unique ignoring case.
func loginFieldLabels(value any) (any, bool) {
	cleaned, ok := array(trimmedMinMax(64))(value)
	if !ok {
		return nil, false
	}
	labels := cleaned.([]any)
	if len(labels) < 1 || len(labels) > 8 {
		return nil, false
	}
	seen := map[string]bool{}
	for _, label := range labels {
		key := JSLower.String(label.(string))
		if seen[key] {
			return nil, false
		}
		seen[key] = true
	}
	return cleaned, true
}

func askBlock(value any) (any, bool) {
	return object(
		required("text", str),
		optional("approvalEffectId", id),
		optional("credential", credentialDestination),
		optional("oneTimeCode", oneTimeCodeTarget),
		optional("instructionUpdate", object(
			required("botId", id), required("before", str), required("after", str), required("reason", str),
			optional("undoVersionId", id),
		)),
		optional("settingsUpdate", object(
			required("botId", id), required("before", botSettingsValues), required("after", botSettingsValues),
		)),
		optional("detail", str),
		optional("detailFormat", enum("text", "code")),
		optional("receipt", askReceipt),
		optional("input", enum("text", "secret")),
		optional("purpose", enum("otp", "password", "api_key")),
		optional("replaces", object(required("id", strMax(64)), required("origin", strMax(2048)))),
		optional("loginFields", loginFieldLabels),
		optional("sharedBrowser", literal(true)),
		optional("site", str),
		optional("status", enum("pending", "answered")),
		optional("answer", str),
		optional("answerMessageId", str),
		optional("dismissed", literal(true)),
		optional("remembered", literal(false)),
		optional("actions", array(object(
			required("id", str), required("label", str),
			optional("outcome", enum("created", "cancelled")),
			optional("recommended", boolean),
		))),
	)(value)
}

const maxChartDataRows = 5000

// chartBlock is ChartBlock: rows in `data` plus the rows embedded in the spec stay under the limit.
func chartBlock(value any) (any, bool) {
	cleaned, ok := object(
		required("name", str),
		required("spec", record),
		required("data", func(data any) (any, bool) {
			items, ok := data.([]any)
			return items, ok && len(items) <= maxChartDataRows
		}),
	)(value)
	if !ok {
		return nil, false
	}
	block := cleaned.(map[string]any)
	rows := len(block["data"].([]any))
	spec := block["spec"].(map[string]any)
	if items, ok := spec["data"].([]any); ok {
		rows += len(items)
	}
	if marks, ok := spec["marks"].([]any); ok {
		for _, mark := range marks {
			if markObject, ok := mark.(map[string]any); ok {
				if items, ok := markObject["data"].([]any); ok {
					rows += len(items)
				}
			}
		}
	}
	return block, rows <= maxChartDataRows
}

var intents = []string{"request", "result", "question", "status", "fyi"}

var step = object(
	required("label", str),
	required("count", positive),
	optional("detail", str),
	optional("note", str),
	optional("durationMs", nonNegative),
	optional("startedAtMs", nonNegative),
	optional("attempt", positive),
	optional("forkedFromStep", nonNegative),
	optional("status", enum("running", "done", "failed", "stopped")),
	optional("outcomes", object(
		optional("succeeded", positive), optional("failed", positive), optional("stopped", positive),
	)),
)

var domains = func(value any) (any, bool) {
	cleaned, ok := array(strMax(256))(value)
	return cleaned, ok && len(cleaned.([]any)) <= 32
}

// blockSchemas is the MessageBlock union by kind. Each object lists `kind` first and the
// other keys in the schema's order.
var blockSchemas = map[string]parser{
	"text": object(required("kind", literal("text")), required("text", str)),
	"card": object(required("kind", literal("card")), required("lines", array(object(required("k", str), required("v", str))))),
	"ask":  withKind("ask", askBlock),
	"choice": object(required("kind", literal("choice")), required("question", str), optional("subtitle", str),
		required("options", array(object(required("id", str), required("letter", str), required("label", str)))),
		optional("answerId", str)),
	"app_connect": object(required("kind", literal("app_connect")), optional("connectorId", str),
		required("provider", str), required("name", str), required("description", str),
		required("logo", nullable(str)), required("status", enum("pending", "connected"))),
	"connect": object(required("kind", literal("connect")), required("name", str), required("initial", str),
		required("color", str), required("status", enum("pending", "connected"))),
	"computer": object(required("kind", literal("computer")), required("state", str), required("text", str)),
	"voice_call": object(required("kind", literal("voice_call")), optional("callId", str), required("title", str),
		required("farewell", str), optional("durationSeconds", nonNegative)),
	"call_request": object(required("kind", literal("call_request")), required("callId", str), required("reason", str),
		required("opening", str), required("status", enum("ringing", "answered", "declined", "missed")),
		required("expiresAt", str), optional("durationSeconds", nonNegative)),
	"meta": object(required("kind", literal("meta")), required("text", str)),
	"routine_event": object(required("kind", literal("routine_event")),
		required("change", enum("created", "updated", "enabled", "disabled", "deleted")), required("name", strMax(200))),
	"delivery": object(required("kind", literal("delivery"))),
	"progress": object(required("kind", literal("progress")), required("text", str), optional("activity", literal(true)),
		optional("pendingToolNames", array(str)), optional("pendingToolDetails", array(nullable(str))),
		optional("pendingToolTimings", array(nullable(object(
			optional("startedAtMs", nonNegative), optional("attempt", positive), optional("forkedFromStep", nonNegative),
		))))),
	"thinking": object(required("kind", literal("thinking")), required("durationMs", nonNegative), required("lines", array(str))),
	"steps": object(required("kind", literal("steps")), required("steps", array(step)), optional("durationMs", nonNegative),
		optional("costUsd", nonNegativeFloat), optional("modelId", str), optional("modelProvider", str),
		optional("attempts", positive), optional("status", enum("completed", "stopped", "failed"))),
	"subagent": object(required("kind", literal("subagent")), required("agentId", str), required("name", str),
		required("task", str), required("status", enum("running", "completed", "failed")),
		optional("progress", str), optional("result", str)),
	"child_bot": object(required("kind", literal("child_bot")), required("botId", str), required("name", str),
		required("status", enum("created", "archived", "deleted"))),
	"cloud_agent": object(required("kind", literal("cloud_agent")), required("agentId", str), required("title", str),
		required("status", enum("running", "finished", "failed", "cancelled", "expired")), required("url", str),
		optional("branch", str), optional("prUrl", str), optional("latestRunId", str)),
	"skill_draft": object(required("kind", literal("skill_draft")), required("skillId", id), required("name", str),
		required("goal", str),
		required("playbook", object(required("whenToUse", str), required("inputs", array(str)),
			required("steps", array(str)), required("howToCheck", str), required("whatToReturn", str),
			required("approvalBoundaries", str), required("failureHandling", str))),
		required("status", enum("draft", "saved"))),
	"chart": withKind("chart", chartBlock),
	"mcp_approval": withDefault(object(required("kind", literal("mcp_approval")), required("name", str),
		required("serverId", id), required("transport", enum("streamable_http", "sse", "stdio")),
		required("endpoint", nullable(str)), required("needsOAuth", boolean),
		field{name: "status", parse: enum("pending", "connected", "dismissed"), def: "pending", hasDef: true})),
	"import_setup": importSetup,
	"image": object(required("kind", literal("image")), optional("imageHandling", literal("confirm")),
		required("artifactId", id), required("mimeType", str), required("name", str)),
	"file": object(required("kind", literal("file")), required("artifactId", id), required("mimeType", str),
		required("name", str), required("size", nonNegative)),
	"app": object(required("kind", literal("app")), required("artifactId", id), required("server", strMax(200)),
		required("tool", strMax(200)), required("toolArguments", record), required("toolResult", record),
		optional("csp", object(optional("connectDomains", domains), optional("resourceDomains", domains))),
		optional("prefersBorder", boolean)),
	"page": object(required("kind", literal("page")), required("pageId", id), required("version", positive),
		required("title", strMax(200))),
	"handoff": object(required("kind", literal("handoff")), required("fromBotId", id), required("toBotId", id),
		required("text", str), optional("hop", positive)),
	"channel_message": object(required("kind", literal("channel_message")), required("provider", str),
		optional("transport", str), required("channelId", id), required("fromAddress", str),
		required("fromLabel", str), required("text", str), optional("hop", nonNegative)),
	"bot_message_sent": object(required("kind", literal("bot_message_sent")), required("toBotId", id),
		required("toBotName", str), required("text", str), optional("intent", enum(intents...))),
	"agent_message_received": object(required("kind", literal("agent_message_received")),
		required("agentName", strMax(80)), required("text", str)),
	"bot_message_received": object(required("kind", literal("bot_message_received")), required("fromBotId", id),
		required("fromBotName", str), required("text", str), optional("intent", enum(intents...)),
		optional("returnToMessageId", id), optional("hop", nonNegative)),
}

// withKind adds the discriminator to a block parser that builds its own object.
func withKind(kind string, inner parser) parser {
	return func(value any) (any, bool) {
		cleaned, ok := inner(value)
		if !ok {
			return nil, false
		}
		if block, isMap := cleaned.(map[string]any); isMap {
			block["kind"] = kind
		}
		return cleaned, true
	}
}

func withDefault(inner parser) parser { return inner }

// parseBlock is MessageBlock.parse of one stored entry.
func parseBlock(value any) (any, bool) {
	input, ok := value.(map[string]any)
	if !ok {
		return nil, false
	}
	kind, _ := input["kind"].(string)
	schema, known := blockSchemas[kind]
	if !known {
		return nil, false
	}
	return schema(input)
}

// ParseBlocks is MessageBlock.array().parse: every entry must be a valid block. The
// caller decides what an invalid list means (the cancel path drops the whole list).
func ParseBlocks(entries []any) (blocks []any, valid bool) {
	out := make([]any, len(entries))
	for index, entry := range entries {
		cleaned, ok := parseBlock(entry)
		if !ok {
			return nil, false
		}
		out[index] = cleaned
	}
	return out, true
}

// StoredBlocks is storedMessageBlocks: the entries of a stored list that are objects naming
// their kind, in order. A value that is not a list reads as no blocks.
func StoredBlocks(value any) []any {
	items, ok := value.([]any)
	if !ok {
		return []any{}
	}
	kept := make([]any, 0, len(items))
	for _, item := range items {
		if block, ok := item.(map[string]any); ok {
			if _, named := block["kind"].(string); named {
				kept = append(kept, block)
			}
		}
	}
	return kept
}

// DecodeJSON reads a jsonb value with numbers kept as json.Number, the form the content
// decryption and validate.Integer expect.
func DecodeJSON(raw []byte) (any, error) {
	if len(raw) == 0 {
		return nil, nil
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		return nil, err
	}
	return value, nil
}
