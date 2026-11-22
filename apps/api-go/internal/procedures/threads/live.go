package threads

import (
	"encoding/json"
	"math"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf16"

	"golang.org/x/text/cases"
	"golang.org/x/text/language"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/shared"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/validate"
)

// This file is projectMessages (packages/core/src/messages/events.ts) for the events threads.get
// reads: the live progress, thinking, tool, subagent and pause events of the thread's active
// runs. The query never selects message, cleared or cloud-agent events, so those branches of
// the projection cannot run and are not ported.

// liveEvent is one stored event of an active run, its payload opened.
type liveEvent struct {
	ID        string
	ThreadID  string
	BotID     string
	Seq       int32
	Type      string
	Payload   map[string]any
	RunID     *string
	CreatedAt time.Time
}

// liveMessage is a projected ThreadMessage: only the keys a projection sets.
type liveMessage struct {
	ID        string
	ThreadID  string
	Seq       int32
	BotID     string
	RunID     string
	CreatedAt string
	Blocks    []map[string]any
}

type liveProjection struct {
	blocks []map[string]any
	meta   liveMessage
}

func stopsRunHelpers(eventType string) bool {
	switch eventType {
	case "run.completed", "run.failed", "run.cancelled", "run.waiting_input", "computer.takeover.requested":
		return true
	}
	return false
}

func progressMessageID(event liveEvent) string {
	if event.RunID != nil {
		return "progress:" + *event.RunID
	}
	return "progress:" + event.ID
}

// settleRunSubagents marks the run's still-running subagent blocks as stopped.
func settleRunSubagents(messages []liveMessage, runID string) []liveMessage {
	if runID == "" {
		return messages
	}
	next := make([]liveMessage, len(messages))
	for index, message := range messages {
		next[index] = message
		if message.RunID != runID {
			continue
		}
		blocks := make([]map[string]any, len(message.Blocks))
		for position, block := range message.Blocks {
			blocks[position] = block
			if block["kind"] == "subagent" && block["status"] == "running" {
				settled := make(map[string]any, len(block)+1)
				for key, value := range block {
					settled[key] = value
				}
				settled["status"] = "failed"
				settled["result"] = "stopped"
				blocks[position] = settled
			}
		}
		next[index].Blocks = blocks
	}
	return next
}

