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

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/messageblocks"
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
			projection.blocks = reduceLive(projection.blocks, liveUpdate{
				kind: "tool", name: name, detail: detail, timing: stepTimingFromPayload(event.Payload),
			})
			touchMeta(projection)
		case "agent.tool.completed":
			if projection, ok := live[progressMessageID(event)]; ok {
				durationMs, hasDuration := payloadNonNegInt64(event.Payload["durationMs"])
				if hasDuration || hasRunningStep(projection.blocks) {
					name := ""
					if event.Payload["name"] != nil {
						name = jsString(event.Payload["name"])
					}
					outcome, _ := event.Payload["outcome"].(string)
					projection.blocks = completeLiveToolStep(projection.blocks, name, durationMs, outcome)
					touchMeta(projection)
				}
			}
		case "usage.recorded":
			if projection, ok := live[progressMessageID(event)]; ok {
				runCost, hasRunCost := payloadNonNegFloat(event.Payload["runCostUsd"])
				stepCost, hasStepCost := payloadNonNegFloat(event.Payload["costUsd"])
				if hasRunCost || hasStepCost {
					prevCost, _ := currentLiveCostUSD(projection.blocks)
					nextCost := prevCost + stepCost
					if hasRunCost {
						nextCost = runCost
					}
					projection.blocks = stampLiveStepsCost(projection.blocks, nextCost)
				}
			}
		case "run.checkpointed":
			if stepsRaw, ok := event.Payload["steps"].([]any); ok {
				projection := touch(event, createdAt)
				projection.blocks = applyLiveCheckpoint(projection.blocks, stepsRaw, event.Payload)
				touchMeta(projection)
			}
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

type stepTiming struct {
	startedAtMs    *int64
	attempt        *int
	forkedFromStep *int
}

func (t *stepTiming) isPresent() bool {
	return t != nil && (t.startedAtMs != nil || t.attempt != nil || t.forkedFromStep != nil)
}

func (t *stepTiming) toMap() map[string]any {
	out := map[string]any{}
	if t.startedAtMs != nil {
		out["startedAtMs"] = *t.startedAtMs
	}
	if t.attempt != nil {
		out["attempt"] = *t.attempt
	}
	if t.forkedFromStep != nil {
		out["forkedFromStep"] = *t.forkedFromStep
	}
	return out
}

