package bots

import (
	"context"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/contentcrypto"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/shared"
)

const (
	// botPreviewWindow is BOT_PREVIEW_WINDOW (bot-previews.ts:10): messages scanned per page.
	botPreviewWindow = 16
	// botPreviewPages is BOT_PREVIEW_PAGES (bot-previews.ts:11).
	botPreviewPages = 5
	// emptyResponseFallbackText is the text a bot reply carries when the run produced nothing.
	emptyResponseFallbackText = "No response. Try again."
)

// outlineMessage is ScannedMessage (bot-previews.ts:26). Blocks holds only each block's kind
// until the message is loaded, exactly as the TypeScript builds it.
type outlineMessage struct {
	ID               string
	ThreadID         string
	Seq              int32
	Role             string
	RunID            *string
	ReplyToMessageID *string
	CreatedAt        time.Time
	Blocks           []any
	Loaded           bool
}

type previewPage struct {
	ThreadID  string
	BeforeSeq *int32
}

// isNoResponseMessage mirrors isNoResponseMessage (message-visibility.ts): hides persisted
// empty, thinking-only, or fallback bot messages from sidebar previews while leaving live
// placeholders, unloaded outlines, user messages, and non-empty bot replies intact.
func isNoResponseMessage(message *outlineMessage) bool {
	if !message.Loaded || message.Role != "bot" || strings.HasPrefix(message.ID, "progress:") {
		return false
	}
	if len(message.Blocks) == 0 {
		return true
	}
	hasThinking := false
	hasText := false
	var textCombined strings.Builder
	for _, entry := range message.Blocks {
		block, ok := entry.(map[string]any)
		if !ok {
			return false
		}
		switch blockKind(block) {
		case "thinking":
			hasThinking = true
		case "text":
			text, ok := block["text"].(string)
			if !ok {
				return false
			}
			hasText = true
			textCombined.WriteString(text)
		default:
			return false
		}
	}
	trimmed := strings.TrimSpace(textCombined.String())
	if trimmed == "" {
		return hasText || hasThinking
	}
	return trimmed == emptyResponseFallbackText
}