// projectLive is projectMessages(events, runs): runs maps each active run to its status.
func projectLive(events []liveEvent, runs map[string]string) []liveMessage {
	live := map[string]*liveProjection{}
	liveOrder := []string{}
	touch := func(event liveEvent, createdAt string) *liveProjection {
		id := progressMessageID(event)
		if existing, ok := live[id]; ok {
			return existing
		}
		projection := &liveProjection{meta: liveMessage{
			ID: id, ThreadID: event.ThreadID, Seq: event.Seq, BotID: event.BotID, CreatedAt: createdAt,
		}}
		if event.RunID != nil {
			projection.meta.RunID = *event.RunID
		}
		live[id] = projection
		liveOrder = append(liveOrder, id)
		return projection
	}
	drop := func(id string) {
		delete(live, id)
		for index, key := range liveOrder {
			if key == id {
				liveOrder = append(liveOrder[:index:index], liveOrder[index+1:]...)
				break
			}
		}
	}
	clearLive := func(event liveEvent) {
		if event.RunID != nil {
			drop(progressMessageID(event))
			return
		}
		live = map[string]*liveProjection{}
		liveOrder = nil
	}
	// A Map keeps a key's place when it is set again, and deleting moves it to the end.
	subagents := map[string]liveMessage{}
	subagentOrder := []string{}
	setSubagent := func(agentID string, message liveMessage) {
		if _, ok := subagents[agentID]; !ok {
			subagentOrder = append(subagentOrder, agentID)
		}
		subagents[agentID] = message
	}
	subagentValues := func() []liveMessage {
		values := make([]liveMessage, 0, len(subagentOrder))
		for _, agentID := range subagentOrder {
			values = append(values, subagents[agentID])
		}
		return values
	}
	for _, event := range events {
		if stopsRunHelpers(event.Type) {
			runID := ""
			if event.RunID != nil {
				runID = *event.RunID
			}
			for _, message := range settleRunSubagents(subagentValues(), runID) {
				if len(message.Blocks) > 0 && message.Blocks[0]["kind"] == "subagent" {
					setSubagent(message.Blocks[0]["agentId"].(string), message)
				}
			}
		}
		createdAt := shared.ISO(event.CreatedAt)
		touchMeta := func(projection *liveProjection) {
			projection.meta.Seq = event.Seq
			projection.meta.BotID = event.BotID
			projection.meta.CreatedAt = createdAt
		}
		switch event.Type {
		case "thread.progress":
			projection := touch(event, createdAt)
			projection.blocks = reduceLive(projection.blocks, liveUpdate{kind: "progress", payload: event.Payload})
			touchMeta(projection)
		case "thread.thinking":
			projection := touch(event, createdAt)
			projection.blocks = reduceLive(projection.blocks, thinkingUpdate(event.Payload))
			touchMeta(projection)
		case "agent.tool.called":
			if jsString(event.Payload["name"]) == "ask_user" && isString(event.Payload["name"]) {
				continue
			}
			projection := touch(event, createdAt)
			detail := ""
			if text, ok := event.Payload["detail"].(string); ok && validate.JSTrim(text) != "" {
				detail = validate.JSTrim(text)
			}
			name := ""
			if event.Payload["name"] != nil {
				name = jsString(event.Payload["name"])
			}
			projection.blocks = reduceLive(projection.blocks, liveUpdate{kind: "tool", name: name, detail: detail})
			touchMeta(projection)
		case "thread.subagent":
			block := subagentBlock(event.Payload)
			message := liveMessage{
				ID: "subagent:" + block["agentId"].(string), ThreadID: event.ThreadID, Seq: event.Seq,
				BotID: event.BotID, CreatedAt: createdAt, Blocks: []map[string]any{block},
			}
			if event.RunID != nil {
				message.RunID = *event.RunID
			}
			setSubagent(block["agentId"].(string), message)
		default:
			if stopsRunHelpers(event.Type) {
				clearLive(event)
			}
		}
	}
	helpers := subagentValues()
	if runs != nil {
		order := []string{}
		visited := map[string]bool{}
		for _, helper := range subagentValues() {
			if !visited[helper.RunID] {
				visited[helper.RunID] = true
				order = append(order, helper.RunID)
			}
		}
		for _, runID := range order {
			if runID != "" && runs[runID] != "running" {
				helpers = settleRunSubagents(helpers, runID)
			}
		}
	}
	messages := append([]liveMessage{}, helpers...)
	for _, id := range liveOrder {
		projection := live[id]
		if len(projection.blocks) == 0 {
			continue
		}
		message := projection.meta
		message.Blocks = projection.blocks
		messages = append(messages, message)
	}
	return messages
}

type liveUpdate struct {
	kind    string // progress, tool or thinking
	payload map[string]any
	name    string
	detail  string
	segment int
	// durationMs and lines are a thinking update's.
	durationMs int
	lines      []string
}

// thinkingUpdate is thinkingLiveUpdate: tolerant of a partial producer.
func thinkingUpdate(payload map[string]any) liveUpdate {
	update := liveUpdate{kind: "thinking", segment: jsCount(payload["segment"]), durationMs: jsCount(payload["durationMs"])}
	if lines, ok := payload["lines"].([]any); ok {
		for _, line := range lines {
			if text, ok := line.(string); ok {
				update.lines = append(update.lines, text)
			}
		}
	}
	return update
}

// jsCount is the `count` helper of thinkingLiveUpdate: Math.trunc(Number(value ?? 0)), kept when
// finite and above zero.
func jsCount(value any) int {
	var number float64
	switch typed := value.(type) {
	case nil:
		return 0
	case json.Number:
		parsed, err := strconv.ParseFloat(typed.String(), 64)
		if err != nil {
			return 0
		}
		number = parsed
	case string:
		text := validate.JSTrim(typed)
		if text == "" {
			return 0
		}
		parsed, err := strconv.ParseFloat(text, 64)
		if err != nil {
			return 0
		}
		number = parsed
	case bool:
		if typed {
			number = 1
		}
	default:
		return 0
	}
	number = math.Trunc(number)
	if math.IsInf(number, 0) || math.IsNaN(number) || number <= 0 || number > math.MaxInt32 {
		return 0
	}
	return int(number)
}

func isString(value any) bool { _, ok := value.(string); return ok }

// jsString is String(value) for a decoded JSON value.
func jsString(value any) string {
	switch typed := value.(type) {
	case nil:
		return "null"
	case string:
		return typed
	case bool:
		return strconv.FormatBool(typed)
	case json.Number:
		return validate.Stringify(typed)
	case []any:
		parts := make([]string, len(typed))
		for index, item := range typed {
			if item != nil {
				parts[index] = jsString(item)
			}
		}
		return strings.Join(parts, ",")
	default:
		return "[object Object]"
	}
}

