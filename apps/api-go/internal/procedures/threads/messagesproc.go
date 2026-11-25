package threads

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/contentcrypto"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/messageblocks"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/orpc"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/shared"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/validate"
)

// This file is threads.messages: resolveThreadTarget with includeArchived, then loadMessagePage
// (apps/api/src/routes/threads.ts:178 over apps/api/src/threads/thread-message-pages.ts:24).
// The around page carries coveredThroughSeq; the before page keeps scanning past a receipt-only
// window unless the caller asked to keep receipts. Blocks and reply previews Go cannot judge are
// declined per request (local.ErrDecline) so the gateway asks TypeScript.

// messagesInput is threadTarget.safeExtend({ before, includePeerRuns, includePeerReceipts, around }).
type messagesInput struct {
	Target
	Before              *int64
	IncludePeerRuns     bool
	IncludePeerReceipts bool
	Around              *aroundTarget
}

// parseMessagesInput mirrors the extended schema: zod reports shape issues in definition order
// (botId, groupId, before, includePeerRuns, includePeerReceipts, around), then the "exactly one"
// refinement, and only when no issue was an invalid_type (zod aborts refinements then).
func parseMessagesInput(raw orpc.Input) (messagesInput, *orpc.Error) {
	object, issues := validate.Decode(raw.Raw, nil)
	if issues != nil {
		return messagesInput{}, validate.Fail(issues)
	}
	var in messagesInput
	var found []validate.Issue
	aborted := false
	note := func(problems []validate.Issue) {
		for _, problem := range problems {
			if problem["code"] == "invalid_type" {
				aborted = true
			}
		}
		found = append(found, problems...)
	}
	readID := func(key string, into *string) {
		value, present := object.Get(key)
		if !present {
			return
		}
		text, problems := validate.String(validate.Path{key}, value, validate.StringRules{Min: 1})
		note(problems)
		if problems == nil {
			*into = text
		}
	}
	readID("botId", &in.BotID)
	readID("groupId", &in.GroupID)
	if value, present := object.Get("before"); present {
		number, problems := validate.Integer(validate.Path{"before"}, value, validate.NumberRules{Min: validate.Float(0)})
		note(problems)
		if problems == nil {
			seq := number
			in.Before = &seq
		}
	}
	readBool := func(key string, into *bool) {
		value, present := object.Get(key)
		if !present {
			return
		}
		flag, problems := validate.Boolean(validate.Path{key}, value)
		note(problems)
		if problems == nil {
			*into = flag
		}
	}
	readBool("includePeerRuns", &in.IncludePeerRuns)
	readBool("includePeerReceipts", &in.IncludePeerReceipts)
	if value, present := object.Get("around"); present {
		nested, problems := validate.AsObject(value, validate.Path{"around"})
		note(problems)
		if problems == nil {
			around := &aroundTarget{}
			if nestedValue, ok := nested.Get("messageId"); ok {
				text, problems := validate.String(validate.Path{"around", "messageId"}, nestedValue, validate.StringRules{Min: 1})
				note(problems)
				if problems == nil {
					around.MessageID = text
				}
			}
			if nestedValue, ok := nested.Get("seq"); ok {
				number, problems := validate.Integer(validate.Path{"around", "seq"}, nestedValue, validate.NumberRules{Min: validate.Float(0)})
				note(problems)
				if problems == nil {
					seq := number
					around.Seq = &seq
				}
			}
			in.Around = around
		}
	}
	if !aborted && (in.BotID != "") == (in.GroupID != "") {
		found = append(found, validate.Issue{
			"code": "custom", "path": []any{"botId"}, "message": "Provide exactly one of botId or groupId",
		})
	}
	if found != nil {
		return messagesInput{}, validate.Fail(found)
	}
	return in, nil
}

