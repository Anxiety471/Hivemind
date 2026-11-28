package threads

import (
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/wtf8"
	"strings"
	"unicode"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/validate"
)

// This file is messageReplyPreview (packages/core/src/messages/message-quote.ts:207) for a parent
// whose blocks already parsed as MessageBlock.array().
//
// The preview of a bot's or system's text runs visibleTextFromMarkdown (message-quote.ts:48), a
// remark + GFM + hast-util-to-text pipeline with no Go equivalent. Go answers only text that
// cannot contain markdown (plainMarkdownText) and declines the request otherwise.

const maxQuotableSource = 100_000

// plainMarkdownText reports whether the Markdown pipeline would hand the text back unchanged:
// one line of letters, digits and a small set of punctuation, no marker that could start a
// construct, no leading or trailing space, no run of spaces. It is an allowlist; anything it
// does not list is treated as Markdown.
func plainMarkdownText(text string) bool {
	if text == "" {
		return true
	}
	previousSpace := true // a leading space is refused the same way as a doubled one
	for index, character := range text {
		switch {
		case unicode.IsLetter(character) || unicode.IsDigit(character):
			previousSpace = false
		case character == ' ':
			if previousSpace {
				return false
			}
			previousSpace = true
		case strings.ContainsRune(",.?'\";%$@/-^={}", character):
			if index == 0 {
				return false
			}
			previousSpace = false
		default:
			return false
		}
	}
	if previousSpace {
		return false
	}
	// A line that starts like an ordered list item.
	digits := 0
	for digits < len(text) && text[digits] >= '0' && text[digits] <= '9' {
		digits++
	}
	return !(digits > 0 && digits < len(text) && text[digits] == '.')
}

// compactReplyExcerpt is compactReplyExcerpt: the first non-blank line, 280 UTF-16 units at most,
// without a split surrogate pair.
func compactReplyExcerpt(text string) string {
	first := ""
	for _, line := range splitLines(text) {
		if trimmed := validate.JSTrim(line); trimmed != "" {
			first = trimmed
			break
		}
	}
	excerpt := units(first)
	if len(excerpt) > 280 {
		excerpt = excerpt[:280]
	}
	if length := len(excerpt); length > 0 && excerpt[length-1] >= 0xd800 && excerpt[length-1] <= 0xdbff {
		excerpt = excerpt[:length-1]
	}
	return wtf8.FromUnits(excerpt)
}

// splitLines is split(/\r?\n/u).
func splitLines(text string) []string {
	return strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n")
}

func blockString(block map[string]any, key string) string {
	text, _ := block[key].(string)
	return text
}

// replyTexts is replyBlockText (packages/core/src/messages/message-quote.ts:152-206) by kind: what
// a reply quotes from a block of that kind. message-quote.ts's switch is the same table, and
// TestReplyTextKindsMatchTypeScript pins the two together. image and file are absent because a
// preview splits them into `attachment` before it reads a caption, exactly as that function does.
var replyTexts = map[string]func(map[string]any) string{
	"text":                   replyText,
	"ask":                    replyText,
	"channel_message":        replyText,
	"computer":               replyText,
	"meta":                   replyText,
	"progress":               replyText,
	"handoff":                replyText,
	"bot_message_sent":       replyText,
	"bot_message_received":   replyText,
	"agent_message_received": replyText,
	"choice":                 func(block map[string]any) string { return blockString(block, "question") },
	"card":                   replyCardText,
	"steps":                  replyStepsText,
	"voice_call":             replyTitle,
	"cloud_agent":            replyTitle,
	"job":                    replyTitle,
	"page":                   replyTitle,
	"call_request":           func(block map[string]any) string { return blockString(block, "reason") },
	"subagent":               replySubagentText,
	"child_bot":              replyName,
	"skill_draft":            replyName,
	"connect":                replyName,
	"app_connect":            replyName,
	"mcp_approval":           replyName,
	"chart":                  replyName,
	"routine_event":          replyName,
	"app":                    func(block map[string]any) string { return blockString(block, "server") },
	"import_setup":           replyImportSetupText,
	// A delivery's prompt and a thinking block's reasoning are not the reply.
	"delivery": replyNothing,
	"thinking": replyNothing,
}

// replyBlockText is replyBlockText for the kinds a preview reads. delivery and thinking read as
// nothing: reasoning is not the reply.
func replyBlockText(block map[string]any) string {
	kind, _ := block["kind"].(string)
	read, known := replyTexts[kind]
	if !known {
		return ""
	}
	return read(block)
}

func replyText(block map[string]any) string { return blockString(block, "text") }

// replyNothing is a kind whose block quotes nothing: a delivery's prompt, a thinking block.
func replyNothing(map[string]any) string { return "" }