// botThreadPreviews is botThreadPreviews (bot-previews.ts:97): the sidebar preview text of a
// bot's thread, read page by page. Only the messages the preview is taken from are loaded
// whole; visibility reads block kinds alone, plus a peer receipt's intent.
func botThreadPreviews(ctx context.Context, tx pgx.Tx, ring *contentcrypto.KeyRing, threadIDs []string) (map[string]string, map[string]time.Time, error) {
	peerRunIDs := map[string]bool{}
	backgroundRunIDs := map[string]bool{}
	checkedRunIDs := map[string]bool{}
	classifyRunIDs := func(ids []string) error {
		missing := []string{}
		for _, id := range ids {
			if !checkedRunIDs[id] {
				missing = append(missing, id)
			}
		}
		if len(missing) == 0 {
			return nil
		}
		rows, err := tx.Query(ctx, `SELECT id, trigger FROM runs
			WHERE id = ANY($1) AND trigger = ANY($2)`, missing, []string{"bot_message", "tickets"})
		if err != nil {
			return err
		}
		for rows.Next() {
			var id, trigger string
			if err := rows.Scan(&id, &trigger); err != nil {
				rows.Close()
				return err
			}
			if trigger == "tickets" {
				backgroundRunIDs[id] = true
			} else {
				peerRunIDs[id] = true
			}
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}
		for _, id := range missing {
			checkedRunIDs[id] = true
		}
		return nil
	}

	pages := make([]previewPage, len(threadIDs))
	for index, threadID := range threadIDs {
		pages[index] = previewPage{ThreadID: threadID}
	}
	loaded, err := messageOutlines(ctx, tx, ring, pages)
	if err != nil {
		return nil, nil, err
	}
	newestAt := map[string]time.Time{}
	for threadID, messages := range loaded {
		if len(messages) > 0 {
			newestAt[threadID] = messages[0].CreatedAt
		}
	}
	previews := map[string]string{}
	for page := 1; len(loaded) > 0; page++ {
		runIDs := []string{}
		for _, messages := range loaded {
			for _, message := range messages {
				if message.RunID != nil {
					runIDs = append(runIDs, *message.RunID)
				}
			}
		}
		if err := classifyRunIDs(runIDs); err != nil {
			return nil, nil, err
		}
		visibleByThread := map[string][]*outlineMessage{}
		for threadID, messages := range loaded {
			visibleByThread[threadID] = visibleMessages(messages, peerRunIDs, backgroundRunIDs)
		}
		exhausted := []string{}
		scanning := make([]string, 0, len(visibleByThread))
		for threadID := range visibleByThread {
			scanning = append(scanning, threadID)
		}
		// Usually the first candidate has text; when it does not, read the rest of the page at once.
		for round := 0; len(scanning) > 0; round++ {
			unloaded := []*outlineMessage{}
			seen := map[string]bool{}
			for _, threadID := range scanning {
				candidates := []*outlineMessage{}
				for _, message := range visibleByThread[threadID] {
					if !message.Loaded {
						candidates = append(candidates, message)
						if round == 0 {
							break
						}
						continue
					}
					if len(candidates) > 0 {
						continue
					}
					if isNoResponseMessage(message) {
						continue
					}
					if preview := shared.PreviewFromBlocks(message.Blocks); preview != "" {
						previews[threadID] = preview
						break
					}
				}
				for _, message := range candidates {
					if !seen[message.ID] {
						seen[message.ID] = true
						unloaded = append(unloaded, message)
					}
				}
				if _, has := previews[threadID]; !has && len(candidates) == 0 {
					exhausted = append(exhausted, threadID)
				}
			}
			if len(unloaded) == 0 {
				break
			}
			if err := loadMessageBlocks(ctx, tx, ring, unloaded); err != nil {
				return nil, nil, err
			}
			next := []string{}
			added := map[string]bool{}
			for _, message := range unloaded {
				if !added[message.ThreadID] {
					added[message.ThreadID] = true
					next = append(next, message.ThreadID)
				}
			}
			scanning = next
		}
		if page == botPreviewPages {
			break
		}
		next := []previewPage{}
		for _, threadID := range exhausted {
			messages := loaded[threadID]
			if len(messages) == 0 {
				continue
			}
			oldest := messages[len(messages)-1].Seq
			next = append(next, previewPage{ThreadID: threadID, BeforeSeq: &oldest})
		}
		loaded, err = messageOutlines(ctx, tx, ring, next)
		if err != nil {
			return nil, nil, err
		}
	}
	return previews, newestAt, nil
}

// messageOutlines is messageOutlines (bot-previews.ts:44): the newest page of messages per
// thread, before `beforeSeq` when given.
func messageOutlines(ctx context.Context, tx pgx.Tx, ring *contentcrypto.KeyRing, pages []previewPage) (map[string][]*outlineMessage, error) {
	if len(pages) == 0 {
		return map[string][]*outlineMessage{}, nil
	}
	threadIDs := make([]string, len(pages))
	befores := make([]*int32, len(pages))
	for index, page := range pages {
		threadIDs[index] = page.ThreadID
		befores[index] = page.BeforeSeq
	}
	rows, err := tx.Query(ctx, `SELECT m.id, m."threadId", m.seq, m.role, m."runId",
			m."replyToMessageId", m."createdAt",
			jsonb_path_query_array(m.blocks, '$[*].kind') AS kinds,
			CASE WHEN m.blocks @> '[{"kind":"bot_message_received"}]' THEN m.blocks END AS blocks
		FROM unnest($1::text[], $2::int[]) AS t(id, before)
		CROSS JOIN LATERAL (
			SELECT id, "threadId", seq, role, "runId", "replyToMessageId", "createdAt", blocks
			FROM messages
			WHERE "threadId" = t.id AND (t.before IS NULL OR seq < t.before)
			ORDER BY seq DESC
			LIMIT $3
		) m
		ORDER BY m."threadId", m.seq DESC`, threadIDs, befores, botPreviewWindow)
	if err != nil {
		return nil, err
	}
	type outlineRow struct {
		message *outlineMessage
		kinds   any
		blocks  any
	}
	scanned := []outlineRow{}
	for rows.Next() {
		message := &outlineMessage{}
		var kinds, blocks any
		if err := rows.Scan(&message.ID, &message.ThreadID, &message.Seq, &message.Role,
			&message.RunID, &message.ReplyToMessageID, &message.CreatedAt, &kinds, &blocks); err != nil {
			rows.Close()
			return nil, err
		}
		scanned = append(scanned, outlineRow{message: message, kinds: kinds, blocks: blocks})
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}

	// Only receipt rows carry their sealed blocks here; contentEncryptionOf(prisma)?.openRows
	// opens exactly those, so a corrupt ciphertext on another row does not fail the read.
	receipts := []*outlineRow{}
	open := []map[string]any{}
	for index := range scanned {
		row := &scanned[index]
		if row.blocks == nil {
			continue
		}
		receipts = append(receipts, row)
		open = append(open, map[string]any{
			"id": row.message.ID, "threadId": row.message.ThreadID, "blocks": row.blocks,
		})
	}
	if ring != nil {
		if err := ring.OpenRows(ctx, "Message", open); err != nil {
			return nil, err
		}
		for index, row := range receipts {
			row.blocks = open[index]["blocks"]
		}
	}
	byThread := map[string][]*outlineMessage{}
	for _, row := range scanned {
		if row.blocks == nil {
			kinds, _ := row.kinds.([]any)
			blocks := make([]any, len(kinds))
			for index, kind := range kinds {
				blocks[index] = map[string]any{"kind": kind}
			}
			row.message.Blocks = blocks
			row.message.Loaded = false
		} else {
			row.message.Blocks = shownBlocks(row.blocks)
			row.message.Loaded = true
		}
		byThread[row.message.ThreadID] = append(byThread[row.message.ThreadID], row.message)
	}
	return byThread, nil
}