type liveUpdate struct {
	kind    string // progress, tool or thinking
	payload map[string]any
	name    string
	detail  string
	timing  *stepTiming
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
	lower := []rune(messageblocks.JSLower.String(spaced))
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
func appendToolCallSegment(segments []map[string]any, toolName, detail string, timing *stepTiming) []map[string]any {
	label := humanizeToolName(toolName)
	normalized := validate.JSTrim(detail)
	timed := timing.isPresent()
	var prior []any
	var last map[string]any
	if len(segments) > 0 && segments[len(segments)-1]["kind"] == "steps" {
		last = segments[len(segments)-1]
		prior = last["steps"].([]any)
	}
	prepared := make([]any, 0, len(prior))
	for _, raw := range prior {
		entry, _ := raw.(map[string]any)
		if timed && entry["status"] == "running" {
			copied := copyMap(entry)
			copied["status"] = "done"
			if _, hasDur := copied["durationMs"]; !hasDur && timing.startedAtMs != nil {
				if prevStart, ok := payloadNonNegInt64(copied["startedAtMs"]); ok {
					dur := *timing.startedAtMs - prevStart
					if dur < 0 {
						dur = 0
					}
					copied["durationMs"] = dur
				}
			}
			prepared = append(prepared, copied)
		} else {
			prepared = append(prepared, raw)
		}
	}
	var steps []any
	if len(prepared) > 0 {
		newest := prepared[len(prepared)-1].(map[string]any)
		newestDetail, _ := newest["detail"].(string)
		compatible := newest["label"] == label && newestDetail == normalized
		if compatible && timed {
			newestStatus, _ := newest["status"].(string)
			newestAttempt, hasNewestAttempt := payloadPosInt(newest["attempt"])
			newestFork, hasNewestFork := payloadPosIntZeroAllowed(newest["forkedFromStep"])
			attemptMatch := (!hasNewestAttempt && timing.attempt == nil) || (hasNewestAttempt && timing.attempt != nil && newestAttempt == *timing.attempt)
			forkMatch := (!hasNewestFork && timing.forkedFromStep == nil) || (hasNewestFork && timing.forkedFromStep != nil && newestFork == *timing.forkedFromStep)
			compatible = attemptMatch && forkMatch && newestStatus != "stopped" && newestStatus != "failed"
		}
		if compatible {
			counted := copyMap(newest)
			counted["count"] = newest["count"].(int) + 1
			if timed && timing.startedAtMs != nil {
				counted["status"] = "running"
			}
			steps = append(append([]any{}, prepared[:len(prepared)-1]...), counted)
		}
	}
	if steps == nil {
		added := map[string]any{"label": label, "count": 1}
		if normalized != "" {
			added["detail"] = normalized
		}
		if timed && timing.startedAtMs != nil {
			added["startedAtMs"] = *timing.startedAtMs
			added["status"] = "running"
		}
		if timed && timing.attempt != nil {
			added["attempt"] = *timing.attempt
		}
		if timed && timing.forkedFromStep != nil {
			added["forkedFromStep"] = *timing.forkedFromStep
		}
		steps = append(append([]any{}, prepared...), added)
	}
	var block map[string]any
	if last != nil {
		block = copyMap(last)
		block["kind"] = "steps"
		block["steps"] = steps
	} else {
		block = map[string]any{"kind": "steps", "steps": steps}
	}
	if timed && timing.attempt != nil {
		prevAttempts, _ := payloadPosInt(block["attempts"])
		if *timing.attempt > prevAttempts && (*timing.attempt > 1 || prevAttempts > 0) {
			block["attempts"] = *timing.attempt
		}
	}
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
			timings, _ := waiting["pendingToolTimings"].([]any)
			for index, name := range names {
				detail := ""
				if index < len(details) {
					detail, _ = details[index].(string)
				}
				var timing *stepTiming
				if index < len(timings) {
					if timingMap, ok := timings[index].(map[string]any); ok {
						timing = stepTimingFromPayload(timingMap)
					}
				}
				blocks = appendToolCallSegment(blocks, name.(string), detail, timing)
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
	var timings []any
	if tailIsProgress {
		names, _ = tail["pendingToolNames"].([]any)
		stored, _ := tail["pendingToolDetails"].([]any)
		storedTimings, _ := tail["pendingToolTimings"].([]any)
		for index := range names {
			if index < len(stored) && stored[index] != nil {
				details = append(details, stored[index])
			} else {
				details = append(details, nil)
			}
			if index < len(storedTimings) && storedTimings[index] != nil {
				timings = append(timings, storedTimings[index])
			} else {
				timings = append(timings, nil)
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
		if update.timing.isPresent() {
			timings = append(timings, update.timing.toMap())
		} else {
			timings = append(timings, nil)
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
			var timing *stepTiming
			if index < len(timings) {
				if timingMap, ok := timings[index].(map[string]any); ok {
					timing = stepTimingFromPayload(timingMap)
				}
			}
			next = appendToolCallSegment(next, name.(string), detail, timing)
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
	for _, entry := range timings {
		if entry != nil {
			progress["pendingToolTimings"] = timings
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

// numberize turns the numbers a projection builds into the json.Number the block schemas read.
func numberize(value any) any {
	switch typed := value.(type) {
	case int:
		return json.Number(strconv.Itoa(typed))
	case int64:
		return json.Number(strconv.FormatInt(typed, 10))
	case float64:
		if !math.IsNaN(typed) && !math.IsInf(typed, 0) {
			return json.Number(strconv.FormatFloat(typed, 'g', -1, 64))
		}
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

func copyMap(source map[string]any) map[string]any {
	out := make(map[string]any, len(source))
	for key, value := range source {
		out[key] = value
	}
	return out
}

func payloadNonNegInt64(raw any) (int64, bool) {
	var parsed float64
	switch typed := raw.(type) {
	case int:
		if typed >= 0 {
			return int64(typed), true
		}
		return 0, false
	case int64:
		if typed >= 0 {
			return typed, true
		}
		return 0, false
	case float64:
		parsed = typed
	case json.Number:
		value, err := strconv.ParseFloat(typed.String(), 64)
		if err != nil {
			return 0, false
		}
		parsed = value
	default:
		return 0, false
	}
	if math.IsNaN(parsed) || math.IsInf(parsed, 0) || parsed < 0 {
		return 0, false
	}
	return int64(math.Trunc(parsed)), true
}

func payloadPosInt(raw any) (int, bool) {
	val, ok := payloadNonNegInt64(raw)
	if !ok || val <= 0 || val > math.MaxInt32 {
		return 0, false
	}
	return int(val), true
}

func payloadPosIntZeroAllowed(raw any) (int, bool) {
	val, ok := payloadNonNegInt64(raw)
	if !ok || val > math.MaxInt32 {
		return 0, false
	}
	return int(val), true
}

func payloadNonNegFloat(raw any) (float64, bool) {
	switch typed := raw.(type) {
	case int:
		if typed >= 0 {
			return float64(typed), true
		}
	case int64:
		if typed >= 0 {
			return float64(typed), true
		}
	case float64:
		if !math.IsNaN(typed) && !math.IsInf(typed, 0) && typed >= 0 {
			return typed, true
		}
	case json.Number:
		parsed, err := strconv.ParseFloat(typed.String(), 64)
		if err == nil && !math.IsNaN(parsed) && !math.IsInf(parsed, 0) && parsed >= 0 {
			return parsed, true
		}
	}
	return 0, false
}

func stepTimingFromPayload(payload map[string]any) *stepTiming {
	var timing stepTiming
	if value, ok := payloadNonNegInt64(payload["startedAtMs"]); ok {
		timing.startedAtMs = &value
	}
	if value, ok := payloadPosInt(payload["attempt"]); ok {
		timing.attempt = &value
	}
	if value, ok := payloadPosIntZeroAllowed(payload["forkedFromStep"]); ok {
		timing.forkedFromStep = &value
	}
	if !timing.isPresent() {
		return nil
	}
	return &timing
}

func hasRunningStep(blocks []map[string]any) bool {
	for _, block := range blocks {
		if block["kind"] != "steps" {
			continue
		}
		if steps, ok := block["steps"].([]any); ok {
			for _, raw := range steps {
				if stepMap, ok := raw.(map[string]any); ok && stepMap["status"] == "running" {
					return true
				}
			}
		}
	}
	return false
}

func currentLiveCostUSD(blocks []map[string]any) (float64, bool) {
	for index := len(blocks) - 1; index >= 0; index-- {
		if blocks[index]["kind"] == "steps" {
			if cost, ok := payloadNonNegFloat(blocks[index]["costUsd"]); ok {
				return cost, true
			}
		}
	}
	return 0, false
}

func completeLiveToolStep(blocks []map[string]any, name string, durationMs int64, outcome string) []map[string]any {
	blockIndex := -1
	for index := len(blocks) - 1; index >= 0; index-- {
		if blocks[index]["kind"] == "steps" {
			blockIndex = index
			break
		}
	}
	if blockIndex == -1 {
		return copyBlocks(blocks)
	}
	block := blocks[blockIndex]
	steps, _ := block["steps"].([]any)
	label := humanizeToolName(name)
	stepIndex := -1
	for index := len(steps) - 1; index >= 0; index-- {
		entry, _ := steps[index].(map[string]any)
		_, hasDuration := entry["durationMs"]
		if entry["label"] == label && (entry["status"] == "running" || !hasDuration) {
			stepIndex = index
			break
		}
	}
	if stepIndex == -1 {
		for index := len(steps) - 1; index >= 0; index-- {
			entry, _ := steps[index].(map[string]any)
			if entry["label"] == label {
				stepIndex = index
				break
			}
		}
	}
	if stepIndex == -1 {
		for index := len(steps) - 1; index >= 0; index-- {
			entry, _ := steps[index].(map[string]any)
			if entry["status"] == "running" {
				stepIndex = index
				break
			}
		}
	}
	if stepIndex == -1 {
		return copyBlocks(blocks)
	}
	target := copyMap(steps[stepIndex].(map[string]any))
	nextDuration := durationMs
	if prevDur, hasPrev := payloadNonNegInt64(target["durationMs"]); hasPrev {
		if count, hasCount := payloadPosInt(target["count"]); hasCount && count > 1 {
			nextDuration = prevDur + durationMs
		}
	}
	target["durationMs"] = nextDuration
	switch outcome {
	case "failed", "error":
		target["status"] = "failed"
	case "stopped", "cancelled":
		target["status"] = "stopped"
	default:
		target["status"] = "done"
	}
	updatedSteps := append([]any{}, steps...)
	updatedSteps[stepIndex] = target
	updatedBlock := copyMap(block)
	updatedBlock["steps"] = updatedSteps
	out := copyBlocks(blocks)
	out[blockIndex] = updatedBlock
	return out
}

func stampLiveStepsCost(blocks []map[string]any, costUsd float64) []map[string]any {
	blockIndex := -1
	for index := len(blocks) - 1; index >= 0; index-- {
		if blocks[index]["kind"] == "steps" {
			blockIndex = index
			break
		}
	}
	if blockIndex == -1 {
		return copyBlocks(blocks)
	}
	updatedBlock := copyMap(blocks[blockIndex])
	updatedBlock["costUsd"] = costUsd
	out := copyBlocks(blocks)
	out[blockIndex] = updatedBlock
	return out
}

func applyLiveCheckpoint(blocks []map[string]any, stepsRaw []any, payload map[string]any) []map[string]any {
	checkpointBlock := map[string]any{
		"kind":  "steps",
		"steps": append([]any{}, stepsRaw...),
	}
	if attempts, ok := payloadPosInt(payload["attempts"]); ok {
		checkpointBlock["attempts"] = attempts
	}
	if costUsd, ok := payloadNonNegFloat(payload["costUsd"]); ok {
		checkpointBlock["costUsd"] = costUsd
	}
	if modelID, ok := payload["modelId"].(string); ok && modelID != "" {
		checkpointBlock["modelId"] = modelID
	}
	if modelProvider, ok := payload["modelProvider"].(string); ok && modelProvider != "" {
		checkpointBlock["modelProvider"] = modelProvider
	}
	existingIndex := -1
	for index := len(blocks) - 1; index >= 0; index-- {
		if blocks[index]["kind"] == "steps" {
			existingIndex = index
			break
		}
	}
	if existingIndex != -1 {
		out := copyBlocks(blocks)
		merged := copyMap(blocks[existingIndex])
		for key, value := range checkpointBlock {
			merged[key] = value
		}
		out[existingIndex] = merged
		return out
	}
	if len(blocks) > 0 && blocks[len(blocks)-1]["kind"] == "progress" {
		out := make([]map[string]any, 0, len(blocks)+1)
		out = append(out, blocks[:len(blocks)-1]...)
		out = append(out, checkpointBlock, blocks[len(blocks)-1])
		return out
	}
	return append(copyBlocks(blocks), checkpointBlock)
}