// jsTruthy is JavaScript truthiness of a decoded JSON value.
func jsTruthy(value any) bool {
	switch typed := value.(type) {
	case nil:
		return false
	case string:
		return typed != ""
	case bool:
		return typed
	case json.Number:
		parsed, err := strconv.ParseFloat(typed.String(), 64)
		return err != nil || (parsed != 0 && !math.IsNaN(parsed))
	default:
		return true
	}
}

// progressText is progressMessageText: a delta extends the text so far, anything else replaces it.
func progressText(payload map[string]any, previous string) string {
	if delta, ok := payload["delta"].(string); ok {
		return previous + delta
	}
	text := payload["text"]
	if text == nil {
		return ""
	}
	return jsString(text)
}

func subagentBlock(payload map[string]any) map[string]any {
	str := func(key string) string {
		if payload[key] == nil {
			return ""
		}
		return jsString(payload[key])
	}
	status := "running"
	if payload["status"] == "completed" || payload["status"] == "failed" {
		status = payload["status"].(string)
	}
	block := map[string]any{
		"kind": "subagent", "agentId": str("agentId"), "name": str("name"), "task": str("task"), "status": status,
	}
	if jsTruthy(payload["progress"]) {
		block["progress"] = jsString(payload["progress"])
	}
	if jsTruthy(payload["result"]) {
		block["result"] = jsString(payload["result"])
	}
	return block
}

func units(text string) []uint16 { return utf16.Encode([]rune(text)) }

func fromUnits(value []uint16) string { return string(utf16.Decode(value)) }

var (
	jsUpper = cases.Upper(language.Und)
	// \s as JavaScript reads it: the white space and line terminator characters.
	jsSpace     = `[\t\n\v\f\r \x{00a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]`
	sentenceEnd = regexp.MustCompile(`[.!?]["'”’)\]]*` + jsSpace + `*$`)
)

// endsSentence is endsSentence: empty text, or a sentence end followed only by closing marks and space.
func endsSentence(text string) bool {
	return validate.JSTrim(text) == "" || sentenceEnd.MatchString(text)
}

func humanizeToolName(name string) string {
	spaced := validate.JSTrim(strings.ReplaceAll(name, "_", " "))
	if spaced == "" {
		return name
	}
	lower := []rune(jsLower.String(spaced))
	return jsUpper.String(string(lower[:1])) + string(lower[1:])
}

func copyBlocks(blocks []map[string]any) []map[string]any {
	return append([]map[string]any{}, blocks...)
}

func appendTextSegment(segments []map[string]any, text string) []map[string]any {
	if text == "" {
		return copyBlocks(segments)
	}
	if len(segments) > 0 && segments[len(segments)-1]["kind"] == "text" {
		last := segments[len(segments)-1]
		out := copyBlocks(segments[:len(segments)-1])
		return append(out, map[string]any{"kind": "text", "text": last["text"].(string) + text})
	}
	return append(copyBlocks(segments), map[string]any{"kind": "text", "text": text})
}

// appendToolCallSegment is appendToolCallSegment + appendToolStep: a repeat of the newest step
// counts up, anything else adds a step.
func appendToolCallSegment(segments []map[string]any, toolName, detail string) []map[string]any {
	label := humanizeToolName(toolName)
	normalized := validate.JSTrim(detail)
	var prior []any
	var last map[string]any
	if len(segments) > 0 && segments[len(segments)-1]["kind"] == "steps" {
		last = segments[len(segments)-1]
		prior = last["steps"].([]any)
	}
	var steps []any
	if len(prior) > 0 {
		newest := prior[len(prior)-1].(map[string]any)
		newestDetail, _ := newest["detail"].(string)
		if newest["label"] == label && newestDetail == normalized {
			counted := make(map[string]any, len(newest))
			for key, value := range newest {
				counted[key] = value
			}
			counted["count"] = newest["count"].(int) + 1
			steps = append(append([]any{}, prior[:len(prior)-1]...), counted)
		}
	}
	if steps == nil {
		added := map[string]any{"label": label, "count": 1}
		if normalized != "" {
			added["detail"] = normalized
		}
		steps = append(append([]any{}, prior...), added)
	}
	block := map[string]any{"kind": "steps", "steps": steps}
	if last != nil {
		return append(copyBlocks(segments[:len(segments)-1]), block)
	}
	return append(copyBlocks(segments), block)
}