func replyTitle(block map[string]any) string { return blockString(block, "title") }

func replyName(block map[string]any) string { return blockString(block, "name") }

func replyCardText(block map[string]any) string {
	lines, _ := block["lines"].([]any)
	parts := make([]string, len(lines))
	for index, line := range lines {
		entry, _ := line.(map[string]any)
		parts[index] = blockString(entry, "k") + ": " + blockString(entry, "v")
	}
	return strings.Join(parts, ", ")
}

func replyStepsText(block map[string]any) string {
	steps, _ := block["steps"].([]any)
	parts := make([]string, len(steps))
	for index, entry := range steps {
		step, _ := entry.(map[string]any)
		parts[index] = blockString(step, "label")
	}
	return strings.Join(parts, ", ")
}

func replySubagentText(block map[string]any) string {
	if name := blockString(block, "name"); name != "" {
		return name
	}
	return blockString(block, "task")
}

// replyImportSetupText is the checklist's item names: an agent import's rows are what a reply to
// it quotes, and an undone checklist quotes nothing.
func replyImportSetupText(block map[string]any) string {
	if undone, _ := block["undone"].(bool); undone {
		return ""
	}
	items, _ := block["items"].([]any)
	parts := make([]string, 0, len(items))
	for _, raw := range items {
		item, _ := raw.(map[string]any)
		if name, ok := item["name"].(string); ok {
			parts = append(parts, name)
			continue
		}
		if title, ok := item["title"].(string); ok {
			parts = append(parts, title)
		}
	}
	return strings.Join(parts, ", ")
}

// isQuestionAsk is isQuestionAskBlock.
func isQuestionAsk(block map[string]any) bool {
	if block["kind"] != "ask" {
		return false
	}
	_, approval := block["approvalEffectId"]
	_, instruction := block["instructionUpdate"]
	secret := block["input"] == "secret" && !approval
	return !secret && !approval && !instruction
}

// replyExcerpt is messageReplyExcerpt; plain is false when the excerpt would need Markdown.
func replyExcerpt(blocks []map[string]any, role string) (excerpt string, plain bool) {
	var texts, channels, questions, others []map[string]any
	for _, block := range blocks {
		switch {
		case block["kind"] == "text":
			texts = append(texts, block)
		case block["kind"] == "channel_message":
			channels = append(channels, block)
		case isQuestionAsk(block):
			questions = append(questions, block)
		default:
			others = append(others, block)
		}
	}
	for _, group := range [][]map[string]any{texts, channels, questions, others} {
		for _, block := range group {
			source := units(replyBlockText(block))
			if len(source) > maxQuotableSource {
				source = source[:maxQuotableSource]
			}
			visible := wtf8.FromUnits(source)
			if block["kind"] == "text" && role != "user" && !plainMarkdownText(visible) {
				return "", false
			}
			if excerpt := compactReplyExcerpt(visible); excerpt != "" {
				return excerpt, true
			}
		}
	}
	return "", true
}

// replyPreview is messageReplyPreview. plain is false when the preview needs the Markdown render.
func replyPreview(blocks []any, role string, botID *string, author map[string]any) (preview map[string]any, plain bool) {
	preview = map[string]any{"role": role}
	if botID != nil {
		preview["botId"] = *botID
	}
	if author != nil {
		preview["author"] = author
	}
	typed := make([]map[string]any, len(blocks))
	for index, block := range blocks {
		typed[index] = block.(map[string]any)
	}
	for _, block := range typed {
		if block["kind"] == "delivery" {
			preview["text"] = ""
			return preview, true
		}
	}
	var attachment map[string]any
	var captioned []map[string]any
	var firstImage, firstFile map[string]any
	for _, block := range typed {
		switch block["kind"] {
		case "image":
			if firstImage == nil {
				firstImage = block
			}
		case "file":
			if firstFile == nil {
				firstFile = block
			}
		default:
			captioned = append(captioned, block)
		}
	}
	source := firstImage
	if source == nil {
		source = firstFile
	}
	if source != nil {
		attachment = map[string]any{
			"kind": source["kind"], "artifactId": source["artifactId"],
			"mimeType": source["mimeType"], "name": source["name"],
		}
	}
	caption, plain := replyExcerpt(captioned, role)
	if !plain {
		return nil, false
	}
	text := caption
	if text == "" && attachment != nil && attachment["kind"] == "file" {
		text = attachment["name"].(string)
	}
	preview["text"] = text
	if attachment != nil {
		preview["attachment"] = attachment
	}
	if len(typed) > 0 {
		allPages := true
		for _, block := range typed {
			if block["kind"] != "page" {
				allPages = false
				break
			}
		}
		if allPages {
			preview["page"] = true
		}
	}
	return preview, true
}