// Messages implements threads.messages.
func Messages(ctx context.Context, database *db.DB, deployment shared.Deployment, actor db.Actor, raw orpc.Input) (any, *orpc.Error) {
	in, failure := parseMessagesInput(raw)
	if failure != nil {
		return nil, failure
	}
	var result map[string]any
	err := locked(ctx, database, actor, func(ctx context.Context, tx pgx.Tx) error {
		resolved, err := resolveWith(ctx, tx, actor, in.Target, true)
		if err != nil {
			return err
		}
		snapshot := snapshotReader{ctx: ctx, tx: tx, ring: deployment.Content, viewer: actor.UserID}
		page, err := snapshot.loadMessagePage(resolved.ThreadID, pageQuery{
			Before:              in.Before,
			Around:              in.Around,
			IncludePeerRuns:     in.IncludePeerRuns,
			IncludePeerReceipts: in.IncludePeerReceipts,
		})
		if err != nil {
			return err
		}
		if failure := validateMessagePage(resolved.ThreadID, page); failure != nil {
			return failure
		}
		result = map[string]any{
			"threadId": resolved.ThreadID, "messages": page.messages, "olderCursor": page.olderCursor,
		}
		if page.coveredThroughSeq != nil {
			result["coveredThroughSeq"] = *page.coveredThroughSeq
		}
		return nil
	})
	if err != nil {
		// The router logs a 5xx with its cause ("<procedure> failed"); no second line here.
		return nil, shared.Failure(err)
	}
	return result, nil
}

// validateMessagePage is ThreadMessagePageSchema's parse of the page.
func validateMessagePage(threadID string, page messagePage) *orpc.Error {
	if threadID == "" {
		return outputInvalid()
	}
	if cursor, ok := page.olderCursor.(int32); ok && cursor < 0 {
		return outputInvalid()
	}
	if page.coveredThroughSeq != nil && *page.coveredThroughSeq < 0 {
		return outputInvalid()
	}
	return ValidateMessages(page.messages)
}

// ValidateMessages is ThreadMessageSchema.array()'s parse of a mapped page: each message's id and
// thread id must be nonempty and its seq non-negative. The block, role and run checks happen when
// the message is mapped (threadMessage).
func ValidateMessages(messages []map[string]any) *orpc.Error {
	for _, message := range messages {
		id, _ := message["id"].(string)
		thread, _ := message["threadId"].(string)
		seq, _ := message["seq"].(int32)
		if id == "" || thread == "" || seq < 0 {
			return outputInvalid()
		}
	}
	return nil
}

// Page is loadMessagePage's answer, for the group read that embeds the first page.
type Page struct {
	Messages          []map[string]any
	OlderCursor       any
	CoveredThroughSeq *int32
}

// LoadFirstPage is loadMessagePage(prisma, threadId, undefined, THREAD_MESSAGE_PAGE_SIZE) in the
// caller's transaction: the newest page with peer and background chatter filtered out.
func LoadFirstPage(ctx context.Context, tx pgx.Tx, ring *contentcrypto.KeyRing, threadID string) (Page, error) {
	snapshot := snapshotReader{ctx: ctx, tx: tx, ring: ring}
	page, err := snapshot.messagePage(threadID)
	if err != nil {
		return Page{}, err
	}
	return Page{Messages: page.messages, OlderCursor: page.olderCursor, CoveredThroughSeq: page.coveredThroughSeq}, nil
}

// NewestMessagePreview is attachNewestGroupMessage's preview (packages/db/src/spaces/groups.ts:283):
// the sidebar text of the thread's newest message, whatever run wrote it.
func NewestMessagePreview(ctx context.Context, tx pgx.Tx, ring *contentcrypto.KeyRing, threadID string) (string, error) {
	var id string
	var blocks []byte
	err := tx.QueryRow(ctx, `SELECT id, blocks FROM messages WHERE "threadId" = $1 ORDER BY seq DESC LIMIT 1`,
		threadID).Scan(&id, &blocks)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	value, err := messageblocks.DecodeJSON(blocks)
	if err != nil {
		return "", err
	}
	rows := []map[string]any{{"id": id, "threadId": threadID, "blocks": value}}
	if ring != nil {
		if err := ring.OpenRows(ctx, "Message", rows); err != nil {
			return "", err
		}
	}
	return shared.PreviewFromBlocks(rows[0]["blocks"]), nil
}