func liveText(blocks []map[string]any) string {
	var out strings.Builder
	for _, block := range blocks {
		if block["kind"] == "text" || block["kind"] == "progress" {
			out.WriteString(block["text"].(string))
		}
	}
	return out.String()
}

// reduceLive is reduceLiveMessageBlocks.
func reduceLive(current []map[string]any, update liveUpdate) []map[string]any {
	if update.kind == "thinking" {
		return upsertThinking(current, update)
	}
	blocks := current
	if update.kind == "progress" && update.payload["reset"] == true {
		var waiting map[string]any
		if len(current) > 0 && current[len(current)-1]["kind"] == "progress" {
			waiting = current[len(current)-1]
		}
		blocks = nil
		for _, block := range current {
			if block["kind"] != "text" && block["kind"] != "progress" {
				blocks = append(blocks, block)
			}
		}
		if waiting != nil {
			names, _ := waiting["pendingToolNames"].([]any)
			details, _ := waiting["pendingToolDetails"].([]any)
			for index, name := range names {
				detail := ""
				if index < len(details) {
					detail, _ = details[index].(string)
				}
				blocks = appendToolCallSegment(blocks, name.(string), detail)
			}
		}
	}
	var tail map[string]any
	if len(blocks) > 0 {
		tail = blocks[len(blocks)-1]
	}
	tailIsProgress := tail != nil && tail["kind"] == "progress"
	segments := blocks
	if tailIsProgress {
		segments = blocks[:len(blocks)-1]
	}
	prior := liveText(blocks)
	flushed := len(units(prior))
	if tailIsProgress {
		flushed -= len(units(tail["text"].(string)))
	}
	tailText := ""
	switch {
	case update.kind == "progress":
		full := units(progressText(update.payload, prior))
		if flushed < len(full) {
			tailText = fromUnits(full[flushed:])
		}
	case tailIsProgress:
		tailText = tail["text"].(string)
	}
	var names []any
	var details []any
	if tailIsProgress {
		names, _ = tail["pendingToolNames"].([]any)
		stored, _ := tail["pendingToolDetails"].([]any)
		for index := range names {
			if index < len(stored) && stored[index] != nil {
				details = append(details, stored[index])
			} else {
				details = append(details, nil)
			}
		}
	}
	names = append([]any{}, names...)
	if update.kind == "tool" {
		names = append(names, update.name)
		if trimmed := validate.JSTrim(update.detail); trimmed != "" {
			details = append(details, trimmed)
		} else {
			details = append(details, nil)
		}
	}
	activity := tailIsProgress && tail["activity"] == true
	if update.kind == "progress" {
		activity = update.payload["activity"] == true
	}
	if len(names) > 0 && endsSentence(tailText) {
		next := copyBlocks(segments)
		if !activity {
			next = appendTextSegment(segments, tailText)
		}
		for index, name := range names {
			detail, _ := details[index].(string)
			next = appendToolCallSegment(next, name.(string), detail)
		}
		return next
	}
	if tailText == "" {
		return copyBlocks(segments)
	}
	progress := map[string]any{"kind": "progress", "text": tailText}
	if activity {
		progress["activity"] = true
	}
	if len(names) > 0 {
		progress["pendingToolNames"] = names
	}
	for _, detail := range details {
		if text, _ := detail.(string); text != "" {
			progress["pendingToolDetails"] = details
			break
		}
	}
	return append(copyBlocks(segments), progress)
}

// upsertThinking replaces the thinking block of the update's segment, or adds one.
func upsertThinking(current []map[string]any, update liveUpdate) []map[string]any {
	lines := make([]any, len(update.lines))
	for index, line := range update.lines {
		lines[index] = line
	}
	block := map[string]any{"kind": "thinking", "durationMs": update.durationMs, "lines": lines}
	ordinal := -1
	replaced := false
	next := make([]map[string]any, len(current))
	for index, existing := range current {
		next[index] = existing
		if existing["kind"] != "thinking" {
			continue
		}
		ordinal++
		if ordinal == update.segment {
			replaced = true
			next[index] = block
		}
	}
	if !replaced {
		return append(next, block)
	}
	return next
}

// numberize turns the integers a projection builds into the json.Number the block schemas read.
func numberize(value any) any {
	switch typed := value.(type) {
	case int:
		return json.Number(strconv.Itoa(typed))
	case []any:
		out := make([]any, len(typed))
		for index, item := range typed {
			out[index] = numberize(item)
		}
		return out
	case map[string]any:
		out := make(map[string]any, len(typed))
		for key, item := range typed {
			out[key] = numberize(item)
		}
		return out
	}
	return value
}
