package contentcrypto

// The message-block text the blind index covers, ported from
// packages/db/src/history-text.ts: the conversational text, attachment names
// and tool-step labels and notes. Words and prefixes are keyed HMACs, so this
// text must match TypeScript exactly or a search would miss the row.

// conversationBlockKinds are the blocks whose text is conversational content.
var conversationBlockKinds = map[string]bool{
	"text": true, "channel_message": true, "bot_message_received": true,
	"bot_message_sent": true, "handoff": true,
}

// objectBlocks filters a JSON array to its object elements.
func objectBlocks(blocks any) []map[string]any {
	items, ok := blocks.([]any)
	if !ok {
		return nil
	}
	out := make([]map[string]any, 0, len(items))
	for _, item := range items {
		if block, ok := item.(map[string]any); ok {
			out = append(out, block)
		}
	}
	return out
}

// toolSteps keeps the steps of a "steps" block that carry a string label.
func toolSteps(block map[string]any) []map[string]any {
	if block["kind"] != "steps" {
		return nil
	}
	items, ok := block["steps"].([]any)
	if !ok {
		return nil
	}
	out := make([]map[string]any, 0, len(items))
	for _, item := range items {
		step, ok := item.(map[string]any)
		if !ok {
			continue
		}
		if _, ok := step["label"].(string); ok {
			out = append(out, step)
		}
	}
	return out
}

// conversationText is conversationText: a subagent block's task and result,
// or another conversational block's text.
func conversationText(block map[string]any) []string {
	if block["kind"] == "subagent" {
		var out []string
		if task, ok := block["task"].(string); ok && task != "" {
			out = append(out, task)
		}
		if result, ok := block["result"].(string); ok && result != "" {
			out = append(out, result)
		}
		return out
	}
	kind, _ := block["kind"].(string)
	if !conversationBlockKinds[kind] {
		return nil
	}
	if text, ok := block["text"].(string); ok {
		return []string{text}
	}
	return nil
}

// HistoryMessageText is historyMessageText: the conversational text only.
// Empty block texts still contribute their separator, as `flatMap(...).join`
// leaves the trailing newline a blank block adds.
func HistoryMessageText(blocks any) string {
	var parts []string
	for _, block := range objectBlocks(blocks) {
		parts = append(parts, conversationText(block)...)
	}
	return joinStrings(parts, "\n")
}

// HistorySearchText is historySearchText: message text, attachment names, and
// tool-step labels and notes, one per line.
func HistorySearchText(blocks any) string {
	var parts []string
	parts = append(parts, HistoryMessageText(blocks))
	for _, block := range objectBlocks(blocks) {
		kind, _ := block["kind"].(string)
		if kind != "file" && kind != "image" {
			continue
		}
		if _, ok := block["artifactId"].(string); !ok {
			continue
		}
		if name, ok := block["name"].(string); ok {
			parts = append(parts, name)
		}
	}
	for _, block := range objectBlocks(blocks) {
		for _, step := range toolSteps(block) {
			label, _ := step["label"].(string)
			parts = append(parts, label)
		}
	}
	for _, block := range objectBlocks(blocks) {
		for _, step := range toolSteps(block) {
			if note, ok := step["note"].(string); ok {
				parts = append(parts, note)
			}
		}
	}
	return joinNonEmpty(parts)
}

// joinNonEmpty is `array.filter(Boolean).join("\n")`.
func joinNonEmpty(parts []string) string {
	kept := make([]string, 0, len(parts))
	for _, part := range parts {
		if part != "" {
			kept = append(kept, part)
		}
	}
	return joinStrings(kept, "\n")
}

// joinStrings is strings.Join without importing the package under a name that
// reads like the JSON strings arrays in this file.
func joinStrings(parts []string, separator string) string {
	out := ""
	for index, part := range parts {
		if index > 0 {
			out += separator
		}
		out += part
	}
	return out
}

// StringsIn is stringsIn (content-encryption.ts:117-121): every string leaf in
// a JSON value, in the order the values are walked.
func StringsIn(value any) []string {
	var out []string
	collectStrings(value, &out)
	return out
}

func collectStrings(value any, out *[]string) {
	switch typed := value.(type) {
	case string:
		*out = append(*out, typed)
	case []any:
		for _, item := range typed {
			collectStrings(item, out)
		}
	case map[string]any:
		for _, item := range typed {
			collectStrings(item, out)
		}
	}
}
