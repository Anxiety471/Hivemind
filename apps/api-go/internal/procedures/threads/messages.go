package threads

import (
	"errors"
	"math"
	"slices"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/local"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/messageblocks"
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
	// coveredThroughSeq is set by the around page: the newest seq the page covers, absent on a
	// before page (loadMessagePage, thread-message-pages.ts:24).
	coveredThroughSeq *int32
}

// errSeqOutOfRange is a paging bound Prisma answers with a request error: anything past int4.
var errSeqOutOfRange = errors.New("message seq outside the int4 range")

// aroundTarget is loadMessagePage's `around`: one message by id or a seq. The seq keeps zod's
// safe-int width; the int4 range check happens when the page is read, as Prisma does.
type aroundTarget struct {
	MessageID string
	Seq       *int64
}

// pageQuery is loadMessagePage's arguments after the thread id.
type pageQuery struct {
	Before              *int64
	Around              *aroundTarget
	IncludePeerRuns     bool
	IncludePeerReceipts bool
}

// messagePage is loadMessagePage for the newest page: peer and background chatter stays off it,
// and a page that holds only peer receipts keeps scanning back until a real message turns up.
func (s snapshotReader) messagePage(threadID string) (messagePage, error) {
	return s.loadMessagePage(threadID, pageQuery{})
}

// loadMessagePage is loadMessagePage (apps/api/src/threads/thread-message-pages.ts:24).
func (s snapshotReader) loadMessagePage(threadID string, query pageQuery) (messagePage, error) {
	if query.Around != nil {
		targetSeq := query.Around.Seq
		if targetSeq == nil && query.Around.MessageID != "" {
			var seq int64
			err := s.tx.QueryRow(s.ctx, `SELECT seq FROM messages WHERE id = $1 AND "threadId" = $2`,
				query.Around.MessageID, threadID).Scan(&seq)
			if err == nil {
				targetSeq = &seq
			} else if !errors.Is(err, pgx.ErrNoRows) {
				return messagePage{}, err
			}
		}
		if targetSeq != nil {
			half := int64(messagePageSize / 2)
			minSeq := max(0, *targetSeq-half)
			maxSeq := *targetSeq + half
			if maxSeq > math.MaxInt32 {
				// The window's upper bound is an int4 filter too (lte maxSeq).
				return messagePage{}, errSeqOutOfRange
			}
			rows, err := s.fetchRange(threadID, minSeq, maxSeq)
			if err != nil {
				return messagePage{}, err
			}
			truncated := len(rows) >= messagePageSize
			covered := int32(maxSeq)
			if truncated {
				covered = rows[len(rows)-1].Seq
			}
			hasOlder := false
			if len(rows) > 0 {
				var count int
				if err := s.tx.QueryRow(s.ctx, `SELECT count(*) FROM messages WHERE "threadId" = $1 AND seq < $2`,
					threadID, rows[0].Seq).Scan(&count); err != nil {
					return messagePage{}, err
				}
				hasOlder = count > 0
			}
			visible := rows
			if !query.IncludePeerRuns {
				if visible, err = s.withoutPeerRunMessages(rows); err != nil {
					return messagePage{}, err
				}
			}
			messages, err := s.toMessages(visible)
			if err != nil {
				return messagePage{}, err
			}
			page := messagePage{messages: messages, coveredThroughSeq: &covered}
			if hasOlder && len(rows) > 0 {
				page.olderCursor = rows[0].Seq
			}
			return page, nil
		}
	}
	cursor := query.Before
	if cursor != nil && *cursor > math.MaxInt32 {
		// Prisma sends Int filter values as int4: a larger `before` fails the request. TypeScript
		// reads `before` only after `around` resolved to nothing, so a resolved around ignores it.
		return messagePage{}, errSeqOutOfRange
	}
	for {
		rows, hasOlder, err := s.fetchRows(threadID, cursor)
		if err != nil {
			return messagePage{}, err
		}
		visible := rows
		if !query.IncludePeerRuns {
			if visible, err = s.withoutPeerRunMessages(rows); err != nil {
				return messagePage{}, err
			}
		}
		// Web hides receipts client-side, so its receipt-only pages keep scanning. Mobile
		// explicitly retains them and must receive each page for pagination.
		substantive := false
		for _, row := range visible {
			if !isPeerReceipt(messageblocks.StoredBlocks(row.Blocks)) {
				substantive = true
				break
			}
		}
		if substantive || query.IncludePeerReceipts || !hasOlder || query.IncludePeerRuns {
			messages, err := s.toMessages(visible)
			if err != nil {
				return messagePage{}, err
			}
			page := messagePage{messages: messages}
			if hasOlder && len(rows) > 0 {
				page.olderCursor = rows[0].Seq
			}
			return page, nil
		}
		next := int64(rows[0].Seq)
		cursor = &next
	}
}

// fetchRows reads one page ascending; hasOlder says a row beyond it exists.
func (s snapshotReader) fetchRows(threadID string, before *int64) ([]messageRow, bool, error) {
	found, err := s.queryMessages(`WHERE m."threadId" = $1 AND ($2::bigint IS NULL OR m.seq < $2)
		ORDER BY m.seq DESC LIMIT $3`, threadID, before, messagePageSize+1)
	if err != nil {
		return nil, false, err
	}
	hasOlder := len(found) > messagePageSize
	if hasOlder {
		found = found[:messagePageSize]
	}
	slices.Reverse(found)
	return found, hasOlder, nil
}

// fetchRange reads the around page ascending (findMany orderBy seq asc take pageSize).
func (s snapshotReader) fetchRange(threadID string, minSeq, maxSeq int64) ([]messageRow, error) {
	return s.queryMessages(`WHERE m."threadId" = $1 AND m.seq >= $2 AND m.seq <= $3
		ORDER BY m.seq ASC LIMIT $4`, threadID, minSeq, maxSeq, messagePageSize)
}

// queryMessages reads message rows with their reply parent, opens the sealed blocks of the page
// and of each reply parent in its own thread, and returns them in the query's order.
func (s snapshotReader) queryMessages(tail string, args ...any) ([]messageRow, error) {
	rows, err := s.tx.Query(s.ctx, `SELECT m.id, m."threadId", m.seq, m.role, m.blocks, m."botId", m."authorUserId",
			m."replyToMessageId", m."replyQuote", m."runId", m."clientNonce", m."createdAt",
			p.id, p."threadId", p.role, p."botId", p."authorUserId", p.blocks
		FROM messages m LEFT JOIN messages p ON p.id = m."replyToMessageId" `+tail, args...)
	if err != nil {
		return nil, err
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
			return nil, err
		}
		if row.Blocks, err = messageblocks.DecodeJSON(blocks); err != nil {
			rows.Close()
			return nil, err
		}
		if parentID != nil {
			parent.ThreadID, parent.Role = *parentThread, *parentRole
			if parent.Blocks, err = messageblocks.DecodeJSON(parentBlocks); err != nil {
				rows.Close()
				return nil, err
			}
			row.Parent = &parent
			parentIDs[row.ID] = *parentID
		}
		found = append(found, row)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
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
		return nil, err
	}
	for index, target := range targets {
		target(open[index]["blocks"])
	}
	return found, nil
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
		blocks := messageblocks.StoredBlocks(row.Blocks)
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
	blocks, valid, decidable := messageblocks.ParseBlocks(messageblocks.StoredBlocks(row.Blocks))
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
	blocks, valid, decidable := messageblocks.ParseBlocks(entries)
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
