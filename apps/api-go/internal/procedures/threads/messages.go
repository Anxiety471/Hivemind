package threads

import (
	"slices"
	"strings"
	"time"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/local"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/shared"
)

type parentRow struct {
	ThreadID     string
	Role         string
	BotID        *string
	AuthorUserID *string
	Blocks       any
}

type messageRow struct {
	ID               string
	ThreadID         string
	Seq              int32
	Role             string
	Blocks           any
	BotID            *string
	AuthorUserID     *string
	ReplyToMessageID *string
	ReplyQuote       *string
	RunID            *string
	ClientNonce      *string
	CreatedAt        time.Time
	Parent           *parentRow
}

type messagePage struct {
	messages    []map[string]any
	olderCursor any
}

// messagePage is loadMessagePage for the newest page: peer and background chatter stays off it, and
// a page that holds only peer receipts keeps scanning back until a real message turns up.
func (s snapshotReader) messagePage(threadID string) (messagePage, error) {
	var before *int32
	for {
		rows, hasOlder, err := s.fetchRows(threadID, before)
		if err != nil {
			return messagePage{}, err
		}
		visible, err := s.withoutPeerRunMessages(rows)
		if err != nil {
			return messagePage{}, err
		}
		substantive := false
		for _, row := range visible {
			if !isPeerReceipt(storedBlocks(row.Blocks)) {
				substantive = true
				break
			}
		}
		if substantive || !hasOlder {
			views, err := s.toMessages(visible)
			if err != nil {
				return messagePage{}, err
			}
			page := messagePage{messages: views}
			if hasOlder && len(rows) > 0 {
				page.olderCursor = rows[0].Seq
			}
			return page, nil
		}
		cursor := rows[0].Seq
		before = &cursor
	}
}

// fetchRows reads one page ascending; hasOlder says a row beyond it exists.
func (s snapshotReader) fetchRows(threadID string, before *int32) ([]messageRow, bool, error) {
	limit := messagePageSize + 1
	rows, err := s.tx.Query(s.ctx, `SELECT m.id, m."threadId", m.seq, m.role, m.blocks, m."botId", m."authorUserId",
			m."replyToMessageId", m."replyQuote", m."runId", m."clientNonce", m."createdAt",
			p.id, p."threadId", p.role, p."botId", p."authorUserId", p.blocks
		FROM messages m LEFT JOIN messages p ON p.id = m."replyToMessageId"
		WHERE m."threadId" = $1 AND ($2::int IS NULL OR m.seq < $2) ORDER BY m.seq DESC LIMIT $3`, threadID, before, limit)
	if err != nil {
		return nil, false, err
	}
	var found []messageRow
	parentIDs := map[string]string{}
	for rows.Next() {
		var row messageRow
		var blocks, parentBlocks []byte
		var parentID, parentThread, parentRole *string
		var parent parentRow
		if err := rows.Scan(&row.ID, &row.ThreadID, &row.Seq, &row.Role, &blocks, &row.BotID, &row.AuthorUserID,
			&row.ReplyToMessageID, &row.ReplyQuote, &row.RunID, &row.ClientNonce, &row.CreatedAt,
			&parentID, &parentThread, &parentRole, &parent.BotID, &parent.AuthorUserID, &parentBlocks); err != nil {
			rows.Close()
			return nil, false, err
		}
		if row.Blocks, err = decodeJSON(blocks); err != nil {
			rows.Close()
			return nil, false, err
		}
		if parentID != nil {
			parent.ThreadID, parent.Role = *parentThread, *parentRole
			if parent.Blocks, err = decodeJSON(parentBlocks); err != nil {
				rows.Close()
				return nil, false, err
			}
			row.Parent = &parent
			parentIDs[row.ID] = *parentID
		}
		found = append(found, row)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, false, err
	}
	hasOlder := len(found) > messagePageSize
	if hasOlder {
		found = found[:messagePageSize]
	}
	// Open the sealed blocks of the rows the page keeps, and of each reply parent in this thread.
	var open []map[string]any
	var targets []func(any)
	for index := range found {
		row := &found[index]
		open = append(open, map[string]any{"id": row.ID, "threadId": row.ThreadID, "blocks": row.Blocks})
		targets = append(targets, func(value any) { row.Blocks = value })
		if row.Parent != nil && row.Parent.ThreadID == row.ThreadID {
			open = append(open, map[string]any{"id": parentIDs[row.ID], "threadId": row.Parent.ThreadID, "blocks": row.Parent.Blocks})
			targets = append(targets, func(value any) { row.Parent.Blocks = value })
		}
	}
	if err := s.open("Message", open); err != nil {
		return nil, false, err
	}
	for index, target := range targets {
		target(open[index]["blocks"])
	}
	slices.Reverse(found)
	return found, hasOlder, nil
}

