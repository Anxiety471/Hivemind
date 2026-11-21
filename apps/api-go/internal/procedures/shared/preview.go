package shared

import (
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/mdtext"
)

// PreviewFromBlocks is previewFromBlocks (packages/db/src/threads/thread-listing.ts:94):
// the sidebar preview of a message, from its opened `blocks` column.
//
// A delivery's text is the bot's prompt, hidden in chat, so that message previews as "".
// Otherwise the first block that is an object with a string `text` is the preview, and a
// block whose `text` is not a string is skipped in favour of the next one.
func PreviewFromBlocks(blocks any) string {
	rows, _ := blocks.([]any)
	for _, row := range rows {
		block, ok := row.(map[string]any)
		if !ok {
			continue
		}
		if block["kind"] == "delivery" {
			return ""
		}
	}
	for _, row := range rows {
		block, ok := row.(map[string]any)
		if !ok {
			continue
		}
		if text, ok := block["text"].(string); ok {
			return mdtext.PlainTextFromMarkdown(text)
		}
	}
	return ""
}