// loadMessageBlocks is the `message.findMany` that fills in the candidates (bot-previews.ts:163).
func loadMessageBlocks(ctx context.Context, tx pgx.Tx, ring *contentcrypto.KeyRing, messages []*outlineMessage) error {
	ids := make([]string, len(messages))
	for index, message := range messages {
		ids[index] = message.ID
	}
	rows, err := tx.Query(ctx, `SELECT id, "threadId", blocks FROM messages WHERE id = ANY($1)`, ids)
	if err != nil {
		return err
	}
	type blockRow struct {
		ID       string
		ThreadID string
		Blocks   any
	}
	loaded := []blockRow{}
	for rows.Next() {
		var row blockRow
		if err := rows.Scan(&row.ID, &row.ThreadID, &row.Blocks); err != nil {
			rows.Close()
			return err
		}
		loaded = append(loaded, row)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	if ring != nil {
		open := make([]map[string]any, len(loaded))
		for index, row := range loaded {
			open[index] = map[string]any{"id": row.ID, "threadId": row.ThreadID, "blocks": row.Blocks}
		}
		if err := ring.OpenRows(ctx, "Message", open); err != nil {
			return err
		}
		for index := range loaded {
			loaded[index].Blocks = open[index]["blocks"]
		}
	}
	byID := make(map[string]any, len(loaded))
	for _, row := range loaded {
		byID[row.ID] = row.Blocks
	}
	for _, message := range messages {
		// A message deleted since the outline read has nothing to preview.
		message.Blocks = shownBlocks(byID[message.ID])
		message.Loaded = true
	}
	return nil
}

// shownBlocks is storedMessageBlocks (message-blocks.ts:57): the entries that name their kind.
type shownBlocksValue = []any

func shownBlocks(value any) []any {
	entries, ok := value.([]any)
	if !ok {
		return []any{}
	}
	kept := make([]any, 0, len(entries))
	for _, entry := range entries {
		object, ok := entry.(map[string]any)
		if !ok {
			continue
		}
		if _, named := object["kind"].(string); !named {
			continue
		}
		kept = append(kept, object)
	}
	return kept
}

// blockMatches reports whether any block satisfies match. Every block here is an object, as
// storedMessageBlocks and the kinds-only stand-ins both produce one.
func blockMatches(blocks []any, match func(map[string]any) bool) bool {
	for _, entry := range blocks {
		if block, ok := entry.(map[string]any); ok && match(block) {
			return true
		}
	}
	return false
}

func blockKind(block map[string]any) string {
	kind, _ := block["kind"].(string)
	return kind
}

// isDeliveryBlocks is isDeliveryMessage (message-visibility.ts:36): a delivery's text is the
// bot's hidden prompt, never shown as a message.
func isDeliveryBlocks(blocks []any) bool {
	return blockMatches(blocks, func(block map[string]any) bool { return blockKind(block) == "delivery" })
}

// isPeerReceiptBlocks is isPeerReceiptBlocks (message-visibility.ts:40).
func isPeerReceiptBlocks(blocks []any) bool {
	return blockMatches(blocks, func(block map[string]any) bool {
		kind := blockKind(block)
		return kind == "bot_message_sent" || kind == "bot_message_received"
	})
}

// isBackgroundInputBlock is isBackgroundInputBlock (message-visibility.ts:45).
func isBackgroundInputBlock(block map[string]any) bool {
	switch blockKind(block) {
	case "ask", "computer", "mcp_approval", "app_connect":
		return true
	}
	return false
}

// isAskBlock is isAskBlock (message-visibility.ts:56).
func isAskBlock(block map[string]any) bool {
	return blockKind(block) == "ask"
}

// startsPeerWork is startsPeerWork (message-visibility.ts:66): another bot handing this bot new
// work, a request or question that does not thread back to one of this bot's messages.
func startsPeerWork(message *outlineMessage) bool {
	if message.ReplyToMessageID != nil {
		return false
	}
	return blockMatches(message.Blocks, func(block map[string]any) bool {
		if blockKind(block) != "bot_message_received" {
			return false
		}
		intent, present := block["intent"]
		if !present {
			return true
		}
		return intent == "request" || intent == "question"
	})
}

// visibleMessages is foldPeerReplies with the options botThreadPreviews passes
// (bot-previews.ts:132): no receipts are kept and delegated reply text is off, so nothing ever
// folds and the result is a plain filter.
func visibleMessages(messages []*outlineMessage, knownPeerRunIDs, backgroundRunIDs map[string]bool) []*outlineMessage {
	markerByRunID := map[string]bool{}
	relayRunIDs := map[string]bool{}
	for _, message := range messages {
		if !blockMatches(message.Blocks, func(block map[string]any) bool {
			return blockKind(block) == "bot_message_received"
		}) {
			continue
		}
		relay := !startsPeerWork(message)
		if message.RunID != nil && !markerByRunID[*message.RunID] {
			markerByRunID[*message.RunID] = true
			if relay {
				relayRunIDs[*message.RunID] = true
			}
		}
	}
	peerRunIDs := map[string]bool{}
	for id := range knownPeerRunIDs {
		peerRunIDs[id] = true
	}
	for id := range markerByRunID {
		peerRunIDs[id] = true
	}
	visible := make([]*outlineMessage, 0, len(messages))
	for _, message := range messages {
		// What woke the bot is its prompt, not a message to show.
		if isDeliveryBlocks(message.Blocks) {
			continue
		}
		if message.RunID != nil && backgroundRunIDs[*message.RunID] {
			if message.Role == "user" {
				visible = append(visible, message)
				continue
			}
			if !blockMatches(message.Blocks, isBackgroundInputBlock) {
				continue
			}
			visible = append(visible, message)
			continue
		}
		// Previews never keep receipt rows.
		if isPeerReceiptBlocks(message.Blocks) {
			continue
		}
		if message.RunID == nil || !peerRunIDs[*message.RunID] {
			visible = append(visible, message)
			continue
		}
		// User-input cards stay inline; previews without receipts keep only asks.
		if blockMatches(message.Blocks, isAskBlock) {
			visible = append(visible, message)
			continue
		}
		// includeDelegatedReplyText is false: a non-relay peer reply never previews.
		if !relayRunIDs[*message.RunID] {
			continue
		}
		if !blockMatches(message.Blocks, func(block map[string]any) bool {
			switch blockKind(block) {
			case "text", "file", "image", "chart", "app", "page":
				return true
			}
			return false
		}) {
			continue
		}
		// Only bot replies fold; a person's message in the run stays inline, and no marker is
		// available without receipts, so every remaining message stays.
		visible = append(visible, message)
	}
	return visible
}