func isPeerReceipt(blocks []any) bool {
	for _, block := range blocks {
		kind := block.(map[string]any)["kind"]
		if kind == "bot_message_sent" || kind == "bot_message_received" {
			return true
		}
	}
	return false
}

// withoutPeerRunMessages drops what a peer run or a background run says that the transcript does
// not show.
func (s snapshotReader) withoutPeerRunMessages(rows []messageRow) ([]messageRow, error) {
	runIDs := map[string]bool{}
	for _, row := range rows {
		if row.RunID != nil {
			runIDs[*row.RunID] = true
		}
	}
	if len(runIDs) == 0 {
		return rows, nil
	}
	ids := make([]string, 0, len(runIDs))
	for id := range runIDs {
		ids = append(ids, id)
	}
	found, err := s.tx.Query(s.ctx, `SELECT id, trigger FROM runs WHERE id = ANY($1) AND trigger IN ($2, $3)`, ids, peerTrigger, backgroundTrigger)
	if err != nil {
		return nil, err
	}
	background := map[string]bool{}
	peer := map[string]bool{}
	for found.Next() {
		var id, trigger string
		if err := found.Scan(&id, &trigger); err != nil {
			found.Close()
			return nil, err
		}
		if trigger == backgroundTrigger {
			background[id] = true
		} else {
			peer[id] = true
		}
	}
	found.Close()
	if err := found.Err(); err != nil {
		return nil, err
	}
	var kept []messageRow
	for _, row := range rows {
		if row.RunID == nil {
			kept = append(kept, row)
			continue
		}
		blocks := storedBlocks(row.Blocks)
		switch {
		case background[*row.RunID]:
			// A person's own message stays visible unless it is a delivery; ticket work stays off the
			// transcript except existing user-input cards.
			isDelivery := slices.ContainsFunc(blocks, func(block any) bool { return block.(map[string]any)["kind"] == "delivery" })
			if (row.Role == "user" && !isDelivery) ||
				slices.ContainsFunc(blocks, func(block any) bool { return isBackgroundInput(block.(map[string]any)) }) {
				kept = append(kept, row)
			}
		case peer[*row.RunID]:
			// Keep peer receipts (chips), ask cards, and the bot's text, chart, page or attachment reply.
			if slices.ContainsFunc(blocks, func(block any) bool {
				return slices.Contains([]string{"bot_message_sent", "bot_message_received", "ask", "text", "chart", "app", "file", "image", "page"},
					block.(map[string]any)["kind"].(string))
			}) {
				kept = append(kept, row)
			}
		default:
			kept = append(kept, row)
		}
	}
	return kept, nil
}

func isBackgroundInput(block map[string]any) bool {
	kind := block["kind"]
	return kind == "ask" || kind == "computer" || kind == "mcp_approval" || kind == "app_connect"
}

// callIDFromClientNonce is callIdFromClientNonce.
func callIDFromClientNonce(nonce *string) (string, bool) {
	if nonce == nil || !strings.HasPrefix(*nonce, "call:") {
		return "", false
	}
	rest := (*nonce)[len("call:"):]
	at := strings.LastIndex(rest, ":")
	if at == -1 || at == 0 {
		return "", false
	}
	return rest[:at], true
}

// toMessages is toThreadMessages: the page's messages as ThreadMessage values.
func (s snapshotReader) toMessages(rows []messageRow) ([]map[string]any, error) {
	wanted := map[string]bool{}
	for _, row := range rows {
		if row.AuthorUserID != nil && *row.AuthorUserID != "" {
			wanted[*row.AuthorUserID] = true
		}
		if row.Parent != nil && row.Parent.AuthorUserID != nil && *row.Parent.AuthorUserID != "" {
			wanted[*row.Parent.AuthorUserID] = true
		}
	}
	authors := map[string]map[string]any{}
	if len(wanted) > 0 {
		ids := make([]string, 0, len(wanted))
		for id := range wanted {
			ids = append(ids, id)
		}
		found, err := s.tx.Query(s.ctx, `SELECT id, name FROM "user" WHERE id = ANY($1)`, ids)
		if err != nil {
			return nil, err
		}
		for found.Next() {
			var id, name string
			if err := found.Scan(&id, &name); err != nil {
				found.Close()
				return nil, err
			}
			authors[id] = map[string]any{"id": id, "name": name}
		}
		found.Close()
		if err := found.Err(); err != nil {
			return nil, err
		}
	}
	messages := make([]map[string]any, 0, len(rows))
	for _, row := range rows {
		message, err := threadMessage(row, authors)
		if err != nil {
			return nil, err
		}
		messages = append(messages, message)
	}
	return messages, nil
}

var messageRoles = []string{"user", "bot", "system"}

// threadMessage is toThreadMessage, then ThreadMessageSchema.
func threadMessage(row messageRow, authors map[string]map[string]any) (map[string]any, error) {
	blocks, valid, decidable := parseBlocks(storedBlocks(row.Blocks))
	if !decidable {
		return nil, local.ErrDecline
	}
	if !valid || !slices.Contains(messageRoles, row.Role) || (row.BotID != nil && *row.BotID == "") ||
		(row.RunID != nil && *row.RunID == "") || (row.ReplyToMessageID != nil && *row.ReplyToMessageID == "") {
		return nil, outputInvalid()
	}
	message := map[string]any{
		"id": row.ID, "threadId": row.ThreadID, "seq": row.Seq, "role": row.Role, "blocks": blocks,
	}
	if row.BotID != nil {
		message["botId"] = *row.BotID
	}
	if row.AuthorUserID != nil {
		if author, ok := authors[*row.AuthorUserID]; ok {
			message["author"] = author
		}
	}
	if row.ReplyToMessageID != nil {
		message["replyToMessageId"] = *row.ReplyToMessageID
	}
	if row.ReplyQuote != nil {
		message["replyQuote"] = *row.ReplyQuote
	}
	replied := (row.ReplyToMessageID != nil && *row.ReplyToMessageID != "") || row.ReplyQuote != nil
	switch {
	case row.Parent != nil && row.Parent.ThreadID == row.ThreadID:
		preview, err := parentPreview(row.Parent, authors)
		if err != nil {
			return nil, err
		}
		if preview != nil {
			message["replyPreview"] = preview
		} else if replied {
			message["replyPreview"] = nil
		}
	case replied:
		message["replyPreview"] = nil
	}
	if row.RunID != nil {
		message["runId"] = *row.RunID
	}
	if callID, ok := callIDFromClientNonce(row.ClientNonce); ok {
		message["callId"] = callID
	}
	message["createdAt"] = shared.ISO(row.CreatedAt)
	return message, nil
}

// parentPreview is the preview of the message a reply answers: nil when the parent's blocks do
// not parse as MessageBlock.array() (the preview is then null, or absent for a plain message).
func parentPreview(parent *parentRow, authors map[string]map[string]any) (map[string]any, error) {
	entries, isList := parent.Blocks.([]any)
	if !isList {
		return nil, nil
	}
	blocks, valid, decidable := parseBlocks(entries)
	if !decidable {
		return nil, local.ErrDecline
	}
	if !valid {
		return nil, nil
	}
	var author map[string]any
	if parent.AuthorUserID != nil {
		author = authors[*parent.AuthorUserID]
	}
	preview, plain := replyPreview(blocks, parent.Role, parent.BotID, author)
	if !plain {
		return nil, local.ErrDecline
	}
	if !slices.Contains(messageRoles, parent.Role) || (parent.BotID != nil && *parent.BotID == "") {
		return nil, outputInvalid()
	}
	return preview, nil
}
